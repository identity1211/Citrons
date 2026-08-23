import { useState, useEffect, useRef, useCallback, type CSSProperties, type ReactNode } from "react";
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
  faceDown: (string | null)[];
  faceUp: (string | null)[];
  hand: string[];
  ready: boolean;
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
  if (place === total && total > 1) return "Последний";
  return `${place} место`;
}

function refillHand(
  hand: string[],
  deck: string[]
): { hand: string[]; deck: string[] } {
  const h = [...hand];
  const d = [...deck];
  while (h.length < HAND_SIZE && d.length > 0) {
    h.push(d.shift()!);
  }
  return { hand: sortHand(h), deck: d };
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

// ─── CSS keyframes ───────────────────────────────────────────────────────────

const STYLE_ID = "card-game-keyframes-v7";
function ensureKeyframes() {
  if (typeof document === "undefined") return;
  for (const id of ["card-game-keyframes", "card-game-keyframes-v3", "card-game-keyframes-v4", "card-game-keyframes-v5", "card-game-keyframes-v6"]) {
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
      0% { opacity: 0.95; transform: translate(var(--fx), var(--fy)) scale(0.88) rotate(var(--fr)); }
      100% { opacity: 1; transform: translate(0, 0) scale(1) rotate(0deg); }
    }
    @keyframes cardFlyToBurn {
      0% { opacity: 1; transform: translate(0, 0) scale(1) rotate(0deg); }
      100% { opacity: 0.85; transform: translate(var(--bx), var(--by)) scale(0.62) rotate(16deg); }
    }
    @keyframes cardFlyToPlayer {
      0% { opacity: 1; transform: translate(0, 0) scale(1) rotate(0deg); }
      100% { opacity: 0.8; transform: translate(var(--px), var(--py)) scale(0.68) rotate(var(--pr)); }
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
    .card-fly { animation: cardFlyToDiscard 0.48s cubic-bezier(0.22, 1, 0.36, 1) both; pointer-events: none; }
    .card-fly-burn { animation: cardFlyToBurn 0.55s cubic-bezier(0.33, 1, 0.68, 1) both; pointer-events: none; }
    .card-fly-pickup { animation: cardFlyToPlayer 0.55s cubic-bezier(0.33, 1, 0.68, 1) both; pointer-events: none; }
    .card-reveal { animation: revealPop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .timer-urgent { animation: timerPulse 0.8s ease-in-out infinite; }
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

function useViewport() {
  const [vp, setVp] = useState({ w: 1024, h: 700, x: 0, y: 0 });
  useEffect(() => {
    const fit = () => {
      const vv = window.visualViewport;
      setVp({
        w: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
        h: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
        x: Math.round(vv?.offsetLeft ?? 0),
        y: Math.round(vv?.offsetTop ?? 0),
      });
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("scroll", fit);
    };
  }, []);
  return vp;
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
        position: "fixed",
        left: vp.x,
        top: vp.y,
        width: vp.w,
        height: vp.h,
        overflow: "hidden",
        background: "#145230",
      }}
    >
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
  onClick,
}: CardProps) {
  const w = wProp ?? (small ? 38 : 56);
  const h = hProp ?? (small ? 54 : 78);
  const box = cardBox(w, h);

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
        className={animClass}
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
      className={animClass}
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
  onSelectFaceUp?: (index: number) => void;
  onSelectFaceDown?: (index: number) => void;
  swapKey?: number;
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
  onSelectFaceUp,
  onSelectFaceDown,
  swapKey = 0,
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
                faceVisible={false}
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
                dimmed={faceUpLegal ? !faceUpLegal[i] : false}
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
  onSelect?: (index: number) => void;
  swapKey?: number;
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
  onSelect,
  swapKey = 0,
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
    <div style={{ position: "relative", width: totalW || 1, height: h }}>
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
            dimmed={isOwner && legalMask ? !legalMask[i] : false}
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

const FLY_MS = 520;
const BURN_MS = 600;
const PICKUP_MS = 600;
const REVEAL_MS = 900;

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
          Отбой
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
            Под 7: {getRank(effective)}
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
          Сброс
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

function FlyOverlay({ anim }: { anim: FlyAnim }) {
  const origin = flyOrigin(anim.fromPlayer, anim.playerCount);
  return (
    <div
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
      {anim.cards.map((card, i) => (
        <div
          key={`${anim.id}-${i}-${card}`}
          className="card-fly"
          style={{
            ["--fx" as string]: `calc(${origin.x} + ${(i - (anim.cards.length - 1) / 2) * 14}px)`,
            ["--fy" as string]: origin.y,
            ["--fr" as string]: `${origin.rot + i * 4}deg`,
            position: "absolute",
            width: 56,
            height: 78,
            animationDelay: `${i * 55}ms`,
            zIndex: 50 + i,
          }}
        >
          <PlayingCard card={card} faceVisible style={{ top: 0, left: 0 }} />
        </div>
      ))}
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
        Твоя карта
      </div>
      <div className="card-reveal" style={{ position: "relative", width: 64, height: 90 }}>
        <PlayingCard card={card} faceVisible style={{ top: 0, left: 0 }} />
      </div>
    </div>
  );
}

function SeatLabel({
  name,
  isHuman,
  ready,
  isTurn,
  place,
}: {
  name: string;
  isHuman: boolean;
  ready?: boolean;
  isTurn?: boolean;
  place?: number | null;
}) {
  const theme = useHostTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
          opacity: place ? 0.75 : 1,
        }}
      >
        {name}
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
const LOBBY_FAN: { card: string; rot: number; x: number; y: number; delay: number }[] = [
  { card: "2♦", rot: -28, x: -78, y: 14, delay: 0 },
  { card: "6♠", rot: -14, x: -40, y: 4, delay: 0.07 },
  { card: "7♥", rot: 0, x: 0, y: 0, delay: 0.14 },
  { card: "10♣", rot: 14, x: 40, y: 4, delay: 0.21 },
  { card: "A♠", rot: 28, x: 78, y: 14, delay: 0.28 },
];

function FeltShell({
  children,
  center,
  style,
}: {
  children: ReactNode;
  center?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        minHeight: "100%",
        height: "100%",
        position: "relative",
        overflowX: "hidden",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: center ? "center" : "flex-start",
        background: FELT_BG,
        backgroundImage: `${FELT_TEXTURE}, ${FELT_BG}`,
        boxShadow: `inset 0 0 0 12px ${WOOD_EDGE}, inset 0 0 0 14px #5d4037`,
        ["--felt" as string]: "#1a6b3c",
        ["--wood" as string]: WOOD_EDGE,
        ...style,
      }}
    >
      <div className="lobby-felt-glow" />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          ...(center ? { justifyContent: "center", flex: 1 } : {}),
        }}
      >
        {children}
      </div>
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
        height: 120,
        margin: "8px 0 28px",
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
            top: 18,
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
    <FeltShell style={{ padding: "28px 20px 40px" }}>
      <div style={{ width: "100%", maxWidth: 560, padding: "0 4px" }}>
        <button
          onClick={onBack}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.28)",
            background: "rgba(0,0,0,0.25)",
            color: "#f5f0e6",
            cursor: "pointer",
            fontSize: 12,
            marginBottom: 20,
          }}
        >
          ← Назад
        </button>
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
          Правила
        </div>
        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginBottom: 24 }}>
          2–5 игроков · 52 карты · масть не важна
        </div>
        <RuleBlock title="Подготовка">
          <p style={{ margin: "0 0 8px" }}>
            Каждому: <b style={{ color: "#fff" }}>3 закрытые</b> →{" "}
            <b style={{ color: "#fff" }}>3 открытые</b> сверху →{" "}
            <b style={{ color: "#fff" }}>3 в руку</b>.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            20 секунд на обмен руки с открытыми. Затем Ready. Первый ход — случайный игрок.
          </p>
        </RuleBlock>
        <RuleBlock title="Старшинство">
          <p style={{ margin: 0, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}>
            {RANK_ORDER.join(" < ")}
          </p>
        </RuleBlock>
        <RuleBlock title="Ход">
          <p style={{ margin: "0 0 8px" }}>
            Кладешь карты одного ранга. Комбо рука+открытые — только если это
            последние карты в руке и колода пуста. Пока есть колода — добираешь до ровно 3.
          </p>
          <p style={{ margin: "0 0 8px" }}>Не можешь ходить — забираешь сброс.</p>
          <p style={{ margin: "0 0 8px" }}>
            Если рука пуста и ты играешь открытыми или закрытыми со стола — вместе
            со сбросом можно забрать карту(ы) со стола в руку. Несколько открытых
            одного ранга забираются все сразу; закрытую — только одну.
          </p>
          <p style={{ margin: 0 }}>
            Рука и колода пусты → открытые, потом закрытые.
          </p>
        </RuleBlock>
        <RuleBlock title="Спецкарты">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b style={{ color: "#fff" }}>2</b> — на любую; сброс до двойки</li>
            <li><b style={{ color: "#fff" }}>6</b> — только 6 или ниже, либо 7. Десятку нельзя</li>
            <li><b style={{ color: "#fff" }}>7</b> — прозрачная</li>
            <li><b style={{ color: "#fff" }}>10</b> — на любую кроме 6; сжигает сброс</li>
            <li><b style={{ color: "#fff" }}>4 одинаковых</b> подряд — сжигание</li>
          </ul>
        </RuleBlock>
        <RuleBlock title="Победа">
          <p style={{ margin: 0 }}>
            Кто первым избавился от всех карт — занимает 1 место, остальные продолжают.
            Игра идёт, пока не останется один проигравший.
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
          Понятно
        </button>
      </div>
    </FeltShell>
  );
}

type LobbyView = "main" | "solo" | "multi";

const LOBBY_MENU_BTN: CSSProperties = {
  width: "100%",
  maxWidth: 300,
  height: 50,
  borderRadius: 10,
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
};

function LobbyBack({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="lobby-ghost-btn"
      onClick={onClick}
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.28)",
        background: "rgba(0,0,0,0.22)",
        color: "#f5f0e6",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 600,
        alignSelf: "flex-start",
      }}
    >
      ← Главное меню
    </button>
  );
}

function Lobby({ onStart, onRules }: { onStart: (count: number) => void; onRules: () => void }) {
  const [view, setView] = useState<LobbyView>("main");
  const [selected, setSelected] = useState(4);
  const [popKey, setPopKey] = useState(0);

  function pickCount(n: number) {
    setSelected(n);
    setPopKey((k) => k + 1);
  }

  return (
    <FeltShell center style={{ padding: "min(32px, 5vh) 16px" }}>
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          padding: "0 8px",
        }}
      >
        <div className="lobby-brand-in" style={{ animationDelay: "0.05s" }}>
          <div
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: "clamp(36px, 11vh, 72px)",
              fontWeight: 700,
              color: "#f5f0e6",
              letterSpacing: 1,
              lineHeight: 1,
              textShadow: "0 2px 0 rgba(0,0,0,0.25), 0 12px 28px rgba(0,0,0,0.35)",
            }}
          >
            Citrons
          </div>
          <div
            style={{
              marginTop: 12,
              fontSize: 15,
              color: "rgba(255,255,255,0.72)",
              fontWeight: 500,
              letterSpacing: 0.2,
              maxWidth: 320,
              lineHeight: 1.4,
            }}
          >
            TwoCircles Edition
          </div>
        </div>

        <LobbyCardFan />

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
          }}
        >
          {view !== "main" && <LobbyBack onClick={() => setView("main")} />}

          {view === "main" && (
            <>
              <button
                type="button"
                className="lobby-play-btn"
                onClick={() => setView("solo")}
                style={{
                  ...LOBBY_MENU_BTN,
                  border: "none",
                  background: "#f1c40f",
                  color: "#1a2e1a",
                  boxShadow: "0 6px 16px rgba(0,0,0,0.28)",
                }}
              >
                Одиночная игра
              </button>
              <button
                type="button"
                className="lobby-ghost-btn"
                onClick={() => setView("multi")}
                style={{
                  ...LOBBY_MENU_BTN,
                  border: "1.5px solid rgba(255,255,255,0.35)",
                  background: "transparent",
                  color: "#f5f0e6",
                }}
              >
                Мультиплеер
              </button>
              <button
                type="button"
                className="lobby-ghost-btn"
                onClick={() => void enterFullscreen()}
                style={{
                  ...LOBBY_MENU_BTN,
                  height: 44,
                  border: "1.5px solid rgba(255,255,255,0.28)",
                  background: "transparent",
                  color: "#f5f0e6",
                  fontSize: 14,
                }}
              >
                Полный экран
              </button>
              <div
                style={{
                  marginTop: 4,
                  maxWidth: 300,
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: "rgba(255,255,255,0.55)",
                }}
              >
                Скрывает панели браузера. На iPhone: Поделиться → На экран «Домой».
              </div>
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
                Игроков
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
                  Правила
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
                  Играть
                </button>
              </div>
            </>
          )}

          {view === "multi" && (
            <>
              <button
                type="button"
                className="lobby-play-btn"
                style={{
                  ...LOBBY_MENU_BTN,
                  border: "none",
                  background: "#f1c40f",
                  color: "#1a2e1a",
                  boxShadow: "0 6px 16px rgba(0,0,0,0.28)",
                }}
              >
                Создать лобби
              </button>
              <button
                type="button"
                className="lobby-ghost-btn"
                style={{
                  ...LOBBY_MENU_BTN,
                  border: "1.5px solid rgba(255,255,255,0.35)",
                  background: "transparent",
                  color: "#f5f0e6",
                }}
              >
                Присоединиться к лобби
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
}: {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  kind: "play" | "take" | "ready" | "ghost";
  style?: CSSProperties;
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
      className="felt-chip"
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
}) {
  const theme = useHostTheme();
  const n = players.length;
  const opponentCount = n - 1;
  const isSwap = phase === "swap";
  const isPlaying = phase === "playing" || phase === "finished";
  const humanReady = players[0]?.ready ?? false;
  const isHumanTurn =
    isPlaying && currentPlayer === 0 && phase === "playing" && !flyAnim && !burnAnim && !pickupAnim && !revealCard;
  const humanZone = players[0] ? activePlayZone(players[0], drawDeck.length) : null;
  const selRank = players[0] ? playSelectionRank(players[0], playSelected) : null;

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
    burnAnim || pickupAnim
      ? []
      : flyAnim && flyAnim.cards.length > 0 && discard.length >= flyAnim.cards.length
        ? discard.slice(0, discard.length - flyAnim.cards.length)
        : discard;

  const vp = useViewport();
  const fsOn = useFullscreen();
  const [fsNote, setFsNote] = useState("");
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
      setFsNote("iPhone: Поделиться → На экран «Домой» — так скроется Safari");
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
          isHuman={false}
          ready={isSwap ? players[pIdx].ready : undefined}
          isTurn={isPlaying && currentPlayer === pIdx && phase === "playing"}
          place={finishOrder.includes(pIdx) ? finishOrder.indexOf(pIdx) + 1 : null}
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
        background: "#145230",
        position: "relative",
        overflow: "hidden",
        boxSizing: "border-box",
        padding: 0,
      }}
    >
      <button
        onClick={onReset}
        style={{
          position: "absolute",
          top: "max(4px, env(safe-area-inset-top))",
          left: "max(6px, env(safe-area-inset-left))",
          zIndex: 8,
          padding: "5px 10px",
          borderRadius: 6,
          border: `1px solid ${theme.stroke.secondary}`,
          background: "rgba(0,0,0,0.35)",
          color: theme.text.primary,
          cursor: "pointer",
          fontSize: 12,
          touchAction: "manipulation",
        }}
      >
        ← Lobby
      </button>
      <button
        onClick={() => void toggleFullscreen()}
        style={{
          position: "absolute",
          top: "max(4px, env(safe-area-inset-top))",
          left: "max(88px, calc(env(safe-area-inset-left) + 82px))",
          zIndex: 8,
          padding: "5px 10px",
          borderRadius: 6,
          border: `1px solid ${theme.stroke.secondary}`,
          background: fsOn ? "rgba(241,196,15,0.9)" : "rgba(0,0,0,0.35)",
          color: fsOn ? "#1a2e1a" : theme.text.primary,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          touchAction: "manipulation",
        }}
      >
        {fsOn ? "Экран" : "Полный экран"}
      </button>
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
        {statusMsg}
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
          {phase === "finished" ? "Итоги · " : ""}
          {finishOrder.map((pIdx, i) => {
            const place = i + 1;
            const isLast = phase === "finished" && place === finishOrder.length && finishOrder.length > 1;
            return (
              <span key={pIdx} style={{ fontWeight: pIdx === 0 || place === 1 ? 700 : 500 }}>
                {isLast ? "Последний" : `${place}`} {players[pIdx].name}
                {i < finishOrder.length - 1 ? " · " : ""}
              </span>
            );
          })}
        </div>
      )}

      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: short ? 18 : 48,
          background: "#1a6b3c",
          border: short ? "6px solid #145230" : "10px solid #145230",
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
            {isSwap && (
              <div style={{ transform: short ? "scale(0.78)" : undefined, transformOrigin: "center" }}>
                <SwapTimer seconds={swapSeconds} />
              </div>
            )}
            {isPlaying && <DiscardPile cards={displayDiscard} />}
            {isSwap && (
              <FeltChip onClick={onReady} disabled={humanReady} kind="ready" label="Ready" />
            )}
            {pickupAwaitTable && isHumanTurn && (
              <FeltChip onClick={onCancelPickupAwait} kind="ghost" label="Отмена" />
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
          {isPlaying && revealCard && <RevealOverlay card={revealCard} />}
        </div>

        <div
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
              isHumanTurn &&
              (pickupAwaitTable ? humanZone === "faceDown" : humanZone === "faceDown")
            }
            locked={isSwap ? humanReady : !isHumanTurn}
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
            onSelectFaceUp={onSelectFaceUp}
            onSelectFaceDown={onSelectFaceDown}
            swapKey={swapTick}
          />
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
              onSelect={onSelectHand}
              swapKey={swapTick}
            />
          )}
        </div>
      </div>

      <FeltChip
        kind={myTurn ? "play" : "ghost"}
        disabled={!myTurn}
        label="Ход"
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
        label={
          <>
            Забрать
            <br />
            сброс
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
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

export default function CardGame() {
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
  const [revealCard, setRevealCard] = useState<string | null>(null);
  const [pickupAwaitTable, setPickupAwaitTable] = useState(false);

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
  playersRef.current = players;
  finishOrderRef.current = finishOrder;
  drawDeckRef.current = drawDeck;
  discardRef.current = discard;
  currentPlayerRef.current = currentPlayer;
  phaseRef.current = phase;

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
        setStatusMsg("Игра окончена");
        return;
      }
      advanceTurn(playerIndex, result.players, false);
      return;
    }

    advanceTurn(playerIndex, result.players, result.extraTurn);
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
    },
    animate: boolean
  ) {
    setPlayers(result.players);
    setDrawDeck(result.deck);
    setDiscard(result.discard);
    setPlaySelected(emptyPlay());
    setStatusMsg(result.message);
    playLockRef.current = true;

    const afterPlayOrBurn = () => {
      if (result.willBurn && result.burnCards.length > 0) {
        flyIdRef.current += 1;
        setBurnAnim({ id: flyIdRef.current, cards: result.burnCards });
        const burnDelay = BURN_MS + Math.min(result.burnCards.length, 6) * 35;
        const t = setTimeout(() => {
          setBurnAnim(null);
          setDiscard([]);
          setBurnCount((c) => c + result.burnCards.length);
          finalizeAfterPlay(playerIndex, result);
        }, burnDelay);
        aiTimersRef.current.push(t);
        return;
      }
      finalizeAfterPlay(playerIndex, result);
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
        setFlyAnim(null);
        afterPlayOrBurn();
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
    const first = Math.floor(Math.random() * pls.length);
    setCurrentPlayer(first);
    setDiscard([]);
    setBurnCount(0);
    clearAnimState();
    setPickupAwaitTable(false);
    setPlaySelected(emptyPlay());
    setFinishOrder([]);
    setPhase("playing");
    setStatusMsg(`Ход: ${pls[first].name}`);
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
    setSwapSeconds(SWAP_SECONDS);
    setSelection(null);
    setStatusMsg("Обмен карт — 20 секунд");

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
          message: "Эта карта ещё закрыта открытой сверху",
          played: [],
          willBurn: false,
          burnCards: [],
          pickup: null,
          privateReveal: null,
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
          ? `Ты открыл ${label} — нельзя, забираешь сброс`
          : `${pl.name} открыл карту — нельзя, забирает сброс`;
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
      });
      if (handIdx.length === 0 && faceIdx.length === 0) {
        return fail("Так ходить нельзя");
      }
      if (pl.hand.length > 0 && handIdx.length === 0) {
        return fail("Сначала выбери карты из руки");
      }
      if (faceIdx.length > 0 && pl.hand.length > 0) {
        if (!canCombineHandWithFaceUp(pl, deckNext.length, handIdx)) {
          return fail("Комбо с открытыми — только последними картами руки, когда колода пуста");
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
        return fail("Так ходить нельзя");
      }
      played = removed;
    }

    const rank = getRank(played[0]);
    discardNext = [...discardNext, ...played];
    message = `${pl.name}: ${played.map((c) => getRank(c) + c.slice(-1)).join(", ")}`;

    if (rank === "7") {
      const under = getEffectiveTop(discardNext);
      if (under) {
        message += ` · под 7: ${getRank(under)}${under.slice(-1)}`;
      } else {
        message += " · под 7 пусто";
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
      message += " — сброс в отбой!";
    }

    if (deckNext.length > 0) {
      const refilled = refillHand(pl.hand, deckNext);
      pl.hand = refilled.hand;
      deckNext = refilled.deck;
    } else {
      pl.hand = sortHand(pl.hand);
    }

    playersNext[playerIndex] = pl;
    const won = playerFinished(pl);
    if (won) message = `${pl.name} выходит!`;

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
        message: "Сброс пуст",
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
          message: "Карту со стола можно взять только с пустой рукой",
          pickupCards: [] as string[],
        };
      }
      if (tableTake.zone === "faceUp") {
        const card = pl.faceUp[tableTake.index];
        if (card === null) {
          return {
            players: pls,
            discard: pile,
            message: "Нет такой открытой карты",
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
            message: "Нет такой закрытой карты",
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
          ? " + 1 закрытая со стола"
          : extras.length === 1
            ? ` + ${getRank(extras[0])}${extras[0].slice(-1)} со стола`
            : ` + ${extras.length}×${getRank(extras[0])} со стола`
        : "";
    return {
      players: playersNext,
      discard: pile,
      message: `${pls[playerIndex].name} забирает сброс (${pile.length})${tableNote}`,
      pickupCards,
    };
  }

  function advanceTurn(from: number, pls: PlayerState[], extraTurn: boolean) {
    if (extraTurn && !playerFinished(pls[from])) {
      setCurrentPlayer(from);
      setStatusMsg(`Ход: ${pls[from].name} (ещё раз)`);
      return from;
    }
    const nxt = nextAlive(from, pls);
    setCurrentPlayer(nxt);
    setStatusMsg(`Ход: ${pls[nxt].name}`);
    return nxt;
  }

  // AI turns
  useEffect(() => {
    if (phase !== "playing") return;
    if (currentPlayer === 0) return;
    if (flyAnim || burnAnim || pickupAnim || revealCard) return;
    if (playerFinished(players[currentPlayer])) return;

    const t = setTimeout(() => {
      const pls = playersRef.current;
      const deck = drawDeckRef.current;
      const pile = discardRef.current;
      const pIdx = currentPlayerRef.current;
      if (pIdx === 0 || phaseRef.current !== "playing") return;
      if (playLockRef.current) return;

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
  }, [phase, currentPlayer, finishOrder, discard, players, drawDeck, flyAnim, burnAnim, pickupAnim, revealCard]);

  const startGame = useCallback((playerCount: number) => {
    void enterFullscreen();
    clearTimers();
    const deck = shuffle(buildDeck());
    let cursor = 0;

    const newPlayers: PlayerState[] = Array.from({ length: playerCount }, (_, i) => ({
      name: i === 0 ? "Ты" : `Игрок ${i + 1}`,
      faceDown: [],
      faceUp: [],
      hand: [],
      ready: false,
    }));

    for (let slot = 0; slot < 3; slot++)
      for (let p = 0; p < playerCount; p++) newPlayers[p].faceDown.push(deck[cursor++]);
    for (let slot = 0; slot < 3; slot++)
      for (let p = 0; p < playerCount; p++) newPlayers[p].faceUp.push(deck[cursor++]);
    for (let slot = 0; slot < 3; slot++)
      for (let p = 0; p < playerCount; p++) newPlayers[p].hand.push(deck[cursor++]);

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
    setStatusMsg("Раздача карт...");
    clearAnimState();
    setBurnCount(0);
    setPickupAwaitTable(false);
    setPhase("dealing");

    const steps = buildDealSequence(playerCount);
    dealStepsRef.current = steps;
    stepRef.current = 0;

    function runStep() {
      const step = dealStepsRef.current[stepRef.current];
      if (!step || step.type === "done") {
        setDealing(false);
        setLastStep(null);
        beginSwapPhase(playerCount);
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
      const sel = selection;
      if (sel?.zone === "faceUp") {
        setPlayers((prev) =>
          prev.map((p, i) => (i === 0 ? swapPlayerCards(p, index, sel.index) : p))
        );
        setSwapTick((t) => t + 1);
        setSelection(null);
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
      const sel = selection;
      if (sel?.zone === "hand") {
        setPlayers((prev) =>
          prev.map((p, i) => (i === 0 ? swapPlayerCards(p, sel.index, index) : p))
        );
        setSwapTick((t) => t + 1);
        setSelection(null);
      } else if (sel?.zone === "faceUp" && sel.index === index) {
        setSelection(null);
      } else {
        setSelection({ zone: "faceUp", index });
      }
      return;
    }

    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;

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
    markReady(0);
  }

  function handlePlay() {
    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    if (pickupAwaitTable) return;
    if (selectionCount(playSelected) === 0) return;
    const pl = playersRef.current[0];
    const zone = activePlayZone(pl, drawDeckRef.current.length);
    if (!zone || zone === "faceDown") return;

    const result = applyPlay(
      0,
      { hand: playSelected.hand, faceUp: playSelected.faceUp },
      playersRef.current,
      drawDeckRef.current,
      discardRef.current
    );
    if (
      result.message === "Так ходить нельзя" ||
      result.message === "Сначала выбери карты из руки" ||
      result.message.startsWith("Комбо с открытыми")
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
  }

  function handlePickUp() {
    if (phase !== "playing" || currentPlayerRef.current !== 0 || playLockRef.current) return;
    const pl = playersRef.current[0];
    const pile = discardRef.current;
    if (pile.length === 0 && activePlayZone(pl, drawDeckRef.current.length) === "faceDown") {
      // Face-down zone with empty discard: nothing to pick up
      setStatusMsg("Сброс пуст");
      return;
    }
    if (pile.length === 0) {
      setStatusMsg("Сброс пуст");
      return;
    }
    if (canTakeTableWithPickup(pl)) {
      setPickupAwaitTable(true);
      setPlaySelected(emptyPlay());
      setStatusMsg(
        activePlayZone(pl, drawDeckRef.current.length) === "faceUp"
          ? "Выбери ранг на столе (все одинаковые) или только сброс"
          : "Выбери карту со стола или забери только сброс"
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
    setStatusMsg(`Ход: ${playersRef.current[0]?.name ?? "Ты"}`);
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
  }

  useEffect(() => () => clearTimers(), []);

  if (phase === "lobby") {
    return (
      <VisualFrame>
        <Lobby onStart={startGame} onRules={() => setPhase("rules")} />
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
    />
    </VisualFrame>
  );
}
