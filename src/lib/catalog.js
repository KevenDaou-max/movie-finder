import { env } from "cloudflare:workers";
import {
  fetchDetail, fetchDiscover, fetchList, fetchNowPlaying, fetchRecommendations, fetchSearch,
  fetchTopRated, fetchTrending, fetchUpcoming, fetchWatchProviders, WATCH_REGION,
} from "./tmdb.js";

// Seconds. Details barely change; popularity ordering does; streaming rights
// change with licensing deals, so providers sit between the two.
const TTL = { list: 60 * 60, search: 15 * 60, detail: 24 * 60 * 60, providers: 6 * 60 * 60 };

const nowSeconds = () => Math.floor(Date.now() / 1000);
const isFresh = (syncedAt, ttl) => typeof syncedAt === "number" && nowSeconds() - syncedAt < ttl;
const db = () => env.DB;

// The cache is an optimisation, never a dependency: if D1 is unreachable or
// unbound, every path below still serves live TMDB data.
function withoutDb(err) {
  console.error("[catalog] D1 unavailable, falling through to TMDB:", err);
  return null;
}

const MOVIE_COLUMNS = "id, title, overview, poster_path, release_date, vote_average, popularity";

const UPSERT_LIST_MOVIE = `
  INSERT INTO movies (id, title, overview, poster_path, release_date, vote_average, popularity, raw_json, list_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    overview = excluded.overview,
    poster_path = excluded.poster_path,
    release_date = excluded.release_date,
    vote_average = excluded.vote_average,
    popularity = excluded.popularity,
    -- A list response is a subset of a detail response, so never let it
    -- downgrade raw_json for a row we already fetched in full.
    raw_json = CASE WHEN movies.detail_synced_at IS NULL THEN excluded.raw_json ELSE movies.raw_json END,
    list_synced_at = excluded.list_synced_at`;

const UPSERT_DETAIL_MOVIE = `
  INSERT INTO movies (id, title, overview, poster_path, release_date, vote_average, popularity, runtime, trailer_key, raw_json, list_synced_at, detail_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    overview = excluded.overview,
    poster_path = excluded.poster_path,
    release_date = excluded.release_date,
    vote_average = excluded.vote_average,
    popularity = excluded.popularity,
    runtime = excluded.runtime,
    trailer_key = excluded.trailer_key,
    raw_json = excluded.raw_json,
    list_synced_at = COALESCE(movies.list_synced_at, excluded.list_synced_at),
    detail_synced_at = excluded.detail_synced_at`;

/** Statements linking a movie to its genres, replacing whatever was there. */
function genreStatements(movieId, genres) {
  const statements = [db().prepare("DELETE FROM movie_genres WHERE movie_id = ?").bind(movieId)];
  for (const genre of genres) {
    // movie_genres has a foreign key onto genres, and TMDB can introduce a
    // genre id our seed doesn't know, so the genre row must exist first.
    //
    // The two cases are NOT symmetric, and conflating them was a real bug:
    // list responses carry genre ids with no names, and an unconditional
    // upsert wrote "Genre 878" over the seeded "Science Fiction". Browsing
    // happens far more often than opening a detail page, so placeholders won
    // and every genre name in the database was eventually destroyed.
    statements.push(
      genre.name
        // A detail response carries real names; treat those as authoritative.
        ? db()
            .prepare("INSERT INTO genres (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name")
            .bind(genre.id, genre.name)
        // A list response knows only the id. Insert a placeholder if the genre
        // is entirely unknown, but never overwrite a name we already have.
        : db()
            .prepare("INSERT OR IGNORE INTO genres (id, name) VALUES (?, ?)")
            .bind(genre.id, `Genre ${genre.id}`)
    );
    statements.push(
      db()
        .prepare("INSERT OR IGNORE INTO movie_genres (movie_id, genre_id) VALUES (?, ?)")
        .bind(movieId, genre.id)
    );
  }
  return statements;
}

/** TMDB list rows carry `genre_ids`; detail rows carry `genres: [{id, name}]`. */
const genresOf = (movie) =>
  movie.genres?.map((g) => ({ id: g.id, name: g.name })) ??
  movie.genre_ids?.map((id) => ({ id, name: null })) ??
  [];

async function writeListMovies(movies, ts) {
  const upsert = db().prepare(UPSERT_LIST_MOVIE);
  const statements = [];
  for (const movie of movies) {
    statements.push(
      upsert.bind(
        movie.id,
        movie.title ?? "Untitled",
        movie.overview ?? null,
        movie.poster_path ?? null,
        movie.release_date ?? null,
        movie.vote_average ?? null,
        movie.popularity ?? null,
        JSON.stringify(movie),
        ts
      ),
      ...genreStatements(movie.id, genresOf(movie))
    );
  }
  if (statements.length) await db().batch(statements);
}

/** Reads movies by id and returns them in the order the ids were given. */
async function hydrate(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");

  const [movieRows, genreRows] = await Promise.all([
    db().prepare(`SELECT ${MOVIE_COLUMNS} FROM movies WHERE id IN (${placeholders})`).bind(...ids).all(),
    db().prepare(`SELECT movie_id, genre_id FROM movie_genres WHERE movie_id IN (${placeholders})`).bind(...ids).all(),
  ]);

  const genreIdsByMovie = new Map();
  for (const row of genreRows.results) {
    const list = genreIdsByMovie.get(row.movie_id) ?? [];
    list.push(row.genre_id);
    genreIdsByMovie.set(row.movie_id, list);
  }

  const byId = new Map(
    movieRows.results.map((row) => [row.id, { ...row, genre_ids: genreIdsByMovie.get(row.id) ?? [] }])
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Shared read-through path for every paginated list. `page` order comes from
 * the stored id array, so results stay stable as TMDB's popularity drifts.
 *
 * `ttl` is per-call rather than per-table because list_pages now holds rows
 * whose data moves at very different speeds: trending is recomputed constantly
 * while top-rated is effectively static. Defaulting it keeps every existing
 * caller unchanged.
 */
async function getPage({ table, keyColumn, keyValue, page, fetchFresh, waitUntil, ttl }) {
  let cached = null;
  try {
    cached = await db()
      .prepare(`SELECT movie_ids, total_pages, fetched_at FROM ${table} WHERE ${keyColumn} = ? AND page = ?`)
      .bind(keyValue, page)
      .first();
  } catch (err) {
    withoutDb(err);
  }

  const serveCached = async (source) => {
    const results = await hydrate(JSON.parse(cached.movie_ids));
    // A page whose movies have been deleted underneath it is a miss, not a hit.
    return results.length ? { page, results, total_pages: cached.total_pages, source } : null;
  };

  const effectiveTtl = ttl ?? TTL[table === "search_cache" ? "search" : "list"];

  if (cached && isFresh(cached.fetched_at, effectiveTtl)) {
    try {
      const hit = await serveCached("cache");
      if (hit) return hit;
    } catch (err) {
      withoutDb(err);
    }
  }

  try {
    const data = await fetchFresh();
    const ts = nowSeconds();

    const write = (async () => {
      const results = data.results ?? [];
      await writeListMovies(results, ts);
      await db()
        .prepare(
          `INSERT INTO ${table} (${keyColumn}, page, movie_ids, total_pages, fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(${keyColumn}, page) DO UPDATE SET
             movie_ids = excluded.movie_ids,
             total_pages = excluded.total_pages,
             fetched_at = excluded.fetched_at`
        )
        .bind(keyValue, page, JSON.stringify(results.map((m) => m.id)), data.total_pages ?? 1, ts)
        .run();
    })().catch(withoutDb);

    // Never make the visitor wait on the cache write.
    if (waitUntil) waitUntil(write);
    else await write;

    return {
      page: data.page ?? page,
      results: data.results ?? [],
      total_pages: data.total_pages ?? 1,
      source: "tmdb",
    };
  } catch (err) {
    // TMDB is down or rate-limiting: expired data beats no data.
    if (cached) {
      try {
        const stale = await serveCached("stale");
        if (stale) return stale;
      } catch (dbErr) {
        withoutDb(dbErr);
      }
    }
    throw err;
  }
}

export function getListPage({ genre, page, waitUntil }) {
  return getPage({
    table: "list_pages",
    keyColumn: "list_key",
    keyValue: genre ? `genre:${genre}` : "popular",
    page,
    fetchFresh: () => fetchList({ genre, page }),
    waitUntil,
  });
}

/**
 * Homepage browse rows. Each is one new `list_key` in list_pages — no new
 * table, no new columns — and differs only in how quickly its data goes stale.
 *
 * TTLs are chosen from how fast TMDB actually changes each list, not from
 * guesswork: trending is recomputed constantly, top-rated barely moves in a
 * year, so refreshing them at the same rate would either waste calls or serve
 * stale data.
 */
export const ROW_TTL = {
  trending: 3 * 60 * 60,
  nowPlaying: 12 * 60 * 60,
  upcoming: 24 * 60 * 60,
  topRated: 7 * 24 * 60 * 60,
  recommendations: 24 * 60 * 60,
};

const listRow = (keyValue, fetchFresh, ttl, page = 1, waitUntil) =>
  getPage({ table: "list_pages", keyColumn: "list_key", keyValue, page, fetchFresh, waitUntil, ttl });

export const getTrending = ({ page = 1, waitUntil } = {}) =>
  listRow("trending", () => fetchTrending(page), ROW_TTL.trending, page, waitUntil);

export const getNowPlaying = ({ page = 1, waitUntil } = {}) =>
  listRow("now_playing", () => fetchNowPlaying(page), ROW_TTL.nowPlaying, page, waitUntil);

export const getUpcoming = ({ page = 1, waitUntil } = {}) =>
  listRow("upcoming", () => fetchUpcoming(page), ROW_TTL.upcoming, page, waitUntil);

export const getTopRated = ({ page = 1, waitUntil } = {}) =>
  listRow("top_rated", () => fetchTopRated(page), ROW_TTL.topRated, page, waitUntil);

/**
 * TMDB's recommendations for one film. Keyed by movie rather than by user, so a
 * popular seed is cached ONCE and serves every user who has seen it — which is
 * why personalised recommendations need no per-user cache table.
 */
export const getMovieRecommendations = (movieId, { waitUntil } = {}) =>
  listRow(`recs:${movieId}`, () => fetchRecommendations(movieId, 1), ROW_TTL.recommendations, 1, waitUntil);

/**
 * AI search results ride the exact same read-through machinery as the genre
 * tabs: same table, same hydration, same stale-on-error behaviour, same
 * X-Movie-Cache reporting. The only new thing is the key.
 *
 * Keys are built from sorted parameters so that two identical searches produce
 * one cache entry regardless of the order the fields were assembled in.
 */
export function getDiscoverPage({ params, page, waitUntil }) {
  const key = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");

  return getPage({
    table: "list_pages",
    keyColumn: "list_key",
    keyValue: `discover:${key}`,
    page,
    fetchFresh: () => fetchDiscover(params, page),
    waitUntil,
  });
}

export function getSearchPage({ query, page, waitUntil }) {
  return getPage({
    table: "search_cache",
    keyColumn: "query",
    keyValue: query.trim().toLowerCase(),
    page,
    fetchFresh: () => fetchSearch({ query, page }),
    waitUntil,
  });
}

/**
 * Title straight from the cache, for stamping onto a booking. Returns null if
 * the movie isn't cached or D1 is unavailable — a soft dependency, since the
 * caller falls back to the title the client sent.
 */
export async function getCachedTitle(movieId) {
  try {
    const row = await db().prepare("SELECT title FROM movies WHERE id = ?").bind(movieId).first();
    return row?.title ?? null;
  } catch (err) {
    return withoutDb(err);
  }
}

// Rendered in this order; TMDB also uses `free` and `ads` for some titles.
const OFFER_TYPES = ["flatrate", "free", "ads", "rent", "buy"];

/**
 * Always returns an object, never null: an empty result means "we know there is
 * nothing", which is different from "we could not find out".
 */
function shapeProviders(block, source) {
  const region = block ?? {};
  const offers = {};

  for (const type of OFFER_TYPES) {
    const list = region[type];
    if (Array.isArray(list) && list.length) {
      offers[type] = list
        // TMDB's own ranking; slice() because sort mutates.
        .slice()
        .sort((a, b) => (a.display_priority ?? 0) - (b.display_priority ?? 0))
        .map((p) => ({ id: p.provider_id, name: p.provider_name, logo_path: p.logo_path }));
    }
  }

  return { link: region.link ?? null, offers, hasOffers: Object.keys(offers).length > 0, source };
}

/** Streaming availability for one movie in WATCH_REGION, or null if unknowable. */
export async function getWatchProviders(movieId, { waitUntil } = {}) {
  let cached = null;
  try {
    cached = await db()
      .prepare("SELECT payload, fetched_at FROM watch_providers WHERE movie_id = ? AND region = ?")
      .bind(movieId, WATCH_REGION)
      .first();
  } catch (err) {
    withoutDb(err);
  }

  if (cached && isFresh(cached.fetched_at, TTL.providers)) {
    try {
      return shapeProviders(JSON.parse(cached.payload), "cache");
    } catch (err) {
      withoutDb(err);
    }
  }

  try {
    const data = await fetchWatchProviders(movieId);
    // TMDB returns ~110 regions; only the one we render is worth storing.
    const block = data.results?.[WATCH_REGION] ?? null;
    const ts = nowSeconds();

    const write = (async () => {
      await db()
        .prepare(
          `INSERT INTO watch_providers (movie_id, region, payload, fetched_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(movie_id, region) DO UPDATE SET
             payload = excluded.payload,
             fetched_at = excluded.fetched_at`
        )
        // Store {} rather than skipping: "no providers" is a real answer, and
        // caching it stops every view of an unavailable film re-asking TMDB.
        .bind(movieId, WATCH_REGION, JSON.stringify(block ?? {}), ts)
        .run();
    })().catch(withoutDb);

    if (waitUntil) waitUntil(write);
    else await write;

    return shapeProviders(block, "tmdb");
  } catch (err) {
    console.error(`[catalog] watch providers failed for ${movieId}:`, err);
    if (cached) {
      try {
        return shapeProviders(JSON.parse(cached.payload), "stale");
      } catch (dbErr) {
        withoutDb(dbErr);
      }
    }
    return null;
  }
}

function shapeDetail(row, genreNames, source) {
  return {
    id: row.id,
    title: row.title,
    overview: row.overview,
    poster_path: row.poster_path,
    release_date: row.release_date,
    vote_average: row.vote_average,
    runtime: row.runtime,
    trailer_key: row.trailer_key,
    genres: genreNames,
    source,
  };
}

const trailerKeyOf = (data) =>
  data.videos?.results?.find((v) => v.type === "Trailer" && v.site === "YouTube")?.key ?? null;

/** Returns a normalised movie, or null if it can't be resolved at all. */
export async function getMovieDetail(id, { waitUntil } = {}) {
  let cached = null;
  try {
    cached = await db().prepare("SELECT * FROM movies WHERE id = ?").bind(id).first();
  } catch (err) {
    withoutDb(err);
  }

  const cachedGenres = async () => {
    const rows = await db()
      .prepare(
        `SELECT g.name FROM movie_genres mg
         JOIN genres g ON g.id = mg.genre_id
         WHERE mg.movie_id = ?`
      )
      .bind(id)
      .all();
    return rows.results.map((r) => r.name);
  };

  // Only a full detail fetch fills runtime/trailer_key, so a row that was only
  // ever seen in a list is not good enough here.
  if (cached?.detail_synced_at && isFresh(cached.detail_synced_at, TTL.detail)) {
    try {
      return shapeDetail(cached, await cachedGenres(), "cache");
    } catch (err) {
      withoutDb(err);
    }
  }

  try {
    const data = await fetchDetail(id);
    const ts = nowSeconds();

    const write = (async () => {
      await db().batch([
        db()
          .prepare(UPSERT_DETAIL_MOVIE)
          .bind(
            data.id,
            data.title ?? "Untitled",
            data.overview ?? null,
            data.poster_path ?? null,
            data.release_date ?? null,
            data.vote_average ?? null,
            data.popularity ?? null,
            data.runtime ?? null,
            trailerKeyOf(data),
            JSON.stringify(data),
            ts,
            ts
          ),
        ...genreStatements(data.id, genresOf(data)),
      ]);
    })().catch(withoutDb);

    if (waitUntil) waitUntil(write);
    else await write;

    return {
      id: data.id,
      title: data.title,
      overview: data.overview,
      poster_path: data.poster_path,
      release_date: data.release_date,
      vote_average: data.vote_average,
      runtime: data.runtime,
      trailer_key: trailerKeyOf(data),
      genres: (data.genres ?? []).map((g) => g.name),
      source: "tmdb",
    };
  } catch (err) {
    console.error(`[catalog] detail fetch failed for ${id}:`, err);
    if (cached?.detail_synced_at) {
      try {
        return shapeDetail(cached, await cachedGenres(), "stale");
      } catch (dbErr) {
        withoutDb(dbErr);
      }
    }
    return null;
  }
}
