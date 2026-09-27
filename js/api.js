/* Data layer. Everything the site reads or writes goes through here.
 * - "live" mode talks to Supabase (auth, database, storage, edge functions).
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
    profile_incomplete: "Please finish your profile first (name, phone and photo).",
    event_not_open: "This tournament isn't open for entry.",
    event_full: "Sorry, there aren't enough seats left.",
    already_enrolled: "You already have a seat in this tournament.",
    cannot_cancel: "This order can't be cancelled online. Contact us and we'll help.",
    no_seats: "Choose at least one seat.",
    too_many_friends: "You can invite up to 8 friends at a time.",
    friend_email_invalid: "One of the friend email addresses doesn't look right.",
    friend_is_you: "That's your own email. Use the \"Also pay for myself\" box instead.",
    friend_duplicate: "You entered the same friend email twice.",
    invite_invalid: "This invite link isn't valid.",
    invite_claimed: "This seat has already been claimed.",
    invite_not_ready: "This seat isn't ready yet. The payment hasn't been confirmed.",
    name_required: "Please enter your first and last name.",
    name_too_long: "That name is too long.",
    phone_invalid: "Enter a valid phone number, with country code (e.g. +961 70 123 456).",
    skill_invalid: "Pick your skill level.",
    marketing_required: "Please answer the updates question.",
    photo_required: "Please add a photo so other players know who you are.",
    avatar_invalid: "That photo couldn't be used. Please try another.",
    need_two_players: "You need at least 2 paid players to build a bracket.",
    downstream_done: "That result can't be changed because the next round has already been played.",
    match_not_ready: "Both players must be known before entering a result.",
    invalid_winner: "The winner must be one of the two players.",
    "Invalid login credentials": "That email and password don't match.",
    "User already registered": "An account with this email already exists. Try signing in.",
    "Email not confirmed": "Please confirm your email first. Check your inbox for our message."
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
  // supabase-js functions.invoke: non-2xx responses come back as an error whose body holds our message.
  async function fnError(res) {
    var msg = "";
    try { var b = await res.error.context.json(); msg = b && b.error; } catch (e) { /* ignore */ }
    var err = new Error(msg || "Something went wrong. Please try again.");
    throw err;
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
    signUp: async function (first, last, email, password) {
      needLive();
      var data = unwrap(await sb.auth.signUp({
        email: email, password: password,
        options: { data: { first_name: first, last_name: last, full_name: first + " " + last },
                   emailRedirectTo: root.location.origin + root.location.pathname }
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

    /* ------------------------------ profile ------------------------------ */
    getProfile: async function (userId) {
      needLive();
      return unwrap(await sb.from("profiles").select("*").eq("id", userId).single());
    },
    // Photo: already cropped to a square JPEG blob by the page.
    uploadAvatar: async function (userId, blob) {
      needLive();
      var path = userId + "/avatar.jpg";
      unwrap(await sb.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" }));
      return sb.storage.from("avatars").getPublicUrl(path).data.publicUrl + "?v=" + Date.now();
    },
    saveProfile: async function (p) {
      needLive();
      return unwrap(await sb.rpc("save_profile", {
        p_first: p.first, p_last: p.last, p_phone: p.phone, p_skill: p.skill,
        p_marketing: p.marketing, p_avatar_url: p.avatarUrl || null
      }));
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
      var people = {};
      if (ids.length) {
        unwrap(await sb.from("public_profiles").select("id, full_name, avatar_url").in("id", ids))
          .forEach(function (p) { people[p.id] = p; });
      }
      var players = enr.map(function (e) {
        var p = people[e.user_id] || {};
        return { user_id: e.user_id, name: p.full_name || "Player", avatar_url: p.avatar_url || null,
                 status: e.status, seed: e.seed, final_place: e.final_place };
      });
      return { players: players, matches: matches };
    },
    rankings: async function () {
      if (!isLive) return S.rankings.slice();
      return unwrap(await sb.from("public_rankings").select("*").order("points", { ascending: false }).limit(50));
    },

    /* ------------------------------ enrolling & paying ------------------------------ */
    myEnrollments: async function (userId) {
      if (!isLive) return [];
      return unwrap(await sb.from("enrollments").select("*").eq("user_id", userId).neq("status", "cancelled"));
    },
    myPendingOrders: async function (userId) {
      if (!isLive) return [];
      return unwrap(await sb.from("orders").select("*").eq("buyer_id", userId).eq("status", "pending")
        .gt("hold_expires_at", new Date().toISOString()));
    },
    myInvites: async function (userId) {
      if (!isLive) return [];
      return unwrap(await sb.from("seat_invites").select("*").eq("inviter_id", userId)
        .in("status", ["ready", "claimed", "declined"]).order("created_at", { ascending: false }));
    },
    // Any already-paid seat waiting on the signed-in player's own email address, whether or
    // not they ever clicked the invite email.
    myPendingInvites: async function () {
      if (!isLive) return [];
      return unwrap(await sb.rpc("my_pending_invites"));
    },
    declineInvite: async function (inviteId) {
      needLive();
      unwrap(await sb.rpc("decline_invite", { p_invite_id: inviteId }));
    },
    getOrder: async function (orderId) {
      needLive();
      return unwrap(await sb.from("orders").select("*").eq("id", orderId).maybeSingle());
    },
    createOrder: async function (eventId, includeSelf, friends) {
      needLive();
      return unwrap(await sb.rpc("create_order", { p_event_id: eventId, p_include_self: includeSelf, p_friends: friends || [] }));
    },
    cancelOrder: async function (orderId) {
      needLive();
      unwrap(await sb.rpc("cancel_order", { p_order_id: orderId }));
    },
    // -> { url } to redirect to Stripe, or { paid: true } when nothing is left to pay.
    startCheckout: async function (orderId) {
      needLive();
      var res = await sb.functions.invoke("create-checkout", {
        body: { order_id: orderId, return_url: root.location.origin + root.location.pathname }
      });
      if (res.error) await fnError(res);
      return res.data || {};
    },
    sendInvites: async function (orderId, inviteId) {
      needLive();
      var res = await sb.functions.invoke("send-invites", { body: { order_id: orderId, invite_id: inviteId || null } });
      if (res.error) await fnError(res);
      return res.data || {};
    },
    getInvite: async function (token) {
      needLive();
      var rows = unwrap(await sb.rpc("get_invite", { p_token: token }));
      return rows && rows[0] ? rows[0] : null;
    },
    claimInvite: async function (token) {
      needLive();
      return unwrap(await sb.rpc("claim_invite", { p_token: token }));
    },

    /* ------------------------------ admin ------------------------------ */
    adminSaveEvent: async function (ev, id) {
      needLive();
      if (id) return unwrap(await sb.from("events").update(ev).eq("id", id).select().single());
      return unwrap(await sb.from("events").insert(ev).select().single());
    },
    uploadEventImage: async function (eventId, blob) {
      needLive();
      var path = eventId + "/photo.jpg";
      unwrap(await sb.storage.from("event-photos").upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" }));
      return sb.storage.from("event-photos").getPublicUrl(path).data.publicUrl + "?v=" + Date.now();
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
      return unwrap(await sb.from("enrollments")
        .select("*, profiles(full_name, email, phone, skill_level, avatar_url)")
        .eq("event_id", eventId).neq("status", "cancelled").order("created_at", { ascending: true }));
    },
    adminInvites: async function (eventId) {
      needLive();
      return unwrap(await sb.from("seat_invites")
        .select("*, inviter:profiles!seat_invites_inviter_id_fkey(full_name), claimer:profiles!seat_invites_claimed_by_fkey(full_name)")
        .eq("event_id", eventId).neq("status", "cancelled").order("created_at", { ascending: true }));
    },
    adminOrders: async function (eventId) {
      needLive();
      return unwrap(await sb.from("orders").select("id, buyer_id, seats, amount, currency, status, needs_review, paid_at")
        .eq("event_id", eventId));
    },
    adminReviewOrders: async function (eventId) {
      needLive();
      return unwrap(await sb.from("orders").select("*, buyer:profiles(full_name, email)")
        .eq("event_id", eventId).eq("needs_review", true));
    },
    adminMarkOrderPaid: async function (orderId) {
      needLive();
      unwrap(await sb.rpc("admin_mark_order_paid", { p_order_id: orderId }));
    },
    adminCancelInvite: async function (inviteId) {
      needLive();
      unwrap(await sb.rpc("admin_cancel_invite", { p_invite_id: inviteId }));
    },
    adminMarkInviteRefunded: async function (inviteId) {
      needLive();
      unwrap(await sb.rpc("admin_mark_invite_refunded", { p_invite_id: inviteId }));
    },
    adminSetEnrollmentStatus: async function (id, status) {
      needLive();
      unwrap(await sb.from("enrollments").update({
        status: status, paid_at: status === "paid" ? new Date().toISOString() : null,
        hold_expires_at: null
      }).eq("id", id));
    },

    // Seed paid players (best season points first, then skill level, ties shuffled), build the
    // bracket with byes, save it and put the event live.
    adminGenerateBracket: async function (eventId) {
      needLive();
      var paid = unwrap(await sb.from("enrollments").select("id, user_id, profiles(skill_level)")
        .eq("event_id", eventId).eq("status", "paid"));
      if (paid.length < 2) fail(new Error("need_two_players"));
      var rk = unwrap(await sb.from("public_rankings").select("user_id, points"));
      var pts = {}; rk.forEach(function (r) { pts[r.user_id] = r.points; });
      paid.forEach(function (p) { p.tie = Math.random(); p.skill = (p.profiles && p.profiles.skill_level) || 0; });
      paid.sort(function (a, b) {
        return (pts[b.user_id] || 0) - (pts[a.user_id] || 0) || b.skill - a.skill || a.tie - b.tie;
      });

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
