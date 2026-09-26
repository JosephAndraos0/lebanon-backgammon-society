/* Single-elimination bracket engine with byes.
 * Pure functions (no DOM, no network) so they can be unit-tested in Node.
 *
 * A "match" row looks like the database row:
 *   { id, round, position, player_a, player_b, score_a, score_b, winner, status }
 * round 1 = first round. The final is (lastRound, position 1); the third-place
 * match (only when both semifinals are real matches) is (lastRound, position 2).
 */
(function (root) {
  "use strict";

  function nextPow2(n) { var p = 1; while (p < n) p *= 2; return p; }
  function log2(n) { var r = 0; while (n > 1) { n /= 2; r++; } return r; }

  // Standard seeding order, e.g. size 8 -> [1,8,4,5,2,7,3,6] (1v8, 4v5, 2v7, 3v6).
  // Seeds above the real player count are byes, so top seeds get them first.
  function seedOrder(size) {
    var result = [1, 2];
    while (result.length < size) {
      var l = result.length * 2 + 1, next = [];
      for (var i = 0; i < result.length; i++) { next.push(result[i]); next.push(l - result[i]); }
      result = next;
    }
    return result.slice(0, Math.max(size, 2));
  }

  function totalRounds(playerCount) { return log2(nextPow2(playerCount)); }

  function roundLabel(round, rounds) {
    var d = rounds - round;
    if (d === 0) return "Final";
    if (d === 1) return "Semifinals";
    if (d === 2) return "Quarterfinals";
    return "Round of " + Math.pow(2, d + 1);
  }

  function find(matches, round, position) {
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].round === round && matches[i].position === position) return matches[i];
    }
    return null;
  }

  function roundsOf(matches) {
    var r = 0;
    matches.forEach(function (m) { if (m.round > r) r = m.round; });
    return r;
  }

  function setSlot(match, position, playerId) {
    if (position % 2 === 1) match.player_a = playerId; else match.player_b = playerId;
  }

  // Send a match's winner (and, for semifinals, its loser) to the next match.
  function propagate(matches, m) {
    var R = roundsOf(matches);
    if (m.round < R && m.winner) {
      var next = find(matches, m.round + 1, Math.ceil(m.position / 2));
      if (next) setSlot(next, m.position, m.winner);
    }
    if (m.round === R - 1 && m.status === "done") {
      var third = find(matches, R, 2);
      var loser = m.winner === m.player_a ? m.player_b : m.player_a;
      if (third && loser) setSlot(third, m.position, loser);
    }
  }

  /* players: array of player ids ordered by seed (index 0 = seed 1).
   * makeId: function returning a new unique id for each match.
   * Returns an array of match rows with byes already resolved and advanced. */
  function generate(players, makeId) {
    var n = players.length;
    if (n < 2) throw new Error("need_two_players");
    var size = nextPow2(n), R = log2(size), order = seedOrder(size), matches = [], r, p;

    for (r = 1; r <= R; r++) {
      var count = size / Math.pow(2, r);
      for (p = 1; p <= count; p++) {
        matches.push({ id: makeId(), round: r, position: p, player_a: null, player_b: null,
                       score_a: null, score_b: null, winner: null, status: "pending" });
      }
    }

    var byeCount = 0;
    for (p = 1; p <= size / 2; p++) {
      var m = find(matches, 1, p);
      var a = order[(p - 1) * 2] <= n ? players[order[(p - 1) * 2] - 1] : null;
      var b = order[(p - 1) * 2 + 1] <= n ? players[order[(p - 1) * 2 + 1] - 1] : null;
      m.player_a = a; m.player_b = b;
      if (!a || !b) { m.winner = a || b; m.status = "bye"; byeCount++; }
    }

    // A third-place match only makes sense when both semifinals are real matches.
    if (R >= 2) {
      var semis = matches.filter(function (x) { return x.round === R - 1; });
      var allReal = semis.length === 2 && semis.every(function (x) { return x.round > 1 || x.status !== "bye"; });
      if (allReal) {
        matches.push({ id: makeId(), round: R, position: 2, player_a: null, player_b: null,
                       score_a: null, score_b: null, winner: null, status: "pending" });
      }
    }

    matches.forEach(function (m) { if (m.status === "bye") propagate(matches, m); });
    return matches;
  }

  /* Record a result. Returns { matches, changed } where matches is a new array and
   * changed holds the rows that need saving. Throws if the winner is invalid or a
   * later match that depends on this one has already been played. */
  function applyResult(matches, matchId, result) {
    var copy = matches.map(function (m) { return Object.assign({}, m); });
    var m = copy.filter(function (x) { return x.id === matchId; })[0];
    if (!m) throw new Error("match_not_found");
    if (!m.player_a || !m.player_b) throw new Error("match_not_ready");
    if (result.winner !== m.player_a && result.winner !== m.player_b) throw new Error("invalid_winner");

    var R = roundsOf(copy);
    var dependents = [];
    if (m.round < R) dependents.push(find(copy, m.round + 1, Math.ceil(m.position / 2)));
    if (m.round === R - 1) dependents.push(find(copy, R, 2));
    if (dependents.some(function (d) { return d && d.status === "done"; })) throw new Error("downstream_done");

    var before = copy.map(function (x) { return JSON.stringify(x); });
    m.score_a = result.score_a == null ? null : result.score_a;
    m.score_b = result.score_b == null ? null : result.score_b;
    m.winner = result.winner;
    m.status = "done";
    propagate(copy, m);

    var changed = copy.filter(function (x, i) { return JSON.stringify(x) !== before[i]; });
    return { matches: copy, changed: changed };
  }

  /* Once the final (and third-place match, if any) is finished, work out each player's
   * final place and season points. Returns { playerId: { place, points } } or null. */
  function finalStandings(matches) {
    var R = roundsOf(matches);
    var final = find(matches, R, 1);
    if (!final || final.status !== "done") return null;
    var third = find(matches, R, 2);
    if (third && third.status !== "done") return null;

    var out = {};
    function loserOf(m) { return m.winner === m.player_a ? m.player_b : m.player_a; }
    function put(id, place, points) { if (id && !out[id]) out[id] = { place: place, points: points }; }

    put(final.winner, 1, 100);
    put(loserOf(final), 2, 60);
    if (third) {
      put(third.winner, 3, 35);
      put(loserOf(third), 4, 25);
    } else if (R >= 2) {
      matches.filter(function (m) { return m.round === R - 1 && m.status === "done"; })
        .forEach(function (m) { put(loserOf(m), 3, 35); });
    }
    matches.forEach(function (m) {
      if (m.status !== "done" || m.round >= R - 1) return;
      var d = R - m.round;
      put(loserOf(m), Math.pow(2, d) + 1, d === 2 ? 15 : d === 3 ? 8 : 4);
    });
    return out;
  }

  /* Group rows into rounds for display: [{ round, label, matches: [...] }]. */
  function toRounds(matches) {
    var R = roundsOf(matches), rounds = [];
    for (var r = 1; r <= R; r++) {
      var list = matches.filter(function (m) { return m.round === r; })
        .sort(function (a, b) { return a.position - b.position; });
      rounds.push({ round: r, label: roundLabel(r, R), matches: list });
    }
    return rounds;
  }

  var api = { nextPow2: nextPow2, seedOrder: seedOrder, totalRounds: totalRounds, roundLabel: roundLabel,
              generate: generate, applyResult: applyResult, finalStandings: finalStandings, toRounds: toRounds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LBS_BRACKET = api;
})(typeof window !== "undefined" ? window : this);
