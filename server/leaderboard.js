"use strict";

const fs = require("fs");
const path = require("path");

const FILE =
  process.env.LEADERBOARD_FILE || path.join(__dirname, "..", "data", "leaderboard.json");
const TOP = 25;

let store = { users: {} };

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.users && typeof parsed.users === "object") store = { users: parsed.users };
  } catch {
    store = { users: {} };
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

function sanitizeId(id) {
  return String(id || "")
    .replace(/[^\w-]/g, "")
    .slice(0, 64);
}

function sanitizeName(name) {
  const n = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return n || "Player";
}

function sanitizeAvatar(url) {
  const u = String(url || "").trim();
  if (!u || u.length > 800) return "";
  if (!/^https:\/\//i.test(u)) return "";
  return u;
}

function bump(userId, name, avatar, { win, last }) {
  const id = sanitizeId(userId);
  if (!id) return;
  const prev = store.users[id] || { name: "Player", avatar: "", wins: 0, games: 0, lasts: 0 };
  store.users[id] = {
    name: sanitizeName(name) || prev.name,
    avatar: sanitizeAvatar(avatar) || prev.avatar,
    wins: (Number(prev.wins) || 0) + (win ? 1 : 0),
    games: (Number(prev.games) || 0) + 1,
    lasts: (Number(prev.lasts) || 0) + (last ? 1 : 0),
    updatedAt: Date.now(),
  };
}

function recordGame(room) {
  const order = room && Array.isArray(room.finishOrder) ? room.finishOrder : [];
  const seats = room && Array.isArray(room.seats) ? room.seats : [];
  if (order.length < 2) return;
  const seen = new Set();
  let changed = false;
  for (let i = 0; i < order.length; i++) {
    const player = seats[order[i]];
    if (!player || !player.clerkUserId) continue;
    const id = sanitizeId(player.clerkUserId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    bump(id, player.name, player.avatar, { win: i === 0, last: i === order.length - 1 });
    changed = true;
  }
  if (changed) save();
}

function top(limit) {
  const n = Math.max(1, Math.min(100, Number(limit) || TOP));
  return Object.keys(store.users)
    .map((id) => {
      const u = store.users[id];
      return {
        id,
        name: sanitizeName(u && u.name),
        avatar: sanitizeAvatar(u && u.avatar),
        wins: Number(u && u.wins) || 0,
        games: Number(u && u.games) || 0,
        lasts: Number(u && u.lasts) || 0,
      };
    })
    .sort(
      (a, b) =>
        b.wins - a.wins || b.games - a.games || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    )
    .slice(0, n)
    .map((row, i) => ({ rank: i + 1, ...row }));
}

load();

module.exports = { recordGame, top };
