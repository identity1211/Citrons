"use strict";

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const engine = require("./engine");
const clerk = require("./clerk");

const PORT = Number(process.env.PORT) || 8787;
const SWAP_SECONDS = 20;
const DEAL_STEP_MS = 200;
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const REJOIN_MS = 10 * 60 * 1000;
const WAITING_REJOIN_MS = 2 * 60 * 1000;

const rooms = new Map();
const browsers = new Set();

function publicLobbies() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.phase !== "waiting") continue;
    const host = room.seats.find((p) => p.id === room.hostId) || room.seats[0];
    list.push({
      code: room.code,
      host: host ? host.name : "Host",
      hostAvatar: (host && host.avatar) || "",
      players: room.seats.map((p) => ({ name: p.name, avatar: p.avatar || "" })),
      count: room.seats.length,
      max: MAX_PLAYERS,
    });
  }
  list.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return list;
}

function notifyLobbies() {
  const payload = { type: "lobbies", lobbies: publicLobbies() };
  for (const ws of browsers) send(ws, payload);
}

function addBrowser(ws) {
  browsers.add(ws);
  send(ws, { type: "lobbies", lobbies: publicLobbies() });
}

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function makeCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

function uniqueCode() {
  for (let i = 0; i < 40; i++) {
    const code = makeCode();
    if (!rooms.has(code)) return code;
  }
  return makeCode() + makeCode();
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function dummyCard() {
  return "A♠";
}

function maskPlayer(p, isSelf) {
  return {
    name: isSelf ? "You" : p.name,
    avatar: p.avatar || "",
    ready: !!p.ready,
    connected: !!p.connected,
    hand: isSelf ? [...p.hand] : p.hand.map(() => dummyCard()),
    faceUp: [...p.faceUp],
    faceDown: isSelf ? [...p.faceDown] : p.faceDown.map((c) => (c === null ? null : dummyCard())),
  };
}

function viewFor(room, playerId) {
  const myIndex = room.seats.findIndex((p) => p.id === playerId);
  if (myIndex < 0) return null;
  const n = room.seats.length;
  const rot = (i) => (i - myIndex + n) % n;
  const players = Array.from({ length: n }, (_, i) => {
    const src = room.seats[(myIndex + i) % n];
    return maskPlayer(src, i === 0);
  });
  return {
    code: room.code,
    you: 0,
    youId: playerId,
    host: room.hostId === playerId,
    phase: room.phase,
    players,
    deckCount: room.deck.length,
    discard: [...room.discard],
    currentPlayer: room.phase === "waiting" ? 0 : rot(room.currentPlayer),
    finishOrder: room.finishOrder.map(rot),
    swapSeconds: room.swapSeconds,
    burnCount: room.burnCount,
    statusMsg: room.statusMsg,
    canStart: room.hostId === playerId && room.phase === "waiting" && room.seats.length >= MIN_PLAYERS,
    lobby: room.seats.map((p) => ({
      id: p.id,
      name: p.id === playerId ? `${p.name} (you)` : p.name,
      avatar: p.avatar || "",
      ready: !!p.ready,
      connected: !!p.connected,
      host: p.id === room.hostId,
    })),
  };
}

function broadcast(room, anim) {
  for (const p of room.seats) {
    if (!p.ws) continue;
    const view = viewFor(room, p.id);
    send(p.ws, { type: "state", view, anim: animFor(room, p.id, anim) });
  }
}

function animFor(room, playerId, anim) {
  if (!anim) return undefined;
  const myIndex = room.seats.findIndex((p) => p.id === playerId);
  if (myIndex < 0) return undefined;
  const n = room.seats.length;
  const rot = (i) => (i - myIndex + n) % n;
  const fromPlayer = rot(anim.fromPlayer);
  const pickup = anim.pickup
    ? {
        cards:
          rot(anim.pickup.toPlayer) === 0
            ? [...anim.pickup.cards]
            : anim.pickup.cards.map(() => dummyCard()),
        toPlayer: rot(anim.pickup.toPlayer),
      }
    : null;
  return {
    kind: anim.kind,
    fromPlayer,
    played: [...(anim.played || [])],
    willBurn: !!anim.willBurn,
    burnCards: [...(anim.burnCards || [])],
    drawn: fromPlayer === 0 ? [...(anim.drawn || [])] : (anim.drawn || []).map(() => dummyCard()),
    pickup,
  };
}

function error(ws, message) {
  send(ws, { type: "error", message });
}

function removeSeat(room, player) {
  room.seats = room.seats.filter((p) => p.id !== player.id);
  if (room.seats.length === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return false;
  }
  if (room.hostId === player.id) room.hostId = room.seats[0].id;
  return true;
}

function attach(ws, room, player) {
  browsers.delete(ws);
  player.ws = ws;
  player.connected = true;
  if (player.leaveTimer) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
  }
  ws.roomCode = room.code;
  ws.playerId = player.id;
  send(ws, { type: "joined", code: room.code, playerId: player.id, token: player.token });
  broadcast(room);
  notifyLobbies();
}

function sanitizeName(name) {
  const n = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return n || "Player";
}

function sanitizeAvatar(url) {
  const u = String(url || "").trim();
  if (!u || u.length > 800) return "";
  if (!/^https:\/\//i.test(u)) return "";
  return u;
}

function makePlayer(ws, name, avatar, clerkUserId) {
  return {
    id: id(),
    token: id(),
    name: sanitizeName(name),
    avatar: sanitizeAvatar(avatar),
    clerkUserId: clerkUserId || null,
    ws,
    connected: true,
    ready: false,
    hand: [],
    faceUp: [],
    faceDown: [],
    leaveTimer: null,
  };
}

function findClerkSeat(clerkUserId) {
  if (!clerkUserId) return null;
  for (const room of rooms.values()) {
    const player = room.seats.find((p) => p.clerkUserId === clerkUserId);
    if (player) return { room, player };
  }
  return null;
}

function abandonSeat(room, player) {
  if (!room || !player) return;
  if (player.leaveTimer) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
  }
  if (player.ws) {
    send(player.ws, { type: "left" });
    player.ws.roomCode = null;
    player.ws.playerId = null;
    player.ws = null;
  }
  if (removeSeat(room, player) && rooms.has(room.code)) broadcast(room);
  notifyLobbies();
}

function releaseClerk(clerkUserId, exceptCode) {
  if (!clerkUserId) return;
  for (const room of [...rooms.values()]) {
    if (exceptCode && room.code === exceptCode) continue;
    const player = room.seats.find((p) => p.clerkUserId === clerkUserId);
    if (player) abandonSeat(room, player);
  }
}

async function identifyClerk(ws, clerkToken, { required }) {
  if (!clerk.clerkConfigured()) return { userId: null };
  const result = await clerk.verifyClerkToken(clerkToken);
  if (!result.ok) {
    if (!required && result.reason === "no-token") return { userId: null };
    const map = {
      "no-token": "Sign in with Google first",
      exp: "Session expired — sign in again",
    };
    error(ws, map[result.reason] || "Couldn't verify sign-in");
    return null;
  }
  return { userId: result.userId };
}

async function createRoom(ws, name, avatar, clerkToken) {
  const auth = await identifyClerk(ws, clerkToken, { required: true });
  if (!auth) return;
  const clerkUserId = auth.userId;
  releaseClerk(clerkUserId, null);
  leave(ws, true);
  const code = uniqueCode();
  const player = makePlayer(ws, name, avatar, clerkUserId);
  const room = {
    code,
    hostId: player.id,
    phase: "waiting",
    seats: [player],
    deck: [],
    discard: [],
    currentPlayer: 0,
    finishOrder: [],
    swapSeconds: SWAP_SECONDS,
    burnCount: 0,
    statusMsg: "",
    createdAt: Date.now(),
    timers: [],
  };
  rooms.set(code, room);
  attach(ws, room, player);
}

async function joinRoom(ws, code, name, token, avatar, clerkToken) {
  const room = rooms.get(String(code || "").trim().toUpperCase());
  if (!room) return error(ws, "Lobby not found");
  const auth = await identifyClerk(ws, clerkToken, { required: !token });
  if (!auth) return;
  const clerkUserId = auth.userId;

  if (ws.roomCode && ws.roomCode !== room.code) leave(ws, true);

  if (token) {
    const existing = room.seats.find((p) => p.token === token);
    if (existing) {
      if (clerkUserId) existing.clerkUserId = clerkUserId;
      if (name) existing.name = sanitizeName(name);
      if (avatar) existing.avatar = sanitizeAvatar(avatar);
      attach(ws, room, existing);
      return;
    }
  }

  if (clerkUserId) {
    const existing = room.seats.find((p) => p.clerkUserId === clerkUserId);
    if (existing) {
      if (name) existing.name = sanitizeName(name);
      if (avatar) existing.avatar = sanitizeAvatar(avatar);
      attach(ws, room, existing);
      return;
    }
    releaseClerk(clerkUserId, room.code);
  }

  if (room.phase !== "waiting") return error(ws, "The game has already started");
  if (room.seats.length >= MAX_PLAYERS) return error(ws, "Lobby is full");

  const player = makePlayer(ws, name, avatar, clerkUserId);
  room.seats.push(player);
  attach(ws, room, player);
}

function clearRoomTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}

function later(room, fn, ms) {
  const t = setTimeout(fn, ms);
  room.timers.push(t);
  return t;
}

function startGame(room) {
  if (room.phase !== "waiting") return;
  if (room.seats.length < MIN_PLAYERS) return;
  clearRoomTimers(room);
  const dealt = engine.dealPlayers(room.seats.map((p) => p.name));
  for (let i = 0; i < room.seats.length; i++) {
    const p = room.seats[i];
    p.hand = dealt.players[i].hand;
    p.faceUp = dealt.players[i].faceUp;
    p.faceDown = dealt.players[i].faceDown;
    p.ready = false;
  }
  room.deck = dealt.deck;
  room.discard = [];
  room.finishOrder = [];
  room.burnCount = 0;
  room.currentPlayer = 0;
  room.phase = "dealing";
  room.statusMsg = "Dealing...";
  broadcast(room);
  notifyLobbies();

  const n = room.seats.length;
  const dealMs = 500 + (9 * n + 1) * DEAL_STEP_MS;
  later(room, () => beginSwap(room), dealMs);
}

function beginSwap(room) {
  if (room.phase !== "dealing") return;
  room.phase = "swap";
  room.swapSeconds = SWAP_SECONDS;
  room.statusMsg = "Card swap — 20 seconds";
  broadcast(room);

  const tick = () => {
    if (room.phase !== "swap") return;
    room.swapSeconds -= 1;
    if (room.swapSeconds <= 0) {
      beginPlaying(room);
      return;
    }
    broadcast(room);
    later(room, tick, 1000);
  };
  later(room, tick, 1000);
}

function beginPlaying(room) {
  if (room.phase !== "swap" && room.phase !== "dealing") return;
  clearRoomTimers(room);
  for (const p of room.seats) p.ready = true;
  room.phase = "playing";
  room.currentPlayer = Math.floor(Math.random() * room.seats.length);
  room.discard = [];
  room.statusMsg = `Turn: ${room.seats[room.currentPlayer].name}`;
  broadcast(room);
}

function maybeAllReady(room) {
  if (room.phase !== "swap") return;
  if (room.seats.every((p) => p.ready)) beginPlaying(room);
}

function resolveStandings(room, finisher) {
  if (!room.finishOrder.includes(finisher)) room.finishOrder.push(finisher);
  const left = engine.unfinishedPlayers(room.seats);
  if (left.length <= 1) {
    if (left.length === 1 && !room.finishOrder.includes(left[0])) room.finishOrder.push(left[0]);
    room.phase = "finished";
    room.statusMsg = "Game over";
    return true;
  }
  return false;
}

function afterPlay(room, playerIndex, result) {
  for (let i = 0; i < room.seats.length; i++) {
    const src = result.players[i];
    const dst = room.seats[i];
    dst.hand = src.hand;
    dst.faceUp = src.faceUp;
    dst.faceDown = src.faceDown;
  }
  room.deck = result.deck;
  room.discard = result.discard;
  if (result.willBurn) room.burnCount += result.burnCards.length;
  if (result.pickup) {
    const p = room.seats[result.pickup.toPlayer];
    p.hand = engine.sortHand([...p.hand, ...result.pickup.cards]);
    room.discard = [];
  }
  room.statusMsg = result.message;
  if (result.privateReveal) {
    send(room.seats[playerIndex].ws, { type: "reveal", card: result.privateReveal });
  }
  if (result.won) {
    if (resolveStandings(room, playerIndex)) {
      broadcast(room, makePlayAnim(playerIndex, result));
      return;
    }
  }
  if (result.extraTurn && !engine.playerFinished(room.seats[playerIndex])) {
    room.currentPlayer = playerIndex;
    room.statusMsg = `Turn: ${room.seats[playerIndex].name} (again)`;
  } else {
    room.currentPlayer = engine.nextAlive(playerIndex, room.seats);
    room.statusMsg = `Turn: ${room.seats[room.currentPlayer].name}`;
  }
  broadcast(room, makePlayAnim(playerIndex, result));
}

function makePlayAnim(playerIndex, result) {
  return {
    kind: "play",
    fromPlayer: playerIndex,
    played: result.played || [],
    willBurn: !!result.willBurn,
    burnCards: result.burnCards || [],
    pickup: result.pickup,
    drawn: result.drawn || [],
  };
}

function handlePlay(room, player, play) {
  if (room.phase !== "playing") return error(player.ws, "You can't play right now");
  const idx = room.seats.indexOf(player);
  if (idx !== room.currentPlayer) return error(player.ws, "It's not your turn");
  const result = engine.applyPlay(idx, play || {}, room.seats, room.deck, room.discard);
  if (!result.ok) return error(player.ws, result.message);
  afterPlay(room, idx, result);
}

function handlePickup(room, player, tableTake) {
  if (room.phase !== "playing") return error(player.ws, "You can't take cards right now");
  const idx = room.seats.indexOf(player);
  if (idx !== room.currentPlayer) return error(player.ws, "It's not your turn");
  const result = engine.applyPickUp(idx, room.seats, room.discard, tableTake || null);
  if (!result.ok) return error(player.ws, result.message);
  for (let i = 0; i < room.seats.length; i++) {
    room.seats[i].hand = result.players[i].hand;
    room.seats[i].faceUp = result.players[i].faceUp;
    room.seats[i].faceDown = result.players[i].faceDown;
  }
  room.discard = result.discard;
  room.statusMsg = result.message;
  room.currentPlayer = engine.nextAlive(idx, room.seats);
  room.statusMsg = `${result.message}. Turn: ${room.seats[room.currentPlayer].name}`;
  broadcast(room, {
    kind: "pickup",
    fromPlayer: idx,
    played: [],
    willBurn: false,
    burnCards: [],
    pickup: { cards: result.pickupCards, toPlayer: idx },
    drawn: [],
  });
}

function handleSwap(room, player, hand, faceUp) {
  if (room.phase !== "swap") return;
  if (player.ready) return;
  const next = engine.swapPlayerCards(player, Number(hand), Number(faceUp));
  player.hand = next.hand;
  player.faceUp = next.faceUp;
  broadcast(room);
}

function handleReady(room, player) {
  if (room.phase !== "swap") return;
  player.ready = true;
  broadcast(room);
  maybeAllReady(room);
}

function leave(ws, immediate) {
  browsers.delete(ws);
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const player = room.seats.find((p) => p.id === ws.playerId);
  if (!player) return;
  if (player.ws === ws) player.ws = null;
  player.connected = false;
  ws.roomCode = null;
  ws.playerId = null;

  if (immediate) {
    abandonSeat(room, player);
    return;
  }

  if (player.leaveTimer) clearTimeout(player.leaveTimer);
  const delay = room.phase === "waiting" ? WAITING_REJOIN_MS : REJOIN_MS;
  player.leaveTimer = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r) return;
    const p = r.seats.find((x) => x.id === player.id);
    if (!p || p.connected) return;
    abandonSeat(r, p);
  }, delay);
}

function onMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return error(ws, "Invalid message");
  }
  const type = msg && msg.type;
  const room = rooms.get(ws.roomCode);
  const player = room && room.seats.find((p) => p.id === ws.playerId);

  if (type === "create") {
    void createRoom(ws, msg.name, msg.avatar, msg.clerkToken);
    return;
  }
  if (type === "join") {
    void joinRoom(ws, msg.code, msg.name, null, msg.avatar, msg.clerkToken);
    return;
  }
  if (type === "rejoin") {
    void joinRoom(ws, msg.code, msg.name, msg.token, msg.avatar, msg.clerkToken);
    return;
  }
  if (type === "ping") return send(ws, { type: "pong" });
  if (type === "browse") {
    addBrowser(ws);
    return;
  }

  if (!room || !player) return error(ws, "Join a lobby first");
  if (type === "start") {
    if (player.id !== room.hostId) return error(ws, "Only the host can start");
    if (room.seats.length < MIN_PLAYERS) return error(ws, "Need at least 2 players");
    return startGame(room);
  }
  if (type === "swap") return handleSwap(room, player, msg.hand, msg.faceUp);
  if (type === "ready") return handleReady(room, player);
  if (type === "play") return handlePlay(room, player, msg.play);
  if (type === "pickup") return handlePickup(room, player, msg.tableTake || null);
  if (type === "leave") {
    leave(ws, true);
    send(ws, { type: "left" });
    return;
  }
  error(ws, "Unknown command");
}

setInterval(() => {
  const now = Date.now();
  let dropped = false;
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      clearRoomTimers(room);
      rooms.delete(code);
      dropped = true;
    }
  }
  if (dropped) notifyLobbies();
}, 60 * 1000);

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = String(req.url || "/").split("?")[0];
  if (path === "/lobbies") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ lobbies: publicLobbies() }));
    return;
  }
  if (path === "/health" || path === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "citrons",
        rooms: rooms.size,
        waiting: publicLobbies().length,
        clerk: clerk.clerkConfigured(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  addBrowser(ws);
  ws.on("message", (data) => onMessage(ws, data));
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Citrons multiplayer on :${PORT}`);
});
