const express = require('express'), http = require('http'), path = require('path');
const { WebSocketServer } = require('ws');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (q, r) => r.send('ok'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });

const C = ['R', 'G', 'Y', 'B'], NM = { R: 'Red', G: 'Green', Y: 'Yellow', B: 'Blue' };
const ST = { R: 0, G: 13, Y: 26, B: 39 }, SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
const rooms = new Map();

const seated = G => C.filter(c => G.seats[c]);
const seatOf = (G, id) => C.find(c => G.seats[c] === id);
const movable = (G, c, d) => G.tokens[c].map((p, i) => (p < 0 ? d === 6 : p + d <= 56) ? i : -1).filter(i => i >= 0);
const clean = s => String(s || 'Player').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'Player';

function newGame(id, n) {
  const t = {}; C.forEach(c => t[c] = [-1, -1, -1, -1]);
  return { host: id, phase: 'lobby', seats: { R: id, G: null, Y: null, B: null }, names: { R: n }, tokens: t,
    turn: 'R', dice: 0, rolled: false, last: null, log: 'Waiting for players…', winner: null };
}
function nextTurn(G) { const s = seated(G); G.turn = s[(s.indexOf(G.turn) + 1) % s.length]; }

function act(G, d, from) {
  if (d.t === 'sit') {
    if (G.phase !== 'lobby' || seatOf(G, from) || !C.includes(d.c) || G.seats[d.c]) return;
    G.seats[d.c] = from; G.names[d.c] = clean(d.n);
  } else if (d.t === 'start') {
    if (from !== G.host || G.phase !== 'lobby' || seated(G).length < 2) return;
    G.phase = 'play'; G.turn = seated(G)[0]; G.log = NM[G.turn] + ' starts — roll!';
  } else if (d.t === 'again') {
    if (from !== G.host || !G.winner) return;
    C.forEach(c => G.tokens[c] = [-1, -1, -1, -1]);
    G.phase = 'lobby'; G.winner = null; G.rolled = false; G.dice = 0; G.log = 'New game — start when ready';
  } else if (d.t === 'roll') {
    if (G.phase !== 'play' || G.seats[G.turn] !== from || G.rolled || G.winner) return;
    const v = 1 + Math.floor(Math.random() * 6), c = G.turn, nm = G.names[c];
    G.dice = v; G.last = c;
    if (!movable(G, c, v).length) { G.log = `${nm} rolled ${v} — no move`; nextTurn(G); }
    else { G.rolled = true; G.log = `${nm} rolled ${v} — pick a token`; }
  } else if (d.t === 'move') {
    const c = G.turn, v = G.dice, i = d.i;
    if (G.phase !== 'play' || G.seats[c] !== from || !G.rolled || !movable(G, c, v).includes(i)) return;
    const p = G.tokens[c][i], np = p < 0 ? 0 : p + v; G.tokens[c][i] = np; let cap = false;
    if (np <= 50) {
      const ab = (ST[c] + np) % 52;
      if (!SAFE.has(ab)) C.forEach(o => {
        if (o === c) return;
        G.tokens[o] = G.tokens[o].map(q => { if (q >= 0 && q <= 50 && (ST[o] + q) % 52 === ab) { cap = true; return -1; } return q; });
      });
    }
    G.rolled = false;
    if (G.tokens[c].every(q => q === 56)) { G.winner = c; G.log = `🏆 ${G.names[c]} wins!`; }
    else { G.log = `${G.names[c]} moved` + (cap ? ' and captured a token!' : ''); if (v !== 6 && !cap) nextTurn(G); else G.log += ' Roll again.'; }
  } else return;
}

function broadcast(code) {
  const r = rooms.get(code); if (!r) return;
  const msg = JSON.stringify({ s: r.G, code });
  r.clients.forEach(w => { if (w.readyState === 1) w.send(msg); });
}
const err = (w, e) => w.send(JSON.stringify({ err: e }));
function leave(w) { const r = w.code && rooms.get(w.code); if (r) { r.clients.delete(w); r.empty = r.clients.size ? 0 : Date.now(); } }

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
      const c = seatOf(r.G, id); if (c) r.G.names[c] = clean(d.n);
      return broadcast(w.code);
    }
    const r = w.code && rooms.get(w.code); if (!r || !w.id) return;
    act(r.G, d, w.id); broadcast(w.code);
  });
  w.on('close', () => leave(w));
});

setInterval(() => {
  wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); });
  rooms.forEach((r, code) => { if (r.empty && Date.now() - r.empty > 3600000) rooms.delete(code); });
}, 30000);

server.listen(process.env.PORT || 3000, () => console.log('Ludo server running'));
