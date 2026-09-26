/* Lebanon Backgammon Society - website logic (routing, accounts, enrolling, admin). */
(function () {
  "use strict";

  var C = window.LBS_CONFIG, API = window.LBS_API, B = window.LBS_BRACKET;

  var state = {
    user: null, profile: null, isAdmin: false,
    events: null, myEnrollments: [],
    filter: "all", tab: "overview",
    authMode: "signin", afterAuth: null,
    view: null, token: 0
  };

  /* ---------------------------------------------------------------- helpers */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(name) { return String(name || "?").split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase(); }
  function money(n, cur) { var v = Number(n) || 0; var s = (v % 1 === 0) ? String(v) : v.toFixed(2); return (cur && cur !== "USD" ? cur + " " : "$") + s; }
  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", { timeZone: C.TIMEZONE || "Asia/Beirut", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return iso; }
  }
  function slugify(s) { return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }
  function errMsg(e) { return (e && e.message) || "Something went wrong. Please try again."; }
  function loading(el) { el.innerHTML = '<div class="empty"><p>Loading…</p></div>'; }
  function emptyState(title, text, extra) { return '<div class="empty"><h3>' + esc(title) + "</h3><p>" + esc(text || "") + "</p>" + (extra || "") + "</div>"; }
  function eventBySlug(slug) { return (state.events || []).filter(function (e) { return e.slug === slug; })[0] || null; }
  function eventById(id) { return (state.events || []).filter(function (e) { return e.id === id; })[0] || null; }
  function myEnrollment(eventId) { return state.myEnrollments.filter(function (e) { return e.event_id === eventId; })[0] || null; }
  function paymentsOn(ev) { return C.PAYMENTS_ENABLED && Number(ev.entry_fee) > 0; }

  function statusBadge(status) {
    if (status === "live") return '<span class="badge badge-live"><span class="dot-live" style="width:6px;height:6px;"></span>Live</span>';
    if (status === "completed") return '<span class="badge badge-completed">Completed</span>';
    if (status === "open") return '<span class="badge badge-upcoming">Open for entry</span>';
    if (status === "cancelled") return '<span class="badge badge-muted">Cancelled</span>';
    return '<span class="badge badge-muted">Draft</span>';
  }

  /* ---------------------------------------------------------------- data */
  async function loadEvents(force) {
    if (state.events && !force) return state.events;
    state.events = await API.listEvents();
    return state.events;
  }
  async function loadMyEnrollments() {
    state.myEnrollments = state.user ? await API.myEnrollments(state.user.id) : [];
  }

  /* ---------------------------------------------------------------- router */
  var VIEW_FOR_NAV = { home: "home", events: "events", event: "events", my: "my", admin: "admin", adminEvent: "admin" };

  function navigate(path) { location.hash = "#/" + path; }

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
    setMobileMenu(false);
    window.scrollTo(0, 0);
  }

  async function route() {
    var r = parseRoute();
    if (!r) return;
    var token = ++state.token;
    showView(r.name);
    try {
      if (r.name === "home") await renderHome(token);
      else if (r.name === "events") await renderEvents(token);
      else if (r.name === "event") { state.tab = "overview"; await renderEvent(r.slug, token); }
      else if (r.name === "my") await renderMy(token);
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
      navigate(navBtn.getAttribute("data-nav") === "home" ? "" : navBtn.getAttribute("data-nav"));
      return;
    }
    var card = e.target.closest("[data-open-event]");
    if (card) navigate("event/" + card.getAttribute("data-open-event"));
  });
  window.addEventListener("hashchange", route);

  /* ---------------------------------------------------------------- mobile menu */
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
        '<div style="text-align:right;"><div class="fee">' + esc(money(ev.entry_fee * (ev.paid || 0), ev.currency)) + '</div><div class="fee-sub">prize pool</div></div>' +
      "</div></div>";
  }
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-open-event]")) {
      e.preventDefault(); navigate("event/" + e.target.getAttribute("data-open-event"));
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
      pill.onclick = function () { navigate("event/" + live[0].slug); };
    } else { pill.style.display = "none"; }

    var list = live.concat(open).slice(0, 6);
    $("homeEventsGrid").innerHTML = list.length ? list.map(eventCard).join("")
      : emptyState("No tournaments yet", "New events are announced here - check back soon.");

    $("rankingsBody").innerHTML = ranks.length ? ranks.map(function (r, i) {
      return '<tr><td class="rank-num">#' + (i + 1) + "</td>" +
        '<td><div class="player-cell"><div class="avatar avatar-muted">' + esc(initials(r.full_name)) + "</div>" + esc(r.full_name) + "</div></td>" +
        '<td class="num">' + r.events_played + "</td>" +
        '<td class="num">' + (r.best_place ? "#" + r.best_place : "—") + "</td>" +
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
  function matchHtml(m, nameOf, tag) {
    var a = m.player_a ? nameOf(m.player_a) : "TBD", b = m.player_b ? nameOf(m.player_b) : "TBD";
    var t = tag ? '<div class="match-tag muted-tag">' + esc(tag) + "</div>" : "";
    if (m.status === "bye") {
      return '<div class="match done bye-match"><div class="match-tag muted-tag">Bye</div>' +
        '<div class="slot winner"><span class="slot-name">' + esc(nameOf(m.winner)) + '</span><span class="slot-score">W</span></div>' +
        '<div class="slot faded"><span class="slot-name">— no opponent —</span></div></div>';
    }
    if (m.status === "pending") {
      return '<div class="match tbd">' + t +
        '<div class="slot"><span class="slot-name' + (m.player_a ? "" : " ph") + '">' + esc(a) + "</span></div>" +
        '<div class="slot"><span class="slot-name' + (m.player_b ? "" : " ph") + '">' + esc(b) + "</span></div></div>";
    }
    var live = m.status === "live";
    var aWin = m.winner && m.winner === m.player_a, bWin = m.winner && m.winner === m.player_b;
    var sa = m.score_a == null ? "" : m.score_a, sb = m.score_b == null ? "" : m.score_b;
    return '<div class="match ' + (live ? "live" : "done") + '">' + (live ? '<div class="match-tag">● Live</div>' : t) +
      '<div class="slot ' + (aWin ? "winner" : "") + '"><span class="slot-name">' + esc(a) + '</span><span class="slot-score">' + sa + "</span></div>" +
      '<div class="slot ' + (bWin ? "winner" : "") + '"><span class="slot-name">' + esc(b) + '</span><span class="slot-score">' + sb + "</span></div></div>";
  }
  function bracketHtml(matches, nameOf) {
    var rounds = B.toRounds(matches);
    var cols = rounds.map(function (r, idx) {
      var last = idx === rounds.length - 1;
      var body;
      if (last) {
        var fin = r.matches.filter(function (m) { return m.position === 1; })[0];
        var third = r.matches.filter(function (m) { return m.position === 2; })[0];
        var champ = fin && fin.status === "done" ? nameOf(fin.winner) : null;
        body = matchHtml(fin, nameOf) +
          '<div class="match champion"><div class="champion-slot">' + trophySvg("#C6A15B") +
          (champ ? "<b>" + esc(champ) + "</b><span>Champion</span>" : '<b class="ph">TBD</b><span>Champion</span>') + "</div></div>" +
          (third ? matchHtml(third, nameOf, "Third place") : "");
      } else {
        body = r.matches.map(function (m) { return matchHtml(m, nameOf); }).join("");
      }
      return '<div class="bracket-round"><div class="round-title">' + esc(r.label) + '</div><div class="round-col">' + body + "</div></div>";
    }).join("");
    return '<div class="bracket-scroll"><div class="bracket">' + cols + "</div></div>";
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
  var current = null;   // { event, detail, names }

  async function renderEvent(slug, token) {
    $("edPanels").innerHTML = '<div class="empty"><p>Loading…</p></div>';
    await loadEvents();
    var ev = eventBySlug(slug);
    if (!ev) { $("edTitle").textContent = "Event not found"; $("edPanels").innerHTML = emptyState("We couldn't find that event", "It may have been removed.", '<button class="btn btn-brass" data-nav="events" style="margin-top:16px;">Browse events</button>'); $("edCtaBox").innerHTML = ""; return; }
    if (state.user) await loadMyEnrollments();
    var detail = await API.eventDetail(ev.id);
    if (stale(token)) return;
    var names = {};
    detail.players.forEach(function (p) { names[p.user_id] = p.name; });
    current = { event: ev, detail: detail, names: names };
    drawEvent();
  }

  function poolFor(ev, detail) {
    var paid = detail.players.filter(function (p) { return p.status === "paid"; }).length;
    return Number(ev.entry_fee) * (ev.status === "open" ? Math.max(paid, 0) : paid);
  }

  function drawEvent() {
    var ev = current.event, detail = current.detail;
    $("edBadgeSlot").innerHTML = statusBadge(ev.status);
    $("edTitle").textContent = ev.name;
    $("edVenue").textContent = ev.venue || "To be announced";
    $("edDate").textContent = fmtDate(ev.starts_at);
    $("edFee").textContent = money(ev.entry_fee, ev.currency);
    $("edPool").textContent = money(poolFor(ev, detail), ev.currency);
    $("edPlayers").textContent = ev.taken + " / " + ev.max_players;
    document.title = ev.name + " — Lebanon Backgammon Society";

    var hasBracket = detail.matches.length > 0;
    document.querySelectorAll("#edTabs button").forEach(function (b) {
      var t = b.getAttribute("data-tab");
      b.style.display = (t === "bracket" && !hasBracket) ? "none" : "";
      b.classList.toggle("active", t === state.tab);
    });
    drawCta();
    drawPanel();
  }

  function drawCta() {
    var ev = current.event, box = $("edCtaBox"), enr = myEnrollment(ev.id);
    var fee = money(ev.entry_fee, ev.currency);
    if (ev.status === "completed") {
      var champ = current.detail.players.filter(function (p) { return p.final_place === 1; })[0];
      box.innerHTML = champ ? '<div class="champ-line"><span>Champion</span><b>' + esc(champ.name) + "</b></div>" : "";
      return;
    }
    if (ev.status === "cancelled") { box.innerHTML = '<button class="btn btn-ghost" disabled>Cancelled</button>'; return; }
    if (enr && enr.status === "paid") { box.innerHTML = '<button class="btn btn-ghost" disabled>✓ You\'re enrolled</button>'; return; }
    if (ev.status === "live") { box.innerHTML = '<button class="btn btn-ghost" disabled>Bracket in progress</button>'; return; }
    if (ev.status !== "open") { box.innerHTML = '<button class="btn btn-ghost" disabled>Not open yet</button>'; return; }
    if (enr && enr.status === "pending_payment") {
      box.innerHTML = '<div class="cta-stack"><span class="pill pill-warn">Seat reserved · payment pending</span>' +
        (paymentsOn(ev) ? '<button class="btn btn-brass" id="edPayBtn">Pay ' + esc(fee) + " now</button>" : '<p class="cta-note">' + esc(C.PAYMENT_INSTRUCTIONS) + "</p>") +
        '<button class="btn-link" id="edCancelBtn">Cancel reservation</button></div>';
      if ($("edPayBtn")) $("edPayBtn").onclick = function () { payNow(ev); };
      $("edCancelBtn").onclick = function () { cancelReservation(ev); };
      return;
    }
    if (ev.taken >= ev.max_players) { box.innerHTML = '<button class="btn btn-ghost" disabled>Seats full</button>'; return; }
    box.innerHTML = '<button class="btn btn-brass" id="edEnrollBtn">' + (state.user ? "Enroll — " : "Sign in to enroll — ") + esc(fee) + "</button>";
    $("edEnrollBtn").onclick = function () { startEnroll(ev); };
  }

  $("edTabs").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b || !current) return;
    state.tab = b.getAttribute("data-tab");
    document.querySelectorAll("#edTabs button").forEach(function (x) { x.classList.toggle("active", x === b); });
    drawPanel();
  });

  function drawPanel() {
    var ev = current.event, d = current.detail, panel = $("edPanels");
    var nameOf = function (id) { return current.names[id] || "Player"; };

    if (state.tab === "overview") {
      var how = ev.status === "open"
        ? '<div class="note-box"><h4>How entry works</h4><p>' + (paymentsOn(ev)
            ? "Enroll to reserve a seat, then pay the " + esc(money(ev.entry_fee, ev.currency)) + " entry fee online to confirm it."
            : "Enroll to reserve a seat. " + esc(C.PAYMENT_INSTRUCTIONS)) +
          " When entry closes, players are seeded and the bracket is published here — if the field isn't a full power of two, the top seeds get byes.</p></div>" : "";
      panel.innerHTML = '<div class="prose"><p>' + esc(ev.description || "Details coming soon.") + "</p>" + how + "</div>";
      return;
    }
    if (state.tab === "bracket") {
      panel.innerHTML = d.matches.length ? bracketHtml(d.matches, nameOf)
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
      var pool = poolFor(ev, d), split = ev.prize_split || [50, 30, 20];
      var amt = function (i) { return Math.round(pool * (split[i] || 0) / 100 * 100) / 100; };
      var place = function (n) { return d.players.filter(function (p) { return p.final_place === n; })[0]; };
      panel.innerHTML = '<div class="prize-grid">' + [0, 1, 2].map(function (i) {
        var p = place(i + 1);
        return '<div class="prize-card ' + (i === 0 ? "gold" : "") + '">' + trophySvg(["#C6A15B", "#C9BBA3", "#B08A56"][i]) +
          '<div class="place">' + ["1st", "2nd", "3rd"][i] + ' place</div><div class="amt">' + esc(money(amt(i), ev.currency)) + '</div><div class="who">' +
          (p ? esc(p.name) : split[i] + "% of the pool") + "</div></div>";
      }).join("") + "</div>" +
      '<p class="fineprint">Prize pool is the entry fees from confirmed players (' + d.players.filter(function (p) { return p.status === "paid"; }).length + " × " + esc(money(ev.entry_fee, ev.currency)) + ").</p>";
      return;
    }
    if (state.tab === "players") {
      panel.innerHTML = d.players.length ? '<div class="players-grid">' + d.players.slice().sort(function (a, b) { return (a.seed || 999) - (b.seed || 999); }).map(function (p, i) {
        return '<div class="player-row"><span class="seed num">' + (p.seed || i + 1) + '</span><div class="avatar avatar-sm">' + esc(initials(p.name)) + '</div><span class="pname">' + esc(p.name) + "</span>" +
          (p.status === "pending_payment" ? '<span class="pill pill-warn pill-sm">reserved</span>' : "") + "</div>";
      }).join("") + "</div>" : emptyState("No players yet", "Be the first to enroll.");
    }
  }

  /* ---------------------------------------------------------------- enrolling */
  function openModal(html) { $("modalInner").innerHTML = html; $("modalOverlay").hidden = false; }
  function closeModal() { $("modalOverlay").hidden = true; $("modalInner").innerHTML = ""; }
  $("modalOverlay").addEventListener("click", function (e) { if (e.target === $("modalOverlay")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeModal(); closeAuth(); } });

  function startEnroll(ev) {
    if (!state.user) { state.afterAuth = function () { startEnroll(ev); }; openAuth("signup"); return; }
    var fee = money(ev.entry_fee, ev.currency);
    openModal(
      '<div class="modal-head"><h3>Enroll in ' + esc(ev.name) + '</h3><button class="modal-close" type="button" data-close-modal aria-label="Close">&times;</button></div>' +
      '<div class="pay-summary"><div><span>Entrance fee</span><b>' + esc(fee) + '</b></div><div class="pay-meta">' + esc(ev.venue) + "<br>" + esc(fmtDate(ev.starts_at)) + "</div></div>" +
      '<p class="modal-text">' + (Number(ev.entry_fee) === 0 ? "This event is free - you'll be enrolled straight away."
        : paymentsOn(ev) ? "We'll reserve your seat, then take you to a secure checkout to pay. Your seat is confirmed once payment goes through."
        : "We'll reserve your seat now. " + esc(C.PAYMENT_INSTRUCTIONS)) + "</p>" +
      '<p class="form-error" id="enrollError" hidden></p>' +
      '<button class="btn btn-brass" id="enrollConfirm" style="width:100%;">' + (paymentsOn(ev) ? "Reserve &amp; continue to payment" : "Reserve my seat") + "</button>");
    $("enrollConfirm").onclick = async function () {
      var btn = $("enrollConfirm"); btn.disabled = true; btn.textContent = "Reserving…";
      try {
        var row = await API.enroll(ev.id);
        await Promise.all([loadEvents(true), loadMyEnrollments()]);
        current && current.event.id === ev.id && (current.event = eventById(ev.id));
        if (row.status === "paid") { enrolledDone(ev, "You're in!", "You're enrolled in " + ev.name + ". See you at the table."); }
        else if (paymentsOn(ev)) { btn.textContent = "Opening checkout…"; location.href = await API.startCheckout(ev.id); return; }
        else { enrolledDone(ev, "Seat reserved", C.PAYMENT_INSTRUCTIONS); }
      } catch (e) {
        var box = $("enrollError"); box.textContent = errMsg(e); box.hidden = false;
        btn.disabled = false; btn.textContent = "Try again";
      }
    };
  }
  function enrolledDone(ev, title, text) {
    openModal('<div class="success-box"><svg viewBox="0 0 24 24" fill="none" stroke="#82B58F" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg><h3>' + esc(title) + "</h3><p>" + esc(text) + '</p><button class="btn btn-brass" id="doneBtn" style="width:100%;">Done</button></div>');
    $("doneBtn").onclick = function () { closeModal(); route(); };
  }
  async function payNow(ev) {
    try { toast("Opening checkout…"); location.href = await API.startCheckout(ev.id); } catch (e) { toast(errMsg(e)); }
  }
  async function cancelReservation(ev) {
    if (!confirm("Cancel your reservation for " + ev.name + "?")) return;
    try {
      await API.cancelEnrollment(ev.id);
      await Promise.all([loadEvents(true), loadMyEnrollments()]);
      toast("Reservation cancelled."); route();
    } catch (e) { toast(errMsg(e)); }
  }
  document.addEventListener("click", function (e) { if (e.target.closest("[data-close-modal]")) closeModal(); });

  /* ---------------------------------------------------------------- my events */
  async function renderMy(token) {
    var box = $("myContent");
    if (!state.user) {
      box.innerHTML = emptyState("You're not signed in", "Create an account to enroll in tournaments and track your results.", '<button class="btn btn-brass" id="mySignIn" style="margin-top:16px;">Sign in or create account</button>');
      $("mySignIn").onclick = function () { openAuth("signin"); };
      return;
    }
    loading(box);
    await Promise.all([loadEvents(true), loadMyEnrollments()]);
    if (stale(token)) return;
    var rows = state.myEnrollments.filter(function (e) { return e.status !== "cancelled"; })
      .map(function (e) { return { enr: e, ev: eventById(e.event_id) }; })
      .filter(function (r) { return r.ev; });
    var head = '<div class="profile-head"><div class="avatar avatar-lg">' + esc(initials(state.profile ? state.profile.full_name : state.user.email)) + "</div>" +
      "<div><div class=\"profile-name\">" + esc(state.profile ? state.profile.full_name : "") + '</div><div class="profile-sub">' + esc(state.user.email) + " · " + rows.length + " event" + (rows.length === 1 ? "" : "s") + "</div></div></div>";
    if (!rows.length) {
      box.innerHTML = head + emptyState("No events yet", "Browse the calendar and enroll in your first tournament.", '<button class="btn btn-brass" data-nav="events" style="margin-top:16px;">Browse events</button>');
      return;
    }
    box.innerHTML = head + '<div class="grid-events">' + rows.map(function (r) {
      var s = r.enr.status === "paid" ? '<span class="pill pill-ok">Confirmed</span>' : '<span class="pill pill-warn">Payment pending</span>';
      var place = r.enr.final_place ? '<span class="pill">Finished #' + r.enr.final_place + "</span>" : "";
      return '<div class="card-wrap">' + eventCard(r.ev) + '<div class="card-status">' + s + place + "</div></div>";
    }).join("") + "</div>";
  }

  /* ---------------------------------------------------------------- auth UI */
  var authOverlay = $("authOverlay");
  function openAuth(mode) { setAuthMode(mode || "signin"); authOverlay.hidden = false; setTimeout(function () { var f = mode === "recovery" ? $("authPass") : $("authEmail"); f && f.focus(); }, 30); }
  function closeAuth() { authOverlay.hidden = true; $("authError").hidden = true; }
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
  authOverlay.addEventListener("click", function (e) { if (e.target === authOverlay) closeAuth(); });
  document.querySelector("[data-close-auth]").addEventListener("click", closeAuth);
  $("forgotBtn").addEventListener("click", function () { setAuthMode("forgot"); });

  $("authForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var mode = state.authMode, email = $("authEmail").value.trim(), pass = $("authPass").value, name = $("authName").value.trim();
    var btn = $("authSubmit"), label = btn.textContent;
    if (!API.isLive) { authMessage("Accounts are switched off until Supabase is connected (see README.md).", false); return; }
    if (mode !== "recovery" && !/^\S+@\S+\.\S+$/.test(email)) { authMessage("Enter a valid email address.", false); return; }
    if (mode === "signup" && !name) { authMessage("Please enter your full name.", false); return; }
    if ((mode === "signup" || mode === "recovery") && pass.length < 8) { authMessage("Use a password with at least 8 characters.", false); return; }
    if (mode === "signin" && !pass) { authMessage("Enter your password.", false); return; }
    btn.disabled = true; btn.textContent = "Please wait…";
    try {
      if (mode === "signin") { await API.signIn(email, pass); closeAuth(); }
      else if (mode === "signup") {
        var r = await API.signUp(name, email, pass);
        if (r.needsConfirmation) { authMessage("Almost there - we sent a confirmation link to " + email + ". Click it, then sign in.", true); }
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
      slot.innerHTML = '<div class="userchip"><div class="avatar">' + esc(initials(nm)) + '</div><span class="chip-name">' + esc(nm.split(" ")[0]) + '</span><button type="button" id="signOutBtn">Sign out</button></div>';
      $("signOutBtn").onclick = async function () { await API.signOut(); };
    } else {
      slot.innerHTML = '<button class="btn btn-brass btn-sm" id="signInBtn">Sign In</button>';
      $("signInBtn").onclick = function () { openAuth("signin"); };
    }
    document.querySelectorAll(".nav-admin").forEach(function (b) { b.hidden = !state.isAdmin; });
  }

  async function onSession(session, event) {
    var wasUser = state.user && state.user.id;
    state.user = session ? session.user : null;
    state.profile = null; state.isAdmin = false; state.myEnrollments = [];
    if (state.user) {
      try { state.profile = await API.getProfile(state.user.id); state.isAdmin = !!state.profile.is_admin; } catch (e) { /* profile row may lag a moment after sign-up */ }
      try { await loadMyEnrollments(); } catch (e) { /* ignore */ }
    }
    renderAuthSlot();
    if (event === "PASSWORD_RECOVERY") { route(); openAuth("recovery"); return; }
    if (event === "SIGNED_IN" && !wasUser && state.user) {
      toast("Welcome" + (state.profile ? ", " + state.profile.full_name.split(" ")[0] : "") + ".");
      var next = state.afterAuth; state.afterAuth = null;
      await route();
      if (next) next();
      return;
    }
    if (event === "SIGNED_OUT") { toast("Signed out."); }
    route();
  }

  /* ---------------------------------------------------------------- admin */
  function requireAdmin(container) {
    if (!API.isLive) { container.innerHTML = emptyState("Connect Supabase first", "The admin dashboard needs the database. Follow README.md, step 1."); return false; }
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
    box.innerHTML = events.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Seats</th><th></th></tr></thead><tbody>' +
      events.map(function (e) {
        return "<tr><td><b>" + esc(e.name) + '</b><div class="sub">' + esc(e.venue) + "</div></td><td>" + esc(fmtDate(e.starts_at)) + "</td><td>" + statusBadge(e.status) + '</td><td class="num">' + e.taken + " / " + e.max_players +
          '</td><td style="text-align:right;"><a class="btn btn-ghost btn-sm" href="#/admin/' + esc(e.slug) + '">Manage</a></td></tr>';
      }).join("") + "</tbody></table></div>" : emptyState("No events yet", "Create your first tournament.");
  }
  $("adminNewEventBtn").addEventListener("click", function () { openEventForm(null); });

  function toLocalInput(iso) {
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function openEventForm(ev) {
    var v = ev || { name: "", slug: "", venue: "", starts_at: new Date(Date.now() + 14 * 864e5).toISOString(), entry_fee: 25, max_players: 16, description: "", status: "draft", prize_split: [50, 30, 20] };
    var split = v.prize_split || [50, 30, 20];
    openModal('<div class="modal-head"><h3>' + (ev ? "Edit event" : "New event") + '</h3><button class="modal-close" type="button" data-close-modal aria-label="Close">&times;</button></div>' +
      '<form id="eventForm" novalidate>' +
      '<div class="field"><label for="fName">Name</label><input id="fName" value="' + esc(v.name) + '" placeholder="Hamra Winter Cup"></div>' +
      '<div class="field"><label for="fSlug">Web address</label><input id="fSlug" value="' + esc(v.slug) + '" placeholder="hamra-winter-cup"><small>lebanonbackgammonsociety.com/#/event/<span id="fSlugPreview">' + esc(v.slug) + "</span></small></div>" +
      '<div class="field"><label for="fVenue">Venue</label><input id="fVenue" value="' + esc(v.venue) + '" placeholder="Backroom Lounge, Hamra"></div>' +
      '<div class="field-row"><div class="field"><label for="fStart">Start (your local time)</label><input id="fStart" type="datetime-local" value="' + esc(toLocalInput(v.starts_at)) + '"></div>' +
      '<div class="field"><label for="fStatus">Status</label><select id="fStatus">' + ["draft", "open", "live", "completed", "cancelled"].map(function (s) { return '<option value="' + s + '"' + (s === v.status ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div></div>" +
      '<div class="field-row"><div class="field"><label for="fFee">Entry fee (USD)</label><input id="fFee" type="number" min="0" step="0.5" value="' + esc(v.entry_fee) + '"></div>' +
      '<div class="field"><label for="fMax">Max players</label><input id="fMax" type="number" min="2" max="128" value="' + esc(v.max_players) + '"></div></div>' +
      '<div class="field"><label>Prize split % (1st / 2nd / 3rd, must total 100)</label><div class="field-row"><input id="fP1" type="number" min="0" value="' + split[0] + '"><input id="fP2" type="number" min="0" value="' + split[1] + '"><input id="fP3" type="number" min="0" value="' + split[2] + '"></div></div>' +
      '<div class="field"><label for="fDesc">Description</label><textarea id="fDesc" rows="3">' + esc(v.description) + "</textarea></div>" +
      '<p class="form-error" id="fError" hidden></p>' +
      '<button type="submit" class="btn btn-brass" style="width:100%;">' + (ev ? "Save changes" : "Create event") + "</button></form>");
    var slugTouched = !!ev;
    $("fName").addEventListener("input", function () { if (!slugTouched) { $("fSlug").value = slugify($("fName").value); $("fSlugPreview").textContent = $("fSlug").value; } });
    $("fSlug").addEventListener("input", function () { slugTouched = true; $("fSlugPreview").textContent = slugify($("fSlug").value); });
    $("eventForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var err = $("fError"); err.hidden = true;
      var p = [+$("fP1").value, +$("fP2").value, +$("fP3").value];
      var obj = { name: $("fName").value.trim(), slug: slugify($("fSlug").value || $("fName").value), venue: $("fVenue").value.trim(),
        starts_at: $("fStart").value ? new Date($("fStart").value).toISOString() : null, status: $("fStatus").value,
        entry_fee: +$("fFee").value, max_players: parseInt($("fMax").value, 10), description: $("fDesc").value.trim(), prize_split: p };
      var problem = !obj.name ? "Give the event a name." : !obj.slug ? "Give the event a web address." : !obj.starts_at ? "Pick a start date and time."
        : !(obj.entry_fee >= 0) ? "Entry fee must be 0 or more." : !(obj.max_players >= 2 && obj.max_players <= 128) ? "Max players must be between 2 and 128."
        : (p[0] + p[1] + p[2] !== 100) ? "The prize split must add up to 100." : "";
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      try {
        var saved = await API.adminSaveEvent(obj, ev && ev.id);
        closeModal(); await loadEvents(true); toast("Saved.");
        if (ev && parseRoute().name === "adminEvent") { navigate("admin/" + saved.slug); route(); } else navigate("admin/" + saved.slug);
      } catch (ex) { err.textContent = /duplicate key/.test(errMsg(ex)) ? "That web address is already used by another event." : errMsg(ex); err.hidden = false; }
    });
  }

  var adminCtx = null;   // { event, enrollments, matches, names }

  async function renderAdminEvent(slug, token) {
    var box = $("adminEventContent");
    if (!requireAdmin(box)) return;
    loading(box);
    var events = await loadEvents(true);
    var ev = events.filter(function (e) { return e.slug === slug; })[0];
    if (!ev) { box.innerHTML = emptyState("Event not found", ""); return; }
    var res = await Promise.all([API.adminEnrollments(ev.id), API.eventDetail(ev.id)]);
    if (stale(token)) return;
    adminCtx = { event: ev, enrollments: res[0], matches: res[1].matches };
    drawAdminEvent();
  }
  function adminName(id) {
    var e = adminCtx.enrollments.filter(function (x) { return x.user_id === id; })[0];
    return e && e.profiles ? e.profiles.full_name : "Player";
  }
  async function adminReload() {
    var ev = adminCtx.event;
    await loadEvents(true);
    ev = eventById(ev.id) || ev;
    var res = await Promise.all([API.adminEnrollments(ev.id), API.eventDetail(ev.id)]);
    adminCtx = { event: ev, enrollments: res[0], matches: res[1].matches };
    drawAdminEvent();
  }
  async function adminDo(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await adminReload(); } catch (e) { toast(errMsg(e)); }
  }

  function drawAdminEvent() {
    var ev = adminCtx.event, box = $("adminEventContent"), enr = adminCtx.enrollments, ms = adminCtx.matches;
    var paid = enr.filter(function (e) { return e.status === "paid"; }).length;
    var pending = enr.filter(function (e) { return e.status === "pending_payment"; }).length;
    var standings = ms.length ? B.finalStandings(ms) : null;

    var actions = "";
    if (ev.status === "draft") actions += '<button class="btn btn-brass btn-sm" data-act="open">Publish - open for entry</button>';
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

    var enrRows = enr.filter(function (e) { return e.status !== "cancelled"; }).map(function (e) {
      var p = e.profiles || {};
      return "<tr><td><b>" + esc(p.full_name || "—") + '</b><div class="sub">' + esc(p.email || "") + "</div></td><td>" +
        (e.status === "paid" ? '<span class="pill pill-ok">Paid</span>' : '<span class="pill pill-warn">Awaiting payment</span>') + "</td>" +
        '<td style="text-align:right; white-space:nowrap;">' +
        (e.status === "paid" ? '<button class="btn btn-ghost btn-sm" data-enr="' + e.id + '" data-to="pending_payment">Mark unpaid</button>' : '<button class="btn btn-brass btn-sm" data-enr="' + e.id + '" data-to="paid">Mark paid</button>') +
        ' <button class="btn btn-ghost btn-sm danger" data-enr="' + e.id + '" data-to="cancelled">Remove</button></td></tr>';
    }).join("");

    var bracketHtmlAdmin = "";
    if (ms.length) {
      bracketHtmlAdmin = '<h3 class="admin-h">Bracket &amp; results</h3><p class="fineprint">Enter the final score of each match - the higher score wins and moves on. Use "Mark live" to show a match as in progress on the public bracket.</p>' +
        B.toRounds(ms).map(function (r) {
          return '<div class="round-block"><h4>' + esc(r.label) + '</h4><div class="match-admin-grid">' + r.matches.map(function (m) {
            var third = m.round === B.toRounds(ms).length && m.position === 2;
            var a = m.player_a ? adminName(m.player_a) : "TBD", b = m.player_b ? adminName(m.player_b) : "TBD";
            if (m.status === "bye") return '<div class="match-admin bye"><div class="ma-names"><b>' + esc(adminName(m.winner)) + '</b> <span class="pill pill-sm">bye</span></div></div>';
            var ready = m.player_a && m.player_b;
            return '<div class="match-admin ' + m.status + '" data-match="' + m.id + '">' +
              (third ? '<div class="ma-tag">Third place</div>' : "") +
              '<div class="ma-row"><span class="ma-name">' + esc(a) + '</span><input class="ma-score" type="number" min="0" data-side="a" value="' + (m.score_a == null ? "" : m.score_a) + '"' + (ready ? "" : " disabled") + "></div>" +
              '<div class="ma-row"><span class="ma-name">' + esc(b) + '</span><input class="ma-score" type="number" min="0" data-side="b" value="' + (m.score_b == null ? "" : m.score_b) + '"' + (ready ? "" : " disabled") + "></div>" +
              '<div class="ma-actions">' + (ready ? '<button class="btn btn-brass btn-sm" data-save="' + m.id + '">' + (m.status === "done" ? "Update result" : "Save result") + "</button>" +
                (m.status !== "done" ? '<button class="btn btn-ghost btn-sm" data-live="' + m.id + '">' + (m.status === "live" ? "Unmark live" : "Mark live") + "</button>" : '<span class="pill pill-ok pill-sm">done</span>') : '<span class="cta-note">Waiting for earlier matches</span>') + "</div></div>";
          }).join("") + "</div></div>";
        }).join("");
    }

    box.innerHTML = '<div class="admin-head"><div><span>' + statusBadge(ev.status) + "</span><h1>" + esc(ev.name) + '</h1><div class="sub">' + esc(fmtDate(ev.starts_at)) + " · " + esc(ev.venue) + " · " + esc(money(ev.entry_fee, ev.currency)) + ' entry · <a href="#/event/' + esc(ev.slug) + '">view public page</a></div></div>' +
      '<div class="admin-actions">' + actions + "</div></div>" +
      '<div class="admin-stats"><div><b>' + paid + "</b><span>paid</span></div><div><b>" + pending + "</b><span>awaiting payment</span></div><div><b>" + ev.max_players + "</b><span>max seats</span></div><div><b>" + esc(money(paid * ev.entry_fee, ev.currency)) + "</b><span>collected</span></div></div>" +
      '<h3 class="admin-h">Players</h3>' + (enrRows ? '<div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Payment</th><th></th></tr></thead><tbody>' + enrRows + "</tbody></table></div>" : '<p class="muted-cell">Nobody has enrolled yet.</p>') +
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
        var size = B.nextPow2(Math.max(paid, 2));
        if (!confirm("Build the bracket with " + paid + " paid players" + (paid < size ? " (" + (size - paid) + " byes)" : "") + "?" + (pend ? "\n\n" + pend + " unpaid reservation(s) will NOT be included." : "") + "\n\nEntry will close.")) return;
        return adminDo(function () { return API.adminGenerateBracket(ev.id); }, "Bracket published.");
      }
      if (a === "reset") { if (!confirm("Delete the bracket and all results, and reopen entry?")) return; return adminDo(function () { return API.adminResetBracket(ev.id); }, "Bracket reset."); }
      if (a === "finish") { if (!confirm("Finish the event and award ranking points?")) return; return adminDo(function () { return API.adminFinishEvent(ev.id, adminCtx.matches); }, "Event finished - rankings updated."); }
      if (a === "delete") {
        if (!confirm("Permanently delete " + ev.name + " and all its enrollments and results?")) return;
        return API.adminDeleteEvent(ev.id).then(function () { toast("Deleted."); return loadEvents(true); }).then(function () { navigate("admin"); }).catch(function (x) { toast(errMsg(x)); });
      }
    }
    var enrBtn = e.target.closest("[data-enr]");
    if (enrBtn) {
      var to = enrBtn.getAttribute("data-to");
      if (to === "cancelled" && !confirm("Remove this player from the event? Refund them first if they paid.")) return;
      return adminDo(function () { return API.adminSetEnrollmentStatus(enrBtn.getAttribute("data-enr"), to); }, "Updated.");
    }
    var save = e.target.closest("[data-save]");
    if (save) {
      var card = save.closest(".match-admin"), id = save.getAttribute("data-save");
      var m = adminCtx.matches.filter(function (x) { return x.id === id; })[0];
      var sa = card.querySelector('[data-side="a"]').value, sb = card.querySelector('[data-side="b"]').value;
      if (sa === "" || sb === "") return toast("Enter both scores.");
      sa = parseInt(sa, 10); sb = parseInt(sb, 10);
      if (sa === sb) return toast("Scores can't be tied - someone has to win.");
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
  function handlePaymentReturn() {
    var q = new URLSearchParams(location.search), flag = q.get("paid");
    if (!flag) return;
    q.delete("paid");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    if (flag === "1") toast("Thanks! Payment received - your seat will show as confirmed in a moment.");
    else toast("Payment cancelled - your seat is still reserved.");
  }

  async function start() {
    $("footerEmail").textContent = C.CONTACT_EMAIL;
    $("footerNote").textContent = API.isLive ? "" : "Sample data · not connected to a database yet";
    $("sampleBanner").hidden = API.isLive;
    handlePaymentReturn();
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
  }
  start();
})();
