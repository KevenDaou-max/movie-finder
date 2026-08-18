import { getEngagedMovies, getGenreAffinity } from "./activity.js";
import { getCachedTitle, getDiscoverPage, getMovieRecommendations } from "./catalog.js";

/**
 * Personalised recommendations, as a ladder of strategies.
 *
 *   enough history  -> seed TMDB's own /movie/{id}/recommendations
 *   thin history    -> genre affinity through /discover
 *   no history      -> null, and the caller shows Trending instead
 *
 * The first strategy exists because of the same principle that made AI search a
 * translator rather than a retriever: reuse the better index. TMDB's
 * recommendations are backed by collaborative signals across millions of users,
 * which nothing computed from one person's genre tallies can match. Our job is
 * picking good seeds, not being the recommender.
 *
 * Nothing here throws. A failed recommendation is a missing row on the
 * homepage, never an error page.
 */

const SEED_COUNT = 3;
const RESULT_COUNT = 20;

// One booking, or three distinct movies viewed, before we trust the history
// enough to seed from specific titles rather than broad genres.
const STRONG_SIGNAL_SCORE = 5;
const MIN_MOVIES_FOR_SEEDING = 3;

/**
 * Score every candidate across all seeds.
 *
 * The important property: a film recommended by MORE THAN ONE seed accumulates
 * score, so overlap between what the user liked is what rises to the top. That
 * is the entire value of merging rather than concatenating.
 *
 * Each seed contributes proportionally to how much the user engaged with it,
 * and position within that seed's list acts as a tiebreak.
 */
function mergeCandidates(seedResults, excludeIds) {
  const scores = new Map();
  const moviesById = new Map();

  for (const { seedScore, results } of seedResults) {
    const total = results.length || 1;
    results.forEach((movie, index) => {
      if (excludeIds.has(movie.id)) return; // never recommend what they've seen
      const positional = (total - index) / total;
      scores.set(movie.id, (scores.get(movie.id) ?? 0) + seedScore * positional);
      if (!moviesById.has(movie.id)) moviesById.set(movie.id, movie);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RESULT_COUNT)
    .map(([id]) => moviesById.get(id));
}

/** Strategy 1: seed from the titles the user engaged with most. */
async function fromHistory(engaged, waitUntil) {
  const seeds = engaged.slice(0, SEED_COUNT);
  const excludeIds = new Set(engaged.map((row) => row.movie_id));

  // Each of these is cached under recs:<movieId> and therefore SHARED across
  // every user who has seen that film — which is why personalisation needs no
  // per-user cache table at all.
  const seedResults = await Promise.all(
    seeds.map(async (seed) => {
      try {
        const page = await getMovieRecommendations(seed.movie_id, { waitUntil });
        return { seedScore: seed.score, results: page.results ?? [] };
      } catch {
        return { seedScore: seed.score, results: [] };
      }
    })
  );

  const movies = mergeCandidates(seedResults, excludeIds);
  if (!movies.length) return null;

  // Name the strongest seed so the row can explain itself, the same way the AI
  // search chip does. A recommendation you can't account for is one people
  // learn to ignore.
  const because = await getCachedTitle(seeds[0].movie_id).catch(() => null);
  return { movies, basis: "history", because };
}

/** Strategy 2: their most-engaged genres, through discover. */
async function fromGenres(userId, engaged, waitUntil) {
  const genreIds = await getGenreAffinity(userId);
  if (!genreIds.length) return null;

  const page = await getDiscoverPage({
    params: {
      // "|" is OR: match any of their genres rather than requiring all of them.
      with_genres: genreIds.join("|"),
      sort_by: "popularity.desc",
      "vote_count.gte": 100,
    },
    page: 1,
    waitUntil,
  });

  const excludeIds = new Set(engaged.map((row) => row.movie_id));
  const movies = (page.results ?? []).filter((movie) => !excludeIds.has(movie.id)).slice(0, RESULT_COUNT);

  return movies.length ? { movies, basis: "genres", because: null } : null;
}

/**
 * Returns { movies, basis, because } or null when there is nothing personal to
 * show — the caller falls back to Trending.
 */
export async function getRecommendations(userId, { waitUntil } = {}) {
  if (!userId) return null;

  try {
    const engaged = await getEngagedMovies(userId);
    if (!engaged.length) return null;

    const hasStrongSignal =
      engaged.some((row) => row.score >= STRONG_SIGNAL_SCORE) || engaged.length >= MIN_MOVIES_FOR_SEEDING;

    if (hasStrongSignal) {
      const fromSeeds = await fromHistory(engaged, waitUntil);
      if (fromSeeds) return fromSeeds;
    }

    return await fromGenres(userId, engaged, waitUntil);
  } catch (err) {
    console.error("[recommendations] failed (ignored):", err);
    return null;
  }
}
