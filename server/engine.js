"use strict";

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];
const HAND_SIZE = 3;
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getRank(card) {
  return card.slice(0, -1);
}

function rankValue(rank) {
  return RANK_ORDER.indexOf(rank);
}

function getEffectiveTop(discard) {
  for (let i = discard.length - 1; i >= 0; i--) {
    if (getRank(discard[i]) !== "7") return discard[i];
  }
  return null;
}

function canPlayRankOnDiscard(rank, discard) {
  const top = getEffectiveTop(discard);
  if (!top) return true;
  if (rank === "7" || rank === "2") return true;
  const topRank = getRank(top);
  if (topRank === "6") return rankValue(rank) <= rankValue("6");
  if (rank === "10") return true;
  return rankValue(rank) >= rankValue(topRank);
}

function canPlayCards(cards, discard) {
  if (cards.length === 0) return false;
  const ranks = cards.map(getRank);
  if (!ranks.every((r) => r === ranks[0])) return false;
  return canPlayRankOnDiscard(ranks[0], discard);
}

function fourOfAKindBurn(discard) {
  if (discard.length < 4) return false;
  const last4 = discard.slice(-4).map(getRank);
  return last4.every((r) => r === last4[0]);
}

function shouldBurnAfterPlay(discard, playedRank) {
  if (playedRank === "10") return true;
  return fourOfAKindBurn(discard);
}

function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const d = rankValue(getRank(a)) - rankValue(getRank(b));
    return d !== 0 ? d : a.localeCompare(b);
  });
}

function activePlayZone(player) {
  if (player.hand.length > 0) return "hand";
  if (player.faceUp.some((c) => c !== null)) return "faceUp";
  if (player.faceDown.some((c) => c !== null)) return "faceDown";
  return null;
}

function playerFinished(player) {
  return (
    player.hand.length === 0 &&
    player.faceUp.every((c) => c === null) &&
    player.faceDown.every((c) => c === null)
  );
}

function unfinishedPlayers(pls) {
  return pls.map((_, i) => i).filter((i) => !playerFinished(pls[i]));
}

function nextAlive(from, pls) {
  const n = pls.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (!playerFinished(pls[idx])) return idx;
  }
  return from;
}

function refillHand(hand, deck) {
  const h = [...hand];
  const d = [...deck];
  const drawn = [];
  while (h.length < HAND_SIZE && d.length > 0) {
    const card = d.shift();
    drawn.push(card);
    h.push(card);
  }
  return { hand: sortHand(h), deck: d, drawn };
}

function removeIndices(arr, indices) {
  const set = new Set(indices);
  const kept = [];
  const removed = [];
  arr.forEach((c, i) => (set.has(i) ? removed.push(c) : kept.push(c)));
  return { kept, removed };
}

function canCombineHandWithFaceUp(player, deckLen, handIndices) {
  if (deckLen > 0) return false;
  if (player.hand.length === 0) return false;
  if (handIndices.length !== player.hand.length) return false;
  if (handIndices.length === 0) return false;
  const ranks = handIndices.map((i) => getRank(player.hand[i]));
  return ranks.every((r) => r === ranks[0]);
}

function clonePlayers(pls) {
  return pls.map((p) => ({
    ...p,
    hand: [...p.hand],
    faceUp: [...p.faceUp],
    faceDown: [...p.faceDown],
  }));
}

function dealPlayers(names) {
  const deck = shuffle(buildDeck());
  let cursor = 0;
  const players = names.map((name) => ({
    name,
    faceDown: [],
    faceUp: [],
    hand: [],
    ready: false,
  }));
  const n = players.length;
  for (let slot = 0; slot < 3; slot++)
    for (let p = 0; p < n; p++) players[p].faceDown.push(deck[cursor++]);
  for (let slot = 0; slot < 3; slot++)
    for (let p = 0; p < n; p++) players[p].faceUp.push(deck[cursor++]);
  for (let slot = 0; slot < 3; slot++)
    for (let p = 0; p < n; p++) players[p].hand.push(deck[cursor++]);
  for (const p of players) p.hand = sortHand(p.hand);
  return { players, deck: deck.slice(cursor) };
}

function swapPlayerCards(player, handIdx, faceUpIdx) {
  const hand = [...player.hand];
  const faceUp = [...player.faceUp];
  const up = faceUp[faceUpIdx];
  if (up === null || handIdx < 0 || handIdx >= hand.length) return player;
  const tmp = hand[handIdx];
  hand[handIdx] = up;
  faceUp[faceUpIdx] = tmp;
  return { ...player, hand: sortHand(hand), faceUp };
}

function failPlay(pls, deck, pile, message) {
  return {
    ok: false,
    players: pls,
    deck,
    discard: pile,
    extraTurn: false,
    won: false,
    message,
    played: [],
    willBurn: false,
    burnCards: [],
    pickup: null,
    privateReveal: null,
    drawn: [],
  };
}

function applyPlay(playerIndex, play, pls, deck, pile) {
  const playersNext = clonePlayers(pls);
  let deckNext = [...deck];
  let discardNext = [...pile];
  const pl = playersNext[playerIndex];
  let played = [];
  let message = "";

  if (play.faceDown !== undefined) {
    const idx = play.faceDown;
    const card = pl.faceDown[idx];
    if (card === null || pl.faceUp[idx] !== null) {
      return failPlay(pls, deck, pile, "Эта карта ещё закрыта открытой сверху");
    }
    const faceDown = [...pl.faceDown];
    faceDown[idx] = null;
    pl.faceDown = faceDown;
    if (!canPlayCards([card], discardNext)) {
      const label = `${getRank(card)}${card.slice(-1)}`;
      const taken = [...discardNext, card];
      message = `${pl.name} открыл ${label} — нельзя, забирает сброс`;
      playersNext[playerIndex] = pl;
      return {
        ok: true,
        players: playersNext,
        deck: deckNext,
        discard: pile,
        extraTurn: false,
        won: false,
        message,
        played: [],
        willBurn: false,
        burnCards: [],
        pickup: { cards: taken, toPlayer: playerIndex },
        privateReveal: card,
        drawn: [],
      };
    }
    played = [card];
  } else {
    const handIdx = play.hand ?? [];
    const faceIdx = play.faceUp ?? [];
    if (handIdx.length === 0 && faceIdx.length === 0) {
      return failPlay(pls, deck, pile, "Так ходить нельзя");
    }
    if (pl.hand.length > 0 && handIdx.length === 0) {
      return failPlay(pls, deck, pile, "Сначала выбери карты из руки");
    }
    if (faceIdx.length > 0 && pl.hand.length > 0) {
      if (!canCombineHandWithFaceUp(pl, deckNext.length, handIdx)) {
        return failPlay(pls, deck, pile, "Комбо с открытыми — только последними картами руки, когда колода пуста");
      }
    }
    const removed = [];
    if (handIdx.length > 0) {
      const { kept, removed: rh } = removeIndices(pl.hand, handIdx);
      removed.push(...rh);
      pl.hand = kept;
    }
    if (faceIdx.length > 0) {
      const faceUp = [...pl.faceUp];
      for (const i of faceIdx) {
        const c = faceUp[i];
        if (c === null) continue;
        removed.push(c);
        faceUp[i] = null;
      }
      pl.faceUp = faceUp;
    }
    if (!canPlayCards(removed, discardNext)) {
      return failPlay(pls, deck, pile, "Так ходить нельзя");
    }
    played = removed;
  }

  const rank = getRank(played[0]);
  discardNext = [...discardNext, ...played];
  message = `${pl.name}: ${played.map((c) => getRank(c) + c.slice(-1)).join(", ")}`;
  if (rank === "7") {
    const under = getEffectiveTop(discardNext);
    message += under ? ` · под 7: ${getRank(under)}${under.slice(-1)}` : " · под 7 пусто";
  }

  let extraTurn = false;
  let willBurn = false;
  let burnCards = [];
  if (shouldBurnAfterPlay(discardNext, rank)) {
    willBurn = true;
    burnCards = [...discardNext];
    extraTurn = true;
    message += " — сброс в отбой!";
  }

  let drawn = [];
  if (deckNext.length > 0) {
    const refilled = refillHand(pl.hand, deckNext);
    drawn = refilled.drawn;
    deckNext = refilled.deck;
    pl.hand = refilled.hand;
  } else {
    pl.hand = sortHand(pl.hand);
  }

  playersNext[playerIndex] = pl;
  const won = playerFinished(pl);
  if (won) message = `${pl.name} выходит!`;

  return {
    ok: true,
    players: playersNext,
    deck: deckNext,
    discard: willBurn ? [] : discardNext,
    extraTurn,
    won,
    message,
    played,
    willBurn,
    burnCards,
    pickup: null,
    privateReveal: null,
    drawn,
  };
}

function applyPickUp(playerIndex, pls, pile, tableTake) {
  if (pile.length === 0) {
    return { ok: false, players: pls, discard: pile, message: "Сброс пуст", pickupCards: [] };
  }
  const playersNext = clonePlayers(pls);
  const pl = playersNext[playerIndex];
  const extras = [];

  if (tableTake) {
    if (pl.hand.length > 0) {
      return {
        ok: false,
        players: pls,
        discard: pile,
        message: "Карту со стола можно взять только с пустой рукой",
        pickupCards: [],
      };
    }
    if (tableTake.zone === "faceUp") {
      const card = pl.faceUp[tableTake.index];
      if (card === null) {
        return { ok: false, players: pls, discard: pile, message: "Нет такой открытой карты", pickupCards: [] };
      }
      const rank = getRank(card);
      const faceUp = [...pl.faceUp];
      for (let i = 0; i < faceUp.length; i++) {
        const c = faceUp[i];
        if (c !== null && getRank(c) === rank) {
          extras.push(c);
          faceUp[i] = null;
        }
      }
      pl.faceUp = faceUp;
    } else {
      const card = pl.faceDown[tableTake.index];
      if (card === null || pl.faceUp[tableTake.index] !== null) {
        return { ok: false, players: pls, discard: pile, message: "Нет такой закрытой карты", pickupCards: [] };
      }
      const faceDown = [...pl.faceDown];
      faceDown[tableTake.index] = null;
      pl.faceDown = faceDown;
      extras.push(card);
    }
  }

  const pickupCards = [...pile, ...extras];
  pl.hand = sortHand([...pl.hand, ...pickupCards]);
  playersNext[playerIndex] = pl;
  const tableNote =
    extras.length > 0
      ? tableTake.zone === "faceDown"
        ? " + 1 закрытая со стола"
        : extras.length === 1
          ? ` + ${getRank(extras[0])}${extras[0].slice(-1)} со стола`
          : ` + ${extras.length}×${getRank(extras[0])} со стола`
      : "";
  return {
    ok: true,
    players: playersNext,
    discard: [],
    message: `${pls[playerIndex].name} забирает сброс (${pile.length})${tableNote}`,
    pickupCards,
  };
}

module.exports = {
  HAND_SIZE,
  dealPlayers,
  swapPlayerCards,
  applyPlay,
  applyPickUp,
  playerFinished,
  unfinishedPlayers,
  nextAlive,
  activePlayZone,
  canPlayCards,
  canCombineHandWithFaceUp,
  sortHand,
};
