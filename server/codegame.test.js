"use strict";

const { createCodeGame, feedback, parseDigits } = require("./codegame");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function easy(secret, guess) {
  return feedback("easy", secret, guess);
}

function hard(secret, guess) {
  return feedback("hard", secret, guess);
}

assert(parseDigits("0123") === "0123", "keeps leading zero");
assert(parseDigits("123") === null, "rejects short");
assert(parseDigits("12345") === null, "rejects long");
assert(parseDigits("12a4") === null, "rejects letters");

{
  const hint = easy("1123", "1111");
  assert(hint.kind === "easy", "easy kind");
  assert(hint.places.join(",") === "true,true,false,false", "in-place pair");
  assert(hint.extras.join(",") === "", "no extra 1s beyond the placed ones");
}

{
  const hint = easy("1123", "1211");
  assert(hint.places.join(",") === "true,false,false,false", "only first is placed");
  assert(hint.extras.join(",") === "2,1", "misplaced digits keep guess order");
}

{
  const hint = easy("1231", "1111");
  assert(hint.places.join(",") === "true,false,false,true", "both placed 1s");
  assert(hint.extras.join(",") === "", "repeats do not invent extra matches");
}

{
  const hint = easy("9876", "1234");
  assert(hint.places.every((p) => p === false), "no places");
  assert(hint.extras.length === 0, "no extras");
}

{
  const hint = hard("1234", "1243");
  assert(hint.kind === "hard" && hint.hit === true, "hard hit");
  assert(!("places" in hint) && !("extras" in hint), "hard hides which and where");
}

{
  const hint = hard("1234", "5678");
  assert(hint.hit === false, "hard miss");
}

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
  const states = ws.sent.filter((m) => m.type === "codeState");
  return states[states.length - 1];
}

const game = createCodeGame({
  rng: () => 0,
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
  cardCodeTaken() {
    return false;
  },
  leaveCard() {},
  releaseCardClerk() {},
});

async function play() {
  const host = fakeWs();
  const guest = fakeWs();
  await game.handle(host, { type: "codeCreate", name: "Lime", clerkToken: "user-a", difficulty: "easy" });
  const created = host.sent.find((m) => m.type === "codeJoined");
  assert(created && created.code, "host joined");
  const browser = fakeWs();
  await game.handle(browser, { type: "codeBrowse" });
  const listed = browser.sent.find((m) => m.type === "codeLobbies");
  assert(listed.lobbies.length === 1 && listed.lobbies[0].difficulty === "easy", "waiting room is listed");

  await game.handle(host, { type: "codeDifficulty", difficulty: "hard" });
  assert(lastState(host).difficulty === "hard", "host can switch before the opponent sits");

  await game.handle(guest, { type: "codeJoin", code: created.code, name: "Yuzu", clerkToken: "user-b" });
  assert(lastState(host).phase === "secrets", "two players move to secrets");
  assert(browser.sent[browser.sent.length - 1].lobbies.length === 0, "full room leaves the list");

  await game.handle(guest, { type: "codeDifficulty", difficulty: "easy" });
  assert(guest.sent.some((m) => m.type === "error"), "guest cannot change difficulty");

  await game.handle(host, { type: "codeSecret", secret: "1123" });
  assert(lastState(host).yourSecret === "1123", "host sees own secret");
  assert(lastState(guest).opponentSecret == null, "guest does not see it");
  assert(!JSON.stringify(lastState(guest)).includes("1123"), "secret is absent from the other view");

  await game.handle(host, { type: "codeSecret", clear: true });
  assert(lastState(host).yourSecret == null, "host can unlock");
  await game.handle(host, { type: "codeSecret", secret: "1123" });
  await game.handle(guest, { type: "codeSecret", secret: "9999" });
  const playing = lastState(host);
  assert(playing.phase === "playing", "both secrets start the round");
  assert(playing.yourTurn === true, "rng 0 gives the first seat the first guess");
  assert(lastState(guest).yourTurn === false, "second seat waits");
  assert(playing.opponentSecret == null, "still hidden");

  await game.handle(guest, { type: "codeGuess", guess: "1111" });
  assert(guest.sent[guest.sent.length - 1].type === "error", "guest waits");

  await game.handle(host, { type: "codeGuess", guess: "1999" });
  const after = lastState(host);
  assert(after.yourTurn === false, "turn passes");
  const mine = after.guesses.find((g) => g.byYou);
  assert(mine.feedback.kind === "hard" && mine.feedback.hit === true, "hard hint is only a hit");
  assert(!JSON.stringify(mine).includes("9999") || mine.guess === "1999", "guess is the typed code");
  assert(!JSON.stringify(after).includes('"9999"'), "opponent secret still hidden");

  await game.handle(guest, { type: "codeGuess", guess: "1123" });
  const won = lastState(guest);
  assert(won.phase === "finished" && won.winner === "you", "guesser wins");
  assert(won.opponentSecret === "1123", "secret revealed at the end");
  assert(lastState(host).winner === "them" && lastState(host).opponentSecret === "9999", "host sees the winning code");

  await game.handle(host, { type: "codeAgain" });
  const again = lastState(host);
  assert(again.phase === "secrets" && again.yourSecret == null, "rematch clears codes");
  await game.handle(host, { type: "codeSecret", secret: "0000" });
  await game.handle(guest, { type: "codeSecret", secret: "1111" });
  assert(lastState(host).yourTurn === true, "loser guesses first on the next round");
  assert(lastState(guest).yourTurn === false, "winner waits");

  const token = created.token;
  host.readyState = 0;
  host.codeRoom = created.code;
  game.dropSocket(host, false);
  assert(lastState(guest).players.some((p) => p.you === false && p.connected === false), "opponent sees a disconnect");
  const returned = fakeWs();
  await game.handle(returned, {
    type: "codeRejoin",
    code: created.code,
    token,
    name: "Lime",
    clerkToken: "user-a",
  });
  const back = lastState(returned);
  assert(back.yourSecret === "0000", "rejoin restores your secret");
  assert(back.opponentSecret == null, "rejoin does not reveal the other secret");
  assert(lastState(guest).players.every((p) => p.connected), "opponent sees the reconnect");

  console.log("codegame tests ok");
}

play().catch((err) => {
  console.error(err);
  process.exit(1);
});
