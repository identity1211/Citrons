"use strict";

const crypto = require("crypto");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const REJOIN_MS = 3 * 60 * 1000;
const WAITING_REJOIN_MS = 2 * 60 * 1000;
const MAX_GUESSES = 400;
const TOURNAMENT_GOAL = 3;
const MIN_NUMBER = 1;
const MAX_NUMBER = 9999;
/** Both players see 3-2-1 before the first guess is accepted. */
const COUNTDOWN_MS = 3500;
/** A person cannot type a number faster than this. It only slows down scripts. */
const MIN_GUESS_GAP_MS = 250;

const HILO_TYPES = new Set([
  "hiloBrowse",
  "hiloCreate",
  "hiloJoin",
  "hiloRejoin",
  "hiloSecret",
  "hiloGuess",
  "hiloDifficulty",
  "hiloAgain",
  "hiloTournament",
  "hiloLeave",
]);

function makeCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

/** A whole number from 1 to 9999, typed without a sign, a dot or a leading zero. */
function parseNumber(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^[1-9]\d{0,3}$/.test(s)) return null;
  return Number(s);
}

function parseDifficulty(raw) {
  return String(raw || "").trim().toLowerCase() === "hard" ? "hard" : "easy";
}

function parseTournament(raw) {
  return raw === true || raw === 1 || String(raw || "").trim().toLowerCase() === "true";
}

/** "up": the secret is higher than the guess. "down": it is lower. "hit": found. */
function compare(secret, guess) {
  if (guess === secret) return "hit";
  return secret > guess ? "up" : "down";
}

function isOnline(seat) {
  return !!(seat && seat.ws && seat.ws.readyState === 1);
}

function createHiloGame(deps) {
  const rooms = new Map();
  const browsers = new Set();
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const countdownMs = Number.isFinite(deps.countdownMs) ? deps.countdownMs : COUNTDOWN_MS;
  const guessGapMs = Number.isFinite(deps.guessGapMs) ? deps.guessGapMs : MIN_GUESS_GAP_MS;

  function hasCode(code) {
    return rooms.has(code);
  }

  function count() {
    return rooms.size;
  }

  function isHiloMessage(type) {
    return HILO_TYPES.has(type);
  }

  function uniqueCode() {
    for (let i = 0; i < 40; i++) {
      const code = makeCode();
      if (!rooms.has(code) && !(deps.codeTaken && deps.codeTaken(code))) return code;
    }
    return makeCode() + makeCode();
  }

  function seatOf(ws) {
    if (!ws || !ws.hiloRoom) return null;
    const room = rooms.get(ws.hiloRoom);
    if (!room) return null;
    const seat =
      room.seats.find((s) => s.id === ws.hiloSeatId) || room.seats.find((s) => s.ws === ws) || null;
    if (!seat) return null;
    return { room, seat };
  }

  /** How many numbers this seat has not ruled out yet. */
  function left(seat) {
    return Math.max(1, seat.hi - seat.lo - 1);
  }

  function viewFor(room, seat) {
    const opponent = room.seats.find((s) => s.id !== seat.id) || null;
    const racing = room.phase === "playing";
    const over = room.phase === "finished";
    const t = now();
    // On Hard the player keeps the range in their head, so only the last answer travels.
    const mine = racing && room.difficulty === "hard" ? seat.guesses.slice(-1) : seat.guesses;
    return {
      type: "hiloState",
      code: room.code,
      difficulty: room.difficulty,
      phase: room.phase,
      host: room.hostId === seat.id,
      min: MIN_NUMBER,
      max: MAX_NUMBER,
      yourSecret: seat.secret == null ? null : seat.secret,
      opponentSecret: over && opponent && opponent.secret != null ? opponent.secret : null,
      players: room.seats.map((s) => ({
        id: s.id,
        name: s.id === seat.id ? "You" : s.name,
        avatar: s.avatar || "",
        connected: isOnline(s),
        locked: s.secret != null,
        you: s.id === seat.id,
      })),
      startsIn: racing ? Math.max(0, room.startsAt - t) : null,
      elapsed: racing ? Math.max(0, t - room.startsAt) : over ? Math.max(0, room.endedAt - room.startsAt) : null,
      guesses: mine.map((g) => ({ n: g.n, dir: g.dir })),
      yourCount: seat.guesses.length,
      theirCount: opponent ? opponent.guesses.length : 0,
      theirLeft: opponent && (racing || over) ? left(opponent) : null,
      theirGuesses: over && opponent ? opponent.guesses.map((g) => ({ n: g.n, dir: g.dir })) : [],
      winner: room.winnerId ? (room.winnerId === seat.id ? "you" : "them") : null,
      tournament: !!room.tournament,
      yourWins: seat.wins || 0,
      theirWins: opponent ? opponent.wins || 0 : 0,
      tournamentOver: !!room.tournamentOver,
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
    for (const room of rooms.values()) {
      if (room.phase !== "waiting") continue;
      if (room.seats.length >= 2) continue;
      const host = room.seats.find((s) => s.id === room.hostId) || room.seats[0];
      if (!host) continue;
      list.push({
        code: room.code,
        host: host.name,
        hostAvatar: host.avatar || "",
        difficulty: room.difficulty,
        tournament: !!room.tournament,
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
      deps.send(ws, { type: "hiloLobbies", lobbies });
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
    ws.hiloRoom = null;
    ws.hiloSeatId = null;
  }

  function resetSeat(seat) {
    seat.secret = null;
    seat.guesses = [];
    seat.lo = MIN_NUMBER - 1;
    seat.hi = MAX_NUMBER + 1;
    seat.lastGuessAt = 0;
  }

  function startSecrets(room) {
    room.phase = "secrets";
    room.winnerId = null;
    room.startsAt = 0;
    room.endedAt = 0;
    room.status = "";
    for (const seat of room.seats) resetSeat(seat);
  }

  function beginRace(room) {
    if (room.phase !== "secrets") return;
    if (room.seats.length < 2 || room.seats.some((s) => s.secret == null)) return;
    room.phase = "playing";
    room.startsAt = now() + countdownMs;
    room.endedAt = 0;
    room.status = "";
  }

  function removeSeat(room, seat) {
    clearSeatTimer(seat);
    const sock = seat.ws;
    seat.ws = null;
    if (sock) {
      detachSocket(sock);
      deps.send(sock, { type: "hiloLeft", code: room.code });
    }
    room.seats = room.seats.filter((s) => s.id !== seat.id);
    if (room.seats.length === 0) {
      rooms.delete(room.code);
      notifyBrowsers();
      return;
    }
    if (room.hostId === seat.id) room.hostId = room.seats[0].id;
    if (room.phase !== "waiting") {
      room.phase = "waiting";
      room.winnerId = null;
      room.startsAt = 0;
      room.endedAt = 0;
      room.status = "Opponent left";
      room.tournamentOver = false;
      for (const s of room.seats) {
        resetSeat(s);
        s.wins = 0;
      }
    }
    broadcast(room);
    notifyBrowsers();
  }

  function dropClerk(clerkUserId, exceptCode) {
    if (!clerkUserId) return;
    for (const room of [...rooms.values()]) {
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
      const live = rooms.get(room.code);
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
      deps.send(prev, { type: "hiloLeft", code: room.code, reason: "replaced" });
    }
    clearSeatTimer(seat);
    seat.ws = ws;
    ws.hiloRoom = room.code;
    ws.hiloSeatId = seat.id;
    deps.send(ws, {
      type: "hiloJoined",
      code: room.code,
      playerId: seat.id,
      token: seat.token,
      host: room.hostId === seat.id,
    });
    broadcast(room);
    notifyBrowsers();
  }

  function makeSeat(name, avatar, clerkUserId) {
    const seat = {
      id: deps.makeId(),
      token: deps.makeId(),
      name: deps.sanitizeName(name),
      avatar: deps.sanitizeAvatar(avatar),
      clerkUserId: clerkUserId || null,
      wins: 0,
      ws: null,
      leaveTimer: null,
    };
    resetSeat(seat);
    return seat;
  }

  async function auth(ws, token, required) {
    const result = await deps.identifyClerk(ws, token, { required });
    if (!result) return null;
    return { userId: result.userId || null };
  }

  /** One account sits in one room at a time, across every game on this server. */
  function leaveOtherGames(ws, userId) {
    if (userId && deps.releaseOthers) deps.releaseOthers(userId);
    if (deps.leaveOthers) deps.leaveOthers(ws);
  }

  async function handle(ws, msg) {
    const type = msg && msg.type;
    if (type === "hiloBrowse") {
      browsers.add(ws);
      deps.send(ws, { type: "hiloLobbies", lobbies: publicList() });
      return;
    }
    if (type === "hiloCreate") {
      const signed = await auth(ws, msg.clerkToken, true);
      if (!signed) return;
      const userId = signed.userId;
      leaveOtherGames(ws, userId);
      dropClerk(userId, null);
      dropSocket(ws, true);
      const seat = makeSeat(msg.name, msg.avatar, userId);
      const room = {
        code: uniqueCode(),
        difficulty: parseDifficulty(msg.difficulty),
        hostId: seat.id,
        phase: "waiting",
        seats: [seat],
        winnerId: null,
        startsAt: 0,
        endedAt: 0,
        tournament: parseTournament(msg.tournament),
        tournamentOver: false,
        status: "",
        createdAt: now(),
      };
      rooms.set(room.code, room);
      attach(ws, room, seat);
      return;
    }
    if (type === "hiloJoin" || type === "hiloRejoin") {
      const code = String(msg.code || "")
        .trim()
        .toUpperCase();
      const room = rooms.get(code);
      if (!room) return deps.error(ws, "Room not found");
      const token = type === "hiloRejoin" ? String(msg.token || "") : "";
      const signed = await auth(ws, msg.clerkToken, !token);
      if (!signed) return;
      const userId = signed.userId;
      // The room can close while the sign-in is being checked.
      if (rooms.get(code) !== room) return deps.error(ws, "Room not found");
      leaveOtherGames(ws, userId);
      dropSocket(ws, true);
      if (userId) dropClerk(userId, room.code);
      if (rooms.get(code) !== room) return deps.error(ws, "Room not found");

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
      startSecrets(room);
      attach(ws, room, seat);
      return;
    }
    if (type === "hiloLeave") {
      dropSocket(ws, true);
      return;
    }

    const found = seatOf(ws);
    if (!found) return deps.error(ws, "Join a room first");
    const { room, seat } = found;

    if (type === "hiloDifficulty") {
      if (room.hostId !== seat.id) return deps.error(ws, "Only the host can change difficulty");
      if (room.phase !== "waiting" || room.seats.length > 1) {
        return deps.error(ws, "Difficulty is locked");
      }
      room.difficulty = parseDifficulty(msg.difficulty);
      broadcast(room);
      notifyBrowsers();
      return;
    }
    if (type === "hiloTournament") {
      if (room.hostId !== seat.id) return deps.error(ws, "Only the host can change the match");
      if (room.phase !== "waiting" || room.seats.length > 1) {
        return deps.error(ws, "The match is locked");
      }
      room.tournament = parseTournament(msg.tournament);
      room.tournamentOver = false;
      for (const s of room.seats) s.wins = 0;
      broadcast(room);
      notifyBrowsers();
      return;
    }
    if (type === "hiloSecret") {
      if (room.phase !== "secrets") return deps.error(ws, "Numbers are already set");
      if (msg.clear) {
        seat.secret = null;
        broadcast(room);
        return;
      }
      const n = parseNumber(msg.secret);
      if (n == null) return deps.error(ws, "Pick a number from 1 to 9999");
      seat.secret = n;
      beginRace(room);
      broadcast(room);
      return;
    }
    if (type === "hiloGuess") {
      if (room.phase !== "playing") return deps.error(ws, "Wait for both numbers");
      const t = now();
      if (t < room.startsAt) return deps.error(ws, "Wait for the start");
      if (seat.guesses.length >= MAX_GUESSES) return deps.error(ws, "Too many guesses");
      // A double tap is dropped without a message, so it cannot flash an error mid-race.
      if (t - seat.lastGuessAt < guessGapMs) return;
      const n = parseNumber(msg.guess);
      if (n == null) return deps.error(ws, "Pick a number from 1 to 9999");
      const opponent = room.seats.find((s) => s.id !== seat.id);
      if (!opponent || opponent.secret == null) return deps.error(ws, "Wait for both numbers");
      const dir = compare(opponent.secret, n);
      seat.lastGuessAt = t;
      seat.guesses.push({ n, dir });
      if (dir === "up") seat.lo = Math.max(seat.lo, n);
      else if (dir === "down") seat.hi = Math.min(seat.hi, n);
      else {
        seat.lo = n - 1;
        seat.hi = n + 1;
        room.phase = "finished";
        room.winnerId = seat.id;
        room.endedAt = t;
        room.status = "";
        if (room.tournament && !room.tournamentOver) {
          seat.wins = (seat.wins || 0) + 1;
          if (seat.wins >= TOURNAMENT_GOAL) room.tournamentOver = true;
        }
      }
      broadcast(room);
      return;
    }
    if (type === "hiloAgain") {
      if (room.phase !== "finished") return deps.error(ws, "Finish the round first");
      if (room.tournamentOver) return deps.error(ws, "The tournament is over");
      if (room.seats.length < 2 || room.seats.some((s) => !isOnline(s))) {
        return deps.error(ws, "Wait for your opponent");
      }
      startSecrets(room);
      broadcast(room);
      return;
    }
    deps.error(ws, "Unknown command");
  }

  function sweep(at) {
    const t = at || now();
    let dropped = false;
    for (const [code, room] of [...rooms]) {
      if (t - room.createdAt > ROOM_TTL_MS) {
        for (const seat of room.seats) {
          clearSeatTimer(seat);
          if (seat.ws) {
            const sock = seat.ws;
            detachSocket(sock);
            deps.send(sock, { type: "hiloLeft", code });
          }
        }
        rooms.delete(code);
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
    isHiloMessage,
  };
}

module.exports = {
  createHiloGame,
  compare,
  parseNumber,
  parseDifficulty,
  MIN_NUMBER,
  MAX_NUMBER,
};
