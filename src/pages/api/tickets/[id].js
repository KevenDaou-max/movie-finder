import { payTicket, redeemTicket } from "../../../lib/tickets.js";

export const prerender = false;

const ACTIONS = { pay: payTicket, redeem: redeemTicket };

// "already booked" reads wrong for a ticket that simply hasn't been paid yet.
const STATE_PHRASE = {
  booked: "still awaiting payment",
  paid: "already paid",
  redeemed: "already redeemed",
};

export async function POST({ params, request, locals }) {
  if (!locals.user) {
    return Response.json({ error: "You must be logged in." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const run = ACTIONS[body.action];
  if (!run) {
    return Response.json({ error: "action must be 'pay' or 'redeem'." }, { status: 400 });
  }

  try {
    // The user id goes into the UPDATE's WHERE clause, so a ticket belonging to
    // someone else simply matches nothing — the action cannot occur.
    const { ok, ticket } = await run(params.id, locals.user.id);

    if (!ticket) {
      // Either no such ticket, or not this user's. Answering 404 for both means
      // an attacker cannot use the status code to confirm an id is real.
      return Response.json({ error: "Ticket not found." }, { status: 404 });
    }
    if (!ok) {
      return Response.json(
        { error: `Cannot ${body.action} a ticket that is ${STATE_PHRASE[ticket.status] ?? ticket.status}.`, ticket },
        { status: 409 }
      );
    }
    return Response.json({ ticket });
  } catch (err) {
    console.error(`[api/tickets/${params.id}] ${body.action} failed`, err);
    return Response.json({ error: `Could not ${body.action} this ticket.` }, { status: 500 });
  }
}
