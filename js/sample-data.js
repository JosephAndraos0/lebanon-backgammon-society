/* Sample tournaments shown until Supabase is connected (see js/config.js).
 * Brackets are built with the real bracket engine, then "played" so you can see byes,
 * live matches and finished events. Players use their names as ids here. */
(function (root) {
  "use strict";
  var B = root.LBS_BRACKET;
  var uid = 0;
  function mkId() { return "s" + (++uid); }

  function play(ms, a, b, sa, sb, live) {
    var m = ms.filter(function (x) {
      return (x.player_a === a && x.player_b === b) || (x.player_a === b && x.player_b === a);
    })[0];
    if (!m) throw new Error("sample: no match for " + a + " vs " + b);
    var flip = m.player_a !== a;              // score order follows the match's a/b slots
    var scoreA = flip ? sb : sa, scoreB = flip ? sa : sb;
    if (live) {
      m.score_a = scoreA; m.score_b = scoreB; m.status = "live";
      return ms;
    }
    var winner = sa > sb ? a : b;
    return B.applyResult(ms, m.id, { score_a: scoreA, score_b: scoreB, winner: winner }).matches;
  }

  function playAllByPreference(ms, prefs) {
    var rank = function (p) { var i = prefs.indexOf(p); return i < 0 ? 999 : i; };
    for (var guard = 0; guard < 500; guard++) {
      var next = ms.filter(function (m) { return m.status !== "done" && m.status !== "bye" && m.player_a && m.player_b; })
        .sort(function (a, b) { return a.round - b.round || a.position - b.position; })[0];
      if (!next) break;
      var w = rank(next.player_a) <= rank(next.player_b) ? next.player_a : next.player_b;
      ms = B.applyResult(ms, next.id, { score_a: w === next.player_a ? 3 : 1, score_b: w === next.player_a ? 1 : 3, winner: w }).matches;
    }
    return ms;
  }

  var P16 = ["Karim Nassar","Nour El Amine","Georges Fakhoury","Jad Chami","Wissam Daher","Elie Khoury","Sarah Matta","Maya Saliba","Fadi Khalil","Layal Rahme","Rami Haddad","Christelle Aoun","Yasmine Berbari","Tony Abou Khalil","Marc Tabet","Rita Sfeir"];
  var P11 = ["Karim Nassar","Nour El Amine","Sarah Matta","Jad Chami","Maya Saliba","Wissam Daher","Georges Fakhoury","Elie Khoury","Rami Haddad","Marc Tabet","Layal Rahme"];
  var P20 = ["Karim Nassar","Rami Haddad","Elie Khoury","Tony Abou Khalil","Nour El Amine","Sarah Matta","Georges Fakhoury","Maya Saliba","Jad Chami","Layal Rahme","Marc Tabet","Christelle Aoun","Wissam Daher","Yasmine Berbari","Fadi Khalil","Rita Sfeir","Sami Rizk","Dana Abboud","Hadi Farah","Reem Chidiac"];
  var P6 = ["Rita Sfeir","Fadi Khalil","Yasmine Berbari","Christelle Aoun","Tony Abou Khalil","Georges Fakhoury"];

  // Achrafieh Open: 16 players, quarterfinals in progress
  var achra = B.generate(P16, mkId);
  [["Karim Nassar","Rita Sfeir",3,1],["Maya Saliba","Fadi Khalil",3,2],["Jad Chami","Yasmine Berbari",3,0],["Wissam Daher","Christelle Aoun",3,2],
   ["Nour El Amine","Marc Tabet",3,1],["Sarah Matta","Layal Rahme",3,2],["Georges Fakhoury","Tony Abou Khalil",3,1],["Elie Khoury","Rami Haddad",3,0],
   ["Jad Chami","Wissam Daher",3,2],["Elie Khoury","Georges Fakhoury",3,1]].forEach(function (r) { achra = play(achra, r[0], r[1], r[2], r[3]); });
  achra = play(achra, "Karim Nassar", "Maya Saliba", 2, 1, true);
  achra = play(achra, "Nour El Amine", "Sarah Matta", 1, 1, true);

  // Hamra Winter Cup: 11 players -> 5 byes
  var hamra = B.generate(P11, mkId);
  [["Elie Khoury","Rami Haddad",3,1],["Georges Fakhoury","Marc Tabet",3,2],["Layal Rahme","Wissam Daher",3,1]]
    .forEach(function (r) { hamra = play(hamra, r[0], r[1], r[2], r[3]); });
  hamra = play(hamra, "Karim Nassar", "Elie Khoury", 1, 0, true);

  // Byblos Classic: 20 players -> 12 byes
  var byblos = B.generate(P20, mkId);
  [["Rita Sfeir","Sami Rizk",3,1],["Wissam Daher","Reem Chidiac",3,2],["Dana Abboud","Fadi Khalil",3,1],["Yasmine Berbari","Hadi Farah",3,0],
   ["Jad Chami","Maya Saliba",3,2],["Wissam Daher","Tony Abou Khalil",3,1],["Dana Abboud","Rami Haddad",3,1],["Georges Fakhoury","Layal Rahme",3,0],
   ["Elie Khoury","Yasmine Berbari",3,1],["Sarah Matta","Marc Tabet",3,2]].forEach(function (r) { byblos = play(byblos, r[0], r[1], r[2], r[3]); });
  byblos = play(byblos, "Karim Nassar", "Rita Sfeir", 2, 1, true);
  byblos = play(byblos, "Nour El Amine", "Christelle Aoun", 1, 1, true);

  // Gemmayzeh Night League: finished
  var gemm = playAllByPreference(B.generate(P16, mkId), ["Elie Khoury", "Karim Nassar", "Jad Chami"]);
  var gemmStand = B.finalStandings(gemm);

  function players(list, statusMap) {
    return list.map(function (n, i) {
      return { user_id: n, name: n, status: "paid", seed: i + 1, final_place: statusMap && statusMap[n] ? statusMap[n].place : null };
    });
  }

  function ev(id, slug, name, venue, iso, fee, max, status, desc, taken) {
    var pool = fee * taken;   // sample tournaments pay out their entry fees 50 / 30 / 20
    return { id: id, slug: slug, name: name, venue: venue, starts_at: iso, entry_fee: fee, currency: "USD",
             max_players: max, description: desc, status: status,
             prizes: [Math.round(pool * 0.5), Math.round(pool * 0.3), Math.round(pool * 0.2)], taken: taken, paid: taken };
  }

  root.LBS_SAMPLE = {
    events: [
      ev("e-achra", "achrafieh-open", "Achrafieh Open", "Cedar Club, Achrafieh", "2026-09-22T19:00:00+03:00", 25, 16, "live",
         "Our flagship monthly open - 16 seats, single elimination, straight to a Friday night final.", 16),
      ev("e-hamra", "hamra-winter-cup", "Hamra Winter Cup", "Backroom Lounge, Hamra", "2026-10-04T18:30:00+03:00", 25, 16, "live",
         "A relaxed weeknight cup in the heart of Hamra, capped at 16 seats. Only 11 players locked in, so five of them carry a bye into the Quarterfinals.", 11),
      ev("e-byblos", "byblos-classic", "Byblos Backgammon Classic", "Byblos Old Souk Courtyard", "2026-11-08T16:00:00+02:00", 40, 32, "live",
         "Our biggest buy-in of the season, capped at 32 seats. Only 20 players locked in, so the top seeds carry a bye straight through to the Round of 16.", 20),
      ev("e-raouche", "raouche-sunset-series", "Raouche Sunset Series", "Sunset Rooftop, Raouche", "2026-10-18T17:00:00+03:00", 25, 16, "open",
         "Games start before sunset over the Pigeon Rocks and run into the evening. New to the Society? This is a friendly place to start.", 6),
      ev("e-gemm", "gemmayzeh-night-league", "Gemmayzeh Night League", "The Backyard, Gemmayzeh", "2026-09-06T20:00:00+03:00", 25, 16, "completed",
         "September's late-night league wrapped with a tight final.", 16)
    ],
    detail: {
      "e-achra":  { players: players(P16), matches: achra },
      "e-hamra":  { players: players(P11), matches: hamra },
      "e-byblos": { players: players(P20), matches: byblos },
      "e-raouche": { players: players(P6), matches: [] },
      "e-gemm":   { players: players(P16, gemmStand), matches: gemm }
    },
    rankings: [
      { user_id: "Elie Khoury", full_name: "Elie Khoury", events_played: 4, points: 210, best_place: 1 },
      { user_id: "Karim Nassar", full_name: "Karim Nassar", events_played: 5, points: 185, best_place: 2 },
      { user_id: "Jad Chami", full_name: "Jad Chami", events_played: 4, points: 170, best_place: 3 },
      { user_id: "Maya Saliba", full_name: "Maya Saliba", events_played: 3, points: 140, best_place: 4 },
      { user_id: "Nour El Amine", full_name: "Nour El Amine", events_played: 4, points: 130, best_place: 5 }
    ]
  };
})(window);
