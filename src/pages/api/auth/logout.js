import { destroySession, SESSION_COOKIE } from "../../../lib/auth.js";

export const prerender = false;

export async function POST({ locals, cookies }) {
  // Delete the server-side session first. Clearing only the cookie would leave
  // a working token in KV for anyone who had already copied it.
  await destroySession(locals.sessionId);
  cookies.delete(SESSION_COOKIE, { path: "/" });

  // Caveat worth knowing: KV propagates in up to 60 seconds, so the session may
  // still resolve at other edge locations briefly after this returns. That is
  // inherent to KV-backed sessions; D1 or a Durable Object would be immediate.
  return Response.json({ ok: true });
}
