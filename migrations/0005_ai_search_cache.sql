-- Cache of natural-language query -> structured search intent.
--
-- This caches the *interpretation*, not the results. Results are already
-- cached by list_pages under a `discover:<hash>` key, so the two layers are
-- independent: a popular phrase costs zero Neurons AND zero TMDB calls, while
-- a fresh phrasing of a known search still reuses the cached result page.
--
-- D1 rather than KV deliberately. KV's free tier allows 1,000 writes/day and
-- sessions already spend from that budget on every login; interpretation
-- caching would compete with people logging in. D1's write allowance is far
-- larger, and a fetched_at column with a TTL check is the pattern every other
-- cache in this app already uses.
CREATE TABLE ai_searches (
  -- SHA-256 of the normalised query text. Hashed rather than stored raw as the
  -- key so the primary key is fixed-width regardless of query length.
  query_hash TEXT PRIMARY KEY,

  -- Kept alongside for debugging and for inspecting what people actually type.
  query_text TEXT NOT NULL,

  -- The validated intent, already whitelisted against the schema. Storing the
  -- post-validation shape means a cache hit never replays unvalidated model
  -- output.
  intent_json TEXT NOT NULL,

  -- Which path produced this: 'ai' when the model returned a usable intent,
  -- 'fallback' when it did not. Caching the failure too stops a nonsense query
  -- being re-sent to the model on every retry.
  strategy TEXT NOT NULL CHECK (strategy IN ('ai', 'fallback')),

  fetched_at INTEGER NOT NULL
);
