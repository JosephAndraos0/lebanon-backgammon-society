/* Data layer. Everything the site reads or writes goes through here.
 * - "live" mode talks to Supabase (auth, database, edge functions).
 * - "sample" mode (no Supabase keys yet) serves read-only sample tournaments so the
 *   site still looks alive while you set things up. */
(function (root) {
  "use strict";
  var C = root.LBS_CONFIG, B = root.LBS_BRACKET, S = root.LBS_SAMPLE;
  var isLive = !!(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && root.supabase);
  var sb = isLive ? root.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;

  var FRIENDLY = {
    not_authenticated: "Please sign in first.",
    event_not_open: "This event isn't open for entry.",
    event_full: "Sorry, this event is full.",
    already_enrolled: "You're already enrolled in this event.",
    cannot_cancel: "This reservation can't be cancelled online. Contact us and we'll help.",
    need_two_players: "You need at least 2 paid players to build a bracket.",
    downstream_done: "That result can't be changed because the next round has already been played.",
    match_not_ready: "Both players must be known before entering a result.",
    invalid_winner: "The winner must be one of the two players.",
    "Invalid login credentials": "That email and password don't match.",
    "User already registered": "An account with this email already exists. Try signing in.",
    "Email not confirmed": "Please confirm your email first - check your inbox for our message."
  };

  function fail(e) {
    var raw = (e && (e.message || e.error_description)) || String(e);
    var key = Object.keys(FRIENDLY).filter(function (k) { return raw.indexOf(k) !== -1; })[0];
    var err = new Error(key ? FRIENDLY[key] : raw);
    err.code = key || "";
    throw err;
  }
  function unwrap(res) { if (res.error) fail(res.error); return res.data; }
  function needLive() {
    if (!isLive) throw new Error("Connect Supabase to enable this (see README.md, step 1).");
  }
  function uuid() {
    return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
        });
  }

  var api = {
    isLive: isLive,

    /* ------------------------------ auth ------------------------------ */
    getSession: async function () {
      if (!isLive) return null;
      return unwrap(await sb.auth.getSession()).session;
    },
    onAuthChange: function (cb) {
      if (!isLive) return;
      sb.auth.onAuthStateChange(function (event, session) { cb(event, session); });
    },
    signUp: async function (name, email, password) {
      needLive();
      var data = unwrap(await sb.auth.signUp({
        email: email, password: password,
        options: { data: { full_name: name }, emailRedirectTo: root.location.origin + root.location.pathname }
      }));
      // With email confirmation on, there is no session until the link is clicked.
      return { needsConfirmation: !data.session };
    },
    signIn: async function (email, password) {
      needLive();
      unwrap(await sb.auth.signInWithPassword({ email: email, password: password }));
    },
    signOut: async function () { if (isLive) await sb.auth.signOut(); },
    sendPasswordReset: async function (email) {
      needLive();
      unwrap(await sb.auth.resetPasswordForEmail(email, { redirectTo: root.location.origin + root.location.pathname }));
    },
    setPassword: async function (password) {
      needLive();
      unwrap(await sb.auth.updateUser({ password: password }));
    },
    getProfile: async function (userId) {
      needLive();
      return unwrap(await sb.from("profiles").select("*").eq("id", userId).single());
    },
    updateName: async function (userId, name) {
      needLive();
      unwrap(await sb.from("profiles").update({ full_name: name }).eq("id", userId));
    },

    /* ------------------------------ public reads ------------------------------ */
    listEvents: async function () {
      if (!isLive) return S.events.map(function (e) { return Object.assign({}, e); });
      var res = await Promise.all([
        sb.from("events").select("*").order("starts_at", { ascending: false }),
        sb.from("event_seats").select("*")
      ]);
      var events = unwrap(res[0]), seats = unwrap(res[1]), bySeats = {};
      seats.forEach(function (s) { bySeats[s.event_id] = s; });
      return events.map(function (e) {
        e.taken = bySeats[e.id] ? bySeats[e.id].taken : 0;
        e.paid = bySeats[e.id] ? bySeats[e.id].paid : 0;
        return e;
      });
    },
    eventDetail: async function (eventId) {
      if (!isLive) {
        var d = S.detail[eventId] || { players: [], matches: [] };
        return { players: d.players.slice(), matches: d.matches.map(function (m) { return Object.assign({}, m); }) };
      }
      var res = await Promise.all([
        sb.from("public_enrollments").select("*").eq("event_id", eventId),
        sb.from("matches").select("*").eq("event_id", eventId)
      ]);
      var enr = unwrap(res[0]), matches = unwrap(res[1]);
      var ids = enr.map(function (e) { return e.user_id; });
      var names = {};
      if (ids.length) {
        unwrap(await sb.from("public_profiles").select("id, full_name").in("id", ids))
          .forEach(function (p) { names[p.id] = p.full_name; });
      }
      var players = enr.map(function (e) {
        return { user_id: e.user_id, name: names[e.user_id] || "Player", status: e.status, seed: e.seed, final_place: e.final_place };
      });
      return { players: players, matches: matches };
    },
    rankings: async function () {
      if (!isLive) return S.rankings.slice();
      return unwrap(await sb.from("public_rankings").select("*").order("points", { ascending: false }).limit(50));
    },

    /* ------------------------------ enrolling ------------------------------ */
    myEnrollments: async function (userId) {
      if (!isLive) return [];
      return unwrap(await sb.from("enrollments").select("*").eq("user_id", userId));
    },
    enroll: async function (eventId) {
      needLive();
      return unwrap(await sb.rpc("enroll_in_event", { p_event_id: eventId }));
    },
    cancelEnrollment: async function (eventId) {
      needLive();
      unwrap(await sb.rpc("cancel_enrollment", { p_event_id: eventId }));
    },
    startCheckout: async function (eventId) {
      needLive();
      var res = await sb.functions.invoke("create-checkout", {
        body: { event_id: eventId, return_url: root.location.origin + root.location.pathname }
      });
      if (res.error) fail(res.error);
      if (!res.data || !res.data.url) throw new Error("Payment couldn't be started. Please try again or contact us.");
      return res.data.url;
    },

    /* ------------------------------ admin ------------------------------ */
    adminSaveEvent: async function (ev, id) {
      needLive();
      if (id) return unwrap(await sb.from("events").update(ev).eq("id", id).select().single());
      return unwrap(await sb.from("events").insert(ev).select().single());
    },
    adminDeleteEvent: async function (id) {
      needLive();
      unwrap(await sb.from("events").delete().eq("id", id));
    },
    adminSetEventStatus: async function (id, status) {
      needLive();
      unwrap(await sb.from("events").update({ status: status }).eq("id", id));
    },
    adminEnrollments: async function (eventId) {
      needLive();
      return unwrap(await sb.from("enrollments").select("*, profiles(full_name, email)")
        .eq("event_id", eventId).order("created_at", { ascending: true }));
    },
    adminSetEnrollmentStatus: async function (id, status) {
      needLive();
      unwrap(await sb.from("enrollments").update({
        status: status, paid_at: status === "paid" ? new Date().toISOString() : null
      }).eq("id", id));
    },

    // Seed paid players (best season points first, ties shuffled), build the bracket with
    // byes, save it and put the event live.
    adminGenerateBracket: async function (eventId) {
      needLive();
      var paid = unwrap(await sb.from("enrollments").select("id, user_id")
        .eq("event_id", eventId).eq("status", "paid"));
      if (paid.length < 2) fail(new Error("need_two_players"));
      var rk = unwrap(await sb.from("public_rankings").select("user_id, points"));
      var pts = {}; rk.forEach(function (r) { pts[r.user_id] = r.points; });
      paid.forEach(function (p) { p.tie = Math.random(); });
      paid.sort(function (a, b) { return (pts[b.user_id] || 0) - (pts[a.user_id] || 0) || a.tie - b.tie; });

      var matches = B.generate(paid.map(function (p) { return p.user_id; }), uuid)
        .map(function (m) { m.event_id = eventId; return m; });

      unwrap(await sb.from("matches").delete().eq("event_id", eventId));
      unwrap(await sb.from("matches").insert(matches));
      (await Promise.all(paid.map(function (p, i) {
        return sb.from("enrollments").update({ seed: i + 1, final_place: null, points: null }).eq("id", p.id);
      }))).forEach(unwrap);
      unwrap(await sb.from("events").update({ status: "live" }).eq("id", eventId));
      return matches;
    },
    adminResetBracket: async function (eventId) {
      needLive();
      unwrap(await sb.from("matches").delete().eq("event_id", eventId));
      unwrap(await sb.from("enrollments").update({ seed: null, final_place: null, points: null }).eq("event_id", eventId));
      unwrap(await sb.from("events").update({ status: "open" }).eq("id", eventId));
    },
    adminSaveResult: async function (matches, matchId, result) {
      needLive();
      var out = B.applyResult(matches, matchId, result);   // throws friendly errors
      unwrap(await sb.from("matches").upsert(out.changed, { onConflict: "id" }));
      return out.matches;
    },
    adminSetMatchLive: async function (matchId, isLiveNow) {
      needLive();
      unwrap(await sb.from("matches").update({ status: isLiveNow ? "live" : "pending" }).eq("id", matchId));
    },
    adminUpdateLiveScore: async function (matchId, a, b) {
      needLive();
      unwrap(await sb.from("matches").update({ score_a: a, score_b: b }).eq("id", matchId));
    },
    adminFinishEvent: async function (eventId, matches) {
      needLive();
      var st = B.finalStandings(matches);
      if (!st) throw new Error("Finish the final (and the third-place match) first.");
      (await Promise.all(Object.keys(st).map(function (uid) {
        return sb.from("enrollments").update({ final_place: st[uid].place, points: st[uid].points })
          .eq("event_id", eventId).eq("user_id", uid);
      }))).forEach(unwrap);
      unwrap(await sb.from("events").update({ status: "completed" }).eq("id", eventId));
    }
  };

  root.LBS_API = api;
})(window);
