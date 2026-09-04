"use strict";

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const engine = require("./engine");
const clerk = require("./clerk");
const leaderboard = require("./leaderboard");
const push = require("./push");

push.init();

const INVITE_GAP_MS = 4000;
const MAX_INVITE_IDS = 8;
const inviteAt = new Map();

const PORT = Number(process.env.PORT) || 8787;
const SWAP_SECONDS = 20;
const DEAL_STEP_MS = 200;
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;
const MAX_SPECTATORS = 16;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const REJOIN_MS = 3 * 60 * 1000;
const WAITING_REJOIN_MS = 2 * 60 * 1000;
const TABLE_SKINS = new Set(["felt", "peli"]);
const CARD_BACKS = new Set(["classic", "shades"]);
const CHAT_MAX_LEN = 120;
const CHAT_MAX_LOG = 50;
const ROOM_TITLE_MAX = 28;
const CHAT_GAP_MS = 400;
const REACT_GAP_MS = 450;
const KICK_VOTE_MS = 20000;
const KICK_COOLDOWN_MS = 12000;
const REACT_EMOJIS = new Set([
  "🍋",
  "😂",
  "⁶🤷⁷",
  "🔥",
  "💀",
  "😎",
  "😭",
  "👏",
  "🃏",
  "😱",
  "🤡",
  "💪",
  "👀",
  "🫠",
  "🫡",
  "🫣",
  "🤣",
  "😈",
  "😤",
  "👑",
  "🍀",
  "🎯",
  "💤",
  "🤔",
  "💩",
  "❤️",
  "🤝",
  "🙃",
  "🥴",
  "😬",
  "🤙",
]);

const rooms = new Map();
const browsers = new Set();

function roomSpectators(room) {
  return Array.isArray(room.spectators) ? room.spectators : [];
}

function roomLive(room) {
  return room.phase === "dealing" || room.phase === "swap" || room.phase === "playing" || room.phase === "finished";
}

function publicLobbies() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.phase === "finished") continue;
    const host = room.seats.find((p) => p.id === room.hostId) || room.seats[0];
    const live = roomLive(room);
    const watchers = roomSpectators(room).filter((s) => isOnline(s)).length;
    list.push({
      code: room.code,
      title: room.title || (host ? `${host.name}'s lobby` : "Lobby"),
      host: host ? host.name : "Host",
      hostAvatar: (host && host.avatar) || "",
      players: room.seats.map((p) => ({ name: p.name, avatar: p.avatar || "" })),
      count: room.seats.length,
      max: MAX_PLAYERS,
      live,
      watchers,
      watchMax: MAX_SPECTATORS,
    });
  }
  list.sort((a, b) => {
    const liveDelta = Number(a.live) - Number(b.live);
    if (liveDelta !== 0) return liveDelta;
    return b.count - a.count || String(a.title).localeCompare(String(b.title));
  });
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

function isOnline(p) {
  return !!(p && p.ws && p.ws.readyState === 1);
}

function maskPlayer(p, isSelf) {
  return {
    id: p.id,
    name: isSelf ? "You" : p.name,
    avatar: p.avatar || "",
    ready: !!p.ready,
    connected: isOnline(p),
    hand: isSelf ? [...p.hand] : p.hand.map(() => dummyCard()),
    faceUp: [...p.faceUp],
    faceDown: isSelf ? [...p.faceDown] : p.faceDown.map((c) => (c === null ? null : dummyCard())),
  };
}

function kickEligible(room, targetId) {
  return room.seats.filter((p) => p.id !== targetId && !engine.playerFinished(p));
}

function kickVoteView(room, viewerId) {
  const v = room.kickVote;
  if (!v) return null;
  const target = room.seats.find((p) => p.id === v.targetId);
  if (!target) return null;
  const starter = room.seats.find((p) => p.id === v.starterId);
  const eligible = kickEligible(room, v.targetId);
  return {
    targetId: v.targetId,
    targetName: target.name,
    starterName: starter ? starter.name : "Player",
    yes: eligible.filter((p) => v.yes.has(p.id)).length,
    no: eligible.filter((p) => v.no.has(p.id)).length,
    need: Math.floor(eligible.length / 2) + 1,
    endsAt: v.endsAt,
    isTarget: viewerId === v.targetId,
    youVoted: v.yes.has(viewerId) || v.no.has(viewerId),
    canVote: eligible.some((p) => p.id === viewerId) && !v.yes.has(viewerId) && !v.no.has(viewerId),
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
    title: room.title || "",
    you: 0,
    youId: playerId,
    host: room.hostId === playerId,
    spectator: false,
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
    tableSkin: TABLE_SKINS.has(room.tableSkin) ? room.tableSkin : "felt",
    cardBack: CARD_BACKS.has(room.cardBack) ? room.cardBack : "classic",
    chat: Array.isArray(room.chat) ? room.chat : [],
    watchers: roomSpectators(room).filter((s) => isOnline(s)).length,
    kickVote: kickVoteView(room, playerId),
    lobby: room.seats.map((p) => ({
      id: p.id,
      name: p.id === playerId ? `${p.name} (you)` : p.name,
      avatar: p.avatar || "",
      ready: !!p.ready,
      connected: isOnline(p),
      host: p.id === room.hostId,
    })),
  };
}

function viewForSpectator(room, spectatorId) {
  const players = room.seats.map((src) => maskPlayer(src, false));
  return {
    code: room.code,
    title: room.title || "",
    you: -1,
    youId: spectatorId,
    host: false,
    spectator: true,
    phase: room.phase,
    players,
    deckCount: room.deck.length,
    discard: [...room.discard],
    currentPlayer: room.phase === "waiting" ? 0 : room.currentPlayer,
    finishOrder: [...room.finishOrder],
    swapSeconds: room.swapSeconds,
    burnCount: room.burnCount,
    statusMsg: room.statusMsg,
    canStart: false,
    tableSkin: TABLE_SKINS.has(room.tableSkin) ? room.tableSkin : "felt",
    cardBack: CARD_BACKS.has(room.cardBack) ? room.cardBack : "classic",
    chat: Array.isArray(room.chat) ? room.chat : [],
    watchers: roomSpectators(room).filter((s) => isOnline(s)).length,
    kickVote: kickVoteView(room, spectatorId),
    lobby: room.seats.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar || "",
      ready: !!p.ready,
      connected: isOnline(p),
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
  for (const s of roomSpectators(room)) {
    if (!s.ws) continue;
    send(s.ws, { type: "state", view: viewForSpectator(room, s.id), anim: animForSpectator(anim) });
  }
}

function animForSpectator(anim) {
  if (!anim) return undefined;
  return {
    kind: anim.kind,
    fromPlayer: anim.fromPlayer,
    played: [...(anim.played || [])],
    willBurn: !!anim.willBurn,
    burnCards: [...(anim.burnCards || [])],
    drawn: (anim.drawn || []).map(() => dummyCard()),
    pickup: anim.pickup
      ? {
          cards: anim.pickup.cards.map(() => dummyCard()),
          toPlayer: anim.pickup.toPlayer,
        }
      : null,
  };
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

function dropSpectators(room) {
  for (const s of roomSpectators(room)) {
    if (s.ws) {
      s.ws.roomCode = null;
      s.ws.playerId = null;
      send(s.ws, { type: "left", code: room.code });
      addBrowser(s.ws);
    }
  }
  room.spectators = [];
}

function removeSeat(room, player) {
  room.seats = room.seats.filter((p) => p.id !== player.id);
  if (room.seats.length === 0) {
    dropSpectators(room);
    clearRoomTimers(room);
    rooms.delete(room.code);
    return false;
  }
  if (room.hostId === player.id) room.hostId = room.seats[0].id;
  return true;
}

function attach(ws, room, player) {
  browsers.delete(ws);
  detachSpectator(ws, room);
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

function detachSpectator(ws, keepRoom) {
  const prev = rooms.get(ws.roomCode);
  if (!prev) return;
  const before = roomSpectators(prev).length;
  prev.spectators = roomSpectators(prev).filter((s) => s.ws !== ws && s.id !== ws.playerId);
  if (prev !== keepRoom && prev.spectators.length !== before) notifyLobbies();
}

function attachSpectator(ws, room, spectator) {
  browsers.delete(ws);
  if (ws.roomCode && ws.roomCode !== room.code) leave(ws, true);
  if (!Array.isArray(room.spectators)) room.spectators = [];
  room.spectators = room.spectators.filter((s) => s !== spectator && s.ws !== ws && s.id !== spectator.id);
  room.spectators.push(spectator);
  spectator.ws = ws;
  spectator.connected = true;
  ws.roomCode = room.code;
  ws.playerId = spectator.id;
  send(ws, { type: "joined", code: room.code, playerId: spectator.id, spectator: true });
  broadcast(room);
  notifyLobbies();
}

function makeSpectator(ws, name, avatar, clerkUserId) {
  return {
    id: id(),
    name: sanitizeName(name),
    avatar: sanitizeAvatar(avatar),
    clerkUserId: clerkUserId || null,
    ws,
    connected: true,
    lastChatAt: 0,
    lastReactAt: 0,
  };
}

function sanitizeName(name) {
  const n = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return n || "Player";
}

function sanitizeTitle(title, fallback) {
  const n = String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOM_TITLE_MAX);
  if (n) return n;
  const host = sanitizeName(fallback);
  return host === "Player" ? "Lobby" : `${host}'s lobby`;
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

function gatherSeatCards(player) {
  const cards = [];
  for (const c of player.hand || []) if (c) cards.push(c);
  for (const c of player.faceUp || []) if (c) cards.push(c);
  for (const c of player.faceDown || []) if (c) cards.push(c);
  return cards;
}

function ejectFromMatch(room, player, opts = {}) {
  const idx = room.seats.indexOf(player);
  if (idx < 0) return;
  const inMatch = room.phase === "playing" || room.phase === "swap" || room.phase === "dealing";
  if (!inMatch) {
    if (removeSeat(room, player) && rooms.has(room.code)) broadcast(room);
    notifyLobbies();
    return;
  }

  if (room.kickVote) {
    if (room.kickVote.targetId === player.id) clearKickVote(room);
    else {
      room.kickVote.yes.delete(player.id);
      room.kickVote.no.delete(player.id);
    }
  }
  const dumped = gatherSeatCards(player);
  if (dumped.length) {
    if (opts.toBurn) room.burnCount = (room.burnCount || 0) + dumped.length;
    else room.discard = [...room.discard, ...dumped];
  }
  const name = player.name;
  const verb = opts.verb || "left";
  const wasTurn = room.currentPlayer === idx;
  const currentId = room.seats[room.currentPlayer] && room.seats[room.currentPlayer].id;

  if (!removeSeat(room, player)) {
    notifyLobbies();
    return;
  }
  room.finishOrder = (room.finishOrder || [])
    .filter((i) => i !== idx)
    .map((i) => (i > idx ? i - 1 : i));

  if (!rooms.has(room.code) || room.seats.length === 0) {
    notifyLobbies();
    return;
  }

  const n = room.seats.length;
  if (wasTurn) {
    const next = idx % n;
    room.currentPlayer = engine.nextAlive((next + n - 1) % n, room.seats);
  } else {
    const found = room.seats.findIndex((p) => p.id === currentId);
    room.currentPlayer = found >= 0 ? found : 0;
  }

  const alive = engine.unfinishedPlayers(room.seats);
  if (alive.length <= 1) {
    if (alive.length === 1 && !room.finishOrder.includes(alive[0])) room.finishOrder.push(alive[0]);
    room.phase = "finished";
    room.statusMsg = `${name} ${verb} · Game over`;
    saveFinishedGame(room);
  } else if (room.phase === "playing") {
    const turnName = room.seats[room.currentPlayer] ? room.seats[room.currentPlayer].name : "";
    room.statusMsg = `${name} ${verb} · Turn: ${turnName}`;
  } else {
    room.statusMsg = `${name} ${verb}`;
  }
  broadcast(room);
  notifyLobbies();
  if (room.kickVote) tallyKickVote(room);
}

function abandonSeat(room, player) {
  if (!room || !player) return;
  if (player.leaveTimer) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
  }
  if (player.ws) {
    send(player.ws, { type: "left", code: room.code });
    player.ws.roomCode = null;
    player.ws.playerId = null;
    player.ws = null;
  }
  ejectFromMatch(room, player);
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

async function createRoom(ws, name, avatar, clerkToken, title) {
  const auth = await identifyClerk(ws, clerkToken, { required: true });
  if (!auth) return;
  const clerkUserId = auth.userId;
  releaseClerk(clerkUserId, null);
  leave(ws, true);
  const code = uniqueCode();
  const player = makePlayer(ws, name, avatar, clerkUserId);
  const room = {
    code,
    title: sanitizeTitle(title, player.name),
    hostId: player.id,
    phase: "waiting",
    seats: [player],
    deck: [],
    discard: [],
    currentPlayer: 0,
    finishOrder: [],
    swapSeconds: SWAP_SECONDS,
    burnCount: 0,
    boardSaved: false,
    tableSkin: "felt",
    cardBack: "classic",
    chat: [],
    statusMsg: "",
    createdAt: Date.now(),
    timers: [],
    spectators: [],
    kickVote: null,
    kickCooldownUntil: 0,
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
  }

  if (room.phase !== "waiting") {
    const watching = roomSpectators(room).find((s) => s.clerkUserId && s.clerkUserId === clerkUserId);
    if (watching) {
      if (name) watching.name = sanitizeName(name);
      if (avatar) watching.avatar = sanitizeAvatar(avatar);
      attachSpectator(ws, room, watching);
      return;
    }
    if (roomSpectators(room).length >= MAX_SPECTATORS) return error(ws, "This table is full of watchers");
    if (!Array.isArray(room.spectators)) room.spectators = [];
    const spectator = makeSpectator(ws, name, avatar, clerkUserId);
    room.spectators.push(spectator);
    attachSpectator(ws, room, spectator);
    return;
  }
  if (room.seats.length >= MAX_PLAYERS) return error(ws, "Lobby is full");
  releaseClerk(clerkUserId, room.code);

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

function sanitizeChat(text) {
  return String(text || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}

function handleReact(room, player, emoji) {
  const face = String(emoji || "");
  if (!REACT_EMOJIS.has(face)) return;
  const now = Date.now();
  if (player.lastReactAt && now - player.lastReactAt < REACT_GAP_MS) return;
  player.lastReactAt = now;
  const react = { id: id(), emoji: face, fromId: player.id, name: player.name, at: now };
  for (const p of room.seats) {
    if (!p.ws) continue;
    send(p.ws, { type: "react", react });
  }
  for (const s of roomSpectators(room)) {
    if (!s.ws) continue;
    send(s.ws, { type: "react", react });
  }
}

function handleChat(room, player, text) {
  const body = sanitizeChat(text);
  if (!body) return;
  const now = Date.now();
  if (player.lastChatAt && now - player.lastChatAt < CHAT_GAP_MS) return;
  player.lastChatAt = now;
  const watching = roomSpectators(room).some((s) => s.id === player.id);
  const line = {
    id: id(),
    fromId: player.id,
    name: watching ? `${player.name} (watch)` : player.name,
    text: body,
    at: now,
  };
  if (!Array.isArray(room.chat)) room.chat = [];
  room.chat.push(line);
  if (room.chat.length > CHAT_MAX_LOG) room.chat = room.chat.slice(-CHAT_MAX_LOG);
  for (const p of room.seats) {
    if (!p.ws) continue;
    send(p.ws, { type: "chat", line });
  }
  for (const s of roomSpectators(room)) {
    if (!s.ws) continue;
    send(s.ws, { type: "chat", line });
  }
}

function clearKickVote(room) {
  if (room.kickVote && room.kickVote.timer) {
    clearTimeout(room.kickVote.timer);
  }
  room.kickVote = null;
}

function failKickVote(room, reason) {
  if (!room.kickVote) return;
  const name = room.kickVote.targetName || "Player";
  clearKickVote(room);
  room.kickCooldownUntil = Date.now() + KICK_COOLDOWN_MS;
  room.statusMsg = reason || `Kick vote against ${name} failed`;
  broadcast(room);
}

function tallyKickVote(room) {
  const v = room.kickVote;
  if (!v) return;
  const target = room.seats.find((p) => p.id === v.targetId);
  if (!target) {
    failKickVote(room, "Kick vote cancelled");
    return;
  }
  const eligible = kickEligible(room, v.targetId);
  const need = Math.floor(eligible.length / 2) + 1;
  const yes = eligible.filter((p) => v.yes.has(p.id)).length;
  const pending = eligible.filter((p) => !v.yes.has(p.id) && !v.no.has(p.id)).length;
  if (yes >= need) {
    applyKick(room, target);
    return;
  }
  if (yes + pending < need) {
    failKickVote(room, `Kick vote against ${target.name} failed`);
  }
}

function applyKick(room, player) {
  clearKickVote(room);
  if (player.leaveTimer) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
  }
  if (player.ws) {
    send(player.ws, { type: "kicked", code: room.code, message: "The table voted you out" });
    addBrowser(player.ws);
    player.ws.roomCode = null;
    player.ws.playerId = null;
    player.ws = null;
  }
  ejectFromMatch(room, player, { toBurn: true, verb: "was kicked" });
}

function handleKickStart(room, player, targetId) {
  if (room.phase !== "playing" && room.phase !== "swap") return error(player.ws, "You can only start a kick vote during the match");
  if (engine.playerFinished(player)) return error(player.ws, "You're out of this match");
  if (room.kickVote) return error(player.ws, "A kick vote is already running");
  if (Date.now() < (room.kickCooldownUntil || 0)) return error(player.ws, "Wait a moment before another kick vote");
  const tid = String(targetId || "");
  if (!tid || tid === player.id) return error(player.ws, "You can't kick yourself");
  const target = room.seats.find((p) => p.id === tid);
  if (!target) return error(player.ws, "Player not found");
  if (engine.playerFinished(target)) return error(player.ws, "That player is already out");
  const eligible = kickEligible(room, target.id);
  if (eligible.length < 2) return error(player.ws, "Need at least 3 players to vote someone out");
  const vote = {
    targetId: target.id,
    targetName: target.name,
    starterId: player.id,
    yes: new Set([player.id]),
    no: new Set(),
    endsAt: Date.now() + KICK_VOTE_MS,
    timer: null,
  };
  vote.timer = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r || r.kickVote !== vote) return;
    tallyKickVote(r);
    if (r.kickVote === vote) failKickVote(r, `Kick vote against ${target.name} timed out`);
  }, KICK_VOTE_MS);
  room.kickVote = vote;
  room.statusMsg = `Vote: kick ${target.name}?`;
  broadcast(room);
  tallyKickVote(room);
}

function handleKickVote(room, player, yes) {
  const v = room.kickVote;
  if (!v) return error(player.ws, "No kick vote running");
  if (player.id === v.targetId) return error(player.ws, "You can't vote on your own kick");
  if (engine.playerFinished(player)) return error(player.ws, "You're out of this match");
  if (v.yes.has(player.id) || v.no.has(player.id)) return error(player.ws, "You already voted");
  if (!kickEligible(room, v.targetId).some((p) => p.id === player.id)) return error(player.ws, "You can't vote on this kick");
  if (yes) v.yes.add(player.id);
  else v.no.add(player.id);
  broadcast(room);
  tallyKickVote(room);
}

function resetRoomToLobby(room) {
  if (room.phase !== "finished") return;
  clearRoomTimers(room);
  for (const p of room.seats) {
    p.hand = [];
    p.faceUp = [];
    p.faceDown = [];
    p.ready = false;
  }
  room.deck = [];
  room.discard = [];
  room.finishOrder = [];
  room.burnCount = 0;
  room.currentPlayer = 0;
  room.swapSeconds = SWAP_SECONDS;
  room.statusMsg = "";
  room.phase = "waiting";
  clearKickVote(room);
  dropSpectators(room);
  broadcast(room);
  notifyLobbies();
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
  room.boardSaved = false;
  room.currentPlayer = 0;
  clearKickVote(room);
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
    saveFinishedGame(room);
    return true;
  }
  return false;
}

function saveFinishedGame(room) {
  if (room.boardSaved) return;
  room.boardSaved = true;
  try {
    leaderboard.recordGame(room);
  } catch (err) {
    room.boardSaved = false;
    console.error("leaderboard save failed", err);
  }
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
  const stillIn = engine.unfinishedPlayers(room.seats).length;
  const outPrefix =
    result.won && stillIn > 1 ? `${room.seats[playerIndex].name} is out · ${stillIn} still in. ` : "";
  if (result.extraTurn && !engine.playerFinished(room.seats[playerIndex])) {
    room.currentPlayer = playerIndex;
    room.statusMsg = `${outPrefix}Turn: ${room.seats[playerIndex].name} (again)`;
  } else {
    room.currentPlayer = engine.nextAlive(playerIndex, room.seats);
    room.statusMsg = `${outPrefix}Turn: ${room.seats[room.currentPlayer].name}`;
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

function handleMeddle(room, player, play) {
  if (room.phase !== "playing") return error(player.ws, "You can only meddle during the match");
  const idx = room.seats.indexOf(player);
  if (idx < 0) return error(player.ws, "Join a lobby first");
  if (idx === room.currentPlayer) return error(player.ws, "It's your turn — use Play");
  if (engine.playerFinished(player)) return error(player.ws, "You're out of this match");
  const handIdx = play && Array.isArray(play.hand) ? play.hand.map(Number) : [];
  if (handIdx.length === 0) return error(player.ws, "Select cards to meddle");
  if ((play && play.faceUp && play.faceUp.length > 0) || (play && play.faceDown !== undefined)) {
    return error(player.ws, "Meddle from your hand");
  }
  const cards = [];
  for (const i of handIdx) {
    const c = player.hand[i];
    if (!c) return error(player.ws, "Can't play that");
    cards.push(c);
  }
  if (!engine.canMeddlePlay(cards, room.discard)) {
    return error(player.ws, "Meddle only if those cards burn the pile");
  }
  const result = engine.applyPlay(idx, { hand: handIdx, faceUp: [] }, room.seats, room.deck, room.discard);
  if (!result.ok) return error(player.ws, result.message);
  if (!result.willBurn) return error(player.ws, "Meddle only if those cards burn the pile");
  result.message = `${player.name} meddles — discard burned!`;
  afterPlay(room, idx, result);
}

function handlePickup(room, player, tableTake) {
  if (room.phase !== "playing") return error(player.ws, "You can't take cards right now");
  const idx = room.seats.indexOf(player);
  if (idx !== room.currentPlayer) return error(player.ws, "It's not your turn");
  if (engine.mustTakeTableWithPickup(player) && (!tableTake || tableTake.zone !== "faceUp")) {
    return error(player.ws, "Tap a face-up card to take it with the discard");
  }
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

  const spectator = roomSpectators(room).find((s) => s.id === ws.playerId || s.ws === ws);
  if (spectator) {
    if (spectator.ws && spectator.ws !== ws) {
      ws.roomCode = null;
      ws.playerId = null;
      return;
    }
    if (spectator.ws === ws) spectator.ws = null;
    spectator.connected = false;
    room.spectators = roomSpectators(room).filter((s) => s.id !== spectator.id);
    ws.roomCode = null;
    ws.playerId = null;
    broadcast(room);
    notifyLobbies();
    return;
  }

  const player = room.seats.find((p) => p.id === ws.playerId) || room.seats.find((p) => p.ws === ws);
  if (!player) return;
  if (player.ws && player.ws !== ws) {
    ws.roomCode = null;
    ws.playerId = null;
    return;
  }
  if (player.ws === ws) player.ws = null;
  player.connected = false;
  ws.roomCode = null;
  ws.playerId = null;

  if (immediate) {
    abandonSeat(room, player);
    return;
  }

  broadcast(room);
  notifyLobbies();

  if (player.leaveTimer) clearTimeout(player.leaveTimer);
  const delay = room.phase === "waiting" ? WAITING_REJOIN_MS : REJOIN_MS;
  player.leaveTimer = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r) return;
    const p = r.seats.find((x) => x.id === player.id);
    if (!p || isOnline(p)) return;
    abandonSeat(r, p);
  }, delay);
}

async function handlePushSubscribe(ws, msg) {
  const auth = await identifyClerk(ws, msg.clerkToken, { required: true });
  if (!auth || !auth.userId) return;
  const ok = push.subscribe(auth.userId, msg.name, msg.avatar, msg.subscription);
  send(ws, { type: "pushReady", ok: !!ok, welcome: !!(ok && msg.welcome) });
  if (ok && msg.welcome) void push.sendWelcome(auth.userId);
}

async function handlePushTest(ws, msg) {
  const auth = await identifyClerk(ws, msg.clerkToken, { required: true });
  if (!auth || !auth.userId) return;
  const result = await push.sendTest(auth.userId);
  if (result.sent) send(ws, { type: "pushReady", ok: true, test: true });
  else error(ws, "Turn on invites on this device first");
}

async function handlePushUnsubscribe(ws, msg) {
  const auth = await identifyClerk(ws, msg.clerkToken, { required: true });
  if (!auth || !auth.userId) return;
  push.unsubscribe(auth.userId, msg.endpoint);
  send(ws, { type: "pushReady", ok: true });
}

function handleInviteList(ws, room, player) {
  if (room.phase !== "waiting") return error(ws, "Invite from the waiting room");
  if (!player.clerkUserId) return error(ws, "Sign in to invite");
  const seated = new Set(room.seats.map((p) => p.clerkUserId).filter(Boolean));
  const users = push.listUsers(player.clerkUserId).filter((u) => !seated.has(u.id));
  send(ws, { type: "inviteList", users });
}

async function handleInvite(ws, room, player, userIds) {
  if (room.phase !== "waiting") return error(ws, "Invite from the waiting room");
  if (!player.clerkUserId) return error(ws, "Sign in to invite");
  if (!push.ready()) return error(ws, "Invites are not available yet");
  const now = Date.now();
  const last = inviteAt.get(player.clerkUserId) || 0;
  if (now - last < INVITE_GAP_MS) return error(ws, "Wait a moment before inviting again");
  const seated = new Set(room.seats.map((p) => p.clerkUserId).filter(Boolean));
  const ids = Array.isArray(userIds) ? userIds.slice(0, MAX_INVITE_IDS) : [];
  const targets = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw || "")
      .replace(/[^\w-]/g, "")
      .slice(0, 64);
    if (!id || seen.has(id) || id === player.clerkUserId || seated.has(id)) continue;
    seen.add(id);
    targets.push(id);
  }
  if (targets.length === 0) return error(ws, "Pick someone to invite");
  inviteAt.set(player.clerkUserId, now);
  const result = await push.sendInvite({
    fromName: player.name,
    code: room.code,
    title: room.title,
    userIds: targets,
  });
  send(ws, { type: "inviteSent", sent: result.sent, failed: result.failed });
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
  const spectator = room && roomSpectators(room).find((s) => s.id === ws.playerId);

  if (type === "create") {
    void createRoom(ws, msg.name, msg.avatar, msg.clerkToken, msg.title);
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
  if (type === "pushSubscribe") {
    void handlePushSubscribe(ws, msg);
    return;
  }
  if (type === "pushUnsubscribe") {
    void handlePushUnsubscribe(ws, msg);
    return;
  }
  if (type === "pushTest") {
    void handlePushTest(ws, msg);
    return;
  }

  if (spectator && !player) {
    if (type === "chat") return handleChat(room, spectator, msg.text);
    if (type === "react") return handleReact(room, spectator, msg.emoji);
    if (type === "leave") {
      leave(ws, true);
      send(ws, { type: "left", code: room.code });
      return;
    }
    return error(ws, "You're watching this table");
  }

  if (!room || !player) return error(ws, "Join a lobby first");
  if (type === "start") {
    if (player.id !== room.hostId) return error(ws, "Only the host can start");
    if (room.seats.length < MIN_PLAYERS) return error(ws, "Need at least 2 players");
    return startGame(room);
  }
  if (type === "skin") {
    if (player.id !== room.hostId) return error(ws, "Only the host can change the table");
    if (room.phase !== "waiting") return error(ws, "Table can only be changed before the game starts");
    const skin = String(msg.skin || "");
    if (!TABLE_SKINS.has(skin)) return error(ws, "Unknown table skin");
    room.tableSkin = skin;
    broadcast(room);
    return;
  }
  if (type === "back") {
    if (player.id !== room.hostId) return error(ws, "Only the host can change the card back");
    if (room.phase !== "waiting") return error(ws, "Card back can only be changed before the game starts");
    const back = String(msg.back || "");
    if (!CARD_BACKS.has(back)) return error(ws, "Unknown card back");
    room.cardBack = back;
    broadcast(room);
    return;
  }
  if (type === "chat") {
    return handleChat(room, player, msg.text);
  }
  if (type === "react") {
    return handleReact(room, player, msg.emoji);
  }
  if (type === "lobby") {
    return resetRoomToLobby(room);
  }
  if (type === "swap") return handleSwap(room, player, msg.hand, msg.faceUp);
  if (type === "ready") return handleReady(room, player);
  if (type === "kick") return handleKickStart(room, player, msg.targetId);
  if (type === "kickVote") return handleKickVote(room, player, !!msg.yes);
  if (type === "play") return handlePlay(room, player, msg.play);
  if (type === "meddle") return handleMeddle(room, player, msg.play);
  if (type === "pickup") return handlePickup(room, player, msg.tableTake || null);
  if (type === "leave") {
    leave(ws, true);
    send(ws, { type: "left", code: room.code });
    return;
  }
  if (type === "inviteList") {
    return handleInviteList(ws, room, player);
  }
  if (type === "invite") {
    void handleInvite(ws, room, player, msg.userIds);
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
  if (path === "/leaderboard") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ players: leaderboard.top(), matches: leaderboard.matches() }));
    return;
  }
  if (path === "/stats") {
    const q = new URL(req.url || "/", "http://citrons.local").searchParams.get("id");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ player: leaderboard.stats(q) }));
    return;
  }
  if (path === "/push/vapid") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ publicKey: push.publicKey() }));
    return;
  }
  if (path === "/health" || path === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "citrons",
        rooms: rooms.size,
        waiting: [...rooms.values()].filter((r) => r.phase === "waiting").length,
        live: [...rooms.values()].filter((r) => roomLive(r)).length,
        clerk: clerk.clerkConfigured(),
        push: push.ready(),
        leaderboard: (() => {
          const board = leaderboard.info();
          return {
            clerk: board.clerk,
            clerkKind: board.clerkKind,
            expectedKind: board.expectedKind,
            mismatch: board.mismatch,
            players: board.players,
            pending: board.pending,
            lastError: board.lastError || undefined,
          };
        })(),
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

Promise.resolve(leaderboard.hydrateFromClerk())
  .catch((err) => console.error("leaderboard hydrate failed", err))
  .finally(() => {
    leaderboard.startSyncLoop();
    server.listen(PORT, "0.0.0.0", () => {
      const board = leaderboard.info();
      console.log(`Citrons multiplayer on :${PORT}`);
      console.log(
        `leaderboard file=${board.file} clerk=${board.clerkKind} expected=${board.expectedKind} players=${board.players} pending=${board.pending}`
      );
      if (board.mismatch || board.clerkKind === "off") {
        console.error(
          "leaderboard will not survive deploys until Railway CLERK_SECRET_KEY is the matching live Clerk secret"
        );
      }
    });
  });
