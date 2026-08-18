import { env } from "cloudflare:workers";

const BASE = "https://api.themoviedb.org/3";

// Read lazily, not at module scope: bindings only exist once a request is in
// flight, and a missing key should surface as a caught error, not a boot crash.
function apiKey() {
  const key = env.TMDB_KEY;
  if (!key) {
    throw new Error(
      "TMDB_KEY is not set. Put it in .env for dev, or run `wrangler secret put TMDB_KEY` for production."
    );
  }
  return key;
}

async function tmdb(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", apiKey());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB ${path} responded ${res.status}`);
  }
  return res.json();
}

export function fetchList({ genre, page }) {
  return genre
    ? tmdb("/discover/movie", { with_genres: genre, page, sort_by: "popularity.desc" })
    : tmdb("/movie/popular", { page });
}

export function fetchSearch({ query, page }) {
  return tmdb("/search/movie", { query, page });
}

export function fetchDetail(id) {
  return tmdb(`/movie/${id}`, { append_to_response: "videos" });
}

/**
 * Resolve a person's name to a TMDB id. This is the step that makes "a movie
 * with The Rock in it" work at all: `with_cast` needs an id, and no amount of
 * semantic similarity over plot summaries would find one, because overviews
 * rarely name their cast.
 */
export async function searchPerson(name) {
  const data = await tmdb("/search/person", { query: name });
  return data.results?.[0] ?? null;
}

/**
 * Resolve a mood word to a TMDB keyword id. TMDB maintains a large curated
 * keyword vocabulary ('feel-good', 'coming of age', 'dystopia'), which gives
 * us a human-authored semantic layer without embedding anything.
 */
export async function searchKeyword(word) {
  const data = await tmdb("/search/keyword", { query: word });
  const results = data.results ?? [];
  if (!results.length) return null;

  // Do NOT just take results[0]. TMDB ranks keyword matches by string
  // similarity, so "feel good" returns "feel good music" (which tags no films)
  // ahead of "feelgood" (which tags plenty). Prefer an exact match ignoring
  // punctuation and spacing, then the shortest name — shorter keywords are
  // more general and therefore tag more movies.
  const flatten = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = flatten(word);

  return (
    results.find((keyword) => flatten(keyword.name) === target) ??
    results.slice().sort((a, b) => a.name.length - b.name.length)[0]
  );
}

/** Structured search. `params` is built by us, never by the model. */
export function fetchDiscover(params, page) {
  return tmdb("/discover/movie", { ...params, page });
}

// Homepage browse rows. All return the same {page, results, total_pages} shape
// as /movie/popular, which is why they need no new storage -- just new keys in
// list_pages. They differ only in how fast the underlying data moves, which is
// expressed as a TTL at the call site rather than here.
export const fetchTrending = (page) => tmdb("/trending/movie/week", { page });
export const fetchNowPlaying = (page) => tmdb("/movie/now_playing", { page });
export const fetchUpcoming = (page) => tmdb("/movie/upcoming", { page });
export const fetchTopRated = (page) => tmdb("/movie/top_rated", { page });

/**
 * TMDB's own recommendations for a film, backed by collaborative signals across
 * millions of users. Seeding from these beats anything we could compute from
 * one person's genre tallies -- the same "reuse the better index" reasoning
 * that made AI search a translator rather than a retriever.
 */
export const fetchRecommendations = (movieId, page) =>
  tmdb(`/movie/${movieId}/recommendations`, { page });

/** Change this to serve a different country's streaming availability. */
export const WATCH_REGION = "US";

/**
 * Deliberately a separate call rather than `append_to_response=watch/providers`
 * on the detail fetch: availability changes with licensing deals, runtime never
 * does, so the two need independent TTLs. The detail cache hit would otherwise
 * skip this refresh entirely.
 */
export function fetchWatchProviders(id) {
  return tmdb(`/movie/${id}/watch/providers`);
}
