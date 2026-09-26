// Supabase Edge Function: create-checkout
// Starts a Stripe Checkout payment for a seat the signed-in player has already reserved.
// Deploy:  supabase functions deploy create-checkout
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_... SITE_URL=https://lebanonbackgammonsociety.com
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey || !siteUrl) return json({ error: "Payments are not configured yet." }, 500);

    // Who is calling? (the browser sends the player's login token)
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Please sign in first." }, 401);

    const { event_id, return_url } = await req.json();

    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: enr } = await db.from("enrollments")
      .select("id, status, events(name, slug, status, entry_fee, currency)")
      .eq("event_id", event_id).eq("user_id", user.id).maybeSingle();
    const ev = (enr as any)?.events;
    if (!enr || enr.status !== "pending_payment" || !ev || ev.status !== "open") {
      return json({ error: "There's no unpaid reservation to pay for." }, 400);
    }

    // Only ever send players back to our own site.
    let base = siteUrl + "/";
    try {
      const r = new URL(return_url);
      if (r.origin === new URL(siteUrl).origin) base = r.origin + r.pathname;
    } catch (_) { /* fall back to siteUrl */ }

    const form = new URLSearchParams({
      mode: "payment",
      success_url: `${base}?paid=1#/event/${ev.slug}`,
      cancel_url: `${base}?paid=0#/event/${ev.slug}`,
      client_reference_id: enr.id,
      customer_email: user.email ?? "",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": String(ev.currency).toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(Math.round(Number(ev.entry_fee) * 100)),
      "line_items[0][price_data][product_data][name]": `${ev.name} - entry fee`,
      "metadata[enrollment_id]": enr.id,
    });
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const session = await res.json();
    if (!res.ok) { console.error("Stripe error", session); return json({ error: "Payment provider error." }, 502); }

    await db.from("enrollments").update({ stripe_session_id: session.id }).eq("id", enr.id);
    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong starting the payment." }, 500);
  }
});
