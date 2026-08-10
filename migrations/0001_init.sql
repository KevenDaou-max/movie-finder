-- Movie catalog cached from TMDB. TMDB stays the source of truth; every id here
-- is a TMDB id, which is what lets the two line up.

CREATE TABLE movies (
  id           INTEGER PRIMARY KEY, -- TMDB id, never autoincrement
  title        TEXT NOT NULL,
  overview     TEXT,
  poster_path  TEXT,
  release_date TEXT,
  vote_average REAL,
  popularity   REAL,

  -- Detail-only fields. List endpoints never return these, so they stay NULL
  -- until the movie has been fetched from /movie/{id}.
  runtime     INTEGER,
  trailer_key TEXT,

  raw_json TEXT,

  -- Unix seconds. Split because a row can be shallow (seen in a list) or full
  -- (fetched by id); the detail page must be able to tell the difference.
  list_synced_at   INTEGER,
  detail_synced_at INTEGER
);

CREATE TABLE genres (
  id   INTEGER PRIMARY KEY, -- TMDB genre id
  name TEXT NOT NULL
);

CREATE TABLE movie_genres (
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id),
  PRIMARY KEY (movie_id, genre_id)
);

CREATE INDEX idx_movie_genres_genre ON movie_genres(genre_id);

-- One row per TMDB result page. Stores the id order as returned so that
-- pagination is reproducible: sorting by our own copy of `popularity` would
-- let a movie drift between pages and appear twice in the infinite scroll.
CREATE TABLE list_pages (
  list_key    TEXT NOT NULL, -- 'popular' | 'genre:28'
  page        INTEGER NOT NULL,
  movie_ids   TEXT NOT NULL, -- JSON array, order significant
  total_pages INTEGER NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (list_key, page)
);

CREATE TABLE search_cache (
  query       TEXT NOT NULL, -- lowercased + trimmed
  page        INTEGER NOT NULL,
  movie_ids   TEXT NOT NULL,
  total_pages INTEGER NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (query, page)
);

-- TMDB's movie genre list. Seeded rather than fetched: it is stable, and
-- movie_genres has a foreign key onto it, so it must be populated before the
-- first movie is written.
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
  (37, 'Western');
