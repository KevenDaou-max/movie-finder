-- Repair genre names destroyed by the bug fixed in catalog.js genreStatements().
--
-- List responses from TMDB carry genre ids but no names, and the write path
-- upserted `Genre <id>` placeholders over the real names seeded in 0001. Since
-- browsing happens far more often than opening a detail page, every name was
-- eventually overwritten -- movie detail pages were rendering "Genre 878"
-- instead of "Science Fiction".
--
-- Idempotent: an upsert of the canonical list, safe to re-run.
INSERT INTO genres (id, name) VALUES
  (28, 'Action'),
  (12, 'Adventure'),
  (16, 'Animation'),
  (35, 'Comedy'),
  (80, 'Crime'),
  (99, 'Documentary'),
  (18, 'Drama'),
  (10751, 'Family'),
  (14, 'Fantasy'),
  (36, 'History'),
  (27, 'Horror'),
  (10402, 'Music'),
  (9648, 'Mystery'),
  (10749, 'Romance'),
  (878, 'Science Fiction'),
  (10770, 'TV Movie'),
  (53, 'Thriller'),
  (10752, 'War'),
  (37, 'Western')
ON CONFLICT(id) DO UPDATE SET name = excluded.name;
