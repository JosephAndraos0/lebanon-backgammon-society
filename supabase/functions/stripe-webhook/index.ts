// Supabase Edge Function: stripe-webhook
// Stripe calls this after a payment succeeds; it marks the player's seat as paid.
// Deploy (Stripe can't send a login token, so JWT checking is switched off - the
// Stripe signature below is what proves the request is genuine):
//   supabase functions deploy stripe-webhook --no-verify-jwt
// Secret: supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
// In Stripe -> Developers -> Webhooks, add the endpoint
//   https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook
// listening for the event "checkout.session.completed".
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
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const enrollmentId = s.metadata?.enrollment_id ?? s.client_reference_id;
    if (s.payment_status === "paid" && enrollmentId) {
      const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await db.from("enrollments")
        .update({ status: "paid", paid_at: new Date().toISOString(), stripe_session_id: s.id })
        .eq("id", enrollmentId);
      if (error) { console.error(error); return new Response("db error", { status: 500 }); }   // Stripe will retry
    }
  }
  return new Response("ok");
});
