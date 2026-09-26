const B = require('../../js/bracket.js');
let fails = 0;
const ok = (label, cond) => { if (!cond) { fails++; console.log('FAIL', label); } };
let idc = 0; const mk = () => 'm' + (++idc);

function playAll(matches, rng) {
  // repeatedly play any match whose players are both known and not done
  let ms = matches, guard = 0;
  while (guard++ < 1000) {
    const next = ms.filter(m => m.status !== 'done' && m.status !== 'bye' && m.player_a && m.player_b)
      .sort((a, b) => a.round - b.round || a.position - b.position)[0];
    if (!next) break;
    const w = rng() < 0.5 ? next.player_a : next.player_b;
    ms = B.applyResult(ms, next.id, { score_a: w === next.player_a ? 3 : 1, score_b: w === next.player_a ? 1 : 3, winner: w }).matches;
  }
  return ms;
}

let seed = 42; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

for (let n = 2; n <= 70; n++) {
  const players = Array.from({ length: n }, (_, i) => 'p' + (i + 1));
  const ms0 = B.generate(players, mk);
  const size = B.nextPow2(n), R = B.totalRounds(n);
  const byes = ms0.filter(m => m.status === 'bye').length;
  ok(`n=${n} byes=${size - n}`, byes === size - n);
  ok(`n=${n} round1 matches`, ms0.filter(m => m.round === 1).length === size / 2);
  // every real player appears exactly once in round 1 or via bye advance into round 2
  const seen = new Set();
  ms0.filter(m => m.round === 1).forEach(m => { [m.player_a, m.player_b].forEach(p => p && seen.add(p)); });
  ok(`n=${n} all players placed once`, seen.size === n);
  // no bye match pairs two nulls
  ok(`n=${n} no empty round1`, ms0.filter(m => m.round === 1).every(m => m.player_a || m.player_b));
  // top seed gets a bye whenever there are byes
  if (n < size) { const m1 = ms0.find(m => m.round === 1 && m.position === 1); ok(`n=${n} seed1 has bye`, m1.status === 'bye' && m1.winner === 'p1'); }

  const done = playAll(ms0, rng);
  const st = B.finalStandings(done);
  ok(`n=${n} standings complete`, st !== null);
  if (st) {
    const places = Object.values(st).map(x => x.place);
    ok(`n=${n} champion exists`, places.filter(p => p === 1).length === 1);
    ok(`n=${n} runner-up exists`, places.filter(p => p === 2).length === 1);
    ok(`n=${n} every player has standing`, Object.keys(st).length === n);
  }
  ok(`n=${n} rounds labels`, B.toRounds(ms0).length === R);
}

// downstream protection
{
  const players = ['a', 'b', 'c', 'd'];
  let ms = B.generate(players, mk);
  const m1 = ms.find(m => m.round === 1 && m.position === 1), m2 = ms.find(m => m.round === 1 && m.position === 2);
  ms = B.applyResult(ms, m1.id, { score_a: 3, score_b: 0, winner: m1.player_a }).matches;
  ms = B.applyResult(ms, m2.id, { score_a: 3, score_b: 0, winner: m2.player_a }).matches;
  const fin = ms.find(m => m.round === 2 && m.position === 1);
  ms = B.applyResult(ms, fin.id, { score_a: 3, score_b: 1, winner: fin.player_a }).matches;
  let threw = false; try { B.applyResult(ms, m1.id, { winner: m1.player_b }); } catch (e) { threw = e.message === 'downstream_done'; }
  ok('cannot edit a match after the final is played', threw);
  threw = false; try { B.applyResult(ms, fin.id, { winner: 'zzz' }); } catch (e) { threw = e.message === 'invalid_winner'; }
  ok('invalid winner rejected', threw);
  const third = ms.find(m => m.round === 2 && m.position === 2);
  ok('third place match exists for 4 players and has both losers', third && third.player_a && third.player_b);
  ok('standings wait for third-place match', B.finalStandings(ms) === null);
}
// example: 20 players
{
  const players = Array.from({ length: 20 }, (_, i) => 'p' + (i + 1));
  const ms = B.generate(players, mk);
  console.log('20 players: byes', ms.filter(m => m.status === 'bye').length, 'real R1', ms.filter(m => m.round === 1 && m.status !== 'bye').length, 'rounds', B.toRounds(ms).map(r => r.label).join(' > '));
}
console.log(fails ? fails + ' FAILURES' : 'all bracket tests passed');
