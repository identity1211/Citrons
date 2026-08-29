import { useState, useEffect, useLayoutEffect, useRef, useCallback, type CSSProperties, type ReactNode } from "react";
import { useHostTheme, Text, Row, Spacer } from "cursor/canvas";

// ─── Card definitions ───────────────────────────────────────────────────────

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];
const SWAP_SECONDS = 20;
const HAND_SIZE = 3;
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;

function buildDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck;
}

function shuffle(deck: string[]): string[] {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getRank(card: string): string {
  return card.slice(0, -1);
}

function getCardLabel(card: string): { rank: string; suit: string; color: string } {
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  const color = suit === "♥" || suit === "♦" ? "#c0392b" : "#222";
  return { rank, suit, color };
}

function rankValue(rank: string): number {
  return RANK_ORDER.indexOf(rank as (typeof RANK_ORDER)[number]);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlayerState {
  name: string;
  avatar?: string;
  faceDown: (string | null)[];
  faceUp: (string | null)[];
  hand: string[];
  ready: boolean;
  connected?: boolean;
}

type Phase = "lobby" | "rules" | "dealing" | "swap" | "playing" | "finished";
type PlayZone = "hand" | "faceUp" | "faceDown";

type Selection =
  | { zone: "hand"; index: number }
  | { zone: "faceUp"; index: number }
  | null;

// ─── Rules engine ────────────────────────────────────────────────────────────

/** Top card that matters for ranking (skip transparent 7s). */
function getEffectiveTop(discard: string[]): string | null {
  for (let i = discard.length - 1; i >= 0; i--) {
    if (getRank(discard[i]) !== "7") return discard[i];
  }
  return null;
}

function canPlayRankOnDiscard(rank: string, discard: string[]): boolean {
  const top = getEffectiveTop(discard);
  if (!top) return true;

  // Transparent 7 — always allowed
  if (rank === "7") return true;
  // 2 — always allowed
  if (rank === "2") return true;

  const topRank = getRank(top);

  // On a 6: only 6 or lower (2–6), or 7 (already handled). 10 forbidden.
  if (topRank === "6") {
    return rankValue(rank) <= rankValue("6");
  }

  // 10 burns the pile — playable on any card except 6
  if (rank === "10") return true;

  // Normal: must be >= effective top
  return rankValue(rank) >= rankValue(topRank);
}

function canPlayCards(cards: string[], discard: string[]): boolean {
  if (cards.length === 0) return false;
  const ranks = cards.map(getRank);
  if (!ranks.every((r) => r === ranks[0])) return false;
  return canPlayRankOnDiscard(ranks[0], discard);
}

function fourOfAKindBurn(discard: string[]): boolean {
  if (discard.length < 4) return false;
  const last4 = discard.slice(-4).map(getRank);
  return last4.every((r) => r === last4[0]);
}

function shouldBurnAfterPlay(discard: string[], playedRank: string): boolean {
  if (playedRank === "10") return true;
  return fourOfAKindBurn(discard);
}

function sortHand(hand: string[]): string[] {
  return [...hand].sort((a, b) => {
    const d = rankValue(getRank(a)) - rankValue(getRank(b));
    return d !== 0 ? d : a.localeCompare(b);
  });
}

function activePlayZone(player: PlayerState, _deckLen = 0): PlayZone | null {
  if (player.hand.length > 0) return "hand";
  if (player.faceUp.some((c) => c !== null)) return "faceUp";
  if (player.faceDown.some((c) => c !== null)) return "faceDown";
  return null;
}

/** Empty hand + table cards: may take table card(s) together with the discard. */
function canTakeTableWithPickup(player: PlayerState): boolean {
  if (player.hand.length > 0) return false;
  return (
    player.faceUp.some((c) => c !== null) || player.faceDown.some((c) => c !== null)
  );
}

/** Clicked index; for face-up, all matching ranks are taken. */
type TableTake = { zone: "faceUp" | "faceDown"; index: number };

function aiChooseTableTake(player: PlayerState): TableTake | null {
  if (!canTakeTableWithPickup(player)) return null;
  const zone = activePlayZone(player);
  if (zone === "faceUp") {
    let bestIndex = -1;
    let bestValue = Infinity;
    player.faceUp.forEach((c, i) => {
      if (c === null) return;
      const v = rankValue(getRank(c));
      if (v < bestValue) {
        bestValue = v;
        bestIndex = i;
      }
    });
    return bestIndex >= 0 ? { zone: "faceUp", index: bestIndex } : null;
  }
  if (zone === "faceDown") {
    const opts = player.faceDown
      .map((c, i) => (c !== null && player.faceUp[i] === null ? i : -1))
      .filter((i) => i >= 0);
    if (opts.length === 0) return null;
    return { zone: "faceDown", index: opts[Math.floor(Math.random() * opts.length)] };
  }
  return null;
}

function playerFinished(player: PlayerState): boolean {
  return (
    player.hand.length === 0 &&
    player.faceUp.every((c) => c === null) &&
    player.faceDown.every((c) => c === null)
  );
}

function unfinishedPlayers(pls: PlayerState[]): number[] {
  return pls.map((_, i) => i).filter((i) => !playerFinished(pls[i]));
}

/** Append finisher; if ≤1 left, append the loser and mark game over. */
function resolveStandings(
  finisher: number,
  pls: PlayerState[],
  prevOrder: number[]
): { order: number[]; gameOver: boolean; place: number } {
  const order = prevOrder.includes(finisher) ? [...prevOrder] : [...prevOrder, finisher];
  const place = order.indexOf(finisher) + 1;
  const left = unfinishedPlayers(pls);
  if (left.length <= 1) {
    if (left.length === 1 && !order.includes(left[0])) order.push(left[0]);
    return { order, gameOver: true, place };
  }
  return { order, gameOver: false, place };
}

function placeLabel(place: number, total: number): string {
  if (place === total && total > 1) return "Last";
  const suf = place === 1 ? "st" : place === 2 ? "nd" : place === 3 ? "rd" : "th";
  return `${place}${suf}`;
}

function refillHand(
  hand: string[],
  deck: string[]
): { hand: string[]; deck: string[]; drawn: string[] } {
  const h = [...hand];
  const d = [...deck];
  const drawn: string[] = [];
  while (h.length < HAND_SIZE && d.length > 0) {
    const card = d.shift()!;
    drawn.push(card);
    h.push(card);
  }
  return { hand: sortHand(h), deck: d, drawn };
}

function removeIndices(arr: string[], indices: number[]): { kept: string[]; removed: string[] } {
  const set = new Set(indices);
  const kept: string[] = [];
  const removed: string[] = [];
  arr.forEach((c, i) => (set.has(i) ? removed.push(c) : kept.push(c)));
  return { kept, removed };
}

interface CombinedPlay {
  hand: number[];
  faceUp: number[];
}

const emptyPlay = (): CombinedPlay => ({ hand: [], faceUp: [] });

function playSelectionRank(player: PlayerState, sel: CombinedPlay): string | null {
  if (sel.hand.length > 0) return getRank(player.hand[sel.hand[0]]);
  if (sel.faceUp.length > 0) {
    const c = player.faceUp[sel.faceUp[0]];
    return c ? getRank(c) : null;
  }
  return null;
}

function cardsFromSelection(player: PlayerState, sel: CombinedPlay): string[] {
  const cards: string[] = [];
  for (const i of sel.hand) cards.push(player.hand[i]);
  for (const i of sel.faceUp) {
    const c = player.faceUp[i];
    if (c) cards.push(c);
  }
  return cards;
}

function selectionCount(sel: CombinedPlay): number {
  return sel.hand.length + sel.faceUp.length;
}

/**
 * Hand + face-up combo is allowed only when:
 * - draw deck is empty, and
 * - the hand cards in the play are the player's entire hand
 *   (last card, or last identical cards — hand becomes empty).
 */
function canCombineHandWithFaceUp(
  player: PlayerState,
  deckLen: number,
  handIndices: number[]
): boolean {
  if (deckLen > 0) return false;
  if (player.hand.length === 0) return false;
  if (handIndices.length !== player.hand.length) return false;
  if (handIndices.length === 0) return false;
  const ranks = handIndices.map((i) => getRank(player.hand[i]));
  return ranks.every((r) => r === ranks[0]);
}

/** True when player may attach face-up cards (deck empty, whole hand is one rank). */
function mayAttachFaceUp(player: PlayerState, deckLen: number): boolean {
  if (deckLen > 0 || player.hand.length === 0) return false;
  const r0 = getRank(player.hand[0]);
  return player.hand.every((c) => getRank(c) === r0);
}

/** AI: pick a legal play (prefer fewest cards, then lowest rank; combine only when allowed). */
function aiChoosePlay(
  player: PlayerState,
  discard: string[],
  deckLen: number
): { kind: "cards"; hand: number[]; faceUp: number[] } | { kind: "faceDown"; index: number } | null {
  const zone = activePlayZone(player, deckLen);
  if (!zone) return null;

  if (zone === "faceDown") {
    const idx = player.faceDown.findIndex((c, i) => c !== null && player.faceUp[i] === null);
    if (idx < 0) return null;
    return { kind: "faceDown", index: idx };
  }

  const primary = zone === "hand" ? player.hand : player.faceUp;
  const byRank = new Map<string, { hand: number[]; faceUp: number[] }>();

  primary.forEach((c, i) => {
    if (c === null) return;
    const r = getRank(c);
    if (!byRank.has(r)) byRank.set(r, { hand: [], faceUp: [] });
    if (zone === "hand") byRank.get(r)!.hand.push(i);
    else byRank.get(r)!.faceUp.push(i);
  });

  const allowCombine = zone === "hand" && mayAttachFaceUp(player, deckLen);
  if (allowCombine) {
    const handRank = getRank(player.hand[0]);
    player.faceUp.forEach((c, i) => {
      if (c === null) return;
      if (getRank(c) !== handRank) return;
      byRank.get(handRank)?.faceUp.push(i);
    });
  }

  const candidates: { rank: string; hand: number[]; faceUp: number[] }[] = [];
  for (const [rank, idxs] of byRank) {
    if (!canPlayRankOnDiscard(rank, discard)) continue;
    const topSame =
      discard.length > 0 && getRank(discard[discard.length - 1]) === rank
        ? (() => {
            let n = 0;
            for (let i = discard.length - 1; i >= 0 && getRank(discard[i]) === rank; i--) n++;
            return n;
          })()
        : 0;

    if (zone === "hand") {
      const canCombine =
        allowCombine &&
        idxs.hand.length === player.hand.length &&
        idxs.faceUp.length > 0;
      let handIdxs = idxs.hand;
      let faceIdxs = canCombine ? idxs.faceUp : [];
      // Without combine: play 1, or more for 10 / four-of-a-kind
      if (!canCombine) {
        let count = 1;
        if (rank === "10") count = idxs.hand.length;
        else if (topSame + idxs.hand.length >= 4)
          count = Math.min(idxs.hand.length, 4 - topSame);
        handIdxs = idxs.hand.slice(0, count);
        faceIdxs = [];
      }
      candidates.push({ rank, hand: handIdxs, faceUp: faceIdxs });
    } else {
      let count = 1;
      if (rank === "10") count = idxs.faceUp.length;
      else if (topSame + idxs.faceUp.length >= 4)
        count = Math.min(idxs.faceUp.length, 4 - topSame);
      candidates.push({ rank, hand: [], faceUp: idxs.faceUp.slice(0, count) });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
  const best = candidates[0];
  return { kind: "cards", hand: best.hand, faceUp: best.faceUp };
}

// ─── Solo tutorial ───────────────────────────────────────────────────────────

type TutWait = "dealing" | "continue" | "swap" | "ready" | "play" | "coach" | "take" | "free";
type TutHint = "hand" | "faceUp" | "ready" | "play" | "take" | "none";
type TutSpecial = "2" | "6" | "7" | "10" | "4";

interface TutStep {
  text: string;
  wait: TutWait;
  hint?: TutHint;
  rank?: string;
  count?: number;
  faceRank?: string;
  coachRank?: string;
  special?: TutSpecial;
}

const SPECIALS_MEMO: { id: TutSpecial; label: string; text: string }[] = [
  { id: "2", label: "2", text: "Plays on anything. Pile resets to 2." },
  { id: "6", label: "6", text: "Only 6 or lower, or a 7. No 10s." },
  { id: "7", label: "7", text: "Transparent — the card under it still counts." },
  { id: "10", label: "10", text: "Plays on anything except 6. Burns the pile." },
  { id: "4", label: "4×", text: "Four of a kind in a row also burns." },
];

const TUTORIAL_STEPS: TutStep[] = [
  {
    text: "Each player gets 3 face-down cards, then 3 face-up on top, then 3 in hand.",
    wait: "dealing",
  },
  {
    text: "Before play, swap hand cards with your face-up cards. Strong cards on the table are played last.",
    wait: "continue",
  },
  {
    text: "Try it: tap the Ace in your hand, then the 3 on the table.",
    wait: "swap",
    hint: "hand",
    rank: "A",
    faceRank: "3",
  },
  {
    text: "Ace is waiting on the table. Tap Ready when the swap looks good.",
    wait: "ready",
    hint: "ready",
  },
  {
    text: "Ranks go 2 < 3 < \u2026 < K < A. Suits don't count. Empty pile \u2014 any card works. Tap your 4, then Play.",
    wait: "play",
    hint: "hand",
    rank: "4",
  },
  {
    text: "Watch Coach play a 5. Your next card must be equal or higher \u2014 unless it is a special.",
    wait: "coach",
    coachRank: "5",
  },
  {
    text: "Play your 8 \u2014 it beats the 5.",
    wait: "play",
    hint: "hand",
    rank: "8",
  },
  {
    text: "Watch Coach play a King.",
    wait: "coach",
    coachRank: "K",
  },
  {
    text: "King is high. Your 3 loses. But 2 plays on anything and resets the pile. Play your 2.",
    wait: "play",
    hint: "hand",
    rank: "2",
    special: "2",
  },
  {
    text: "Watch Coach play a 4. The 2 reset the pile, so any card was legal.",
    wait: "coach",
    coachRank: "4",
    special: "2",
  },
  {
    text: "Play your 6 \u2014 after a 6, only 6 or lower (or a 7) can be played. Your 10 is illegal.",
    wait: "play",
    hint: "hand",
    rank: "6",
    special: "6",
  },
  {
    text: "Watch Coach play a 7. It is transparent \u2014 the 6 underneath still counts.",
    wait: "coach",
    coachRank: "7",
    special: "7",
  },
  {
    text: "Your turn to play a 7. The pile still counts as 6, so a 10 still cannot burn it.",
    wait: "play",
    hint: "hand",
    rank: "7",
    special: "7",
  },
  {
    text: "Watch Coach play another 7. Two 7s in a row still leave the 6 in charge.",
    wait: "coach",
    coachRank: "7",
    special: "7",
  },
  {
    text: "3 is 6 or lower, so it is legal. Play your 3.",
    wait: "play",
    hint: "hand",
    rank: "3",
    special: "6",
  },
  {
    text: "Watch Coach play a 9.",
    wait: "coach",
    coachRank: "9",
  },
  {
    text: "10 plays on anything except a 6 and burns the discard. You go again. Play your 10.",
    wait: "play",
    hint: "hand",
    rank: "10",
    special: "10",
  },
  {
    text: "Pile burned. Empty pile \u2014 play your 4.",
    wait: "play",
    hint: "hand",
    rank: "4",
  },
  {
    text: "Watch Coach play a Queen.",
    wait: "coach",
    coachRank: "Q",
    special: "4",
  },
  {
    text: "Select all three Queens, then Play. Four of a kind in a row burns, same as a 10.",
    wait: "play",
    hint: "hand",
    rank: "Q",
    count: 3,
    special: "4",
  },
  {
    text: "The pile burned, so you go again. Play your 5.",
    wait: "play",
    hint: "hand",
    rank: "5",
  },
  {
    text: "Watch Coach play an Ace.",
    wait: "coach",
    coachRank: "A",
  },
  {
    text: "Ace beats 8, J, and 5. You have no 2, 7, or 10. Take the discard.",
    wait: "take",
    hint: "take",
  },
  {
    text: "Play from your hand first. When the deck and hand are empty, play face-up, then flip face-down. First to empty all cards takes 1st place.",
    wait: "continue",
  },
  {
    text: "That's the rules. Keep playing against Coach, or leave with \u2190 Lobby.",
    wait: "free",
  },
];

function buildTutorialDeck(): string[] {
  const slots: (string | null)[] = Array.from({ length: 52 }, () => null);
  const used = new Set<string>();
  const put = (i: number, card: string) => {
    used.add(card);
    slots[i] = card;
  };
  // Deal order for 2 players: FD 0,2,4 / 1,3,5 then FU 6,8,10 / 7,9,11 then hand 12,14,16 / 13,15,17
  put(0, "5♣");
  put(2, "8♦");
  put(4, "J♥");
  put(1, "5♦");
  put(3, "6♠");
  put(5, "J♠");
  put(6, "3♠");
  put(8, "9♥");
  put(10, "K♣");
  put(7, "4♣");
  put(9, "9♦");
  put(11, "K♠");
  put(12, "4♦");
  put(14, "8♠");
  put(16, "A♥");
  put(13, "5♥");
  put(15, "7♣");
  put(17, "K♦");
  put(18, "6♥");
  put(19, "9♣");
  put(20, "2♣");
  put(21, "4♥");
  put(22, "10♠");
  put(23, "3♦");
  put(24, "7♦");
  put(25, "7♥");
  put(26, "Q♦");
  put(27, "A♠");
  put(28, "Q♣");
  put(29, "Q♠");
  put(30, "4♠");
  put(31, "Q♥");
  put(32, "8♣");
  put(33, "5♠");
  put(34, "8♥");
  put(35, "J♣");
  put(36, "9♠");
  const rest: string[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      const c = `${r}${s}`;
      if (!used.has(c)) rest.push(c);
    }
  }
  let k = 0;
  for (let i = 0; i < 52; i++) {
    if (!slots[i]) slots[i] = rest[k++];
  }
  return slots as string[];
}

function tutorialFreeIndex(): number {
  const i = TUTORIAL_STEPS.findIndex((s) => s.wait === "free");
  return i >= 0 ? i : TUTORIAL_STEPS.length - 1;
}

function tutorialLockedAt(step: number): boolean {
  const s = TUTORIAL_STEPS[step];
  return !!s && s.wait !== "free";
}

// ─── CSS keyframes ───────────────────────────────────────────────────────────

const STYLE_ID = "card-game-keyframes-v17";
function ensureKeyframes() {
  if (typeof document === "undefined") return;
  for (const id of ["card-game-keyframes", "card-game-keyframes-v3", "card-game-keyframes-v4", "card-game-keyframes-v5", "card-game-keyframes-v6", "card-game-keyframes-v7", "card-game-keyframes-v8", "card-game-keyframes-v9", "card-game-keyframes-v10", "card-game-keyframes-v11", "card-game-keyframes-v12", "card-game-keyframes-v13", "card-game-keyframes-v14", "card-game-keyframes-v15", "card-game-keyframes-v16"]) {
    document.getElementById(id)?.remove();
  }
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes cardDealIn {
      0% { opacity: 0; transform: translate(-120px, -60px) scale(0.5) rotate(-15deg); }
      60% { opacity: 1; transform: translate(4px, -4px) scale(1.08) rotate(2deg); }
      100% { opacity: 1; transform: translate(0, 0) scale(1) rotate(0deg); }
    }
    @keyframes cardFlipIn {
      0% { opacity: 0; transform: translate(-100px, -40px) scale(0.4) rotateY(180deg); }
      50% { opacity: 1; transform: translate(2px, -2px) scale(1.05) rotateY(40deg); }
      100% { opacity: 1; transform: translate(0, 0) scale(1) rotateY(0deg); }
    }
    @keyframes cardHandIn {
      0% { opacity: 0; transform: translate(-80px, -30px) scale(0.3); }
      70% { opacity: 1; transform: translate(0, -8px) scale(1.06); }
      100% { opacity: 1; transform: translate(0, 0) scale(1); }
    }
    @keyframes swapPop {
      0% { transform: scale(1); }
      50% { transform: scale(1.12); }
      100% { transform: scale(1); }
    }
    @keyframes timerPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.06); }
    }
    @keyframes cardFlyToDiscard {
      0% { opacity: 1; transform: translate(var(--fx), var(--fy)) scale(0.9) rotate(var(--fr)); }
      55% { opacity: 1; transform: translate(var(--mx), var(--my)) scale(1.06) rotate(var(--mr)); }
      100% { opacity: 1; transform: translate(var(--tx), var(--ty)) scale(1) rotate(0deg); }
    }
    @keyframes cardFlyToBurn {
      0% { opacity: 1; transform: translate(0, 0) scale(1) rotate(0deg); }
      100% { opacity: 0.85; transform: translate(var(--bx), var(--by)) scale(0.62) rotate(16deg); }
    }
    @keyframes cardFlyToPlayer {
      0% { opacity: 1; transform: translate(0, 0) scale(1) rotate(0deg); }
      100% { opacity: 0.8; transform: translate(var(--px), var(--py)) scale(0.68) rotate(var(--pr)); }
    }
    @keyframes cardFlyFromDeck {
      0% { opacity: 1; transform: translate(var(--dx), var(--dy)) scale(0.92) rotate(-10deg); }
      100% { opacity: 1; transform: translate(var(--px), var(--py)) scale(0.86) rotate(var(--pr)); }
    }
    @keyframes cardDrawReveal {
      0%, 68% { transform: rotateY(180deg); }
      100% { transform: rotateY(360deg); }
    }
    @keyframes revealPop {
      0% { opacity: 0; transform: scale(0.45) rotate(-14deg); }
      45% { opacity: 1; transform: scale(1.1) rotate(3deg); }
      100% { opacity: 1; transform: scale(1) rotate(0deg); }
    }
    @keyframes lobbyFeltBreathe {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50% { opacity: 0.85; transform: scale(1.08); }
    }
    @keyframes lobbyFanSettle {
      0% { opacity: 0; transform: translate(var(--fan-x), calc(var(--fan-y) + 28px)) scale(0.88) rotate(var(--fan-rot)); }
      70% { opacity: 1; transform: translate(var(--fan-x), calc(var(--fan-y) - 4px)) scale(1.03) rotate(var(--fan-rot)); }
      100% { opacity: 1; transform: translate(var(--fan-x), var(--fan-y)) scale(1) rotate(var(--fan-rot)); }
    }
    @keyframes lobbyBrandIn {
      0% { opacity: 0; transform: translateY(12px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    .card-deal-facedown { animation: cardDealIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .card-deal-faceup  { animation: cardFlipIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .card-deal-hand    { animation: cardHandIn 0.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .card-swap-pop     { animation: swapPop 0.28s ease; }
    @media (hover: hover) {
      .card-hoverable:hover { transform: translateY(-6px) !important; }
    }
    .felt-chip {
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      font-family: inherit;
    }
    .felt-chip:active:not(:disabled) { transform: translateY(1px); filter: brightness(0.92); }
    html:fullscreen, html:-webkit-full-screen { background: #145230; width: 100%; height: 100%; }
    .card-fly { animation: cardFlyToDiscard 0.58s cubic-bezier(0.22, 1, 0.36, 1) both; pointer-events: none; }
    .card-fly-burn { animation: cardFlyToBurn 0.55s cubic-bezier(0.33, 1, 0.68, 1) both; pointer-events: none; }
    .card-fly-pickup { animation: cardFlyToPlayer 0.55s cubic-bezier(0.33, 1, 0.68, 1) both; pointer-events: none; }
    .card-fly-draw { animation: cardFlyFromDeck 0.62s cubic-bezier(0.22, 1, 0.36, 1) both; pointer-events: none; transform-style: preserve-3d; }
    .card-draw-reveal { animation: cardDrawReveal 0.62s cubic-bezier(0.22, 1, 0.36, 1) both; transform-style: preserve-3d; }
    .card-reveal { animation: revealPop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .timer-urgent { animation: timerPulse 0.8s ease-in-out infinite; }
    @keyframes tutGlow {
      0%, 100% { box-shadow: 0 0 0 2px rgba(241,196,15,0.4), 0 0 10px rgba(241,196,15,0.28); }
      50% { box-shadow: 0 0 0 3px rgba(241,196,15,0.95), 0 0 18px rgba(241,196,15,0.55); }
    }
    .tut-glow { animation: tutGlow 1.15s ease-in-out infinite; }
    .tut-glow-chip { animation: tutGlow 1.15s ease-in-out infinite; }
    .lobby-felt-glow {
      position: absolute;
      inset: -10%;
      background: radial-gradient(ellipse at 50% 42%, rgba(255,255,255,0.16) 0%, transparent 58%);
      animation: lobbyFeltBreathe 5.5s ease-in-out infinite;
      pointer-events: none;
    }
    .lobby-fan-card {
      animation: lobbyFanSettle 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .lobby-brand-in {
      animation: lobbyBrandIn 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @media (max-width: 640px) {
      .lobby-fs-hint { display: none !important; }
    }
    @media (orientation: landscape) and (max-height: 520px) {
      .lobby-title { font-size: 30px !important; }
      .lobby-fan-wrap { height: 52px !important; margin: 0 0 0 !important; transform: scale(0.68); transform-origin: top center; }
      .lobby-fan-wrap .lobby-fan-card { top: 0 !important; }
      .lobby-fs-hint { display: none !important; }
    }
    .lobby-play-btn {
      transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    }
    .lobby-play-btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 10px 24px rgba(0,0,0,0.28);
    }
    .lobby-play-btn:active {
      transform: translateY(-1px);
    }
    .lobby-ghost-btn {
      transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
    }
    .lobby-ghost-btn:hover {
      transform: translateY(-2px);
      background: rgba(255,255,255,0.08);
    }
    .lobby-ghost-btn:active {
      transform: translateY(-1px);
    }
    @keyframes winnerBannerIn {
      0% { opacity: 0; transform: scale(0.72) translateY(22px); }
      55% { opacity: 1; transform: scale(1.06) translateY(-6px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes winnerBurst {
      0% { opacity: 0; transform: scale(0.35); }
      35% { opacity: 0.5; transform: scale(1.05); }
      100% { opacity: 0; transform: scale(1.85); }
    }
    @keyframes winnerConfetti {
      0% { opacity: 0; transform: translate3d(var(--cx), -18%, 0) rotate(0deg); }
      10% { opacity: 1; }
      100% { opacity: 0.12; transform: translate3d(calc(var(--cx) + var(--cdx)), 122%, 0) rotate(var(--crot)); }
    }
    .winner-banner { animation: winnerBannerIn 0.55s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .winner-burst { animation: winnerBurst 0.9s ease-out both; pointer-events: none; }
    .winner-confetti { animation: winnerConfetti var(--cdur) linear var(--cdelay) both; pointer-events: none; }
    @keyframes chatToastIn {
      0% { opacity: 0; transform: translateY(12px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    .chat-toast { animation: chatToastIn 0.22s ease-out both; }
    .chat-toast-stack {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 6px;
      pointer-events: none;
      width: 100%;
    }
    .emoji-rail {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      overscroll-behavior-x: contain;
    }
    .emoji-rail::-webkit-scrollbar { display: none; }
    .emoji-rail button { scroll-snap-align: start; flex: 0 0 auto; min-width: 40px; }
    @keyframes emojiReactFly {
      0% { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.45); }
      12% { opacity: 1; transform: translate3d(-8px, -28px, 0) scale(1.22); }
      72% { opacity: 1; }
      100% { opacity: 0; transform: translate3d(var(--ex), var(--ey), 0) scale(0.92) rotate(var(--erot)); }
    }
    .emoji-react-fly {
      animation: emojiReactFly 1.65s ease-out both;
      pointer-events: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .winner-banner { animation: none !important; }
      .winner-burst, .winner-confetti { animation: none !important; opacity: 0 !important; }
      .chat-toast { animation: none !important; }
      .emoji-react-fly { animation: none !important; opacity: 0 !important; }
    }
  `;
  document.head.appendChild(style);
}

const CARD_BACK_BG = "#1a5276";
const CARD_BACK_PATTERN =
  "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.06) 4px, rgba(255,255,255,0.06) 8px)";
const CARD_BACK_INNER =
  "radial-gradient(ellipse at center, rgba(255,255,255,0.08) 0%, transparent 70%)";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function cardBox(w: number, h: number) {
  return {
    w,
    h,
    r: Math.max(5, Math.round(w * 0.11)),
    rank: Math.max(8, Math.round(w * 0.18)),
    suit: Math.max(7, Math.round(w * 0.15)),
    mid: Math.max(14, Math.round(w * 0.39)),
    midSuit: Math.max(10, Math.round(w * 0.28)),
  };
}

type VirtualKeyboardNav = Navigator & {
  virtualKeyboard?: {
    overlaysContent: boolean;
    boundingRect?: DOMRect;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  };
};

function pinLayoutScroll() {
  try {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const vk = (navigator as VirtualKeyboardNav).virtualKeyboard;
    if (vk) vk.overlaysContent = true;
  } catch {
    /* ignore */
  }
}

function subscribeViewport(fit: () => void) {
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);
  window.visualViewport?.addEventListener("resize", fit);
  window.visualViewport?.addEventListener("scroll", fit);
  const vk = (navigator as VirtualKeyboardNav).virtualKeyboard;
  vk?.addEventListener("geometrychange", fit);
  return () => {
    window.removeEventListener("resize", fit);
    window.removeEventListener("orientationchange", fit);
    window.visualViewport?.removeEventListener("resize", fit);
    window.visualViewport?.removeEventListener("scroll", fit);
    vk?.removeEventListener("geometrychange", fit);
  };
}

function readVisualMetrics() {
  const innerW = window.innerWidth;
  const innerH = window.innerHeight;
  const vv = window.visualViewport;
  const vvW = vv?.width ?? innerW;
  const vvH = vv?.height ?? innerH;
  const offsetTop = vv?.offsetTop ?? 0;
  const offsetLeft = vv?.offsetLeft ?? 0;
  const vkH = (navigator as VirtualKeyboardNav).virtualKeyboard?.boundingRect?.height ?? 0;
  const covered = Math.max(0, innerH - (vvH + offsetTop), vkH);
  return {
    innerW,
    innerH,
    vvW,
    vvH,
    offsetTop,
    offsetLeft,
    covered,
    vkH,
    keyboard: covered > 80,
  };
}

function useViewport() {
  const stable = useRef({ w: 1024, h: 700 });
  const [vp, setVp] = useState({ w: 1024, h: 700 });
  useEffect(() => {
    const fit = () => {
      const m = readVisualMetrics();
      const layoutH = m.vvH + m.offsetTop;
      const kb = m.covered > 80 || layoutH < stable.current.h - 100;
      if (!kb) {
        stable.current = {
          w: Math.max(1, Math.round(m.innerW)),
          h: Math.max(1, Math.round(Math.max(m.innerH, layoutH))),
        };
      }
      setVp({
        w: kb ? stable.current.w : Math.max(1, Math.round(m.vvW)),
        h: kb ? stable.current.h : Math.max(1, Math.round(m.vvH)),
      });
    };
    fit();
    return subscribeViewport(fit);
  }, []);
  return vp;
}

function useVisualInset() {
  const stable = useRef({ w: 1024, h: 700 });
  const [inset, setInset] = useState({
    bottom: 0,
    left: 0,
    top: 0,
    width: 1024,
    height: 700,
    keyboard: false,
    vkH: 0,
    android: false,
  });
  useEffect(() => {
    const android = /Android/i.test(navigator.userAgent);
    const fit = () => {
      const m = readVisualMetrics();
      const layoutH = m.vvH + m.offsetTop;
      if (Math.abs(m.innerW - stable.current.w) > 60) {
        stable.current = {
          w: Math.max(1, Math.round(m.innerW)),
          h: Math.max(1, Math.round(Math.max(m.innerH, layoutH))),
        };
      }
      const shrunk = layoutH < stable.current.h - 100;
      const keyboard = m.covered > 80 || m.vkH > 80 || shrunk;
      if (!keyboard) {
        stable.current = {
          w: Math.max(1, Math.round(m.innerW)),
          h: Math.max(1, Math.round(Math.max(m.innerH, layoutH))),
        };
      }
      setInset({
        bottom: Math.round(m.covered),
        left: Math.round(m.offsetLeft),
        top: Math.round(m.offsetTop),
        width: Math.max(1, Math.round(m.vvW)),
        height: Math.max(1, Math.round(m.vvH)),
        keyboard,
        vkH: Math.round(m.vkH),
        android,
      });
    };
    fit();
    let burstId: number | undefined;
    const burst = () => {
      fit();
      if (burstId) window.clearInterval(burstId);
      let n = 0;
      burstId = window.setInterval(() => {
        fit();
        n += 1;
        if (n >= 24) {
          window.clearInterval(burstId);
          burstId = undefined;
        }
      }, 50);
    };
    const onFocus = () => burst();
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    const unsub = subscribeViewport(fit);
    const poll = window.setInterval(() => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) fit();
    }, 250);
    return () => {
      unsub();
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
      window.clearInterval(poll);
      if (burstId) window.clearInterval(burstId);
    };
  }, []);
  return inset;
}

function isStandaloneDisplay() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone
  );
}

function isFullscreenActive() {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return !!(document.fullscreenElement || doc.webkitFullscreenElement || isStandaloneDisplay());
}

function canRequestFullscreen() {
  const el = document.documentElement as HTMLElement & {
    requestFullscreen?: (opts?: FullscreenOptions) => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

async function enterFullscreen(): Promise<"ok" | "unsupported" | "denied"> {
  if (isFullscreenActive()) return "ok";
  const el = document.documentElement as HTMLElement & {
    requestFullscreen?: (opts?: FullscreenOptions) => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
  if (!el.requestFullscreen && !el.webkitRequestFullscreen) return "unsupported";
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else el.webkitRequestFullscreen?.();
  } catch {
    return "denied";
  }
  try {
    await (screen.orientation as ScreenOrientation & { lock?: (m: string) => Promise<void> })?.lock?.("landscape");
  } catch {
    /* not supported outside fullscreen on many browsers */
  }
  return "ok";
}

async function exitFullscreen() {
  const doc = document as Document & { webkitExitFullscreen?: () => void };
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } catch {
    /* already exited */
  }
  try {
    screen.orientation?.unlock?.();
  } catch {
    /* ignore */
  }
}

function useFullscreen() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(isFullscreenActive());
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);
  return on;
}

function VisualFrame({ children }: { children: ReactNode }) {
  const vp = useViewport();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: vp.w,
        height: vp.h,
        overflow: "hidden",
        background: "#145230",
      }}
    >
      <div id="clerk-captcha" style={{ position: "absolute", left: 0, bottom: 0, zIndex: 50 }} />
      {children}
    </div>
  );
}

// ─── Playing Card ────────────────────────────────────────────────────────────

interface CardProps {
  card?: string;
  faceVisible: boolean;
  style?: CSSProperties;
  small?: boolean;
  w?: number;
  h?: number;
  animClass?: string;
  selected?: boolean;
  selectable?: boolean;
  locked?: boolean;
  dimmed?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
}

function PlayingCard({
  card,
  faceVisible,
  style,
  small,
  w: wProp,
  h: hProp,
  animClass,
  selected,
  selectable,
  locked,
  dimmed,
  highlighted,
  onClick,
}: CardProps) {
  const w = wProp ?? (small ? 38 : 56);
  const h = hProp ?? (small ? 54 : 78);
  const box = cardBox(w, h);
  const cls = [animClass, highlighted ? "tut-glow" : ""].filter(Boolean).join(" ") || undefined;

  const base: CSSProperties = {
    width: w,
    height: h,
    borderRadius: box.r,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    position: "absolute",
    cursor: selectable && !locked ? "pointer" : "default",
    touchAction: selectable ? "manipulation" : undefined,
    outline: selected ? "2px solid #f1c40f" : "none",
    outlineOffset: 2,
    opacity: dimmed ? 0.4 : locked && selectable ? 0.85 : 1,
    ...style,
  };

  if (!faceVisible) {
    return (
      <div
        className={cls}
        onClick={selectable && !locked ? onClick : undefined}
        style={{
          ...base,
          background: CARD_BACK_BG,
          backgroundImage: CARD_BACK_PATTERN,
          border: "1.5px solid #1a4060",
        }}
      >
        <div
          style={{
            width: w - 8,
            height: h - 8,
            borderRadius: 3,
            border: "1px solid rgba(255,255,255,0.12)",
            backgroundImage: CARD_BACK_INNER,
          }}
        />
      </div>
    );
  }

  if (!card) return null;
  const { rank, suit, color } = getCardLabel(card);

  return (
    <div
      className={cls}
      onClick={selectable && !locked ? onClick : undefined}
      style={{
        ...base,
        background: "#fff",
        border: selected ? "1.5px solid #f1c40f" : "1.5px solid #ccc",
      }}
    >
      <span style={{ position: "absolute", top: 3, left: 5, fontSize: box.rank, fontWeight: 700, color, lineHeight: 1 }}>
        {rank}
      </span>
      <span style={{ position: "absolute", top: 3 + box.rank + 1, left: 5, fontSize: box.suit, color, lineHeight: 1 }}>
        {suit}
      </span>
      <span style={{ fontSize: box.mid, fontWeight: 700, color, lineHeight: 1 }}>{rank}</span>
      <span style={{ fontSize: box.midSuit, color, lineHeight: 1, marginTop: 1 }}>{suit}</span>
      <span
        style={{
          position: "absolute",
          bottom: 3,
          right: 5,
          fontSize: box.rank,
          fontWeight: 700,
          color,
          lineHeight: 1,
          transform: "rotate(180deg)",
        }}
      >
        {rank}
      </span>
    </div>
  );
}

// ─── Table stack ─────────────────────────────────────────────────────────────

interface TableStackProps {
  faceDown: (string | null)[];
  faceUp: (string | null)[];
  revealed: boolean;
  small?: boolean;
  cardW?: number;
  cardH?: number;
  animating?: boolean;
  fuAnimSlots?: number;
  selectableFaceUp?: boolean;
  selectableFaceDown?: boolean;
  locked?: boolean;
  selectedFaceUp?: number[];
  faceUpLegal?: boolean[];
  glowFaceUp?: boolean[];
  onSelectFaceUp?: (index: number) => void;
  onSelectFaceDown?: (index: number) => void;
  swapKey?: number;
  peekedDown?: boolean[];
}

function TableStack({
  faceDown,
  faceUp,
  revealed,
  small,
  cardW,
  cardH,
  animating,
  fuAnimSlots = 0,
  selectableFaceUp,
  selectableFaceDown,
  locked,
  selectedFaceUp = [],
  faceUpLegal,
  glowFaceUp,
  onSelectFaceUp,
  onSelectFaceDown,
  swapKey = 0,
  peekedDown,
}: TableStackProps) {
  const w = cardW ?? (small ? 38 : 56);
  const h = cardH ?? (small ? 54 : 78);
  const lift = Math.max(8, Math.round(h * 0.12));
  const slotCount = Math.max(faceDown.length, faceUp.length, 3);

  return (
    <div style={{ display: "flex", gap: Math.max(4, Math.round(w * 0.14)) }}>
      {Array.from({ length: slotCount }, (_, i) => {
        const down = faceDown[i] ?? null;
        const up = faceUp[i] ?? null;
        if (!down && !up) return null;
        const showFaceUp = revealed && !!up;
        const showFaceDown = !!down;
        return (
          <div
            key={i}
            style={{
              position: "relative",
              width: w,
              height: showFaceUp && showFaceDown ? h + lift : h,
            }}
          >
            {showFaceDown && (
              <PlayingCard
                card={down}
                faceVisible={!!peekedDown?.[i]}
                style={{ top: 0, left: 0 }}
                w={w}
                h={h}
                selectable={!!selectableFaceDown && !showFaceUp}
                locked={locked}
                onClick={() => onSelectFaceDown?.(i)}
                animClass={animating && i === (fuAnimSlots > 0 ? faceDown.filter(Boolean).length - 1 : i) ? "card-deal-facedown" : undefined}
              />
            )}
            {showFaceUp && (
              <PlayingCard
                card={up!}
                faceVisible
                style={{ top: showFaceDown ? lift : 0, left: 0 }}
                w={w}
                h={h}
                selected={selectedFaceUp.includes(i)}
                selectable={selectableFaceUp}
                locked={locked}
                dimmed={
                  glowFaceUp
                    ? !glowFaceUp[i]
                    : faceUpLegal
                      ? !faceUpLegal[i]
                      : false
                }
                highlighted={!!glowFaceUp?.[i]}
                onClick={() => onSelectFaceUp?.(i)}
                animClass={
                  animating && i === fuAnimSlots - 1
                    ? "card-deal-faceup"
                    : swapKey > 0
                      ? "card-swap-pop"
                      : undefined
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Hand ────────────────────────────────────────────────────────────────────

interface HandProps {
  cards: string[];
  isOwner: boolean;
  small?: boolean;
  cardW?: number;
  cardH?: number;
  maxWidth?: number;
  peek?: number;
  animating?: boolean;
  selectable?: boolean;
  locked?: boolean;
  selectedIndices?: number[];
  legalMask?: boolean[];
  glowMask?: boolean[];
  onSelect?: (index: number) => void;
  swapKey?: number;
  seatId?: number;
}

function Hand({
  cards,
  isOwner,
  small,
  cardW,
  cardH,
  maxWidth,
  peek,
  animating,
  selectable,
  locked,
  selectedIndices = [],
  legalMask,
  glowMask,
  onSelect,
  swapKey = 0,
  seatId,
}: HandProps) {
  const w = cardW ?? (small ? 38 : 56);
  const h = cardH ?? (small ? 54 : 78);
  const overlap = Math.round(w * (isOwner ? 0.3 : 0.78));
  const n = cards.length;
  const comfortableStep = Math.max(6, w - overlap);
  const threeW = w + 2 * comfortableStep;
  const naturalW = n <= 1 ? (n === 1 ? w : 0) : w + (n - 1) * comfortableStep;
  const cap = maxWidth ?? (isOwner ? Infinity : threeW);
  const packed = n > 1 && naturalW > cap;
  const packedStep = packed ? (Math.min(cap, naturalW) - w) / Math.max(1, n - 1) : comfortableStep;
  const step = n <= 1 ? 0 : packed ? Math.max(10, packedStep) : comfortableStep;
  const totalW = n === 0 ? 0 : n === 1 ? w : w + (n - 1) * step;

  return (
    <div data-hand-fan={seatId} style={{ position: "relative", width: totalW || 1, height: h }}>
      {cards.map((card, i) => (
        <div
          key={`${card}-${i}-${swapKey}`}
          className={isOwner && selectable && !locked ? "card-hoverable" : undefined}
          style={{
            position: "absolute",
            left: i * step,
            top: selectedIndices.includes(i) ? -Math.round(h * 0.12) : 0,
            zIndex: selectedIndices.includes(i) ? 100 : i,
            transition: "top 0.15s ease, left 0.15s ease",
          }}
        >
          <PlayingCard
            card={card}
            faceVisible={isOwner}
            style={{ top: 0, left: 0 }}
            w={w}
            h={h}
            selected={selectedIndices.includes(i)}
            selectable={selectable && isOwner}
            locked={locked}
            dimmed={
              isOwner && glowMask
                ? !glowMask[i]
                : isOwner && legalMask
                  ? !legalMask[i]
                  : false
            }
            highlighted={!!isOwner && !!glowMask?.[i]}
            onClick={() => onSelect?.(i)}
            animClass={
              animating && i === cards.length - 1
                ? "card-deal-hand"
                : swapKey > 0 && isOwner
                  ? "card-swap-pop"
                  : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}

// ─── Deck / Discard ──────────────────────────────────────────────────────────

function DeckPile({ count }: { count: number }) {
  return (
    <div style={{ position: "relative", width: 64, height: 90 }}>
      {[...Array(Math.min(count, 6))].map((_, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: -i * 1.5,
            left: i * 0.6,
            width: 64,
            height: 90,
            borderRadius: 7,
            border: "1.5px solid #1a4060",
            background: CARD_BACK_BG,
            backgroundImage: CARD_BACK_PATTERN,
          }}
        >
          {i === Math.min(count, 6) - 1 && (
            <div
              style={{
                width: 56,
                height: 82,
                margin: 3,
                borderRadius: 3,
                border: "1px solid rgba(255,255,255,0.12)",
                backgroundImage: CARD_BACK_INNER,
              }}
            />
          )}
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          bottom: -22,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 11,
          fontWeight: 600,
          color: "rgba(255,255,255,0.6)",
        }}
      >
        {count}
      </div>
    </div>
  );
}

const FLY_MS = 640;
const LAND_PAUSE_MS = 550;
const BURN_MS = 600;
const PICKUP_MS = 600;
const REVEAL_MS = 900;
const DRAW_MS = 680;
const DRAW_STAGGER_MS = 80;
const END_LINGER_MS = 1800;
const WIN_BANNER_MS = 2800;

interface FlyAnim {
  id: number;
  cards: string[];
  fromPlayer: number;
  playerCount: number;
}

interface BurnAnim {
  id: number;
  cards: string[];
}

interface PickupAnim {
  id: number;
  cards: string[];
  toPlayer: number;
  playerCount: number;
  hideFaces: boolean;
}

interface DrawAnim {
  id: number;
  cards: string[];
  toPlayer: number;
  playerCount: number;
}

function splitOpponentSeats(opponentCount: number): { left: number[]; top: number[]; right: number[] } {
  if (opponentCount <= 0) return { left: [], top: [], right: [] };
  if (opponentCount === 1) return { left: [], top: [1], right: [] };
  if (opponentCount === 2) return { left: [1], top: [], right: [2] };
  if (opponentCount === 3) return { left: [1], top: [2], right: [3] };
  return { left: [1], top: [2, 3], right: [4] };
}

function flyOrigin(playerIndex: number, playerCount: number): { x: string; y: string; rot: number } {
  if (playerIndex === 0) return { x: "0px", y: "36%", rot: -8 };
  const seats = splitOpponentSeats(playerCount - 1);
  if (seats.left.includes(playerIndex)) return { x: "-36%", y: "0%", rot: -12 };
  if (seats.right.includes(playerIndex)) return { x: "36%", y: "0%", rot: 12 };
  const tops = seats.top;
  const i = Math.max(0, tops.indexOf(playerIndex));
  const x = tops.length <= 1 ? 0 : -14 + (28 / Math.max(1, tops.length - 1)) * i;
  return { x: `${x}%`, y: "-30%", rot: 6 + i * 3 };
}

function BurnPile({ count }: { count: number }) {
  return (
    <div style={{ position: "relative", width: 64, height: 90 }}>
      {count === 0 ? (
        <div
          style={{
            width: 64,
            height: 90,
            borderRadius: 7,
            border: "2px dashed rgba(255,255,255,0.22)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.35)",
            fontSize: 10,
            textAlign: "center",
            padding: 4,
          }}
        >
          Burn
        </div>
      ) : (
        [...Array(Math.min(count, 5))].map((_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              top: -i * 1.5,
              left: i * 0.5,
              width: 64,
              height: 90,
              borderRadius: 7,
              border: "1.5px solid #4a3728",
              background: "#5d4037",
              backgroundImage:
                "repeating-linear-gradient(-45deg, transparent, transparent 5px, rgba(0,0,0,0.12) 5px, rgba(0,0,0,0.12) 10px)",
            }}
          />
        ))
      )}
    </div>
  );
}

function countTopSevens(discard: string[]): number {
  let n = 0;
  for (let i = discard.length - 1; i >= 0; i--) {
    if (getRank(discard[i]) === "7") n++;
    else break;
  }
  return n;
}

function DiscardPile({ cards }: { cards: string[] }) {
  const top = cards.length > 0 ? cards[cards.length - 1] : null;
  const effective = getEffectiveTop(cards);
  const sevens = countTopSevens(cards);
  const peeking = sevens > 0 && !!effective && getRank(top!) === "7";
  const underNormal = !peeking && cards.length > 1 ? cards[cards.length - 2] : null;

  return (
    <div style={{ position: "relative", width: 72, height: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {peeking && effective && (
        <>
          <PlayingCard
            card={effective}
            faceVisible
            style={{ top: 8, left: 4, transform: "rotate(-8deg)" }}
          />
          {Array.from({ length: Math.min(sevens, 2) }, (_, i) => {
            const start = cards.length - sevens;
            const card = cards[start + (sevens - Math.min(sevens, 2)) + i];
            return (
              <div key={`7wrap-${i}-${card}`} style={{ position: "absolute", inset: 0 }}>
                <PlayingCard
                  card={card}
                  faceVisible
                  style={{
                    top: 8 - i * 2,
                    left: 10 + i * 4,
                    opacity: 0.55,
                    border: "1.5px dashed #8e44ad",
                    transform: `rotate(${4 + i * 3}deg)`,
                  }}
                />
              </div>
            );
          })}
          <div
            style={{
              position: "absolute",
              top: -26,
              left: "50%",
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
              padding: "2px 8px",
              borderRadius: 8,
              background: "rgba(0,0,0,0.55)",
              color: "#fff",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Under 7: {getRank(effective)}
            {effective.slice(-1)}
          </div>
        </>
      )}

      {!peeking && underNormal && (
        <PlayingCard card={underNormal} faceVisible style={{ top: 5, left: 2, transform: "rotate(-6deg)" }} />
      )}
      {!peeking && top && (
        <PlayingCard card={top} faceVisible style={{ top: 8, left: 8 }} />
      )}

      {!top && (
        <div
          style={{
            width: 64,
            height: 90,
            borderRadius: 7,
            border: "2px dashed rgba(255,255,255,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.4)",
            fontSize: 11,
          }}
        >
          Discard
        </div>
      )}

      {cards.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: -4,
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 11,
            fontWeight: 600,
            color: "rgba(255,255,255,0.6)",
          }}
        >
          {cards.length}
        </div>
      )}
    </div>
  );
}

function measureFlyPath(overlay: HTMLElement, fromPlayer: number) {
  const box = overlay.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const fromEl =
    document.querySelector(`[data-hand-fan="${fromPlayer}"]`) ||
    document.querySelector(`[data-player-hand="${fromPlayer}"]`);
  const toEl = document.querySelector("[data-discard-pile]");
  const fromR = fromEl?.getBoundingClientRect();
  const toR = toEl?.getBoundingClientRect();
  const fallback = flyOrigin(fromPlayer, 5);
  const fx = fromR ? fromR.left + fromR.width / 2 - cx : fromPlayer === 0 ? box.height * 0.02 : 0;
  const fy = fromR
    ? fromR.top + fromR.height / 2 - cy
    : fromPlayer === 0
      ? box.height * 0.36
      : -box.height * 0.28;
  const tx = toR ? toR.left + toR.width / 2 - cx : 0;
  const ty = toR ? toR.top + toR.height / 2 - cy : 0;
  return {
    fx: `${Math.round(fx)}px`,
    fy: `${Math.round(fy)}px`,
    tx: `${Math.round(tx)}px`,
    ty: `${Math.round(ty)}px`,
    mx: `${Math.round((fx + tx) / 2)}px`,
    my: `${Math.round((fy + ty) / 2 - 56)}px`,
    rot: fallback.rot,
  };
}

function FlyOverlay({ anim }: { anim: FlyAnim }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<{
    fx: string;
    fy: string;
    tx: string;
    ty: string;
    mx: string;
    my: string;
    rot: number;
  } | null>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    setPath(measureFlyPath(overlay, anim.fromPlayer));
  }, [anim.id, anim.fromPlayer]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {path &&
        anim.cards.map((card, i) => {
          const spread = (i - (anim.cards.length - 1) / 2) * 14;
          const rot = path.rot + i * 4;
          return (
            <div
              key={`${anim.id}-${i}-${card}`}
              className="card-fly"
              style={{
                ["--fx" as string]: `calc(${path.fx} + ${spread}px)`,
                ["--fy" as string]: path.fy,
                ["--tx" as string]: `calc(${path.tx} + ${spread * 0.25}px)`,
                ["--ty" as string]: path.ty,
                ["--mx" as string]: `calc(${path.mx} + ${spread * 0.6}px)`,
                ["--my" as string]: path.my,
                ["--fr" as string]: `${rot}deg`,
                ["--mr" as string]: `${Math.round(rot * 0.35)}deg`,
                position: "absolute",
                width: 56,
                height: 78,
                animationDelay: `${i * 55}ms`,
                zIndex: 50 + i,
              }}
            >
              <PlayingCard card={card} faceVisible style={{ top: 0, left: 0 }} />
            </div>
          );
        })}
    </div>
  );
}

function BurnOverlay({ anim }: { anim: BurnAnim }) {
  const visible = anim.cards.slice(-6);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 55,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {visible.map((card, i) => (
        <div
          key={`${anim.id}-burn-${i}-${card}`}
          className="card-fly-burn"
          style={{
            ["--bx" as string]: `calc(12% + ${i * 3}px)`,
            ["--by" as string]: `${-6 + i * 2}px`,
            position: "absolute",
            width: 56,
            height: 78,
            animationDelay: `${i * 35}ms`,
            zIndex: 55 + i,
          }}
        >
          <PlayingCard card={card} faceVisible style={{ top: 0, left: 0 }} />
        </div>
      ))}
    </div>
  );
}

function PickupOverlay({ anim }: { anim: PickupAnim }) {
  const dest = flyOrigin(anim.toPlayer, anim.playerCount);
  const visible = anim.cards.slice(-8);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 55,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {visible.map((card, i) => (
        <div
          key={`${anim.id}-pick-${i}-${card}`}
          className="card-fly-pickup"
          style={{
            ["--px" as string]: `calc(${dest.x} + ${(i - visible.length / 2) * 8}px)`,
            ["--py" as string]: dest.y,
            ["--pr" as string]: `${dest.rot}deg`,
            position: "absolute",
            width: 56,
            height: 78,
            animationDelay: `${i * 40}ms`,
            zIndex: 55 + i,
          }}
        >
          <PlayingCard
            card={card}
            faceVisible={!anim.hideFaces}
            style={{ top: 0, left: 0 }}
          />
        </div>
      ))}
    </div>
  );
}

function measureDrawPath(overlay: HTMLElement, toPlayer: number) {
  const box = overlay.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const deck = document.querySelector("[data-deck-pile]")?.getBoundingClientRect();
  const dest =
    document.querySelector(`[data-hand-fan="${toPlayer}"]`)?.getBoundingClientRect() ??
    document.querySelector(`[data-player-hand="${toPlayer}"]`)?.getBoundingClientRect();
  const fromX = deck ? deck.left + deck.width / 2 - cx : -box.width * 0.16;
  const fromY = deck ? deck.top + deck.height / 2 - cy : 0;
  const toX = dest ? dest.left + dest.width / 2 - cx : 0;
  const toY = dest
    ? dest.top + dest.height / 2 - cy
    : toPlayer === 0
      ? box.height * 0.4
      : -box.height * 0.28;
  return {
    dx: `${Math.round(fromX)}px`,
    dy: `${Math.round(fromY)}px`,
    px: `${Math.round(toX)}px`,
    py: `${Math.round(toY)}px`,
  };
}

function DrawOverlay({ anim }: { anim: DrawAnim }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<{ dx: string; dy: string; px: string; py: string } | null>(null);
  const flip = anim.toPlayer === 0;

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    setPath(measureDrawPath(overlay, anim.toPlayer));
  }, [anim.id, anim.toPlayer]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 54,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {path &&
        anim.cards.map((card, i) => (
          <div
            key={`${anim.id}-draw-${i}-${card}`}
            className="card-fly-draw"
            style={{
              ["--dx" as string]: path.dx,
              ["--dy" as string]: path.dy,
              ["--px" as string]: `calc(${path.px} + ${(i - (anim.cards.length - 1) / 2) * 12}px)`,
              ["--py" as string]: path.py,
              ["--pr" as string]: `${(flip ? -8 : 10) + i * 4}deg`,
              position: "absolute",
              width: 56,
              height: 78,
              perspective: 800,
              animationDelay: `${i * DRAW_STAGGER_MS}ms`,
              zIndex: 54 + i,
            }}
          >
            {flip ? (
              <div
                className="card-draw-reveal"
                style={{
                  width: "100%",
                  height: "100%",
                  animationDelay: `${i * DRAW_STAGGER_MS}ms`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    backfaceVisibility: "hidden",
                    WebkitBackfaceVisibility: "hidden",
                  }}
                >
                  <PlayingCard card={card} faceVisible style={{ top: 0, left: 0 }} />
                </div>
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    backfaceVisibility: "hidden",
                    WebkitBackfaceVisibility: "hidden",
                    transform: "rotateY(180deg)",
                  }}
                >
                  <PlayingCard card={card} faceVisible={false} style={{ top: 0, left: 0 }} />
                </div>
              </div>
            ) : (
              <PlayingCard card={card} faceVisible={false} style={{ top: 0, left: 0 }} />
            )}
          </div>
        ))}
    </div>
  );
}

function WinnerOverlay({
  name,
  avatar,
  you,
  onDismiss,
}: {
  name: string;
  avatar?: string;
  you: boolean;
  onDismiss: () => void;
}) {
  const colors = ["#f1c40f", "#fdebd0", "#ffffff", "#2ecc71", "#e67e22", "#f8e6a0"];
  const bits = Array.from({ length: 24 }, (_, i) => ({
    left: `${(i * 17 + 9) % 94}%`,
    delay: `${(i % 8) * 0.07}s`,
    dur: `${1.65 + (i % 5) * 0.2}s`,
    dx: `${((i * 13) % 72) - 36}px`,
    rot: `${200 + (i % 7) * 80}deg`,
    color: colors[i % colors.length],
    w: i % 3 === 0 ? 10 : 7,
    h: i % 4 === 0 ? 16 : 8,
    round: i % 2 === 0,
  }));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        overflow: "hidden",
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {bits.map((b, i) => (
        <span
          key={i}
          className="winner-confetti"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: b.w,
            height: b.h,
            borderRadius: b.round ? 99 : 2,
            background: b.color,
            boxShadow: "0 0 6px rgba(241,196,15,0.35)",
            ["--cx" as string]: b.left,
            ["--cdx" as string]: b.dx,
            ["--crot" as string]: b.rot,
            ["--cdur" as string]: b.dur,
            ["--cdelay" as string]: b.delay,
          }}
        />
      ))}
      <div
        className="winner-burst"
        style={{
          position: "absolute",
          width: 220,
          height: 220,
          borderRadius: 110,
          background: "radial-gradient(circle, rgba(241,196,15,0.45) 0%, transparent 70%)",
        }}
      />
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss winner"
        className="winner-banner"
        style={{
          position: "relative",
          zIndex: 1,
          pointerEvents: "auto",
          minWidth: 200,
          maxWidth: "86%",
          padding: "18px 22px 14px",
          borderRadius: 16,
          border: "1.5px solid rgba(241,196,15,0.75)",
          background: "linear-gradient(180deg, rgba(26,43,26,0.94), rgba(16,32,18,0.96))",
          boxShadow: "0 16px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.08) inset",
          color: "#f5f0e6",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: "#f1c40f",
          }}
        >
          1st place
        </div>
        <AvatarBubble src={avatar} name={name} size={56} />
        <div
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 28,
            fontWeight: 700,
            lineHeight: 1.1,
            textAlign: "center",
          }}
        >
          {you ? "You win!" : `${name} wins!`}
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)" }}>Tap to continue</div>
      </button>
    </div>
  );
}

function FinishedLobbyOverlay({ onLobby }: { onLobby: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: "max(64px, calc(env(safe-area-inset-bottom) + 58px))",
        transform: "translateX(-50%)",
        zIndex: 85,
        pointerEvents: "auto",
      }}
    >
      <button
        type="button"
        className="lobby-play-btn"
        onClick={onLobby}
        style={{
          ...LOBBY_GOLD_BTN,
          width: 148,
          height: 44,
          maxWidth: 148,
        }}
      >
        Lobby
      </button>
    </div>
  );
}

function RevealOverlay({ card }: { card: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          padding: "4px 12px",
          borderRadius: 8,
          background: "rgba(0,0,0,0.65)",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        Your card
      </div>
      <div className="card-reveal" style={{ position: "relative", width: 64, height: 90 }}>
        <PlayingCard card={card} faceVisible style={{ top: 0, left: 0 }} />
      </div>
    </div>
  );
}

function AvatarBubble({
  src,
  name,
  size = 36,
  onClick,
}: {
  src?: string;
  name?: string;
  size?: number;
  onClick?: () => void;
}) {
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const inner = src ? (
    <img src={src} alt="" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  ) : (
    <span style={{ fontWeight: 800, fontSize: Math.round(size * 0.42), color: "#1a2e1a", lineHeight: 1 }}>{letter}</span>
  );
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size / 2,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: src ? "#145230" : "#f1c40f",
    border: "1.5px solid rgba(255,255,255,0.4)",
    padding: 0,
    flexShrink: 0,
    cursor: onClick ? "pointer" : "default",
    boxShadow: "0 2px 8px rgba(0,0,0,0.28)",
  };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={style} aria-label="Profile">
        {inner}
      </button>
    );
  }
  return <div style={style}>{inner}</div>;
}

// Publishable key is public. Prefer the baked key so a leftover localStorage value cannot hide it.
const DEFAULT_CLERK_PK = "pk_live_Y2xlcmsuY2l0cm9ucy5sYXQk";

function isClerkPk(value: unknown): value is string {
  return typeof value === "string" && /^pk_(test|live)_/.test(value) && value.length > 20;
}

function clerkPublishableKey(): string {
  if (typeof window !== "undefined") {
    const w = window as unknown as { CLERK_PK?: string };
    if (isClerkPk(w.CLERK_PK)) return w.CLERK_PK;
  }
  return DEFAULT_CLERK_PK;
}

function clerkFrontendHost(pk: string): string {
  try {
    const part = pk.split("_")[2] || "";
    return atob(part).replace(/\$+$/g, "");
  } catch {
    return "";
  }
}

function clerkPortalOrigin(pk: string): string {
  const host = clerkFrontendHost(pk);
  if (!host) return "";
  if (host.endsWith(".clerk.accounts.dev")) {
    return `https://${host.replace(".clerk.accounts.dev", ".accounts.dev")}`;
  }
  if (host.startsWith("clerk.")) {
    return `https://${host.replace(/^clerk\./, "accounts.")}`;
  }
  return host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host}`;
}

function clerkSignInUrl(): string {
  const origin = clerkPortalOrigin(clerkPublishableKey());
  return origin ? `${origin}/sign-in` : "";
}

function clerkSignUpUrl(): string {
  const origin = clerkPortalOrigin(clerkPublishableKey());
  return origin ? `${origin}/sign-up` : "";
}

function appUrl(): string {
  if (typeof window === "undefined") return "";
  const u = new URL(window.location.href);
  if (u.hostname === "citrons.lat" || u.hostname === "www.citrons.lat") u.protocol = "https:";
  let path = u.pathname || "/";
  const last = path.split("/").pop() || "";
  if (!path.endsWith("/") && !last.includes(".")) path += "/";
  return `${u.origin}${path}`;
}

function isClerkCallbackUrl(href: string): boolean {
  return /__clerk|rotating_token_nonce|clerk_status|created_session/.test(href);
}

async function activateClerkSession(clerk: any, fromCallback = false): Promise<void> {
  const tryActive = async (sessionId: unknown) => {
    if (clerk.user) return;
    const id = typeof sessionId === "string" && sessionId ? sessionId : "";
    if (!id || typeof clerk.setActive !== "function") return;
    try {
      await clerk.setActive({ session: id });
    } catch {
      /* session may already be active or expired */
    }
  };

  const signIn = clerk.client?.signIn;
  const signUp = clerk.client?.signUp;
  await tryActive(signIn?.createdSessionId);
  await tryActive(signUp?.createdSessionId);
  await tryActive(clerk.session?.id);
  await tryActive(clerk.client?.lastActiveSessionId);
  const sessions = clerk.client?.sessions;
  if (Array.isArray(sessions) && sessions[0]?.id) await tryActive(sessions[0].id);
  if (clerk.user) return;

  const transferable =
    signIn?.firstFactorVerification?.status === "transferable" ||
    signIn?.verifications?.externalAccount?.status === "transferable";
  if (transferable && signUp && typeof signUp.create === "function") {
    try {
      await signUp.create({ transfer: true });
      await tryActive(signUp.createdSessionId);
    } catch {
      /* captcha or missing fields */
    }
  }
  if (clerk.user) return;

  if (!fromCallback || typeof clerk.handleRedirectCallback !== "function") return;
  try {
    await clerk.handleRedirectCallback({
      afterSignInUrl: appUrl(),
      afterSignUpUrl: appUrl(),
      continueSignUpUrl: appUrl(),
      signInFallbackRedirectUrl: appUrl(),
      signUpFallbackRedirectUrl: appUrl(),
    });
  } catch {
    /* load() may already consume the callback */
  }
  await tryActive(clerk.client?.signIn?.createdSessionId);
  await tryActive(clerk.client?.signUp?.createdSessionId);
}

function loadScriptOnce(src: string, attrs?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const found = [...document.scripts].find((s) => s.src === src);
    if (found) {
      if ((found as HTMLScriptElement & { _citronsLoaded?: boolean })._citronsLoaded) {
        resolve();
        return;
      }
      found.addEventListener("load", () => resolve());
      found.addEventListener("error", () => reject(new Error("script")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    if (attrs) for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = () => {
      (s as HTMLScriptElement & { _citronsLoaded?: boolean })._citronsLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error(`Clerk failed to load (${src})`));
    document.head.appendChild(s);
  });
}

let clerkPromise: Promise<any> | null = null;

async function ensureClerk(): Promise<any> {
  if (clerkPromise) return clerkPromise;
  clerkPromise = (async () => {
    const pk = clerkPublishableKey();
    if (!pk) {
      const err = new Error("NO_PK");
      throw err;
    }
    const w = window as any;
    const callbackHref = window.location.href;
    if (w.Clerk && typeof w.Clerk.load === "function" && typeof w.Clerk !== "function") {
      if (!w.Clerk.loaded) {
        await w.Clerk.load({
          signInUrl: clerkSignInUrl() || undefined,
          signUpUrl: clerkSignUpUrl() || undefined,
          afterSignInUrl: appUrl(),
          afterSignUpUrl: appUrl(),
          afterSignOutUrl: appUrl(),
          allowedRedirectOrigins: ["https://citrons.lat", "https://www.citrons.lat", "https://identity1211.github.io"],
        });
      }
      const fromCallback = isClerkCallbackUrl(callbackHref);
      if (fromCallback || !w.Clerk.user) {
        await activateClerkSession(w.Clerk, fromCallback);
      }
      return w.Clerk;
    }
    const host = clerkFrontendHost(pk);
    const clerkSrc = host
      ? `https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
      : "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
    await loadScriptOnce(clerkSrc, { "data-clerk-publishable-key": pk });
    let clerk = w.Clerk;
    if (typeof clerk === "function") clerk = new clerk(pk);
    if (!clerk || typeof clerk.load !== "function") throw new Error("Clerk failed to load");
    await clerk.load({
      signInUrl: clerkSignInUrl() || undefined,
      signUpUrl: clerkSignUpUrl() || undefined,
      afterSignInUrl: appUrl(),
      afterSignUpUrl: appUrl(),
      afterSignOutUrl: appUrl(),
      allowedRedirectOrigins: ["https://citrons.lat", "https://www.citrons.lat", "https://identity1211.github.io"],
    });
    w.Clerk = clerk;
    const fromCallback = isClerkCallbackUrl(callbackHref);
    if (fromCallback || !clerk.user) {
      await activateClerkSession(clerk, fromCallback);
    }
    if (clerk.user && isClerkCallbackUrl(window.location.href)) {
      try {
        window.history.replaceState({}, "", appUrl());
      } catch {
        /* ignore */
      }
    }
    return clerk;
  })().catch((err) => {
    clerkPromise = null;
    throw err;
  });
  return clerkPromise;
}

function clerkNickname(user: any): string {
  const meta = (user && user.unsafeMetadata) || {};
  const email =
    user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || "";
  const local = String(email).includes("@") ? String(email).split("@")[0] : "";
  const raw = meta.nickname || user?.firstName || user?.username || local || "Player";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 18) || "Player";
}

function clerkErrorText(err: any): string {
  if (!err) return "Clerk error";
  if (err.message === "NO_PK") {
    return "Couldn't sign in. Refresh the page and try again.";
  }
  const clerkMsg = err.errors?.[0]?.longMessage || err.errors?.[0]?.message;
  return String(clerkMsg || err.message || err);
}

function clerkPortalHref(path: "sign-in" | "sign-up"): string {
  const origin = clerkPortalOrigin(clerkPublishableKey());
  if (!origin) return "";
  const dest = encodeURIComponent(appUrl());
  const qs = `redirect_url=${dest}&after_sign_in_url=${dest}&after_sign_up_url=${dest}`;
  return `${origin}/${path}?${qs}#/?${qs}`;
}

async function signInWithGoogle(): Promise<void> {
  const dest = appUrl();
  try {
    const clerk = await ensureClerk();
    const signIn = clerk.client?.signIn;
    if (signIn && typeof signIn.authenticateWithRedirect === "function") {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: dest,
        redirectUrlComplete: dest,
      });
      return;
    }
  } catch {
    /* hosted Account Portal */
  }
  const href = clerkPortalHref("sign-in");
  if (!href) throw new Error("Google sign-in is unavailable");
  window.location.assign(href);
}

function useClerkAuth() {
  const [loaded, setLoaded] = useState(() => !clerkPublishableKey());
  const [user, setUser] = useState<any>(null);
  const [error, setError] = useState(() =>
    clerkPublishableKey() ? "" : clerkErrorText(new Error("NO_PK"))
  );

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    if (!clerkPublishableKey()) {
      setLoaded(true);
      setError(clerkErrorText(new Error("NO_PK")));
      return;
    }
    void (async () => {
      try {
        const clerk = await ensureClerk();
        if (cancelled) return;
        const sync = (payload?: { user?: any }) => {
          const u = payload?.user !== undefined ? payload.user : clerk.user || null;
          setUser(u);
          setLoaded(true);
          setError("");
          if (u) {
            try {
              localStorage.setItem(NAME_KEY, clerkNickname(u));
            } catch {
              /* ignore */
            }
          }
        };
        sync();
        if (typeof clerk.addListener === "function") unsub = clerk.addListener(sync);
        if (!clerk.user) {
          window.setTimeout(() => {
            if (!cancelled) sync();
          }, 400);
        }
      } catch (e) {
        if (cancelled) return;
        setLoaded(true);
        setUser(null);
        setError(clerkErrorText(e));
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);

  return { loaded, user, error };
}

const PROFILE_PANEL: CSSProperties = {
  width: "min(320px, 100%)",
  maxHeight: "100%",
  boxSizing: "border-box",
  margin: "auto",
  borderRadius: 14,
  background: "#145230",
  border: "1.5px solid rgba(255,255,255,0.22)",
  boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
  padding: "12px 14px 10px",
  color: "#f5f0e6",
  textAlign: "center",
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
};

const PROFILE_GHOST: CSSProperties = {
  width: "100%",
  height: 36,
  borderRadius: 8,
  border: "1.5px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "#f5f0e6",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
};

function ProfileButton() {
  const { loaded, user, error } = useClerkAuth();
  const [open, setOpen] = useState(false);
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (user) setNick(clerkNickname(user));
  }, [user]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(clerkErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  const nickName = user ? clerkNickname(user) : "Sign in";

  return (
    <>
      <div
        style={{
          position: "absolute",
          top: FELT_INSET_TOP,
          right: FELT_INSET_RIGHT,
          zIndex: 20,
          pointerEvents: "auto",
        }}
      >
        {user ? (
          <AvatarBubble src={user.imageUrl} name={nickName} size={40} onClick={() => setOpen(true)} />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{
              ...LOBBY_CORNER_BTN,
              position: "static",
              left: "auto",
              top: "auto",
              background: "#f1c40f",
              color: "#1a2e1a",
              border: "none",
              boxShadow: "0 4px 12px rgba(0,0,0,0.28)",
            }}
          >
            {loaded ? "Sign in" : "…"}
          </button>
        )}
      </div>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 80,
            pointerEvents: "auto",
            background: "rgba(0,0,0,0.48)",
            display: "flex",
            alignItems: "stretch",
            justifyContent: "center",
            overflow: "auto",
            padding: "max(8px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left))",
            boxSizing: "border-box",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={PROFILE_PANEL}
          >
            <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Profile
            </div>
            {user ? (
              <>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                  <AvatarBubble src={user.imageUrl} name={nickName} size={56} />
                </div>
                <input
                  value={nick}
                  onChange={(e) => setNick(e.target.value.slice(0, 18))}
                  placeholder="Nickname"
                  maxLength={18}
                  style={{ ...LOBBY_INPUT, maxWidth: "100%", height: 38, margin: "0 auto 6px", fontSize: 16 }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const next = nick.replace(/\s+/g, " ").trim().slice(0, 18) || "Player";
                      await user.update({
                        unsafeMetadata: { ...(user.unsafeMetadata || {}), nickname: next },
                      });
                      setNick(next);
                      try {
                        localStorage.setItem(NAME_KEY, next);
                      } catch {
                        /* ignore */
                      }
                      setMsg("Nickname saved");
                    })
                  }
                  style={{ ...LOBBY_GOLD_BTN, maxWidth: "100%", height: 36, fontSize: 14, marginBottom: 8 }}
                >
                  {busy ? "Saving…" : "Save nickname"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  style={PROFILE_GHOST}
                >
                  Upload photo
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files && e.target.files[0];
                    e.target.value = "";
                    if (!file) return;
                    if (file.size > 8 * 1024 * 1024) {
                      setMsg("File is larger than 8 MB");
                      return;
                    }
                    void run(async () => {
                      await user.setProfileImage({ file });
                      setMsg("Avatar updated");
                    });
                  }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const clerk = await ensureClerk();
                      const after = appUrl();
                      await clerk.signOut({ redirectUrl: after });
                      setOpen(false);
                      if (!window.location.href.startsWith(after)) {
                        window.location.replace(after);
                      }
                    })
                  }
                  style={{ ...PROFILE_GHOST, marginTop: 6, opacity: 0.85 }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.4, color: "rgba(255,255,255,0.72)", marginBottom: 12 }}>
                  Sign in with Google to save your nickname and avatar.
                </div>
                <button
                  type="button"
                  disabled={busy || !loaded}
                  onClick={() =>
                    run(async () => {
                      await signInWithGoogle();
                    })
                  }
                  style={{ ...LOBBY_GOLD_BTN, maxWidth: "100%", height: 40, fontSize: 15 }}
                >
                  {busy ? "Opening Google…" : "Sign in with Google"}
                </button>
              </>
            )}
            {(msg || (!user && error)) && (
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.35, color: msg ? "#d5f5e3" : "#f5b7b1" }}>
                {msg || error}
              </div>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ ...PROFILE_GHOST, marginTop: 8, height: 32, fontSize: 13 }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function SeatLabel({
  name,
  avatar,
  isHuman,
  ready,
  isTurn,
  place,
  offline,
}: {
  name: string;
  avatar?: string;
  isHuman: boolean;
  ready?: boolean;
  isTurn?: boolean;
  place?: number | null;
  offline?: boolean;
}) {
  const theme = useHostTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <AvatarBubble src={avatar} name={name} size={22} />
      <div
        style={{
          padding: "2px 10px",
          borderRadius: 12,
          background: isTurn
            ? "rgba(241,196,15,0.9)"
            : isHuman
              ? theme.fill.secondary
              : "rgba(255,255,255,0.12)",
          border: `1px solid ${
            isTurn ? "#f39c12" : isHuman ? theme.stroke.focused : "rgba(255,255,255,0.2)"
          }`,
          fontSize: 11,
          fontWeight: 600,
          color: isTurn ? "#222" : isHuman ? theme.text.primary : "#fff",
          opacity: place || offline ? 0.55 : 1,
        }}
      >
        {offline ? `${name} · offline` : name}
      </div>
      {ready && (
        <div
          style={{
            padding: "2px 8px",
            borderRadius: 10,
            background: "#27ae60",
            fontSize: 10,
            fontWeight: 700,
            color: "#fff",
          }}
        >
          Ready
        </div>
      )}
      {place != null && place > 0 && (
        <div
          style={{
            padding: "2px 8px",
            borderRadius: 10,
            background: place === 1 ? "#f1c40f" : "rgba(255,255,255,0.2)",
            fontSize: 10,
            fontWeight: 700,
            color: place === 1 ? "#222" : "#fff",
          }}
        >
          #{place}
        </div>
      )}
    </div>
  );
}

function SwapTimer({ seconds }: { seconds: number }) {
  const urgent = seconds <= 5;
  return (
    <div
      className={urgent ? "timer-urgent" : undefined}
      style={{
        width: 88,
        height: 88,
        borderRadius: 44,
        background: "rgba(0,0,0,0.45)",
        border: `3px solid ${urgent ? "#e74c3c" : "rgba(255,255,255,0.35)"}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1, color: urgent ? "#e74c3c" : "#fff" }}>
        {seconds}
      </div>
      <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>sec</div>
    </div>
  );
}

// ─── Rules / Lobby ───────────────────────────────────────────────────────────

const FELT_BG =
  "linear-gradient(165deg, #145230 0%, #1a6b3c 38%, #0f3d24 100%)";
const FELT_TEXTURE =
  "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px), repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(255,255,255,0.02) 2px, rgba(255,255,255,0.02) 4px)";
const WOOD_EDGE = "#3e2723";
const PELI_SKIN_SRC = "skins/peli.jpg";

type TableSkinId = "felt" | "peli";

const TABLE_SKINS: { id: TableSkinId; name: string; src?: string }[] = [
  { id: "felt", name: "Felt" },
  { id: "peli", name: "Peli case", src: PELI_SKIN_SRC },
];

function isTableSkin(id: unknown): id is TableSkinId {
  return id === "felt" || id === "peli";
}

function feltShellStyle(skin: TableSkinId): CSSProperties {
  if (skin === "peli") {
    return {
      backgroundColor: "#121212",
      backgroundImage: `url(${PELI_SKIN_SRC})`,
      backgroundSize: "cover",
      backgroundPosition: "center 30%",
      backgroundRepeat: "no-repeat",
      boxShadow: "inset 0 0 0 10px #0a0a0a, inset 0 0 0 12px #2a2a2a",
      ["--felt" as string]: "#1a1a1a",
      ["--wood" as string]: "#0a0a0a",
    };
  }
  return {
    background: FELT_BG,
    backgroundImage: `${FELT_TEXTURE}, ${FELT_BG}`,
    boxShadow: `inset 0 0 0 12px ${WOOD_EDGE}, inset 0 0 0 14px #5d4037`,
    ["--felt" as string]: "#1a6b3c",
    ["--wood" as string]: WOOD_EDGE,
  };
}

function tableBoardStyle(skin: TableSkinId, short: boolean): CSSProperties {
  if (skin === "peli") {
    return {
      backgroundColor: "#141414",
      backgroundImage: `url(${PELI_SKIN_SRC})`,
      backgroundSize: "cover",
      backgroundPosition: "center 28%",
      backgroundRepeat: "no-repeat",
      border: short ? "6px solid #0d0d0d" : "10px solid #0d0d0d",
    };
  }
  return {
    background: "#1a6b3c",
    border: short ? "6px solid #145230" : "10px solid #145230",
  };
}
const LOBBY_FAN: { card: string; rot: number; x: number; y: number; delay: number }[] = [
  { card: "2♦", rot: -28, x: -78, y: 14, delay: 0 },
  { card: "6♠", rot: -14, x: -40, y: 4, delay: 0.07 },
  { card: "7♥", rot: 0, x: 0, y: 0, delay: 0.14 },
  { card: "10♣", rot: 14, x: 40, y: 4, delay: 0.21 },
  { card: "A♠", rot: 28, x: 78, y: 14, delay: 0.28 },
];

function FeltShell({
  children,
  overlay,
  center,
  style,
  skin = "felt",
}: {
  children: ReactNode;
  overlay?: ReactNode;
  center?: boolean;
  style?: CSSProperties;
  skin?: TableSkinId;
}) {
  return (
    <div
      style={{
        minHeight: "100%",
        height: "100%",
        boxSizing: "border-box",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        ...feltShellStyle(skin),
      }}
    >
      {skin === "felt" ? <div className="lobby-felt-glow" /> : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.42)",
            pointerEvents: "none",
          }}
        />
      )}
      <div id="clerk-captcha" style={{ position: "absolute", left: 0, bottom: 0, zIndex: 50 }} />
      {overlay ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 8,
            pointerEvents: "none",
          }}
        >
          {overlay}
        </div>
      ) : null}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          flex: 1,
          minHeight: 0,
          overflowX: "hidden",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: center ? "center" : "flex-start",
          boxSizing: "border-box",
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TableSkinPicker({
  value,
  onChange,
  disabled,
}: {
  value: TableSkinId;
  onChange?: (id: TableSkinId) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ width: "100%", maxWidth: 300 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.62)",
          marginBottom: 8,
          textAlign: "left",
        }}
      >
        Table
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {TABLE_SKINS.map((s) => {
          const on = value === s.id;
          return (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange?.(s.id)}
              style={{
                flex: 1,
                height: 64,
                borderRadius: 10,
                border: on ? "2px solid #f1c40f" : "1.5px solid rgba(255,255,255,0.28)",
                padding: 0,
                overflow: "hidden",
                cursor: disabled ? "default" : "pointer",
                background:
                  s.id === "peli"
                    ? `#1a1a1a url(${PELI_SKIN_SRC}) center 30% / cover no-repeat`
                    : FELT_BG,
                position: "relative",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 8,
                  bottom: 6,
                  color: "#f5f0e6",
                  fontSize: 11,
                  fontWeight: 800,
                  textShadow: "0 1px 4px rgba(0,0,0,0.8)",
                }}
              >
                {s.name}
              </span>
            </button>
          );
        })}
      </div>
      {disabled ? (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 6, textAlign: "left" }}>
          Host chooses the table
        </div>
      ) : null}
    </div>
  );
}

type ChatLine = { id: string; fromId: string; name: string; text: string; at: number };
type ChatToast = { id: string; name: string; text: string; until: number };

function RoomChat({
  lines,
  youId,
  onSend,
  variant,
}: {
  lines: ChatLine[];
  youId?: string;
  onSend: (text: string) => void;
  variant: "lobby" | "table";
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(variant === "lobby");
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seenRef = useRef(0);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const inset = useVisualInset();
  const wasKeyboard = useRef(false);

  useEffect(() => {
    if (open) {
      seenRef.current = lines.length;
      setUnread(0);
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      return;
    }
    const extra = Math.max(0, lines.length - seenRef.current);
    setUnread(extra);
  }, [lines, open]);

  useEffect(() => {
    if (!primedRef.current) {
      primedRef.current = true;
      for (const line of lines) seenIdsRef.current.add(line.id);
      return;
    }
    const fresh = lines.filter((line) => !seenIdsRef.current.has(line.id));
    for (const line of fresh) seenIdsRef.current.add(line.id);
    if (variant !== "table" || open || fresh.length === 0) return;
    const incoming = fresh.filter((line) => !youId || line.fromId !== youId);
    if (incoming.length === 0) return;
    const until = Date.now() + 5000;
    setToasts((prev) =>
      [...prev, ...incoming.map((line) => ({ id: line.id, name: line.name, text: line.text, until }))].slice(-4)
    );
  }, [lines, open, variant, youId]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const tick = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => t.until > now));
    }, 200);
    return () => window.clearInterval(tick);
  }, [toasts.length]);

  useEffect(() => {
    if (open) setToasts([]);
  }, [open]);

  function pinChat() {
    pinLayoutScroll();
    window.setTimeout(pinLayoutScroll, 50);
    window.setTimeout(pinLayoutScroll, 180);
    window.setTimeout(pinLayoutScroll, 400);
  }

  function onComposerFocus() {
    pinChat();
  }

  function onComposerBlur() {
    pinChat();
  }

  useEffect(() => {
    if (variant !== "table") return;
    if (wasKeyboard.current && !inset.keyboard) pinChat();
    wasKeyboard.current = inset.keyboard;
  }, [inset.keyboard, variant]);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  const log = (
    <div
      ref={logRef}
      style={{
        height: variant === "lobby" ? 112 : undefined,
        flex: variant === "table" ? 1 : undefined,
        minHeight: variant === "table" ? 48 : undefined,
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        padding: "6px 8px",
        background: "rgba(0,0,0,0.28)",
        borderRadius: variant === "lobby" ? 8 : "0",
        textAlign: "left",
      }}
    >
      {lines.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, lineHeight: 1.4 }}>
          {variant === "lobby" ? "Say hi before the game starts." : "Table chat"}
        </div>
      ) : (
        lines.map((line) => {
          const mine = !!youId && line.fromId === youId;
          return (
            <div key={line.id} style={{ marginBottom: 5, lineHeight: 1.3 }}>
              <span style={{ color: mine ? "#f1c40f" : "rgba(255,255,255,0.62)", fontSize: 11, fontWeight: 800 }}>
                {mine ? "You" : line.name}
              </span>
              <span style={{ color: "#f5f0e6", fontSize: 12 }}> {line.text}</span>
            </div>
          );
        })
      )}
    </div>
  );

  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ display: "flex", gap: 6, marginTop: variant === "lobby" ? 6 : 0, flexShrink: 0 }}
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, 120))}
        onFocus={onComposerFocus}
        onBlur={onComposerBlur}
        placeholder="Message"
        maxLength={120}
        autoComplete="off"
        autoCorrect="off"
        enterKeyHint="send"
        inputMode="text"
        style={{
          flex: 1,
          height: 36,
          borderRadius: 8,
          border: "1.5px solid rgba(255,255,255,0.22)",
          background: "rgba(0,0,0,0.35)",
          color: "#f5f0e6",
          padding: "0 10px",
          fontSize: 16,
          minWidth: 0,
        }}
      />
      <button
        type="submit"
        className="lobby-ghost-btn"
        style={{
          height: 36,
          padding: "0 12px",
          borderRadius: 8,
          border: "1.5px solid rgba(241,196,15,0.45)",
          background: "rgba(241,196,15,0.18)",
          color: "#f1c40f",
          fontWeight: 800,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Send
      </button>
    </form>
  );

  if (variant === "lobby") {
    return (
      <div style={{ width: "100%", maxWidth: 300 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.3,
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.62)",
            marginBottom: 8,
            textAlign: "left",
          }}
        >
          Chat
        </div>
        {log}
        {composer}
      </div>
    );
  }

  const showToasts = !open && toasts.length > 0;
  const dockWidth = open || showToasts ? Math.min(260, Math.max(168, inset.width - 24)) : undefined;
  const kbOpen = open && inset.keyboard;
  const imePad = !kbOpen ? 0 : inset.android ? (inset.vkH > 80 ? 28 : 80) : 16;
  const panelH = Math.min(260, Math.max(168, inset.height - imePad - 12));
  const kbTop = Math.max(8, inset.height - panelH - imePad);

  return (
    <div
      style={{
        position: "fixed",
        left: kbOpen ? 8 : `max(8px, env(safe-area-inset-left))`,
        top: kbOpen ? kbTop : undefined,
        bottom: kbOpen ? "auto" : "max(64px, calc(env(safe-area-inset-bottom) + 58px))",
        height: kbOpen ? panelH : undefined,
        transform: kbOpen ? `translate3d(${inset.left}px, ${inset.top}px, 0)` : "none",
        zIndex: 120,
        width: dockWidth,
        maxWidth: "min(260px, calc(100% - 16px))",
        maxHeight: open ? (kbOpen ? panelH : 280) : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        pointerEvents: "none",
        boxSizing: "border-box",
      }}
    >
      {showToasts ? (
        <div className="chat-toast-stack" style={{ marginBottom: 6 }}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="chat-toast"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "7px 10px",
                borderRadius: 10,
                background: "rgba(8, 18, 10, 0.92)",
                border: "1px solid rgba(241,196,15,0.4)",
                boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
                textAlign: "left",
              }}
            >
              <div style={{ color: "#f1c40f", fontSize: 10, fontWeight: 800, letterSpacing: 0.4, marginBottom: 2 }}>
                {toast.name}
              </div>
              <div
                style={{
                  color: "#f5f0e6",
                  fontSize: 13,
                  lineHeight: 1.3,
                  overflow: "hidden",
                  maxHeight: 52,
                  overflowWrap: "anywhere",
                }}
              >
                {toast.text}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          pinChat();
        }}
        style={{
          pointerEvents: "auto",
          flexShrink: 0,
          padding: "7px 10px",
          borderRadius: open ? "10px 10px 0 0" : 10,
          border: "1px solid rgba(241,196,15,0.4)",
          borderBottom: open ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(241,196,15,0.4)",
          background: "rgba(8, 18, 10, 0.88)",
          color: "#f1c40f",
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        {open ? "Chat ▾" : unread > 0 ? `Chat · ${unread}` : "Chat"}
      </button>
      {open ? (
        <div
          style={{
            pointerEvents: "auto",
            width: "100%",
            minWidth: 168,
            boxSizing: "border-box",
            borderRadius: "0 10px 10px 10px",
            background: "rgba(8, 18, 10, 0.94)",
            border: "1px solid rgba(241,196,15,0.4)",
            borderTop: "none",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            flex: 1,
            overflow: "hidden",
          }}
        >
          {log}
          {composer}
        </div>
      ) : null}
    </div>
  );
}

const REACT_EMOJIS = [
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
];

type ReactBurst = { id: string; emoji: string; fromId: string };
type EmojiFly = { id: string; emoji: string; x: number; rot: number };

function driftFromId(id: string) {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 33 + id.charCodeAt(i)) | 0;
  return { x: (Math.abs(n) % 72) - 36, rot: (Math.abs(n >> 8) % 44) - 22 };
}

function EmojiDock({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        position: "absolute",
        right: "max(8px, env(safe-area-inset-right))",
        bottom: "max(64px, calc(env(safe-area-inset-bottom) + 56px))",
        zIndex: 88,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        pointerEvents: "auto",
      }}
    >
      {open ? (
        <div
          style={{
            width: 5 * 44,
            padding: "6px 6px",
            borderRadius: 12,
            background: "rgba(8, 18, 10, 0.92)",
            border: "1px solid rgba(241,196,15,0.4)",
            boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
          }}
        >
          <div className="emoji-rail">
            {REACT_EMOJIS.map((face) => {
              const wide = [...face].length >= 3;
              return (
              <button
                key={face}
                type="button"
                onClick={() => onPick(face)}
                aria-label={`React ${face}`}
                style={{
                  width: wide ? 58 : 40,
                  height: 40,
                  borderRadius: 10,
                  border: "none",
                  background: "transparent",
                  fontSize: wide ? 16 : 26,
                  lineHeight: "40px",
                  cursor: "pointer",
                  padding: 0,
                  whiteSpace: "nowrap",
                }}
              >
                {face}
              </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={open ? "Close reactions" : "Reactions"}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          border: "1px solid rgba(241,196,15,0.45)",
          background: "rgba(8, 18, 10, 0.9)",
          color: "#f5f0e6",
          fontSize: 22,
          cursor: "pointer",
          boxShadow: "0 6px 16px rgba(0,0,0,0.3)",
          flexShrink: 0,
        }}
      >
        {open ? "×" : "😂"}
      </button>
    </div>
  );
}

function EmojiFlyLayer({ flies }: { flies: EmojiFly[] }) {
  if (flies.length === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 125,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {flies.map((fly) => (
        <div
          key={fly.id}
          className="emoji-react-fly"
          style={{
            position: "absolute",
            right: 22,
            bottom: 72,
            fontSize: 42,
            lineHeight: 1,
            ["--ex" as string]: `${fly.x}px`,
            ["--ey" as string]: "-78vh",
            ["--erot" as string]: `${fly.rot}deg`,
            textShadow: "0 6px 16px rgba(0,0,0,0.35)",
          }}
        >
          {fly.emoji}
        </div>
      ))}
    </div>
  );
}

function LobbyCardFan() {
  return (
    <div
      className="lobby-fan-wrap"
      style={{
        position: "relative",
        width: "min(320px, 86vw)",
        height: 108,
        margin: "2px 0 0",
        flexShrink: 0,
      }}
      aria-hidden
    >
      {LOBBY_FAN.map((c) => (
        <div
          key={c.card}
          className="lobby-fan-card"
          style={{
            position: "absolute",
            left: "50%",
            top: 6,
            width: 56,
            height: 78,
            marginLeft: -28,
            ["--fan-x" as string]: `${c.x}px`,
            ["--fan-y" as string]: `${c.y}px`,
            ["--fan-rot" as string]: `${c.rot}deg`,
            animationDelay: `${c.delay}s`,
            zIndex: 10 + (30 - Math.abs(c.rot)),
            filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.35))",
          }}
        >
          <PlayingCard card={c.card} faceVisible style={{ top: 0, left: 0, position: "relative" }} />
        </div>
      ))}
    </div>
  );
}

function RuleBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          marginBottom: 6,
          fontSize: 15,
          fontWeight: 700,
          color: "#f5f0e6",
          fontFamily: 'Georgia, "Times New Roman", serif',
          letterSpacing: 0.3,
        }}
      >
        {title}
      </div>
      <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

function RulesScreen({ onBack }: { onBack: () => void }) {
  return (
    <FeltShell
      overlay={
        <>
          <WindowButton />
          <LobbyBack onClick={onBack} />
        </>
      }
      style={{ padding: "max(40px, calc(env(safe-area-inset-top) + 22px)) 20px max(52px, calc(env(safe-area-inset-bottom) + 24px))" }}
    >
      <div style={{ width: "100%", maxWidth: 560, padding: "0 4px" }}>
        <div
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 36,
            fontWeight: 700,
            color: "#f5f0e6",
            marginBottom: 6,
            letterSpacing: 0.5,
          }}
        >
          Rules
        </div>
        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginBottom: 24 }}>
          2–5 players · 52 cards · suits don't matter
        </div>
        <RuleBlock title="Setup">
          <p style={{ margin: "0 0 8px" }}>
            Each player: <b style={{ color: "#fff" }}>3 face-down</b> →{" "}
            <b style={{ color: "#fff" }}>3 face-up</b> on top →{" "}
            <b style={{ color: "#fff" }}>3 in hand</b>.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            20 seconds to swap hand cards with face-up cards. Then Ready. First turn is random.
          </p>
        </RuleBlock>
        <RuleBlock title="Ranking">
          <p style={{ margin: 0, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}>
            {RANK_ORDER.join(" < ")}
          </p>
        </RuleBlock>
        <RuleBlock title="Turn">
          <p style={{ margin: "0 0 8px" }}>
            Play cards of one rank. Hand + face-up combo only if those are your last hand cards and the deck is empty. While the deck remains, draw back up to 3.
          </p>
          <p style={{ margin: "0 0 8px" }}>If you can't play, take the discard pile.</p>
          <p style={{ margin: "0 0 8px" }}>
            If your hand is empty and you play face-up or face-down table cards, you may also take table card(s) into hand with the discard. Matching face-up ranks are taken all at once; a face-down card is taken one at a time.
          </p>
          <p style={{ margin: 0 }}>
            Empty hand and empty deck → face-up cards, then face-down.
          </p>
        </RuleBlock>
        <RuleBlock title="Specials">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b style={{ color: "#fff" }}>2</b> — plays on anything; pile resets to 2</li>
            <li><b style={{ color: "#fff" }}>6</b> — only 6 or lower, or 7. No 10s</li>
            <li><b style={{ color: "#fff" }}>7</b> — transparent</li>
            <li><b style={{ color: "#fff" }}>10</b> — plays on anything except 6; burns the discard</li>
            <li><b style={{ color: "#fff" }}>4 of a kind</b> in a row — burn</li>
          </ul>
        </RuleBlock>
        <RuleBlock title="Winning">
          <p style={{ margin: 0 }}>
            First to empty their cards takes 1st place; everyone else keeps playing until one loser remains.
          </p>
        </RuleBlock>
        <button
          onClick={onBack}
          className="lobby-play-btn"
          style={{
            marginTop: 8,
            padding: "12px 28px",
            borderRadius: 10,
            border: "none",
            background: "#f1c40f",
            color: "#1a2e1a",
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
          }}
        >
          Got it
        </button>
      </div>
    </FeltShell>
  );
}

type LobbyView = "main" | "solo" | "multi" | "board";

const LOBBY_MENU_BTN: CSSProperties = {
  width: "100%",
  maxWidth: 300,
  height: 50,
  borderRadius: 10,
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
};

const LOBBY_GOLD_BTN: CSSProperties = {
  ...LOBBY_MENU_BTN,
  border: "none",
  background: "#f1c40f",
  color: "#1a2e1a",
  boxShadow: "0 6px 16px rgba(0,0,0,0.28)",
};

const LOBBY_GHOST_BTN: CSSProperties = {
  ...LOBBY_MENU_BTN,
  border: "1.5px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "#f5f0e6",
};

const LOBBY_CORNER_BTN: CSSProperties = {
  position: "absolute",
  zIndex: 8,
  padding: "8px 12px",
  minHeight: 36,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.28)",
  background: "rgba(0,0,0,0.35)",
  color: "#f5f0e6",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  touchAction: "manipulation",
  pointerEvents: "auto",
};

const FELT_INSET_TOP = "max(18px, calc(env(safe-area-inset-top) + 4px))";
const FELT_INSET_LEFT = "max(18px, calc(env(safe-area-inset-left) + 4px))";
const FELT_INSET_RIGHT = "max(18px, calc(env(safe-area-inset-right) + 4px))";
const FELT_INSET_BOTTOM = "max(18px, calc(env(safe-area-inset-bottom) + 4px))";

function WindowButton({ style, onClick }: { style?: CSSProperties; onClick?: () => void }) {
  const fsOn = useFullscreen();
  return (
    <button
      type="button"
      onClick={() => {
        if (onClick) onClick();
        else void (fsOn ? exitFullscreen() : enterFullscreen());
      }}
      style={{
        position: "absolute",
        top: FELT_INSET_TOP,
        left: FELT_INSET_LEFT,
        zIndex: 8,
        padding: "2px 0",
        minHeight: 0,
        border: "none",
        background: "transparent",
        color: fsOn ? "#f1c40f" : "rgba(245,240,230,0.88)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.2,
        touchAction: "manipulation",
        pointerEvents: "auto",
        textShadow: "0 1px 3px rgba(0,0,0,0.55)",
        ...style,
      }}
    >
      {fsOn ? "Window" : "Fullscreen"}
    </button>
  );
}

function LobbyBack({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...LOBBY_CORNER_BTN,
        top: "auto",
        left: FELT_INSET_LEFT,
        bottom: FELT_INSET_BOTTOM,
      }}
    >
      {label || "← Main menu"}
    </button>
  );
}

function Lobby({
  onStart,
  onRules,
  onOnline,
}: {
  onStart: (count: number, tutorial?: boolean) => void;
  onRules: () => void;
  onOnline: () => void;
}) {
  const [view, setView] = useState<LobbyView>("main");
  const [selected, setSelected] = useState(4);
  const [popKey, setPopKey] = useState(0);

  function pickCount(n: number) {
    setSelected(n);
    setPopKey((k) => k + 1);
  }

  return (
    <FeltShell
      center
      overlay={
        <>
          <ProfileButton />
          <WindowButton />
          {view === "main" && (
            <div
              className="lobby-fs-hint"
              style={{
                position: "absolute",
                top: "max(36px, calc(env(safe-area-inset-top) + 22px))",
                left: FELT_INSET_LEFT,
                zIndex: 8,
                maxWidth: 148,
                fontSize: 11,
                lineHeight: 1.35,
                color: "rgba(255,255,255,0.55)",
                textAlign: "left",
                pointerEvents: "none",
              }}
            >
              Hides the browser chrome. On iPhone: Share → Add to Home Screen.
            </div>
          )}
          {view !== "main" && <LobbyBack onClick={() => setView("main")} />}
          <div
            className="lobby-edition"
            style={{
              position: "absolute",
              right: "max(16px, env(safe-area-inset-right))",
              bottom: "max(12px, env(safe-area-inset-bottom))",
              zIndex: 2,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 0.5,
              color: "rgba(255,255,255,0.26)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            TwoCircles Edition
          </div>
        </>
      }
      style={{ padding: "max(40px, calc(env(safe-area-inset-top) + 22px)) 16px max(56px, calc(env(safe-area-inset-bottom) + 40px))" }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          padding: "0 8px",
        }}
      >
        <div
          className="lobby-brand-in"
          style={{
            animationDelay: "0.05s",
            flexShrink: 0,
            paddingTop: 12,
            position: "relative",
            zIndex: 1,
          }}
        >
          <div
            className="lobby-title"
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: "clamp(34px, 7.5vh, 64px)",
              fontWeight: 700,
              color: "#f5f0e6",
              letterSpacing: 1,
              lineHeight: 1,
              textShadow: "0 2px 0 rgba(0,0,0,0.25), 0 12px 28px rgba(0,0,0,0.35)",
            }}
          >
            Citrons
          </div>
        </div>

        {view !== "board" && <LobbyCardFan />}

        {view !== "board" && <div style={{ flex: 1, minHeight: 12, width: "100%" }} />}

        <div
          key={view}
          className="lobby-brand-in"
          style={{
            animationDelay: "0.12s",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            flexShrink: view === "board" ? 1 : 0,
            flex: view === "board" ? 1 : undefined,
            minHeight: view === "board" ? 0 : undefined,
            position: "relative",
            zIndex: 3,
            marginTop: view === "board" ? 16 : "auto",
            paddingBottom: 4,
          }}
        >
          {view === "main" && (
            <>
              <button
                type="button"
                className="lobby-play-btn"
                onClick={() => setView("solo")}
                style={LOBBY_GOLD_BTN}
              >
                Solo
              </button>
              <button
                type="button"
                className="lobby-play-btn"
                onClick={onOnline}
                style={LOBBY_GOLD_BTN}
              >
                Multiplayer
              </button>
              <button
                type="button"
                className="lobby-ghost-btn"
                onClick={() => setView("board")}
                style={LOBBY_GHOST_BTN}
              >
                Leaderboard
              </button>
            </>
          )}

          {view === "board" && (
            <>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: "#f5f0e6",
                  fontFamily: 'Georgia, "Times New Roman", serif',
                }}
              >
                Leaderboard
              </div>
              <LeaderboardPanel />
            </>
          )}

          {view === "solo" && (
            <>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,0.55)",
                }}
              >
                Players
              </div>
              <div
                key={popKey}
                style={{
                  display: "inline-flex",
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1.5px solid rgba(255,255,255,0.28)",
                  background: "rgba(0,0,0,0.22)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                }}
              >
                {[2, 3, 4, 5].map((n, i) => {
                  const active = selected === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => pickCount(n)}
                      className={active ? "card-swap-pop" : undefined}
                      style={{
                        width: 52,
                        height: 48,
                        border: "none",
                        borderLeft: i === 0 ? "none" : "1px solid rgba(255,255,255,0.12)",
                        background: active ? "#f1c40f" : "transparent",
                        color: active ? "#1a2e1a" : "rgba(255,255,255,0.88)",
                        fontSize: 18,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 14,
                }}
              >
                <button
                  type="button"
                  className="lobby-ghost-btn"
                  onClick={onRules}
                  style={{
                    padding: "12px 18px",
                    borderRadius: 10,
                    border: "1.5px solid rgba(255,255,255,0.35)",
                    background: "transparent",
                    color: "#f5f0e6",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Rules
                </button>
                <button
                  type="button"
                  className="lobby-ghost-btn"
                  onClick={() => onStart(2, true)}
                  style={{
                    padding: "12px 18px",
                    borderRadius: 10,
                    border: "1.5px solid #f1c40f",
                    background: "transparent",
                    color: "#f1c40f",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Tutorial
                </button>
                <button
                  type="button"
                  className="lobby-play-btn"
                  onClick={() => onStart(selected)}
                  style={{
                    padding: "12px 36px",
                    borderRadius: 10,
                    border: "none",
                    background: "#f1c40f",
                    color: "#1a2e1a",
                    fontSize: 16,
                    fontWeight: 700,
                    cursor: "pointer",
                    boxShadow: "0 6px 16px rgba(0,0,0,0.28)",
                  }}
                >
                  Play
                </button>
              </div>
            </>
          )}

          {view === "multi" && (
            <>
              <button type="button" className="lobby-play-btn" style={LOBBY_GOLD_BTN}>
                Create lobby
              </button>
              <button type="button" className="lobby-play-btn" style={LOBBY_GOLD_BTN}>
                Join lobby
              </button>
            </>
          )}
        </div>
      </div>
    </FeltShell>
  );
}

// ─── Deal helpers ────────────────────────────────────────────────────────────

const DEAL_STEP_MS = 200;

type DealStep =
  | { type: "faceDown"; player: number; slot: number }
  | { type: "faceUp"; player: number; slot: number }
  | { type: "hand"; player: number; slot: number }
  | { type: "done" };

function buildDealSequence(playerCount: number): DealStep[] {
  const steps: DealStep[] = [];
  for (let slot = 0; slot < 3; slot++)
    for (let p = 0; p < playerCount; p++) steps.push({ type: "faceDown", player: p, slot });
  for (let slot = 0; slot < 3; slot++)
    for (let p = 0; p < playerCount; p++) steps.push({ type: "faceUp", player: p, slot });
  for (let slot = 0; slot < 3; slot++)
    for (let p = 0; p < playerCount; p++) steps.push({ type: "hand", player: p, slot });
  steps.push({ type: "done" });
  return steps;
}

function swapPlayerCards(player: PlayerState, handIdx: number, faceUpIdx: number): PlayerState {
  const hand = [...player.hand];
  const faceUp = [...player.faceUp];
  const up = faceUp[faceUpIdx];
  if (up === null) return player;
  const tmp = hand[handIdx];
  hand[handIdx] = up;
  faceUp[faceUpIdx] = tmp;
  return { ...player, hand: sortHand(hand), faceUp };
}

function FeltChip({
  label,
  onClick,
  disabled,
  kind,
  style,
  glow,
}: {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  kind: "play" | "take" | "ready" | "ghost";
  style?: CSSProperties;
  glow?: boolean;
}) {
  const palettes = {
    play: {
      background: disabled
        ? "radial-gradient(circle at 50% 30%, rgba(80,90,50,0.5), rgba(30,40,20,0.55))"
        : "radial-gradient(circle at 50% 28%, #f7dc6f, #c9a227 62%, #9a7b12)",
      color: disabled ? "rgba(255,255,255,0.38)" : "#1d1404",
      border: disabled ? "1.5px solid rgba(255,255,255,0.16)" : "1.5px solid #f8e6a0",
    },
    take: {
      background: disabled
        ? "radial-gradient(circle at 50% 30%, rgba(70,50,40,0.4), rgba(30,20,16,0.5))"
        : "radial-gradient(circle at 50% 28%, #8d6e63, #5d4037 70%, #3e2723)",
      color: disabled ? "rgba(255,255,255,0.32)" : "#f5e6d3",
      border: "1.5px solid rgba(62,39,35,0.95)",
    },
    ready: {
      background: disabled
        ? "radial-gradient(circle at 50% 28%, #27ae60, #1e8449)"
        : "radial-gradient(circle at 50% 28%, #58d68d, #1e8449 70%, #145a32)",
      color: "#fff",
      border: "1.5px solid rgba(171,235,198,0.55)",
    },
    ghost: {
      background: "rgba(0,0,0,0.28)",
      color: "rgba(255,255,255,0.82)",
      border: "1.5px solid rgba(255,255,255,0.28)",
    },
  } as const;
  const pal = palettes[kind];
  return (
    <button
      type="button"
      className={glow ? "felt-chip tut-glow-chip" : "felt-chip"}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 92,
        minHeight: 38,
        padding: "7px 8px",
        borderRadius: 999,
        border: pal.border,
        background: pal.background,
        color: pal.color,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.7,
        textTransform: "uppercase",
        lineHeight: 1.15,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.72 : 1,
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function TutorialBar({
  text,
  showNext,
  showSkip,
  onNext,
  onSkip,
}: {
  text: string;
  showNext: boolean;
  showSkip: boolean;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "max(42px, calc(env(safe-area-inset-top) + 30px))",
        transform: "translateX(-50%)",
        zIndex: 92,
        width: "min(420px, calc(100% - 24px))",
        minWidth: 160,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          padding: "8px 12px 8px",
          borderRadius: 12,
          background: "rgba(8, 18, 10, 0.86)",
          border: "1px solid rgba(241,196,15,0.45)",
          boxShadow: "0 10px 28px rgba(0,0,0,0.38)",
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: "#f1c40f",
            marginBottom: 4,
          }}
        >
          Tutorial
        </div>
        <div style={{ color: "#f5f0e6", fontSize: 13, lineHeight: 1.4, fontWeight: 600 }}>
          {text}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginTop: 8,
          }}
        >
          {showSkip ? (
            <button
              type="button"
              onClick={onSkip}
              style={{
                border: "none",
                background: "transparent",
                color: "rgba(255,255,255,0.55)",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                padding: "4px 0",
              }}
            >
              Skip
            </button>
          ) : (
            <span />
          )}
          {showNext ? (
            <button
              type="button"
              onClick={onNext}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                border: "none",
                background: "#f1c40f",
                color: "#1a2e1a",
                fontSize: 12,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Next
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>
    </div>
  );
}

function SpecialsMemo({ active, drop }: { active?: TutSpecial | null; drop?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      style={{
        position: "absolute",
        top: drop
          ? "max(132px, calc(env(safe-area-inset-top) + 118px))"
          : "max(42px, calc(env(safe-area-inset-top) + 30px))",
        right: FELT_INSET_RIGHT,
        zIndex: 93,
        width: open ? 148 : "auto",
        pointerEvents: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: open ? "100%" : "auto",
          padding: open ? "6px 10px 5px" : "7px 10px",
          borderRadius: open ? "10px 10px 0 0" : 10,
          border: "1px solid rgba(241,196,15,0.4)",
          borderBottom: open ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(241,196,15,0.4)",
          background: "rgba(8, 18, 10, 0.88)",
          color: "#f1c40f",
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {open ? "Specials ▾" : "Specials"}
      </button>
      {open ? (
        <div
          style={{
            padding: "6px 8px 8px",
            borderRadius: "0 0 10px 10px",
            background: "rgba(8, 18, 10, 0.88)",
            border: "1px solid rgba(241,196,15,0.4)",
            borderTop: "none",
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          {SPECIALS_MEMO.map((row) => {
            const on = active === row.id;
            return (
              <div
                key={row.id}
                style={{
                  padding: "5px 6px",
                  borderRadius: 7,
                  background: on ? "rgba(241,196,15,0.18)" : "transparent",
                  border: on ? "1px solid rgba(241,196,15,0.55)" : "1px solid transparent",
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                  <span
                    style={{
                      minWidth: 22,
                      fontSize: 13,
                      fontWeight: 800,
                      color: on ? "#f1c40f" : "#f5f0e6",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {row.label}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: 1.35,
                      color: on ? "#f5f0e6" : "rgba(255,255,255,0.72)",
                      fontWeight: on ? 700 : 500,
                    }}
                  >
                    {row.text}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Table ───────────────────────────────────────────────────────────────────

function Table({
  players,
  drawDeck,
  discard,
  phase,
  dealing,
  dealProgress,
  lastStep,
  swapSeconds,
  selection,
  swapTick,
  currentPlayer,
  playSelected,
  statusMsg,
  finishOrder,
  flyAnim,
  burnCount,
  burnAnim,
  pickupAnim,
  drawAnim,
  revealCard,
  pickupAwaitTable,
  onSelectHand,
  onSelectFaceUp,
  onSelectFaceDown,
  onReady,
  onPlay,
  onPickUp,
  onPickUpOnly,
  onCancelPickupAwait,
  onReset,
  onToLobby,
  resetLabel,
  tutorial,
  tableSkin = "felt",
  chat,
  youId,
  onSendChat,
  reacts,
  onSendReact,
}: {
  players: PlayerState[];
  drawDeck: string[];
  discard: string[];
  phase: Phase;
  dealing: boolean;
  dealProgress: { faceDown: number[]; faceUp: number[]; hand: number[] };
  lastStep: DealStep | null;
  swapSeconds: number;
  selection: Selection;
  swapTick: number;
  currentPlayer: number;
  playSelected: CombinedPlay;
  statusMsg: string;
  finishOrder: number[];
  flyAnim: FlyAnim | null;
  burnCount: number;
  burnAnim: BurnAnim | null;
  pickupAnim: PickupAnim | null;
  drawAnim: DrawAnim | null;
  revealCard: string | null;
  pickupAwaitTable: boolean;
  onSelectHand: (index: number) => void;
  onSelectFaceUp: (index: number) => void;
  onSelectFaceDown: (index: number) => void;
  onReady: () => void;
  onPlay: () => void;
  onPickUp: () => void;
  onPickUpOnly: () => void;
  onCancelPickupAwait: () => void;
  onReset: () => void;
  onToLobby?: () => void;
  resetLabel?: string;
  tableSkin?: TableSkinId;
  chat?: ChatLine[];
  youId?: string;
  onSendChat?: (text: string) => void;
  reacts?: ReactBurst[];
  onSendReact?: (emoji: string) => void;
  tutorial?: {
    text: string;
    showNext: boolean;
    showSkip: boolean;
    hint: TutHint;
    rank?: string;
    faceRank?: string;
    special?: TutSpecial | null;
    onNext: () => void;
    onSkip: () => void;
  } | null;
}) {
  const theme = useHostTheme();
  const n = players.length;
  const opponentCount = n - 1;
  const isSwap = phase === "swap";
  const isPlaying = phase === "playing" || phase === "finished";
  const humanReady = players[0]?.ready ?? false;
  const isHumanTurn =
    isPlaying && currentPlayer === 0 && phase === "playing" && !flyAnim && !burnAnim && !pickupAnim && !revealCard && !drawAnim;
  const humanZone = players[0] ? activePlayZone(players[0], drawDeck.length) : null;
  const selRank = players[0] ? playSelectionRank(players[0], playSelected) : null;
  const tutHint = tutorial?.hint ?? "none";
  const handGlow =
    tutHint === "hand" && tutorial?.rank && players[0]
      ? players[0].hand.map((c) => getRank(c) === tutorial.rank)
      : undefined;
  const faceUpGlow =
    tutHint === "faceUp" && tutorial?.faceRank && players[0]
      ? players[0].faceUp.map((c) => !!c && getRank(c) === tutorial.faceRank)
      : undefined;

  function playerFaceDown(p: number) {
    if (isPlaying) return players[p].faceDown;
    return players[p].faceDown.slice(0, dealProgress.faceDown[p] || 0);
  }
  function playerFaceUp(p: number) {
    if (isPlaying) return players[p].faceUp;
    return players[p].faceUp.slice(0, dealProgress.faceUp[p] || 0);
  }
  function playerHand(p: number) {
    if (isPlaying) return players[p].hand;
    return players[p].hand.slice(0, dealProgress.hand[p] || 0);
  }

  const isAnimTarget = (p: number, type: string) =>
    !!dealing && !!lastStep && lastStep.type === type && "player" in lastStep && lastStep.player === p;

  // Hand always selectable on your turn if you have hand cards
  const handLegal =
    isHumanTurn && humanZone === "hand"
      ? players[0].hand.map((c) => {
          const r = getRank(c);
          if (selRank && r !== selRank) return false;
          return canPlayRankOnDiscard(r, discard);
        })
      : undefined;

  // Face-up alone when hand empty; combine with hand only if deck empty & emptying entire hand
  const combineOk =
    isHumanTurn &&
    humanZone === "hand" &&
    mayAttachFaceUp(players[0], drawDeck.length);
  const canSelectFaceUp =
    isHumanTurn &&
    (pickupAwaitTable
      ? humanZone === "faceUp"
      : humanZone === "faceUp" || combineOk);
  const faceUpLegal = canSelectFaceUp
    ? players[0].faceUp.map((c) => {
        if (c === null) return false;
        if (pickupAwaitTable) return true;
        const r = getRank(c);
        if (!canPlayRankOnDiscard(r, discard)) return false;
        if (humanZone === "hand") {
          // Entire hand is one rank; face-up must match it
          const handRank = getRank(players[0].hand[0]);
          return r === handRank;
        }
        if (selRank && r !== selRank) return false;
        return true;
      })
    : undefined;

  const selectedCards = players[0] ? cardsFromSelection(players[0], playSelected) : [];
  // Face-up alone (hand empty) is always fine; combo only when attaching face-up while still holding hand cards
  const comboLegal =
    playSelected.faceUp.length === 0 ||
    !players[0] ||
    players[0].hand.length === 0 ||
    canCombineHandWithFaceUp(players[0], drawDeck.length, playSelected.hand);
  const canPlaySelected =
    isHumanTurn &&
    selectedCards.length > 0 &&
    humanZone !== "faceDown" &&
    !(humanZone === "hand" && playSelected.hand.length === 0) &&
    comboLegal &&
    canPlayCards(selectedCards, discard);

  const displayDiscard =
    pickupAnim
      ? []
      : flyAnim && flyAnim.cards.length > 0 && discard.length >= flyAnim.cards.length
        ? discard.slice(0, discard.length - flyAnim.cards.length)
        : burnAnim
          ? []
          : discard;

  const vp = useViewport();
  const fsOn = useFullscreen();
  const [fsNote, setFsNote] = useState("");
  const [winShow, setWinShow] = useState(false);
  const [endUi, setEndUi] = useState(false);
  const [peekDown, setPeekDown] = useState<Record<number, boolean>>({});
  const [outNote, setOutNote] = useState("");
  const seenFinishRef = useRef(0);
  const [emojiFlies, setEmojiFlies] = useState<EmojiFly[]>([]);
  const seenReactRef = useRef(new Set<string>());
  const winnerIdx = finishOrder.length > 0 ? finishOrder[0] : null;
  const winner = winnerIdx != null ? players[winnerIdx] : null;
  const tableBusy = !!(flyAnim || burnAnim || pickupAnim || revealCard || drawAnim);

  useEffect(() => {
    if (phase !== "finished") {
      setPeekDown({});
      setEndUi(false);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "finished" || winnerIdx == null) {
      if (phase !== "finished") setWinShow(false);
      return;
    }
    if (tableBusy) return;
    const show = window.setTimeout(() => setWinShow(true), END_LINGER_MS);
    const hide = window.setTimeout(() => {
      setWinShow(false);
      setEndUi(true);
    }, END_LINGER_MS + WIN_BANNER_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [phase, winnerIdx, tableBusy]);

  useEffect(() => {
    if (phase !== "playing") {
      seenFinishRef.current = finishOrder.length;
      if (phase !== "finished") setOutNote("");
      return;
    }
    if (finishOrder.length <= seenFinishRef.current) {
      seenFinishRef.current = finishOrder.length;
      return;
    }
    const pIdx = finishOrder[finishOrder.length - 1];
    const stillIn = unfinishedPlayers(players).length;
    const name = players[pIdx]?.name || "Player";
    setOutNote(stillIn > 1 ? `${name} is out · ${stillIn} still in` : `${name} is out`);
    seenFinishRef.current = finishOrder.length;
    const t = window.setTimeout(() => setOutNote(""), 2400);
    return () => window.clearTimeout(t);
  }, [finishOrder, phase, players]);

  function spawnEmojiFly(id: string, emoji: string) {
    const drift = driftFromId(id);
    setEmojiFlies((prev) => [...prev, { id, emoji, x: drift.x, rot: drift.rot }].slice(-10));
    window.setTimeout(() => {
      setEmojiFlies((prev) => prev.filter((f) => f.id !== id));
    }, 1700);
  }

  useEffect(() => {
    for (const burst of reacts ?? []) {
      if (seenReactRef.current.has(burst.id)) continue;
      seenReactRef.current.add(burst.id);
      if (youId && burst.fromId === youId) continue;
      spawnEmojiFly(burst.id, burst.emoji);
    }
  }, [reacts, youId]);

  function pickReact(emoji: string) {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    seenReactRef.current.add(id);
    spawnEmojiFly(id, emoji);
    onSendReact?.(emoji);
  }
  const short = vp.h < 560;
  const ownerH = short ? Math.round(clamp(vp.h * 0.26, 64, 86)) : 78;
  const ownerW = Math.round(ownerH * 0.72);
  const oppH = short ? Math.round(clamp(vp.h * 0.162, 43, 59)) : 63;
  const oppW = Math.round(oppH * 0.72);
  const tableGap = Math.max(4, Math.round(ownerW * 0.14));
  const tableSpread = ownerW * 3 + tableGap * 2;
  const humanGap = short ? 36 : 24;
  const cornerReserve = 116;
  const handMax = Math.max(
    ownerW,
    vp.w - cornerReserve * 2 - tableSpread - humanGap - 12,
  );
  const seats = splitOpponentSeats(opponentCount);
  const oppTableGap = Math.max(4, Math.round(oppW * 0.14));
  const sideColW =
    seats.left.length || seats.right.length
      ? Math.round(oppW * 3 + oppTableGap * 2 + 18)
      : 4;

  async function toggleFullscreen() {
    if (fsOn) {
      await exitFullscreen();
      setFsNote("");
      return;
    }
    const res = await enterFullscreen();
    if (res !== "ok") {
      setFsNote("iPhone: Share → Add to Home Screen to hide Safari");
      window.setTimeout(() => setFsNote(""), 6000);
    } else {
      setFsNote("");
    }
  }

  function renderOpp(pIdx: number, side: "left" | "right" | "top") {
    const hand = playerHand(pIdx);
    const across = side === "top";
    return (
      <div
        key={pIdx}
        data-player-hand={pIdx}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          padding: across ? "0 6px" : "2px 2px",
        }}
      >
        <SeatLabel
          name={hand.length > 0 ? `${players[pIdx].name} · ${hand.length}` : players[pIdx].name}
          avatar={players[pIdx].avatar}
          isHuman={false}
          ready={isSwap ? players[pIdx].ready : undefined}
          isTurn={isPlaying && currentPlayer === pIdx && phase === "playing"}
          place={finishOrder.includes(pIdx) ? finishOrder.indexOf(pIdx) + 1 : null}
          offline={players[pIdx].connected === false}
        />
        <div
          style={{
            display: "flex",
            flexDirection: across ? "row" : "column",
            alignItems: "center",
            justifyContent: "center",
            flexWrap: "nowrap",
            gap: across ? 6 : 2,
          }}
        >
          <TableStack
            faceDown={playerFaceDown(pIdx)}
            faceUp={playerFaceUp(pIdx)}
            revealed={isPlaying || (dealProgress.faceUp[pIdx] || 0) > 0}
            cardW={oppW}
            cardH={oppH}
            animating={dealing}
            fuAnimSlots={dealProgress.faceUp[pIdx] || 0}
          />
          {hand.length > 0 && (
            <Hand
              cards={hand}
              isOwner={false}
              cardW={oppW}
              cardH={oppH}
              maxWidth={oppW + 2 * Math.max(6, Math.round(oppW * 0.22))}
              animating={!!isAnimTarget(pIdx, "hand")}
              seatId={pIdx}
            />
          )}
        </div>
      </div>
    );
  }

  const myTurn = isPlaying && currentPlayer === 0 && phase === "playing";
  const playClickable =
    isHumanTurn && !pickupAwaitTable && humanZone !== "faceDown" && canPlaySelected;
  const pickupClickable = isHumanTurn && (pickupAwaitTable || discard.length > 0);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: tableSkin === "peli" ? "#111" : "#145230",
        position: "relative",
        overflow: "hidden",
        boxSizing: "border-box",
        padding: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: FELT_INSET_TOP,
          left: FELT_INSET_LEFT,
          zIndex: 96,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <WindowButton style={{ position: "static", top: "auto", left: "auto" }} onClick={() => void toggleFullscreen()} />
        <button
          onClick={phase === "finished" && onToLobby ? onToLobby : onReset}
          style={{
            padding: "6px 10px",
            minHeight: 0,
            borderRadius: 6,
            border: `1px solid ${theme.stroke.secondary}`,
            background: "rgba(0,0,0,0.35)",
            color: theme.text.primary,
            cursor: "pointer",
            fontSize: 12,
            touchAction: "manipulation",
          }}
        >
          {phase === "finished" && onToLobby ? "Lobby" : resetLabel || "← Lobby"}
        </button>
      </div>
      {fsNote ? (
        <div
          style={{
            position: "absolute",
            top: 32,
            left: 8,
            zIndex: 9,
            maxWidth: 280,
            padding: "6px 8px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.72)",
            color: "#f5f0e6",
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          {fsNote}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          top: 32,
          left: "max(8px, env(safe-area-inset-left))",
          zIndex: 8,
          maxWidth: "42%",
          color: theme.text.secondary,
          fontSize: 11,
          textAlign: "left",
          lineHeight: 1.25,
        }}
      >
        {tutorial ? null : statusMsg}
      </div>

      {(finishOrder.length > 0 || phase === "finished") && (
        <div
          style={{
            position: "absolute",
            top: 34,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 8,
            padding: "3px 10px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.45)",
            border: `1px solid ${theme.stroke.focused}`,
            color: theme.text.primary,
            fontSize: 11,
            maxWidth: "70%",
            textAlign: "center",
          }}
        >
          {phase === "finished" ? "Results · " : finishOrder.length > 0 ? "Still playing · " : ""}
          {finishOrder.map((pIdx, i) => {
            const place = i + 1;
            const isLast = phase === "finished" && place === finishOrder.length && finishOrder.length > 1;
            return (
              <span key={pIdx} style={{ fontWeight: pIdx === 0 || place === 1 ? 700 : 500 }}>
                {isLast ? "Last" : `${place}`} {players[pIdx].name}
                {i < finishOrder.length - 1 ? " · " : ""}
              </span>
            );
          })}
        </div>
      )}
      {outNote ? (
        <div
          style={{
            position: "absolute",
            top: 62,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 70,
            padding: "6px 12px",
            borderRadius: 10,
            background: "rgba(8, 18, 10, 0.9)",
            border: "1px solid rgba(241,196,15,0.55)",
            color: "#f5f0e6",
            fontSize: 13,
            fontWeight: 700,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {outNote}
        </div>
      ) : null}

      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: short ? 18 : 48,
          ...tableBoardStyle(tableSkin, short),
          display: "grid",
          gridTemplateColumns: `${sideColW}px minmax(0, 1fr) ${sideColW}px`,
          gridTemplateRows: "auto minmax(0, 1fr) auto",
          rowGap: short ? 4 : 10,
          columnGap: short ? 4 : 12,
          alignItems: "center",
          justifyItems: "center",
          padding: short ? "13px 6px 28px" : "8px 28px 28px",
          overflow: "hidden",
          boxSizing: "border-box",
          position: "relative",
          minHeight: 0,
        }}
      >
        {tableSkin === "felt" ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: short ? 12 : 38,
            backgroundImage:
              "radial-gradient(ellipse at 50% 40%, rgba(255,255,255,0.04) 0%, transparent 60%)",
            pointerEvents: "none",
          }}
        />
        ) : null}

        <div
          style={{
            gridColumn: 1,
            gridRow: "1 / -1",
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            width: sideColW,
            minWidth: sideColW,
            minHeight: 0,
          }}
        >
          {seats.left.map((pIdx) => renderOpp(pIdx, "left"))}
        </div>

        <div
          style={{
            gridColumn: 2,
            gridRow: 1,
            zIndex: 1,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            alignSelf: "start",
            gap: short ? 16 : 28,
            minHeight: 0,
            width: "100%",
          }}
        >
          {seats.top.map((pIdx) => renderOpp(pIdx, "top"))}
        </div>

        <div
          style={{
            gridColumn: 3,
            gridRow: "1 / -1",
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            width: sideColW,
            minWidth: sideColW,
            minHeight: 0,
          }}
        >
          {seats.right.map((pIdx) => renderOpp(pIdx, "right"))}
        </div>

        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 2,
            position: "relative",
            width: "100%",
            height: "100%",
            minHeight: 0,
            zIndex: 3,
            pointerEvents: "none",
            alignSelf: "stretch",
            justifySelf: "stretch",
          }}
        >
          <div
            data-deck-pile=""
            style={{
              position: "absolute",
              left: "34%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              pointerEvents: "auto",
            }}
          >
            <DeckPile count={drawDeck.length} />
          </div>
          <div
            data-discard-pile=""
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              pointerEvents: "auto",
            }}
          >
            {isSwap && !tutorial && (
              <div style={{ transform: short ? "scale(0.78)" : undefined, transformOrigin: "center" }}>
                <SwapTimer seconds={swapSeconds} />
              </div>
            )}
            {isPlaying && <DiscardPile cards={displayDiscard} />}
            {isSwap && (
              <FeltChip onClick={onReady} disabled={humanReady} kind="ready" label="Ready" glow={tutHint === "ready"} />
            )}
            {pickupAwaitTable && isHumanTurn && (
              <FeltChip onClick={onCancelPickupAwait} kind="ghost" label="Cancel" />
            )}
          </div>
          <div
            style={{
              position: "absolute",
              left: "66%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              pointerEvents: "auto",
            }}
          >
            {isPlaying ? <BurnPile count={burnCount} /> : <div style={{ width: 64, height: 90 }} />}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 50,
            gridColumn: "1 / -1",
            gridRow: "1 / -1",
          }}
        >
          {isPlaying && flyAnim && <FlyOverlay anim={flyAnim} />}
          {isPlaying && burnAnim && <BurnOverlay anim={burnAnim} />}
          {isPlaying && pickupAnim && <PickupOverlay anim={pickupAnim} />}
          {isPlaying && drawAnim && <DrawOverlay anim={drawAnim} />}
          {isPlaying && revealCard && <RevealOverlay card={revealCard} />}
        </div>

        <div
          data-player-hand={0}
          style={{
            gridColumn: 2,
            gridRow: 3,
            zIndex: 2,
            display: "flex",
            flexDirection: short ? "row" : "column",
            alignItems: "center",
            justifyContent: "center",
            gap: humanGap,
            minHeight: 0,
            alignSelf: "end",
            padding: isPlaying && currentPlayer === 0 && phase === "playing" ? "4px 10px 2px" : "2px 8px",
            borderRadius: 16,
            boxShadow:
              isPlaying && currentPlayer === 0 && phase === "playing"
                ? "0 0 0 2px rgba(241,196,15,0.55)"
                : undefined,
          }}
        >
          <TableStack
            faceDown={playerFaceDown(0)}
            faceUp={playerFaceUp(0)}
            revealed={isPlaying || (dealProgress.faceUp[0] || 0) > 0}
            animating={dealing}
            fuAnimSlots={dealProgress.faceUp[0] || 0}
            cardW={ownerW}
            cardH={ownerH}
            selectableFaceUp={
              (isSwap && !humanReady) || (isHumanTurn && canSelectFaceUp)
            }
            selectableFaceDown={
              (phase === "finished" && playerFaceDown(0).some((c, i) => c !== null && !playerFaceUp(0)[i])) ||
              (isHumanTurn &&
                (pickupAwaitTable ? humanZone === "faceDown" : humanZone === "faceDown"))
            }
            locked={phase === "finished" ? false : isSwap ? humanReady : !isHumanTurn}
            peekedDown={phase === "finished" ? playerFaceDown(0).map((_, i) => !!peekDown[i]) : undefined}
            selectedFaceUp={
              isSwap
                ? selection?.zone === "faceUp"
                  ? [selection.index]
                  : []
                : pickupAwaitTable
                  ? []
                  : playSelected.faceUp
            }
            faceUpLegal={faceUpLegal}
            glowFaceUp={faceUpGlow}
            onSelectFaceUp={onSelectFaceUp}
            onSelectFaceDown={
              phase === "finished"
                ? (i) => {
                    if (playerFaceUp(0)[i]) return;
                    setPeekDown((prev) => ({ ...prev, [i]: !prev[i] }));
                  }
                : onSelectFaceDown
            }
            swapKey={swapTick}
          />
          {phase === "finished" && playerFaceDown(0).some((c, i) => c !== null && !playerFaceUp(0)[i]) ? (
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}>
              Tap a face-down card to peek
            </div>
          ) : null}
          {(playerHand(0).length > 0 || !isPlaying) && (
            <Hand
              cards={playerHand(0)}
              isOwner
              cardW={ownerW}
              cardH={ownerH}
              maxWidth={handMax}
              animating={!!isAnimTarget(0, "hand")}
              selectable={(isSwap && !humanReady) || (isHumanTurn && humanZone === "hand")}
              locked={isSwap ? humanReady : !isHumanTurn}
              selectedIndices={
                isSwap
                  ? selection?.zone === "hand"
                    ? [selection.index]
                    : []
                  : playSelected.hand
              }
              legalMask={handLegal}
              glowMask={handGlow}
              onSelect={onSelectHand}
              swapKey={swapTick}
              seatId={0}
            />
          )}
        </div>
      </div>

      <FeltChip
        kind={myTurn ? "play" : "ghost"}
        disabled={!myTurn}
        label="Play"
        glow={tutHint === "play"}
        onClick={() => {
          if (playClickable) onPlay();
        }}
        style={{
          position: "absolute",
          left: "max(8px, env(safe-area-inset-left))",
          bottom: "max(8px, env(safe-area-inset-bottom))",
          zIndex: 80,
          width: 108,
          minHeight: 48,
          fontSize: 14,
          pointerEvents: "auto",
        }}
      />
      <FeltChip
        kind={myTurn ? "take" : "ghost"}
        disabled={!myTurn}
        glow={tutHint === "take"}
        label={
          <>
            Take
            <br />
            discard
          </>
        }
        onClick={() => {
          if (!pickupClickable) return;
          if (pickupAwaitTable) onPickUpOnly();
          else onPickUp();
        }}
        style={{
          position: "absolute",
          right: "max(8px, env(safe-area-inset-right))",
          bottom: "max(8px, env(safe-area-inset-bottom))",
          zIndex: 80,
          width: 108,
          minHeight: 48,
          fontSize: 13,
          pointerEvents: "auto",
        }}
      />
      {phase === "playing" || phase === "swap" || phase === "finished" ? <EmojiDock onPick={pickReact} /> : null}
      <EmojiFlyLayer flies={emojiFlies} />
      {onSendChat ? (
        <RoomChat variant="table" lines={chat ?? []} youId={youId} onSend={onSendChat} />
      ) : null}
      {tutorial ? (
        <TutorialBar
          text={tutorial.text}
          showNext={tutorial.showNext}
          showSkip={tutorial.showSkip}
          onNext={tutorial.onNext}
          onSkip={tutorial.onSkip}
        />
      ) : null}
      {phase !== "lobby" && phase !== "rules" ? (
        <SpecialsMemo active={tutorial?.special} drop={!!tutorial} />
      ) : null}
      {winShow && winner ? (
        <WinnerOverlay
          name={winner.name}
          avatar={winner.avatar}
          you={winnerIdx === 0}
          onDismiss={() => {
            setWinShow(false);
            setEndUi(true);
          }}
        />
      ) : null}
      {phase === "finished" && onToLobby && endUi && !winShow ? <FinishedLobbyOverlay onLobby={onToLobby} /> : null}
    </div>
  );
}

const NAME_KEY = "citrons-name";
const WS_KEY = "citrons-ws";
const SESSION_KEY = "citrons-mp-session";
const REJOIN_KEEP_MS = 10 * 60 * 1000;

type MpSession = { code: string; token: string; name: string; savedAt: number };

function readMpSession(): MpSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MpSession>;
    if (!parsed.code || !parsed.token) return null;
    const savedAt = Number(parsed.savedAt) || Date.now();
    if (Date.now() - savedAt > REJOIN_KEEP_MS) {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return {
      code: String(parsed.code),
      token: String(parsed.token),
      name: String(parsed.name || "Player"),
      savedAt,
    };
  } catch {
    return null;
  }
}

function writeMpSession(sess: MpSession) {
  const raw = JSON.stringify(sess);
  try {
    localStorage.setItem(SESSION_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(SESSION_KEY, raw);
  } catch {
    /* ignore */
  }
}

function clearMpSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

type OnlineView = {
  code: string;
  you: number;
  youId: string;
  host: boolean;
  phase: "waiting" | "dealing" | "swap" | "playing" | "finished";
  players: PlayerState[];
  deckCount: number;
  discard: string[];
  currentPlayer: number;
  finishOrder: number[];
  swapSeconds: number;
  burnCount: number;
  statusMsg: string;
  canStart: boolean;
  tableSkin: TableSkinId;
  chat?: ChatLine[];
  lobby: { id: string; name: string; avatar?: string; ready: boolean; connected: boolean; host: boolean }[];
};

type LobbyInfo = {
  code: string;
  host: string;
  hostAvatar?: string;
  players: { name: string; avatar?: string }[];
  count: number;
  max: number;
};

function OpenLobbyList({
  lobbies,
  busy,
  onJoin,
}: {
  lobbies: LobbyInfo[];
  busy: boolean;
  onJoin: (code: string) => void;
}) {
  return (
    <div style={{ width: "100%", maxWidth: 340, textAlign: "left" }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.55)",
          marginBottom: 8,
          textAlign: "center",
        }}
      >
        Open lobbies
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "38vh", overflowY: "auto" }}>
        {lobbies.length === 0 ? (
          <div
            style={{
              padding: "16px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.28)",
              color: "rgba(255,255,255,0.62)",
              fontSize: 13,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            Searching for open lobbies…
          </div>
        ) : (
          lobbies.map((lobby) => {
            const full = lobby.count >= lobby.max;
            const names = lobby.players.map((p) => p.name).join(", ");
            return (
              <div
                key={lobby.code}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 10px 10px 12px",
                  borderRadius: 10,
                  background: "rgba(0,0,0,0.32)",
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <AvatarBubble src={lobby.hostAvatar} name={lobby.host} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: "#f5f0e6",
                      fontWeight: 700,
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {lobby.host}
                  </div>
                  <div
                    style={{
                      color: "rgba(255,255,255,0.55)",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {lobby.count}/{lobby.max} · {names || lobby.code}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy || full}
                  onClick={() => onJoin(lobby.code)}
                  style={{
                    flexShrink: 0,
                    height: 32,
                    padding: "0 12px",
                    borderRadius: 8,
                    border: "none",
                    background: full ? "rgba(255,255,255,0.12)" : "#f1c40f",
                    color: full ? "rgba(255,255,255,0.45)" : "#1a2e1a",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: busy || full ? "default" : "pointer",
                  }}
                >
                  {full ? "Full" : "Join"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

type BoardRow = {
  rank: number;
  id: string;
  name: string;
  avatar: string;
  wins: number;
  games: number;
};

function medalColor(rank: number): string {
  if (rank === 1) return "#f1c40f";
  if (rank === 2) return "#d5d8dc";
  if (rank === 3) return "#cd7f32";
  return "rgba(255,255,255,0.45)";
}

function LeaderboardPanel() {
  const auth = useClerkAuth();
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [fail, setFail] = useState("");

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const res = await fetch(httpUrlFromWs(defaultWsUrl(), "/leaderboard"));
        if (!res.ok) throw new Error("bad");
        const data = await res.json();
        if (stop) return;
        const players = Array.isArray(data.players) ? data.players : [];
        setRows(
          players.map((p: { rank?: number; id?: string; name?: string; avatar?: string; wins?: number; games?: number }, i: number) => ({
            rank: Number(p.rank) || i + 1,
            id: String(p.id || ""),
            name: String(p.name || "Player"),
            avatar: String(p.avatar || ""),
            wins: Number(p.wins) || 0,
            games: Number(p.games) || 0,
          }))
        );
        setFail("");
      } catch {
        if (!stop) {
          setRows([]);
          setFail("Couldn't load the board");
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  const me = auth.user && auth.user.id ? String(auth.user.id) : "";

  return (
    <div style={{ width: "100%", maxWidth: 340, textAlign: "left" }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.3,
          color: "rgba(255,255,255,0.55)",
          marginBottom: 8,
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        Signed-in multiplayer wins
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
        {rows === null ? (
          <div
            style={{
              padding: "16px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.28)",
              color: "rgba(255,255,255,0.62)",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            Loading…
          </div>
        ) : fail ? (
          <div
            style={{
              padding: "16px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.28)",
              color: "#f5b7b1",
              fontSize: 13,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            {fail}
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: "16px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.28)",
              color: "rgba(255,255,255,0.62)",
              fontSize: 13,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            Win a signed-in multiplayer game to appear here.
          </div>
        ) : (
          rows.map((row) => {
            const mine = me && row.id === me;
            return (
              <div
                key={row.id || `${row.rank}-${row.name}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: mine ? "rgba(241,196,15,0.16)" : "rgba(0,0,0,0.32)",
                  border: mine ? "1px solid rgba(241,196,15,0.55)" : "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <div
                  style={{
                    width: 28,
                    flexShrink: 0,
                    fontWeight: 800,
                    fontSize: 14,
                    textAlign: "center",
                    color: medalColor(row.rank),
                  }}
                >
                  {row.rank}
                </div>
                <AvatarBubble src={row.avatar} name={row.name} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: "#f5f0e6",
                      fontWeight: 700,
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.name}
                    {mine ? " (you)" : ""}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11 }}>
                    {row.games} {row.games === 1 ? "game" : "games"}
                  </div>
                </div>
                <div style={{ flexShrink: 0, textAlign: "right" }}>
                  <div style={{ color: "#f1c40f", fontWeight: 800, fontSize: 16, lineHeight: 1 }}>
                    {row.wins}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: 600 }}>
                    {row.wins === 1 ? "win" : "wins"}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

type NetAnim = {
  kind?: string;
  fromPlayer: number;
  played?: string[];
  willBurn?: boolean;
  burnCards?: string[];
  drawn?: string[];
  pickup?: { cards: string[]; toPlayer: number } | null;
};

function omitCardsFromHand(hand: string[], cards: string[]): string[] {
  const next = [...hand];
  for (const c of cards) {
    const i = next.indexOf(c);
    if (i >= 0) next.splice(i, 1);
    else if (next.length) next.pop();
  }
  return next;
}

function withPlayerHand(view: OnlineView, playerIndex: number, hand: string[]): OnlineView {
  return {
    ...view,
    players: view.players.map((p, i) => (i === playerIndex ? { ...p, hand } : p)),
  };
}

function normalizeWsUrl(raw: string): string {
  let u = String(raw || "").trim();
  if (!u) return u;
  if (u.startsWith("https://")) u = `wss://${u.slice(8)}`;
  else if (u.startsWith("http://")) u = `ws://${u.slice(7)}`;
  else if (!u.startsWith("ws://") && !u.startsWith("wss://")) {
    const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss://" : "ws://";
    u = proto + u.replace(/^\/\//, "");
  }
  return u.replace(/\/$/, "");
}

function httpUrlFromWs(wsUrl: string, path: string): string {
  let u = normalizeWsUrl(wsUrl);
  if (u.startsWith("wss://")) u = `https://${u.slice(6)}`;
  else if (u.startsWith("ws://")) u = `http://${u.slice(5)}`;
  return u.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

const DEFAULT_WS = "wss://web-production-b9cc89.up.railway.app";

function defaultWsUrl(): string {
  if (typeof window === "undefined") return DEFAULT_WS;
  const q = new URLSearchParams(window.location.search).get("ws");
  if (q) return normalizeWsUrl(q);
  const builtin = (window as unknown as { CITRONS_WS?: string }).CITRONS_WS;
  if (builtin) return normalizeWsUrl(builtin);
  try {
    const saved = localStorage.getItem(WS_KEY);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return `ws://${host}:8787`;
  return DEFAULT_WS;
}

function readSavedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

const LOBBY_INPUT: CSSProperties = {
  width: "100%",
  maxWidth: 300,
  height: 44,
  borderRadius: 10,
  border: "1.5px solid rgba(255,255,255,0.28)",
  background: "rgba(0,0,0,0.28)",
  color: "#f5f0e6",
  fontSize: 16,
  textAlign: "center",
  outline: "none",
  boxSizing: "border-box",
};

function fullDealProgress(n: number) {
  return {
    faceDown: Array.from({ length: n }, () => 3),
    faceUp: Array.from({ length: n }, () => 3),
    hand: Array.from({ length: n }, () => 3),
  };
}

function OnlineGame({ onLeave }: { onLeave: () => void }) {
  const auth = useClerkAuth();
  const [screen, setScreen] = useState<"pick" | "create" | "join" | "waiting" | "table">("pick");
  const [name, setName] = useState(readSavedName);
  const [code, setCode] = useState("");
  const [wsUrl, setWsUrl] = useState(defaultWsUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lobbies, setLobbies] = useState<LobbyInfo[]>([]);
  const [view, setView] = useState<OnlineView | null>(null);
  const [revealCard, setRevealCard] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [swapTick, setSwapTick] = useState(0);
  const [playSelected, setPlaySelected] = useState<CombinedPlay>(emptyPlay);
  const [pickupAwaitTable, setPickupAwaitTable] = useState(false);
  const [dealing, setDealing] = useState(false);
  const [dealProgress, setDealProgress] = useState(fullDealProgress(2));
  const [lastStep, setLastStep] = useState<DealStep | null>(null);
  const [copied, setCopied] = useState(false);
  const [flyAnim, setFlyAnim] = useState<FlyAnim | null>(null);
  const [burnAnim, setBurnAnim] = useState<BurnAnim | null>(null);
  const [pickupAnim, setPickupAnim] = useState<PickupAnim | null>(null);
  const [drawAnim, setDrawAnim] = useState<DrawAnim | null>(null);
  const [dropped, setDropped] = useState(false);
  const [savedGame, setSavedGame] = useState<MpSession | null>(() => readMpSession());
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [reacts, setReacts] = useState<ReactBurst[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef<MpSession | null>(readMpSession());
  const reconnectTriesRef = useRef(0);
  const viewRef = useRef<OnlineView | null>(null);
  const screenRef = useRef(screen);
  const animIdRef = useRef(0);
  const animTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  viewRef.current = view;
  screenRef.current = screen;

  function persistName(n: string) {
    setName(n);
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      /* ignore */
    }
  }

  function persistWs(u: string) {
    const next = normalizeWsUrl(u);
    setWsUrl(next);
    try {
      localStorage.setItem(WS_KEY, next);
    } catch {
      /* ignore */
    }
  }

  function send(msg: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function clearTableAnims() {
    animTimersRef.current.forEach(clearTimeout);
    animTimersRef.current = [];
    setFlyAnim(null);
    setBurnAnim(null);
    setPickupAnim(null);
    setDrawAnim(null);
  }

  function afterAnim(ms: number, fn: () => void) {
    const t = setTimeout(fn, ms);
    animTimersRef.current.push(t);
  }

  function runNetAnim(finalView: OnlineView, anim: NetAnim) {
    clearTableAnims();
    const n = finalView.players.length;
    const played = anim.played || [];
    const burnCards = anim.burnCards || [];
    const drawn = anim.drawn || [];
    const pickup = anim.pickup || null;
    const finish = () => {
      setView(finalView);
      setFlyAnim(null);
      setBurnAnim(null);
      setPickupAnim(null);
      setDrawAnim(null);
    };

    const startDraw = () => {
      if (drawn.length === 0) {
        finish();
        return;
      }
      animIdRef.current += 1;
      setDrawAnim({
        id: animIdRef.current,
        cards: drawn,
        toPlayer: anim.fromPlayer,
        playerCount: n,
      });
      afterAnim(DRAW_MS + Math.max(0, drawn.length - 1) * DRAW_STAGGER_MS, finish);
    };

    const afterPlayOrBurn = () => {
      if (anim.willBurn && burnCards.length > 0) {
        animIdRef.current += 1;
        setBurnAnim({ id: animIdRef.current, cards: burnCards });
        afterAnim(BURN_MS + Math.min(burnCards.length, 6) * 35, () => {
          setBurnAnim(null);
          startDraw();
        });
        return;
      }
      startDraw();
    };

    const startPickup = () => {
      if (!pickup) {
        afterPlayOrBurn();
        return;
      }
      animIdRef.current += 1;
      setPickupAnim({
        id: animIdRef.current,
        cards: pickup.cards,
        toPlayer: pickup.toPlayer,
        playerCount: n,
        hideFaces: pickup.toPlayer !== 0,
      });
      afterAnim(PICKUP_MS + Math.min(pickup.cards.length, 8) * 40, finish);
    };

    if (pickup && played.length === 0) {
      startPickup();
      return;
    }
    if (played.length > 0) {
      animIdRef.current += 1;
      setFlyAnim({
        id: animIdRef.current,
        cards: played,
        fromPlayer: anim.fromPlayer,
        playerCount: n,
      });
      afterAnim(FLY_MS + played.length * 55, () => {
        if (pickup) {
          setFlyAnim(null);
          startPickup();
        } else if (anim.willBurn && burnCards.length > 0) {
          afterAnim(LAND_PAUSE_MS, () => {
            setFlyAnim(null);
            afterPlayOrBurn();
          });
        } else {
          setFlyAnim(null);
          afterPlayOrBurn();
        }
      });
      return;
    }
    startDraw();
  }

  function stopPing() {
    if (pingRef.current) clearInterval(pingRef.current);
    pingRef.current = null;
  }

  function closeSocket() {
    stopPing();
    const ws = wsRef.current;
    wsRef.current = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  function handleMessage(raw: string) {
    let msg: {
      type?: string;
      message?: string;
      view?: OnlineView;
      code?: string;
      token?: string;
      card?: string;
      anim?: NetAnim;
      lobbies?: LobbyInfo[];
      line?: ChatLine;
      react?: ReactBurst;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "error") {
      setBusy(false);
      setError(msg.message || "Server error");
      if (/lobby not found|game has already started/i.test(msg.message || "")) {
        const inMatch = screenRef.current === "waiting" || screenRef.current === "table";
        if (!inMatch) forgetSession();
      }
      return;
    }
    if (msg.type === "lobbies" && Array.isArray(msg.lobbies)) {
      setLobbies(msg.lobbies);
      if (!sessionRef.current) setBusy(false);
      return;
    }
    if (msg.type === "chat" && msg.line && msg.line.id && msg.line.text) {
      setChat((prev) => {
        if (prev.some((l) => l.id === msg.line!.id)) return prev;
        return [...prev, msg.line!].slice(-50);
      });
      return;
    }
    if (msg.type === "react" && msg.react && msg.react.id && msg.react.emoji) {
      setReacts((prev) => {
        if (prev.some((r) => r.id === msg.react!.id)) return prev;
        return [...prev, msg.react!].slice(-20);
      });
      return;
    }
    if (msg.type === "joined") {
      setBusy(false);
      setError("");
      setDropped(false);
      reconnectTriesRef.current = 0;
      if (msg.code && msg.token) {
        const sess: MpSession = {
          code: msg.code,
          token: msg.token,
          name: name.trim() || "Player",
          savedAt: Date.now(),
        };
        sessionRef.current = sess;
        setSavedGame(sess);
        writeMpSession(sess);
      }
      return;
    }
    if (msg.type === "state" && msg.view) {
      setBusy(false);
      setError("");
      setDropped(false);
      reconnectTriesRef.current = 0;
      if (Array.isArray(msg.view.chat)) {
        const incoming = msg.view.chat;
        setChat((prev) => {
          const byId = new Map<string, ChatLine>();
          for (const line of prev) byId.set(line.id, line);
          for (const line of incoming) byId.set(line.id, line);
          return [...byId.values()].sort((a, b) => a.at - b.at).slice(-50);
        });
      }
      if (msg.view.phase === "waiting") {
        clearTableAnims();
        setView(msg.view);
        setScreen("waiting");
        return;
      }
      setScreen("table");
      const anim = msg.anim;
      const hasAnim =
        (msg.view.phase === "playing" || msg.view.phase === "finished") &&
        anim &&
        ((anim.played && anim.played.length > 0) ||
          anim.pickup ||
          (anim.drawn && anim.drawn.length > 0) ||
          anim.willBurn);
      if (hasAnim && anim) {
        let display = msg.view;
        if (anim.drawn && anim.drawn.length > 0) {
          display = withPlayerHand(
            display,
            anim.fromPlayer,
            omitCardsFromHand(display.players[anim.fromPlayer].hand, anim.drawn)
          );
        }
        if (anim.pickup) {
          display = withPlayerHand(
            display,
            anim.pickup.toPlayer,
            omitCardsFromHand(display.players[anim.pickup.toPlayer].hand, anim.pickup.cards)
          );
        }
        if (anim.willBurn && anim.burnCards && anim.burnCards.length > 0) {
          display = { ...display, discard: anim.burnCards };
        }
        setView(display);
        runNetAnim(msg.view, anim);
      } else {
        clearTableAnims();
        setView(msg.view);
      }
      return;
    }
    if (msg.type === "reveal" && msg.card) {
      setRevealCard(msg.card);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      revealTimerRef.current = setTimeout(() => setRevealCard(null), 900);
      return;
    }
    if (msg.type === "left") {
      forgetSession();
      setDropped(false);
      setView(null);
      setChat([]);
      setReacts([]);
      setScreen("pick");
    }
  }

  function connect(then: (ws: WebSocket) => void, opts?: { silent?: boolean }) {
    if (!opts?.silent) setBusy(true);
    setError("");
    closeSocket();
    persistWs(wsUrl);
    persistName(name);
    let ws: WebSocket;
    try {
      ws = new WebSocket(normalizeWsUrl(wsUrl));
    } catch {
      setBusy(false);
      setError("Couldn't open the connection");
      return;
    }
    wsRef.current = ws;
    ws.onopen = () => {
      pingRef.current = setInterval(() => send({ type: "ping" }), 25000);
      then(ws);
    };
    ws.onmessage = (ev) => handleMessage(String(ev.data));
    ws.onerror = () => {
      setBusy(false);
      setError("No connection to the server. Check the Railway URL.");
    };
    ws.onclose = () => {
      stopPing();
      if (wsRef.current === ws) wsRef.current = null;
      const sess = sessionRef.current;
      const inMatch = screenRef.current === "waiting" || screenRef.current === "table";
      if (sess && inMatch) {
        if (reconnectTriesRef.current < 2) {
          reconnectTriesRef.current += 1;
          window.setTimeout(() => {
            if (wsRef.current) return;
            if (screenRef.current !== "waiting" && screenRef.current !== "table") return;
            rejoinSavedGame();
          }, 800);
        } else {
          setDropped(true);
          setBusy(false);
          setError("Connection lost — you can rejoin.");
        }
        return;
      }
      if (screenRef.current === "pick" || screenRef.current === "join") {
        window.setTimeout(() => {
          if (wsRef.current) return;
          if (screenRef.current !== "pick" && screenRef.current !== "join") return;
          connect((next) => next.send(JSON.stringify({ type: "browse" })), { silent: true });
        }, 1200);
      }
    };
  }

  async function clerkPayload() {
    const clerk = await ensureClerk();
    const token = clerk.session ? await clerk.session.getToken() : "";
    const u = clerk.user;
    if (!token || !u) throw new Error("Sign in with Google first");
    const nick = clerkNickname(u);
    persistName(nick);
    return { name: nick, avatar: u.imageUrl || "", clerkToken: token };
  }

  function createLobby() {
    void (async () => {
      try {
        const payload = await clerkPayload();
        connect((ws) => ws.send(JSON.stringify({ type: "create", ...payload })));
      } catch (e) {
        setError(clerkErrorText(e));
      }
    })();
  }

  function joinByCode(raw: string) {
    const c = raw.trim().toUpperCase();
    if (c.length < 4) {
      setError("Enter a lobby code");
      return;
    }
    void (async () => {
      try {
        const payload = await clerkPayload();
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
          setBusy(true);
          ws.send(JSON.stringify({ type: "join", code: c, ...payload }));
        } else {
          connect((sock) => sock.send(JSON.stringify({ type: "join", code: c, ...payload })));
        }
      } catch (e) {
        setError(clerkErrorText(e));
      }
    })();
  }

  function joinLobby() {
    joinByCode(code);
  }

  function startBrowse() {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "browse" }));
      return;
    }
    if (ws && ws.readyState === 0) return;
    connect((sock) => sock.send(JSON.stringify({ type: "browse" })), { silent: true });
  }

  async function fetchLobbies() {
    try {
      const res = await fetch(httpUrlFromWs(wsUrl, "/lobbies"));
      const data = await res.json();
      if (data && Array.isArray(data.lobbies)) setLobbies(data.lobbies);
    } catch {
      /* WS browse may still fill the list */
    }
  }

  function forgetSession() {
    sessionRef.current = null;
    setSavedGame(null);
    clearMpSession();
  }

  function rejoinSavedGame() {
    const sess = sessionRef.current || readMpSession();
    if (!sess) {
      setError("No game to rejoin");
      setDropped(false);
      return;
    }
    sessionRef.current = sess;
    setSavedGame(sess);
    setDropped(false);
    setError("");
    void (async () => {
      try {
        const payload = await clerkPayload();
        connect((ws) =>
          ws.send(
            JSON.stringify({
              type: "rejoin",
              code: sess.code,
              token: sess.token,
              ...payload,
            })
          )
        );
      } catch (e) {
        setError(clerkErrorText(e));
        setDropped(true);
      }
    })();
  }

  function exitToMenu() {
    closeSocket();
    if (dealTimerRef.current) clearTimeout(dealTimerRef.current);
    setChat([]);
    setReacts([]);
    onLeave();
  }

  function leaveOnline() {
    send({ type: "leave" });
    forgetSession();
    closeSocket();
    if (dealTimerRef.current) clearTimeout(dealTimerRef.current);
    setChat([]);
    setReacts([]);
    onLeave();
  }

  useEffect(() => {
    if (screen !== "pick" && screen !== "join") return;
    startBrowse();
    void fetchLobbies();
    const t = window.setInterval(() => {
      startBrowse();
      void fetchLobbies();
    }, 2000);
    return () => window.clearInterval(t);
  }, [screen, wsUrl]);

  useEffect(() => {
    if (!view || view.phase !== "dealing") {
      if (dealTimerRef.current) clearTimeout(dealTimerRef.current);
      setDealing(false);
      setLastStep(null);
      if (view) setDealProgress(fullDealProgress(view.players.length));
      return;
    }
    const n = view.players.length;
    setDealProgress({
      faceDown: Array.from({ length: n }, () => 0),
      faceUp: Array.from({ length: n }, () => 0),
      hand: Array.from({ length: n }, () => 0),
    });
    setDealing(true);
    const steps = buildDealSequence(n);
    let i = 0;
    function runStep() {
      const step = steps[i];
      if (!step || step.type === "done") {
        setDealing(false);
        setLastStep(null);
        return;
      }
      setLastStep(step);
      setDealProgress((prev) => {
        const next = {
          faceDown: [...prev.faceDown],
          faceUp: [...prev.faceUp],
          hand: [...prev.hand],
        };
        if (step.type === "faceDown") next.faceDown[step.player]++;
        else if (step.type === "faceUp") next.faceUp[step.player]++;
        else if (step.type === "hand") next.hand[step.player]++;
        return next;
      });
      i++;
      dealTimerRef.current = setTimeout(runStep, DEAL_STEP_MS);
    }
    dealTimerRef.current = setTimeout(runStep, 500);
    return () => {
      if (dealTimerRef.current) clearTimeout(dealTimerRef.current);
    };
  }, [view?.phase, view?.players.length]);

  useEffect(
    () => () => {
      closeSocket();
      clearTableAnims();
      if (dealTimerRef.current) clearTimeout(dealTimerRef.current);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    },
    []
  );

  const players = view?.players ?? [];
  const drawDeck = Array.from({ length: view?.deckCount ?? 0 }, () => "A♠");
  const tablePhase: Phase =
    !view || view.phase === "waiting"
      ? "lobby"
      : view.phase === "dealing"
        ? "dealing"
        : view.phase === "swap"
          ? "swap"
          : view.phase === "finished"
            ? "finished"
            : "playing";

  function onSelectHand(index: number) {
    if (!view) return;
    if (view.phase === "swap") {
      if (view.players[0]?.ready) return;
      const sel = selection;
      if (sel?.zone === "faceUp") {
        send({ type: "swap", hand: index, faceUp: sel.index });
        setSwapTick((t) => t + 1);
        setSelection(null);
      } else if (sel?.zone === "hand" && sel.index === index) setSelection(null);
      else setSelection({ zone: "hand", index });
      return;
    }
    if (view.phase !== "playing" || view.currentPlayer !== 0) return;
    const pl = view.players[0];
    if (activePlayZone(pl, view.deckCount) !== "hand") return;
    const rank = getRank(pl.hand[index]);
    setPlaySelected((prev) => {
      const curRank = playSelectionRank(pl, prev);
      if (prev.hand.includes(index)) return { hand: prev.hand.filter((i) => i !== index), faceUp: [] };
      if (!curRank || curRank !== rank) return { hand: [index], faceUp: [] };
      return { hand: [...prev.hand, index], faceUp: prev.faceUp };
    });
  }

  function onSelectFaceUp(index: number) {
    if (!view) return;
    if (view.phase === "swap") {
      if (view.players[0]?.ready) return;
      const sel = selection;
      if (sel?.zone === "hand") {
        send({ type: "swap", hand: sel.index, faceUp: index });
        setSwapTick((t) => t + 1);
        setSelection(null);
      } else if (sel?.zone === "faceUp" && sel.index === index) setSelection(null);
      else setSelection({ zone: "faceUp", index });
      return;
    }
    if (view.phase !== "playing" || view.currentPlayer !== 0) return;
    if (pickupAwaitTable) {
      send({ type: "pickup", tableTake: { zone: "faceUp", index } });
      setPickupAwaitTable(false);
      return;
    }
    const pl = view.players[0];
    const zone = activePlayZone(pl, view.deckCount);
    if (zone !== "faceUp" && zone !== "hand") return;
    const card = pl.faceUp[index];
    if (!card) return;
    const rank = getRank(card);
    if (zone === "hand") {
      if (!mayAttachFaceUp(pl, view.deckCount)) return;
      if (getRank(pl.hand[0]) !== rank) return;
    }
    setPlaySelected((prev) => {
      if (prev.faceUp.includes(index)) return { ...prev, faceUp: prev.faceUp.filter((i) => i !== index) };
      if (zone === "hand") return { hand: pl.hand.map((_, i) => i), faceUp: [...prev.faceUp, index] };
      const curRank = playSelectionRank(pl, prev);
      if (!curRank || curRank !== rank) return { hand: [], faceUp: [index] };
      return { hand: [], faceUp: [...prev.faceUp, index] };
    });
  }

  function onSelectFaceDown(index: number) {
    if (!view || view.phase !== "playing" || view.currentPlayer !== 0) return;
    if (pickupAwaitTable) {
      send({ type: "pickup", tableTake: { zone: "faceDown", index } });
      setPickupAwaitTable(false);
      return;
    }
    if (activePlayZone(view.players[0], view.deckCount) !== "faceDown") return;
    send({ type: "play", play: { faceDown: index } });
  }

  function onPlay() {
    if (!view || view.phase !== "playing" || view.currentPlayer !== 0) return;
    if (selectionCount(playSelected) === 0) return;
    send({ type: "play", play: { hand: playSelected.hand, faceUp: playSelected.faceUp } });
    setPlaySelected(emptyPlay());
  }

  function onPickUp() {
    if (!view || view.phase !== "playing" || view.currentPlayer !== 0) return;
    if (view.discard.length === 0) return;
    if (canTakeTableWithPickup(view.players[0])) {
      setPickupAwaitTable(true);
      setPlaySelected(emptyPlay());
      return;
    }
    send({ type: "pickup", tableTake: null });
  }

  const formShell = (children: ReactNode, skin: TableSkinId = "felt") => (
    <FeltShell
      skin={skin}
      center
      overlay={
        <>
          <WindowButton />
          <LobbyBack onClick={exitToMenu} />
          <ProfileButton />
        </>
      }
      style={{ padding: "max(40px, calc(env(safe-area-inset-top) + 22px)) 16px max(56px, calc(env(safe-area-inset-bottom) + 40px))" }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          padding: "20px 8px 8px",
          textAlign: "center",
        }}
      >
        {children}
        {error ? <div style={{ color: "#f5b7b1", fontSize: 13, maxWidth: 300, lineHeight: 1.4 }}>{error}</div> : null}
      </div>
    </FeltShell>
  );

  const droppedOverlay = dropped ? (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.58)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 320,
          borderRadius: 14,
          background: "#145230",
          border: "1px solid rgba(255,255,255,0.22)",
          padding: "22px 18px",
          textAlign: "center",
        }}
      >
        <div style={{ color: "#f5f0e6", fontWeight: 800, fontSize: 18, marginBottom: 8 }}>Connection lost</div>
        <div style={{ color: "rgba(255,255,255,0.72)", fontSize: 13, lineHeight: 1.4, marginBottom: 16 }}>
          Your seat is saved. Rejoin this game when you're back online.
        </div>
        <button
          type="button"
          className="lobby-play-btn"
          style={{ ...LOBBY_GOLD_BTN, marginBottom: 10 }}
          disabled={busy}
          onClick={rejoinSavedGame}
        >
          {busy ? "Rejoining…" : savedGame ? `Rejoin ${savedGame.code}` : "Rejoin game"}
        </button>
        <button
          type="button"
          onClick={leaveOnline}
          style={{
            background: "transparent",
            border: "1.5px solid rgba(255,255,255,0.35)",
            color: "#f5f0e6",
            borderRadius: 10,
            height: 44,
            width: "100%",
            maxWidth: 300,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Leave game
        </button>
      </div>
    </div>
  ) : null;

  if (screen === "pick") {
    return formShell(
      <>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#f5f0e6", fontFamily: 'Georgia, "Times New Roman", serif' }}>
          Multiplayer
        </div>
        {auth.user ? (
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>
            Playing as {clerkNickname(auth.user)}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", maxWidth: 300, lineHeight: 1.4 }}>
            Sign in with Google first — button at the top right.
          </div>
        )}
        <button
          type="button"
          className="lobby-play-btn"
          style={LOBBY_GOLD_BTN}
          onClick={() => {
            if (!auth.user) {
              setError("Sign in with Google first");
              return;
            }
            setScreen("create");
          }}
        >
          Create lobby
        </button>
        <button
          type="button"
          className="lobby-play-btn"
          style={LOBBY_GOLD_BTN}
          onClick={() => {
            if (!auth.user) {
              setError("Sign in with Google first");
              return;
            }
            setScreen("join");
          }}
        >
          Join lobby
        </button>
        {savedGame ? (
          <button
            type="button"
            className="lobby-play-btn"
            style={LOBBY_GOLD_BTN}
            disabled={busy}
            onClick={() => {
              if (!auth.user) {
                setError("Sign in with Google first");
                return;
              }
              rejoinSavedGame();
            }}
          >
            {busy ? "Rejoining…" : `Rejoin ${savedGame.code}`}
          </button>
        ) : null}
        <OpenLobbyList
          lobbies={lobbies}
          busy={busy}
          onJoin={(c) => {
            if (!auth.user) {
              setError("Sign in with Google first");
              return;
            }
            joinByCode(c);
          }}
        />
      </>
    );
  }

  if (screen === "create") {
    return formShell(
      <>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#f5f0e6", fontFamily: 'Georgia, "Times New Roman", serif' }}>
          New lobby
        </div>
        {auth.user ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AvatarBubble src={auth.user.imageUrl} name={clerkNickname(auth.user)} size={36} />
            <div style={{ color: "#f5f0e6", fontWeight: 700 }}>{clerkNickname(auth.user)}</div>
          </div>
        ) : (
          <input
            value={name}
            onChange={(e) => persistName(e.target.value)}
            placeholder="Your name"
            maxLength={18}
            style={LOBBY_INPUT}
          />
        )}
        <button
          type="button"
          className="lobby-play-btn"
          style={LOBBY_GOLD_BTN}
          disabled={busy}
          onClick={createLobby}
        >
          {busy ? "Connecting…" : "Create"}
        </button>
      </>
    );
  }

  if (screen === "join") {
    return formShell(
      <>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#f5f0e6", fontFamily: 'Georgia, "Times New Roman", serif' }}>
          Join lobby
        </div>
        {auth.user ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AvatarBubble src={auth.user.imageUrl} name={clerkNickname(auth.user)} size={36} />
            <div style={{ color: "#f5f0e6", fontWeight: 700 }}>{clerkNickname(auth.user)}</div>
          </div>
        ) : (
          <input
            value={name}
            onChange={(e) => persistName(e.target.value)}
            placeholder="Your name"
            maxLength={18}
            style={LOBBY_INPUT}
          />
        )}
        <OpenLobbyList lobbies={lobbies} busy={busy} onJoin={joinByCode} />
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.4, textTransform: "uppercase", color: "rgba(255,255,255,0.55)" }}>
          Or enter a code
        </div>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
          placeholder="Code"
          maxLength={8}
          autoCapitalize="characters"
          style={{ ...LOBBY_INPUT, letterSpacing: 4, fontWeight: 700 }}
        />
        <button
          type="button"
          className="lobby-play-btn"
          style={LOBBY_GOLD_BTN}
          disabled={busy}
          onClick={joinLobby}
        >
          {busy ? "Connecting…" : "Join"}
        </button>
      </>
    );
  }

  if (screen === "waiting" && view) {
    const waitSkin = isTableSkin(view.tableSkin) ? view.tableSkin : "felt";
    return formShell(
      <>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#f5f0e6", fontFamily: 'Georgia, "Times New Roman", serif' }}>
          Lobby code
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(view.code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          style={{
            ...LOBBY_GOLD_BTN,
            height: 64,
            fontSize: 32,
            letterSpacing: 8,
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          {view.code}
        </button>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
          {copied ? "Copied" : "Tap the code to copy"}
        </div>
        <div style={{ width: "100%", maxWidth: 300, display: "flex", flexDirection: "column", gap: 6 }}>
          {view.lobby.map((p) => (
            <div
              key={p.id}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.28)",
                color: "#f5f0e6",
                display: "flex",
                justifyContent: "space-between",
                fontSize: 14,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <AvatarBubble src={p.avatar} name={p.name} size={24} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.name}
                  {p.host ? " · host" : ""}
                </span>
              </span>
              <span style={{ opacity: 0.65 }}>{p.connected ? "online" : "offline"}</span>
            </div>
          ))}
        </div>
        <TableSkinPicker
          value={waitSkin}
          disabled={!view.host}
          onChange={(id) => send({ type: "skin", skin: id })}
        />
        <RoomChat
          variant="lobby"
          lines={chat}
          youId={view.youId}
          onSend={(text) => send({ type: "chat", text })}
        />
        {view.host ? (
          <button
            type="button"
            className="lobby-play-btn"
            style={LOBBY_GOLD_BTN}
            disabled={!view.canStart}
            onClick={() => send({ type: "start" })}
          >
            {view.canStart ? "Start game" : "Waiting for another player"}
          </button>
        ) : (
          <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 14 }}>Waiting for the host to start</div>
        )}
        {droppedOverlay}
      </>,
      waitSkin
    );
  }

  if (screen === "table" && view) {
    return (
      <>
        {droppedOverlay}
      <Table
        players={players}
        drawDeck={drawDeck}
        discard={view.discard}
        phase={tablePhase}
        dealing={dealing && view.phase === "dealing"}
        dealProgress={view.phase === "dealing" ? dealProgress : fullDealProgress(players.length)}
        lastStep={lastStep}
        swapSeconds={view.swapSeconds}
        selection={selection}
        swapTick={swapTick}
        currentPlayer={view.currentPlayer}
        playSelected={playSelected}
        statusMsg={view.statusMsg}
        finishOrder={view.finishOrder}
        flyAnim={flyAnim}
        burnCount={view.burnCount}
        burnAnim={burnAnim}
        pickupAnim={pickupAnim}
        drawAnim={drawAnim}
        revealCard={revealCard}
        pickupAwaitTable={pickupAwaitTable}
        onSelectHand={onSelectHand}
        onSelectFaceUp={onSelectFaceUp}
        onSelectFaceDown={onSelectFaceDown}
        onReady={() => send({ type: "ready" })}
        onPlay={onPlay}
        onPickUp={onPickUp}
        onPickUpOnly={() => {
          send({ type: "pickup", tableTake: null });
          setPickupAwaitTable(false);
        }}
        onCancelPickupAwait={() => setPickupAwaitTable(false)}
        onReset={leaveOnline}
        resetLabel="← Leave"
        tableSkin={isTableSkin(view.tableSkin) ? view.tableSkin : "felt"}
        chat={chat}
        youId={view.youId}
        onSendChat={(text) => send({ type: "chat", text })}
        reacts={reacts}
        onSendReact={(emoji) => send({ type: "react", emoji })}
        onToLobby={view.phase === "finished" ? () => send({ type: "lobby" }) : undefined}
      />
      </>
    );
  }

  return formShell(<div style={{ color: "#f5f0e6" }}>Connecting…</div>);
}

// ─── Root ────────────────────────────────────────────────────────────────────

export default function CardGame() {
  const [online, setOnline] = useState(false);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [drawDeck, setDrawDeck] = useState<string[]>([]);
  const [discard, setDiscard] = useState<string[]>([]);
  const [dealing, setDealing] = useState(false);
  const [dealProgress, setDealProgress] = useState<{
    faceDown: number[];
    faceUp: number[];
    hand: number[];
  }>({ faceDown: [], faceUp: [], hand: [] });
  const [lastStep, setLastStep] = useState<DealStep | null>(null);
  const [swapSeconds, setSwapSeconds] = useState(SWAP_SECONDS);
  const [selection, setSelection] = useState<Selection>(null);
  const [swapTick, setSwapTick] = useState(0);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [playSelected, setPlaySelected] = useState<CombinedPlay>(emptyPlay);
  const [statusMsg, setStatusMsg] = useState("");
  const [finishOrder, setFinishOrder] = useState<number[]>([]);
  const [flyAnim, setFlyAnim] = useState<FlyAnim | null>(null);
  const [burnCount, setBurnCount] = useState(0);
  const [burnAnim, setBurnAnim] = useState<BurnAnim | null>(null);
  const [pickupAnim, setPickupAnim] = useState<PickupAnim | null>(null);
  const [drawAnim, setDrawAnim] = useState<DrawAnim | null>(null);
  const [revealCard, setRevealCard] = useState<string | null>(null);
  const [pickupAwaitTable, setPickupAwaitTable] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  const [tutStep, setTutStep] = useState(0);

  const stepRef = useRef(0);
  const dealStepsRef = useRef<DealStep[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swapIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aiTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const flyIdRef = useRef(0);
  const playLockRef = useRef(false);
  const playersRef = useRef(players);
  const drawDeckRef = useRef(drawDeck);
  const discardRef = useRef(discard);
  const currentPlayerRef = useRef(currentPlayer);
  const finishOrderRef = useRef(finishOrder);
  const phaseRef = useRef(phase);
  const tutorialRef = useRef(tutorial);
  const tutStepRef = useRef(tutStep);
  playersRef.current = players;
  finishOrderRef.current = finishOrder;
  drawDeckRef.current = drawDeck;
  discardRef.current = discard;
  currentPlayerRef.current = currentPlayer;
  phaseRef.current = phase;
  tutorialRef.current = tutorial;
  tutStepRef.current = tutStep;

  function tutStepNow(): TutStep | null {
    if (!tutorialRef.current) return null;
    return TUTORIAL_STEPS[tutStepRef.current] ?? null;
  }

  function tutLocked(): boolean {
    return !!(tutorialRef.current && tutorialLockedAt(tutStepRef.current));
  }

  function advanceTutorial() {
    const next = Math.min(tutStepRef.current + 1, TUTORIAL_STEPS.length - 1);
    tutStepRef.current = next;
    setTutStep(next);
  }

  function maybeAdvanceTutorialAfterPlay(playerIndex: number) {
    if (!tutorialRef.current) return;
    const step = TUTORIAL_STEPS[tutStepRef.current];
    if (!step) return;
    if (playerIndex === 0 && step.wait === "play") advanceTutorial();
    if (playerIndex === 1 && step.wait === "coach") advanceTutorial();
  }

  function skipTutorial() {
    if (!tutorialRef.current) return;
    const free = tutorialFreeIndex();
    tutStepRef.current = free;
    setTutStep(free);
    const ph = phaseRef.current;
    if (ph === "dealing" || ph === "swap") {
      clearTimers();
      playLockRef.current = false;
      setDealing(false);
      setLastStep(null);
      const n = Math.max(playersRef.current.length, 2);
      setDealProgress({
        faceDown: Array(n).fill(3),
        faceUp: Array(n).fill(3),
        hand: Array(n).fill(3),
      });
      const ready = playersRef.current.map((p) => ({ ...p, ready: true }));
      setPlayers(ready);
      beginPlaying(ready);
    }
  }

  useEffect(() => {
    ensureKeyframes();
  }, []);

  function clearTimers() {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (swapIntervalRef.current) clearInterval(swapIntervalRef.current);
    aiTimersRef.current.forEach(clearTimeout);
    aiTimersRef.current = [];
  }

  function clearAnimState() {
    setFlyAnim(null);
    setBurnAnim(null);
    setPickupAnim(null);
    setDrawAnim(null);
    setRevealCard(null);
  }

  function finalizeAfterPlay(
    playerIndex: number,
    result: {
      players: PlayerState[];
      extraTurn: boolean;
      won: boolean;
    }
  ) {
    clearAnimState();
    playLockRef.current = false;

    if (result.won) {
      const standing = resolveStandings(playerIndex, result.players, finishOrderRef.current);
      setFinishOrder(standing.order);
      finishOrderRef.current = standing.order;
      const msg = `${result.players[playerIndex].name} — ${placeLabel(standing.place, result.players.length)}!`;
      setStatusMsg(msg);

      if (standing.gameOver) {
        setPhase("finished");
        setStatusMsg("Game over");
        return;
      }
      advanceTurn(playerIndex, result.players, false);
      const stillIn = unfinishedPlayers(result.players).length;
      setStatusMsg(`${result.players[playerIndex].name} is out · ${stillIn} still in`);
      return;
    }

    advanceTurn(playerIndex, result.players, result.extraTurn);
    maybeAdvanceTutorialAfterPlay(playerIndex);
  }

  function runPickupSequence(
    pickup: { cards: string[]; toPlayer: number; hideFaces: boolean },
    playerCount: number,
    onDone: () => void
  ) {
    flyIdRef.current += 1;
    setPickupAnim({
      id: flyIdRef.current,
      cards: pickup.cards,
      toPlayer: pickup.toPlayer,
      playerCount,
      hideFaces: pickup.hideFaces,
    });
    const delay = PICKUP_MS + Math.min(pickup.cards.length, 8) * 40;
    const t = setTimeout(() => {
      setPickupAnim(null);
      onDone();
    }, delay);
    aiTimersRef.current.push(t);
  }

  function commitPickupToHand(playerIndex: number, cards: string[], pls: PlayerState[]) {
    const playersNext = pls.map((p, i) =>
      i === playerIndex ? { ...p, hand: sortHand([...p.hand, ...cards]) } : p
    );
    setPlayers(playersNext);
    setDiscard([]);
    return playersNext;
  }

  function commitDrawToHand(playerIndex: number, cards: string[], pls: PlayerState[]) {
    if (cards.length === 0) return pls;
    const playersNext = pls.map((p, i) =>
      i === playerIndex ? { ...p, hand: sortHand([...p.hand, ...cards]) } : p
    );
    setPlayers(playersNext);
    return playersNext;
  }

  function runPlayResult(
    playerIndex: number,
    result: {
      players: PlayerState[];
      deck: string[];
      discard: string[];
      extraTurn: boolean;
      won: boolean;
      message: string;
      played: string[];
      willBurn: boolean;
      burnCards: string[];
      pickup: { cards: string[]; toPlayer: number; hideFaces: boolean } | null;
      privateReveal: string | null;
      drawn: string[];
    },
    animate: boolean
  ) {
    setPlayers(result.players);
    setDrawDeck(result.deck);
    setDiscard(result.discard);
    setPlaySelected(emptyPlay());
    setStatusMsg(result.message);
    playLockRef.current = true;

    const finishPlay = (pls: PlayerState[]) => {
      finalizeAfterPlay(playerIndex, { ...result, players: pls });
    };

    const startDrawIfNeeded = (pls: PlayerState[] = result.players) => {
      if (result.drawn.length === 0) {
        finishPlay(pls);
        return;
      }
      if (!animate) {
        finishPlay(commitDrawToHand(playerIndex, result.drawn, pls));
        return;
      }
      flyIdRef.current += 1;
      setDrawAnim({
        id: flyIdRef.current,
        cards: result.drawn,
        toPlayer: playerIndex,
        playerCount: pls.length,
      });
      const t = setTimeout(() => {
        setDrawAnim(null);
        finishPlay(commitDrawToHand(playerIndex, result.drawn, pls));
      }, DRAW_MS + Math.max(0, result.drawn.length - 1) * DRAW_STAGGER_MS);
      aiTimersRef.current.push(t);
    };

    const afterPlayOrBurn = () => {
      if (result.willBurn && result.burnCards.length > 0) {
        flyIdRef.current += 1;
        setBurnAnim({ id: flyIdRef.current, cards: result.burnCards });
        const burnDelay = BURN_MS + Math.min(result.burnCards.length, 6) * 35;
        const t = setTimeout(() => {
          setBurnAnim(null);
          setDiscard([]);
          setBurnCount((c) => c + result.burnCards.length);
          startDrawIfNeeded();
        }, burnDelay);
        aiTimersRef.current.push(t);
        return;
      }
      startDrawIfNeeded();
    };

    const startPickupIfNeeded = () => {
      if (!result.pickup) {
        afterPlayOrBurn();
        return;
      }
      const cards = result.pickup.cards;
      runPickupSequence(result.pickup, result.players.length, () => {
        const next = commitPickupToHand(result.pickup!.toPlayer, cards, result.players);
        finalizeAfterPlay(playerIndex, { ...result, players: next, extraTurn: false, won: false });
      });
    };

    const startRevealOrPickup = () => {
      if (result.privateReveal) {
        setRevealCard(result.privateReveal);
        const t = setTimeout(() => {
          setRevealCard(null);
          startPickupIfNeeded();
        }, REVEAL_MS);
        aiTimersRef.current.push(t);
        return;
      }
      startPickupIfNeeded();
    };

    // Failed face-down / pickup path (no cards successfully played onto discard via fly)
    if (result.pickup && result.played.length === 0) {
      if (animate) {
        startRevealOrPickup();
      } else {
        const next = commitPickupToHand(
          result.pickup.toPlayer,
          result.pickup.cards,
          result.players
        );
        finalizeAfterPlay(playerIndex, { ...result, players: next, extraTurn: false, won: false });
      }
      return;
    }

    if (animate && result.played.length > 0) {
      flyIdRef.current += 1;
      setFlyAnim({
        id: flyIdRef.current,
        cards: result.played,
        fromPlayer: playerIndex,
        playerCount: result.players.length,
      });
      const t = setTimeout(() => {
        if (result.willBurn && result.burnCards.length > 0) {
          const pause = setTimeout(() => {
            setFlyAnim(null);
            afterPlayOrBurn();
          }, LAND_PAUSE_MS);
          aiTimersRef.current.push(pause);
        } else {
          setFlyAnim(null);
          afterPlayOrBurn();
        }
      }, FLY_MS + result.played.length * 55);
      aiTimersRef.current.push(t);
    } else {
      afterPlayOrBurn();
    }
  }

  function runPickUpResult(playerIndex: number, cards: string[], pls: PlayerState[], message: string) {
    if (cards.length === 0) {
      setStatusMsg(message);
      return;
    }
    playLockRef.current = true;
    setStatusMsg(message);
    setPlaySelected(emptyPlay());
    // Keep discard visible until overlay starts (displayDiscard clears during pickupAnim)
    runPickupSequence(
      {
        cards,
        toPlayer: playerIndex,
        hideFaces: playerIndex !== 0,
      },
      pls.length,
      () => {
        const next = commitPickupToHand(playerIndex, cards, pls);
        clearAnimState();
        playLockRef.current = false;
        advanceTurn(playerIndex, next, false);
      }
    );
  }

  function nextAlive(from: number, pls: PlayerState[]): number {
    const n = pls.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (!playerFinished(pls[idx])) return idx;
    }
    return from;
  }

  function beginPlaying(pls: PlayerState[]) {
    const first = tutorialRef.current ? 0 : Math.floor(Math.random() * pls.length);
    setCurrentPlayer(first);
    setDiscard([]);
    setBurnCount(0);
    clearAnimState();
    setPickupAwaitTable(false);
    setPlaySelected(emptyPlay());
    setFinishOrder([]);
    setPhase("playing");
    setStatusMsg(`Turn: ${pls[first].name}`);
  }

  function markReady(playerIndex: number) {
    setPlayers((prev) => {
      if (prev[playerIndex]?.ready) return prev;
      const next = prev.map((p, i) => (i === playerIndex ? { ...p, ready: true } : p));
      if (next.every((p) => p.ready)) {
        if (swapIntervalRef.current) clearInterval(swapIntervalRef.current);
        setTimeout(() => beginPlaying(next), 400);
      }
      return next;
    });
    if (playerIndex === 0) setSelection(null);
  }

  function beginSwapPhase(playerCount: number) {
    setPhase("swap");
    setSelection(null);

    if (tutorialRef.current) {
      setStatusMsg("Card swap");
      const t = setTimeout(() => markReady(1), 350);
      aiTimersRef.current.push(t);
      return;
    }

    setSwapSeconds(SWAP_SECONDS);
    setStatusMsg("Card swap — 20 seconds");

    swapIntervalRef.current = setInterval(() => {
      setSwapSeconds((s) => {
        if (s <= 1) {
          if (swapIntervalRef.current) clearInterval(swapIntervalRef.current);
          setPlayers((prev) => {
            const next = prev.map((p) => ({ ...p, ready: true }));
            setTimeout(() => beginPlaying(next), 400);
            return next;
          });
          setSelection(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    for (let p = 1; p < playerCount; p++) {
      const delay = 1500 + Math.random() * 8000;
      const t = setTimeout(() => {
        setPlayers((prev) => {
          if (prev[p]?.ready) return prev;
          let updated = [...prev];
          const swapCount = Math.floor(Math.random() * 4);
          const usedHand = new Set<number>();
          const usedFace = new Set<number>();
          for (let s = 0; s < swapCount; s++) {
            const handOpts = [0, 1, 2].filter((i) => !usedHand.has(i));
            const faceOpts = [0, 1, 2].filter((i) => !usedFace.has(i));
            if (!handOpts.length || !faceOpts.length) break;
            const hi = handOpts[Math.floor(Math.random() * handOpts.length)];
            const fi = faceOpts[Math.floor(Math.random() * faceOpts.length)];
            usedHand.add(hi);
            usedFace.add(fi);
            updated = updated.map((pl, idx) => (idx === p ? swapPlayerCards(pl, hi, fi) : pl));
          }
          return updated;
        });
        const t2 = setTimeout(() => markReady(p), 600 + Math.random() * 2500);
        aiTimersRef.current.push(t2);
      }, delay);
      aiTimersRef.current.push(t);
    }
  }

  /** Apply a play for playerIndex. Returns whether they get another turn (burn). */
  function applyPlay(
    playerIndex: number,
    play: { hand?: number[]; faceUp?: number[]; faceDown?: number },
    pls: PlayerState[],
    deck: string[],
    pile: string[]
  ): {
    players: PlayerState[];
    deck: string[];
    discard: string[];
    extraTurn: boolean;
    won: boolean;
    message: string;
    played: string[];
    willBurn: boolean;
    burnCards: string[];
    pickup: { cards: string[]; toPlayer: number; hideFaces: boolean } | null;
    privateReveal: string | null;
    drawn: string[];
  } {
    let playersNext = pls.map((p) => ({
      ...p,
      hand: [...p.hand],
      faceUp: [...p.faceUp],
      faceDown: [...p.faceDown],
    }));
    let deckNext = [...deck];
    let discardNext = [...pile];
    const pl = playersNext[playerIndex];
    let played: string[] = [];
    let message = "";

    if (play.faceDown !== undefined) {
      const idx = play.faceDown;
      const card = pl.faceDown[idx];
      if (card === null || pl.faceUp[idx] !== null) {
        return {
          players: pls,
          deck,
          discard: pile,
          extraTurn: false,
          won: false,
          message: "That card is still covered by a face-up card",
          played: [],
          willBurn: false,
          burnCards: [],
          pickup: null,
          privateReveal: null,
          drawn: [],
        };
      }
      const faceDown = [...pl.faceDown];
      faceDown[idx] = null;
      pl.faceDown = faceDown;
      if (!canPlayCards([card], discardNext)) {
        const label = `${getRank(card)}${card.slice(-1)}`;
        const isHuman = playerIndex === 0;
        const taken = [...discardNext, card];
        // Human sees the revealed card on the pile; opponents must not learn AI's failed card
        discardNext = isHuman ? taken : [...discardNext];
        message = isHuman
          ? `You flipped ${label} — can't play, take the discard`
          : `${pl.name} flipped a card — can't play, takes the discard`;
        playersNext[playerIndex] = pl;
        return {
          players: playersNext,
          deck: deckNext,
          discard: discardNext,
          extraTurn: false,
          won: false,
          message,
          played: [],
          willBurn: false,
          burnCards: [],
          pickup: { cards: taken, toPlayer: playerIndex, hideFaces: !isHuman },
          privateReveal: isHuman ? card : null,
          drawn: [],
        };
      }
      played = [card];
    } else {
      const handIdx = play.hand ?? [];
      const faceIdx = play.faceUp ?? [];
      const fail = (message: string) => ({
        players: pls,
        deck,
        discard: pile,
        extraTurn: false,
        won: false,
        message,
        played: [] as string[],
        willBurn: false,
        burnCards: [] as string[],
        pickup: null,
        privateReveal: null,
        drawn: [] as string[],
      });
      if (handIdx.length === 0 && faceIdx.length === 0) {
        return fail("Can't play that");
      }
      if (pl.hand.length > 0 && handIdx.length === 0) {
        return fail("Choose cards from your hand first");
      }
      if (faceIdx.length > 0 && pl.hand.length > 0) {
        if (!canCombineHandWithFaceUp(pl, deckNext.length, handIdx)) {
          return fail("Face-up combo only with your last hand cards when the deck is empty");
        }
      }

      const removed: string[] = [];
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
        return fail("Can't play that");
      }
      played = removed;
    }

    const rank = getRank(played[0]);
    discardNext = [...discardNext, ...played];
    message = `${pl.name}: ${played.map((c) => getRank(c) + c.slice(-1)).join(", ")}`;

    if (rank === "7") {
      const under = getEffectiveTop(discardNext);
      if (under) {
        message += ` · under 7: ${getRank(under)}${under.slice(-1)}`;
      } else {
        message += " · nothing under 7";
      }
    }

    let extraTurn = false;
    let willBurn = false;
    let burnCards: string[] = [];
    if (shouldBurnAfterPlay(discardNext, rank)) {
      willBurn = true;
      burnCards = [...discardNext];
      // Keep discard for play animation; cleared after burn flight
      extraTurn = true;
      message += " — discard burned!";
    }

    let drawn: string[] = [];
    if (deckNext.length > 0) {
      const refilled = refillHand(pl.hand, deckNext);
      drawn = refilled.drawn;
      deckNext = refilled.deck;
    }
    pl.hand = sortHand(pl.hand);

    playersNext[playerIndex] = pl;
    const won = playerFinished({ ...pl, hand: sortHand([...pl.hand, ...drawn]) });
    if (won) message = `${pl.name} is out!`;

    return {
      players: playersNext,
      deck: deckNext,
      discard: discardNext,
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

  function applyPickUp(
    playerIndex: number,
    pls: PlayerState[],
    pile: string[],
    tableTake?: TableTake | null
  ) {
    if (pile.length === 0) {
      return {
        players: pls,
        discard: pile,
        message: "Discard is empty",
        pickupCards: [] as string[],
      };
    }

    const playersNext = pls.map((p) => ({
      ...p,
      hand: [...p.hand],
      faceUp: [...p.faceUp],
      faceDown: [...p.faceDown],
    }));
    const pl = playersNext[playerIndex];
    const extras: string[] = [];

    if (tableTake) {
      if (pl.hand.length > 0) {
        return {
          players: pls,
          discard: pile,
          message: "You can only take a table card with an empty hand",
          pickupCards: [] as string[],
        };
      }
      if (tableTake.zone === "faceUp") {
        const card = pl.faceUp[tableTake.index];
        if (card === null) {
          return {
            players: pls,
            discard: pile,
            message: "No such face-up card",
            pickupCards: [] as string[],
          };
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
          return {
            players: pls,
            discard: pile,
            message: "No such face-down card",
            pickupCards: [] as string[],
          };
        }
        const faceDown = [...pl.faceDown];
        faceDown[tableTake.index] = null;
        pl.faceDown = faceDown;
        extras.push(card);
      }
    }

    playersNext[playerIndex] = pl;
    const pickupCards = [...pile, ...extras];
    const tableNote =
      extras.length > 0
        ? tableTake!.zone === "faceDown"
          ? " + 1 face-down from the table"
          : extras.length === 1
            ? ` + ${getRank(extras[0])}${extras[0].slice(-1)} from the table`
            : ` + ${extras.length}×${getRank(extras[0])} from the table`
        : "";
    return {
      players: playersNext,
      discard: pile,
      message: `${pls[playerIndex].name} takes the discard (${pile.length})${tableNote}`,
      pickupCards,
    };
  }

  function advanceTurn(from: number, pls: PlayerState[], extraTurn: boolean) {
    if (extraTurn && !playerFinished(pls[from])) {
      setCurrentPlayer(from);
      setStatusMsg(`Turn: ${pls[from].name} (again)`);
      return from;
    }
    const nxt = nextAlive(from, pls);
    setCurrentPlayer(nxt);
    setStatusMsg(`Turn: ${pls[nxt].name}`);
    return nxt;
  }

  // AI turns
  useEffect(() => {
    if (phase !== "playing") return;
    if (currentPlayer === 0) return;
    if (tutorialRef.current && tutorialLockedAt(tutStepRef.current)) return;
    if (flyAnim || burnAnim || pickupAnim || revealCard || drawAnim) return;
    if (playerFinished(players[currentPlayer])) return;

    const t = setTimeout(() => {
      const pls = playersRef.current;
      const deck = drawDeckRef.current;
      const pile = discardRef.current;
      const pIdx = currentPlayerRef.current;
      if (pIdx === 0 || phaseRef.current !== "playing") return;
      if (playLockRef.current) return;
      if (tutorialRef.current && tutorialLockedAt(tutStepRef.current)) return;

      const choice = aiChoosePlay(pls[pIdx], pile, deck.length);
      if (!choice) {
        const tableTake = aiChooseTableTake(pls[pIdx]);
        const result = applyPickUp(pIdx, pls, pile, tableTake);
        if (result.pickupCards.length === 0) {
          setStatusMsg(result.message);
          return;
        }
        setPlayers(result.players);
        runPickUpResult(pIdx, result.pickupCards, result.players, result.message);
        return;
      }

      const play =
        choice.kind === "faceDown"
          ? { faceDown: choice.index }
          : { hand: choice.hand, faceUp: choice.faceUp };
      const result = applyPlay(pIdx, play, pls, deck, pile);
      const shouldFly = result.played.length > 0 || !!result.pickup;
      runPlayResult(pIdx, result, shouldFly);
    }, 700 + Math.random() * 500);

    return () => clearTimeout(t);
  }, [phase, currentPlayer, finishOrder, discard, players, drawDeck, flyAnim, burnAnim, pickupAnim, revealCard, drawAnim, tutorial, tutStep]);

  useEffect(() => {
    if (!tutorial) return;
    const step = TUTORIAL_STEPS[tutStep];
    if (step?.wait === "dealing" && phase === "swap") {
      advanceTutorial();
    }
  }, [tutorial, tutStep, phase]);

  useEffect(() => {
    if (!tutorial) return;
    if (phase !== "playing") return;
    if (flyAnim || burnAnim || pickupAnim || revealCard || drawAnim) return;
    const step = TUTORIAL_STEPS[tutStep];
    if (!step || (step.wait !== "coach" && step.wait !== "play")) return;
    if (currentPlayer !== 1) return;

    let cancelled = false;
    const tryCoachPlay = () => {
      if (cancelled || playLockRef.current) return;
      if (currentPlayerRef.current !== 1 || phaseRef.current !== "playing") return;
      const pls = playersRef.current;
      const deck = drawDeckRef.current;
      const pile = discardRef.current;
      const coach = pls[1];
      if (!coach || playerFinished(coach)) return;

      let play: { hand: number[]; faceUp: number[] } | { faceDown: number } | null = null;
      if (step.wait === "coach" && step.coachRank) {
        const idx = coach.hand.findIndex((c) => getRank(c) === step.coachRank);
        if (idx >= 0) play = { hand: [idx], faceUp: [] };
      }
      if (!play) {
        const choice = aiChoosePlay(coach, pile, deck.length);
        if (!choice) return;
        play =
          choice.kind === "faceDown"
            ? { faceDown: choice.index }
            : { hand: choice.hand, faceUp: choice.faceUp };
      }

      const result = applyPlay(1, play, pls, deck, pile);
      if (result.played.length === 0 && !result.pickup) return;
      runPlayResult(1, result, true);
    };

    const t = setTimeout(tryCoachPlay, 700);
    const iv = setInterval(tryCoachPlay, 850);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [tutorial, tutStep, phase, currentPlayer, flyAnim, burnAnim, pickupAnim, revealCard, drawAnim]);

  const startGame = useCallback((playerCount: number, asTutorial = false) => {
    void enterFullscreen();
    clearTimers();
    tutorialRef.current = asTutorial;
    tutStepRef.current = asTutorial ? 0 : 0;
    setTutorial(asTutorial);
    setTutStep(asTutorial ? 0 : 0);
    const count = asTutorial ? 2 : playerCount;
    const deck = asTutorial ? buildTutorialDeck() : shuffle(buildDeck());
    let cursor = 0;

    const newPlayers: PlayerState[] = Array.from({ length: count }, (_, i) => ({
      name: i === 0 ? "You" : asTutorial ? "Coach" : `Player ${i + 1}`,
      faceDown: [],
      faceUp: [],
      hand: [],
      ready: false,
    }));

    for (let slot = 0; slot < 3; slot++)
      for (let p = 0; p < count; p++) newPlayers[p].faceDown.push(deck[cursor++]);
    for (let slot = 0; slot < 3; slot++)
      for (let p = 0; p < count; p++) newPlayers[p].faceUp.push(deck[cursor++]);
    for (let slot = 0; slot < 3; slot++)
      for (let p = 0; p < count; p++) newPlayers[p].hand.push(deck[cursor++]);

    for (const p of newPlayers) p.hand = sortHand(p.hand);

    const remaining = deck.slice(cursor);
    setPlayers(newPlayers);
    setDrawDeck(remaining);
    setDiscard([]);
    setDealProgress({
      faceDown: newPlayers.map(() => 0),
      faceUp: newPlayers.map(() => 0),
      hand: newPlayers.map(() => 0),
    });
    setDealing(true);
    setLastStep(null);
    setSelection(null);
    setSwapTick(0);
    setPlaySelected(emptyPlay());
    setFinishOrder([]);
    setStatusMsg("Dealing...");
    clearAnimState();
    setBurnCount(0);
    setPickupAwaitTable(false);
    setPhase("dealing");

    const steps = buildDealSequence(count);
    dealStepsRef.current = steps;
    stepRef.current = 0;

    function runStep() {
      const step = dealStepsRef.current[stepRef.current];
      if (!step || step.type === "done") {
        setDealing(false);
        setLastStep(null);
        beginSwapPhase(count);
        return;
      }
      setLastStep(step);
      setDealProgress((prev) => {
        const next = {
          faceDown: [...prev.faceDown],
          faceUp: [...prev.faceUp],
          hand: [...prev.hand],
        };
        if (step.type === "faceDown") next.faceDown[step.player]++;
        else if (step.type === "faceUp") next.faceUp[step.player]++;
        else if (step.type === "hand") next.hand[step.player]++;
        return next;
      });
      stepRef.current++;
      timerRef.current = setTimeout(runStep, DEAL_STEP_MS);
    }

    timerRef.current = setTimeout(runStep, 500);
  }, []);

  function handleSelectHand(index: number) {
    if (phase === "swap") {
      if (playersRef.current[0]?.ready) return;
      const step = tutStepNow();
      const pl = playersRef.current[0];
      if (tutLocked()) {
        if (step?.wait !== "swap" || !step.rank || !step.faceRank) return;
        const handRank = getRank(pl.hand[index]);
        if (selection?.zone === "faceUp") {
          const face = pl.faceUp[selection.index];
          if (!face || handRank !== step.rank || getRank(face) !== step.faceRank) return;
        } else if (handRank !== step.rank) {
          return;
        }
      }
      const sel = selection;
      if (sel?.zone === "faceUp") {
        setPlayers((prev) =>
          prev.map((p, i) => (i === 0 ? swapPlayerCards(p, index, sel.index) : p))
        );
        setSwapTick((t) => t + 1);
        setSelection(null);
        if (tutLocked() && step?.wait === "swap") advanceTutorial();
      } else if (sel?.zone === "hand" && sel.index === index) {
        setSelection(null);
      } else {
        setSelection({ zone: "hand", index });
      }
      return;
    }

    if (phase !== "playing" || currentPlayerRef.current !== 0) return;
    const pl = playersRef.current[0];
    if (activePlayZone(pl, drawDeckRef.current.length) !== "hand") return;
    const rank = getRank(pl.hand[index]);
    if (tutLocked()) {
      const step = tutStepNow();
      if (step?.wait !== "play" || rank !== step.rank) return;
      if (step.count && step.count > 1) {
        const hand = pl.hand
          .map((c, i) => (getRank(c) === step.rank ? i : -1))
          .filter((i) => i >= 0);
        setPlaySelected({ hand, faceUp: [] });
        return;
      }
    }

    setPlaySelected((prev) => {
      const curRank = playSelectionRank(pl, prev);
      if (prev.hand.includes(index)) {
        const nextHand = prev.hand.filter((i) => i !== index);
        const nextFace =
          nextHand.length > 0 &&
          canCombineHandWithFaceUp(pl, drawDeckRef.current.length, nextHand)
            ? prev.faceUp.filter((i) => {
                const c = pl.faceUp[i];
                return c !== null && getRank(c) === getRank(pl.hand[nextHand[0]]);
              })
            : [];
        return { hand: nextHand, faceUp: nextFace };
      }
      if (!curRank || curRank !== rank) {
        return { hand: [index], faceUp: [] };
      }
      const nextHand = [...prev.hand, index];
      const nextFace = canCombineHandWithFaceUp(pl, drawDeckRef.current.length, nextHand)
        ? prev.faceUp.filter((i) => {
            const c = pl.faceUp[i];
            return c !== null && getRank(c) === rank;
          })
        : [];
      return { hand: nextHand, faceUp: nextFace };
    });
  }

  function handleSelectFaceUp(index: number) {
    if (phase === "swap") {
      if (playersRef.current[0]?.ready) return;
      const step = tutStepNow();
      const pl = playersRef.current[0];
      if (tutLocked()) {
        if (step?.wait !== "swap" || !step.rank || !step.faceRank) return;
        const face = pl.faceUp[index];
        if (!face || getRank(face) !== step.faceRank) return;
        if (selection?.zone === "hand") {
          if (getRank(pl.hand[selection.index]) !== step.rank) return;
        }
      }
      const sel = selection;
      if (sel?.zone === "hand") {
        setPlayers((prev) =>
          prev.map((p, i) => (i === 0 ? swapPlayerCards(p, sel.index, index) : p))
        );
        setSwapTick((t) => t + 1);
        setSelection(null);
        if (tutLocked() && step?.wait === "swap") advanceTutorial();
      } else if (sel?.zone === "faceUp" && sel.index === index) {
        setSelection(null);
      } else {
        setSelection({ zone: "faceUp", index });
      }
      return;
    }

    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    if (tutLocked()) return;

    if (pickupAwaitTable) {
      executePickUp({ zone: "faceUp", index });
      return;
    }

    const pl = playersRef.current[0];
    const zone = activePlayZone(pl, drawDeckRef.current.length);
    if (zone !== "faceUp" && zone !== "hand") return;
    const card = pl.faceUp[index];
    if (card === null) return;
    const rank = getRank(card);
    const deckLen = drawDeckRef.current.length;

    // While still in hand phase, face-up only if combo is allowed
    if (zone === "hand") {
      if (!mayAttachFaceUp(pl, deckLen)) return;
      if (getRank(pl.hand[0]) !== rank) return;
    }

    setPlaySelected((prev) => {
      if (prev.faceUp.includes(index)) {
        return { ...prev, faceUp: prev.faceUp.filter((i) => i !== index) };
      }
      if (zone === "hand") {
        // Auto-select entire hand (required for combo)
        const hand = pl.hand.map((_, i) => i);
        const curRank = playSelectionRank(pl, { hand, faceUp: prev.faceUp });
        if (curRank && curRank !== rank) {
          return { hand, faceUp: [index] };
        }
        return { hand, faceUp: [...prev.faceUp.filter((i) => {
          const c = pl.faceUp[i];
          return c !== null && getRank(c) === rank;
        }), index] };
      }
      // Pure face-up phase
      const curRank = playSelectionRank(pl, prev);
      if (!curRank) return { hand: [], faceUp: [index] };
      if (curRank !== rank) return { hand: [], faceUp: [index] };
      return { hand: [], faceUp: [...prev.faceUp, index] };
    });
  }

  function handleSelectFaceDown(index: number) {
    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    if (tutLocked()) return;

    if (pickupAwaitTable) {
      executePickUp({ zone: "faceDown", index });
      return;
    }

    const pl = playersRef.current[0];
    if (activePlayZone(pl, drawDeckRef.current.length) !== "faceDown") return;

    const result = applyPlay(
      0,
      { faceDown: index },
      playersRef.current,
      drawDeckRef.current,
      discardRef.current
    );
    runPlayResult(0, result, true);
  }

  function handleReady() {
    if (phase !== "swap" || playersRef.current[0]?.ready) return;
    if (tutLocked() && tutStepNow()?.wait !== "ready") return;
    markReady(0);
    if (tutLocked() && tutStepNow()?.wait === "ready") advanceTutorial();
  }

  function handlePlay() {
    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    if (pickupAwaitTable) return;
    if (selectionCount(playSelected) === 0) return;
    const pl = playersRef.current[0];
    const zone = activePlayZone(pl, drawDeckRef.current.length);
    if (!zone || zone === "faceDown") return;
    const step = tutStepNow();
    if (tutLocked()) {
      if (step?.wait !== "play") return;
      const cards = cardsFromSelection(pl, playSelected);
      if (!cards.length || getRank(cards[0]) !== step.rank) return;
      if (step.count && cards.length !== step.count) return;
    }

    const result = applyPlay(
      0,
      { hand: playSelected.hand, faceUp: playSelected.faceUp },
      playersRef.current,
      drawDeckRef.current,
      discardRef.current
    );
    if (
      result.message === "Can't play that" ||
      result.message === "Choose cards from your hand first" ||
      result.message.startsWith("Face-up combo")
    ) {
      setStatusMsg(result.message);
      return;
    }
    runPlayResult(0, result, true);
  }

  function executePickUp(tableTake?: TableTake | null) {
    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    const pile = discardRef.current;
    const result = applyPickUp(0, playersRef.current, pile, tableTake ?? null);
    if (result.pickupCards.length === 0) {
      setStatusMsg(result.message);
      return;
    }
    setPickupAwaitTable(false);
    setPlayers(result.players);
    runPickUpResult(0, result.pickupCards, result.players, result.message);
    if (tutLocked() && tutStepNow()?.wait === "take") advanceTutorial();
  }

  function handlePickUp() {
    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    if (tutLocked() && tutStepNow()?.wait !== "take") return;
    const pl = playersRef.current[0];
    const pile = discardRef.current;
    if (pile.length === 0 && activePlayZone(pl, drawDeckRef.current.length) === "faceDown") {
      // Face-down zone with empty discard: nothing to pick up
      setStatusMsg("Discard is empty");
      return;
    }
    if (pile.length === 0) {
      setStatusMsg("Discard is empty");
      return;
    }
    if (canTakeTableWithPickup(pl)) {
      setPickupAwaitTable(true);
      setPlaySelected(emptyPlay());
      setStatusMsg(
        activePlayZone(pl, drawDeckRef.current.length) === "faceUp"
          ? "Pick a matching rank on the table, or take discard only"
          : "Pick a table card or take discard only"
      );
      return;
    }
    executePickUp(null);
  }

  function handlePickUpOnly() {
    executePickUp(null);
  }

  function handleCancelPickupAwait() {
    setPickupAwaitTable(false);
    setStatusMsg(`Turn: ${playersRef.current[0]?.name ?? "You"}`);
  }

  function resetToLobby() {
    clearTimers();
    setPhase("lobby");
    setPlayers([]);
    setDrawDeck([]);
    setDiscard([]);
    setDealing(false);
    setLastStep(null);
    setSelection(null);
    setSwapSeconds(SWAP_SECONDS);
    setPlaySelected(emptyPlay());
    setFinishOrder([]);
    clearAnimState();
    setBurnCount(0);
    setPickupAwaitTable(false);
    setStatusMsg("");
    tutorialRef.current = false;
    tutStepRef.current = 0;
    setTutorial(false);
    setTutStep(0);
  }

  useEffect(() => () => clearTimers(), []);

  if (online) {
    return (
      <VisualFrame>
        <OnlineGame onLeave={() => setOnline(false)} />
      </VisualFrame>
    );
  }

  if (phase === "lobby") {
    return (
      <VisualFrame>
        <Lobby onStart={startGame} onRules={() => setPhase("rules")} onOnline={() => setOnline(true)} />
      </VisualFrame>
    );
  }
  if (phase === "rules") {
    return (
      <VisualFrame>
        <RulesScreen onBack={() => setPhase("lobby")} />
      </VisualFrame>
    );
  }

  return (
    <VisualFrame>
    <Table
      players={players}
      drawDeck={drawDeck}
      discard={discard}
      phase={phase}
      dealing={dealing}
      dealProgress={dealProgress}
      lastStep={lastStep}
      swapSeconds={swapSeconds}
      selection={selection}
      swapTick={swapTick}
      currentPlayer={currentPlayer}
      playSelected={playSelected}
      statusMsg={statusMsg}
      finishOrder={finishOrder}
      flyAnim={flyAnim}
      burnCount={burnCount}
      burnAnim={burnAnim}
      pickupAnim={pickupAnim}
      drawAnim={drawAnim}
      revealCard={revealCard}
      pickupAwaitTable={pickupAwaitTable}
      onSelectHand={handleSelectHand}
      onSelectFaceUp={handleSelectFaceUp}
      onSelectFaceDown={handleSelectFaceDown}
      onReady={handleReady}
      onPlay={handlePlay}
      onPickUp={handlePickUp}
      onPickUpOnly={handlePickUpOnly}
      onCancelPickupAwait={handleCancelPickupAwait}
      onReset={resetToLobby}
      tutorial={
        tutorial && TUTORIAL_STEPS[tutStep]
          ? (() => {
              const step = TUTORIAL_STEPS[tutStep];
              let hint: TutHint = step.hint ?? "none";
              if (step.wait === "play" && step.rank && players[0]) {
                const selected = cardsFromSelection(players[0], playSelected);
                const n = selected.filter((c) => getRank(c) === step.rank).length;
                if (step.count ? n >= step.count : n > 0) hint = "play";
              }
              if (step.wait === "swap" && selection?.zone === "hand" && players[0]) {
                if (getRank(players[0].hand[selection.index]) === step.rank) hint = "faceUp";
              }
              return {
                text: step.text,
                showNext: step.wait === "continue",
                showSkip: step.wait !== "free",
                hint,
                rank: step.rank,
                faceRank: step.faceRank,
                special: step.special,
                onNext: advanceTutorial,
                onSkip: skipTutorial,
              };
            })()
          : null
      }
    />
    </VisualFrame>
  );
}
