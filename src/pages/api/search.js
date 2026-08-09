export const prerender = false;

export async function GET({ url }) {
  const q = url.searchParams.get("q") || "";
  const API_KEY = import.meta.env.TMDB_KEY;
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(q)}`);
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}