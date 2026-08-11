/**
 * A deliberately small booking cap. This is not protection against a determined
 * attacker — an IP is cheap to change — it exists so that a script, a stuck
 * retry loop, or someone idly clicking cannot fill the tickets table.
 *
 * Cloudflare's Rate Limiting rules are the right tool for real abuse; this is
 * the in-code floor beneath them.
 */
export const BOOKING_CAP = 10;
export const BOOKING_WINDOW_SECONDS = 60 * 60;

/**
 * Pseudonymous per-client identifier. The raw IP is hashed and truncated, so
 * the database holds something linkable but not personally identifying, and
 * there is no way back to the address.
 *
 * Behind Cloudflare, CF-Connecting-IP is set by the edge and cannot be spoofed
 * by the client. Local dev has no such header, so everything collapses to a
 * single key there — which is what makes the cap easy to test.
 */
export async function getClientKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const bytes = new TextEncoder().encode(`movie-finder:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Unix seconds marking the start of the current window. */
export function bookingWindowStart(now = Date.now()) {
  return Math.floor(now / 1000) - BOOKING_WINDOW_SECONDS;
}
