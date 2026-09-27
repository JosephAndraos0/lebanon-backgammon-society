-- Migration 004 — run once on a database that already has migrations 002 and 003.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- Lets the organizer add a photo to a tournament, shown faded behind its card on the
-- tournaments list and home page (the name and details stay readable on top of it).
-- Photos live in their own public storage bucket. Unlike the avatars bucket, there's
-- no per-user folder here — only the admin can write to it at all.

alter table public.events add column if not exists image_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-photos', 'event-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists event_photos_select on storage.objects;
drop policy if exists event_photos_write on storage.objects;
create policy event_photos_select on storage.objects for select using (bucket_id = 'event-photos');
create policy event_photos_write on storage.objects for all to authenticated
  using (bucket_id = 'event-photos' and public.is_admin())
  with check (bucket_id = 'event-photos' and public.is_admin());
