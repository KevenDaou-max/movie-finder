export const prerender = false;

export async function GET({ url }) {
  const page = url.searchParams.get("page") || "1";
  const genre = url.searchParams.get("genre");
  const API_KEY = import.meta.env.TMDB_KEY;

  const apiUrl = genre
    ? `https://api.themoviedb.org/3/discover/movie?api_key=${API_KEY}&with_genres=${genre}&page=${page}&sort_by=popularity.desc`
    : `https://api.themoviedb.org/3/movie/popular?api_key=${API_KEY}&page=${page}`;

  const res = await fetch(apiUrl);
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}