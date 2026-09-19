"use strict";

const assert = require("assert");
const { rotateElimination, fillOpenSeatFromQueue } = require("./elimination");

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

function fullSeats() {
  return [seat("a", "A"), seat("b", "B"), seat("c", "C"), seat("d", "D"), seat("e", "E")];
}

function testRotatesLastWithQueueHead() {
  const room = {
    mode: "elimination",
    hostId: "a",
    seats: fullSeats(),
    finishOrder: [1, 0, 3, 2, 4], // E last
    spectators: [spectator("q1", "Q1", true), spectator("w1", "W1", false)],
    queue: ["q1"],
  };
  const result = rotateElimination(room, { makeToken: () => "new-token", maxPlayers: 5 });
  assert.ok(result);
  assert.strictEqual(result.promotedId, "q1");
  assert.strictEqual(result.demotedId, "e");
  assert.strictEqual(room.seats[4].id, "q1");
  assert.strictEqual(room.seats[4].token, "new-token");
  assert.strictEqual(room.seats[4].hand.length, 0);
  assert.ok(room.spectators.some((s) => s.id === "e" && s.queued));
  assert.ok(room.spectators.some((s) => s.id === "w1" && !s.queued));
  assert.deepStrictEqual(room.queue, ["e"]);
  assert.strictEqual(room.hostId, "a");
  assert.strictEqual(room.seats.length, 5);
}

function testHostTransferWhenLoserWasHost() {
  const room = {
    mode: "elimination",
    hostId: "e",
    seats: fullSeats(),
    finishOrder: [0, 1, 2, 3, 4],
    spectators: [spectator("q1", "Q1", true)],
    queue: ["q1"],
  };
  rotateElimination(room, { makeToken: () => "tok", maxPlayers: 5 });
  assert.notStrictEqual(room.hostId, "e");
  assert.ok(room.seats.some((p) => p.id === room.hostId));
}

function testNoSwapOnShortTable() {
  const room = {
    mode: "elimination",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B"), seat("c", "C")],
    finishOrder: [1, 0, 2], // C last
    spectators: [spectator("q1", "Q1", true), spectator("q2", "Q2", true)],
    queue: ["q1", "q2"],
  };
  assert.strictEqual(rotateElimination(room, { maxPlayers: 5 }), null);
  assert.strictEqual(room.seats[2].id, "c");
  assert.strictEqual(room.seats.length, 3);
  assert.deepStrictEqual(room.queue, ["q1", "q2"]);
}

function testNoopWithoutQueue() {
  const room = {
    mode: "elimination",
    hostId: "a",
    seats: fullSeats(),
    finishOrder: [0, 1, 2, 3, 4],
    spectators: [spectator("w1", "W1", false)],
    queue: [],
  };
  assert.strictEqual(rotateElimination(room, { maxPlayers: 5 }), null);
  assert.strictEqual(room.seats[4].id, "e");
}

function testClassicIgnored() {
  const room = {
    mode: "classic",
    hostId: "a",
    seats: fullSeats(),
    finishOrder: [0, 1, 2, 3, 4],
    spectators: [spectator("q1", "Q1", true)],
    queue: ["q1"],
  };
  assert.strictEqual(rotateElimination(room, { maxPlayers: 5 }), null);
}

function testFillOpenSeatFromQueue() {
  const room = {
    mode: "elimination",
    phase: "waiting",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B")],
    spectators: [spectator("q1", "Q1", true), spectator("w1", "W1", false)],
    queue: ["q1"],
  };
  const result = fillOpenSeatFromQueue(room, { makeToken: () => "seat-tok", maxPlayers: 5 });
  assert.ok(result);
  assert.strictEqual(result.promotedId, "q1");
  assert.strictEqual(room.seats.length, 3);
  assert.strictEqual(room.seats[2].id, "q1");
  assert.strictEqual(room.seats[2].token, "seat-tok");
  assert.deepStrictEqual(room.queue, []);
  assert.ok(!room.spectators.some((s) => s.id === "q1"));
  assert.ok(room.spectators.some((s) => s.id === "w1"));
}

function testFillSkipsWhenFull() {
  const room = {
    mode: "elimination",
    phase: "waiting",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B"), seat("c", "C")],
    spectators: [spectator("q1", "Q1", true)],
    queue: ["q1"],
  };
  assert.strictEqual(fillOpenSeatFromQueue(room, { maxPlayers: 3 }), null);
  assert.strictEqual(room.seats.length, 3);
  assert.deepStrictEqual(room.queue, ["q1"]);
}

function testShortTableThenFillKeepsLoser() {
  const room = {
    mode: "elimination",
    phase: "waiting",
    hostId: "a",
    seats: [seat("a", "A"), seat("b", "B"), seat("c", "C")],
    finishOrder: [1, 0, 2],
    spectators: [spectator("q1", "Q1", true), spectator("q2", "Q2", true)],
    queue: ["q1", "q2"],
  };
  assert.strictEqual(rotateElimination(room, { maxPlayers: 5 }), null);
  assert.strictEqual(room.seats[2].id, "c");
  while (fillOpenSeatFromQueue(room, { makeToken: () => "t", maxPlayers: 5 })) {
    /* fill */
  }
  assert.strictEqual(room.seats.length, 5);
  assert.ok(room.seats.some((p) => p.id === "c"));
  assert.ok(room.seats.some((p) => p.id === "q1"));
  assert.ok(room.seats.some((p) => p.id === "q2"));
  assert.deepStrictEqual(room.queue, []);
}

testRotatesLastWithQueueHead();
testHostTransferWhenLoserWasHost();
testNoSwapOnShortTable();
testNoopWithoutQueue();
testClassicIgnored();
testFillOpenSeatFromQueue();
testFillSkipsWhenFull();
testShortTableThenFillKeepsLoser();
console.log("elimination tests ok");
