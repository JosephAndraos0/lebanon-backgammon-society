# Tests

None of this is loaded by the website. Everything here runs on your own computer.

## 1. Bracket engine (no setup)

```
node tests/db/bracket.test.js
```

Plays every field size from 2 to 70 players through to a champion and checks byes, seeding, the
third-place match and the "can't edit a result that later rounds depend on" guard.

## 2. Database rules (Postgres in memory)

Runs `supabase/schema.sql` (fresh project) and baseline + `migrations/002_...sql` (upgrading the live
database) inside PGlite, a Postgres that runs in Node, then checks about 75 rules: who can read/write
what, profile validation, seat holds and expiry, orders, friend invites, claiming, late payments,
server-only functions.

One-time setup (creates a `node_modules` folder here, which git ignores):

```
cd tests
npm install @electric-sql/pglite
cd ..
node tests/db/schema.test.mjs migrate
node tests/db/schema.test.mjs fresh
```

Run both modes after any change to `supabase/schema.sql` or a migration.

## 3. The website itself (fake backend, in a browser)

`tests/ui/fake-supabase.js` stands in for Supabase so the real `index.html` + `js/app.js` can be driven
end to end without a database, without Stripe, and without real accounts. It mimics the v2 rules
(holds, orders, friend invites, claims); the real rules are what test 2 checks.

```
node tests/ui/build.js
python -m http.server 8744 --bind 127.0.0.1
```

Then open:

- `http://127.0.0.1:8744/tests/ui/index.html` - the site wired to the fake backend
- `http://127.0.0.1:8744/tests/ui/sample.html` - the site with no Supabase keys (sample-data mode)

`build.js` regenerates both pages from the real `index.html`, so re-run it if `index.html` changes.
The fake keeps its data in the browser's localStorage. In the browser console, `__fake` has the controls:
`__fake.pay(orderId)` (what Stripe's webhook does), `__fake.setHold(orderId, ms)`, `__fake.cfg.confirm = true`
(email-confirmation sign-up), `__fake.cfg.failCheckout = 1` (payment page fails to open), `__fake.reset()`.
Test accounts (fake, only exist inside the fake backend): `admin@test.com` and `p1@test.com`..`p6@test.com`,
password `password123`.

The fake "Stripe" address is a dead local https URL, so nothing ever contacts Stripe.
