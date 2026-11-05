"use strict";

const crypto = require("crypto");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const REJOIN_MS = 3 * 60 * 1000;
const WAITING_REJOIN_MS = 2 * 60 * 1000;
const MAX_GUESSES = 800;

const CODE_TYPES = new Set([
  "codeBrowse",
  "codeCreate",
  "codeJoin",
  "codeRejoin",
  "codeSecret",
  "codeGuess",
  "codeDifficulty",
  "codeAgain",
  "codeLeave",
]);

function makeCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

function parseDigits(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^\d{4}$/.test(s)) return null;
  return s;
}

function parseDifficulty(raw) {
  return String(raw || "").trim().toLowerCase() === "hard" ? "hard" : "easy";
}

/** Public hint for one guess. Never includes the secret. */
function feedback(difficulty, secret, guess) {
  const places = [0, 1, 2, 3].map((i) => secret[i] === guess[i]);
  if (difficulty === "hard") return { kind: "hard", count: places.filter(Boolean).length };
  const pool = [];
  const extras = [];
  for (let i = 0; i < 4; i++) {
    if (!places[i]) pool.push(secret[i]);
  }
  for (let i = 0; i < 4; i++) {
    if (places[i]) continue;
    const at = pool.indexOf(guess[i]);
    if (at < 0) continue;
    extras.push(guess[i]);
    pool.splice(at, 1);
  }
  return { kind: "easy", places, extras };
}

function isOnline(seat) {
  return !!(seat && seat.ws && seat.ws.readyState === 1);
}

function createCodeGame(deps) {
  const codeRooms = new Map();
  const browsers = new Set();
  const rng = typeof deps.rng === "function" ? deps.rng : Math.random;

  function hasCode(code) {
    return codeRooms.has(code);
  }

  function count() {
    return codeRooms.size;
  }

  function isCodeMessage(type) {
    return CODE_TYPES.has(type);
  }

  function uniqueCode() {
    for (let i = 0; i < 40; i++) {
      const code = makeCode();
      if (!codeRooms.has(code) && !(deps.cardCodeTaken && deps.cardCodeTaken(code))) return code;
    }
    return makeCode() + makeCode();
  }

  function seatOf(ws) {
    if (!ws || !ws.codeRoom) return null;
    const room = codeRooms.get(ws.codeRoom);
    if (!room) return null;
    const seat =
      room.seats.find((s) => s.id === ws.codeSeatId) || room.seats.find((s) => s.ws === ws) || null;
    if (!seat) return null;
    return { room, seat };
  }

  function viewFor(room, seat) {
    const opponent = room.seats.find((s) => s.id !== seat.id) || null;
    const turnSeat = room.phase === "playing" ? room.seats[room.turn] : null;
    return {
      type: "codeState",
      code: room.code,
      difficulty: room.difficulty,
      phase: room.phase,
      host: room.hostId === seat.id,
      yourSecret: seat.secret || null,
      opponentSecret: room.phase === "finished" && opponent ? opponent.secret || null : null,
      yourTurn: !!(turnSeat && turnSeat.id === seat.id),
      players: room.seats.map((s) => ({
        id: s.id,
        name: s.id === seat.id ? "You" : s.name,
        avatar: s.avatar || "",
        connected: isOnline(s),
        locked: !!s.secret,
        you: s.id === seat.id,
      })),
      guesses: room.guesses.map((g) => ({
        byYou: g.by === seat.id,
        guess: g.guess,
        feedback: g.feedback,
      })),
      winner: room.winnerId ? (room.winnerId === seat.id ? "you" : "them") : null,
      status: room.status || "",
    };
  }

  function broadcast(room) {
    for (const seat of room.seats) {
      if (isOnline(seat)) deps.send(seat.ws, viewFor(room, seat));
    }
  }

  function publicList() {
    const list = [];
    for (const room of codeRooms.values()) {
      if (room.phase !== "waiting") continue;
      if (room.seats.length >= 2) continue;
      const host = room.seats.find((s) => s.id === room.hostId) || room.seats[0];
      if (!host) continue;
      list.push({
        code: room.code,
        host: host.name,
        hostAvatar: host.avatar || "",
        difficulty: room.difficulty,
        count: room.seats.length,
        max: 2,
      });
    }
    return list;
  }

  function notifyBrowsers() {
    const lobbies = publicList();
    for (const ws of [...browsers]) {
      if (!ws || ws.readyState !== 1) {
        browsers.delete(ws);
        continue;
      }
      deps.send(ws, { type: "codeLobbies", lobbies });
    }
  }

  function clearSeatTimer(seat) {
    if (seat && seat.leaveTimer) {
      clearTimeout(seat.leaveTimer);
      seat.leaveTimer = null;
    }
  }

  function detachSocket(ws) {
    if (!ws) return;
    ws.codeRoom = null;
    ws.codeSeatId = null;
  }

  function startSecrets(room, firstId) {
    room.phase = "secrets";
    room.guesses = [];
    room.winnerId = null;
    room.turn = 0;
    room.pendingFirstId = firstId || null;
    room.status = "";
    for (const seat of room.seats) {
      seat.secret = null;
    }
  }

  function beginPlaying(room) {
    if (room.phase !== "secrets") return;
    if (room.seats.length < 2 || room.seats.some((s) => !s.secret)) return;
    let firstId = room.pendingFirstId;
    if (!room.seats.some((s) => s.id === firstId)) {
      const index = Math.floor(rng() * room.seats.length) % room.seats.length;
      firstId = room.seats[index].id;
    }
    room.turn = room.seats.findIndex((s) => s.id === firstId);
    if (room.turn < 0) room.turn = 0;
    room.phase = "playing";
    room.pendingFirstId = null;
    room.status = "";
  }

  function removeSeat(room, seat) {
    clearSeatTimer(seat);
    const sock = seat.ws;
    seat.ws = null;
    if (sock) {
      detachSocket(sock);
      deps.send(sock, { type: "codeLeft", code: room.code });
    }
    room.seats = room.seats.filter((s) => s.id !== seat.id);
    if (room.seats.length === 0) {
      codeRooms.delete(room.code);
      notifyBrowsers();
      return;
    }
    if (room.hostId === seat.id) room.hostId = room.seats[0].id;
    if (room.phase !== "waiting") {
      room.phase = "waiting";
      room.guesses = [];
      room.winnerId = null;
      room.turn = 0;
      room.pendingFirstId = null;
      room.status = "Opponent left";
      for (const s of room.seats) s.secret = null;
    }
    broadcast(room);
    notifyBrowsers();
  }

  function dropClerk(clerkUserId, exceptCode) {
    if (!clerkUserId) return;
    for (const room of [...codeRooms.values()]) {
      if (exceptCode && room.code === exceptCode) continue;
      const seat = room.seats.find((s) => s.clerkUserId === clerkUserId);
      if (seat) removeSeat(room, seat);
    }
  }

  function dropSocket(ws, immediate) {
    browsers.delete(ws);
    const found = seatOf(ws);
    if (!found) return;
    const { room, seat } = found;
    if (seat.ws && seat.ws !== ws) {
      detachSocket(ws);
      return;
    }
    if (immediate) {
      removeSeat(room, seat);
      return;
    }
    seat.ws = null;
    detachSocket(ws);
    broadcast(room);
    notifyBrowsers();
    clearSeatTimer(seat);
    const delay = room.phase === "waiting" ? WAITING_REJOIN_MS : REJOIN_MS;
    seat.leaveTimer = setTimeout(() => {
      const live = codeRooms.get(room.code);
      if (!live) return;
      const still = live.seats.find((s) => s.id === seat.id);
      if (!still || isOnline(still)) return;
      removeSeat(live, still);
    }, delay);
    if (seat.leaveTimer.unref) seat.leaveTimer.unref();
  }

  function attach(ws, room, seat) {
    browsers.delete(ws);
    const prev = seat.ws;
    if (prev && prev !== ws) {
      detachSocket(prev);
      deps.send(prev, { type: "codeLeft", code: room.code, reason: "replaced" });
      prev.codeRoom = null;
    }
    clearSeatTimer(seat);
    seat.ws = ws;
    ws.codeRoom = room.code;
    ws.codeSeatId = seat.id;
    deps.send(ws, {
      type: "codeJoined",
      code: room.code,
      playerId: seat.id,
      token: seat.token,
      host: room.hostId === seat.id,
    });
    broadcast(room);
    notifyBrowsers();
  }

  function makeSeat(name, avatar, clerkUserId) {
    return {
      id: deps.makeId(),
      token: deps.makeId(),
      name: deps.sanitizeName(name),
      avatar: deps.sanitizeAvatar(avatar),
      clerkUserId: clerkUserId || null,
      ws: null,
      secret: null,
      leaveTimer: null,
    };
  }

  async function auth(ws, token, required) {
    const result = await deps.identifyClerk(ws, token, { required });
    if (!result) return null;
    return { userId: result.userId || null };
  }

  async function handle(ws, msg) {
    const type = msg && msg.type;
    if (type === "codeBrowse") {
      browsers.add(ws);
      deps.send(ws, { type: "codeLobbies", lobbies: publicList() });
      return;
    }
    if (type === "codeCreate") {
      const signed = await auth(ws, msg.clerkToken, true);
      if (!signed) return;
      const userId = signed.userId;
      if (deps.releaseCardClerk) deps.releaseCardClerk(userId);
      if (deps.leaveCard) deps.leaveCard(ws);
      dropClerk(userId, null);
      dropSocket(ws, true);
      const seat = makeSeat(msg.name, msg.avatar, userId);
      const room = {
        code: uniqueCode(),
        difficulty: parseDifficulty(msg.difficulty),
        hostId: seat.id,
        phase: "waiting",
        seats: [seat],
        guesses: [],
        turn: 0,
        winnerId: null,
        pendingFirstId: null,
        status: "",
        createdAt: Date.now(),
      };
      codeRooms.set(room.code, room);
      attach(ws, room, seat);
      return;
    }
    if (type === "codeJoin" || type === "codeRejoin") {
      const code = String(msg.code || "")
        .trim()
        .toUpperCase();
      const room = codeRooms.get(code);
      if (!room) return deps.error(ws, "Room not found");
      const token = type === "codeRejoin" ? String(msg.token || "") : "";
      const signed = await auth(ws, msg.clerkToken, !token);
      if (!signed) return;
      const userId = signed.userId;
      if (deps.releaseCardClerk && userId) deps.releaseCardClerk(userId);
      if (deps.leaveCard) deps.leaveCard(ws);
      dropSocket(ws, true);
      if (userId) dropClerk(userId, room.code);

      if (token) {
        const existing = room.seats.find((s) => s.token === token);
        if (!existing) return deps.error(ws, "Room not found");
        if (existing.clerkUserId && userId && existing.clerkUserId !== userId) {
          return deps.error(ws, "This seat belongs to another account");
        }
        if (userId) existing.clerkUserId = userId;
        if (msg.name) existing.name = deps.sanitizeName(msg.name);
        if (msg.avatar) existing.avatar = deps.sanitizeAvatar(msg.avatar);
        attach(ws, room, existing);
        return;
      }

      if (userId) {
        const existing = room.seats.find((s) => s.clerkUserId === userId);
        if (existing) {
          if (msg.name) existing.name = deps.sanitizeName(msg.name);
          if (msg.avatar) existing.avatar = deps.sanitizeAvatar(msg.avatar);
          attach(ws, room, existing);
          return;
        }
      }

      if (room.phase !== "waiting" || room.seats.length >= 2) {
        return deps.error(ws, "Game already started");
      }
      const seat = makeSeat(msg.name, msg.avatar, userId);
      room.seats.push(seat);
      startSecrets(room, null);
      attach(ws, room, seat);
      return;
    }
    if (type === "codeLeave") {
      dropSocket(ws, true);
      return;
    }

    const found = seatOf(ws);
    if (!found) return deps.error(ws, "Join a room first");
    const { room, seat } = found;

    if (type === "codeDifficulty") {
      if (room.hostId !== seat.id) return deps.error(ws, "Only the host can change difficulty");
      if (room.phase !== "waiting" || room.seats.length > 1) {
        return deps.error(ws, "Difficulty is locked");
      }
      room.difficulty = parseDifficulty(msg.difficulty);
      broadcast(room);
      notifyBrowsers();
      return;
    }
    if (type === "codeSecret") {
      if (room.phase !== "secrets") return deps.error(ws, "Codes are already set");
      if (msg.clear) {
        seat.secret = null;
        broadcast(room);
        return;
      }
      const digits = parseDigits(msg.secret);
      if (!digits) return deps.error(ws, "Enter 4 digits");
      seat.secret = digits;
      beginPlaying(room);
      broadcast(room);
      return;
    }
    if (type === "codeGuess") {
      if (room.phase !== "playing") return deps.error(ws, "Wait for both codes");
      const turnSeat = room.seats[room.turn];
      if (!turnSeat || turnSeat.id !== seat.id) return deps.error(ws, "Wait for your turn");
      if (room.guesses.length >= MAX_GUESSES) return deps.error(ws, "Too many guesses");
      const digits = parseDigits(msg.guess);
      if (!digits) return deps.error(ws, "Enter 4 digits");
      const opponent = room.seats.find((s) => s.id !== seat.id);
      if (!opponent || !opponent.secret) return deps.error(ws, "Wait for both codes");
      const hint = feedback(room.difficulty, opponent.secret, digits);
      room.guesses.push({ by: seat.id, guess: digits, feedback: hint });
      if (digits === opponent.secret) {
        room.phase = "finished";
        room.winnerId = seat.id;
        room.status = "";
      } else {
        const next = room.seats.findIndex((s) => s.id !== seat.id);
        room.turn = next < 0 ? room.turn : next;
      }
      broadcast(room);
      return;
    }
    if (type === "codeAgain") {
      if (room.phase !== "finished") return deps.error(ws, "Finish the round first");
      if (room.seats.length < 2 || room.seats.some((s) => !isOnline(s))) {
        return deps.error(ws, "Wait for your opponent");
      }
      const loser = room.seats.find((s) => s.id !== room.winnerId);
      startSecrets(room, loser ? loser.id : null);
      broadcast(room);
      return;
    }
    deps.error(ws, "Unknown command");
  }

  function sweep(now) {
    const t = now || Date.now();
    let dropped = false;
    for (const [code, room] of [...codeRooms]) {
      if (t - room.createdAt > ROOM_TTL_MS) {
        for (const seat of room.seats) {
          clearSeatTimer(seat);
          if (seat.ws) {
            detachSocket(seat.ws);
            deps.send(seat.ws, { type: "codeLeft", code });
          }
        }
        codeRooms.delete(code);
        dropped = true;
      }
    }
    if (dropped) notifyBrowsers();
  }

  return {
    handle,
    dropSocket,
    dropClerk,
    sweep,
    count,
    hasCode,
    isCodeMessage,
    feedback,
    parseDigits,
  };
}

module.exports = {
  createCodeGame,
  feedback,
  parseDigits,
  parseDifficulty,
};
