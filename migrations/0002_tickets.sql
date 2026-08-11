-- Two tables with deliberately opposite philosophies.
--
-- watch_providers is a CACHE: TMDB is the source of truth, losing it costs
-- only latency, and a failed write is swallowed.
--
-- tickets is a RECORD: it is the source of truth, nothing upstream can
-- regenerate it, and a failed write must surface as an error.

-- Streaming/rent/buy availability, stored as the region block verbatim.
-- Not normalised into provider tables because it is never queried across --
-- only ever read whole for one (movie, region) and rendered.
CREATE TABLE watch_providers (
  movie_id   INTEGER NOT NULL,
  region     TEXT NOT NULL, -- 'US'; part of the key so changing region can't alias
  payload    TEXT NOT NULL, -- JSON: { link, flatrate?, rent?, buy?, free?, ads? }
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (movie_id, region)
);

-- Mock bookings. The cinemas, showtimes and payment are invented; these rows
-- are real and permanent.
CREATE TABLE tickets (
  -- Unguessable, because with no auth the id IS the credential: it is what
  -- localStorage holds and what /api/tickets/{id} accepts. A sequential id
  -- would let anyone walk /checkout/1, /checkout/2 and redeem other bookings.
  id TEXT PRIMARY KEY,

  -- 'MOV-4X9K2'. NULL until paid; SQLite allows many NULLs under UNIQUE,
  -- so unpaid tickets coexist while paid codes stay distinct.
  confirmation TEXT UNIQUE,

  -- Deliberately NOT a foreign key onto movies. Movie cache writes happen in
  -- waitUntil and are allowed to fail, so an FK would let a *cache* problem
  -- destroy a booking. The title is denormalised for the same reason: the
  -- ticket must stay readable even if the cached movie row is evicted.
  movie_id    INTEGER NOT NULL,
  movie_title TEXT NOT NULL,

  cinema   TEXT NOT NULL,
  showtime TEXT NOT NULL, -- 'YYYY-MM-DDTHH:MM' wall-clock at the cinema

  seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 10),

  -- Integer cents, per seat. Floats lose money to rounding; the total is
  -- derived (unit x seats) rather than stored twice.
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),

  -- The database rejects an invalid state even if application code has a bug.
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'paid', 'redeemed')),

  created_at  INTEGER NOT NULL,
  paid_at     INTEGER,
  redeemed_at INTEGER
);
