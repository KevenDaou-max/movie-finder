import { env } from "cloudflare:workers";

/**
 * Unlike catalog.js, there is deliberately no `withoutDb` here.
 *
 * The cache tables hold copies of TMDB data, so swallowing a D1 error and
 * falling through costs only latency. A ticket exists nowhere else — there is
 * nothing to fall through to. Swallowing a failed write would tell someone they
 * have a booking when they do not, so every error in this file propagates and
 * becomes a 500.
 */
const db = () => env.DB;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// 32 characters with I, O, 0 and 1 removed so a code is unambiguous read aloud.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 5;
const MAX_LOOKUP_IDS = 50;

const COLUMNS =
  "id, confirmation, movie_id, movie_title, cinema, showtime, seats, unit_price_cents, status, created_at, paid_at, redeemed_at";

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

export function getTicket(id) {
  return db().prepare(`SELECT ${COLUMNS} FROM tickets WHERE id = ?`).bind(id).first();
}

export async function getTickets(ids) {
  const capped = ids.slice(0, MAX_LOOKUP_IDS);
  if (!capped.length) return [];

  const placeholders = capped.map(() => "?").join(",");
  const { results } = await db()
    .prepare(`SELECT ${COLUMNS} FROM tickets WHERE id IN (${placeholders}) ORDER BY created_at DESC`)
    .bind(...capped)
    .all();
  return results;
}

/**
 * Returns the new ticket, or null if this client's booking cap was reached.
 *
 * The cap is enforced by the INSERT itself rather than by a SELECT beforehand.
 * `INSERT ... SELECT ... WHERE (subquery) < cap` writes zero rows once the
 * limit is hit, so two simultaneous requests cannot both pass a check and then
 * both insert. Same compare-and-swap reasoning as the status transitions.
 */
export async function createTicket({
  movieId, movieTitle, cinema, showtime, seats, unitPriceCents, clientKey, cap, windowStart,
}) {
  const id = crypto.randomUUID();
  const result = await db()
    .prepare(
      `INSERT INTO tickets (id, movie_id, movie_title, cinema, showtime, seats, unit_price_cents, status, created_at, client_key)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?
       WHERE (SELECT COUNT(*) FROM tickets WHERE client_key = ? AND created_at >= ?) < ?`
    )
    .bind(
      id, movieId, movieTitle, cinema, showtime, seats, unitPriceCents, nowSeconds(), clientKey,
      clientKey, windowStart, cap
    )
    .run();

  return result.meta.changes === 1 ? getTicket(id) : null;
}

/** How many bookings this client has in the window, and the oldest one's time. */
export async function bookingUsage(clientKey, windowStart) {
  const row = await db()
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
       FROM tickets WHERE client_key = ? AND created_at >= ?`
    )
    .bind(clientKey, windowStart)
    .first();
  return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
}

/**
 * Every transition is a compare-and-swap: the UPDATE carries the expected
 * current status in its WHERE clause, then we check how many rows actually
 * changed. If two requests race, or someone double-clicks Pay, exactly one
 * wins and the other sees changes === 0. Reading the status first and then
 * writing would leave a window between the two where both callers see 'booked'.
 *
 * Returns { ok, ticket }: ok false with a ticket means the transition was not
 * legal from its current status; a null ticket means no such ticket.
 */
async function transition(id, sql, bindings) {
  const result = await db().prepare(sql).bind(...bindings).run();
  const ticket = await getTicket(id);
  return { ok: result.meta.changes === 1, ticket };
}

export async function payTicket(id) {
  // A collision needs two identical 5-character codes; the retry exists so that
  // the UNIQUE constraint can never turn into a user-visible 500.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await transition(
        id,
        `UPDATE tickets SET status = 'paid', confirmation = ?, paid_at = ?
         WHERE id = ? AND status = 'booked'`,
        [generateConfirmation(), nowSeconds(), id]
      );
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
}

export function redeemTicket(id) {
  return transition(
    id,
    `UPDATE tickets SET status = 'redeemed', redeemed_at = ?
     WHERE id = ? AND status = 'paid'`,
    [nowSeconds(), id]
  );
}
