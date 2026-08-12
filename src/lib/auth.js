import { env } from "cloudflare:workers";

/**
 * Pincode hashing and session storage.
 *
 * Like tickets.js and unlike catalog.js, nothing here swallows errors. A
 * session lookup that fails must not quietly resolve to "no session" if the
 * cause was infrastructure — but note the deliberate exception documented on
 * readSession below.
 */

// PBKDF2-SHA256 via Web Crypto. bcrypt/scrypt/Argon2 would all resist GPUs
// better, but workerd exposes PBKDF2 natively and the others would mean
// shipping WASM. PBKDF2 is the right choice *for this runtime*.
//
// Measured in workerd on the dev machine: 10k iterations ~= 6ms, 25k ~= 12ms,
// 100k ~= 61ms. The Workers Free plan allows 10ms CPU per request, so 10k is
// the ceiling here. On a Paid plan (30s CPU) raise this to 100000+; existing
// users keep working because each hash records its own iteration count.
export const PBKDF2_ITERATIONS = 10_000;

// Honest framing: at this work factor a 6-digit pincode (10^6 candidates) is
// recoverable from a leaked hash in seconds on a GPU. The salt still matters —
// it stops one precomputed table breaking every account at once — but the real
// brute-force defence is the lockout in users.js, not this number.

const SESSION_PREFIX = "session:";
export const SESSION_COOKIE = "session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const sessions = () => env.SESSIONS;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** URL-safe, unpadded — session ids travel in a cookie. */
const toBase64Url = (bytes) => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export function newSalt() {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function derivePinHash(pin, saltBase64, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromBase64(saltBase64), iterations, hash: "SHA-256" },
    key,
    256
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * Constant-time string comparison. `a === b` returns as soon as two characters
 * differ, so how long it takes leaks how much of the value was correct. These
 * are derived hashes rather than the secret itself, so the leak is small, but
 * comparing secrets properly costs three lines.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

export async function verifyPin(pin, user) {
  const candidate = await derivePinHash(pin, user.pin_salt, user.pin_iterations);
  return timingSafeEqual(candidate, user.pin_hash);
}

/**
 * Burn equivalent CPU when the email doesn't exist, so a wrong address and a
 * wrong pincode take the same time. Without this, response latency alone tells
 * an attacker which emails are registered.
 */
export async function dummyVerify() {
  await derivePinHash("000000", newSalt(), PBKDF2_ITERATIONS);
}

/** 256 bits of randomness. Unguessability is the whole security model. */
export async function createSession(user) {
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await sessions().put(
    SESSION_PREFIX + id,
    JSON.stringify({ userId: user.id, email: user.email, createdAt: nowSeconds() }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  return id;
}

/**
 * Returns { id, userId, email } or null.
 *
 * This is the one place that treats a failure as "no session" rather than
 * throwing: an unreadable session must never be interpreted as a valid one.
 * Failing closed is the safe direction here.
 */
export async function readSession(sessionId) {
  if (!sessionId) return null;

  const raw = await sessions().get(SESSION_PREFIX + sessionId);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.userId) return null;
    return { id: sessionId, userId: parsed.userId, email: parsed.email };
  } catch {
    return null;
  }
}

export async function destroySession(sessionId) {
  if (sessionId) await sessions().delete(SESSION_PREFIX + sessionId);
}

/**
 * Only ever redirect to a path on this site.
 *
 * `?next=https://evil.example/login` on a real login page is a textbook open
 * redirect: the link genuinely comes from your domain, so it survives casual
 * inspection, and the victim lands on a convincing fake. Requiring a leading
 * "/" and rejecting "//" (protocol-relative, e.g. //evil.example) closes it.
 */
export function safeNextPath(next, fallback = "/tickets") {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}

/**
 * Cookie flags, each earning its place:
 *   httpOnly - JavaScript cannot read it, so an XSS bug cannot steal the session
 *   secure   - never sent over plain HTTP (browsers still allow this on localhost)
 *   sameSite lax - not attached to cross-site POSTs, which is the CSRF defence
 *   maxAge   - matches the KV TTL so cookie and server state expire together
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
