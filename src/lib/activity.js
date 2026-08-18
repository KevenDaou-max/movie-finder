import { env } from "cloudflare:workers";

/**
 * User activity tracking — the input to personalised recommendations.
 *
 * A third error philosophy, distinct from the two already in this codebase:
 *
 *   catalog.js  cache     swallow errors, fall back to TMDB
 *   tickets.js  record    fail loudly, the data exists nowhere else
 *   activity.js telemetry swallow errors, and never block anything
 *
 * Losing a row here costs a little recommendation quality and nothing else, so
 * a failed write must never turn a movie page into a 500. Every function is
 * best-effort by design.
 */
const db = () => env.DB;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Completing a booking says far more about taste than clicking a poster.
export const ACTION_WEIGHTS = { book: 5, view: 1 };

// Older behaviour still counts, but taste drifts; anything beyond this is noise.
export const HISTORY_WINDOW_SECONDS = 90 * 24 * 60 * 60;

// Refreshing a page shouldn't inflate the signal. Genuine repeat interest
// across days still counts — only rapid repeats are collapsed.
const DEDUP_WINDOW_SECONDS = 30 * 60;

const MAX_HISTORY_ROWS = 200;

/**
 * Best-effort. Returns nothing and throws nothing: callers pass this to
 * waitUntil and carry on rendering.
 */
export async function recordActivity(userId, movieId, action) {
  if (!userId || !Number.isInteger(movieId) || !ACTION_WEIGHTS[action]) return;

  try {
    // Insert only if this exact interaction wasn't just recorded. Doing it as
    // one conditional INSERT rather than SELECT-then-INSERT keeps it to a
    // single round trip and cannot race with itself.
    await db()
      .prepare(
        `INSERT INTO user_activity (user_id, movie_id, action, created_at)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM user_activity
           WHERE user_id = ? AND movie_id = ? AND action = ? AND created_at > ?
         )`
      )
      .bind(
        userId, movieId, action, nowSeconds(),
        userId, movieId, action, nowSeconds() - DEDUP_WINDOW_SECONDS
      )
      .run();
  } catch (err) {
    console.error("[activity] write failed (ignored):", err);
  }
}

/**
 * The user's movies, scored by action weight and collapsed per movie. Highest
 * scoring first — these become recommendation seeds.
 */
export async function getEngagedMovies(userId) {
  try {
    const { results } = await db()
      .prepare(
        `SELECT movie_id,
                SUM(CASE action WHEN 'book' THEN ? ELSE ? END) AS score,
                MAX(created_at) AS last_seen
         FROM user_activity
         WHERE user_id = ? AND created_at > ?
         GROUP BY movie_id
         ORDER BY score DESC, last_seen DESC
         LIMIT ?`
      )
      .bind(
        ACTION_WEIGHTS.book, ACTION_WEIGHTS.view,
        userId, nowSeconds() - HISTORY_WINDOW_SECONDS, MAX_HISTORY_ROWS
      )
      .all();
    return results;
  } catch (err) {
    console.error("[activity] history read failed (ignored):", err);
    return [];
  }
}

/**
 * Weighted genre tally across everything the user has engaged with. The
 * fallback strategy when there isn't enough history to seed from real titles.
 *
 * Joins through movie_genres, which means it only sees genres for movies still
 * in the cache — acceptable, because this is a hint, not a record.
 */
export async function getGenreAffinity(userId, limit = 3) {
  try {
    const { results } = await db()
      .prepare(
        `SELECT mg.genre_id,
                SUM(CASE a.action WHEN 'book' THEN ? ELSE ? END) AS score
         FROM user_activity a
         JOIN movie_genres mg ON mg.movie_id = a.movie_id
         WHERE a.user_id = ? AND a.created_at > ?
         GROUP BY mg.genre_id
         ORDER BY score DESC
         LIMIT ?`
      )
      .bind(
        ACTION_WEIGHTS.book, ACTION_WEIGHTS.view,
        userId, nowSeconds() - HISTORY_WINDOW_SECONDS, limit
      )
      .all();
    return results.map((row) => row.genre_id);
  } catch (err) {
    console.error("[activity] genre affinity failed (ignored):", err);
    return [];
  }
}
