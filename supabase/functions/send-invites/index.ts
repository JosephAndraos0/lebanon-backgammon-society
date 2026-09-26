// Supabase Edge Function: send-invites
// Emails the "claim your seat" link to friends whose seats were paid for.
// Called by the payment webhook (with the service key), and by the buyer / an admin to (re)send.
// Deploy:  supabase functions deploy send-invites --no-verify-jwt   (it checks the caller itself)
// Secrets: RESEND_API_KEY, SITE_URL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function emailHtml(o: { friend: string; inviter: string; event: string; when: string; venue: string; link: string }) {
  const greet = o.friend ? `Hi ${esc(o.friend)},` : "Hi,";
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#efe7d8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe7d8;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#180F09;border-radius:16px;">
<tr><td style="padding:30px 34px 6px;"><div style="font-family:Impact,'Arial Narrow',Arial,sans-serif;font-size:24px;letter-spacing:1px;color:#F1E6D3;line-height:1.1;">LEBANON BACKGAMMON SOCIETY</div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;color:#C6A15B;margin-top:6px;">TOURNAMENTS ACROSS LEBANON</div></td></tr>
<tr><td style="padding:0 34px;"><div style="height:2px;background:#C6A15B;margin:18px 0 6px;opacity:.7;"></div></td></tr>
<tr><td style="padding:18px 34px 8px;font-family:Arial,Helvetica,sans-serif;color:#F1E6D3;">
<h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#F1E6D3;">${esc(o.inviter)} paid for your seat</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#d9ccb6;">${greet}</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#d9ccb6;"><b style="color:#F1E6D3;">${esc(o.inviter)}</b> has paid your entry to <b style="color:#F1E6D3;">${esc(o.event)}</b>.<br>${esc(o.when)}${o.venue ? " · " + esc(o.venue) : ""}</p>
<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#d9ccb6;">Claim your seat with one click. You'll create a free account (your name and a photo, so everyone knows who's at the table) - there's nothing to pay.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#C6A15B;border-radius:999px;"><a href="${esc(o.link)}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#180F09;text-decoration:none;">Claim my seat</a></td></tr></table>
<p style="margin:26px 0 6px;font-size:12.5px;line-height:1.6;color:#9C8B76;">Button not working? Copy and paste this link into your browser:</p>
<p style="margin:0 0 6px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(o.link)}" style="color:#C6A15B;">${esc(o.link)}</a></p>
</td></tr>
<tr><td style="padding:22px 34px 30px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#9C8B76;border-top:1px solid #33261b;">Weren't expecting this? You can safely ignore this email.<br><a href="https://lebanonbackgammonsociety.com" style="color:#C6A15B;text-decoration:none;">lebanonbackgammonsociety.com</a></td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey || !siteUrl) return json({ error: "Invite emails are not configured yet." }, 500);

    const auth = req.headers.get("Authorization") ?? "";
    const isServer = timingSafeEqual(auth.replace(/^Bearer\s+/i, ""), serviceKey);
    const db = createClient(url, serviceKey);

    let callerId: string | null = null;
    if (!isServer) {
      const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await asUser.auth.getUser();
      if (!user) return json({ error: "Please sign in first." }, 401);
      callerId = user.id;
    }

    const { order_id, invite_id } = await req.json();
    const { data: order } = await db.from("orders")
      .select("id, buyer_id, status, event_id, events(name, slug, venue, starts_at)").eq("id", order_id).maybeSingle();
    if (!order) return json({ error: "Order not found." }, 404);
    if (!isServer) {
      const { data: prof } = await db.from("profiles").select("is_admin").eq("id", callerId!).maybeSingle();
      if (order.buyer_id !== callerId && !prof?.is_admin) return json({ error: "Not allowed." }, 403);
    }
    if (order.status !== "paid") return json({ error: "This order isn't paid yet." }, 409);

    const { data: buyer } = await db.from("profiles").select("full_name").eq("id", order.buyer_id).maybeSingle();
    let q = db.from("seat_invites").select("id, email, name, token, emailed_at").eq("order_id", order.id).eq("status", "ready");
    if (invite_id) q = q.eq("id", invite_id); else q = q.is("emailed_at", null);
    const { data: invites } = await q;

    const ev = (order as any).events;
    const when = new Date(ev.starts_at).toLocaleString("en-US", { timeZone: "Asia/Beirut", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    let sent = 0, failed = 0;
    for (const inv of invites ?? []) {
      const link = `${siteUrl}/#/claim/${inv.token}`;
      const subject = `${buyer?.full_name ?? "A friend"} paid for your seat at ${ev.name}`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Lebanon Backgammon Society <noreply@lebanonbackgammonsociety.com>",
          to: [inv.email],
          subject,
          html: emailHtml({ friend: inv.name ?? "", inviter: buyer?.full_name ?? "A friend", event: ev.name, when, venue: ev.venue ?? "", link }),
          text: `${buyer?.full_name ?? "A friend"} paid for your seat at ${ev.name} (${when}).\nClaim it here: ${link}`,
        }),
      });
      if (res.ok) { sent++; await db.from("seat_invites").update({ emailed_at: new Date().toISOString() }).eq("id", inv.id); }
      else { failed++; console.error("resend error", res.status, await res.text()); }
    }
    return json({ sent, failed });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong sending invites." }, 500);
  }
});
