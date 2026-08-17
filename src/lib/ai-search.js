import { env } from "cloudflare:workers";
import { searchKeyword, searchPerson } from "./tmdb.js";

/**
 * Natural language -> structured TMDB search intent.
 *
 * The architecture is "AI as translator": the model's only job is to turn a
 * phrase into a fixed set of fields. Retrieval is still TMDB's, because the
 * index you search sets the ceiling — TMDB covers ~1M films with real cast and
 * genre metadata, while a local vector index would cover only what we happen
 * to have cached.
 *
 * Error philosophy: this whole module is an *enhancement* over keyword search,
 * which always works. So unlike tickets.js, nothing here is fatal — every
 * failure path degrades to the ordinary search the app already had.
 */

// 8B rather than 70B: ~50-200 Neurons per call against a 10,000/day free
// allowance, versus ~500-2000. Kept as a constant so it is one edit to A/B
// against @cf/meta/llama-3.3-70b-instruct-fp8-fast.
//
// The plain `@cf/meta/llama-3.1-8b-instruct` was retired on 2026-05-30; this
// fp8 build is its live replacement. Check `wrangler ai models` before
// assuming any model id still exists.
export const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

// The text -> intent mapping is stable (temperature 0), so this can be long.
const INTENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 200;

const MAX_PEOPLE = 3;
const MAX_GENRES = 4;
const MAX_KEYWORDS = 3;

// Only these three, mapped to TMDB's sort strings by us. The model never sees
// or emits a TMDB parameter value.
const SORTS = {
  popularity: "popularity.desc",
  rating: "vote_average.desc",
  newest: "primary_release_date.desc",
};

const db = () => env.DB;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export const normaliseQuery = (text) => String(text ?? "").trim().replace(/\s+/g, " ");

async function hashQuery(text) {
  const bytes = new TextEncoder().encode(text.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SYSTEM_PROMPT = `You convert a movie search phrase into JSON search filters.
Reply with ONLY a JSON object and no other text.

Optional fields (omit anything that does not apply):
  people      array of person names mentioned, max 3, full real names
  genres      array chosen ONLY from: Action, Adventure, Animation, Comedy, Crime,
              Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery,
              Romance, Science Fiction, TV Movie, Thriller, War, Western
  keywords    array of 1-2 word themes or moods, max 3
  year_from   integer year
  year_to     integer year
  min_rating  number from 0 to 10
  sort_by     one of: popularity, rating, newest

Rules:
- Use the exact genre spellings above ("Science Fiction", never "Sci-Fi").
- If no specific person is named, ALWAYS include at least one genre.
- Prefer genres over keywords; keywords are narrow and match few films.

Examples:
"a movie with The Rock in it" -> {"people":["Dwayne Johnson"]}
"something uplifting for a rainy day" -> {"genres":["Comedy","Family"],"keywords":["feel good"]}
"90s sci-fi with a twist ending" -> {"genres":["Science Fiction"],"year_from":1990,"year_to":1999}
"highly rated crime films" -> {"genres":["Crime"],"min_rating":7.5,"sort_by":"rating"}
"scary movies about haunted houses" -> {"genres":["Horror"],"keywords":["haunted house"]}
"a feel good animated film for kids" -> {"genres":["Animation","Family"]}`;

/**
 * Models wrap JSON in prose or code fences no matter how firmly you ask them
 * not to. Pull out the first balanced-looking object rather than trusting the
 * whole response to parse.
 */
function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const cleanStrings = (value, max, maxLength = 60) =>
  Array.isArray(value)
    ? [...new Set(
        value
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim().slice(0, maxLength))
      )].slice(0, max)
    : [];

/**
 * Treat model output exactly like a request body: whitelist, coerce, cap,
 * reject. Genre names are resolved against the genres table rather than
 * trusted, and anything unrecognised is dropped rather than passed through.
 *
 * This is also the answer to prompt injection. A user can absolutely talk the
 * model into emitting something strange, but the blast radius is bounded by
 * this function: the worst achievable outcome is an odd movie search, because
 * nothing downstream ever sees a field that did not survive here.
 */
export function validateIntent(raw, genreIdsByName) {
  if (!raw || typeof raw !== "object") return null;
  const intent = {};

  const people = cleanStrings(raw.people, MAX_PEOPLE);
  if (people.length) intent.people = people;

  const keywords = cleanStrings(raw.keywords, MAX_KEYWORDS, 30);
  if (keywords.length) intent.keywords = keywords;

  if (Array.isArray(raw.genres)) {
    const ids = [...new Set(
      raw.genres
        .filter((name) => typeof name === "string")
        .map((name) => genreIdsByName.get(canonicalGenre(name)))
        .filter((id) => Number.isInteger(id))
    )].slice(0, MAX_GENRES);
    if (ids.length) intent.genreIds = ids;
  }

  const maxYear = new Date().getUTCFullYear() + 5;
  const year = (value) =>
    Number.isInteger(value) && value >= 1888 && value <= maxYear ? value : null;

  const from = year(raw.year_from);
  const to = year(raw.year_to);
  if (from) intent.yearFrom = from;
  if (to) intent.yearTo = to;
  // A reversed range would silently return nothing.
  if (intent.yearFrom && intent.yearTo && intent.yearFrom > intent.yearTo) {
    [intent.yearFrom, intent.yearTo] = [intent.yearTo, intent.yearFrom];
  }

  const rating = Number(raw.min_rating);
  if (Number.isFinite(rating) && rating > 0 && rating <= 10) {
    intent.minRating = Math.round(rating * 10) / 10;
  }

  if (typeof raw.sort_by === "string" && SORTS[raw.sort_by]) intent.sortBy = raw.sort_by;

  // An intent with no filters is worse than a keyword search.
  return Object.keys(intent).length ? intent : null;
}

/**
 * Models write genres the way people do, not the way TMDB spells them: "Sci-Fi"
 * rather than "Science Fiction". The whitelist correctly rejects the mismatch,
 * but the result is a worse query, so normalise the common variants first.
 */
const GENRE_ALIASES = new Map([
  ["sci-fi", "science fiction"],
  ["scifi", "science fiction"],
  ["sci fi", "science fiction"],
  ["science-fiction", "science fiction"],
  ["rom-com", "romance"],
  ["romcom", "romance"],
  ["romantic comedy", "romance"],
  ["kids", "family"],
  ["children", "family"],
  ["children's", "family"],
  ["animated", "animation"],
  ["cartoon", "animation"],
  ["documentaries", "documentary"],
  ["docs", "documentary"],
  ["suspense", "thriller"],
  ["biopic", "history"],
  ["biography", "history"],
  ["musical", "music"],
  ["scary", "horror"],
  ["action-adventure", "action"],
]);

const canonicalGenre = (name) => {
  const key = name.trim().toLowerCase();
  return GENRE_ALIASES.get(key) ?? key;
};

/** Genre name -> id, straight from the table the migration seeded. */
async function genreLookup() {
  const { results } = await db().prepare("SELECT id, name FROM genres").all();
  return new Map(results.map((row) => [row.name.toLowerCase(), row.id]));
}

/** id -> display name, for describing the interpretation back to the user. */
export async function genreNamesById() {
  const { results } = await db().prepare("SELECT id, name FROM genres").all();
  return new Map(results.map((row) => [row.id, row.name]));
}

async function readCachedIntent(hash) {
  const row = await db()
    .prepare("SELECT intent_json, strategy, fetched_at FROM ai_searches WHERE query_hash = ?")
    .bind(hash)
    .first();

  if (!row || nowSeconds() - row.fetched_at >= INTENT_TTL_SECONDS) return null;
  try {
    return { intent: row.intent_json ? JSON.parse(row.intent_json) : null, strategy: row.strategy };
  } catch {
    return null;
  }
}

function writeCachedIntent(hash, queryText, intent, strategy) {
  return db()
    .prepare(
      `INSERT INTO ai_searches (query_hash, query_text, intent_json, strategy, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(query_hash) DO UPDATE SET
         intent_json = excluded.intent_json,
         strategy = excluded.strategy,
         fetched_at = excluded.fetched_at`
    )
    .bind(hash, queryText.slice(0, MAX_QUERY_LENGTH), JSON.stringify(intent), strategy, nowSeconds())
    .run();
}

/**
 * Returns { intent, strategy, cached }. `intent` is null when the phrase could
 * not be turned into anything useful, and the caller falls back to keyword
 * search. Failures are cached too, so a nonsense query is not re-sent to the
 * model on every retry.
 */
export async function interpret(queryText, { waitUntil } = {}) {
  const hash = await hashQuery(queryText);

  try {
    const cached = await readCachedIntent(hash);
    if (cached) return { ...cached, cached: true };
  } catch (err) {
    console.error("[ai-search] intent cache read failed:", err);
  }

  let intent = null;
  try {
    const genreIdsByName = await genreLookup();
    const response = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: queryText },
      ],
      // Deterministic, so the cache is meaningful and results are stable.
      temperature: 0,
      max_tokens: 200,
    });

    const raw = extractJson(response?.response);
    intent = validateIntent(raw, genreIdsByName);

    // Worth keeping: when a query interprets badly, this is the only way to
    // tell "the model said nothing useful" from "validation rejected it".
    if (!intent) {
      console.error("[ai-search] unusable model output for", JSON.stringify(queryText), "->", response?.response?.slice?.(0, 300));
    }
  } catch (err) {
    // Binding missing, model error, rate limit, timeout — all the same to us.
    console.error("[ai-search] inference failed:", err);
  }

  const strategy = intent ? "ai" : "fallback";
  const write = writeCachedIntent(hash, queryText, intent, strategy).catch((err) =>
    console.error("[ai-search] intent cache write failed:", err)
  );
  if (waitUntil) waitUntil(write);
  else await write;

  return { intent, strategy, cached: false };
}

/**
 * Turn a validated intent into TMDB /discover parameters, resolving names to
 * ids. All lookups run in parallel; a name TMDB cannot resolve is simply
 * dropped rather than failing the search.
 *
 * Returns null if nothing survived resolution.
 */
export async function buildDiscoverParams(intent) {
  const [people, keywords] = await Promise.all([
    Promise.all((intent.people ?? []).map((name) => searchPerson(name).catch(() => null))),
    Promise.all((intent.keywords ?? []).map((word) => searchKeyword(word).catch(() => null))),
  ]);

  const params = {};

  const castIds = people.filter(Boolean).map((p) => p.id);
  if (castIds.length) params.with_cast = castIds.join(",");

  const keywordIds = keywords.filter(Boolean).map((k) => k.id);
  // "|" is OR in TMDB's syntax. "," would mean AND, which for moods and genres
  // is far too strict — few films are simultaneously Comedy AND Family AND Drama.
  if (keywordIds.length) params.with_keywords = keywordIds.join("|");
  if (intent.genreIds?.length) params.with_genres = intent.genreIds.join("|");

  if (intent.yearFrom) params["primary_release_date.gte"] = `${intent.yearFrom}-01-01`;
  if (intent.yearTo) params["primary_release_date.lte"] = `${intent.yearTo}-12-31`;
  if (intent.minRating) params["vote_average.gte"] = intent.minRating;

  params.sort_by = SORTS[intent.sortBy] ?? SORTS.popularity;

  // Without this, "highly rated" surfaces obscure films with a single 10/10
  // vote. A floor on vote count is what makes a rating filter mean anything.
  params["vote_count.gte"] = intent.minRating ? 200 : 50;

  return hasRealFilter(params)
    ? { params, resolved: { people: people.filter(Boolean), keywords: keywords.filter(Boolean) } }
    : null;
}

/** sort_by and a vote floor alone are not a search. */
function hasRealFilter(params) {
  return Boolean(
    params.with_cast || params.with_keywords || params.with_genres ||
    params["primary_release_date.gte"] || params["primary_release_date.lte"] ||
    params["vote_average.gte"]
  );
}

/**
 * Faceted search fails by returning nothing, not by erroring, and TMDB ANDs
 * separate parameters together — so "Comedy AND keyword:feel-good AND 50+
 * votes" can easily match zero films even though the interpretation was good.
 *
 * Rather than throwing a correct interpretation away the moment it is too
 * narrow, drop the least essential facets and try again. Order matters: the
 * things the user explicitly asked for (cast, genre, decade) are kept longest,
 * while keywords and quality floors — which we inferred — go first.
 *
 * Returns queries to attempt in order, most specific first.
 */
export function relaxationLadder(params) {
  const attempts = [params];

  if (params.with_keywords) {
    const { with_keywords, ...withoutKeywords } = params;
    attempts.push(withoutKeywords);
  }

  const narrowest = attempts[attempts.length - 1];
  if (narrowest["vote_average.gte"] || narrowest["vote_count.gte"] > 20) {
    const relaxed = { ...narrowest };
    delete relaxed["vote_average.gte"];
    relaxed["vote_count.gte"] = 20;
    attempts.push(relaxed);
  }

  return attempts.filter(hasRealFilter);
}

/** Plain-English summary shown back to the user so the AI is not a black box. */
export function describeIntent(intent, resolved, genreNamesById) {
  const parts = [];

  if (intent.minRating) parts.push(`rated ${intent.minRating}+`);
  if (intent.genreIds?.length) {
    parts.push(intent.genreIds.map((id) => genreNamesById.get(id) ?? `genre ${id}`).join(" / "));
  } else {
    parts.push("films");
  }
  if (resolved.people.length) parts.push(`starring ${resolved.people.map((p) => p.name).join(", ")}`);
  if (resolved.keywords.length) parts.push(`about ${resolved.keywords.map((k) => k.name).join(", ")}`);

  if (intent.yearFrom && intent.yearTo) parts.push(`from ${intent.yearFrom}–${intent.yearTo}`);
  else if (intent.yearFrom) parts.push(`from ${intent.yearFrom} onwards`);
  else if (intent.yearTo) parts.push(`up to ${intent.yearTo}`);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
