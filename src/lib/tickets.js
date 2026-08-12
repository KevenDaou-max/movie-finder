import { env } from "cloudflare:workers";

/**
 * Unlike catalog.js, there is deliberately no `withoutDb` here. The cache
 * tables hold copies of TMDB data, so swallowing an error and falling through
 * costs only latency. A ticket exists nowhere else, so every error propagates
 * and becomes a 500.
 *
 * AUTHORIZATION MODEL
 * -------------------
 * Every function below takes `userId` and welds `AND user_id = ?` into its SQL.
 * That is deliberate, and it is the whole design: ownership is not a check a
 * caller performs and might forget, it is a parameter no caller can omit.
 * There is no function here that can read or mutate a ticket without an owner,
 * so a future route cannot accidentally expose one.
 *
 * A ticket belonging to someone else is indistinguishable from one that does
 * not exist — both yield null, and callers return 404. A 403 would confirm the
 * id is real, which is information the caller has not earned.
 */
const db = () => env.DB;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// 32 characters with I, O, 0 and 1 removed so a code is unambiguous read aloud.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 5;

const COLUMNS =
  "id, confirmation, user_id, movie_id, movie_title, cinema, showtime, seats, unit_price_cents, status, created_at, paid_at, redeemed_at";

/** e.g. 'MOV-4X9K2'. ~33.5M combinations; UNIQUE in SQL is the real guarantee. */
function generateConfirmation() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  // 256 is an exact multiple of 32, so this modulo introduces no bias.
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `MOV-${code}`;
}

// D1 surfaces constraint failures as message text rather than an error code.
const isUniqueViolation = (err) => String(err?.message ?? "").includes("UNIQUE constraint failed");

/** Null when the ticket does not exist OR is not this user's. */
export function getTicketForUser(id, userId) {
  return db()
    .prepare(`SELECT ${COLUMNS} FROM tickets WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first();
}

/** Takes no id list at all — the session decides which rows exist for you. */
export async function getTicketsForUser(userId) {
  const { results } = await db()
    .prepare(`SELECT ${COLUMNS} FROM tickets WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all();
  return results;
}

/**
 * Returns the new ticket, or null if this user's booking cap was reached.
 *
 * The cap is enforced by the INSERT itself rather than a SELECT beforehand:
 * `INSERT ... SELECT ... WHERE (subquery) < cap` writes zero rows once the
 * limit is hit, so two simultaneous requests cannot both pass a check and then
 * both insert. Now scoped per user rather than per IP, since an account is a
 * stronger identity than an address.
 */
export async function createTicket({
  userId, movieId, movieTitle, cinema, showtime, seats, unitPriceCents, clientKey, cap, windowStart,
}) {
  const id = crypto.randomUUID();
  const result = await db()
    .prepare(
      `INSERT INTO tickets (id, user_id, movie_id, movie_title, cinema, showtime, seats, unit_price_cents, status, created_at, client_key)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?
       WHERE (SELECT COUNT(*) FROM tickets WHERE user_id = ? AND created_at >= ?) < ?`
    )
    .bind(
      id, userId, movieId, movieTitle, cinema, showtime, seats, unitPriceCents, nowSeconds(), clientKey,
      userId, windowStart, cap
    )
    .run();

  return result.meta.changes === 1 ? getTicketForUser(id, userId) : null;
}

/** How many bookings this user has in the window, and the oldest one's time. */
export async function bookingUsage(userId, windowStart) {
  const row = await db()
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
       FROM tickets WHERE user_id = ? AND created_at >= ?`
    )
    .bind(userId, windowStart)
    .first();
  return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
}

/**
 * Every transition is a compare-and-swap that carries BOTH the expected status
 * and the owner in its WHERE clause. If either fails to match, zero rows change
 * and nothing happens. Ownership is therefore enforced atomically by the same
 * statement that performs the write — there is no window between checking who
 * owns the ticket and acting on it.
 *
 * Returns { ok, ticket }. A null ticket means "not found, or not yours" and the
 * caller must answer 404 either way.
 */
async function transition(id, userId, sql, bindings) {
  const result = await db().prepare(sql).bind(...bindings).run();
  const ticket = await getTicketForUser(id, userId);
  return { ok: result.meta.changes === 1, ticket };
}

export async function payTicket(id, userId) {
  // A collision needs two identical 5-character codes; the retry exists so the
  // UNIQUE constraint can never turn into a user-visible 500.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await transition(
        id,
        userId,
        `UPDATE tickets SET status = 'paid', confirmation = ?, paid_at = ?
         WHERE id = ? AND user_id = ? AND status = 'booked'`,
        [generateConfirmation(), nowSeconds(), id, userId]
      );
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
}

export function redeemTicket(id, userId) {
  return transition(
    id,
    userId,
    `UPDATE tickets SET status = 'redeemed', redeemed_at = ?
     WHERE id = ? AND user_id = ? AND status = 'paid'`,
    [nowSeconds(), id, userId]
  );
}
