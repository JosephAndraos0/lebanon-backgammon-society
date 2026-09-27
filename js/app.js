/* Lebanon Backgammon Society - website logic (v2).
 * Routing, accounts & profile (with photo), enrolling with seat holds, paying for friends,
 * Stripe return handling, claiming a friend's seat, My Events and the admin dashboard.
 * Plain ES5-style JavaScript on purpose (old phones); async/await is the only modern syntax. */
(function () {
  "use strict";

  var C = window.LBS_CONFIG, API = window.LBS_API, B = window.LBS_BRACKET;

  var state = {
    user: null, profile: null, isAdmin: false,
    events: null, myEnrollments: [], myOrders: [],
    filter: "all", tab: "overview", authMode: "signin",
    awaitingConfirm: false, afterProfile: null, autoEnroll: null,
    view: null, token: 0, sessSeq: 0, welcomed: null,
    expiring: false, nextExpireCheck: 0
  };

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var SKILLS = ["Beginner", "Casual", "Intermediate", "Advanced", "Expert"];
  // Noted once at load, before the auth library rewrites the address (email-confirmation links).
  var cameFromAuthLink = /access_token|type=signup|type=magiclink/.test(location.hash);

  /* ---------------------------------------------------------------- helpers */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(name) {
    return String(name || "?").split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase() || "?";
  }
  // Round photo with initials underneath (shown if there is no photo or it fails to load).
  function avatar(name, url, cls) {
    var img = /^https?:\/\//.test(url || "")
      ? '<img src="' + esc(url) + '" alt="" loading="lazy" onerror="this.parentNode.removeChild(this)">' : "";
    return '<span class="avatar ' + (cls || "") + '"><span class="av-ini">' + esc(initials(name)) + "</span>" + img + "</span>";
  }
  function money(n, cur) { var v = Number(n) || 0; var s = (v % 1 === 0) ? String(v) : v.toFixed(2); return (cur && cur !== "USD" ? cur + " " : "$") + s; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", { timeZone: C.TIMEZONE || "Asia/Beirut", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return iso; }
  }
  function fmtClock(ms) {
    var s = Math.ceil(Math.max(0, ms) / 1000), m = Math.floor(s / 60); s = s % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function slugify(s) { return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove("show"); }, 3600);
  }
  function errMsg(e) { return (e && e.message) || "Something went wrong. Please try again."; }
  function loading(el) { el.innerHTML = '<div class="empty"><div class="spinner"></div><p>Loading…</p></div>'; }
  function emptyState(title, text, extra) { return '<div class="empty"><h3>' + esc(title) + "</h3><p>" + esc(text || "") + "</p>" + (extra || "") + "</div>"; }
  function eventBySlug(slug) { return (state.events || []).filter(function (e) { return e.slug === slug; })[0] || null; }
  function eventById(id) { return (state.events || []).filter(function (e) { return e.id === id; })[0] || null; }
  function paymentsOn(ev) { return !!C.PAYMENTS_ENABLED && Number(ev.entry_fee) > 0; }
  function isOnboarded() { return !!(state.profile && state.profile.onboarded_at); }
  function firstName() {
    var p = state.profile;
    return (p && (p.first_name || (p.full_name || "").split(" ")[0])) || ((state.user && state.user.email) || "").split("@")[0];
  }
  function needSupabase(box) {
    box.innerHTML = emptyState("Connect Supabase first", "This part of the site needs the database. Follow README.md, step 1.");
  }
  // The modern clipboard API can be refused (in-app browsers, no user gesture), so fall back to the old way.
  function copyText(text) {
    function legacy() {
      return new Promise(function (resolve, reject) {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("copy"));
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }

  function statusBadge(status) {
    if (status === "live") return '<span class="badge badge-live"><span class="dot-live" style="width:6px;height:6px;"></span>Live</span>';
    if (status === "completed") return '<span class="badge badge-completed">Completed</span>';
    if (status === "open") return '<span class="badge badge-upcoming">Open for entry</span>';
    if (status === "cancelled") return '<span class="badge badge-muted">Cancelled</span>';
    return '<span class="badge badge-muted">Draft</span>';
  }

  /* ---------------------------------------------------------------- post-login intents
   * Email-confirmation links reload the page and drop the #/route, so "what the person was
   * doing" (claiming a seat / enrolling) is kept in localStorage and resumed after sign-in. */
  var INTENT_KEY = "lbs_intent", INTENT_TTL = 3 * 3600 * 1000;
  function setIntent(obj) { try { obj.ts = Date.now(); localStorage.setItem(INTENT_KEY, JSON.stringify(obj)); } catch (e) { /* storage blocked */ } }
  function clearIntent() { try { localStorage.removeItem(INTENT_KEY); } catch (e) { /* ignore */ } }
  function takeIntent() {
    try {
      var raw = localStorage.getItem(INTENT_KEY);
      if (!raw) return null;
      localStorage.removeItem(INTENT_KEY);
      var o = JSON.parse(raw);
      return o && Date.now() - o.ts < INTENT_TTL ? o : null;
    } catch (e) { return null; }
  }
  function resumeIntent() {
    var it = takeIntent();
    if (!it) return false;
    if (it.t === "claim" && /^[A-Za-z0-9]{16,128}$/.test(it.token || "")) { go("claim/" + it.token); return true; }
    if (it.t === "enroll" && /^[a-z0-9-]{1,80}$/.test(it.slug || "")) { state.autoEnroll = it.slug; go("event/" + it.slug); return true; }
    return false;
  }

  /* ---------------------------------------------------------------- data */
  async function loadEvents(force) {
    if (state.events && !force) return state.events;
    state.events = await API.listEvents();
    return state.events;
  }
  // Paid/held seats and unpaid orders that are still inside their hold window.
  async function loadMine() {
    if (!state.user) { state.myEnrollments = []; state.myOrders = []; return; }
    var r = await Promise.all([API.myEnrollments(state.user.id), API.myPendingOrders(state.user.id)]);
    state.myEnrollments = r[0]; state.myOrders = r[1];
  }
  // Only a PAID enrollment counts as being registered. A pending row is just a hold.
  function paidEnrollment(eventId) {
    return state.myEnrollments.filter(function (e) { return e.event_id === eventId && e.status === "paid"; })[0] || null;
  }
  function heldOrder(eventId) {
    return state.myOrders.filter(function (o) {
      return o.event_id === eventId && o.status === "pending" && new Date(o.hold_expires_at).getTime() > Date.now();
    })[0] || null;
  }
  async function refreshMine() { await Promise.all([loadEvents(true), loadMine()]); }

  /* ---------------------------------------------------------------- router */
  var VIEW_FOR_NAV = { home: "home", events: "events", event: "events", my: "my", profile: "profile", admin: "admin", adminEvent: "admin" };

  function go(path) {
    var h = "#/" + path;
    if (location.hash === h) route(); else location.hash = h;
  }

  function parseRoute() {
    var h = location.hash;
    var authRedirect = /access_token|type=|error_description/.test(h);   // email-confirm / password-reset links
    if (h && h !== "#" && h.indexOf("#/") !== 0 && !authRedirect) return null;   // in-page anchors like #how
    if (authRedirect) h = "";
    var parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (!parts.length) return { name: "home" };
    if (parts[0] === "events") return { name: "events" };
    if (parts[0] === "event" && parts[1]) return { name: "event", slug: parts[1] };
    if (parts[0] === "my") return { name: "my" };
    if (parts[0] === "profile") return { name: "profile" };
    if (parts[0] === "claim" && parts[1]) return { name: "claim", token: parts[1] };
    if (parts[0] === "admin" && parts[1]) return { name: "adminEvent", slug: parts[1] };
    if (parts[0] === "admin") return { name: "admin" };
    return { name: "home" };
  }

  function showView(name) {
    state.view = name;
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.getAttribute("data-view") !== name; });
    var navName = VIEW_FOR_NAV[name];
    document.querySelectorAll(".navlinks button, .mobile-menu button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-nav") === navName);
    });
    document.body.classList.remove("has-cta");
    setMobileMenu(false);
    updateBanner();
    window.scrollTo(0, 0);
  }

  async function route() {
    var r = parseRoute();
    if (!r) return;
    var token = ++state.token;
    showView(r.name);
    if (r.name !== "event") document.title = "Lebanon Backgammon Society";
    try {
      if (r.name === "home") await renderHome(token);
      else if (r.name === "events") await renderEvents(token);
      else if (r.name === "event") { state.tab = "overview"; await renderEvent(r.slug, token); }
      else if (r.name === "my") await renderMy(token);
      else if (r.name === "profile") await renderProfile(token);
      else if (r.name === "claim") await renderClaim(r.token, token);
      else if (r.name === "admin") await renderAdmin(token);
      else if (r.name === "adminEvent") await renderAdminEvent(r.slug, token);
    } catch (e) {
      if (token === state.token) toast(errMsg(e));
    }
  }
  function stale(token) { return token !== state.token; }

  document.addEventListener("click", function (e) {
    var navBtn = e.target.closest("[data-nav]");
    if (navBtn) {
      e.preventDefault();
      go(navBtn.getAttribute("data-nav") === "home" ? "" : navBtn.getAttribute("data-nav"));
      return;
    }
    var card = e.target.closest("[data-open-event]");
    if (card) go("event/" + card.getAttribute("data-open-event"));
  });
  window.addEventListener("hashchange", route);
  // Coming back from Stripe with the browser's Back button can restore a frozen page: start clean.
  window.addEventListener("pageshow", function (e) { if (e.persisted) location.reload(); });

  /* ---------------------------------------------------------------- mobile menu & banners */
  var navToggle = $("navToggle"), mobileMenu = $("mobileMenu"), navToggleIcon = $("navToggleIcon");
  var ICON_BURGER = '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>';
  var ICON_CLOSE = '<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>';
  function setMobileMenu(open) {
    mobileMenu.hidden = !open;
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    navToggleIcon.innerHTML = open ? ICON_CLOSE : ICON_BURGER;
  }
  navToggle.addEventListener("click", function () { setMobileMenu(mobileMenu.hidden); });
  window.addEventListener("resize", function () { if (window.innerWidth > 860) setMobileMenu(false); });
  $("mobileSignOut").addEventListener("click", function () { doSignOut(); });

  function updateBanner() {
    var b = $("profileBanner");
    var show = API.isLive && state.user && state.profile && !isOnboarded() && state.view !== "profile" && state.view !== "claim";
    b.hidden = !show;
    if (show) b.innerHTML = '<span>Finish your profile to enroll. Add your phone number and a photo.</span> <button type="button" class="linklike" data-nav="profile">Complete profile</button>';
  }

  async function doSignOut() {
    try { await API.signOut(); } catch (e) { toast(errMsg(e)); }
  }

  /* ---------------------------------------------------------------- cards */
  function eventCard(ev) {
    var pct = Math.min(100, Math.round((ev.taken / ev.max_players) * 100));
    return '<div class="card" data-open-event="' + esc(ev.slug) + '" tabindex="0" role="link">' +
      statusBadge(ev.status) +
      "<h3>" + esc(ev.name) + "</h3>" +
      '<div class="card-meta">' +
        '<div><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>' + esc(ev.venue || "Venue to be announced") + "</div>" +
        '<div><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' + esc(fmtDate(ev.starts_at)) + "</div>" +
      "</div>" +
      '<div><div class="fill-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="fill-text">' + ev.taken + " / " + ev.max_players + " seats filled</div></div>" +
      '<div class="card-foot">' +
        '<div class="fee">' + esc(money(ev.entry_fee, ev.currency)) + '<span> entry</span></div>' +
        '<div style="text-align:right;"><div class="fee">' + (totalPrizes(ev) > 0 ? esc(money(totalPrizes(ev), ev.currency)) : "—") + '</div><div class="fee-sub">in prizes</div></div>' +
      "</div></div>";
  }
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-open-event]")) {
      e.preventDefault(); go("event/" + e.target.getAttribute("data-open-event"));
    }
  });

  /* ---------------------------------------------------------------- home */
  async function renderHome(token) {
    var res = await Promise.all([loadEvents(), API.rankings()]);
    if (stale(token)) return;
    var events = res[0], ranks = res[1];
    var live = events.filter(function (e) { return e.status === "live"; });
    var open = events.filter(function (e) { return e.status === "open"; });
    var completed = events.filter(function (e) { return e.status === "completed"; });

    $("heroStats").innerHTML =
      '<div><b class="num">' + live.length + "</b><span>Live now</span></div>" +
      '<div><b class="num">' + open.length + "</b><span>Open for entry</span></div>" +
      '<div><b class="num">' + completed.length + "</b><span>Tournaments played</span></div>";

    var pill = $("liveHeroPill");
    if (live.length) {
      pill.style.display = "";
      $("liveHeroText").textContent = live[0].name;
      pill.onclick = function () { go("event/" + live[0].slug); };
    } else { pill.style.display = "none"; }

    var list = live.concat(open).slice(0, 6);
    $("homeEventsGrid").innerHTML = list.length ? list.map(eventCard).join("")
      : emptyState("No tournaments yet", "New events are announced here. Check back soon.");

    $("rankingsBody").innerHTML = ranks.length ? ranks.map(function (r, i) {
      return '<tr><td class="rank-num">#' + (i + 1) + "</td>" +
        '<td><div class="player-cell">' + avatar(r.full_name, null, "avatar-muted") + '<span class="pname-wrap">' + esc(r.full_name) + "</span></div></td>" +
        '<td class="num hide-sm">' + r.events_played + "</td>" +
        '<td class="num hide-sm">' + (r.best_place ? "#" + r.best_place : "—") + "</td>" +
        '<td class="num points">' + r.points + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="muted-cell">Rankings appear after the first tournament finishes.</td></tr>';
  }

  /* ---------------------------------------------------------------- events list */
  async function renderEvents(token) {
    var grid = $("allEventsGrid");
    if (!state.events) loading(grid);
    var events = await loadEvents(true);
    if (stale(token)) return;
    events = events.filter(function (e) { return state.filter === "all" ? e.status !== "draft" || state.isAdmin : e.status === state.filter; });
    grid.innerHTML = events.length ? events.map(eventCard).join("") : emptyState("No events here", "Try a different filter.");
  }
  $("eventFilterBar").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    state.filter = b.getAttribute("data-filter");
    document.querySelectorAll("#eventFilterBar button").forEach(function (x) { x.classList.toggle("active", x === b); });
    renderEvents(state.token);
  });

  /* ---------------------------------------------------------------- bracket display */
  function trophySvg(color) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="1.8"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 01-10 0V4z"/><path d="M7 5H4a3 3 0 003 3M17 5h3a3 3 0 01-3 3"/></svg>';
  }
  function slotWho(id, nameOf, avOf, placeholder) {
    if (!id) return '<span class="slot-who"><span class="slot-name ph">' + esc(placeholder) + "</span></span>";
    return '<span class="slot-who">' + avatar(nameOf(id), avOf(id), "avatar-xs") + '<span class="slot-name">' + esc(nameOf(id)) + "</span></span>";
  }
  function matchHtml(m, nameOf, avOf, tag) {
    var t = tag ? '<div class="match-tag muted-tag">' + esc(tag) + "</div>" : "";
    if (m.status === "bye") {
      return '<div class="match done bye-match"><div class="match-tag muted-tag">Bye</div>' +
        '<div class="slot winner">' + slotWho(m.winner, nameOf, avOf, "TBD") + '<span class="slot-score">W</span></div>' +
        '<div class="slot faded"><span class="slot-name">No opponent</span></div></div>';
    }
    if (m.status === "pending") {
      return '<div class="match tbd">' + t +
        '<div class="slot">' + slotWho(m.player_a, nameOf, avOf, "TBD") + "</div>" +
        '<div class="slot">' + slotWho(m.player_b, nameOf, avOf, "TBD") + "</div></div>";
    }
    var live = m.status === "live";
    var aWin = m.winner && m.winner === m.player_a, bWin = m.winner && m.winner === m.player_b;
    var sa = m.score_a == null ? "" : m.score_a, sb = m.score_b == null ? "" : m.score_b;
    return '<div class="match ' + (live ? "live" : "done") + '">' + (live ? '<div class="match-tag">● Live</div>' : t) +
      '<div class="slot ' + (aWin ? "winner" : "") + '">' + slotWho(m.player_a, nameOf, avOf, "TBD") + '<span class="slot-score">' + sa + "</span></div>" +
      '<div class="slot ' + (bWin ? "winner" : "") + '">' + slotWho(m.player_b, nameOf, avOf, "TBD") + '<span class="slot-score">' + sb + "</span></div></div>";
  }
  function bracketHtml(matches, nameOf, avOf) {
    var rounds = B.toRounds(matches);
    var cols = rounds.map(function (r, idx) {
      var last = idx === rounds.length - 1;
      var body;
      if (last) {
        var fin = r.matches.filter(function (m) { return m.position === 1; })[0];
        var third = r.matches.filter(function (m) { return m.position === 2; })[0];
        var champ = fin && fin.status === "done" ? nameOf(fin.winner) : null;
        body = matchHtml(fin, nameOf, avOf) +
          '<div class="match champion"><div class="champion-slot">' + trophySvg("#C6A15B") +
          (champ ? "<b>" + esc(champ) + "</b><span>Champion</span>" : '<b class="ph">TBD</b><span>Champion</span>') + "</div></div>" +
          (third ? matchHtml(third, nameOf, avOf, "Third place") : "");
      } else {
        body = r.matches.map(function (m) { return matchHtml(m, nameOf, avOf); }).join("");
      }
      return '<div class="bracket-round"><div class="round-title">' + esc(r.label) + '</div><div class="round-col">' + body + "</div></div>";
    }).join("");
    return '<p class="swipe-hint">Swipe sideways to see every round →</p><div class="bracket-scroll"><div class="bracket">' + cols + "</div></div>";
  }

  function standingsFrom(matches, players) {
    var out = {}, alive = {};
    players.forEach(function (p) { alive[p.user_id] = { p: p, exit: 0, live: false }; });
    matches.forEach(function (m) {
      if (m.status === "live") { [m.player_a, m.player_b].forEach(function (id) { if (alive[id]) alive[id].live = true; }); }
      if (m.status === "done") {
        var loser = m.winner === m.player_a ? m.player_b : m.player_a;
        if (alive[loser]) alive[loser].exit = Math.max(alive[loser].exit, m.round);
      }
    });
    out.competing = []; out.eliminated = [];
    var R = matches.length ? Math.max.apply(null, matches.map(function (m) { return m.round; })) : 0;
    Object.keys(alive).forEach(function (id) {
      var a = alive[id];
      if (a.exit) out.eliminated.push({ n: a.p.name, exit: a.exit, label: "Out · " + B.roundLabel(a.exit, R) });
      else out.competing.push({ n: a.p.name, live: a.live });
    });
    out.eliminated.sort(function (x, y) { return y.exit - x.exit; });
    return out;
  }

  /* ---------------------------------------------------------------- event detail */
  var current = null;   // { event, detail, people }

  async function renderEvent(slug, token) {
    $("edPanels").innerHTML = '<div class="empty"><div class="spinner"></div><p>Loading…</p></div>';
    $("edCtaBox").innerHTML = "";
    await Promise.all([loadEvents(true), state.user ? loadMine() : Promise.resolve()]);
    var ev = eventBySlug(slug);
    if (!ev) {
      $("edTitle").textContent = "Event not found"; $("edBadgeSlot").innerHTML = "";
      $("edPanels").innerHTML = emptyState("We couldn't find that event", "It may have been removed.", '<button class="btn btn-brass" data-nav="events" style="margin-top:16px;">Browse events</button>');
      return;
    }
    var detail = await API.eventDetail(ev.id);
    if (stale(token)) return;
    var people = {};
    detail.players.forEach(function (p) { people[p.user_id] = { name: p.name, avatar_url: p.avatar_url }; });
    current = { event: ev, detail: detail, people: people };
    drawEvent();
    // Someone who signed in from an "Enroll" button carries on where they left off.
    if (state.autoEnroll === slug) { state.autoEnroll = null; startEnroll(ev); }
  }

  function prizesOf(ev) {
    var p = ev.prizes || [];
    return [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0];
  }
  function totalPrizes(ev) { return prizesOf(ev).reduce(function (a, b) { return a + b; }, 0); }

  function drawEvent() {
    var ev = current.event, detail = current.detail;
    $("edBadgeSlot").innerHTML = statusBadge(ev.status);
    $("edTitle").textContent = ev.name;
    $("edVenue").textContent = ev.venue || "To be announced";
    $("edDate").textContent = fmtDate(ev.starts_at);
    $("edFee").textContent = money(ev.entry_fee, ev.currency);
    $("edPool").textContent = totalPrizes(ev) > 0 ? money(totalPrizes(ev), ev.currency) : "—";
    $("edPlayers").textContent = ev.taken + " / " + ev.max_players;
    document.title = ev.name + " · Lebanon Backgammon Society";

    var hasBracket = detail.matches.length > 0;
    document.querySelectorAll("#edTabs button").forEach(function (b) {
      var t = b.getAttribute("data-tab");
      b.style.display = (t === "bracket" && !hasBracket) ? "none" : "";
      b.classList.toggle("active", t === state.tab);
    });
    drawCta();
    drawPanel();
  }

  function holdHtml(order) {
    var left = new Date(order.hold_expires_at).getTime() - Date.now();
    return '<div class="hold-box"><div class="hold-info"><span class="hold-label">Seats held for you</span>' +
      '<b class="hold-time num" data-until="' + esc(order.hold_expires_at) + '">' + fmtClock(left) + "</b>" +
      '<span class="hold-note">' + plural(order.seats, "seat") + " · " + esc(money(order.amount, order.currency)) + " · not confirmed until paid</span></div>" +
      '<div class="hold-actions"><button class="btn btn-brass" id="edPayBtn">Pay ' + esc(money(order.amount, order.currency)) + ' now</button>' +
      '<button class="btn-link" id="edCancelBtn">Cancel</button></div></div>';
  }

  function drawCta() {
    var ev = current.event, box = $("edCtaBox");
    var paid = paidEnrollment(ev.id), held = heldOrder(ev.id);
    var full = ev.taken >= ev.max_players, fee = money(ev.entry_fee, ev.currency);
    var html = "", sticky = false;

    if (ev.status === "completed") {
      var champ = current.detail.players.filter(function (p) { return p.final_place === 1; })[0];
      html = champ ? '<div class="champ-line"><span>Champion</span><b>' + esc(champ.name) + "</b></div>" : "";
    } else if (ev.status === "cancelled") {
      html = '<button class="btn btn-ghost" disabled>Cancelled</button>';
    } else if (ev.status === "live") {
      html = paid ? '<span class="pill pill-ok pill-lg">✓ You\'re enrolled</span>' : '<button class="btn btn-ghost" disabled>Bracket in progress</button>';
    } else if (ev.status !== "open") {
      html = '<button class="btn btn-ghost" disabled>Not open yet</button>';
    } else {
      var parts = [];
      if (paid) {
        var canInvite = !full || held;
        parts.push('<div class="cta-row"><span class="pill pill-ok pill-lg">✓ You\'re enrolled</span>' +
          (canInvite && (paymentsOn(ev) || Number(ev.entry_fee) === 0) ? '<button class="btn btn-ghost" id="edInviteBtn">Invite friends</button>' : "") + "</div>");
      }
      if (held) parts.push(holdHtml(held));
      if (!paid && !held) {
        if (full) parts.push('<button class="btn btn-ghost" disabled>Seats full</button>');
        else if (Number(ev.entry_fee) > 0 && !C.PAYMENTS_ENABLED) parts.push('<button class="btn btn-ghost" disabled>Online payment coming soon</button><p class="cta-note">' + esc(C.PAYMENT_INSTRUCTIONS) + "</p>");
        else parts.push('<button class="btn btn-brass btn-cta" id="edEnrollBtn">' + (state.user ? "Enroll · " : "Sign in to enroll · ") + esc(Number(ev.entry_fee) > 0 ? fee : "Free") + "</button>");
      }
      html = '<div class="cta-stack">' + parts.join("") + "</div>";
      sticky = !!(held || !paid && !full && (Number(ev.entry_fee) === 0 || C.PAYMENTS_ENABLED));
    }

    box.innerHTML = html;
    box.classList.toggle("cta-sticky", sticky);
    document.body.classList.toggle("has-cta", sticky && state.view === "event");

    if ($("edEnrollBtn")) $("edEnrollBtn").onclick = function () { startEnroll(ev); };
    if ($("edInviteBtn")) $("edInviteBtn").onclick = function () { startEnroll(ev); };
    if ($("edPayBtn")) $("edPayBtn").onclick = function () { payOrder(held, $("edPayBtn")); };
    if ($("edCancelBtn")) $("edCancelBtn").onclick = function () { cancelHold(held); };
  }

  $("edTabs").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b || !current) return;
    state.tab = b.getAttribute("data-tab");
    document.querySelectorAll("#edTabs button").forEach(function (x) { x.classList.toggle("active", x === b); });
    drawPanel();
  });

  function drawPanel() {
    var ev = current.event, d = current.detail, panel = $("edPanels");
    var nameOf = function (id) { return (current.people[id] && current.people[id].name) || "Player"; };
    var avOf = function (id) { return current.people[id] && current.people[id].avatar_url; };

    if (state.tab === "overview") {
      var how = ev.status === "open"
        ? '<div class="note-box"><h4>How entry works</h4><p>' + (paymentsOn(ev)
            ? "Tap Enroll and pay the " + esc(money(ev.entry_fee, ev.currency)) + " entry fee by card. Your seat is confirmed the moment the payment goes through. While you pay, your seat is held for a few minutes; if you don't finish, it's released for someone else. You can also pay for friends: they get an email to claim the seat you paid for."
            : Number(ev.entry_fee) > 0 ? "Online payment isn't available yet. " + esc(C.PAYMENT_INSTRUCTIONS)
            : "This event is free. Tap Enroll to take a seat. You can also reserve seats for friends.") +
          " When entry closes, players are seeded and the bracket is published here. If the field isn't a full power of two, the top seeds get byes.</p></div>" : "";
      panel.innerHTML = '<div class="prose"><p>' + esc(ev.description || "Details coming soon.") + "</p>" + how + "</div>";
      return;
    }
    if (state.tab === "bracket") {
      panel.innerHTML = d.matches.length ? bracketHtml(d.matches, nameOf, avOf)
        : emptyState("No bracket yet", "The bracket is published when entry closes.");
      return;
    }
    if (state.tab === "standings") {
      if (ev.status === "completed") {
        var byPlace = function (n) { return d.players.filter(function (p) { return p.final_place === n; })[0]; };
        var podium = [[1, "gold", "#C6A15B"], [2, "", "#C9BBA3"], [3, "", "#B08A56"]].map(function (x) {
          var p = byPlace(x[0]);
          return '<div class="prize-card ' + x[1] + '">' + trophySvg(x[2]) + '<div class="place">' + ["", "1st", "2nd", "3rd"][x[0]] + ' place</div><div class="who big">' + esc(p ? p.name : "—") + "</div></div>";
        }).join("");
        panel.innerHTML = '<div class="prize-grid">' + podium + "</div>";
        return;
      }
      if (!d.matches.length) { panel.innerHTML = emptyState("Standings open once play begins", "Check back when the bracket is published."); return; }
      var st = standingsFrom(d.matches, d.players.filter(function (p) { return p.status === "paid"; }));
      panel.innerHTML = '<div class="standing-cols">' +
        '<div class="standing-block"><h4>Still competing</h4>' + st.competing.map(function (p) {
          return '<div class="standing-item"><b>' + esc(p.n) + '</b><span class="round-out">' + (p.live ? "● Playing now" : "Advancing") + "</span></div>";
        }).join("") + "</div>" +
        '<div class="standing-block"><h4>Eliminated</h4>' + (st.eliminated.length ? st.eliminated.map(function (p) {
          return '<div class="standing-item dim"><b>' + esc(p.n) + '</b><span class="round-out">' + esc(p.label) + "</span></div>";
        }).join("") : '<p class="muted-cell">Nobody yet.</p>') + "</div></div>";
      return;
    }
    if (state.tab === "prizes") {
      var prizes = prizesOf(ev);
      var place = function (n) { return d.players.filter(function (p) { return p.final_place === n; })[0]; };
      panel.innerHTML = '<div class="prize-grid">' + [0, 1, 2].map(function (i) {
        var p = place(i + 1);
        return '<div class="prize-card ' + (i === 0 ? "gold" : "") + '">' + trophySvg(["#C6A15B", "#C9BBA3", "#B08A56"][i]) +
          '<div class="place">' + ["1st", "2nd", "3rd"][i] + ' place</div><div class="amt">' + esc(money(prizes[i], ev.currency)) + '</div><div class="who">' +
          (p ? esc(p.name) : "Up for grabs") + "</div></div>";
      }).join("") + "</div>" +
      '<p class="fineprint">Prizes are awarded to the top three finishers of this tournament.</p>';
      return;
    }
    if (state.tab === "players") {
      // Only players with a confirmed (paid) seat are ever listed.
      panel.innerHTML = d.players.length ? '<div class="players-grid">' + d.players.slice().sort(function (a, b) { return (a.seed || 999) - (b.seed || 999); }).map(function (p, i) {
        return '<div class="player-row"><span class="seed num">' + (p.seed || i + 1) + "</span>" + avatar(p.name, p.avatar_url, "avatar-md") + '<span class="pname">' + esc(p.name) + "</span></div>";
      }).join("") + "</div>" : emptyState("No players yet", "Be the first to enroll.");
    }
  }

  /* ---------------------------------------------------------------- dialogs (bottom sheets on phones) */
  var sheetSeq = 0, sheetSticky = false;
  function syncLock() {
    document.body.classList.toggle("modal-open", !$("modalOverlay").hidden || !$("authOverlay").hidden);
  }
  // Returns an id; async work started for a sheet checks it to know whether the sheet is still showing.
  function openModal(html, opts) {
    sheetSeq++; sheetSticky = !!(opts && opts.sticky);
    $("modalInner").innerHTML = html; $("modalOverlay").hidden = false; syncLock();
    var m = $("modalOverlay").querySelector(".modal"); if (m) m.scrollTop = 0;
    return sheetSeq;
  }
  function closeModal() {
    var wasOpen = !$("modalOverlay").hidden;
    sheetSeq++; $("modalOverlay").hidden = true; $("modalInner").innerHTML = ""; syncLock();
    if (wasOpen) redraw(true);   // whatever the sheet did (held seats, a payment) must show on the page behind it
  }
  $("modalOverlay").addEventListener("click", function (e) { if (e.target === $("modalOverlay") && !sheetSticky) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeModal(); dismissAuth(); } });
  document.addEventListener("click", function (e) { if (e.target.closest("[data-close-modal]")) closeModal(); });

  function sheetMessage(kind, title, text, buttons) {
    var icon = kind === "ok"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#82B58F" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>'
      : kind === "wait" ? '<div class="spinner spinner-lg"></div>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="#E7C583" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5v.5"/></svg>';
    return '<div class="success-box">' + icon + "<h3>" + esc(title) + "</h3><p>" + text + "</p>" + (buttons || "") + "</div>";
  }
  function doneSheet(kind, title, text, after) {
    openModal(sheetMessage(kind, title, text, '<button class="btn btn-brass btn-block" id="doneBtn">Done</button>'));
    $("doneBtn").onclick = function () { closeModal(); if (after) after(); else redraw(true); };
  }

  /* ---------------------------------------------------------------- enrolling & paying */
  // Entry point for every "Enroll" / "Invite friends" button.
  function startEnroll(ev) {
    if (!ev) return;
    if (!API.isLive) { toast("Connect Supabase to enable enrolling (see README.md)."); return; }
    if (!state.user) { setIntent({ t: "enroll", slug: ev.slug }); openAuth("signup"); return; }
    if (!isOnboarded()) {
      setIntent({ t: "enroll", slug: ev.slug });                       // survives a reload while the profile is filled in
      state.afterProfile = function () { state.autoEnroll = ev.slug; go("event/" + ev.slug); };
      toast("First, finish your profile. It only takes a minute.");
      go("profile");
      return;
    }
    openCheckout(ev);
  }

  function friendRowHtml() {
    return '<div class="friend-row"><div class="fr-fields">' +
      '<input class="fr-name" aria-label="Friend\'s name (optional)" placeholder="Name (optional)" autocomplete="off" maxlength="60">' +
      '<input class="fr-email" type="email" inputmode="email" aria-label="Friend\'s email" placeholder="friend@example.com" autocomplete="off" autocapitalize="off" maxlength="200">' +
      '</div><button type="button" class="fr-del" aria-label="Remove this friend">&times;</button></div>';
  }

  function openCheckout(ev) {
    var paid = paidEnrollment(ev.id), held = heldOrder(ev.id);
    var avail = ev.max_players - ev.taken + (held ? held.seats : 0);   // a new order replaces our own hold
    var fee = Number(ev.entry_fee) || 0, canSelf = !paid;
    var myEmail = String((state.user && state.user.email) || "").toLowerCase();
    if (avail < 1) { toast("Sorry, this event is full."); return; }
    if (fee > 0 && !C.PAYMENTS_ENABLED) { toast("Online payment isn't switched on yet."); return; }
    var order = null, busy = false;

    openModal(
      '<div class="modal-head"><h3>' + (canSelf ? "Enroll in " : "Invite friends to ") + esc(ev.name) + '</h3><button class="modal-close" type="button" data-close-modal aria-label="Close">&times;</button></div>' +
      '<div class="co-event"><span>' + esc(fmtDate(ev.starts_at)) + "</span><span>" + esc(ev.venue || "") + "</span></div>" +
      (canSelf
        ? '<label class="check-row"><input type="checkbox" id="coSelf" checked><span class="check-box" aria-hidden="true"></span><span class="check-text"><b>Also pay for myself</b><small>Your own seat' + (fee > 0 ? " · " + esc(money(fee, ev.currency)) : "") + "</small></span></label>"
        : '<p class="modal-text">You already have a seat. Pay for friends and we\'ll email each of them a link to claim the seat you paid for.</p>') +
      '<div class="co-friends"><div class="co-friends-head"><b>Friends</b><span class="muted" id="coCap"></span></div>' +
      '<div id="coRows"></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="coAdd">+ Add a friend</button>' +
      '<small class="co-hint">Each friend gets an email with a one-tap link to claim the seat you paid for. They set up their own free account.</small></div>' +
      (held ? '<p class="modal-note">This replaces the seats you are currently holding for this event.</p>' : "") +
      '<div class="co-total"><span id="coSeats"></span><b id="coTotal"></b></div>' +
      '<p class="form-error" id="coError" role="alert" hidden></p>' +
      '<p class="modal-note">' + (fee > 0 ? "Seats are held for 35 minutes while you pay on our secure Stripe checkout page. Nothing is confirmed until the payment goes through." : "This event is free.") + "</p>" +
      '<div class="sheet-actions"><button class="btn btn-brass btn-block" id="coGo"></button></div>',
      { sticky: true });

    function selfOn() { return canSelf && $("coSelf").checked; }
    function rowEls() { return Array.prototype.slice.call($("coRows").querySelectorAll(".friend-row")); }
    function filled() { return rowEls().filter(function (r) { return r.querySelector(".fr-email").value.trim(); }).length; }
    function cap() { return Math.max(0, Math.min(8, avail - (selfOn() ? 1 : 0))); }
    function refresh() {
      var n = (selfOn() ? 1 : 0) + filled(), c = cap();
      $("coSeats").textContent = plural(n, "seat") + (fee > 0 ? " × " + money(fee, ev.currency) : "");
      $("coTotal").textContent = fee > 0 ? money(fee * n, ev.currency) : "Free";
      $("coCap").textContent = c > 0 ? "up to " + c : "no seats left for friends";
      $("coAdd").disabled = busy || !!order || rowEls().length >= c;
      var goBtn = $("coGo");
      goBtn.disabled = busy || (!order && n < 1);
      if (order) goBtn.textContent = "Try payment again";
      else goBtn.textContent = n < 1 ? "Choose at least one seat" : fee > 0 ? "Pay " + money(fee * n, ev.currency) : "Reserve " + plural(n, "seat");
    }
    function addRow(focus) {
      $("coRows").insertAdjacentHTML("beforeend", friendRowHtml());
      if (focus) { var r = rowEls(); r[r.length - 1].querySelector(".fr-email").focus(); }
      refresh();
    }
    function lockInputs() {
      Array.prototype.forEach.call($("modalInner").querySelectorAll("input"), function (i) { i.disabled = true; });
      $("coAdd").disabled = true;
    }
    function fail(msg) { var b = $("coError"); b.textContent = msg; b.hidden = false; }

    if (!canSelf) addRow(false);
    refresh();
    if (canSelf) $("coSelf").addEventListener("change", refresh);
    $("coAdd").onclick = function () { addRow(true); };
    $("coRows").addEventListener("input", refresh);
    $("coRows").addEventListener("click", function (e) {
      var del = e.target.closest(".fr-del");
      if (del) { del.parentNode.parentNode.removeChild(del.parentNode); refresh(); }
    });

    $("coGo").onclick = async function () {
      $("coError").hidden = true;
      var self = selfOn(), friends = [], seen = {}, problem = "";
      rowEls().forEach(function (r) {
        var name = r.querySelector(".fr-name").value.trim(), email = r.querySelector(".fr-email").value.trim().toLowerCase();
        if (!name && !email) return;                                   // blank rows are ignored
        if (!email) problem = problem || "Add an email address for " + name + ".";
        else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problem = problem || "\"" + email + "\" doesn't look like an email address.";
        else if (email === myEmail) problem = problem || "That's your own email. Use \"Also pay for myself\" instead.";
        else if (seen[email]) problem = problem || "You entered " + email + " twice.";
        else { seen[email] = 1; friends.push({ email: email, name: name }); }
      });
      if (problem) { fail(problem); return; }
      var n = (self ? 1 : 0) + friends.length;
      if (n < 1) { fail("Choose at least one seat."); return; }
      if (n > avail) { fail(avail === 1 ? "Only 1 seat is left." : "Only " + avail + " seats are left."); return; }

      busy = true; refresh(); $("coGo").textContent = "Please wait…";
      try {
        // Keep the order if opening the payment page fails, so a retry doesn't create a second one.
        if (!order) { order = await API.createOrder(ev.id, self, friends); lockInputs(); }
        await refreshMine();
        if (order.status === "paid") { await finishFreeOrder(ev, order, self, friends.length); return; }
        $("coGo").textContent = "Opening secure checkout…";
        var r = await API.startCheckout(order.id);
        if (r.paid) { await refreshMine(); doneSheet("ok", "Already paid", "This order is already paid. You're all set."); return; }
        if (!/^https:\/\//.test(r.url || "")) throw new Error("We couldn't open the payment page. Please try again.");
        location.href = r.url;
        return;                                                        // leaving the page; button stays disabled
      } catch (e) {
        fail(errMsg(e) + (order ? " Your seats are still held. Try again, or come back to this page." : ""));
        try { await refreshMine(); } catch (x) { /* ignore */ }
      }
      busy = false; refresh();
    };
  }

  async function finishFreeOrder(ev, order, self, friendCount) {
    var note = "";
    if (friendCount) {
      try { await API.sendInvites(order.id); note = " We've emailed your " + (friendCount === 1 ? "friend" : "friends") + " a link to claim their seat" + (friendCount === 1 ? "" : "s") + "."; }
      catch (e) { note = " We couldn't send the invite emails. Open My Events to copy or resend each link."; }
    }
    doneSheet("ok", self ? "You're in!" : "Seats reserved", esc((self ? "You're enrolled in " + ev.name + ". See you at the table." : "Your friends' seats for " + ev.name + " are reserved.") + note));
  }

  async function payOrder(order, btn) {
    if (!order) return;
    var label = btn && btn.textContent;
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Opening checkout…"; }
      var r = await API.startCheckout(order.id);
      if (r.paid) { await refreshMine(); toast("This order is already paid."); redraw(true); return; }
      if (!/^https:\/\//.test(r.url || "")) throw new Error("We couldn't open the payment page. Please try again.");
      location.href = r.url;
    } catch (e) {
      toast(errMsg(e));
      try { await refreshMine(); } catch (x) { /* ignore */ }
      if (btn && btn.parentNode) { btn.disabled = false; btn.textContent = label; }
      redraw(true);
    }
  }

  async function cancelHold(order) {
    if (!order) return;
    if (!confirm("Give up these " + plural(order.seats, "held seat") + "? They'll be released for other players.")) return;
    try {
      await API.cancelOrder(order.id);
      await refreshMine();
      toast("Seats released.");
    } catch (e) { toast(errMsg(e)); try { await refreshMine(); } catch (x) { /* ignore */ } }
    redraw(true);
  }

  // Redraw whatever screen shows seats/holds without jumping back to the top.
  function redraw(silent) {
    if (state.view === "event" && current) { current.event = eventById(current.event.id) || current.event; drawEvent(); }
    else if (state.view === "my") renderMy(state.token, silent);
    else if (state.view === "events") renderEvents(state.token);
    else if (state.view === "home") renderHome(state.token);
  }

  /* ---------------------------------------------------------------- hold countdowns */
  setInterval(function () {
    var els = document.querySelectorAll("[data-until]");
    if (!els.length) return;
    var now = Date.now(), expired = false;
    els.forEach(function (el) {
      var left = new Date(el.getAttribute("data-until")).getTime() - now;
      el.textContent = fmtClock(left);
      if (left <= 0) expired = true;
    });
    if (expired && !state.expiring && now > state.nextExpireCheck) {
      state.expiring = true;
      refreshMine().then(function () { redraw(true); }).catch(function () { /* ignore */ })
        .then(function () { state.expiring = false; state.nextExpireCheck = Date.now() + 5000; });
    }
  }, 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.user && document.querySelector("[data-until]")) {
      refreshMine().then(function () { redraw(true); }).catch(function () { /* ignore */ });
    }
  });

  /* ---------------------------------------------------------------- returning from Stripe */
  var returnParams = (function () {
    try {
      var q = new URLSearchParams(location.search), flag = q.get("paid");
      if (flag === null) return null;
      var out = { flag: flag, order: q.get("order") };
      q.delete("paid"); q.delete("order");
      history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
      return out;
    } catch (e) { return null; }
  })();

  // The address bar saying "paid=1" proves nothing. Only the server's record of the order does.
  async function confirmPayment(orderId) {
    var seq = openModal(sheetMessage("wait", "Confirming your payment…", "This usually takes a few seconds. Please keep this page open and don't pay again.", '<button class="btn-link" data-close-modal>Close</button>'), { sticky: true });
    var started = Date.now(), order = null;
    while (Date.now() - started < 45000) {
      if (seq !== sheetSeq) return;                                    // the person closed the sheet
      try { order = await API.getOrder(orderId); } catch (e) { order = null; }
      if (order && order.status === "paid") break;
      await sleep(2000);
    }
    if (seq !== sheetSeq) return;
    if (order && order.status === "paid") {
      try { await refreshMine(); } catch (e) { /* ignore */ }
      if (order.needs_review) {
        doneSheet("warn", "Payment received", "Your payment went through, but the seats had already been taken by the time it arrived. We'll contact you shortly to sort it out. You won't lose your money.");
        return;
      }
      var mine = state.myEnrollments.filter(function (e) { return e.order_id === order.id && e.status === "paid"; }).length;
      var friends = order.seats - mine;
      doneSheet("ok", "Payment confirmed", esc((mine ? "You're enrolled. See you at the table." : "Your seats are paid.") +
        (friends > 0 ? " We're emailing " + (friends === 1 ? "your friend" : "your " + friends + " friends") + " a link to claim their seat" + (friends === 1 ? "" : "s") + ". You can also share the links from My Events." : "")));
      return;
    }
    openModal(sheetMessage("warn", "Still waiting for confirmation",
      "We haven't received confirmation from the payment provider yet. Your payment may still be processing. <b>Please don't pay again.</b> Your seat appears here as soon as it's confirmed.",
      '<button class="btn btn-brass btn-block" id="againBtn">Check again</button><button class="btn-link" id="closeBtn" style="margin-top:12px;">Close</button>'));
    $("againBtn").onclick = function () { confirmPayment(orderId); };
    $("closeBtn").onclick = function () { closeModal(); redraw(true); };
  }

  async function handlePaymentReturn(p) {
    if (!p.order || !UUID_RE.test(p.order)) {
      if (p.flag === "1") toast("Thanks! If your payment went through, your seat will show up in a moment.");
      return;
    }
    if (!state.user) {
      openModal(sheetMessage("warn", "Sign in to see your seat", "Sign in with the account you paid with and your seat will show up as soon as the payment is confirmed.", '<button class="btn btn-brass btn-block" id="siBtn">Sign in</button>'));
      $("siBtn").onclick = function () { closeModal(); openAuth("signin"); };
      return;
    }
    if (p.flag === "1") { await confirmPayment(p.order); return; }
    var o = null;
    try { o = await API.getOrder(p.order); } catch (e) { /* ignore */ }
    if (o && o.status === "paid") { await confirmPayment(p.order); return; }
    if (o && o.status === "pending" && new Date(o.hold_expires_at).getTime() > Date.now()) toast("Payment not completed. Your seats are still held for a few minutes.");
    else toast("Payment not completed. Your seats were released. You can enroll again.");
  }

  /* ---------------------------------------------------------------- profile & onboarding */
  var pf = null;   // profile-form state: { blob, avatarUrl, skill, marketing, preview }

  async function renderProfile(token) {
    var box = $("profileContent");
    if (!API.isLive) { needSupabase(box); return; }
    if (!state.user) {
      box.innerHTML = emptyState("Sign in required", "Sign in to set up your player profile.", '<button class="btn btn-brass" id="pfSignIn" style="margin-top:16px;">Sign in or create account</button>');
      $("pfSignIn").onclick = function () { openAuth("signin"); };
      return;
    }
    if (!state.profile) {
      loading(box);
      try { state.profile = await API.getProfile(state.user.id); } catch (e) { box.innerHTML = emptyState("Couldn't load your profile", errMsg(e)); return; }
      if (stale(token)) return;
    }
    drawProfile();
  }

  function drawProfile() {
    var box = $("profileContent"), p = state.profile, first = !isOnboarded();
    pf = { blob: null, avatarUrl: p.avatar_url || null, skill: p.skill_level || 0, marketing: p.marketing_opt_in, preview: null };
    box.innerHTML =
      '<div class="eyebrow">' + (first ? "Welcome" : "Your profile") + "</div>" +
      "<h2>" + (first ? "Let's set up your player profile" : "Edit your profile") + "</h2>" +
      '<p class="section-sub">' + (first ? "One quick step before your first tournament. Your name and photo are shown to other players; your phone number is only seen by the organizer." : "Your name and photo are shown to other players; your phone number is only seen by the organizer.") + "</p>" +
      '<form id="pfForm" class="pf-form" novalidate>' +
        '<div class="photo-block"><div class="photo-preview" id="pfPreview"></div><div class="photo-side">' +
          '<div class="photo-btns"><button type="button" class="btn btn-brass" id="pfCam">Take photo</button><button type="button" class="btn btn-ghost" id="pfUp">Upload photo</button></div>' +
          "<small>A clear photo of your face, so the other players know who they're sitting across from.</small></div>" +
          '<input type="file" id="pfFileCam" accept="image/*" capture="user" hidden><input type="file" id="pfFileUp" accept="image/*" hidden></div>' +
        '<div class="field-row"><div class="field"><label for="pfFirst">First name</label><input id="pfFirst" autocomplete="given-name" maxlength="60" value="' + esc(p.first_name) + '"></div>' +
        '<div class="field"><label for="pfLast">Last name</label><input id="pfLast" autocomplete="family-name" maxlength="60" value="' + esc(p.last_name) + '"></div></div>' +
        '<div class="field"><label for="pfEmail">Email</label><input id="pfEmail" type="email" value="' + esc(p.email) + '" readonly><small>This is your sign-in email.</small></div>' +
        '<div class="field"><label for="pfPhone">Phone number</label><input id="pfPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+961 70 123 456" maxlength="30" value="' + esc(p.phone) + '"><small>Include the country code. Only the organizer can see it.</small></div>' +
        '<div class="field"><label for="pfSkill">Skill level</label><div class="skill"><input id="pfSkill" type="range" min="1" max="5" step="1" value="' + (pf.skill || 3) + '"' + (pf.skill ? "" : ' class="untouched"') + '><div class="skill-ticks"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div><output id="pfSkillOut" class="skill-out"></output></div></div>' +
        '<div class="field"><label id="pfMkLabel">Can we send you tournament news and updates?</label><div class="seg" role="radiogroup" aria-labelledby="pfMkLabel">' +
          '<label><input type="radio" name="pfMk" value="yes"' + (p.marketing_opt_in === true ? " checked" : "") + "><span>Yes, keep me posted</span></label>" +
          '<label><input type="radio" name="pfMk" value="no"' + (p.marketing_opt_in === false ? " checked" : "") + "><span>No thanks</span></label></div></div>" +
        '<p class="form-error" id="pfError" role="alert" hidden></p>' +
        '<button type="submit" class="btn btn-brass btn-block" id="pfSave">' + (first ? "Save and continue" : "Save changes") + "</button>" +
      "</form>";

    var name = (p.full_name || p.email);
    function paintPreview() {
      $("pfPreview").innerHTML = pf.preview
        ? '<span class="avatar avatar-xl"><img src="' + esc(pf.preview) + '" alt="Your photo"></span>'
        : avatar(name, pf.avatarUrl, "avatar-xl");
      $("pfCam").textContent = (pf.preview || pf.avatarUrl) ? "Retake photo" : "Take photo";
    }
    function paintSkill() {
      $("pfSkillOut").textContent = pf.skill ? "Level " + pf.skill + " · " + SKILLS[pf.skill - 1] : "Slide to choose your level";
      $("pfSkill").classList.toggle("untouched", !pf.skill);
    }
    function pfError(msg) { var b = $("pfError"); b.textContent = msg; b.hidden = !msg; if (msg) b.scrollIntoView({ block: "center", behavior: "smooth" }); }
    paintPreview(); paintSkill();

    $("pfCam").onclick = function () { $("pfFileCam").click(); };
    $("pfUp").onclick = function () { $("pfFileUp").click(); };
    function picked(input) {
      var f = input.files && input.files[0]; input.value = "";
      if (!f) return;
      pfError("");
      // Save waits for this, so tapping it straight after choosing a photo can't miss the photo.
      pf.processing = processPhoto(f).then(function (blob) {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
        pf.blob = blob; pf.preview = URL.createObjectURL(blob); paintPreview();
      }).catch(function () { pfError("That photo couldn't be read. Please try a different one."); });
    }
    $("pfFileCam").onchange = function () { picked(this); };
    $("pfFileUp").onchange = function () { picked(this); };
    var slider = $("pfSkill");
    ["input", "change", "click", "touchend"].forEach(function (ev) {
      slider.addEventListener(ev, function () { pf.skill = parseInt(slider.value, 10); paintSkill(); });
    });

    $("pfForm").addEventListener("submit", async function (e) {
      e.preventDefault(); pfError("");
      if (pf.processing) await pf.processing;
      var firstN = $("pfFirst").value.trim(), lastN = $("pfLast").value.trim(), phone = $("pfPhone").value.trim();
      var mk = document.querySelector('input[name="pfMk"]:checked');
      var digits = phone.replace(/[^0-9+]/g, "");
      var problem = !firstN || !lastN ? "Please enter your first and last name."
        : !/^\+?[0-9]{7,15}$/.test(digits) ? "Enter a valid phone number, with country code (e.g. +961 70 123 456)."
        : !pf.blob && !pf.avatarUrl ? "Please add a photo so other players know who you are."
        : !pf.skill ? "Slide to pick your skill level."
        : !mk ? "Please answer the updates question." : "";
      if (problem) { pfError(problem); return; }
      var btn = $("pfSave"), label = btn.textContent;
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        if (pf.blob) { pf.avatarUrl = await API.uploadAvatar(state.user.id, pf.blob); pf.blob = null; }
        state.profile = await API.saveProfile({ first: firstN, last: lastN, phone: phone, skill: pf.skill, marketing: mk.value === "yes", avatarUrl: pf.avatarUrl });
        renderAuthSlot(); updateBanner();
        var next = state.afterProfile; state.afterProfile = null;
        if (next) { clearIntent(); toast("Profile saved."); next(); }
        else if (resumeIntent()) { toast("Profile saved."); }
        else if (first) { toast("You're all set. Pick a tournament."); go("events"); }
        else { toast("Profile saved."); btn.disabled = false; btn.textContent = label; }
      } catch (err) { pfError(errMsg(err)); btn.disabled = false; btn.textContent = label; }
    });
  }

  // Centre-crop to a square, shrink to at most 640px, re-encode as JPEG.
  function processPhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h), out = Math.min(640, side);
          if (!side) throw new Error("empty image");
          var cv = document.createElement("canvas"); cv.width = out; cv.height = out;
          var ctx = cv.getContext("2d");
          ctx.fillStyle = "#180F09"; ctx.fillRect(0, 0, out, out);
          ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
          URL.revokeObjectURL(url);
          if (cv.toBlob) cv.toBlob(function (b) { b ? resolve(b) : reject(new Error("encode")); }, "image/jpeg", 0.86);
          else {
            var bin = atob(cv.toDataURL("image/jpeg", 0.86).split(",")[1]), arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            resolve(new Blob([arr], { type: "image/jpeg" }));
          }
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  /* ---------------------------------------------------------------- claim a friend's seat */
  async function renderClaim(token, tk) {
    var box = $("claimContent");
    if (!API.isLive) { needSupabase(box); return; }
    loading(box);
    var res = await Promise.all([API.getInvite(token), loadEvents(true)]);
    if (stale(tk)) return;
    var inv = res[0];
    var homeBtn = '<button class="btn btn-brass" data-nav="events" style="margin-top:16px;">Browse events</button>';
    if (!inv || inv.status === "cancelled") {
      box.innerHTML = emptyState(inv ? "This seat was cancelled" : "This link isn't valid", inv ? "The person who invited you or the organizer cancelled this seat." : "Check that you copied the whole link from the email, or ask your friend to send it again.", homeBtn);
      return;
    }
    var ev = eventBySlug(inv.event_slug);
    var card = '<div class="claim-card"><div class="eyebrow">Your seat</div><h2>' + esc(inv.inviter_name) + " paid for your seat</h2>" +
      '<div class="claim-event"><b>' + esc(inv.event_name) + "</b><span>" + esc(fmtDate(inv.starts_at)) + (inv.venue ? " · " + esc(inv.venue) : "") + "</span></div>";

    if (inv.status === "claimed") {
      var mine = ev && paidEnrollment(ev.id);
      box.innerHTML = card + (mine ? '<p class="modal-text">You claimed this seat. You\'re in!</p><button class="btn btn-brass btn-block" data-nav="event/' + esc(inv.event_slug) + '">View the event</button>'
        : '<p class="modal-text">This seat has already been claimed.</p>' + homeBtn) + "</div>";
      return;
    }
    if (inv.status === "pending") {
      box.innerHTML = card + '<p class="modal-text">The payment for this seat is still being confirmed. Try again in a minute.</p><button class="btn btn-brass btn-block" id="claimAgain">Check again</button></div>';
      $("claimAgain").onclick = function () { route(); };
      return;
    }
    if (inv.event_status !== "open") {
      box.innerHTML = card + '<p class="modal-text">Entry for this event has closed, so the seat can no longer be claimed. Please contact us at ' + esc(C.CONTACT_EMAIL) + ".</p></div>";
      return;
    }
    if (!state.user) {
      box.innerHTML = card + '<p class="modal-text">Create your free account to claim it. You\'ll add your name and a photo. There\'s nothing to pay.</p>' +
        '<button class="btn btn-brass btn-block" id="claimSignup">Create account &amp; claim my seat</button>' +
        '<button class="btn btn-ghost btn-block" id="claimSignin" style="margin-top:10px;">I already have an account</button></div>';
      $("claimSignup").onclick = function () { setIntent({ t: "claim", token: token }); openAuth("signup"); };
      $("claimSignin").onclick = function () { setIntent({ t: "claim", token: token }); openAuth("signin"); };
      return;
    }
    if (!isOnboarded()) {
      box.innerHTML = card + '<p class="modal-text">One more step: tell us who you are (name, phone and a photo) and the seat is yours.</p>' +
        '<button class="btn btn-brass btn-block" id="claimProfile">Complete my profile</button></div>';
      $("claimProfile").onclick = function () {
        setIntent({ t: "claim", token: token });                       // survives a reload while the profile is filled in
        state.afterProfile = function () { go("claim/" + token); };
        go("profile");
      };
      return;
    }
    box.innerHTML = card + '<p class="form-error" id="claimError" role="alert" hidden></p><button class="btn btn-brass btn-block" id="claimGo">Claim my seat</button></div>';
    $("claimGo").onclick = async function () {
      var btn = $("claimGo"); btn.disabled = true; btn.textContent = "Claiming…";
      try {
        await API.claimInvite(token);
        await refreshMine();
        doneSheet("ok", "You're in!", esc("Your seat for " + inv.event_name + " is confirmed. See you at the table."), function () { go("event/" + inv.event_slug); });
      } catch (e) {
        var b = $("claimError"); b.textContent = errMsg(e); b.hidden = false;
        btn.disabled = false; btn.textContent = "Try again";
        if (e.code === "invite_claimed" || e.code === "already_enrolled" || e.code === "event_not_open") setTimeout(function () { route(); }, 1800);
      }
    };
  }

  /* ---------------------------------------------------------------- my events */
  function inviteLink(token) { return location.origin + location.pathname + "#/claim/" + token; }

  async function renderMy(token, silent) {
    var box = $("myContent");
    if (!state.user) {
      box.innerHTML = emptyState("You're not signed in", "Create an account to enroll in tournaments and track your results.", '<button class="btn btn-brass" id="mySignIn" style="margin-top:16px;">Sign in or create account</button>');
      $("mySignIn").onclick = function () { openAuth("signin"); };
      return;
    }
    if (!silent) loading(box);
    var invites = [];
    var res = await Promise.all([loadEvents(true), loadMine(), API.myInvites(state.user.id).catch(function () { return []; })]);
    invites = res[2];
    if (stale(token)) return;

    var p = state.profile || {};
    var rows = state.myEnrollments.filter(function (e) { return e.status === "paid"; })
      .map(function (e) { return { enr: e, ev: eventById(e.event_id) }; }).filter(function (r) { return r.ev; });
    var holds = state.myOrders.filter(function (o) { return new Date(o.hold_expires_at).getTime() > Date.now() && eventById(o.event_id); });

    var html = '<div class="profile-head">' + avatar(p.full_name || state.user.email, p.avatar_url, "avatar-lg") +
      '<div class="ph-text"><div class="profile-name">' + esc(p.full_name || "") + '</div><div class="profile-sub">' + esc(state.user.email) + "</div></div>" +
      (API.isLive ? '<button class="btn btn-ghost btn-sm" data-nav="profile">Edit profile</button>' : "") + "</div>";

    if (API.isLive && state.profile && !isOnboarded()) {
      html += '<div class="note-box note-warn"><h4>Finish your profile</h4><p>Add your phone number and a photo to enroll in tournaments.</p><button class="btn btn-brass btn-sm" data-nav="profile" style="margin-top:12px;">Complete profile</button></div>';
    }

    if (holds.length) {
      html += '<h3 class="my-h">Seats on hold</h3><p class="fineprint" style="margin-top:0;margin-bottom:12px;">Not confirmed yet. Pay before the timer runs out or the seats are released.</p><div class="my-list">' + holds.map(function (o) {
        var ev = eventById(o.event_id), left = new Date(o.hold_expires_at).getTime() - Date.now();
        return '<div class="my-item"><div class="mi-main"><b>' + esc(ev.name) + '</b><span class="sub">' + plural(o.seats, "seat") + " · " + esc(money(o.amount, o.currency)) + '</span></div>' +
          '<span class="hold-time num" data-until="' + esc(o.hold_expires_at) + '">' + fmtClock(left) + "</span>" +
          '<div class="mi-actions"><button class="btn btn-brass btn-sm" data-hold-pay="' + esc(o.id) + '">Pay now</button><button class="btn btn-ghost btn-sm" data-hold-cancel="' + esc(o.id) + '">Cancel</button></div></div>';
      }).join("") + "</div>";
    }

    html += '<h3 class="my-h">My tournaments</h3>';
    html += rows.length ? '<div class="grid-events">' + rows.map(function (r) {
      var place = r.enr.final_place ? '<span class="pill">Finished #' + r.enr.final_place + "</span>" : "";
      return '<div class="card-wrap">' + eventCard(r.ev) + '<div class="card-status"><span class="pill pill-ok">Confirmed</span>' + place + "</div></div>";
    }).join("") + "</div>" : emptyState("No events yet", "Browse the calendar and enroll in your first tournament.", '<button class="btn btn-brass" data-nav="events" style="margin-top:16px;">Browse events</button>');

    if (invites.length) {
      html += '<h3 class="my-h">Friends you\'ve paid for</h3><div class="my-list">' + invites.map(function (i) {
        var ev = eventById(i.event_id), who = i.name ? i.name + " · " + i.email : i.email;
        var claimed = i.status === "claimed";
        return '<div class="my-item"><div class="mi-main"><b>' + esc(who) + '</b><span class="sub">' + esc(ev ? ev.name : "") + "</span></div>" +
          (claimed ? '<span class="pill pill-ok">Claimed</span>' : '<span class="pill pill-warn">Waiting to claim</span>') +
          (claimed ? "" : '<div class="mi-actions">' +
            '<button class="btn btn-ghost btn-sm" data-copy="' + esc(i.token) + '">Copy link</button>' +
            '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent("I paid for your seat at " + (ev ? ev.name : "the tournament") + "! Claim it here: " + inviteLink(i.token)) + '">WhatsApp</a>' +
            '<button class="btn btn-ghost btn-sm" data-resend="' + esc(i.id) + '" data-order="' + esc(i.order_id) + '">' + (i.emailed_at ? "Resend email" : "Send email") + "</button></div>") + "</div>";
      }).join("") + "</div>";
    }
    box.innerHTML = html;
  }

  $("myContent").addEventListener("click", async function (e) {
    var pay = e.target.closest("[data-hold-pay]"), cancel = e.target.closest("[data-hold-cancel]");
    var copy = e.target.closest("[data-copy]"), resend = e.target.closest("[data-resend]");
    if (pay) { payOrder(state.myOrders.filter(function (o) { return o.id === pay.getAttribute("data-hold-pay"); })[0], pay); }
    else if (cancel) { cancelHold(state.myOrders.filter(function (o) { return o.id === cancel.getAttribute("data-hold-cancel"); })[0]); }
    else if (copy) {
      var link = inviteLink(copy.getAttribute("data-copy"));
      try { await copyText(link); toast("Link copied. Paste it into a message."); }
      catch (x) { window.prompt("Copy this link and send it to your friend:", link); }
    } else if (resend) {
      resend.disabled = true;
      try {
        var r = await API.sendInvites(resend.getAttribute("data-order"), resend.getAttribute("data-resend"));
        toast(r.sent ? "Email sent." : "The email couldn't be sent. Share the link instead.");
      } catch (x) { toast(errMsg(x)); }
      resend.disabled = false;
    }
  });

  /* ---------------------------------------------------------------- auth UI */
  var authOverlay = $("authOverlay");
  function openAuth(mode) {
    setAuthMode(mode || "signin"); authOverlay.hidden = false; syncLock();
    setTimeout(function () { var f = mode === "recovery" ? $("authPass") : $("authEmail"); if (f) f.focus(); }, 30);
  }
  function closeAuth() { authOverlay.hidden = true; $("authError").hidden = true; syncLock(); }
  // The person closed the sign-in box themselves: forget what they were about to do
  // (unless they're waiting for a confirmation email, when we need it after they click the link).
  function dismissAuth() {
    if (authOverlay.hidden) return;
    closeAuth();
    if (!state.awaitingConfirm) clearIntent();
  }
  function setAuthMode(mode) {
    state.authMode = mode;
    var signup = mode === "signup", forgot = mode === "forgot", recovery = mode === "recovery";
    $("authTabs").hidden = forgot || recovery;
    document.querySelectorAll("[data-authtab]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-authtab") === mode); });
    $("authNameField").hidden = !signup;
    $("authEmailField").hidden = recovery;
    $("authPassField").hidden = forgot;
    $("authPass").autocomplete = signup || recovery ? "new-password" : "current-password";
    $("authTitle").textContent = { signin: "Sign in", signup: "Create your account", forgot: "Reset your password", recovery: "Choose a new password" }[mode];
    $("authSubmit").textContent = { signin: "Sign In", signup: "Create Account", forgot: "Send reset link", recovery: "Save new password" }[mode];
    $("forgotBtn").parentElement.hidden = mode !== "signin";
    $("authError").hidden = true; $("authError").classList.remove("ok");
  }
  function authMessage(text, ok) { var b = $("authError"); b.textContent = text; b.hidden = false; b.classList.toggle("ok", !!ok); }

  document.querySelectorAll("[data-authtab]").forEach(function (b) { b.addEventListener("click", function () { setAuthMode(b.getAttribute("data-authtab")); }); });
  authOverlay.addEventListener("click", function (e) { if (e.target === authOverlay) dismissAuth(); });
  document.querySelector("[data-close-auth]").addEventListener("click", dismissAuth);
  $("forgotBtn").addEventListener("click", function () { setAuthMode("forgot"); });

  $("authForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var mode = state.authMode, email = $("authEmail").value.trim(), pass = $("authPass").value;
    var first = $("authFirst").value.trim(), last = $("authLast").value.trim();
    var btn = $("authSubmit"), label = btn.textContent;
    if (!API.isLive) { authMessage("Accounts are switched off until Supabase is connected (see README.md).", false); return; }
    if (mode !== "recovery" && !/^\S+@\S+\.\S+$/.test(email)) { authMessage("Enter a valid email address.", false); return; }
    if (mode === "signup" && (!first || !last)) { authMessage("Please enter your first and last name.", false); return; }
    if ((mode === "signup" || mode === "recovery") && pass.length < 8) { authMessage("Use a password with at least 8 characters.", false); return; }
    if (mode === "signin" && !pass) { authMessage("Enter your password.", false); return; }
    btn.disabled = true; btn.textContent = "Please wait…";
    try {
      if (mode === "signin") { await API.signIn(email, pass); closeAuth(); }
      else if (mode === "signup") {
        var r = await API.signUp(first, last, email, pass);
        if (r.needsConfirmation) { state.awaitingConfirm = true; authMessage("Almost there. We sent a confirmation link to " + email + ". Click it and you'll pick up right where you left off.", true); }
        else { closeAuth(); }
      }
      else if (mode === "forgot") { await API.sendPasswordReset(email); authMessage("If that email has an account, a reset link is on its way.", true); }
      else if (mode === "recovery") { await API.setPassword(pass); closeAuth(); toast("Password updated."); }
      $("authForm").reset();
    } catch (err) { authMessage(errMsg(err), false); }
    btn.disabled = false; btn.textContent = label;
  });

  function renderAuthSlot() {
    var slot = $("navAuthSlot");
    if (state.user) {
      var nm = (state.profile && state.profile.full_name) || state.user.email;
      slot.innerHTML = '<div class="userchip"><button type="button" class="chip-btn" data-nav="profile" aria-label="Your profile">' +
        avatar(nm, state.profile && state.profile.avatar_url) + '<span class="chip-name">' + esc(firstName()) + '</span></button>' +
        '<button type="button" class="chip-out" id="signOutBtn">Sign out</button></div>';
      $("signOutBtn").onclick = doSignOut;
    } else {
      slot.innerHTML = '<button class="btn btn-brass btn-sm" id="signInBtn">Sign In</button>';
      $("signInBtn").onclick = function () { openAuth("signin"); };
    }
    var signedIn = !!state.user && API.isLive;
    document.querySelectorAll(".nav-profile").forEach(function (b) { b.hidden = !signedIn; });
    document.querySelectorAll(".nav-signout").forEach(function (b) { b.hidden = !signedIn; });
    document.querySelectorAll(".nav-admin").forEach(function (b) { b.hidden = !state.isAdmin; });
  }

  async function onSession(session, event) {
    var wasUser = state.user && state.user.id;
    // Supabase re-announces SIGNED_IN when a tab regains focus: nothing changed, so leave the page alone.
    if (event === "SIGNED_IN" && session && wasUser === session.user.id) return;
    var seq = ++state.sessSeq;
    state.user = session ? session.user : null;
    state.profile = null; state.isAdmin = false; state.myEnrollments = []; state.myOrders = [];
    if (state.user) {
      try { state.profile = await API.getProfile(state.user.id); state.isAdmin = !!state.profile.is_admin; } catch (e) { /* profile row may lag a moment after sign-up */ }
      try { await loadMine(); } catch (e) { /* ignore */ }
    }
    if (seq !== state.sessSeq) return;                                 // a newer sign-in/out superseded this one
    var fromLink = cameFromAuthLink; cameFromAuthLink = false;
    renderAuthSlot(); updateBanner();
    if (event === "PASSWORD_RECOVERY") { route(); openAuth("recovery"); return; }
    if (event === "SIGNED_OUT") { clearIntent(); toast("Signed out."); }
    if (state.user && (event === "SIGNED_IN" || fromLink) && state.welcomed !== state.user.id) {
      state.welcomed = state.user.id;
      toast("Welcome" + (state.user ? ", " + firstName() : "") + ".");
    }
    if (state.user && resumeIntent()) return;                          // continues the claim / enroll they came for
    if (state.user && state.profile && !isOnboarded() && (event === "SIGNED_IN" || fromLink) && parseRoute() && parseRoute().name !== "claim") {
      go("profile");
      return;
    }
    route();
  }

  /* ---------------------------------------------------------------- admin */
  function requireAdmin(container) {
    if (!API.isLive) { needSupabase(container); return false; }
    if (!state.user) { container.innerHTML = emptyState("Sign in required", "Sign in with your admin account.", '<button class="btn btn-brass" id="adminSignIn" style="margin-top:16px;">Sign in</button>'); $("adminSignIn").onclick = function () { openAuth("signin"); }; return false; }
    if (!state.isAdmin) { container.innerHTML = emptyState("Not an admin", "This account doesn't have organizer access. See README.md, step 3, to make yours an admin."); return false; }
    return true;
  }

  async function renderAdmin(token) {
    var box = $("adminContent");
    $("adminNewEventBtn").hidden = true;
    if (!requireAdmin(box)) return;
    $("adminNewEventBtn").hidden = false;
    loading(box);
    var events = await loadEvents(true);
    if (stale(token)) return;
    box.innerHTML = events.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th class="hide-sm">Date</th><th>Status</th><th>Seats</th><th></th></tr></thead><tbody>' +
      events.map(function (e) {
        return "<tr><td><b>" + esc(e.name) + '</b><div class="sub">' + esc(e.venue) + '</div></td><td class="hide-sm">' + esc(fmtDate(e.starts_at)) + "</td><td>" + statusBadge(e.status) + '</td><td class="num">' + e.taken + " / " + e.max_players +
          '</td><td style="text-align:right;"><a class="btn btn-ghost btn-sm" href="#/admin/' + esc(e.slug) + '">Manage</a></td></tr>';
      }).join("") + "</tbody></table></div>" : emptyState("No events yet", "Create your first tournament.");
  }
  $("adminNewEventBtn").addEventListener("click", function () { openEventForm(null); });

  function toLocalInput(iso) {
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function openEventForm(ev) {
    var v = ev || { name: "", slug: "", venue: "", starts_at: new Date(Date.now() + 14 * 864e5).toISOString(), entry_fee: 25, max_players: 16, description: "", status: "draft", prizes: [200, 120, 80] };
    var pz = prizesOf(v);
    openModal('<div class="modal-head"><h3>' + (ev ? "Edit event" : "New event") + '</h3><button class="modal-close" type="button" data-close-modal aria-label="Close">&times;</button></div>' +
      '<form id="eventForm" novalidate>' +
      '<div class="field"><label for="fName">Name</label><input id="fName" value="' + esc(v.name) + '" placeholder="Hamra Winter Cup"></div>' +
      '<div class="field"><label for="fSlug">Web address</label><input id="fSlug" value="' + esc(v.slug) + '" placeholder="hamra-winter-cup" autocapitalize="off"><small>lebanonbackgammonsociety.com/#/event/<span id="fSlugPreview">' + esc(v.slug) + "</span></small></div>" +
      '<div class="field"><label for="fVenue">Venue</label><input id="fVenue" value="' + esc(v.venue) + '" placeholder="Backroom Lounge, Hamra"></div>' +
      '<div class="field-row"><div class="field"><label for="fStart">Start (your local time)</label><input id="fStart" type="datetime-local" value="' + esc(toLocalInput(v.starts_at)) + '"></div>' +
      '<div class="field"><label for="fStatus">Status</label><select id="fStatus">' + ["draft", "open", "live", "completed", "cancelled"].map(function (s) { return '<option value="' + s + '"' + (s === v.status ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div></div>" +
      '<div class="field-row"><div class="field"><label for="fFee">Entry fee (USD)</label><input id="fFee" type="number" inputmode="decimal" min="0" step="0.5" value="' + esc(v.entry_fee) + '"></div>' +
      '<div class="field"><label for="fMax">Max players</label><input id="fMax" type="number" inputmode="numeric" min="2" max="128" value="' + esc(v.max_players) + '"></div></div>' +
      '<div class="field"><label>Prizes in USD (1st / 2nd / 3rd place)</label><div class="field-row"><input id="fP1" type="number" inputmode="numeric" min="0" step="1" aria-label="1st place prize" value="' + pz[0] + '"><input id="fP2" type="number" inputmode="numeric" min="0" step="1" aria-label="2nd place prize" value="' + pz[1] + '"><input id="fP3" type="number" inputmode="numeric" min="0" step="1" aria-label="3rd place prize" value="' + pz[2] + '"></div><small>Fixed amounts paid to the top three finishers.</small></div>' +
      '<div class="field"><label for="fDesc">Description</label><textarea id="fDesc" rows="3">' + esc(v.description) + "</textarea></div>" +
      '<p class="form-error" id="fError" hidden></p>' +
      '<div class="sheet-actions"><button type="submit" class="btn btn-brass btn-block">' + (ev ? "Save changes" : "Create event") + "</button></div></form>", { sticky: true });
    var slugTouched = !!ev;
    $("fName").addEventListener("input", function () { if (!slugTouched) { $("fSlug").value = slugify($("fName").value); $("fSlugPreview").textContent = $("fSlug").value; } });
    $("fSlug").addEventListener("input", function () { slugTouched = true; $("fSlugPreview").textContent = slugify($("fSlug").value); });
    $("eventForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var err = $("fError"); err.hidden = true;
      var p = [+$("fP1").value, +$("fP2").value, +$("fP3").value];
      var obj = { name: $("fName").value.trim(), slug: slugify($("fSlug").value || $("fName").value), venue: $("fVenue").value.trim(),
        starts_at: $("fStart").value ? new Date($("fStart").value).toISOString() : null, status: $("fStatus").value,
        entry_fee: +$("fFee").value, max_players: parseInt($("fMax").value, 10), description: $("fDesc").value.trim(), prizes: p };
      var problem = !obj.name ? "Give the event a name." : !obj.slug ? "Give the event a web address." : !obj.starts_at ? "Pick a start date and time."
        : !(obj.entry_fee >= 0) ? "Entry fee must be 0 or more." : !(obj.max_players >= 2 && obj.max_players <= 128) ? "Max players must be between 2 and 128."
        : !(p[0] >= 0 && p[1] >= 0 && p[2] >= 0) ? "Prizes must be 0 or more." : "";
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      try {
        var saved = await API.adminSaveEvent(obj, ev && ev.id);
        closeModal(); await loadEvents(true); toast("Saved.");
        if (ev && parseRoute().name === "adminEvent") { go("admin/" + saved.slug); } else go("admin/" + saved.slug);
      } catch (ex) { err.textContent = /duplicate key/.test(errMsg(ex)) ? "That web address is already used by another event." : errMsg(ex); err.hidden = false; }
    });
  }

  var adminCtx = null;   // { event, enrollments, invites, invitesError, orders, reviewOrders, matches }

  async function loadAdminCtx(ev) {
    var res = await Promise.all([
      API.adminEnrollments(ev.id), API.eventDetail(ev.id),
      API.adminInvites(ev.id).then(function (r) { return { rows: r }; }, function (e) { return { rows: [], error: errMsg(e) }; }),
      API.adminOrders(ev.id).catch(function () { return []; }),
      API.adminReviewOrders(ev.id).catch(function () { return []; })
    ]);
    adminCtx = { event: ev, enrollments: res[0], matches: res[1].matches, invites: res[2].rows, invitesError: res[2].error || "", orders: res[3], reviewOrders: res[4] };
  }
  async function renderAdminEvent(slug, token) {
    var box = $("adminEventContent");
    if (!requireAdmin(box)) return;
    loading(box);
    var events = await loadEvents(true);
    var ev = events.filter(function (e) { return e.slug === slug; })[0];
    if (!ev) { box.innerHTML = emptyState("Event not found", ""); return; }
    await loadAdminCtx(ev);
    if (stale(token)) return;
    drawAdminEvent();
  }
  function adminName(id) {
    var e = adminCtx.enrollments.filter(function (x) { return x.user_id === id; })[0];
    return e && e.profiles ? e.profiles.full_name : "Player";
  }
  async function adminReload() {
    var ev = adminCtx.event;
    await loadEvents(true);
    await loadAdminCtx(eventById(ev.id) || ev);
    drawAdminEvent();
  }
  async function adminDo(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await adminReload(); } catch (e) { toast(errMsg(e)); }
  }
  function holdLive(e) { return e.status === "pending_payment" && e.hold_expires_at && new Date(e.hold_expires_at).getTime() > Date.now(); }

  function drawAdminEvent() {
    var ev = adminCtx.event, box = $("adminEventContent"), enr = adminCtx.enrollments, ms = adminCtx.matches;
    var invites = adminCtx.invites, orders = adminCtx.orders || [], review = adminCtx.reviewOrders || [];
    var orderById = {}; orders.forEach(function (o) { orderById[o.id] = o; });
    var paid = enr.filter(function (e) { return e.status === "paid"; }).length;
    var held = enr.filter(holdLive).length;
    var waiting = invites.filter(function (i) { return i.status === "ready"; }).length;
    var collected = orders.filter(function (o) { return o.status === "paid"; }).reduce(function (s, o) { return s + Number(o.amount); }, 0) +
      enr.filter(function (e) { return e.status === "paid" && !e.order_id; }).length * Number(ev.entry_fee);
    var standings = ms.length ? B.finalStandings(ms) : null;

    var actions = "";
    if (ev.status === "draft") actions += '<button class="btn btn-brass btn-sm" data-act="open">Publish · open for entry</button>';
    if (ev.status === "open") {
      actions += '<button class="btn btn-brass btn-sm" data-act="generate">Close entry &amp; build bracket (' + paid + " paid)</button>";
      actions += '<button class="btn btn-ghost btn-sm" data-act="draft">Back to draft</button>';
    }
    if (ev.status === "live") {
      actions += '<button class="btn btn-brass btn-sm" data-act="finish"' + (standings ? "" : " disabled") + ">Finish event &amp; award points</button>";
      actions += '<button class="btn btn-ghost btn-sm" data-act="reset">Reset bracket</button>';
    }
    actions += '<button class="btn btn-ghost btn-sm" data-act="edit">Edit details</button>';
    actions += '<button class="btn btn-ghost btn-sm danger" data-act="delete">Delete</button>';

    // Paid first, then live holds, then holds that ran out.
    var rank = function (e) { return e.status === "paid" ? 0 : holdLive(e) ? 1 : 2; };
    var enrRows = enr.filter(function (e) { return e.status !== "cancelled"; }).sort(function (a, b) { return rank(a) - rank(b); }).map(function (e) {
      var p = e.profiles || {}, isPaid = e.status === "paid", live = holdLive(e);
      var pill = isPaid ? '<span class="pill pill-ok">Paid</span>'
        : live ? '<span class="pill pill-warn">Paying · <span class="num" data-until="' + esc(e.hold_expires_at) + '">' + fmtClock(new Date(e.hold_expires_at).getTime() - Date.now()) + "</span></span>"
        : '<span class="pill">Hold expired</span>';
      var ord = e.order_id && orderById[e.order_id];
      return '<div class="admin-row' + (isPaid || live ? "" : " dim") + '">' + avatar(p.full_name, p.avatar_url, "avatar-md") +
        '<div class="ar-main"><b>' + esc(p.full_name || "—") + '</b><div class="sub">' + esc(p.email || "") +
          (p.phone ? ' · <a href="tel:' + esc(p.phone) + '">' + esc(p.phone) + "</a>" : "") +
          (p.skill_level ? " · skill " + p.skill_level + "/5" : "") + "</div></div>" +
        '<div class="ar-status">' + pill + "</div>" +
        '<div class="ar-actions">' +
        (isPaid ? '<button class="btn btn-ghost btn-sm" data-enr="' + esc(e.id) + '" data-to="pending_payment">Mark unpaid</button>'
          : '<button class="btn btn-brass btn-sm" data-enr="' + esc(e.id) + '" data-to="paid"' + (e.order_id ? ' data-order="' + esc(e.order_id) + '" data-seats="' + (ord ? ord.seats : 1) + '"' : "") + ">Mark paid</button>") +
        ' <button class="btn btn-ghost btn-sm danger" data-enr="' + esc(e.id) + '" data-to="cancelled">Remove</button></div></div>';
    }).join("");

    var inviteRows = invites.map(function (i) {
      var who = i.name ? i.name + " · " + i.email : i.email;
      var status = i.status === "claimed" ? '<span class="pill pill-ok">Claimed' + (i.claimer && i.claimer.full_name ? " by " + esc(i.claimer.full_name) : "") + "</span>"
        : i.status === "ready" ? '<span class="pill pill-warn">Waiting to claim</span>' : '<span class="pill">Awaiting payment</span>';
      return '<div class="admin-row"><div class="ar-main"><b>' + esc(who) + '</b><div class="sub">paid for by ' + esc((i.inviter && i.inviter.full_name) || "—") + (i.status === "ready" ? (i.emailed_at ? " · emailed" : " · not emailed yet") : "") + "</div></div>" +
        '<div class="ar-status">' + status + "</div>" +
        '<div class="ar-actions">' + (i.status === "ready" ? '<button class="btn btn-ghost btn-sm" data-resend="' + esc(i.id) + '" data-order="' + esc(i.order_id) + '">' + (i.emailed_at ? "Resend" : "Send email") + '</button> <button class="btn btn-ghost btn-sm danger" data-cancel-invite="' + esc(i.id) + '">Cancel seat</button>' : "") + "</div></div>";
    }).join("");

    var reviewRows = review.map(function (o) {
      var b = o.buyer || {};
      return '<div class="admin-row"><div class="ar-main"><b>' + esc(b.full_name || "—") + '</b><div class="sub">' + esc(b.email || "") + " · " + plural(o.seats, "seat") + " · " + esc(money(o.amount, o.currency)) + "</div></div></div>";
    }).join("");

    var bracketHtmlAdmin = "";
    if (ms.length) {
      bracketHtmlAdmin = '<h3 class="admin-h">Bracket &amp; results</h3><p class="fineprint">Enter the final score of each match. The higher score wins and moves on. Use "Mark live" to show a match as in progress on the public bracket.</p>' +
        B.toRounds(ms).map(function (r) {
          return '<div class="round-block"><h4>' + esc(r.label) + '</h4><div class="match-admin-grid">' + r.matches.map(function (m) {
            var third = m.round === B.toRounds(ms).length && m.position === 2;
            var a = m.player_a ? adminName(m.player_a) : "TBD", b = m.player_b ? adminName(m.player_b) : "TBD";
            if (m.status === "bye") return '<div class="match-admin bye"><div class="ma-names"><b>' + esc(adminName(m.winner)) + '</b> <span class="pill pill-sm">bye</span></div></div>';
            var ready = m.player_a && m.player_b;
            return '<div class="match-admin ' + m.status + '" data-match="' + m.id + '">' +
              (third ? '<div class="ma-tag">Third place</div>' : "") +
              '<div class="ma-row"><span class="ma-name">' + esc(a) + '</span><input class="ma-score" type="number" inputmode="numeric" min="0" data-side="a" aria-label="Score for ' + esc(a) + '" value="' + (m.score_a == null ? "" : m.score_a) + '"' + (ready ? "" : " disabled") + "></div>" +
              '<div class="ma-row"><span class="ma-name">' + esc(b) + '</span><input class="ma-score" type="number" inputmode="numeric" min="0" data-side="b" aria-label="Score for ' + esc(b) + '" value="' + (m.score_b == null ? "" : m.score_b) + '"' + (ready ? "" : " disabled") + "></div>" +
              '<div class="ma-actions">' + (ready ? '<button class="btn btn-brass btn-sm" data-save="' + m.id + '">' + (m.status === "done" ? "Update result" : "Save result") + "</button>" +
                (m.status !== "done" ? '<button class="btn btn-ghost btn-sm" data-live="' + m.id + '">' + (m.status === "live" ? "Unmark live" : "Mark live") + "</button>" : '<span class="pill pill-ok pill-sm">done</span>') : '<span class="cta-note">Waiting for earlier matches</span>') + "</div></div>";
          }).join("") + "</div></div>";
        }).join("");
    }

    box.innerHTML = '<div class="admin-head"><div><span>' + statusBadge(ev.status) + "</span><h1>" + esc(ev.name) + '</h1><div class="sub">' + esc(fmtDate(ev.starts_at)) + " · " + esc(ev.venue) + " · " + esc(money(ev.entry_fee, ev.currency)) + ' entry · <a href="#/event/' + esc(ev.slug) + '">view public page</a></div></div>' +
      '<div class="admin-actions">' + actions + "</div></div>" +
      '<div class="admin-stats"><div><b>' + paid + "</b><span>paid</span></div><div><b>" + held + "</b><span>paying now</span></div><div><b>" + waiting + "</b><span>friend seats waiting</span></div><div><b>" + ev.max_players + "</b><span>max seats</span></div><div><b>" + esc(money(collected, ev.currency)) + "</b><span>collected</span></div></div>" +
      (review.length ? '<div class="note-box note-warn"><h4>Payments that need your attention</h4><p>These were paid after the seats had already been taken. Refund them in Stripe or make room, and contact the buyer.</p><div class="admin-list" style="margin-top:12px;">' + reviewRows + "</div></div>" : "") +
      '<h3 class="admin-h">Players</h3>' + (enrRows ? '<div class="admin-list">' + enrRows + "</div>" : '<p class="muted-cell">Nobody has enrolled yet.</p>') +
      '<h3 class="admin-h">Friend seats</h3>' + (adminCtx.invitesError ? '<p class="form-error">Couldn\'t load friend seats: ' + esc(adminCtx.invitesError) + "</p>" : inviteRows ? '<div class="admin-list">' + inviteRows + "</div>" : '<p class="muted-cell">Nobody has paid for a friend yet.</p>') +
      bracketHtmlAdmin;
  }

  $("adminEventContent").addEventListener("click", function (e) {
    if (!adminCtx) return;
    var ev = adminCtx.event;
    var act = e.target.closest("[data-act]");
    if (act) {
      var a = act.getAttribute("data-act");
      if (a === "edit") return openEventForm(ev);
      if (a === "open") return adminDo(function () { return API.adminSetEventStatus(ev.id, "open"); }, "Event is now open for entry.");
      if (a === "draft") return adminDo(function () { return API.adminSetEventStatus(ev.id, "draft"); }, "Moved back to draft.");
      if (a === "generate") {
        var paid = adminCtx.enrollments.filter(function (x) { return x.status === "paid"; }).length;
        var pend = adminCtx.enrollments.filter(function (x) { return x.status === "pending_payment"; }).length;
        var unclaimed = adminCtx.invites.filter(function (x) { return x.status === "ready"; }).length;
        var size = B.nextPow2(Math.max(paid, 2));
        if (!confirm("Build the bracket with " + paid + " paid players" + (paid < size ? " (" + (size - paid) + " byes)" : "") + "?" +
          (pend ? "\n\n" + plural(pend, "unpaid reservation") + " will NOT be included." : "") +
          (unclaimed ? "\n\n" + plural(unclaimed, "friend seat") + (unclaimed === 1 ? " hasn't" : " haven't") + " been claimed yet and will NOT be included." : "") + "\n\nEntry will close.")) return;
        return adminDo(function () { return API.adminGenerateBracket(ev.id); }, "Bracket published.");
      }
      if (a === "reset") { if (!confirm("Delete the bracket and all results, and reopen entry?")) return; return adminDo(function () { return API.adminResetBracket(ev.id); }, "Bracket reset."); }
      if (a === "finish") { if (!confirm("Finish the event and award ranking points?")) return; return adminDo(function () { return API.adminFinishEvent(ev.id, adminCtx.matches); }, "Event finished. Rankings updated."); }
      if (a === "delete") {
        if (!confirm("Permanently delete " + ev.name + " and all its enrollments and results?")) return;
        return API.adminDeleteEvent(ev.id).then(function () { toast("Deleted."); return loadEvents(true); }).then(function () { go("admin"); }).catch(function (x) { toast(errMsg(x)); });
      }
    }
    var enrBtn = e.target.closest("[data-enr]");
    if (enrBtn) {
      var to = enrBtn.getAttribute("data-to"), enrId = enrBtn.getAttribute("data-enr"), orderId = enrBtn.getAttribute("data-order");
      if (to === "cancelled" && !confirm("Remove this player from the event? Refund them first if they paid.")) return;
      if (to === "paid" && orderId) {
        var seats = parseInt(enrBtn.getAttribute("data-seats"), 10) || 1;
        if (!confirm("Mark this payment as received?" + (seats > 1 ? "\n\nIt covers " + seats + " seats (theirs and their friends'), so all of them become confirmed." : ""))) return;
        // The whole order is confirmed together, then any friend invites are emailed.
        return adminDo(async function () {
          await API.adminMarkOrderPaid(orderId);
          try { await API.sendInvites(orderId); } catch (x) { /* can be resent from the Friend seats list */ }
        }, "Marked as paid.");
      }
      return adminDo(function () { return API.adminSetEnrollmentStatus(enrId, to); }, "Updated.");
    }
    var resend = e.target.closest("[data-resend]");
    if (resend) {
      return adminDo(async function () {
        var r = await API.sendInvites(resend.getAttribute("data-order"), resend.getAttribute("data-resend"));
        if (!r.sent) throw new Error("The email couldn't be sent.");
      }, "Email sent.");
    }
    var cancelInv = e.target.closest("[data-cancel-invite]");
    if (cancelInv) {
      if (!confirm("Cancel this friend's seat? It frees the seat. Refund the buyer in Stripe if needed.")) return;
      return adminDo(function () { return API.adminCancelInvite(cancelInv.getAttribute("data-cancel-invite")); }, "Seat cancelled.");
    }
    var save = e.target.closest("[data-save]");
    if (save) {
      var card = save.closest(".match-admin"), id = save.getAttribute("data-save");
      var m = adminCtx.matches.filter(function (x) { return x.id === id; })[0];
      var sa = card.querySelector('[data-side="a"]').value, sb = card.querySelector('[data-side="b"]').value;
      if (sa === "" || sb === "") return toast("Enter both scores.");
      sa = parseInt(sa, 10); sb = parseInt(sb, 10);
      if (sa === sb) return toast("Scores can't be tied. Someone has to win.");
      return adminDo(function () {
        return API.adminSaveResult(adminCtx.matches, id, { score_a: sa, score_b: sb, winner: sa > sb ? m.player_a : m.player_b });
      }, "Result saved.");
    }
    var live = e.target.closest("[data-live]");
    if (live) {
      var lid = live.getAttribute("data-live"), lm = adminCtx.matches.filter(function (x) { return x.id === lid; })[0];
      var card2 = live.closest(".match-admin");
      var la = card2.querySelector('[data-side="a"]').value, lb = card2.querySelector('[data-side="b"]').value;
      return adminDo(async function () {
        await API.adminSetMatchLive(lid, lm.status !== "live");
        if (lm.status !== "live") await API.adminUpdateLiveScore(lid, la === "" ? null : +la, lb === "" ? null : +lb);
      }, lm.status === "live" ? "Match unmarked." : "Match is live.");
    }
  });

  /* ---------------------------------------------------------------- start up */
  async function start() {
    $("footerEmail").textContent = C.CONTACT_EMAIL;
    $("footerNote").textContent = API.isLive ? "" : "Sample data · not connected to a database yet";
    $("sampleBanner").hidden = API.isLive;
    renderAuthSlot();

    var recovering = /type=recovery/.test(location.hash);
    // Subscribe before reading the session so a password-reset link's event isn't missed.
    API.onAuthChange(function (event, sess) {
      // The initial load is handled below; only react to real changes here.
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      onSession(sess, event);
    });
    var session = null;
    try { session = await API.getSession(); } catch (e) { /* not signed in */ }
    await onSession(session, recovering ? "PASSWORD_RECOVERY" : "INITIAL");
    if (returnParams) { var rp = returnParams; returnParams = null; await handlePaymentReturn(rp); }
  }
  start();
})();
