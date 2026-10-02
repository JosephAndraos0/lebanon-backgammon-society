-- Migration 007 — run once on a database that already has migrations 002-006.
-- (A brand-new project should just run schema.sql, which already includes all of this.)
--
-- The Society doesn't award cash prizes, so the dollar amounts stored in events.prizes
-- are no longer used anywhere in the site. This resets every event's amounts to zero.
-- The column itself stays (dropping it is a bigger change nobody asked for).

update public.events set prizes = '{0,0,0}' where prizes is distinct from '{0,0,0}'::numeric(10,2)[];
