import {
  createSession, dummyVerify, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, verifyPin,
} from "../../../lib/auth.js";
import { getClientKey } from "../../../lib/rate-limit.js";
import {
  clearFailedAttempts, findUserByEmail, isLocked, LOCKOUT_SECONDS, normaliseEmail,
  recordFailedAttempt, throttleExceeded, upgradeHashIfNeeded,
} from "../../../lib/users.js";

export const prerender = false;

// One message for every credential failure. Distinguishing "no such email" from
// "wrong pincode" hands an attacker a free list of registered addresses.
const INVALID = "Invalid email or pincode.";

export async function POST({ request, cookies }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const email = normaliseEmail(body.email);
  const pin = typeof body.pin === "string" ? body.pin : "";

  // Layer 1: per-IP. Stops one pincode being sprayed across many accounts,
  // which per-account lockout alone would never notice.
  const clientKey = await getClientKey(request);
  if (await throttleExceeded(clientKey)) {
    return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  const user = await findUserByEmail(email);

  if (!user) {
    // Spend the same CPU a real verification would, so timing does not reveal
    // whether the address exists.
    await dummyVerify();
    return Response.json({ error: INVALID }, { status: 401 });
  }

  // Layer 2: per-account lockout. This is the primary brute-force defence,
  // because a 6-digit pincode is only 10^6 possibilities.
  if (isLocked(user)) {
    // This does reveal the account exists. The alternative — silently rejecting
    // correct credentials — is far worse for a legitimate locked-out user, so
    // the disclosure is accepted knowingly.
    return Response.json(
      { error: `Too many failed attempts. Try again in ${Math.ceil(LOCKOUT_SECONDS / 60)} minutes.` },
      { status: 429 }
    );
  }

  if (!(await verifyPin(pin, user))) {
    await recordFailedAttempt(user);
    return Response.json({ error: INVALID }, { status: 401 });
  }

  // Only reachable with a verified pincode, so this is the one safe moment to
  // re-hash at a higher work factor.
  await upgradeHashIfNeeded(user, pin);
  await clearFailedAttempts(user.id);

  const sessionId = await createSession(user);
  cookies.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTIONS);

  return Response.json({ user: { id: user.id, email: user.email } });
}
