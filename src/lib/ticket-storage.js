/**
 * Browser-side ticket ownership. There is no auth, so "your tickets" means
 * "ticket ids this browser has written down".
 *
 * Limitations, by design rather than by accident:
 *   - Tickets are invisible in another browser, another device, or incognito.
 *   - Clearing site data destroys them permanently; there is no account to
 *     recover them from.
 *   - Anyone holding an id can pay or redeem that ticket. The id IS the
 *     credential, which is why it is a random UUID.
 *
 * Only ids are stored. The confirmation code comes back from the server, so
 * this never becomes a second source of truth that can disagree with D1.
 */
const KEY = "movie-finder:tickets";
const MAX_STORED = 100;

export function readTicketIds() {
  try {
    const raw = localStorage.getItem(KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];
  } catch {
    // Private modes can throw on access, and a hand-edited value can be junk.
    return [];
  }
}

export function rememberTicketId(id) {
  const ids = readTicketIds();
  if (ids.includes(id)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...ids].slice(0, MAX_STORED)));
  } catch {
    // Storage full or blocked: the booking still exists server-side, it just
    // won't show up in My Tickets on this browser.
  }
}
