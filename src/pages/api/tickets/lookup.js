import { getTickets } from "../../../lib/tickets.js";

export const prerender = false;

/**
 * POST rather than GET with a query string: the id list is this browser's whole
 * identity, and POST keeps it out of server logs and browser history.
 *
 * Astro prefers a static route over a dynamic one, so /api/tickets/lookup lands
 * here rather than in [id].js.
 */
export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.ids)) {
    return Response.json({ error: "ids must be an array." }, { status: 400 });
  }

  const ids = body.ids.filter((id) => typeof id === "string" && id.length > 0);

  try {
    return Response.json({ tickets: await getTickets(ids) });
  } catch (err) {
    console.error("[api/tickets/lookup] failed", err);
    return Response.json({ error: "Could not load your tickets." }, { status: 500 });
  }
}
