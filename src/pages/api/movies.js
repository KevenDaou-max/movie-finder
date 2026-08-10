import { getListPage } from "../../lib/catalog.js";

export const prerender = false;

export async function GET({ url, locals }) {
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  // TMDB refuses pages above 500, and unbounded input would pollute the cache
  // with keys that can never be served.
  const page = Number.isFinite(requestedPage) ? Math.min(Math.max(Math.trunc(requestedPage), 1), 500) : 1;

  const genreParam = url.searchParams.get("genre");
  const genre = genreParam && /^\d+$/.test(genreParam) ? genreParam : null;

  try {
    const { results, total_pages, source } = await getListPage({
      genre,
      page,
      waitUntil: locals.cfContext?.waitUntil.bind(locals.cfContext),
    });
    return Response.json({ page, results, total_pages }, { headers: { "X-Movie-Cache": source } });
  } catch (err) {
    console.error("[api/movies]", err);
    return Response.json({ error: "Unable to load movies right now." }, { status: 502 });
  }
}
