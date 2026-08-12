import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "../../../lib/auth.js";
import { getClientKey } from "../../../lib/rate-limit.js";
import { createUser, isValidPin, looksLikeEmail, normaliseEmail, throttleExceeded } from "../../../lib/users.js";

export const prerender = false;

export async function POST({ request, cookies }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const email = normaliseEmail(body.email);
  const pin = typeof body.pin === "string" ? body.pin : "";

  if (!looksLikeEmail(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!isValidPin(pin)) {
    return Response.json({ error: "Pincode must be 6 to 12 digits." }, { status: 400 });
  }

  // Without this, account creation is unbounded.
  const clientKey = await getClientKey(request);
  if (await throttleExceeded(clientKey)) {
    return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  const user = await createUser(email, pin);
  if (!user) {
    // The address is taken. This does disclose that the email is registered,
    // which is unavoidable for a signup form: it has to say the address is
    // unavailable. Login is where enumeration is properly defended against.
    return Response.json({ error: "That email is already registered. Try logging in." }, { status: 409 });
  }

  // No verification email is sent, so signing up logs you straight in.
  const sessionId = await createSession(user);
  cookies.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTIONS);

  return Response.json({ user: { id: user.id, email: user.email } }, { status: 201 });
}
