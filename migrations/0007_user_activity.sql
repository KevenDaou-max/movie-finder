-- What a logged-in user has engaged with, used to personalise recommendations.
--
-- An append-only event log rather than aggregated counters. Counters would be
-- smaller and cheaper to read, but they discard *when* something happened, and
-- recency is the signal recommendations most depend on -- what someone watched
-- last week matters more than a year ago. If volume ever became a problem the
-- standard move is to roll old rows into a summary table and delete them, which
-- a log makes possible and counters do not.
--
-- This is a THIRD error philosophy, distinct from the other two in this app:
--   cache  (catalog.js)  swallow errors, fall back to the upstream
--   record (tickets.js)  fail loudly, the data exists nowhere else
--   telemetry (here)     swallow errors, never block the page
-- Losing an activity row costs a little recommendation quality and nothing
-- else, so a failed write must never turn a movie page into a 500.
CREATE TABLE user_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  user_id TEXT NOT NULL REFERENCES users(id),

  -- No foreign key onto movies, for the same reason tickets has none: `movies`
  -- is a cache whose writes happen in waitUntil and are allowed to fail, so an
  -- FK would let a cache miss reject an activity write.
  movie_id INTEGER NOT NULL,

  -- 'book' is worth far more than 'view': one is completing a whole flow, the
  -- other is clicking a poster and possibly bouncing. Weighting lives in
  -- application code (activity.js) rather than here.
  action TEXT NOT NULL CHECK (action IN ('view', 'book')),

  created_at INTEGER NOT NULL
);

-- "This user's recent history", for seeding recommendations.
CREATE INDEX idx_activity_user_time ON user_activity (user_id, created_at DESC);

-- Serves the 30-minute duplicate guard: without it, sitting on a movie page
-- pressing refresh would dominate a user's entire profile.
CREATE INDEX idx_activity_dedup ON user_activity (user_id, movie_id, action, created_at DESC);
