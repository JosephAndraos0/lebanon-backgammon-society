import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

import { fileURLToPath } from 'url';
// The supabase/ folder of this repo (override with LBS_SUPABASE_DIR, ending in a slash, if needed).
const root = process.env.LBS_SUPABASE_DIR || fileURLToPath(new URL('../../supabase/', import.meta.url));
const mode = process.argv[2] || 'migrate';   // 'migrate' = baseline + 002 + 003 + 004 + 005 + 006 ; 'fresh' = schema.sql only
const db = new PGlite();

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
  grant usage on schema auth, storage, public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant all on all functions in schema storage to anon, authenticated, service_role;
`);
if (mode === 'migrate') {
  await db.exec(fs.readFileSync(root + 'migrations/000_baseline_before_002.sql.txt', 'utf8'));
  // live DB already had a test row before migrating: keep one to prove data survives
  await db.exec(`insert into auth.users(id,email,raw_user_meta_data) values ('11111111-1111-1111-1111-111111111111','old@x.com','{"full_name":"Old Timer"}');`);
  await db.exec(fs.readFileSync(root + 'migrations/002_profiles_holds_orders_invites.sql', 'utf8'));
  await db.exec(fs.readFileSync(root + 'migrations/003_decline_invite.sql', 'utf8'));
  await db.exec(fs.readFileSync(root + 'migrations/004_event_photos.sql', 'utf8'));
  await db.exec(fs.readFileSync(root + 'migrations/005_rankings_photo.sql', 'utf8'));
  await db.exec(fs.readFileSync(root + 'migrations/006_profession.sql', 'utf8'));
} else {
  await db.exec(fs.readFileSync(root + 'schema.sql', 'utf8'));
}
console.log('applied:', mode);

let fails = 0;
const as = async (uid, role, q, params) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await db.query(q, params); } finally { await db.exec('reset role;'); }
};
const blocked = async (label, fn, expectMsg) => {
  try { await fn(); console.log('FAIL (should have errored):', label); fails++; }
  catch (e) { const good = !expectMsg || e.message.includes(expectMsg); if (!good) { fails++; console.log('FAIL wrong error:', label, '->', e.message); } else console.log('ok  blocked:', label, '->', e.message); }
};
const ok = (label, cond, extra) => { console.log(cond ? 'ok  ' : 'FAIL', label, cond ? '' : (extra || '')); if (!cond) fails++; };
const val = async (q, p) => (await db.query(q, p)).rows[0];

const newUser = async (email, meta = {}) => (await db.query(`insert into auth.users(email, raw_user_meta_data) values ($1, $2) returning id`, [email, JSON.stringify(meta)])).rows[0].id;
const admin = await newUser('admin@x.com', { first_name: 'Ada', last_name: 'Min' });
const p1 = await newUser('p1@x.com', { first_name: 'Player', last_name: 'One' });
const p2 = await newUser('p2@x.com', { first_name: 'Player', last_name: 'Two' });
const p3 = await newUser('p3@x.com', { full_name: 'Player Three' });
const p4 = await newUser('p4@x.com');
await db.query(`update profiles set is_admin = true where id = $1`, [admin]);

// ---- profiles
ok('names split from signup metadata', (await val(`select first_name f, last_name l, full_name n from profiles where id=$1`, [p1])).n === 'Player One');
ok('legacy full_name signup split', (await val(`select first_name f, last_name l from profiles where id=$1`, [p3])).l === 'Three');
ok('email-only signup gets fallback name', (await val(`select full_name n from profiles where id=$1`, [p4])).n === 'p4');
if (mode === 'migrate') ok('pre-existing user was backfilled', (await val(`select first_name f, last_name l from profiles where email='old@x.com'`)).l === 'Timer');
await blocked('player editing own profile row directly', () => as(p1, 'authenticated', `update profiles set phone='1' where id=$1`, [p1]));
await blocked('player making self admin', () => as(p1, 'authenticated', `update profiles set is_admin=true where id=$1`, [p1]));
const av = (u) => `https://x.supabase.co/storage/v1/object/public/avatars/${u}/avatar.jpg?v=1`;
await blocked('save_profile without photo', () => as(p1, 'authenticated', `select save_profile('Player','One','+96170123456',3,true,null,'Engineer')`), 'photo_required');
await blocked('save_profile with someone else\'s photo path', () => as(p1, 'authenticated', `select save_profile('Player','One','+96170123456',3,true,$1,'Engineer')`, [av(p2)]), 'avatar_invalid');
await blocked('save_profile bad phone', () => as(p1, 'authenticated', `select save_profile('Player','One','abc',3,true,$1,'Engineer')`, [av(p1)]), 'phone_invalid');
await blocked('save_profile bad skill', () => as(p1, 'authenticated', `select save_profile('Player','One','+96170123456',9,true,$1,'Engineer')`, [av(p1)]), 'skill_invalid');
await blocked('save_profile missing marketing answer', () => as(p1, 'authenticated', `select save_profile('Player','One','+96170123456',3,null,$1,'Engineer')`, [av(p1)]), 'marketing_required');
await blocked('save_profile missing profession', () => as(p1, 'authenticated', `select save_profile('Player','One','+96170123456',3,true,$1,'')`, [av(p1)]), 'profession_required');
await blocked('save_profile profession too long', () => as(p1, 'authenticated', `select save_profile('Player','One','+96170123456',3,true,$1,$2)`, [av(p1), 'x'.repeat(81)]), 'profession_too_long');
await blocked('save_profile anonymous', () => as(null, 'anon', `select save_profile('A','B','+96170123456',3,true,null,'Engineer')`));
for (const [u, n] of [[p1, 'One'], [p2, 'Two'], [p3, 'Three']])
  await as(u, 'authenticated', `select save_profile('Player',$2,'+961 70 123 456',3,false,$1,'Backgammon Enthusiast')`, [av(u), n]);
const prof = await val(`select phone, onboarded_at, full_name, marketing_opt_in, profession from profiles where id=$1`, [p1]);
ok('phone normalised, onboarded, consent stored, profession saved', prof.phone === '+96170123456' && prof.onboarded_at && prof.marketing_opt_in === false && prof.full_name === 'Player One' && prof.profession === 'Backgammon Enthusiast');
ok('public_profiles exposes name, photo, and profession (not phone/email)', Object.keys((await as(null, 'anon', `select * from public_profiles limit 1`)).rows[0]).sort().join() === 'avatar_url,full_name,id,profession');
ok('anon cannot read phones', (await as(null, 'anon', `select count(*)::int c from profiles`)).rows[0].c === 0);
ok('player reads only own profile', (await as(p1, 'authenticated', `select count(*)::int c from profiles`)).rows[0].c === 1);
// storage policies (own folder only)
await as(p1, 'authenticated', `insert into storage.objects(bucket_id,name,owner) values ('avatars',$1,$2)`, [`${p1}/avatar.jpg`, p1]);
await blocked('uploading into another player\'s folder', () => as(p1, 'authenticated', `insert into storage.objects(bucket_id,name,owner) values ('avatars',$1,$2)`, [`${p2}/avatar.jpg`, p1]));
await blocked('anon uploading a photo', () => as(null, 'anon', `insert into storage.objects(bucket_id,name) values ('avatars',$1)`, [`${p1}/x.jpg`]));

// ---- events
const ev = (await as(admin, 'authenticated', `insert into events(slug,name,starts_at,status,max_players,entry_fee,currency) values ('cup','Cup', now()+interval '7 days','open',4,25,'USD') returning id`)).rows[0].id;
const free = (await as(admin, 'authenticated', `insert into events(slug,name,starts_at,status,max_players,entry_fee) values ('free','Free', now()+interval '7 days','open',3,0) returning id`)).rows[0].id;
const seats = async (e) => (await as(null, 'anon', `select taken, paid from event_seats where event_id=$1`, [e])).rows[0];

// ---- checkout: onboarding gate
await blocked('unfinished profile cannot order', () => as(p4, 'authenticated', `select create_order($1,true,'[]')`, [ev]), 'profile_incomplete');
await blocked('anonymous cannot order', () => as(null, 'anon', `select create_order($1,true,'[]')`, [ev]));
await blocked('order for nothing', () => as(p1, 'authenticated', `select create_order($1,false,'[]')`, [ev]), 'no_seats');

// ---- single seat: hold, not paid
const o1 = (await as(p1, 'authenticated', `select * from create_order($1,true,'[]')`, [ev])).rows[0];
ok('order is pending, $25, 1 seat', o1.status === 'pending' && Number(o1.amount) === 25 && o1.seats === 1);
let s = await seats(ev); ok('unpaid hold occupies a seat', s.taken === 1 && s.paid === 0);
ok('unpaid person NOT in public player list', (await as(null, 'anon', `select count(*)::int c from public_enrollments where event_id=$1`, [ev])).rows[0].c === 0);
ok('enrollment is pending_payment (not paid)', (await val(`select status from enrollments where user_id=$1 and event_id=$2`, [p1, ev])).status === 'pending_payment');
await blocked('player marking own seat paid', async () => { const r = await as(p1, 'authenticated', `update enrollments set status='paid' where user_id=$1 returning id`, [p1]); if (!r.rows.length) throw new Error('0 rows (RLS)'); });
await blocked('player calling the internal mark-paid function', () => as(p1, 'authenticated', `select _mark_order_paid($1,'x')`, [o1.id]));
await blocked('anon calling the internal mark-paid function', () => as(null, 'anon', `select _mark_order_paid($1,'x')`, [o1.id]));
await blocked('non-admin admin_mark_order_paid', () => as(p1, 'authenticated', `select admin_mark_order_paid($1)`, [o1.id]), 'not_admin');

// ---- expiry: holds lapse, seat freed, still not paid
await db.query(`update orders set hold_expires_at = now() - interval '1 minute' where id=$1`, [o1.id]);
await db.query(`update enrollments set hold_expires_at = now() - interval '1 minute' where order_id=$1`, [o1.id]);
s = await seats(ev); ok('expired hold frees the seat', s.taken === 0);
ok('still not paid after expiry', (await val(`select status from enrollments where user_id=$1 and event_id=$2`, [p1, ev])).status === 'pending_payment');

// ---- webhook (service role) marks paid
const o2 = (await as(p1, 'authenticated', `select * from create_order($1,true,'[]')`, [ev])).rows[0];
ok('re-ordering creates a fresh hold', (await seats(ev)).taken === 1);
ok('previous pending order got cancelled', (await val(`select status from orders where id=$1`, [o1.id])).status === 'cancelled');
await as(null, 'service_role', `select _mark_order_paid($1,'cs_test_1')`, [o2.id]);
await as(null, 'service_role', `select _mark_order_paid($1,'cs_test_1')`, [o2.id]);   // idempotent
ok('webhook marks paid (idempotent)', (await val(`select status, paid_at from enrollments where user_id=$1 and event_id=$2`, [p1, ev])).status === 'paid');
ok('paid player now listed publicly', (await as(null, 'anon', `select count(*)::int c from public_enrollments where event_id=$1`, [ev])).rows[0].c === 1);
await blocked('paying twice for the same event', () => as(p1, 'authenticated', `select create_order($1,true,'[]')`, [ev]), 'already_enrolled');

// ---- friends
await blocked('inviting yourself', () => as(p2, 'authenticated', `select create_order($1,true,$2::jsonb)`, [ev, JSON.stringify([{ email: 'P2@x.com' }])]), 'friend_is_you');
await blocked('bad friend email', () => as(p2, 'authenticated', `select create_order($1,true,$2::jsonb)`, [ev, JSON.stringify([{ email: 'nope' }])]), 'friend_email_invalid');
await blocked('duplicate friend email', () => as(p2, 'authenticated', `select create_order($1,true,$2::jsonb)`, [ev, JSON.stringify([{ email: 'a@x.com' }, { email: 'A@X.com' }])]), 'friend_duplicate');
await blocked('more than 8 friends', () => as(p2, 'authenticated', `select create_order($1,true,$2::jsonb)`, [ev, JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ email: `f${i}@x.com` })))]), 'too_many_friends');
await blocked('event too full for the group (1 taken + 4 > 4)', () => as(p2, 'authenticated', `select create_order($1,true,$2::jsonb)`, [ev, JSON.stringify([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }])]), 'event_full');
const o3 = (await as(p2, 'authenticated', `select * from create_order($1,true,$2::jsonb)`, [ev, JSON.stringify([{ email: 'Friend@X.com', name: 'Fri End' }, { email: 'other@x.com' }])])).rows[0];
ok('group order = 3 seats, $75', o3.seats === 3 && Number(o3.amount) === 75);
s = await seats(ev); ok('group hold occupies 3 seats (+1 paid = 4)', s.taken === 4);
await blocked('a fifth person cannot squeeze in', () => as(p3, 'authenticated', `select create_order($1,true,'[]')`, [ev]), 'event_full');
const inv = (await db.query(`select id, token, status, email from seat_invites where order_id=$1 order by email`, [o3.id])).rows;
ok('invites stored lowercase and pending until paid', inv.length === 2 && inv[0].email === 'friend@x.com' && inv[0].status === 'pending');
await blocked('claiming an unpaid invite', () => as(p3, 'authenticated', `select claim_invite($1)`, [inv[0].token]), 'invite_not_ready');
ok('invite tokens are long', inv[0].token.length >= 60);
ok('stranger cannot read invites', (await as(p3, 'authenticated', `select count(*)::int c from seat_invites`)).rows[0].c === 0);
ok('buyer can read own invites', (await as(p2, 'authenticated', `select count(*)::int c from seat_invites`)).rows[0].c === 2);
ok('anon cannot read invites table', (await as(null, 'anon', `select count(*)::int c from seat_invites`)).rows[0].c === 0);
await as(null, 'service_role', `select _mark_order_paid($1,'cs_test_3')`, [o3.id]);
ok('invites ready after payment', (await val(`select count(*)::int c from seat_invites where order_id=$1 and status='ready'`, [o3.id])).c === 2);
s = await seats(ev); ok('seat count unchanged after payment (4)', s.taken === 4);
const info = (await as(null, 'anon', `select * from get_invite($1)`, [inv[0].token])).rows[0];
ok('get_invite shows event + who paid (before login)', info.event_name === 'Cup' && info.inviter_name === 'Player Two' && info.status === 'ready');
ok('get_invite reveals nothing for a wrong token', (await as(null, 'anon', `select count(*)::int c from get_invite('nope')`)).rows[0].c === 0);
await blocked('anon claiming', () => as(null, 'anon', `select claim_invite($1)`, [inv[0].token]));
await blocked('claim with unfinished profile', () => as(p4, 'authenticated', `select claim_invite($1)`, [inv[0].token]), 'profile_incomplete');
await blocked('claim with a made-up token', () => as(p3, 'authenticated', `select claim_invite('bogus')`), 'invite_invalid');
await blocked('buyer claiming a friend seat while already enrolled', () => as(p2, 'authenticated', `select claim_invite($1)`, [inv[0].token]), 'already_enrolled');
const claimed = (await as(p3, 'authenticated', `select * from claim_invite($1)`, [inv[0].token])).rows[0];
ok('friend claims: paid enrollment', claimed.status === 'paid' && claimed.user_id === p3);
await blocked('claiming twice', () => as(p3, 'authenticated', `select claim_invite($1)`, [inv[0].token]), 'invite_claimed');
s = await seats(ev); ok('claiming does not change seat count (still 4)', s.taken === 4);
await blocked('the same friend claiming a second seat', () => as(p3, 'authenticated', `select claim_invite($1)`, [inv[1].token]), 'already_enrolled');
ok('claimed friend now listed publicly', (await as(null, 'anon', `select count(*)::int c from public_enrollments where event_id=$1`, [ev])).rows[0].c === 3);

// ---- cancelling
await blocked('cancel someone else\'s order', () => as(p1, 'authenticated', `select cancel_order($1)`, [o3.id]), 'cannot_cancel');
await blocked('cancel an already-paid order', () => as(p2, 'authenticated', `select cancel_order($1)`, [o3.id]), 'cannot_cancel');
const o4 = (await as(p4, 'authenticated', `select 1`)).rows; // p4 has no profile; onboard p4 quickly then order + cancel
await as(p4, 'authenticated', `select save_profile('Four','Four','+96170999999',2,true,$1,'Architect')`, [av(p4)]);
const free1 = (await as(p4, 'authenticated', `select * from create_order($1,true,'[]')`, [free])).rows[0];
ok('free event: instantly paid, no payment needed', free1.status === 'paid' && (await val(`select status from enrollments where user_id=$1 and event_id=$2`, [p4, free])).status === 'paid');
const o5 = (await as(p1, 'authenticated', `select * from create_order($1,true,'[]')`, [free])).rows[0];
ok('free order paid instantly for p1', o5.status === 'paid');

// ---- admin
ok('admin sees all orders', (await as(admin, 'authenticated', `select count(*)::int c from orders`)).rows[0].c >= 4);
await as(admin, 'authenticated', `select admin_cancel_invite($1)`, [inv[1].id]);
ok('admin cancelled the unclaimed friend seat -> frees it', (await seats(ev)).taken === 3);
await blocked('player cancelling an invite', () => as(p2, 'authenticated', `select admin_cancel_invite($1)`, [inv[1].id]), 'not_admin');

// ---- late payment for a cancelled order (paid in an old tab)
const ev2 = (await as(admin, 'authenticated', `insert into events(slug,name,starts_at,status,max_players,entry_fee) values ('c2','C2', now()+interval '7 days','open',2,10) returning id`)).rows[0].id;
const oa = (await as(p1, 'authenticated', `select * from create_order($1,true,'[]')`, [ev2])).rows[0];
await as(p1, 'authenticated', `select cancel_order($1)`, [oa.id]);
ok('cancelled order frees seat', (await seats(ev2)).taken === 0);
await as(null, 'service_role', `select _mark_order_paid($1,'late')`, [oa.id]);
ok('late payment revives the seat when there is room', (await val(`select status from enrollments where user_id=$1 and event_id=$2`, [p1, ev2])).status === 'paid');
const ob = (await as(p2, 'authenticated', `select * from create_order($1,true,'[]')`, [ev2])).rows[0];
await as(p2, 'authenticated', `select cancel_order($1)`, [ob.id]);
const oc = (await as(p3, 'authenticated', `select * from create_order($1,true,'[]')`, [ev2])).rows[0]; await as(null, 'service_role', `select _mark_order_paid($1,'c')`, [oc.id]);
await as(null, 'service_role', `select _mark_order_paid($1,'late2')`, [ob.id]);
ok('late payment with no room is flagged for admin review (not silently lost)', (await val(`select needs_review from orders where id=$1`, [ob.id])).needs_review === true);

// ---- declining a paid invite (friend doesn't want the seat, never visits the claim link)
const p5 = await newUser('p5@x.com', { first_name: 'Player', last_name: 'Five' });
await as(p5, 'authenticated', `select save_profile('Player','Five','+96170555555',3,true,$1,'Teacher')`, [av(p5)]);
const ev3 = (await as(admin, 'authenticated', `insert into events(slug,name,starts_at,status,max_players,entry_fee) values ('c3','C3', now()+interval '7 days','open',5,10) returning id`)).rows[0].id;
const o6 = (await as(p1, 'authenticated', `select * from create_order($1,true,$2::jsonb)`, [ev3, JSON.stringify([{ email: 'p5@x.com', name: 'Five' }])])).rows[0];
await as(null, 'service_role', `select _mark_order_paid($1,'cs_decline')`, [o6.id]);
ok('friend seat ready after payment', (await val(`select status from seat_invites where order_id=$1`, [o6.id])).status === 'ready');
ok('both seats occupied right after payment', (await seats(ev3)).taken === 2);
ok('unrelated player sees no pending invites', (await as(p3, 'authenticated', `select count(*)::int c from my_pending_invites()`)).rows[0].c === 0);
const pend = (await as(p5, 'authenticated', `select * from my_pending_invites()`)).rows;
ok('invited friend sees the paid seat waiting, matched by email (never visited the link)',
   pend.length === 1 && pend[0].event_name === 'C3' && pend[0].inviter_name === 'Player One');
const inv3 = await val(`select id, token from seat_invites where order_id=$1`, [o6.id]);
await blocked('a stranger cannot decline someone else\'s invite', () => as(p3, 'authenticated', `select decline_invite($1)`, [inv3.id]), 'invite_invalid');
await blocked('anon cannot decline', () => as(null, 'anon', `select decline_invite($1)`, [inv3.id]));
await as(p5, 'authenticated', `select decline_invite($1)`, [inv3.id]);
ok('declining frees the seat immediately (buyer keeps theirs)', (await seats(ev3)).taken === 1);
ok('invite marked declined, not cancelled (admin still needs to refund it)', (await val(`select status from seat_invites where id=$1`, [inv3.id])).status === 'declined');
ok('declined invite drops off the friend\'s pending list', (await as(p5, 'authenticated', `select count(*)::int c from my_pending_invites()`)).rows[0].c === 0);
await blocked('declining twice', () => as(p5, 'authenticated', `select decline_invite($1)`, [inv3.id]), 'invite_invalid');
await blocked('claiming after declining', () => as(p5, 'authenticated', `select claim_invite($1)`, [inv3.token]), 'invite_not_ready');
await blocked('non-admin marking a decline refunded', () => as(p1, 'authenticated', `select admin_mark_invite_refunded($1)`, [inv3.id]), 'not_admin');
await as(admin, 'authenticated', `select admin_mark_invite_refunded($1)`, [inv3.id]);
ok('admin closes it out once refunded in Stripe', (await val(`select status from seat_invites where id=$1`, [inv3.id])).status === 'cancelled');

// ---- event photos (migration 004)
await as(admin, 'authenticated', `update events set image_url=$1 where id=$2`, ['https://x.supabase.co/storage/v1/object/public/event-photos/' + ev + '/photo.jpg', ev]);
ok('admin can set an event photo', (await val(`select image_url from events where id=$1`, [ev])).image_url !== null);
await blocked('non-admin editing an event', async () => { const r = await as(p1, 'authenticated', `update events set image_url='x' where id=$1 returning id`, [ev]); if (!r.rows.length) throw new Error('0 rows (RLS)'); });
await as(admin, 'authenticated', `insert into storage.objects(bucket_id,name) values ('event-photos',$1)`, [`${ev}/photo.jpg`]);
await blocked('non-admin uploading an event photo', () => as(p1, 'authenticated', `insert into storage.objects(bucket_id,name) values ('event-photos',$1)`, [`${ev}/x.jpg`]));
await blocked('anon uploading an event photo', () => as(null, 'anon', `insert into storage.objects(bucket_id,name) values ('event-photos',$1)`, [`${ev}/x.jpg`]));
ok('anyone can read event photos', (await as(null, 'anon', `select count(*)::int c from storage.objects where bucket_id='event-photos'`)).rows[0].c >= 1);

// ---- rankings & old behaviour still fine
await as(admin, 'authenticated', `update enrollments set points=100, final_place=1 where user_id=$1 and event_id=$2`, [p1, ev]);
ok('rankings view still works', (await as(null, 'anon', `select count(*)::int c from public_rankings`)).rows[0].c === 1);
ok('leaderboard exposes the player\'s photo', (await val(`select avatar_url from public_rankings where user_id=$1`, [p1])).avatar_url !== null);
ok('leaderboard exposes the player\'s profession', (await val(`select profession from public_rankings where user_id=$1`, [p1])).profession === 'Backgammon Enthusiast');
ok('old enroll functions are gone', (await val(`select count(*)::int c from pg_proc where proname in ('enroll_in_event','cancel_enrollment')`)).c === 0);

console.log(fails ? `\n${fails} FAILURES` : '\nall database tests passed');
process.exit(fails ? 1 : 0);
