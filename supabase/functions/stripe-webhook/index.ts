// Supabase Edge Function: stripe-webhook
// Stripe calls this after a payment succeeds. It is the ONLY thing that marks an order paid:
// it checks Stripe's signature, checks the amount paid matches the order, then marks the seats
// paid and emails any friend invites.
// Deploy (Stripe can't send a login token, so JWT checking is switched off - the signature is the proof):
//   supabase functions deploy stripe-webhook --no-verify-jwt
// Secret: STRIPE_WEBHOOK_SECRET
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const enc = new TextEncoder();

async function validSignature(body: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;   // reject old/replayed requests

  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  const expected = Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 500 });

  const body = await req.text();
  if (!(await validSignature(body, req.headers.get("stripe-signature") ?? "", secret))) {
    return new Response("bad signature", { status: 400 });
  }

  const event = JSON.parse(body);
  if (event.type !== "checkout.session.completed") return new Response("ok");

  const s = event.data.object;
  const orderId = s.metadata?.order_id ?? s.client_reference_id;
  if (s.payment_status !== "paid" || !orderId) return new Response("ok");

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, serviceKey);

  const { data: order } = await db.from("orders").select("id, amount, currency, status").eq("id", orderId).maybeSingle();
  if (!order) { console.error("order not found", orderId); return new Response("ok"); }

  // Never trust a payment that doesn't match what we asked for.
  const expected = Math.round(Number(order.amount) * 100);
  if (s.amount_total !== expected || String(s.currency).toLowerCase() !== String(order.currency).toLowerCase()) {
    console.error("amount mismatch", { orderId, paid: s.amount_total, expected, currency: s.currency });
    return new Response("ok");   // 200 so Stripe doesn't retry forever; the order stays unpaid for an admin to review
  }

  const { error } = await db.rpc("_mark_order_paid", { p_order_id: orderId, p_session_id: s.id });
  if (error) { console.error(error); return new Response("db error", { status: 500 }); }   // Stripe will retry

  // Email friend invites (best effort - the payment itself is already recorded).
  try {
    await fetch(`${url}/functions/v1/send-invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId }),
    });
  } catch (e) { console.error("send-invites failed", e); }

  return new Response("ok");
});
