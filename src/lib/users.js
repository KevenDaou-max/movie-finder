import { env } from "cloudflare:workers";
import { derivePinHash, newSalt, PBKDF2_ITERATIONS } from "./auth.js";

/**
 * User records. Source of truth, so errors propagate — never a stale or
 * "best effort" answer to "who is this and is their pincode right".
 */
const db = () => env.DB;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Account lockout. A pincode has a tiny search space, so this is the primary
// brute-force defence, not a secondary one.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 15 * 60;

// Per-IP throttle across all accounts, covering login and signup. Account
// lockout alone does not stop one pincode being sprayed at many emails, nor
// unlimited account creation.
export const AUTH_ATTEMPT_CAP = 20;
export const AUTH_WINDOW_SECONDS = 15 * 60;

const USER_COLUMNS =
  "id, email, pin_hash, pin_salt, pin_iterations, created_at, failed_attempts, locked_until";

/** Lowercase + trim, so one address is one account regardless of typing. */
export const normaliseEmail = (email) => String(email ?? "").trim().toLowerCase();

// Deliberately permissive: this is a uniqueness key, not a deliverability
// check, and no verification mail is ever sent.
export const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** 6-12 digits. Length is the only real entropy lever on a numeric pincode. */
export const isValidPin = (pin) => typeof pin === "string" && /^\d{6,12}$/.test(pin);

export function findUserByEmail(email) {
  return db().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).bind(normaliseEmail(email)).first();
}

export function findUserById(id) {
  return db().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
}

/**
 * Returns the new user, or null if the email is taken.
 *
 * The UNIQUE constraint decides, not a prior SELECT: checking first would leave
 * a window in which two concurrent signups both see the address as free.
 */
export async function createUser(email, pin) {
  const salt = newSalt();
  const hash = await derivePinHash(pin, salt, PBKDF2_ITERATIONS);
  const id = crypto.randomUUID();

  try {
    await db()
      .prepare(
        `INSERT INTO users (id, email, pin_hash, pin_salt, pin_iterations, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, normaliseEmail(email), hash, salt, PBKDF2_ITERATIONS, nowSeconds())
      .run();
  } catch (err) {
    if (String(err?.message ?? "").includes("UNIQUE constraint failed")) return null;
    throw err;
  }

  return findUserById(id);
}

export const isLocked = (user) => Boolean(user.locked_until && user.locked_until > nowSeconds());

/** Locks the account once the threshold is crossed. */
export async function recordFailedAttempt(user) {
  const attempts = user.failed_attempts + 1;
  const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? nowSeconds() + LOCKOUT_SECONDS : null;

  await db()
    .prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
    .bind(attempts, lockedUntil, user.id)
    .run();

  return { attempts, lockedUntil };
}

export function clearFailedAttempts(userId) {
  return db()
    .prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?")
    .bind(userId)
    .run();
}

/**
 * Upgrade a hash in place when the work factor has been raised since the user
 * signed up. Only safe here, immediately after a successful verification, since
 * this is the only moment the plaintext pincode is legitimately available.
 */
export async function upgradeHashIfNeeded(user, pin) {
  if (user.pin_iterations >= PBKDF2_ITERATIONS) return;

  const salt = newSalt();
  const hash = await derivePinHash(pin, salt, PBKDF2_ITERATIONS);
  await db()
    .prepare("UPDATE users SET pin_hash = ?, pin_salt = ?, pin_iterations = ? WHERE id = ?")
    .bind(hash, salt, PBKDF2_ITERATIONS, user.id)
    .run();
}

/**
 * Per-IP attempt counter. One row per client with a rolling window, so this
 * cannot grow per attempt the way an append-only log would.
 *
 * Returns true when the caller is over the cap.
 */
export async function throttleExceeded(clientKey, cap = AUTH_ATTEMPT_CAP, windowSeconds = AUTH_WINDOW_SECONDS) {
  const now = nowSeconds();
  const row = await db()
    .prepare("SELECT window_start, attempts FROM auth_throttle WHERE client_key = ?")
    .bind(clientKey)
    .first();

  if (row && now - row.window_start < windowSeconds) {
    if (row.attempts >= cap) return true;
    await db()
      .prepare("UPDATE auth_throttle SET attempts = attempts + 1 WHERE client_key = ?")
      .bind(clientKey)
      .run();
    return false;
  }

  // No row, or the previous window has expired: start a fresh one.
  await db()
    .prepare(
      `INSERT INTO auth_throttle (client_key, window_start, attempts) VALUES (?, ?, 1)
       ON CONFLICT(client_key) DO UPDATE SET window_start = excluded.window_start, attempts = 1`
    )
    .bind(clientKey, now)
    .run();
  return false;
}
