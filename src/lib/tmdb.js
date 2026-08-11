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
