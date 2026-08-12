import { readSession, SESSION_COOKIE } from "./lib/auth.js";

/**
 * Runs before every SSR request and resolves the session exactly once, putting
 * the result on `locals`. Routes and pages then read `locals.user` instead of
 * each parsing cookies and hitting KV themselves — one implementation to get
 * right, and no route can accidentally use a different notion of "logged in".
 *
 * This establishes *authentication* only (who you are). Authorization (what you
 * may touch) is enforced separately in the SQL of every ticket query, because a
 * signed-in user is still not allowed to read someone else's booking.
 */
export async function onRequest(context, next) {
  context.locals.user = null;
  context.locals.sessionId = null;

  try {
    const sessionId = context.cookies.get(SESSION_COOKIE)?.value ?? null;
    const session = await readSession(sessionId);

    if (session) {
      context.locals.sessionId = session.id;
      context.locals.user = { id: session.userId, email: session.email };
    } else if (sessionId) {
      // Cookie present but no matching session: expired, revoked, or forged.
      // Clear it so the browser stops sending a dead token.
      context.cookies.delete(SESSION_COOKIE, { path: "/" });
    }
  } catch (err) {
    // Bindings are absent while prerendering static pages at build time, and a
    // KV outage should log the user out rather than crash the site. Failing
    // closed (no user) is the safe direction: it can only ever deny access.
    console.error("[middleware] session lookup failed:", err);
  }

  return next();
}
