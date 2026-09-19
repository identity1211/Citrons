"use strict";

const assert = require("assert");
const { rotateElimination } = require("./elimination");

function seat(id, name) {
  return {
    id,
    token: `t-${id}`,
    name,
    avatar: "",
    clerkUserId: `c-${id}`,
    ws: null,
    connected: false,
    ready: false,
    hand: ["A♠"],
    faceUp: [],
    faceDown: [],
    leaveTimer: null,
  };
}

function spectator(id, name, queued) {
  return {
    id,
    name,
    avatar: "",
    clerkUserId: `c-${id}`,
    ws: null,
    connected: false,
    lastChatAt: 0,
    lastReactAt: 0,
    queued: !!queued,
  };
}

function testRotatesLastWithQueueHead() {
  const room = {
    mode: "elimination",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B"), seat("c", "C")],
    finishOrder: [1, 0, 2], // C last
    spectators: [spectator("q1", "Q1", true), spectator("w1", "W1", false)],
    queue: ["q1"],
  };
  const result = rotateElimination(room, { makeToken: () => "new-token" });
  assert.ok(result);
  assert.strictEqual(result.promotedId, "q1");
  assert.strictEqual(result.demotedId, "c");
  assert.strictEqual(room.seats[2].id, "q1");
  assert.strictEqual(room.seats[2].token, "new-token");
  assert.strictEqual(room.seats[2].hand.length, 0);
  assert.ok(room.spectators.some((s) => s.id === "c" && s.queued));
  assert.ok(room.spectators.some((s) => s.id === "w1" && !s.queued));
  assert.deepStrictEqual(room.queue, ["c"]);
  assert.strictEqual(room.hostId, "a");
}

function testHostTransferWhenLoserWasHost() {
  const room = {
    mode: "elimination",
    hostId: "c",
    seats: [seat("a", "A"), seat("b", "B"), seat("c", "C")],
    finishOrder: [0, 1, 2],
    spectators: [spectator("q1", "Q1", true)],
    queue: ["q1"],
  };
  rotateElimination(room, { makeToken: () => "tok" });
  assert.notStrictEqual(room.hostId, "c");
  assert.ok(room.seats.some((p) => p.id === room.hostId));
}

function testNoopWithoutQueue() {
  const room = {
    mode: "elimination",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B")],
    finishOrder: [0, 1],
    spectators: [spectator("w1", "W1", false)],
    queue: [],
  };
  assert.strictEqual(rotateElimination(room), null);
  assert.strictEqual(room.seats[1].id, "b");
}

function testClassicIgnored() {
  const room = {
    mode: "classic",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B")],
    finishOrder: [0, 1],
    spectators: [spectator("q1", "Q1", true)],
    queue: ["q1"],
  };
  assert.strictEqual(rotateElimination(room), null);
}

testRotatesLastWithQueueHead();
testHostTransferWhenLoserWasHost();
testNoopWithoutQueue();
testClassicIgnored();
console.log("elimination tests ok");
