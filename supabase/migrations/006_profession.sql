-- Migration 006 — run once on a database that already has migrations 002-005.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- Adds a "profession" to each player's profile. The whole point of the Society is for
-- people to meet each other, so this is shown publicly next to their name and photo —
-- not private like phone/email. Required going forward, same as the photo and skill
-- level already are. (profession has to go last in both views below: CREATE OR REPLACE
-- VIEW can only append columns, same constraint as migration 005's avatar_url addition.)

alter table public.profiles add column if not exists profession text;

drop function if exists public.save_profile(text, text, text, int, boolean, text);

create function public.save_profile(
  p_first text, p_last text, p_phone text, p_skill int, p_marketing boolean,
  p_avatar_url text, p_profession text
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  f    text := trim(coalesce(p_first, ''));
  l    text := trim(coalesce(p_last, ''));
  ph   text := regexp_replace(trim(coalesce(p_phone, '')), '[^0-9+]', '', 'g');
  prof text := trim(coalesce(p_profession, ''));
  av   text;
  r    public.profiles;
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
  if prof = '' then raise exception 'profession_required'; end if;
  if length(prof) > 80 then raise exception 'profession_too_long'; end if;

  select coalesce(p_avatar_url, avatar_url) into av from public.profiles where id = auth.uid();
  if av is null then raise exception 'photo_required'; end if;

  update public.profiles
     set first_name = f, last_name = l, full_name = f || ' ' || l, phone = ph,
         skill_level = p_skill, marketing_opt_in = p_marketing, avatar_url = av,
         profession = prof, onboarded_at = coalesce(onboarded_at, now())
   where id = auth.uid()
   returning * into r;
  return r;
end $$;

revoke execute on function public.save_profile(text, text, text, int, boolean, text, text) from public, anon;
grant execute on function public.save_profile(text, text, text, int, boolean, text, text) to authenticated;

-- Profession shown publicly, like name/photo — not private like phone/email.
create or replace view public.public_profiles as
  select id, full_name, avatar_url, profession from public.profiles;

create or replace view public.public_rankings as
  select p.id as user_id,
         p.full_name,
         count(*)::int                 as events_played,
         coalesce(sum(e.points), 0)::int as points,
         min(e.final_place)            as best_place,
         p.avatar_url,
         p.profession
  from public.profiles p
  join public.enrollments e on e.user_id = p.id
  where e.status = 'paid' and e.points is not null
  group by p.id, p.full_name;
