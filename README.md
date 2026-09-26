# Lebanon Backgammon Society

Tournament site: accounts, event enrollment, brackets with byes, results, rankings, and an organizer dashboard.
Plain HTML/CSS/JS on the front end (no build step) + [Supabase](https://supabase.com) for the database and logins.

```
index.html            the page (all screens live here)
styles.css            design
js/config.js          YOUR settings - Supabase keys, payments switch
js/bracket.js         seeding + byes + bracket engine (pure functions)
js/api.js             every database / login call
js/app.js             screens, routing, admin dashboard
js/sample-data.js     demo tournaments shown until Supabase is connected
supabase/schema.sql   database tables + security rules
supabase/functions/   Stripe payment functions (optional, step 6)
```

Until you finish step 1 the site runs in **sample mode** (fake tournaments, read-only) so you can see it and style it.

---

## 1. Create the database (free, ~5 min)

1. Sign up at supabase.com -> **New project**. Pick a region near Lebanon (e.g. Frankfurt / Paris) and save the database password.
2. **Project Settings -> API**: copy the **Project URL** and the **anon public** key into `js/config.js`.
   (The anon key is meant to be public. Never paste the `service_role` key anywhere in this site.)
3. **SQL Editor -> New query**: paste all of `supabase/schema.sql` and press **Run**.
4. **Authentication -> URL Configuration**: set *Site URL* to `https://lebanonbackgammonsociety.com` and add these *Redirect URLs*:
   `https://lebanonbackgammonsociety.com`, `http://localhost:8744`.
5. **Authentication -> Providers -> Email**: keep "Confirm email" **on** (players click a link to verify).
   Supabase's built-in email sender only allows a handful of emails per hour - before launch, add your own sender under
   **Project Settings -> Authentication -> SMTP** (Resend, Brevo, Mailgun... all have free tiers).

## 2. Try it on your computer

```bash
python -m http.server 8744
```

Open http://localhost:8744 (opening `index.html` by double-click also works, but email links need the server).

## 3. Make yourself the admin

Sign up on your own site, then in Supabase **SQL Editor** run (with your email):

```sql
update public.profiles set is_admin = true where email = 'you@example.com';
```

Refresh the site: an **Admin** link appears.

## 4. Run a tournament

1. **Admin -> New event.** Name, venue, date, entry fee, max players, prize split. Save it as *draft*, then **Publish** (status *open*).
2. Players create accounts and hit **Enroll**. They get a reserved seat (status "awaiting payment").
3. When someone pays you, open the event in Admin and press **Mark paid**. (With online payments on, this happens automatically.)
4. **Close entry & build bracket.** Paid players are seeded (best season points first, ties shuffled). If the number isn't a power of two,
   the top seeds get **byes** automatically - 20 players = 12 byes into a 32-slot bracket, 11 players = 5 byes, etc.
5. Enter each match's final score under **Bracket & results** - the higher score wins and advances (semifinal losers play a third-place match).
   "Mark live" shows a match as in progress on the public bracket.
6. **Finish event & award points.** Places 1-4 get 100/60/35/25 points, earlier exits 15/8/4 - the Society rankings on the home page update.

Prizes are fixed dollar amounts you set per event for 1st, 2nd and 3rd place (they're shown on the event page and cards).

## 5. Put it online on lebanonbackgammonsociety.com

It's a static site, so any static host works. **Cloudflare Pages** (free) is the easiest:

1. Cloudflare -> Workers & Pages -> Create -> Pages -> **Upload assets**. Drag in this folder (skip `_test` if it exists). Deploy.
2. In the project: **Custom domains -> Set up** `lebanonbackgammonsociety.com`. Cloudflare will give you two **nameservers**.
3. In **Porkbun** -> Domain Management -> your domain -> **Authoritative Nameservers**: replace Porkbun's with Cloudflare's two. Wait for it to activate (minutes to a few hours). HTTPS is automatic.
4. For the `hello@` email: Cloudflare **Email Routing** (free) can forward it to your Gmail, or use Porkbun email hosting.

(Netlify also works: add the domain there, then in Porkbun DNS create an **ALIAS** record `@` -> `apex-loadbalancer.netlify.com` and a **CNAME** `www` -> your `*.netlify.app` address.)

Every time you edit files, re-upload the folder (or connect a GitHub repo to Cloudflare Pages for automatic deploys).

## 6. Online card payments (optional)

**Read this first:** Stripe does not open merchant accounts for businesses based in Lebanon. You have three realistic options:
(a) keep collecting entry fees in cash / Whish / OMT / bank transfer and press **Mark paid** (works today, zero setup);
(b) have a Stripe account through a company registered in a supported country (e.g. Stripe Atlas);
(c) use a gateway available to you locally - only the two functions in `supabase/functions` are provider-specific, so switching provider means rewriting those two files.

If you do have Stripe:

```bash
npm i -g supabase && supabase login && supabase link --project-ref <your-project-ref>
supabase secrets set STRIPE_SECRET_KEY=sk_live_... SITE_URL=https://lebanonbackgammonsociety.com
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
```

Then in Stripe -> Developers -> Webhooks add `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` for the event
`checkout.session.completed`, copy its signing secret and run `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...`.
Finally set `PAYMENTS_ENABLED: true` in `js/config.js`. Test with Stripe test keys and card `4242 4242 4242 4242` first.
If the site says payments aren't configured, the secrets aren't set yet - players can still reserve a seat and you can mark them paid.

## Notes

- **Security:** all permissions live in the database (`schema.sql`, Row Level Security). Players can only read their own enrollment rows,
  cannot mark themselves paid, cannot become admin, and cannot write brackets - even if someone tampers with the site's JavaScript.
- Free Supabase projects pause after 7 days without activity; open the dashboard to wake it (or upgrade before a busy season).
- Players' full names are public (bracket, players list, rankings). Emails are private (visible to admins only).
- Times are shown in `Asia/Beirut` (change `TIMEZONE` in `js/config.js`).
