import {
  buildDiscoverParams, describeIntent, genreNamesById, interpret,
  MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, normaliseQuery, relaxationLadder,
} from "../../lib/ai-search.js";
import { getDiscoverPage, getSearchPage } from "../../lib/catalog.js";
import { getClientKey } from "../../lib/rate-limit.js";
import { throttleExceeded } from "../../lib/users.js";

export const prerender = false;

// Inference costs Neurons from a shared daily allowance, so an uncapped public
// endpoint could exhaust the budget for everyone. Reuses the auth_throttle
// table under an "ai:" key prefix, which keeps this counter completely separate
// from login attempts despite sharing the table.
const AI_SEARCH_CAP = 10;
const AI_SEARCH_WINDOW_SECONDS = 60 * 60;

/**
 * Natural-language movie search.
 *
 * Everything AI-related happens here on the server: the browser never sees the
 * binding, the model name, or the prompt — same reasoning as proxying TMDB.
 *
 * The response is deliberately shaped like every other search endpoint
 * ({ page, results, total_pages }) so the existing movie card renderer needs no
 * changes. The extra fields are additive.
 */
export async function GET({ url, request, locals }) {
  const query = normaliseQuery(url.searchParams.get("q"));

  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: `Search text must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const waitUntil = locals.cfContext?.waitUntil.bind(locals.cfContext);

  const clientKey = await getClientKey(request);
  if (await throttleExceeded(`ai:${clientKey}`, AI_SEARCH_CAP, AI_SEARCH_WINDOW_SECONDS)) {
    return Response.json(
      { error: `AI search limit reached (${AI_SEARCH_CAP} per hour). Plain search still works.` },
      { status: 429, headers: { "Retry-After": String(AI_SEARCH_WINDOW_SECONDS) } }
    );
  }

  /** Plain keyword search — the path this endpoint degrades to, never an error. */
  const keywordFallback = async (reason) => {
    const result = await getSearchPage({ query, page: 1, waitUntil });
    return Response.json(
      {
        page: 1,
        results: result.results,
        total_pages: result.total_pages,
        strategy: "fallback",
        reason,
        interpretation: null,
      },
      { headers: { "X-Movie-Cache": result.source, "X-AI-Strategy": "fallback" } }
    );
  };

  try {
    const { intent, cached } = await interpret(query, { waitUntil });

    // The model produced nothing usable, or validation stripped it all.
    if (!intent) return keywordFallback("Couldn't interpret that");

    const built = await buildDiscoverParams(intent);
    // Every name failed to resolve to a TMDB id.
    if (!built) return keywordFallback("Couldn't match that to anything");

    // Try the most specific query first, then progressively broader ones.
    const attempts = relaxationLadder(built.params);

    for (const [index, params] of attempts.entries()) {
      const result = await getDiscoverPage({ params, page: 1, waitUntil });
      if (!result.results.length) continue;

      const description = describeIntent(intent, built.resolved, await genreNamesById());
      return Response.json(
        {
          page: 1,
          results: result.results,
          total_pages: result.total_pages,
          strategy: "ai",
          // Say so when the exact query was too narrow, rather than quietly
          // presenting broader results as if they were what was asked for.
          interpretation: index === 0 ? description : `${description} (broadened)`,
          relaxed: index > 0,
          cached_interpretation: cached,
        },
        { headers: { "X-Movie-Cache": result.source, "X-AI-Strategy": cached ? "ai-cached" : "ai" } }
      );
    }

    // Even the broadest form of the interpretation found nothing.
    return keywordFallback("No matches for that interpretation");
  } catch (err) {
    // Anything unforeseen still degrades rather than failing the request.
    console.error("[api/ai-search]", err);
    try {
      return await keywordFallback("AI search unavailable");
    } catch (fallbackErr) {
      console.error("[api/ai-search] fallback also failed", fallbackErr);
      return Response.json({ error: "Search is unavailable right now." }, { status: 502 });
    }
  }
}
