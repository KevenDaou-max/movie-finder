import { payTicket, redeemTicket } from "../../../lib/tickets.js";

export const prerender = false;

const ACTIONS = { pay: payTicket, redeem: redeemTicket };

// "already booked" reads wrong for a ticket that simply hasn't been paid yet.
const STATE_PHRASE = {
  booked: "still awaiting payment",
  paid: "already paid",
  redeemed: "already redeemed",
};

export async function POST({ params, request }) {
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
    const { ok, ticket } = await run(params.id);

    if (!ticket) {
      return Response.json({ error: "Ticket not found." }, { status: 404 });
    }
    if (!ok) {
      // The compare-and-swap matched nothing: the ticket is not in a state this
      // action is legal from. 409 rather than 400 — the request was well formed,
      // it just lost the race or was replayed.
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
