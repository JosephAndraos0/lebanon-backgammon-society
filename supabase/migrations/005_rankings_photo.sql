-- Migration 005 — run once on a database that already has migrations 002-004.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- The leaderboard showed a player's initials even though their real photo is public
-- everywhere else on the site (event pages, admin, the champion card). The view just
-- wasn't exposing avatar_url — this adds it, no RLS or table change needed.

-- CREATE OR REPLACE VIEW can only add columns at the end of the list, not insert
-- them in the middle — avatar_url has to go last, after the existing columns.
create or replace view public.public_rankings as
  select p.id as user_id,
         p.full_name,
         count(*)::int                 as events_played,
         coalesce(sum(e.points), 0)::int as points,
         min(e.final_place)            as best_place,
         p.avatar_url
  from public.profiles p
  join public.enrollments e on e.user_id = p.id
  where e.status = 'paid' and e.points is not null
  group by p.id, p.full_name;
