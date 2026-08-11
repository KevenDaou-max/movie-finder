-- Per-client booking cap.
--
-- Counting rows in `tickets` itself means no extra table and no cleanup job:
-- the cap is literally "how many bookings has this client made recently".
--
-- client_key is a truncated SHA-256 of the caller's IP, never the IP itself.
-- That keeps the column pseudonymous rather than personal data, at the cost of
-- being unable to reverse it (which is the point).
--
-- Nullable with no default, so existing rows simply carry NULL. Adding a column
-- is the one ALTER SQLite does cheaply; it rewrites no data.
ALTER TABLE tickets ADD COLUMN client_key TEXT;

-- Serves the cap's counting query: WHERE client_key = ? AND created_at >= ?
CREATE INDEX idx_tickets_client_key ON tickets (client_key, created_at);
