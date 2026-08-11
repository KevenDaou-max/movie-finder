/**
 * MOCK DATA. There is no real showtime API here — every cinema, time and price
 * in this file is invented.
 *
 * The one property that matters is DETERMINISM: output is a pure function of
 * the movie id. That is not cosmetic, it is what makes the feature work at all.
 *
 *   1. The user picks a showtime and the page re-renders. With Math.random()
 *      the option they picked would no longer exist.
 *   2. The server must decide whether a submitted cinema/showtime was ever
 *      really on offer, and what it costs. It regenerates this list and checks
 *      membership, so nothing has to be stored and the client cannot invent
 *      a screening or a price.
 */

/**
 * mulberry32: a tiny seeded PRNG. Given the same seed it always yields the same
 * sequence of floats in [0, 1) — a stand-in for Math.random() that is
 * reproducible on both sides of the wire.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Invented venues. `base` is the per-seat price in cents before any premium.
const CINEMA_POOL = [
  { name: "Grand Cineplex", base: 1250 },
  { name: "Odeon Riverside", base: 1100 },
  { name: "Starlight Cinema 12", base: 950 },
  { name: "The Empire", base: 1450 },
  { name: "Metro Screens", base: 1050 },
  { name: "Aurora IMAX", base: 1850 },
  { name: "Pixel Picturehouse", base: 1350 },
  { name: "Northgate Multiplex", base: 900 },
];

const TIME_SLOTS = ["11:15", "13:45", "16:30", "19:00", "21:45"];
const EVENING_FROM_HOUR = 18;
const EVENING_PREMIUM_CENTS = 250;
const DAYS_AHEAD = 3; // today + the next two

/** Deterministic Fisher-Yates: same input and same rand stream, same order. */
function shuffled(items, rand) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Showtimes are wall-clock strings ('2026-08-11T19:00') with no timezone: the
 * cinemas are imaginary, so there is no real venue timezone to convert to. A
 * production system would store UTC plus the venue's zone.
 */
function priceFor(cinema, showtime) {
  const hour = Number(showtime.slice(11, 13));
  return cinema.base + (hour >= EVENING_FROM_HOUR ? EVENING_PREMIUM_CENTS : 0);
}

/** 3-4 cinemas, each with 3-4 daily slots, stable forever for a given movie. */
export function generateShowtimes(movieId, { now = new Date() } = {}) {
  const rand = mulberry32(movieId);

  const cinemaCount = 3 + Math.floor(rand() * 2);
  const cinemas = shuffled(CINEMA_POOL, rand).slice(0, cinemaCount);

  // UTC throughout, so a worker's locale can never shift the window.
  const days = [];
  for (let offset = 0; offset < DAYS_AHEAD; offset++) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + offset);
    days.push(date.toISOString().slice(0, 10));
  }

  return cinemas.map((cinema) => {
    const slotCount = 3 + Math.floor(rand() * 2);
    const times = shuffled(TIME_SLOTS, rand).slice(0, slotCount).sort();

    return {
      name: cinema.name,
      days: days.map((day) => ({
        day,
        times: times.map((time) => {
          const showtime = `${day}T${time}`;
          return { showtime, time, unit_price_cents: priceFor(cinema, showtime) };
        }),
      })),
    };
  });
}

/**
 * '2026-08-11T19:00' -> 'Tue, Aug 11 · 19:00'. Locale is pinned rather than
 * left to the environment so a worker and a browser render it identically.
 */
export function formatShowtime(showtime) {
  const [day, time] = showtime.split("T");
  const label = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
  return `${label} · ${time}`;
}

/**
 * Server-side validation: was this cinema/showtime genuinely on offer, and what
 * does it cost? Returns null if not, which the route turns into a 400.
 *
 * Known mock limitation: the day window is relative to "now", so a booking
 * submitted at 23:59:59 and validated a second later can fall outside it.
 */
export function findSlot(movieId, cinema, showtime, { now = new Date() } = {}) {
  for (const venue of generateShowtimes(movieId, { now })) {
    if (venue.name !== cinema) continue;
    for (const day of venue.days) {
      const match = day.times.find((slot) => slot.showtime === showtime);
      if (match) return { cinema: venue.name, ...match };
    }
  }
  return null;
}
