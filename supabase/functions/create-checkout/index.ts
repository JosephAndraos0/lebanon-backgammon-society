// Supabase Edge Function: create-checkout
// Starts a Stripe Checkout payment for a pending order (the player's own seat and/or seats for friends).
// The seats stay held while the player pays; nothing is marked paid here - only the webhook does that.
// Deploy:  supabase functions deploy create-checkout --no-verify-jwt   (it checks the login itself)
// Secrets: STRIPE_SECRET_KEY, SITE_URL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STRIPE = "https://api.stripe.com/v1";

async function expireSession(id: string, key: string) {
  try {
    await fetch(`${STRIPE}/checkout/sessions/${id}/expire`, { method: "POST", headers: { Authorization: `Bearer ${key}` } });
  } catch (_) { /* already expired/completed - fine */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey || !siteUrl) return json({ error: "Payments are not configured yet." }, 500);

    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Please sign in first." }, 401);

    const { order_id, return_url } = await req.json();
    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: order } = await db.from("orders")
      .select("id, buyer_id, event_id, seats, amount, currency, status, hold_expires_at, stripe_session_id, events(name, slug, status, entry_fee)")
      .eq("id", order_id).maybeSingle();
    const ev = (order as any)?.events;
    if (!order || order.buyer_id !== user.id) return json({ error: "We couldn't find that order." }, 404);
    if (order.status === "paid") return json({ paid: true });
    if (order.status !== "pending" || !ev || ev.status !== "open") return json({ error: "This order is no longer active. Please start again." }, 410);
    if (new Date(order.hold_expires_at).getTime() < Date.now() + 60_000) {
      return json({ error: "Your seat hold expired. Please start again." }, 410);
    }
    if (Number(order.amount) <= 0) return json({ error: "Nothing to pay for this order." }, 400);

    // A player can only have one live checkout: close earlier sessions (old tabs) for this event.
    const { data: old } = await db.from("orders").select("stripe_session_id")
      .eq("buyer_id", user.id).eq("event_id", order.event_id).neq("id", order.id)
      .not("stripe_session_id", "is", null).neq("status", "paid");
    for (const o of old ?? []) if (o.stripe_session_id) await expireSession(o.stripe_session_id, stripeKey);
    if (order.stripe_session_id) await expireSession(order.stripe_session_id, stripeKey);

    // Only ever send players back to our own site.
    let base = siteUrl + "/";
    try {
      const r = new URL(return_url);
      if (r.origin === new URL(siteUrl).origin) base = r.origin + r.pathname;
    } catch (_) { /* fall back to siteUrl */ }

    const unit = Math.round((Number(order.amount) / order.seats) * 100);
    const form = new URLSearchParams({
      mode: "payment",
      success_url: `${base}?paid=1&order=${order.id}#/event/${ev.slug}`,
      cancel_url: `${base}?paid=0&order=${order.id}#/event/${ev.slug}`,
      client_reference_id: order.id,
      customer_email: user.email ?? "",
      expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),   // Stripe minimum is 30 min; our hold is 35
      "line_items[0][quantity]": String(order.seats),
      "line_items[0][price_data][currency]": String(order.currency).toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(unit),
      "line_items[0][price_data][product_data][name]": `${ev.name} - entry fee`,
      "metadata[order_id]": order.id,
      "payment_intent_data[metadata][order_id]": order.id,
    });
    const res = await fetch(`${STRIPE}/checkout/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const session = await res.json();
    if (!res.ok) { console.error("Stripe error", session); return json({ error: "Payment provider error." }, 502); }

    await db.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);
    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong starting the payment." }, 500);
  }
});
