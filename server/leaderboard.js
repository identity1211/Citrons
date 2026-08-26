"use strict";

const fs = require("fs");
const path = require("path");

const TOP = 25;
const CLERK_META_KEY = "citrons";

let store = { users: {} };

function clerkKey() {
  return String(process.env.CLERK_SECRET_KEY || "").trim();
}

function filePath() {
  if (process.env.LEADERBOARD_FILE) return process.env.LEADERBOARD_FILE;
  const vol = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").replace(/\/$/, "");
  if (vol) return path.join(vol, "leaderboard.json");
  return path.join(__dirname, "..", "data", "leaderboard.json");
}

function load() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.users && typeof parsed.users === "object") store = { users: parsed.users };
  } catch {
    store = { users: {} };
  }
}

function save() {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
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
  if (!id) return "";
  const prev = store.users[id] || { name: "Player", avatar: "", wins: 0, games: 0, lasts: 0 };
  store.users[id] = {
    name: sanitizeName(name) || prev.name,
    avatar: sanitizeAvatar(avatar) || prev.avatar,
    wins: (Number(prev.wins) || 0) + (win ? 1 : 0),
    games: (Number(prev.games) || 0) + 1,
    lasts: (Number(prev.lasts) || 0) + (last ? 1 : 0),
    updatedAt: Date.now(),
  };
  return id;
}

async function clerkApi(method, urlPath, body) {
  const key = clerkKey();
  if (!key) return null;
  const res = await fetch(`https://api.clerk.com/v1${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`clerk ${method} ${urlPath} ${res.status} ${text.slice(0, 180)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function rowFromClerkUser(user) {
  const meta = user && user.public_metadata && user.public_metadata[CLERK_META_KEY];
  if (!meta || typeof meta !== "object") return null;
  const games = Number(meta.games) || 0;
  const wins = Number(meta.wins) || 0;
  if (games <= 0 && wins <= 0) return null;
  const id = sanitizeId(user.id);
  if (!id) return null;
  const nameFromClerk = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username;
  return {
    id,
    row: {
      name: sanitizeName(meta.name || nameFromClerk),
      avatar: sanitizeAvatar(meta.avatar || user.image_url),
      wins,
      games,
      lasts: Number(meta.lasts) || 0,
      updatedAt: Number(meta.updatedAt) || Date.now(),
    },
  };
}

async function pushUserToClerk(id, row) {
  if (!clerkKey() || !id || !row) return;
  await clerkApi("PATCH", `/users/${encodeURIComponent(id)}`, {
    public_metadata: {
      [CLERK_META_KEY]: {
        wins: Number(row.wins) || 0,
        games: Number(row.games) || 0,
        lasts: Number(row.lasts) || 0,
        name: sanitizeName(row.name),
        avatar: sanitizeAvatar(row.avatar),
        updatedAt: Number(row.updatedAt) || Date.now(),
      },
    },
  });
}

async function hydrateFromClerk() {
  if (!clerkKey()) return;
  let offset = 0;
  let found = 0;
  for (;;) {
    const batch = await clerkApi("GET", `/users?limit=100&offset=${offset}&order_by=-updated_at`);
    const list = Array.isArray(batch) ? batch : [];
    if (list.length === 0) break;
    for (const user of list) {
      const parsed = rowFromClerkUser(user);
      if (!parsed) continue;
      const prev = store.users[parsed.id];
      if (!prev || (Number(parsed.row.games) || 0) >= (Number(prev.games) || 0)) {
        store.users[parsed.id] = parsed.row;
        found++;
      }
    }
    offset += list.length;
    if (list.length < 100) break;
  }
  if (found) {
    try {
      save();
    } catch (err) {
      console.error("leaderboard file save after clerk hydrate failed", err);
    }
  }
}

function recordGame(room) {
  const order = room && Array.isArray(room.finishOrder) ? room.finishOrder : [];
  const seats = room && Array.isArray(room.seats) ? room.seats : [];
  if (order.length < 2) return;
  const seen = new Set();
  const changed = [];
  for (let i = 0; i < order.length; i++) {
    const player = seats[order[i]];
    if (!player || !player.clerkUserId) continue;
    const id = sanitizeId(player.clerkUserId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    bump(id, player.name, player.avatar, { win: i === 0, last: i === order.length - 1 });
    changed.push(id);
  }
  if (changed.length === 0) return;
  save();
  Promise.all(changed.map((id) => pushUserToClerk(id, store.users[id]))).catch((err) => {
    console.error("leaderboard clerk sync failed", err);
  });
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

function info() {
  return {
    file: filePath(),
    clerk: !!clerkKey(),
    players: Object.keys(store.users).length,
  };
}

load();

module.exports = { recordGame, top, hydrateFromClerk, info };
