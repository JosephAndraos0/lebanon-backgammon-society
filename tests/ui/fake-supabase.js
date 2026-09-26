/* Test-only stand-in for supabase-js, so the whole UI can be exercised in a browser with no backend.
 * It mirrors the v2 rules (holds, orders, friend invites, claims) closely enough to drive the UI;
 * the REAL database rules are tested separately against Postgres (see tests/README.md).
 * State lives in localStorage so page reloads (Stripe returns, email-confirmation links) behave like the real thing.
 * Controls for the tests are on window.__fake. Never load this on the live site. */
(function (root) {
  "use strict";
  var KEY = "lbs_fake_db";
  var db, users, session = null, listeners = [];
  var cfg = { confirm: false, failCheckout: 0, latency: 0 };
  var emails = [], uploads = {}, calls = [];

  function uid() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }); }
  function iso(ms) { return new Date(ms).toISOString(); }
  function pick(o, keys) { var r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function err(message) { var e = new Error(message); e.message = message; return e; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ db: db, users: users, session: session, cfg: cfg })); } catch (e) { /* ignore */ } }

  /* ------------------------------------------------------------ seed data */
  function profile(email, first, last, extra) {
    var p = { id: uid(), email: email, first_name: first, last_name: last, full_name: first + " " + last, is_admin: false,
      phone: "+96170123456", avatar_url: root.location.origin + "/tests/ui/av.svg", skill_level: 3, marketing_opt_in: true,
      onboarded_at: iso(Date.now() - 864e5), created_at: iso(Date.now() - 864e5) };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    db.profiles.push(p); users.push({ id: p.id, email: email, password: "password123" });
    return p;
  }
  function seed() {
    db = { profiles: [], events: [], enrollments: [], orders: [], seat_invites: [], matches: [] };
    users = [];
    var admin = profile("admin@test.com", "Ada", "Admin", { is_admin: true });
    var names = [["Rami", "Haddad"], ["Nour", "Khoury"], ["Karim", "Saad"], ["Layla", "Nasr"], ["Omar", "Fares"], ["Maya", "Aoun"]];
    var ps = names.map(function (n, i) { return profile("p" + (i + 1) + "@test.com", n[0], n[1], i === 5 ? { avatar_url: null } : {}); });
    function ev(slug, name, status, fee, max, extra) {
      var e = { id: uid(), slug: slug, name: name, venue: "Backroom Lounge, Hamra", starts_at: iso(Date.now() + 7 * 864e5), entry_fee: fee, currency: "USD",
        max_players: max, description: "Test event " + name, status: status, prizes: [200, 120, 80], created_at: iso(Date.now()) };
      Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
      db.events.push(e); return e;
    }
    var cup = ev("test-cup", "Test Cup", "open", 25, 8);
    var free = ev("free-night", "Free Night", "open", 0, 6);
    var live = ev("live-cup", "Live Cup", "live", 25, 8);
    var full = ev("full-cup", "Full Cup", "open", 25, 2);
    ev("past-cup", "Past Cup", "completed", 25, 8, { starts_at: iso(Date.now() - 20 * 864e5) });
    ev("draft-cup", "Draft Cup", "draft", 25, 8);
    function paid(e, p, extra) {
      var r = { id: uid(), event_id: e.id, user_id: p.id, status: "paid", paid_at: iso(Date.now()), seed: null, final_place: null, points: null, order_id: null, hold_expires_at: null, created_at: iso(Date.now()) };
      Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
      db.enrollments.push(r); return r;
    }
    paid(cup, ps[0]); paid(cup, ps[1]); paid(cup, ps[5]);
    paid(full, ps[0]); paid(full, ps[1]);
    // a live bracket of 6 (byes for the top 2 seeds)
    var B = root.LBS_BRACKET;
    ps.forEach(function (p, i) { paid(live, p, { seed: i + 1 }); });
    B.generate(ps.map(function (p) { return p.id; }), uid).forEach(function (m) { m.event_id = live.id; db.matches.push(m); });
    return admin;
  }

  /* ------------------------------------------------------------ rules (ported from the SQL) */
  function me() { return session ? session.user.id : null; }
  function prof(id) { return db.profiles.filter(function (p) { return p.id === id; })[0]; }
  function isAdmin() { var p = prof(me()); return !!(p && p.is_admin); }
  function evById(id) { return db.events.filter(function (e) { return e.id === id; })[0]; }
  function holdLive(iso_) { return iso_ && new Date(iso_).getTime() > Date.now(); }
  function seatsTaken(eid) {
    var n = db.enrollments.filter(function (e) { return e.event_id === eid && (e.status === "paid" || (e.status === "pending_payment" && holdLive(e.hold_expires_at))); }).length;
    db.seat_invites.forEach(function (i) {
      if (i.event_id !== eid) return;
      var o = db.orders.filter(function (x) { return x.id === i.order_id; })[0];
      if (i.status === "ready" || (i.status === "pending" && o && o.status === "pending" && holdLive(o.hold_expires_at))) n++;
    });
    return n;
  }
  function markOrderPaid(orderId) {
    var o = db.orders.filter(function (x) { return x.id === orderId; })[0];
    if (!o) throw err("order_not_found");
    if (o.status === "paid") return;
    var ev = evById(o.event_id), was = o.status;
    if (was === "cancelled" && !(ev.status === "open" && seatsTaken(o.event_id) + o.seats <= ev.max_players)) { o.status = "paid"; o.paid_at = iso(Date.now()); o.needs_review = true; return; }
    o.status = "paid"; o.paid_at = iso(Date.now());
    var from = was === "pending" ? "pending_payment" : "cancelled";
    db.enrollments.forEach(function (e) { if (e.order_id === o.id && e.status === from) { e.status = "paid"; e.paid_at = iso(Date.now()); e.hold_expires_at = null; } });
    db.seat_invites.forEach(function (i) { if (i.order_id === o.id && i.status === (was === "pending" ? "pending" : "cancelled")) i.status = "ready"; });
  }
  var RPC = {
    save_profile: function (a) {
      if (!me()) throw err("not_authenticated");
      var f = (a.p_first || "").trim(), l = (a.p_last || "").trim(), ph = (a.p_phone || "").trim().replace(/[^0-9+]/g, "");
      if (!f || !l) throw err("name_required");
      if (!/^\+?[0-9]{7,15}$/.test(ph)) throw err("phone_invalid");
      if (!a.p_skill || a.p_skill < 1 || a.p_skill > 5) throw err("skill_invalid");
      if (a.p_marketing == null) throw err("marketing_required");
      if (a.p_avatar_url && a.p_avatar_url.indexOf("/storage/v1/object/public/avatars/" + me() + "/") === -1) throw err("avatar_invalid");
      var p = prof(me()), av = a.p_avatar_url || p.avatar_url;
      if (!av) throw err("photo_required");
      p.first_name = f; p.last_name = l; p.full_name = f + " " + l; p.phone = ph; p.skill_level = a.p_skill; p.marketing_opt_in = a.p_marketing; p.avatar_url = av;
      p.onboarded_at = p.onboarded_at || iso(Date.now());
      return clone(p);
    },
    create_order: function (a) {
      if (!me()) throw err("not_authenticated");
      var p = prof(me()); if (!p.onboarded_at) throw err("profile_incomplete");
      var ev = evById(a.p_event_id); if (!ev || ev.status !== "open") throw err("event_not_open");
      var friends = a.p_friends || [];
      if (friends.length > 8) throw err("too_many_friends");
      var n = (a.p_include_self ? 1 : 0) + friends.length; if (n < 1) throw err("no_seats");
      var seen = [];
      friends.forEach(function (f) {
        var em = String(f.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw err("friend_email_invalid");
        if (em === p.email.toLowerCase()) throw err("friend_is_you");
        if (seen.indexOf(em) !== -1) throw err("friend_duplicate");
        seen.push(em);
      });
      if (a.p_include_self && db.enrollments.some(function (e) { return e.event_id === ev.id && e.user_id === me() && e.status === "paid"; })) throw err("already_enrolled");
      db.orders.forEach(function (o) { if (o.buyer_id === me() && o.event_id === ev.id && o.status === "pending") o.status = "cancelled"; });
      db.seat_invites.forEach(function (i) { if (i.inviter_id === me() && i.event_id === ev.id && i.status === "pending") i.status = "cancelled"; });
      db.enrollments.forEach(function (e) { if (e.user_id === me() && e.event_id === ev.id && e.status === "pending_payment") { e.status = "cancelled"; e.hold_expires_at = null; } });
      if (seatsTaken(ev.id) + n > ev.max_players) throw err("event_full");
      var o = { id: uid(), event_id: ev.id, buyer_id: me(), seats: n, amount: ev.entry_fee * n, currency: ev.currency, status: "pending", stripe_session_id: null, needs_review: false,
        hold_expires_at: iso(Date.now() + 35 * 60000), paid_at: null, created_at: iso(Date.now()) };
      db.orders.push(o);
      if (a.p_include_self) {
        var ex = db.enrollments.filter(function (e) { return e.event_id === ev.id && e.user_id === me(); })[0];
        if (ex) { ex.status = "pending_payment"; ex.order_id = o.id; ex.hold_expires_at = o.hold_expires_at; ex.paid_at = null; }
        else db.enrollments.push({ id: uid(), event_id: ev.id, user_id: me(), status: "pending_payment", paid_at: null, seed: null, final_place: null, points: null, order_id: o.id, hold_expires_at: o.hold_expires_at, created_at: iso(Date.now()) });
      }
      friends.forEach(function (f) {
        db.seat_invites.push({ id: uid(), order_id: o.id, event_id: ev.id, inviter_id: me(), email: String(f.email).trim().toLowerCase(), name: (f.name || "").trim() || null,
          token: uid().replace(/-/g, "") + uid().replace(/-/g, ""), status: "pending", claimed_by: null, claimed_at: null, emailed_at: null, created_at: iso(Date.now()) });
      });
      if (o.amount === 0) markOrderPaid(o.id);
      return clone(o);
    },
    cancel_order: function (a) {
      if (!me()) throw err("not_authenticated");
      var o = db.orders.filter(function (x) { return x.id === a.p_order_id && x.buyer_id === me(); })[0];
      if (!o || o.status !== "pending") throw err("cannot_cancel");
      o.status = "cancelled";
      db.enrollments.forEach(function (e) { if (e.order_id === o.id && e.status === "pending_payment") { e.status = "cancelled"; e.hold_expires_at = null; } });
      db.seat_invites.forEach(function (i) { if (i.order_id === o.id && i.status === "pending") i.status = "cancelled"; });
      return null;
    },
    get_invite: function (a) {
      return db.seat_invites.filter(function (i) { return i.token === a.p_token; }).map(function (i) {
        var ev = evById(i.event_id);
        return { status: i.status, event_name: ev.name, event_slug: ev.slug, venue: ev.venue, starts_at: ev.starts_at, event_status: ev.status, inviter_name: prof(i.inviter_id).full_name };
      });
    },
    claim_invite: function (a) {
      if (!me()) throw err("not_authenticated");
      var p = prof(me()); if (!p.onboarded_at) throw err("profile_incomplete");
      var i = db.seat_invites.filter(function (x) { return x.token === a.p_token; })[0];
      if (!i) throw err("invite_invalid");
      if (i.status === "claimed") throw err("invite_claimed");
      if (i.status !== "ready") throw err("invite_not_ready");
      if (evById(i.event_id).status !== "open") throw err("event_not_open");
      if (db.enrollments.some(function (e) { return e.event_id === i.event_id && e.user_id === me() && e.status === "paid"; })) throw err("already_enrolled");
      var ex = db.enrollments.filter(function (e) { return e.event_id === i.event_id && e.user_id === me(); })[0], r;
      if (ex) { ex.status = "paid"; ex.paid_at = iso(Date.now()); ex.order_id = i.order_id; ex.hold_expires_at = null; r = ex; }
      else { r = { id: uid(), event_id: i.event_id, user_id: me(), status: "paid", paid_at: iso(Date.now()), seed: null, final_place: null, points: null, order_id: i.order_id, hold_expires_at: null, created_at: iso(Date.now()) }; db.enrollments.push(r); }
      i.status = "claimed"; i.claimed_by = me(); i.claimed_at = iso(Date.now());
      return clone(r);
    },
    admin_mark_order_paid: function (a) { if (!isAdmin()) throw err("not_admin"); markOrderPaid(a.p_order_id); return null; },
    admin_cancel_invite: function (a) {
      if (!isAdmin()) throw err("not_admin");
      db.seat_invites.forEach(function (i) { if (i.id === a.p_invite_id && (i.status === "pending" || i.status === "ready")) i.status = "cancelled"; });
      return null;
    }
  };

  /* ------------------------------------------------------------ tables & views (with the row-level rules) */
  function rows(t) {
    var m = me();
    if (t === "events") return db.events.filter(function (e) { return e.status !== "draft" || isAdmin(); });
    if (t === "event_seats") return db.events.map(function (e) { return { event_id: e.id, taken: seatsTaken(e.id), paid: db.enrollments.filter(function (x) { return x.event_id === e.id && x.status === "paid"; }).length }; });
    if (t === "public_enrollments") return db.enrollments.filter(function (e) { return e.status === "paid"; }).map(function (e) { return pick(e, ["event_id", "user_id", "status", "seed", "final_place"]); });
    if (t === "public_profiles") return db.profiles.map(function (p) { return pick(p, ["id", "full_name", "avatar_url"]); });
    if (t === "public_rankings") return [];
    if (t === "profiles") return db.profiles.filter(function (p) { return p.id === m || isAdmin(); });
    if (t === "enrollments") return db.enrollments.filter(function (e) { return e.user_id === m || isAdmin(); });
    if (t === "orders") return db.orders.filter(function (o) { return o.buyer_id === m || isAdmin(); });
    if (t === "seat_invites") return db.seat_invites.filter(function (i) { return i.inviter_id === m || i.claimed_by === m || isAdmin(); });
    if (t === "matches") return db.matches;
    throw err("unknown table " + t);
  }
  var FK = { enrollments: { profiles: "user_id" }, orders: { profiles: "buyer_id" }, seat_invites: { inviter: "inviter_id", claimer: "claimed_by" } };

  function splitTop(s) { var out = [], d = 0, cur = ""; for (var i = 0; i < s.length; i++) { var c = s[i]; if (c === "(") d++; if (c === ")") d--; if (c === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += c; } if (cur.trim()) out.push(cur.trim()); return out; }
  function embed(t, list, cols) {
    if (!cols || cols === "*") return list;
    var embeds = splitTop(cols).filter(function (x) { return x.indexOf("(") !== -1; });
    if (!embeds.length) return list;
    return list.map(function (r) {
      var o = clone(r);
      embeds.forEach(function (tok) {
        var m = tok.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/), alias = m[1] || m[2], fkName = m[3] || "";
        var col = FK[t] && (FK[t][alias] || FK[t][m[2]]);
        if (t === "seat_invites" && fkName) col = /claimed_by/.test(fkName) ? "claimed_by" : "inviter_id";
        if (!col && m[2] === "events") { o[alias] = evById(r.event_id); return; }
        var target = prof(r[col]);
        o[alias] = target ? clone(target) : null;
      });
      return o;
    });
  }

  function Q(t) { this.t = t; this.f = []; this.op = "select"; this.cols = "*"; this.ord = null; this.lim = null; this.mode = null; this.payload = null; this.opts = null; this.ret = false; }
  Q.prototype.select = function (c) { if (this.op === "select") this.cols = c || "*"; else this.ret = true; return this; };
  Q.prototype.eq = function (k, v) { this.f.push(function (r) { return r[k] === v; }); return this; };
  Q.prototype.neq = function (k, v) { this.f.push(function (r) { return r[k] !== v; }); return this; };
  Q.prototype.in = function (k, arr) { this.f.push(function (r) { return arr.indexOf(r[k]) !== -1; }); return this; };
  Q.prototype.gt = function (k, v) { this.f.push(function (r) { return r[k] != null && new Date(r[k]).getTime() > new Date(v).getTime(); }); return this; };
  Q.prototype.is = function (k, v) { this.f.push(function (r) { return r[k] === v || (v === null && r[k] == null); }); return this; };
  Q.prototype.not = function (k, op, v) { this.f.push(function (r) { return !(v === null ? r[k] == null : r[k] === v); }); return this; };
  Q.prototype.order = function (k, o) { this.ord = { k: k, asc: !o || o.ascending !== false }; return this; };
  Q.prototype.limit = function (n) { this.lim = n; return this; };
  Q.prototype.single = function () { this.mode = "single"; return this; };
  Q.prototype.maybeSingle = function () { this.mode = "maybe"; return this; };
  Q.prototype.insert = function (p) { this.op = "insert"; this.payload = p; return this; };
  Q.prototype.update = function (p) { this.op = "update"; this.payload = p; return this; };
  Q.prototype.upsert = function (p, o) { this.op = "upsert"; this.payload = p; this.opts = o; return this; };
  Q.prototype.delete = function () { this.op = "delete"; return this; };
  Q.prototype.exec = function () {
    var t = this.t, self = this, out;
    function match(r) { return self.f.every(function (fn) { return fn(r); }); }
    if (this.op !== "select") {
      var writable = { events: 1, matches: 1, enrollments: 1 };
      if (!writable[t] || !isAdmin()) throw err("permission denied for table " + t + " (or new row violates row-level security policy)");
      var arr = db[t], touched = [];
      if (this.op === "insert") { [].concat(this.payload).forEach(function (r) { var n = Object.assign({ id: uid(), created_at: iso(Date.now()) }, r); if (t === "events" && arr.some(function (x) { return x.slug === n.slug; })) throw err('duplicate key value violates unique constraint "events_slug_key"'); arr.push(n); touched.push(n); }); }
      if (this.op === "update") arr.forEach(function (r) { if (match(r)) { Object.assign(r, self.payload); touched.push(r); } });
      if (this.op === "delete") { db[t] = arr.filter(function (r) { if (match(r)) { touched.push(r); return false; } return true; }); if (t === "events") { db.enrollments = db.enrollments.filter(function (e) { return e.event_id !== touched[0].id; }); db.matches = db.matches.filter(function (m) { return m.event_id !== touched[0].id; }); } }
      if (this.op === "upsert") [].concat(this.payload).forEach(function (r) { var ex = arr.filter(function (x) { return x.id === r.id; })[0]; if (ex) Object.assign(ex, r); else arr.push(r); touched.push(r); });
      out = touched;
    } else {
      out = embed(t, rows(t).filter(match), this.cols);
      if (this.ord) { var k = this.ord.k, asc = this.ord.asc; out = out.slice().sort(function (a, b) { return (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1); }); }
      if (this.lim != null) out = out.slice(0, this.lim);
    }
    out = clone(out);
    if (this.mode === "single") { if (out.length !== 1) throw err("JSON object requested, multiple (or no) rows returned"); return out[0]; }
    if (this.mode === "maybe") { if (out.length > 1) throw err("multiple rows returned"); return out[0] || null; }
    return out;
  };
  Q.prototype.then = function (resolve, reject) {
    var self = this;
    return new Promise(function (res) {
      setTimeout(function () {
        var r;
        try { calls.push(self.op + " " + self.t); r = { data: self.exec(), error: null }; save(); } catch (e) { r = { data: null, error: { message: e.message } }; }
        res(r);
      }, cfg.latency);
    }).then(resolve, reject);
  };

  /* ------------------------------------------------------------ the client */
  function emit(event) { setTimeout(function () { listeners.forEach(function (cb) { cb(event, session); }); }, 0); }
  function mkSession(u) { return { access_token: "fake." + u.id, user: { id: u.id, email: u.email } }; }
  var client = {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
      onAuthStateChange: function (cb) {
        listeners.push(cb);
        emit("INITIAL_SESSION");
        if (/access_token/.test(root.location.hash) && session) emit("SIGNED_IN");
        return { data: { subscription: { unsubscribe: function () {} } } };
      },
      signUp: function (a) {
        return new Promise(function (res) {
          setTimeout(function () {
            if (users.some(function (u) { return u.email === a.email; })) return res({ data: null, error: { message: "User already registered" } });
            var md = (a.options && a.options.data) || {};
            var p = profile(a.email, md.first_name || "", md.last_name || "", { phone: null, avatar_url: null, skill_level: null, marketing_opt_in: null, onboarded_at: null });
            users[users.length - 1].password = a.password;
            calls.push("signUp " + a.email);
            if (cfg.confirm) { emails.push({ to: a.email, kind: "confirm" }); save(); return res({ data: { user: { id: p.id }, session: null }, error: null }); }
            var u = users[users.length - 1]; session = mkSession(u); save(); emit("SIGNED_IN");
            res({ data: { user: session.user, session: session }, error: null });
          }, cfg.latency);
        });
      },
      signInWithPassword: function (a) {
        return new Promise(function (res) {
          setTimeout(function () {
            var u = users.filter(function (x) { return x.email === a.email && x.password === a.password; })[0];
            if (!u) return res({ data: null, error: { message: "Invalid login credentials" } });
            session = mkSession(u); save(); emit("SIGNED_IN");
            res({ data: { user: session.user, session: session }, error: null });
          }, cfg.latency);
        });
      },
      signOut: function () { session = null; save(); emit("SIGNED_OUT"); return Promise.resolve({ error: null }); },
      resetPasswordForEmail: function (email) { emails.push({ to: email, kind: "reset" }); return Promise.resolve({ data: {}, error: null }); },
      updateUser: function () { return Promise.resolve({ data: {}, error: null }); }
    },
    from: function (t) { return new Q(t); },
    rpc: function (name, args) {
      return new Promise(function (res) {
        setTimeout(function () {
          try { calls.push("rpc " + name); var r = RPC[name](args || {}); save(); res({ data: r, error: null }); } catch (e) { res({ data: null, error: { message: e.message } }); }
        }, cfg.latency);
      });
    },
    storage: {
      from: function () {
        return {
          upload: function (path, blob) { uploads[path] = { size: blob.size, type: blob.type }; calls.push("upload " + path); return Promise.resolve({ data: { path: path }, error: null }); },
          getPublicUrl: function (path) { return { data: { publicUrl: root.location.origin + "/tests/ui/av.svg?src=/storage/v1/object/public/avatars/" + path } }; }
        };
      }
    },
    functions: {
      invoke: function (name, opts) {
        function fail(msg) { return { data: null, error: { context: { json: function () { return Promise.resolve({ error: msg }); } } } }; }
        return new Promise(function (res) {
          setTimeout(function () {
            calls.push("fn " + name);
            var b = (opts && opts.body) || {};
            if (!me()) return res(fail("Please sign in first."));
            var o = db.orders.filter(function (x) { return x.id === b.order_id; })[0];
            if (name === "create-checkout") {
              if (cfg.failCheckout > 0) { cfg.failCheckout--; return res(fail("Payment provider error.")); }
              if (!o || o.buyer_id !== me()) return res(fail("We couldn't find that order."));
              if (o.status === "paid") return res({ data: { paid: true }, error: null });
              if (o.status !== "pending") return res(fail("This order is no longer active. Please start again."));
              if (new Date(o.hold_expires_at).getTime() < Date.now() + 60000) return res(fail("Your seat hold expired. Please start again."));
              o.stripe_session_id = "cs_fake_" + o.id; save();
              // A dead local https address: the app must accept it (https only) and "leave" the page, without touching Stripe.
              return res({ data: { url: "https://127.0.0.1:8744/fake-stripe/" + o.id }, error: null });
            }
            if (name === "send-invites") {
              if (!o) return res(fail("Order not found."));
              if (o.buyer_id !== me() && !isAdmin()) return res(fail("Not allowed."));
              if (o.status !== "paid") return res(fail("This order isn't paid yet."));
              var sent = 0;
              db.seat_invites.forEach(function (i) {
                if (i.order_id !== o.id || i.status !== "ready") return;
                if (b.invite_id ? i.id !== b.invite_id : i.emailed_at) return;
                i.emailed_at = iso(Date.now()); sent++; emails.push({ to: i.email, kind: "invite", token: i.token });
              });
              save(); return res({ data: { sent: sent, failed: 0 }, error: null });
            }
            res(fail("unknown function"));
          }, cfg.latency);
        });
      }
    }
  };

  /* ------------------------------------------------------------ test controls */
  root.__fake = {
    cfg: cfg, emails: emails, uploads: uploads, calls: calls,
    db: function () { return db; },
    reset: function () { localStorage.removeItem(KEY); },
    // Stripe's webhook arriving: the ONLY thing that turns an order paid (besides an admin).
    pay: function (orderId) { markOrderPaid(orderId); save(); },
    setHold: function (orderId, ms) { var o = db.orders.filter(function (x) { return x.id === orderId; })[0]; o.hold_expires_at = iso(Date.now() + ms); db.enrollments.forEach(function (e) { if (e.order_id === o.id && e.status === "pending_payment") e.hold_expires_at = o.hold_expires_at; }); save(); },
    confirmEmail: function (email) { var u = users.filter(function (x) { return x.email === email; })[0]; session = mkSession(u); save(); },
    signOutQuiet: function () { session = null; save(); }
  };

  root.supabase = { createClient: function () { return client; } };
  var raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  if (raw) { var o = JSON.parse(raw); db = o.db; users = o.users; session = o.session; if (o.cfg) Object.keys(o.cfg).forEach(function (k) { cfg[k] = o.cfg[k]; }); }
  else { root.addEventListener("DOMContentLoaded", function () {}); }
  // The bracket engine loads after this file, so seeding waits until the app first asks for the client.
  var realCreate = root.supabase.createClient;
  root.supabase.createClient = function () { if (!db) { seed(); save(); } return realCreate.apply(this, arguments); };
})(window);
