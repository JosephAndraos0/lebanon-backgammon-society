-- Lebanon Backgammon Society — database schema for Supabase (Postgres).
-- Run this whole file once in: Supabase dashboard -> SQL Editor -> New query -> Run.
-- It is safe to re-run only on an empty project (it does not use "if not exists" for tables).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.events (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  venue        text not null default '',
  starts_at    timestamptz not null,
  entry_fee    numeric(10,2) not null default 25 check (entry_fee >= 0),
  currency     text not null default 'USD',
  max_players  int not null default 16 check (max_players between 2 and 128),
  description  text not null default '',
  status       text not null default 'draft'
               check (status in ('draft','open','live','completed','cancelled')),
  prizes       numeric(10,2)[] not null default '{0,0,0}',   -- fixed amounts: 1st, 2nd, 3rd place
  created_at   timestamptz not null default now()
);

create table public.enrollments (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references public.events(id) on delete cascade,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  status             text not null default 'pending_payment'
                     check (status in ('pending_payment','paid','cancelled')),
  paid_at            timestamptz,
  seed               int,
  final_place        int,
  points             int,
  stripe_session_id  text,
  created_at         timestamptz not null default now(),
  unique (event_id, user_id)
);

-- One row per bracket slot. round 1 = first round. The final is (last round, position 1);
-- the third-place match is (last round, position 2).
create table public.matches (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  round       int not null check (round >= 1),
  position    int not null check (position >= 1),
  player_a    uuid references public.profiles(id),
  player_b    uuid references public.profiles(id),
  score_a     int,
  score_b     int,
  winner      uuid references public.profiles(id),
  status      text not null default 'pending'
              check (status in ('pending','live','done','bye')),
  unique (event_id, round, position)
);

create index on public.enrollments (event_id);
create index on public.enrollments (user_id);
create index on public.matches (event_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- Create a profile automatically whenever someone signs up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email,
          coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles    enable row level security;
alter table public.events      enable row level security;
alter table public.enrollments enable row level security;
alter table public.matches     enable row level security;

-- profiles: you can read/update yourself (name only); admins can read everyone.
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from anon, authenticated;
grant  update (full_name) on public.profiles to authenticated;

-- events: everyone sees non-draft events; only admins write.
create policy events_select on public.events for select
  using (status <> 'draft' or public.is_admin());
create policy events_admin_write on public.events for all
  using (public.is_admin()) with check (public.is_admin());

-- enrollments: you see your own; admins see and edit all. Players enroll through the
-- enroll_in_event() function below (never by inserting directly).
create policy enrollments_select on public.enrollments for select
  using (user_id = auth.uid() or public.is_admin());
create policy enrollments_admin_write on public.enrollments for all
  using (public.is_admin()) with check (public.is_admin());

-- matches: public read, admin write.
create policy matches_select on public.matches for select using (true);
create policy matches_admin_write on public.matches for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Public views (only expose what the website needs to show everyone)
-- ---------------------------------------------------------------------------

create view public.public_profiles as
  select id, full_name from public.profiles;

create view public.public_enrollments as
  select event_id, user_id, status, seed, final_place
  from public.enrollments
  where status <> 'cancelled';

create view public.event_seats as
  select event_id,
         count(*)::int as taken,
         (count(*) filter (where status = 'paid'))::int as paid
  from public.enrollments
  where status <> 'cancelled'
  group by event_id;

create view public.public_rankings as
  select p.id as user_id,
         p.full_name,
         count(*)::int                 as events_played,
         coalesce(sum(e.points), 0)::int as points,
         min(e.final_place)            as best_place
  from public.profiles p
  join public.enrollments e on e.user_id = p.id
  where e.status = 'paid' and e.points is not null
  group by p.id, p.full_name;

grant select on public.public_profiles, public.public_enrollments,
                public.event_seats, public.public_rankings
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enrolling (called from the website)
-- ---------------------------------------------------------------------------

create function public.enroll_in_event(p_event_id uuid) returns public.enrollments
language plpgsql security definer set search_path = public as $$
declare
  ev  public.events;
  r   public.enrollments;
  cnt int;
  new_status text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select * into ev from public.events where id = p_event_id for update;  -- serialises seat checks
  if not found or ev.status <> 'open' then raise exception 'event_not_open'; end if;

  select count(*) into cnt from public.enrollments
   where event_id = p_event_id and status <> 'cancelled';

  new_status := case when ev.entry_fee = 0 then 'paid' else 'pending_payment' end;

  select * into r from public.enrollments where event_id = p_event_id and user_id = auth.uid();
  if found then
    if r.status <> 'cancelled' then raise exception 'already_enrolled'; end if;
    if cnt >= ev.max_players then raise exception 'event_full'; end if;
    update public.enrollments
       set status = new_status,
           paid_at = case when new_status = 'paid' then now() else null end
     where id = r.id
     returning * into r;
    return r;
  end if;

  if cnt >= ev.max_players then raise exception 'event_full'; end if;

  insert into public.enrollments (event_id, user_id, status, paid_at)
  values (p_event_id, auth.uid(), new_status, case when new_status = 'paid' then now() end)
  returning * into r;
  return r;
end $$;

-- Players may cancel an unpaid reservation while the event is still open.
-- (Paid cancellations/refunds are handled by an admin.)
create function public.cancel_enrollment(p_event_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  update public.enrollments e
     set status = 'cancelled'
   where e.event_id = p_event_id
     and e.user_id = auth.uid()
     and e.status = 'pending_payment'
     and exists (select 1 from public.events ev where ev.id = e.event_id and ev.status = 'open');
  if not found then raise exception 'cannot_cancel'; end if;
end $$;

grant execute on function public.enroll_in_event(uuid), public.cancel_enrollment(uuid) to authenticated;
revoke execute on function public.enroll_in_event(uuid), public.cancel_enrollment(uuid) from anon;

-- ---------------------------------------------------------------------------
-- Make yourself the admin: sign up on the website first, then run this once
-- (replace the email), so the admin dashboard appears for your account.
-- ---------------------------------------------------------------------------
-- update public.profiles set is_admin = true where email = 'you@example.com';
