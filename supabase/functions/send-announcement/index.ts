// Supabase Edge Function: send-announcement
// Emails everyone who opted in to updates about an OPEN tournament ("grab your seat before it fills up").
// Admin only. Skips players who already have a seat (or a live hold) in that tournament.
// Body: { event_id, dry_run? }   dry_run = true only counts the recipients and reports the last send.
// Deploy:  supabase functions deploy send-announcement --no-verify-jwt   (it checks the caller itself)
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

function emailHtml(o: { name: string; event: string; when: string; venue: string; fee: string; seats: string; link: string; profileLink: string }) {
  const greet = o.name ? `Hi ${esc(o.name)},` : "Hi,";
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#efe7d8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe7d8;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#180F09;border-radius:16px;">
<tr><td style="padding:30px 34px 6px;"><div style="font-family:Impact,'Arial Narrow',Arial,sans-serif;font-size:24px;letter-spacing:1px;color:#F1E6D3;line-height:1.1;">LEBANON BACKGAMMON SOCIETY</div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;color:#C6A15B;margin-top:6px;">TOURNAMENTS ACROSS LEBANON</div></td></tr>
<tr><td style="padding:0 34px;"><div style="height:2px;background:#C6A15B;margin:18px 0 6px;opacity:.7;"></div></td></tr>
<tr><td style="padding:18px 34px 8px;font-family:Arial,Helvetica,sans-serif;color:#F1E6D3;">
<h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#F1E6D3;">${esc(o.event)} is open</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#d9ccb6;">${greet}</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#d9ccb6;">There's a tournament coming up and seats are filling. Grab yours before they're gone.</p>
<p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#d9ccb6;"><b style="color:#F1E6D3;">${esc(o.when)}</b>${o.venue ? "<br>" + esc(o.venue) : ""}<br>Entry: ${esc(o.fee)}${o.seats ? "<br>" + esc(o.seats) : ""}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#C6A15B;border-radius:999px;"><a href="${esc(o.link)}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#180F09;text-decoration:none;">See it and grab a seat</a></td></tr></table>
<p style="margin:26px 0 6px;font-size:12.5px;line-height:1.6;color:#9C8B76;">Button not working? Copy and paste this link into your browser:</p>
<p style="margin:0 0 18px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(o.link)}" style="color:#C6A15B;">${esc(o.link)}</a></p>
<p style="margin:0 0 20px;font-size:11.5px;line-height:1.6;color:#7d6f5d;">You're getting this because you chose to hear about tournaments. You can change that any time in <a href="${esc(o.profileLink)}" style="color:#9C8B76;">your profile</a>.</p>
</td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey || !siteUrl) return json({ error: "Emails are not configured yet." }, 500);

    const auth = req.headers.get("Authorization") ?? "";
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Please sign in first." }, 401);

    const db = createClient(url, serviceKey);
    const { data: prof } = await db.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
    if (!prof?.is_admin) return json({ error: "Only the organizer can do this." }, 403);

    const { event_id, dry_run } = await req.json();
    const { data: ev } = await db.from("events")
      .select("id, name, slug, venue, starts_at, entry_fee, currency, max_players, status").eq("id", event_id).maybeSingle();
    if (!ev) return json({ error: "Tournament not found." }, 404);
    if (ev.status !== "open") return json({ error: "Only tournaments that are open for entry can be announced." }, 409);

    // Opted in, with an email, and not already in this tournament.
    const { data: optedIn } = await db.from("profiles").select("id, first_name, email")
      .eq("marketing_opt_in", true).not("email", "is", null);
    const { data: enr } = await db.from("enrollments").select("user_id, status, hold_expires_at")
      .eq("event_id", ev.id).in("status", ["paid", "pending_payment"]);
    const inEvent = new Set((enr ?? [])
      .filter((e) => e.status === "paid" || (e.hold_expires_at && new Date(e.hold_expires_at).getTime() > Date.now()))
      .map((e) => e.user_id));
    const recipients = (optedIn ?? []).filter((p) => p.email && !inEvent.has(p.id));

    const { data: last } = await db.from("event_announcements").select("created_at").eq("event_id", ev.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (dry_run) return json({ recipients: recipients.length, last_sent: last?.created_at ?? null });
    if (!recipients.length) return json({ sent: 0, failed: 0 });

    const { data: seatRow } = await db.from("event_seats").select("taken").eq("event_id", ev.id).maybeSingle();
    const left = seatRow ? Math.max(0, ev.max_players - (seatRow.taken ?? 0)) : null;
    const when = new Date(ev.starts_at).toLocaleString("en-US", {
      timeZone: "Asia/Beirut", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const fee = Number(ev.entry_fee) > 0 ? `${ev.currency === "USD" ? "$" : ev.currency + " "}${Number(ev.entry_fee)}` : "Free";
    const seats = left === null ? "" : `${left} of ${ev.max_players} seats left`;
    const link = `${siteUrl}/#/event/${ev.slug}`;
    const profileLink = `${siteUrl}/#/profile`;
    const subject = `${ev.name} is open: grab your seat`;

    let sent = 0, failed = 0;
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100);
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((p) => ({
          from: "Lebanon Backgammon Society <noreply@lebanonbackgammonsociety.com>",
          to: [p.email],
          subject,
          html: emailHtml({ name: p.first_name ?? "", event: ev.name, when, venue: ev.venue ?? "", fee, seats, link, profileLink }),
          text: `${ev.name} is open: grab your seat.\n${when}${ev.venue ? "\n" + ev.venue : ""}\nEntry: ${fee}${seats ? "\n" + seats : ""}\n${link}\n\nYou're getting this because you chose to hear about tournaments. Change that any time: ${profileLink}`,
        }))),
      });
      if (res.ok) sent += chunk.length;
      else { failed += chunk.length; console.error("resend batch error", res.status, await res.text()); }
    }
    await db.from("event_announcements").insert({ event_id: ev.id, sent_by: user.id, recipients: sent, failed });
    return json({ sent, failed });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong sending the emails." }, 500);
  }
});
