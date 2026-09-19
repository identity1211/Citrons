"use strict";

const crypto = require("crypto");

function isElimination(room) {
  return !!(room && room.mode === "elimination");
}

function roomQueue(room) {
  if (!room) return [];
  if (!Array.isArray(room.queue)) room.queue = [];
  return room.queue;
}

function roomSpectatorsList(room) {
  if (!room) return [];
  if (!Array.isArray(room.spectators)) room.spectators = [];
  return room.spectators;
}

function playerFromSpectator(s, token) {
  return {
    id: s.id,
    token: token || crypto.randomBytes(8).toString("hex"),
    name: s.name,
    avatar: s.avatar || "",
    clerkUserId: s.clerkUserId || null,
    ws: s.ws || null,
    connected: !!(s.ws && s.ws.readyState === 1),
    ready: false,
    hand: [],
    faceUp: [],
    faceDown: [],
    leaveTimer: null,
    perfectSwapReady: false,
    wasCardLeader: false,
    joinedFromQueue: false,
    matchChat: false,
    matchReact: false,
  };
}

function spectatorFromPlayer(p, queued) {
  if (p && p.leaveTimer) {
    clearTimeout(p.leaveTimer);
    p.leaveTimer = null;
  }
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar || "",
    clerkUserId: p.clerkUserId || null,
    ws: p.ws || null,
    connected: !!(p.ws && p.ws.readyState === 1),
    lastChatAt: 0,
    lastReactAt: 0,
    queued: !!queued,
  };
}

/** Pull the next valid queued spectator off the FIFO (skips stale ids). */
function pullQueuedSpectator(room) {
  const spectators = roomSpectatorsList(room);
  const queue = roomQueue(room);
  while (queue.length) {
    const nextId = queue.shift();
    const idx = spectators.findIndex((s) => s && s.id === nextId && s.queued);
    if (idx < 0) continue;
    const promoted = spectators[idx];
    spectators.splice(idx, 1);
    return promoted;
  }
  return null;
}

/**
 * After a finished elimination match on a FULL table: last place leaves,
 * first queued spectator takes that seat; loser goes to the end of the queue.
 * No-op if the table is short of maxPlayers — callers should fill open seats instead.
 * Mutates room.seats / spectators / queue / hostId.
 * @returns {{ promotedId: string, demotedId: string } | null}
 */
function rotateElimination(room, opts) {
  if (!isElimination(room)) return null;
  const max = opts && typeof opts.maxPlayers === "number" ? opts.maxPlayers : 5;
  if (!Array.isArray(room.seats) || room.seats.length < max) return null;

  const order = Array.isArray(room.finishOrder) ? room.finishOrder : [];
  if (order.length < 2) return null;
  const loserIdx = order[order.length - 1];
  if (loserIdx < 0 || loserIdx >= room.seats.length) return null;
  const loser = room.seats[loserIdx];
  if (!loser) return null;

  const makeToken =
    (opts && typeof opts.makeToken === "function" && opts.makeToken) ||
    (() => crypto.randomBytes(8).toString("hex"));

  const promoted = pullQueuedSpectator(room);
  if (!promoted) return null;

  const newPlayer = playerFromSpectator(promoted, makeToken());
  room.seats[loserIdx] = newPlayer;

  const demoted = spectatorFromPlayer(loser, true);
  roomSpectatorsList(room).push(demoted);
  roomQueue(room).push(demoted.id);

  if (room.hostId === loser.id) {
    const other = room.seats.find((p) => p && p.id !== newPlayer.id) || room.seats[0];
    room.hostId = other ? other.id : newPlayer.id;
  }

  return { promotedId: newPlayer.id, demotedId: demoted.id };
}

/**
 * Fill one open waiting-room seat from the queue (elimination only).
 * @returns {{ promotedId: string } | null}
 */
function fillOpenSeatFromQueue(room, opts) {
  if (!isElimination(room)) return null;
  if (!room || room.phase !== "waiting") return null;
  const max = opts && typeof opts.maxPlayers === "number" ? opts.maxPlayers : 5;
  if (room.seats.length >= max) return null;

  const makeToken =
    (opts && typeof opts.makeToken === "function" && opts.makeToken) ||
    (() => crypto.randomBytes(8).toString("hex"));

  const promoted = pullQueuedSpectator(room);
  if (!promoted) return null;

  const newPlayer = playerFromSpectator(promoted, makeToken());
  room.seats.push(newPlayer);
  return { promotedId: newPlayer.id, player: newPlayer };
}

function removeFromQueue(room, personId) {
  const queue = roomQueue(room);
  room.queue = queue.filter((id) => id !== personId);
}

function queueView(room) {
  const spectators = roomSpectatorsList(room);
  const byId = new Map(spectators.map((s) => [s.id, s]));
  return roomQueue(room)
    .map((qid) => byId.get(qid))
    .filter((s) => s && s.queued)
    .map((s) => ({
      id: s.id,
      name: s.name,
      avatar: s.avatar || "",
      connected: !!(s.ws && s.ws.readyState === 1),
    }));
}

module.exports = {
  isElimination,
  roomQueue,
  playerFromSpectator,
  spectatorFromPlayer,
  pullQueuedSpectator,
  rotateElimination,
  fillOpenSeatFromQueue,
  removeFromQueue,
  queueView,
};
