-- Migration 003 — run once on a database that already has migration 002.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- Problem this fixes: a friend a seat was paid for saw nothing on the site unless they clicked
-- the emailed link. If they just signed in and looked around, the event page told them to pay
-- again. Now, signing in checks for any paid seat waiting on that email address and offers it
-- to them directly, with the option to turn it down.
--
-- Declining frees the seat immediately. It does NOT touch Stripe or move any money — the buyer
-- paid for the whole order in one charge, so refunding just one seat out of it is something the
-- organizer does by hand in the Stripe dashboard. A declined invite shows up for the admin with
-- a "mark refunded" button once that's done, purely to clear it off the list.

alter table public.seat_invites drop constraint if exists seat_invites_status_check;
alter table public.seat_invites add constraint seat_invites_status_check
  check (status in ('pending', 'ready', 'claimed', 'cancelled', 'declined'));

-- What a signed-in player sees: any already-paid seat waiting on their email address that they
-- haven't claimed or turned down yet. Matched by email, not by who was signed in when the order
-- was paid, so it also catches someone who creates their account after being invited.
create or replace function public.my_pending_invites()
returns table (id uuid, token text, event_name text, event_slug text, venue text,
               starts_at timestamptz, inviter_name text)
language sql stable security definer set search_path = public as $$
  select i.id, i.token, ev.name, ev.slug, ev.venue, ev.starts_at, p.full_name
  from public.seat_invites i
  join public.events ev on ev.id = i.event_id
  join public.profiles p on p.id = i.inviter_id
  where i.status = 'ready'
    and lower(i.email) = lower((select email from public.profiles where id = auth.uid()))
  order by i.created_at desc
$$;

-- The invited player turns down a seat that was already paid for.
create or replace function public.decline_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  i        public.seat_invites;
  my_email text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select email into my_email from public.profiles where id = auth.uid();
  select * into i from public.seat_invites where id = p_invite_id for update;
  if not found or i.status <> 'ready' or lower(i.email) <> lower(coalesce(my_email, '')) then
    raise exception 'invite_invalid';
  end if;
  update public.seat_invites set status = 'declined' where id = i.id;
end $$;

-- The organizer confirms they've refunded the buyer for that one seat in Stripe. Purely a
-- bookkeeping step — it doesn't touch Stripe or the order itself.
create or replace function public.admin_mark_invite_refunded(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  update public.seat_invites set status = 'cancelled' where id = p_invite_id and status = 'declined';
end $$;

revoke execute on function public.decline_invite(uuid) from public, anon;
grant execute on function public.decline_invite(uuid) to authenticated;
revoke execute on function public.my_pending_invites() from public, anon;
grant execute on function public.my_pending_invites() to authenticated;
revoke execute on function public.admin_mark_invite_refunded(uuid) from public, anon;
grant execute on function public.admin_mark_invite_refunded(uuid) to authenticated;
