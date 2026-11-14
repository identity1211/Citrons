"use strict";

const { createHiloGame, compare, parseNumber } = require("./hilo");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

assert(parseNumber("1") === 1, "one digit");
assert(parseNumber("9999") === 9999, "top of the range");
assert(parseNumber(42) === 42, "a number is fine");
assert(parseNumber("0") === null, "zero is out of range");
assert(parseNumber("0123") === null, "no leading zero");
assert(parseNumber("10000") === null, "five digits are too many");
assert(parseNumber("12a") === null, "letters are rejected");
assert(parseNumber("-5") === null, "no sign");
assert(parseNumber("") === null && parseNumber(null) === null, "empty is rejected");

assert(compare(500, 100) === "up", "secret above the guess");
assert(compare(500, 900) === "down", "secret below the guess");
assert(compare(500, 500) === "hit", "exact");

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
  };
}

function lastState(ws) {
  const states = ws.sent.filter((m) => m.type === "hiloState");
  return states[states.length - 1];
}

function lastMsg(ws) {
  return ws.sent[ws.sent.length - 1];
}

function makeGame(clock, extra) {
  const released = [];
  const game = createHiloGame({
    now: () => clock.t,
    countdownMs: 3000,
    guessGapMs: 250,
    send(ws, msg) {
      ws.send(JSON.stringify(msg));
    },
    error(ws, message) {
      ws.send(JSON.stringify({ type: "error", message }));
    },
    identifyClerk(_ws, token) {
      if (!token) return null;
      return { userId: String(token) };
    },
    sanitizeName(name) {
      return String(name || "Player").slice(0, 18);
    },
    sanitizeAvatar() {
      return "";
    },
    makeId() {
      return "id" + Math.random().toString(16).slice(2);
    },
    codeTaken() {
      return false;
    },
    leaveOthers() {},
    releaseOthers(userId) {
      released.push(userId);
    },
    ...extra,
  });
  return { game, released };
}

async function seated(game, options) {
  const host = fakeWs();
  const guest = fakeWs();
  await game.handle(host, { type: "hiloCreate", name: "Lime", clerkToken: "user-a", ...options });
  const created = host.sent.find((m) => m.type === "hiloJoined");
  await game.handle(guest, { type: "hiloJoin", code: created.code, name: "Yuzu", clerkToken: "user-b" });
  return { host, guest, created };
}

async function race() {
  const clock = { t: 1000000 };
  const { game, released } = makeGame(clock);
  const host = fakeWs();
  const guest = fakeWs();

  await game.handle(host, { type: "hiloCreate", name: "Lime", clerkToken: "user-a", difficulty: "easy" });
  const created = host.sent.find((m) => m.type === "hiloJoined");
  assert(created && created.code, "host joined");
  assert(released.includes("user-a"), "creating a room frees the account from other games");

  const browser = fakeWs();
  await game.handle(browser, { type: "hiloBrowse" });
  assert(lastMsg(browser).type === "hiloLobbies" && lastMsg(browser).lobbies.length === 1, "waiting room is listed");

  await game.handle(host, { type: "hiloDifficulty", difficulty: "hard" });
  assert(lastState(host).difficulty === "hard", "host can switch before the opponent sits");
  await game.handle(host, { type: "hiloDifficulty", difficulty: "easy" });

  await game.handle(guest, { type: "hiloJoin", code: created.code, name: "Yuzu", clerkToken: "user-b" });
  assert(lastState(host).phase === "secrets", "two players move to secrets");
  assert(lastMsg(browser).lobbies.length === 0, "full room leaves the list");

  await game.handle(guest, { type: "hiloDifficulty", difficulty: "hard" });
  assert(lastMsg(guest).type === "error", "guest cannot change difficulty");

  const stranger = fakeWs();
  await game.handle(stranger, { type: "hiloJoin", code: created.code, name: "Kumquat", clerkToken: "user-c" });
  assert(lastMsg(stranger).type === "error", "a third player is turned away");

  await game.handle(host, { type: "hiloSecret", secret: "0" });
  assert(lastMsg(host).type === "error", "zero is not a number to hide");
  await game.handle(host, { type: "hiloSecret", secret: "6183" });
  assert(lastState(host).yourSecret === 6183, "host sees own number");
  assert(!JSON.stringify(lastState(guest)).includes("6183"), "the number is absent from the other view");
  assert(lastState(guest).players.find((p) => !p.you).locked === true, "the other player sees it is locked");

  await game.handle(host, { type: "hiloSecret", clear: true });
  assert(lastState(host).yourSecret == null, "host can change it before the start");
  await game.handle(host, { type: "hiloGuess", guess: "5000" });
  assert(lastMsg(host).type === "error", "no guessing before both numbers are set");

  await game.handle(host, { type: "hiloSecret", secret: "6183" });
  await game.handle(guest, { type: "hiloSecret", secret: "42" });
  const begun = lastState(host);
  assert(begun.phase === "playing" && begun.startsIn === 3000 && begun.elapsed === 0, "both numbers start the countdown");
  assert(begun.theirLeft === 9999 && begun.theirCount === 0, "the opponent starts with the whole range");

  await game.handle(host, { type: "hiloGuess", guess: "5000" });
  assert(lastMsg(host).type === "error" && lastMsg(host).message === "Wait for the start", "the countdown holds guesses back");
  await game.handle(host, { type: "hiloSecret", secret: "7" });
  assert(lastMsg(host).type === "error", "the number is locked once the race is on");

  clock.t += 3000;
  // Both players guess at will: nobody waits for a turn.
  await game.handle(host, { type: "hiloGuess", guess: "5000" });
  let mine = lastState(host);
  assert(mine.guesses.length === 1 && mine.guesses[0].n === 5000 && mine.guesses[0].dir === "down", "42 is lower than 5000");
  assert(mine.startsIn === 0, "the race is on");
  let theirs = lastState(guest);
  assert(theirs.theirCount === 1 && theirs.theirLeft === 4999, "the opponent sees the range close, not the guess");
  assert(!JSON.stringify(theirs).includes("5000"), "the guess itself stays private");

  await game.handle(host, { type: "hiloGuess", guess: "2500" });
  assert(lastState(host).guesses.length === 1, "a double tap inside the gap is dropped");
  assert(lastMsg(host).type === "hiloState", "and it does not raise an error");

  clock.t += 400;
  await game.handle(guest, { type: "hiloGuess", guess: "5000" });
  assert(lastState(guest).guesses[0].dir === "up", "6183 is higher than 5000");
  clock.t += 400;
  await game.handle(guest, { type: "hiloGuess", guess: "nope" });
  assert(lastMsg(guest).type === "error", "junk is rejected");

  clock.t += 400;
  await game.handle(host, { type: "hiloGuess", guess: "20" });
  mine = lastState(host);
  assert(mine.guesses[1].dir === "up" && mine.yourCount === 2, "42 is higher than 20");
  assert(lastState(guest).theirLeft === 4979, "bounds 20 and 5000 leave 4979 numbers");

  clock.t += 400;
  await game.handle(host, { type: "hiloGuess", guess: "9000" });
  assert(lastState(guest).theirLeft === 4979, "a guess outside the known range rules nothing out");

  // Drop and return mid-race.
  const token = created.token;
  host.readyState = 0;
  game.dropSocket(host, false);
  assert(lastState(guest).players.some((p) => !p.you && !p.connected), "opponent sees the disconnect");
  clock.t += 1000;
  const returned = fakeWs();
  await game.handle(returned, { type: "hiloRejoin", code: created.code, token, name: "Lime", clerkToken: "user-a" });
  const back = lastState(returned);
  assert(back.phase === "playing" && back.yourSecret === 6183 && back.guesses.length === 3, "rejoin restores the race");
  assert(back.opponentSecret == null, "rejoin does not reveal the other number");
  assert(back.elapsed === 2600, "rejoin carries the race clock");
  assert(lastState(guest).players.every((p) => p.connected), "opponent sees the reconnect");

  clock.t += 400;
  await game.handle(returned, { type: "hiloGuess", guess: "42" });
  const won = lastState(returned);
  assert(won.phase === "finished" && won.winner === "you", "the first exact guess wins");
  assert(won.opponentSecret === 42 && won.elapsed === 3000, "the number and the time are shown");
  assert(won.theirGuesses.length === 1 && won.theirGuesses[0].n === 5000, "the other history opens at the end");
  const lost = lastState(guest);
  assert(lost.winner === "them" && lost.opponentSecret === 6183, "the loser sees the number too");
  assert(lost.theirGuesses.length === 4 && lost.theirLeft === 1, "and the winning line");

  await game.handle(guest, { type: "hiloGuess", guess: "6183" });
  assert(lastMsg(guest).type === "error", "no guesses after the finish");

  await game.handle(guest, { type: "hiloAgain" });
  const again = lastState(guest);
  assert(again.phase === "secrets" && again.yourSecret == null && again.guesses.length === 0, "rematch clears the round");

  // Leaving mid-game sends the other player back to waiting.
  await game.handle(returned, { type: "hiloSecret", secret: "10" });
  await game.handle(guest, { type: "hiloSecret", secret: "20" });
  await game.handle(guest, { type: "hiloLeave" });
  const alone = lastState(returned);
  assert(alone.phase === "waiting" && alone.players.length === 1 && alone.status === "Opponent left", "the room reopens");
  assert(alone.yourSecret == null, "the old number is gone");
  assert(lastMsg(guest).type === "hiloLeft", "the leaver is told");
  await game.handle(returned, { type: "hiloLeave" });
  assert(game.count() === 0, "an empty room is removed");

  console.log("hilo race tests ok");
}

async function hard() {
  const clock = { t: 5000 };
  const { game } = makeGame(clock);
  const { host, guest } = await seated(game, { difficulty: "hard" });
  await game.handle(host, { type: "hiloSecret", secret: "100" });
  await game.handle(guest, { type: "hiloSecret", secret: "8000" });
  clock.t += 3000;
  for (const guess of ["5000", "7000", "9000"]) {
    await game.handle(host, { type: "hiloGuess", guess });
    clock.t += 300;
  }
  const mid = lastState(host);
  assert(mid.guesses.length === 1 && mid.guesses[0].n === 9000 && mid.guesses[0].dir === "down", "hard keeps only the last answer");
  assert(mid.yourCount === 3, "the count is still whole");
  assert(lastState(guest).theirLeft === 1999, "the opponent still sees the range close");
  await game.handle(host, { type: "hiloGuess", guess: "8000" });
  assert(lastState(host).guesses.length === 4, "the full history opens after the finish");
  console.log("hilo hard tests ok");
}

async function tournament() {
  const clock = { t: 5000 };
  const { game } = makeGame(clock);
  const { host, guest } = await seated(game, { tournament: true });
  assert(lastState(host).tournament === true && lastState(host).yourWins === 0, "tournament starts at zero");
  for (let round = 1; round <= 3; round++) {
    await game.handle(host, { type: "hiloSecret", secret: "1111" });
    await game.handle(guest, { type: "hiloSecret", secret: "2222" });
    clock.t += 3000;
    await game.handle(guest, { type: "hiloGuess", guess: "1111" });
    const done = lastState(guest);
    assert(done.phase === "finished" && done.winner === "you" && done.yourWins === round, "score follows the rounds");
    assert(done.tournamentOver === (round === 3), "three wins close it");
    if (round < 3) {
      await game.handle(host, { type: "hiloAgain" });
      assert(lastState(host).phase === "secrets" && lastState(host).theirWins === round, "the next round keeps the score");
    }
    clock.t += 1000;
  }
  await game.handle(host, { type: "hiloAgain" });
  assert(lastMsg(host).type === "error", "no round after three wins");
  console.log("hilo tournament tests ok");
}

async function oneRoomPerAccount() {
  const clock = { t: 5000 };
  const { game } = makeGame(clock);
  const first = fakeWs();
  await game.handle(first, { type: "hiloCreate", name: "Lime", clerkToken: "user-a" });
  const second = fakeWs();
  await game.handle(second, { type: "hiloCreate", name: "Lime", clerkToken: "user-a" });
  assert(game.count() === 1, "a second room replaces the first for one account");
  assert(first.sent.some((m) => m.type === "hiloLeft"), "the old tab is told");

  const unsigned = fakeWs();
  await game.handle(unsigned, { type: "hiloCreate", name: "Anon" });
  assert(game.count() === 1 && !unsigned.sent.some((m) => m.type === "hiloJoined"), "no room without a sign-in");

  game.sweep(clock.t + 4 * 60 * 60 * 1000);
  assert(game.count() === 0, "old rooms are swept");
  assert(lastMsg(second).type === "hiloLeft", "and the player is told");
  console.log("hilo account tests ok");
}

race()
  .then(hard)
  .then(tournament)
  .then(oneRoomPerAccount)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
