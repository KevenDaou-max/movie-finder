-- Accounts, and moving ticket ownership from "this browser" to "this user".

CREATE TABLE users (
  id TEXT PRIMARY KEY, -- UUID, same reasoning as tickets

  -- Normalised to lowercase+trimmed in application code before it ever reaches
  -- here. SQLite's UNIQUE is case-sensitive, so without that normalisation
  -- Bob@x.com and bob@x.com would be two accounts.
  email TEXT NOT NULL UNIQUE,

  -- PBKDF2-SHA256 output and its per-user salt, both base64. The raw pincode
  -- is never stored, logged, or returned.
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,

  -- Stored per user so the work factor can be raised later without locking
  -- anyone out: each login verifies with the cost its hash was created under,
  -- and is transparently upgraded on success.
  pin_iterations INTEGER NOT NULL,

  created_at INTEGER NOT NULL,

  -- Lockout state lives in D1, not KV. KV allows 1 write/second per key and
  -- propagates in up to 60s, so an attacker could outrun a KV-based counter.
  -- A brute-force guard has to be strongly consistent to mean anything.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER
);

-- Per-IP throttle covering login AND signup. Account lockout alone does not
-- stop spraying one pincode across many emails, and it does not stop unlimited
-- account creation. One row per client, so this cannot grow per-attempt.
CREATE TABLE auth_throttle (
  client_key   TEXT PRIMARY KEY, -- hashed IP, never the address itself
  window_start INTEGER NOT NULL,
  attempts     INTEGER NOT NULL
);

-- Tickets are rebuilt rather than altered so that user_id can be NOT NULL.
-- Ownership must be an invariant the database enforces: if an unowned ticket
-- could exist, every ownership check would need a special case for it, and one
-- of them would eventually get it wrong.
--
-- Existing rows are intentionally discarded (starting fresh on tickets).
DROP TABLE tickets;

CREATE TABLE tickets (
  id           TEXT PRIMARY KEY,
  confirmation TEXT UNIQUE,

  -- A real foreign key this time. movie_id deliberately has none because
  -- `movies` is a cache whose rows may be absent; `users` is a record table,
  -- so pointing at it is safe.
  user_id TEXT NOT NULL REFERENCES users(id),

  movie_id    INTEGER NOT NULL,
  movie_title TEXT NOT NULL,

  cinema   TEXT NOT NULL,
  showtime TEXT NOT NULL,

  seats            INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 10),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),

  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'paid', 'redeemed')),

  created_at  INTEGER NOT NULL,
  paid_at     INTEGER,
  redeemed_at INTEGER,

  -- Kept for abuse investigation; the booking cap is now per user, not per IP.
  client_key TEXT
);

-- Serves both "my tickets, newest first" and the per-user booking cap count.
CREATE INDEX idx_tickets_user ON tickets (user_id, created_at DESC);
