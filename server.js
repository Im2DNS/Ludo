const express = require('express'), http = require('http'), path = require('path');
const { WebSocketServer } = require('ws');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (q, r) => r.send('ok'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const C = ['R', 'G', 'Y', 'B'], NM = { R: 'Red', G: 'Green', Y: 'Yellow', B: 'Blue' };
const ST = { R: 0, G: 13, Y: 26, B: 39 }, SAFE = new Set([0, 13, 26, 39]); // start squares only
const rooms = new Map();
const seated = G => C.filter(c => G.seats[c]);
const seatOf = (G, id) => C.find(c => G.seats[c] === id);
// Token value v: -1 base | 0..51 ring steps from own start | 100..104 home lane | 105 finished
function dest(G, c, v, d) {
  if (v === -1) return d === 1 ? 0 : null;                  // leave base only on a 1
  if (v >= 100) { const L = v - 100 + d; return L <= 5 ? 100 + L : null; }
  const t = v + d;
  if (G.cut[c]) { if (t <= 50) return t; const L = t - 51; return L <= 5 ? 100 + L : null; } // lane only after a capture
  return t >= 52 ? t - 52 : t;                             // no capture yet: keep circling
}
function victims(G, c, nv) {
  const out = [];
  if (nv < 0 || nv > 51) return out;
  const ab = (ST[c] + nv) % 52; if (SAFE.has(ab)) return out;
  C.forEach(o => { if (o !== c) G.tokens[o].forEach((q, j) => { if (q >= 0 && q <= 51 && (ST[o] + q) % 52 === ab) out.push([o, j]); }); });
  return out;
}
function movable(G, c, d) {
  const all = [], cap = [];
  G.tokens[c].forEach((v, i) => {
    if (v === 105) return;
    const nv = dest(G, c, v, d); if (nv === null) return;
    all.push(i); if (victims(G, c, nv).length) cap.push(i);
  });
  return cap.length ? cap : all;                            // must capture when possible
}
const clean = s => String(s || 'Player').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'Player';
function newGame(id, n) {
  const t = {}; C.forEach(c => t[c] = [-1, -1, -1, -1]);
  return { host: id, phase: 'lobby', seats: { R: id, G: null, Y: null, B: null }, names: { R: n }, tokens: t,
    turn: 'R', dice: 0, rolled: false, mv: [], cut: { R: false, G: false, Y: false, B: false }, ones: { R: 0, G: 0, Y: 0, B: 0 }, last: null, log: 'Waiting for players…', winner: null };
}
function nextTurn(G) { const s = seated(G); G.turn = s[(s.indexOf(G.turn) + 1) % s.length]; }
function act(G, d, from) {
  if (d.t === 'sit') {
    if (G.phase !== 'lobby' || !C.includes(d.c) || G.seats[d.c]) return;
    const old = seatOf(G, from); if (old) { G.seats[old] = null; delete G.names[old]; }
    G.seats[d.c] = from; G.names[d.c] = clean(d.n);
  } else if (d.t === 'start') {
    if (from !== G.host || G.phase !== 'lobby' || seated(G).length < 2) return;
    const s2 = seated(G);
    if (s2.length === 2) {
      const OP = { R: 'Y', Y: 'R', G: 'B', B: 'G' }, [a, b] = s2;
      if (OP[a] !== b) { const nb = OP[a]; G.seats[nb] = G.seats[b]; G.names[nb] = G.names[b]; G.seats[b] = null; delete G.names[b]; }
    }
    G.phase = 'play'; G.turn = seated(G)[0]; G.log = NM[G.turn] + ' starts — roll!';
  } else if (d.t === 'again') {
    if (from !== G.host || !G.winner) return;
    C.forEach(c => G.tokens[c] = [-1, -1, -1, -1]);
    G.phase = 'lobby'; G.winner = null; G.rolled = false; G.dice = 0; G.mv = [];
    C.forEach(c => { G.cut[c] = false; G.ones[c] = 0; }); G.log = 'New game — start when ready';
  } else if (d.t === 'roll') {
    if (G.phase !== 'play' || G.seats[G.turn] !== from || G.rolled || G.winner) return;
    const v = 1 + Math.floor(Math.random() * 6), c = G.turn, nm = G.names[c];
    G.dice = v; G.last = c; G.mv = [];
    G.ones[c] = v === 1 ? G.ones[c] + 1 : 0;
    if (G.ones[c] >= 3) {
      G.ones[c] = 0;
      let best = -1; G.tokens[c].forEach((t, i) => { if (t >= 0 && t < 105 && (best < 0 || t > G.tokens[c][best])) best = i; });
      if (best >= 0) { G.tokens[c][best] = -1; G.log = `${nm} rolled 1 three times — own token sent back to base!`; nextTurn(G); return; }
    }
    const m = movable(G, c, v);
    if (!m.length) { G.log = `${nm} rolled ${v} — no move`; nextTurn(G); }
    else { G.rolled = true; G.mv = m; G.log = `${nm} rolled ${v} — pick a token` + (m.length && victims(G, c, dest(G, c, G.tokens[c][m[0]], v)).length ? ' (you must capture)' : ''); }
  } else if (d.t === 'move') {
    const c = G.turn, v = G.dice, i = d.i;
    if (G.phase !== 'play' || G.seats[c] !== from || !G.rolled || !G.mv.includes(i)) return;
    const nv = dest(G, c, G.tokens[c][i], v), vs = victims(G, c, nv);
    G.tokens[c][i] = nv; vs.forEach(([o, j]) => G.tokens[o][j] = -1);
    if (vs.length) G.cut[c] = true;
    G.rolled = false; G.mv = [];
    const reachedHome = (nv === 105);
    const bonusTurn = (v === 1 || v === 6 || vs.length > 0 || reachedHome);
    if (G.tokens[c].every(q => q === 105)) {
      G.winner = c;
      G.log = `🏆 ${G.names[c]} wins!`;
    } else {
      let actionMsg = `${G.names[c]} moved`;
      if (vs.length) actionMsg = `${G.names[c]} captured a token (home lane unlocked!)`;
      else if (reachedHome) actionMsg = `${G.names[c]} reached home!`;
      G.log = actionMsg;
      if (bonusTurn) {
        G.log += ' Roll again!';
      } else {
        nextTurn(G);
      }
    }
  } else return;
}
function removePlayer(G, id) {
  const c = seatOf(G, id); if (!c) return;
  const nm = G.names[c];
  const wasTurn = G.phase === 'play' && !G.winner && G.turn === c;
  G.seats[c] = null; delete G.names[c]; G.tokens[c] = [-1, -1, -1, -1]; G.cut[c] = false; G.ones[c] = 0;
  const s = seated(G);
  if (G.host === id && s.length) G.host = G.seats[s[0]];
  if (G.phase === 'play' && !G.winner) {
    if (s.length === 1) {
      G.winner = s[0]; G.rolled = false; G.mv = [];
      G.log = `🏆 ${G.names[s[0]]} wins — everyone else left!`;
    } else {
      if (wasTurn) { G.rolled = false; G.mv = []; nextTurn(G); }
      G.log = `${nm} left the game`;
    }
  }
}
function broadcast(code) {
  const r = rooms.get(code); if (!r) return;
  const msg = JSON.stringify({ s: r.G, code });
  r.clients.forEach(w => { if (w.readyState === 1) w.send(msg); });
}
const err = (w, e) => w.send(JSON.stringify({ err: e }));
function leave(w) { const r = w.code && rooms.get(w.code); if (r) { r.clients.delete(w); } }
wss.on('connection', w => {
  w.alive = true; w.on('pong', () => w.alive = true);
  w.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d.t !== 'string') return;
    if (d.t === 'create' || d.t === 'join') {
      const id = String(d.id || '').slice(0, 32); if (!id) return;
      leave(w);
      if (d.t === 'create') {
        let code; do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); } while (rooms.has(code));
        rooms.set(code, { G: newGame(id, clean(d.n)), clients: new Set(), empty: 0 });
        w.code = code;
      } else {
        const code = String(d.code || '').toUpperCase().slice(0, 5);
        if (!rooms.has(code)) return err(w, 'No game with that code.');
        w.code = code;
      }
      w.id = id;
      const r = rooms.get(w.code); r.clients.add(w); r.empty = 0;
      if (r.timers && r.timers[id]) { clearTimeout(r.timers[id]); delete r.timers[id]; }
      const c = seatOf(r.G, id); if (c) r.G.names[c] = clean(d.n);
      return broadcast(w.code);
    }
    if (d.t === 'leave') {
      const r0 = w.code && rooms.get(w.code), code = w.code;
      if (r0 && w.id) { removePlayer(r0.G, w.id); leave(w); w.code = null; broadcast(code); }
      return;
    }
    const r = w.code && rooms.get(w.code); if (!r || !w.id) return;
    act(r.G, d, w.id); broadcast(w.code);
  });
  w.on('close', () => {
    const code = w.code, id = w.id;
    const r = code && rooms.get(code);
    if (!r || !id) return;
    r.clients.delete(w);
    if (r.clients.size === 0) return;            // room idles; 30-min cleanup handles it
    // Others still here → give this player 60 s to reconnect before vacating
    if (!r.timers) r.timers = {};
    if (r.timers[id]) clearTimeout(r.timers[id]);
    r.timers[id] = setTimeout(() => {
      delete r.timers[id];
      const r2 = rooms.get(code); if (!r2) return;
      let back = false;
      r2.clients.forEach(cw => { if (cw.id === id) back = true; });
      if (!back) { removePlayer(r2.G, id); broadcast(code); }
    }, 60000);
  });
});
setInterval(() => {
  wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); });
  rooms.forEach((r, code) => {
    if (r.clients.size === 0) {
      if (!r.empty) r.empty = Date.now();
      else if (Date.now() - r.empty > 1800000) rooms.delete(code); // Clean up after 30 mins of zero active connections
    } else {
      r.empty = 0;
    }
  });
}, 30000);
server.listen(process.env.PORT || 3000, () => console.log('Ludo server running'));
