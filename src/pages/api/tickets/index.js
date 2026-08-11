import { getCachedTitle } from "../../../lib/catalog.js";
import { BOOKING_CAP, BOOKING_WINDOW_SECONDS, bookingWindowStart, getClientKey } from "../../../lib/rate-limit.js";
import { findSlot } from "../../../lib/showtimes.js";
import { bookingUsage, createTicket } from "../../../lib/tickets.js";

export const prerender = false;

const MAX_TITLE_LENGTH = 200;

const bad = (message) => Response.json({ error: message }, { status: 400 });

export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Expected a JSON body.");
  }

  const movieId = Number(body.movie_id);
  if (!Number.isInteger(movieId) || movieId <= 0) {
    return bad("movie_id must be a positive integer.");
  }

  const seats = Number(body.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 10) {
    return bad("seats must be a whole number between 1 and 10.");
  }

  const cinema = typeof body.cinema === "string" ? body.cinema : "";
  const showtime = typeof body.showtime === "string" ? body.showtime : "";

  // The price is never read from the request. It is recomputed from the same
  // deterministic generator that produced the options, which simultaneously
  // proves the screening was really on offer and fixes what it costs.
  const slot = findSlot(movieId, cinema, showtime);
  if (!slot) {
    return bad("That cinema and showtime is not on offer for this movie.");
  }

  // Prefer the cached title over the client's. Falls back rather than failing:
  // the title is display data, so it must not block a booking.
  const clientTitle = typeof body.movie_title === "string" ? body.movie_title.trim() : "";
  const movieTitle = (await getCachedTitle(movieId)) ?? clientTitle.slice(0, MAX_TITLE_LENGTH) ?? "";

  // Validation runs first so junk requests never reach the database.
  const clientKey = await getClientKey(request);
  const windowStart = bookingWindowStart();

  try {
    const ticket = await createTicket({
      movieId,
      movieTitle: movieTitle || "Unknown title",
      cinema: slot.cinema,
      showtime: slot.showtime,
      seats,
      unitPriceCents: slot.unit_price_cents,
      clientKey,
      cap: BOOKING_CAP,
      windowStart,
    });

    if (!ticket) {
      // The insert declined: this client is at its cap. Work out when the
      // oldest booking in the window ages out so Retry-After is honest.
      const { oldest } = await bookingUsage(clientKey, windowStart);
      const retryAfter = oldest
        ? Math.max(1, oldest + BOOKING_WINDOW_SECONDS - Math.floor(Date.now() / 1000))
        : BOOKING_WINDOW_SECONDS;

      return Response.json(
        { error: `Booking limit reached (${BOOKING_CAP} per hour). Please try again later.` },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    return Response.json({ ticket }, { status: 201 });
  } catch (err) {
    // A booking that cannot be written down did not happen. Say so.
    console.error("[api/tickets] create failed", err);
    return Response.json({ error: "Could not save your booking. Please try again." }, { status: 500 });
  }
}
