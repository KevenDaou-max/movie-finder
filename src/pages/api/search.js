import { getSearchPage } from "../../lib/catalog.js";

export const prerender = false;

export async function GET({ url, locals }) {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) {
    return Response.json({ page: 1, results: [], total_pages: 0 });
  }

  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isFinite(requestedPage) ? Math.min(Math.max(Math.trunc(requestedPage), 1), 500) : 1;

  try {
    const { results, total_pages, source } = await getSearchPage({
      query,
      page,
      waitUntil: locals.cfContext?.waitUntil.bind(locals.cfContext),
    });
    return Response.json({ page, results, total_pages }, { headers: { "X-Movie-Cache": source } });
  } catch (err) {
    console.error("[api/search]", err);
    return Response.json({ error: "Search is unavailable right now." }, { status: 502 });
  }
}
