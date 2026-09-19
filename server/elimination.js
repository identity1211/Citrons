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
  };
}

function spectatorFromPlayer(p, queued) {
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

/**
 * After a finished elimination match: last place leaves the table,
 * first queued spectator takes that seat; loser goes to the end of the queue.
 * Mutates room.seats / spectators / queue / hostId.
 * @returns {{ promotedId: string, demotedId: string } | null}
 */
function rotateElimination(room, opts) {
  if (!isElimination(room)) return null;
  const order = Array.isArray(room.finishOrder) ? room.finishOrder : [];
  if (order.length < 2) return null;
  const loserIdx = order[order.length - 1];
  if (loserIdx < 0 || loserIdx >= room.seats.length) return null;
  const loser = room.seats[loserIdx];
  if (!loser) return null;

  const spectators = roomSpectatorsList(room);
  const queue = roomQueue(room);
  const makeToken =
    (opts && typeof opts.makeToken === "function" && opts.makeToken) ||
    (() => crypto.randomBytes(8).toString("hex"));

  let promoted = null;
  while (queue.length && !promoted) {
    const nextId = queue.shift();
    const idx = spectators.findIndex((s) => s && s.id === nextId && s.queued);
    if (idx < 0) continue;
    promoted = spectators[idx];
    spectators.splice(idx, 1);
  }
  if (!promoted) return null;

  const newPlayer = playerFromSpectator(promoted, makeToken());
  room.seats[loserIdx] = newPlayer;

  const demoted = spectatorFromPlayer(loser, true);
  spectators.push(demoted);
  queue.push(demoted.id);

  if (room.hostId === loser.id) {
    const other = room.seats.find((p) => p && p.id !== newPlayer.id) || room.seats[0];
    room.hostId = other ? other.id : newPlayer.id;
  }

  return { promotedId: newPlayer.id, demotedId: demoted.id };
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
  rotateElimination,
  removeFromQueue,
  queueView,
};
