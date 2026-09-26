-- Migration 002 — run once on a database that already has schema.sql from before this change.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- 1. Player profiles: first/last name, phone, photo, skill level, marketing consent.
-- 2. Seat holds that expire: an unpaid reservation no longer holds a seat forever
--    and unpaid people never appear in public player lists.
-- 3. Orders: one payment can cover several seats (yours + friends').
-- 4. Friend invites: a friend gets an email with a one-click link to claim a paid seat.

-- ---------------------------------------------------------------------------
-- 1. Profiles
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists first_name       text not null default '',
  add column if not exists last_name        text not null default '',
  add column if not exists phone            text,
  add column if not exists avatar_url       text,
  add column if not exists skill_level      int check (skill_level between 1 and 5),
  add column if not exists marketing_opt_in boolean,
  add column if not exists onboarded_at     timestamptz;

update public.profiles
   set first_name = split_part(full_name, ' ', 1),
       last_name  = trim(substr(full_name, length(split_part(full_name, ' ', 1)) + 1))
 where first_name = '' and last_name = '';

-- Profile edits go through save_profile() only (it validates everything), never directly.
drop policy if exists profiles_update on public.profiles;
revoke update on public.profiles from anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  f text := nullif(trim(new.raw_user_meta_data ->> 'first_name'), '');
  l text := nullif(trim(new.raw_user_meta_data ->> 'last_name'), '');
  fullname text;
begin
  if f is null and l is null then
    fullname := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1));
    f := split_part(fullname, ' ', 1);
    l := trim(substr(fullname, length(f) + 1));
  else
    fullname := trim(coalesce(f, '') || ' ' || coalesce(l, ''));
  end if;
  insert into public.profiles (id, email, full_name, first_name, last_name)
  values (new.id, new.email, fullname, coalesce(f, ''), coalesce(l, ''));
  return new;
end $$;

create or replace function public.save_profile(
  p_first text, p_last text, p_phone text, p_skill int, p_marketing boolean, p_avatar_url text
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  f  text := trim(coalesce(p_first, ''));
  l  text := trim(coalesce(p_last, ''));
  ph text := regexp_replace(trim(coalesce(p_phone, '')), '[^0-9+]', '', 'g');
  av text;
  r  public.profiles;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if f = '' or l = '' then raise exception 'name_required'; end if;
  if length(f) > 60 or length(l) > 60 then raise exception 'name_too_long'; end if;
  if ph !~ '^\+?[0-9]{7,15}$' then raise exception 'phone_invalid'; end if;
  if p_skill is null or p_skill < 1 or p_skill > 5 then raise exception 'skill_invalid'; end if;
  if p_marketing is null then raise exception 'marketing_required'; end if;
  if p_avatar_url is not null and position('/storage/v1/object/public/avatars/' || auth.uid()::text || '/' in p_avatar_url) = 0 then
    raise exception 'avatar_invalid';
  end if;

  select coalesce(p_avatar_url, avatar_url) into av from public.profiles where id = auth.uid();
  if av is null then raise exception 'photo_required'; end if;

  update public.profiles
     set first_name = f, last_name = l, full_name = f || ' ' || l, phone = ph,
         skill_level = p_skill, marketing_opt_in = p_marketing, avatar_url = av,
         onboarded_at = coalesce(onboarded_at, now())
   where id = auth.uid()
   returning * into r;
  return r;
end $$;

-- Everyone may see names and photos (players list, brackets). Phone/email stay private.
create or replace view public.public_profiles as
  select id, full_name, avatar_url from public.profiles;

-- Photos live in a public storage bucket; each player can only write inside their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists avatars_select on storage.objects;
drop policy if exists avatars_insert on storage.objects;
drop policy if exists avatars_update on storage.objects;
drop policy if exists avatars_delete on storage.objects;
create policy avatars_select on storage.objects for select using (bucket_id = 'avatars');
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 2 + 3 + 4. Orders, holds, invites
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references public.events(id) on delete cascade,
  buyer_id           uuid not null references public.profiles(id) on delete cascade,
  seats              int not null check (seats between 1 and 9),
  amount             numeric(10,2) not null check (amount >= 0),
  currency           text not null,
  status             text not null default 'pending' check (status in ('pending','paid','cancelled')),
  stripe_session_id  text,
  needs_review       boolean not null default false,   -- paid, but the seats were no longer available
  hold_expires_at    timestamptz not null,
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists orders_event_idx on public.orders (event_id);
create index if not exists orders_buyer_idx on public.orders (buyer_id);

alter table public.enrollments
  add column if not exists order_id        uuid references public.orders(id) on delete set null,
  add column if not exists hold_expires_at timestamptz;

create table if not exists public.seat_invites (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  inviter_id  uuid not null references public.profiles(id) on delete cascade,
  email       text not null,
  name        text,
  token       text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  status      text not null default 'pending' check (status in ('pending','ready','claimed','cancelled')),
  claimed_by  uuid references public.profiles(id),
  claimed_at  timestamptz,
  emailed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists seat_invites_event_idx on public.seat_invites (event_id);
create index if not exists seat_invites_order_idx on public.seat_invites (order_id);

alter table public.orders       enable row level security;
alter table public.seat_invites enable row level security;

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select using (buyer_id = auth.uid() or public.is_admin());
drop policy if exists invites_select on public.seat_invites;
create policy invites_select on public.seat_invites for select
  using (inviter_id = auth.uid() or claimed_by = auth.uid() or public.is_admin());

-- Seats in use = paid players + unexpired unpaid holds + unclaimed friend seats.
create or replace function public.seats_taken(p_event_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select (
    (select count(*) from public.enrollments e
      where e.event_id = p_event_id
        and (e.status = 'paid' or (e.status = 'pending_payment' and e.hold_expires_at > now())))
    +
    (select count(*) from public.seat_invites i join public.orders o on o.id = i.order_id
      where i.event_id = p_event_id
        and (i.status = 'ready' or (i.status = 'pending' and o.status = 'pending' and o.hold_expires_at > now())))
  )::int
$$;

-- Only PAID players are listed publicly (an unpaid reservation is invisible to others).
create or replace view public.public_enrollments as
  select event_id, user_id, status, seed, final_place
  from public.enrollments
  where status = 'paid';

create or replace view public.event_seats as
  select ev.id as event_id,
         public.seats_taken(ev.id) as taken,
         (select count(*)::int from public.enrollments e where e.event_id = ev.id and e.status = 'paid') as paid
  from public.events ev;

-- Start (or restart) a checkout: reserves seats for 35 minutes while the payment happens.
create or replace function public.create_order(p_event_id uuid, p_include_self boolean, p_friends jsonb default '[]'::jsonb)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  ev  public.events;
  me  public.profiles;
  o   public.orders;
  f   jsonb;
  em  text;
  seen text[] := '{}';
  n_friends int;
  n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.onboarded_at is null then raise exception 'profile_incomplete'; end if;

  select * into ev from public.events where id = p_event_id for update;   -- serialises seat checks
  if not found or ev.status <> 'open' then raise exception 'event_not_open'; end if;

  n_friends := coalesce(jsonb_array_length(coalesce(p_friends, '[]'::jsonb)), 0);
  if n_friends > 8 then raise exception 'too_many_friends'; end if;
  n := (case when p_include_self then 1 else 0 end) + n_friends;
  if n < 1 then raise exception 'no_seats'; end if;

  for f in select * from jsonb_array_elements(coalesce(p_friends, '[]'::jsonb)) loop
    em := lower(trim(coalesce(f ->> 'email', '')));
    if em !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(em) > 200 then raise exception 'friend_email_invalid'; end if;
    if em = lower(me.email) then raise exception 'friend_is_you'; end if;
    if em = any(seen) then raise exception 'friend_duplicate'; end if;
    seen := seen || em;
  end loop;

  if p_include_self and exists (
       select 1 from public.enrollments where event_id = p_event_id and user_id = auth.uid() and status = 'paid') then
    raise exception 'already_enrolled';
  end if;

  -- drop this player's earlier unfinished attempts for the event
  update public.orders set status = 'cancelled'
   where buyer_id = auth.uid() and event_id = p_event_id and status = 'pending';
  update public.seat_invites set status = 'cancelled'
   where inviter_id = auth.uid() and event_id = p_event_id and status = 'pending';
  update public.enrollments set status = 'cancelled', hold_expires_at = null
   where user_id = auth.uid() and event_id = p_event_id and status = 'pending_payment';

  if public.seats_taken(p_event_id) + n > ev.max_players then raise exception 'event_full'; end if;

  insert into public.orders (event_id, buyer_id, seats, amount, currency, hold_expires_at)
  values (p_event_id, auth.uid(), n, ev.entry_fee * n, ev.currency, now() + interval '35 minutes')
  returning * into o;

  if p_include_self then
    insert into public.enrollments (event_id, user_id, status, order_id, hold_expires_at)
    values (p_event_id, auth.uid(), 'pending_payment', o.id, o.hold_expires_at)
    on conflict (event_id, user_id) do update
      set status = 'pending_payment', order_id = o.id, hold_expires_at = o.hold_expires_at, paid_at = null;
  end if;

  insert into public.seat_invites (order_id, event_id, inviter_id, email, name)
  select o.id, p_event_id, auth.uid(), lower(trim(x ->> 'email')), nullif(trim(x ->> 'name'), '')
  from jsonb_array_elements(coalesce(p_friends, '[]'::jsonb)) x;

  if o.amount = 0 then
    perform public._mark_order_paid(o.id, null);
    select * into o from public.orders where id = o.id;
  end if;
  return o;
end $$;

-- Give up an unpaid order (frees the held seats immediately).
create or replace function public.cancel_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into o from public.orders where id = p_order_id and buyer_id = auth.uid() for update;
  if not found or o.status <> 'pending' then raise exception 'cannot_cancel'; end if;
  update public.orders set status = 'cancelled' where id = o.id;
  update public.enrollments set status = 'cancelled', hold_expires_at = null where order_id = o.id and status = 'pending_payment';
  update public.seat_invites set status = 'cancelled' where order_id = o.id and status = 'pending';
end $$;

-- Internal: called by the payment webhook (server side) or by an admin. Idempotent.
create or replace function public._mark_order_paid(p_order_id uuid, p_session_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  o  public.orders;
  ev public.events;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status = 'paid' then return; end if;

  if o.status = 'pending' then
    update public.orders set status = 'paid', paid_at = now(), stripe_session_id = coalesce(p_session_id, stripe_session_id) where id = o.id;
    update public.enrollments set status = 'paid', paid_at = now(), hold_expires_at = null
     where order_id = o.id and status = 'pending_payment';
    update public.seat_invites set status = 'ready' where order_id = o.id and status = 'pending';
    return;
  end if;

  -- The order had been cancelled, but the money arrived (e.g. paid in an old browser tab).
  select * into ev from public.events where id = o.event_id;
  if ev.status = 'open' and public.seats_taken(o.event_id) + o.seats <= ev.max_players then
    update public.orders set status = 'paid', paid_at = now(), stripe_session_id = coalesce(p_session_id, stripe_session_id) where id = o.id;
    update public.enrollments set status = 'paid', paid_at = now(), hold_expires_at = null
     where order_id = o.id and status = 'cancelled';
    update public.seat_invites set status = 'ready' where order_id = o.id and status = 'cancelled';
  else
    update public.orders set status = 'paid', paid_at = now(), needs_review = true,
           stripe_session_id = coalesce(p_session_id, stripe_session_id) where id = o.id;
  end if;
end $$;

create or replace function public.admin_mark_order_paid(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  perform public._mark_order_paid(p_order_id, null);
end $$;

create or replace function public.admin_cancel_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  update public.seat_invites set status = 'cancelled' where id = p_invite_id and status in ('pending', 'ready');
end $$;

-- What a friend sees before signing in: which event, who paid for them.
create or replace function public.get_invite(p_token text)
returns table (status text, event_name text, event_slug text, venue text, starts_at timestamptz,
               event_status text, inviter_name text)
language sql stable security definer set search_path = public as $$
  select i.status, ev.name, ev.slug, ev.venue, ev.starts_at, ev.status, p.full_name
  from public.seat_invites i
  join public.events ev on ev.id = i.event_id
  join public.profiles p on p.id = i.inviter_id
  where i.token = p_token
$$;

-- The friend claims the seat that was paid for them (needs an account with a complete profile).
create or replace function public.claim_invite(p_token text) returns public.enrollments
language plpgsql security definer set search_path = public as $$
declare
  i  public.seat_invites;
  ev public.events;
  me public.profiles;
  r  public.enrollments;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.onboarded_at is null then raise exception 'profile_incomplete'; end if;

  select * into i from public.seat_invites where token = p_token for update;
  if not found then raise exception 'invite_invalid'; end if;
  if i.status = 'claimed' then raise exception 'invite_claimed'; end if;
  if i.status <> 'ready' then raise exception 'invite_not_ready'; end if;

  select * into ev from public.events where id = i.event_id;
  if ev.status <> 'open' then raise exception 'event_not_open'; end if;
  if exists (select 1 from public.enrollments where event_id = i.event_id and user_id = auth.uid() and status = 'paid') then
    raise exception 'already_enrolled';
  end if;

  insert into public.enrollments (event_id, user_id, status, paid_at, order_id)
  values (i.event_id, auth.uid(), 'paid', now(), i.order_id)
  on conflict (event_id, user_id) do update
    set status = 'paid', paid_at = now(), order_id = i.order_id, hold_expires_at = null
  returning * into r;

  update public.seat_invites set status = 'claimed', claimed_by = auth.uid(), claimed_at = now() where id = i.id;
  return r;
end $$;

-- Old one-step enrolling is replaced by create_order().
drop function if exists public.enroll_in_event(uuid);
drop function if exists public.cancel_enrollment(uuid);

-- Function permissions: players call these; internal ones are server-only.
revoke execute on function public._mark_order_paid(uuid, text) from public, anon, authenticated;
revoke execute on function
  public.create_order(uuid, boolean, jsonb), public.cancel_order(uuid), public.claim_invite(text),
  public.save_profile(text, text, text, int, boolean, text),
  public.admin_mark_order_paid(uuid), public.admin_cancel_invite(uuid)
  from public, anon;
grant execute on function
  public.create_order(uuid, boolean, jsonb), public.cancel_order(uuid), public.claim_invite(text),
  public.save_profile(text, text, text, int, boolean, text),
  public.admin_mark_order_paid(uuid), public.admin_cancel_invite(uuid)
  to authenticated;
grant execute on function public.get_invite(text), public.seats_taken(uuid) to anon, authenticated;
grant select on public.public_profiles, public.public_enrollments, public.event_seats to anon, authenticated;
