-- Migration 008 — run once on a database that already has migrations 002-007.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- Keeps a log of "tournament announcement" emails the admin sends to opted-in players,
-- so the admin page can say "already emailed on ..." before sending again.
-- Only the send-announcement Edge Function (service role) writes to it; only an admin can read it.

create table if not exists public.event_announcements (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  sent_by     uuid references public.profiles(id) on delete set null,
  recipients  int not null default 0,
  failed      int not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.event_announcements enable row level security;

drop policy if exists event_announcements_admin_select on public.event_announcements;
create policy event_announcements_admin_select on public.event_announcements
  for select using (public.is_admin());
