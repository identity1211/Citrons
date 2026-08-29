"use strict";

const fs = require("fs");
const path = require("path");

const TOP = 25;
const CLERK_META_KEY = "citrons";
const DEFAULT_LIVE_PK = "pk_live_";

let store = { users: {} };
const pending = new Set();
let lastError = "";
let flushTimer = null;

function clerkKey() {
  return String(process.env.CLERK_SECRET_KEY || "").trim();
}

function clerkKind() {
  const key = clerkKey();
  if (!key) return "off";
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return "other";
}

function expectedClerkKind() {
  const pk = String(process.env.CLERK_PUBLISHABLE_KEY || DEFAULT_LIVE_PK).trim();
  if (pk.startsWith("pk_live_")) return "live";
  if (pk.startsWith("pk_test_")) return "test";
  return "";
}

function clerkMismatch() {
  const kind = clerkKind();
  const expected = expectedClerkKind();
  return kind !== "off" && !!expected && kind !== expected;
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
    if (Array.isArray(parsed && parsed.pending)) {
      for (const id of parsed.pending) {
        if (sanitizeId(id)) pending.add(sanitizeId(id));
      }
    }
  } catch {
    store = { users: {} };
  }
}

function save() {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ users: store.users, pending: [...pending] }, null, 2)
  );
  fs.renameSync(tmp, file);
}

function saveSafe() {
  try {
    save();
  } catch (err) {
    console.error("leaderboard file save failed", err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function rowNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const aGames = Number(a.games) || 0;
  const bGames = Number(b.games) || 0;
  if (aGames !== bGames) return aGames > bGames;
  return (Number(a.updatedAt) || 0) >= (Number(b.updatedAt) || 0);
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

function citronsPayload(row) {
  return {
    wins: Number(row.wins) || 0,
    games: Number(row.games) || 0,
    lasts: Number(row.lasts) || 0,
    name: sanitizeName(row.name),
    avatar: sanitizeAvatar(row.avatar),
    updatedAt: Number(row.updatedAt) || Date.now(),
  };
}

async function pushUserToClerk(id, row) {
  if (!clerkKey() || !id || !row) return;
  await clerkApi("PATCH", `/users/${encodeURIComponent(id)}/metadata`, {
    public_metadata: {
      [CLERK_META_KEY]: citronsPayload(row),
    },
  });
}

async function pushUserToClerkWithRetry(id, row, attempts = 6) {
  if (!clerkKey() || !id || !row) return false;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await pushUserToClerk(id, row);
      pending.delete(id);
      lastError = "";
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** i);
    }
  }
  pending.add(id);
  lastError = String((lastErr && lastErr.message) || lastErr || "clerk sync failed").slice(0, 180);
  console.error("leaderboard clerk sync failed", lastErr);
  saveSafe();
  return false;
}

async function flushPending() {
  if (!clerkKey() || pending.size === 0) return;
  for (const id of [...pending]) {
    const row = store.users[id];
    if (!row) {
      pending.delete(id);
      continue;
    }
    await pushUserToClerkWithRetry(id, row, 3);
  }
  saveSafe();
}

function clerkUsersFromResponse(batch) {
  if (Array.isArray(batch)) return batch;
  if (batch && Array.isArray(batch.data)) return batch.data;
  return [];
}

async function listClerkUsers(offset) {
  try {
    return clerkUsersFromResponse(
      await clerkApi("GET", `/users?limit=100&offset=${offset}&order_by=-updated_at`)
    );
  } catch (err) {
    console.warn("leaderboard clerk list with order_by failed, retrying", err && err.message);
    return clerkUsersFromResponse(await clerkApi("GET", `/users?limit=100&offset=${offset}`));
  }
}

async function parsedRowFromListedUser(user) {
  let parsed = rowFromClerkUser(user);
  if (parsed || !user || !user.id) return parsed;
  if (user.public_metadata && Object.keys(user.public_metadata).length) return null;
  try {
    const full = await clerkApi("GET", `/users/${encodeURIComponent(user.id)}`);
    return rowFromClerkUser(full);
  } catch (err) {
    console.warn("leaderboard clerk user fetch failed", user.id, err && err.message);
    return null;
  }
}

function mergeClerkRow(parsed) {
  if (!parsed) return false;
  const prev = store.users[parsed.id];
  if (rowNewer(parsed.row, prev)) {
    store.users[parsed.id] = parsed.row;
    pending.delete(parsed.id);
    return true;
  }
  if (prev && !rowNewer(parsed.row, prev)) pending.add(parsed.id);
  return false;
}

async function hydrateFromClerk() {
  if (!clerkKey()) {
    console.error("leaderboard CLERK_SECRET_KEY missing; scores will not survive deploys");
    return;
  }
  if (clerkMismatch()) {
    console.error(
      `leaderboard secret is ${clerkKind()} but the app expects ${expectedClerkKind()}; live scores will not persist`
    );
  }
  let offset = 0;
  let found = 0;
  for (;;) {
    const list = await listClerkUsers(offset);
    if (list.length === 0) break;
    const pageHasMeta = list.some(
      (user) => user && user.public_metadata && Object.keys(user.public_metadata).length
    );
    for (const user of list) {
      const parsed = pageHasMeta ? rowFromClerkUser(user) : await parsedRowFromListedUser(user);
      if (mergeClerkRow(parsed)) found++;
    }
    offset += list.length;
    if (list.length < 100) break;
  }
  saveSafe();
  console.log(
    `leaderboard hydrate clerk=${clerkKind()} scored=${found} store=${Object.keys(store.users).length} pending=${pending.size}`
  );
  await flushPending();
  await healClerkFromStore();
}

async function healClerkFromStore() {
  if (!clerkKey()) return;
  const ids = Object.keys(store.users);
  for (const id of ids) {
    await pushUserToClerkWithRetry(id, store.users[id], 4);
  }
  saveSafe();
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
    pending.add(id);
    changed.push(id);
  }
  if (changed.length === 0) return;
  saveSafe();
  Promise.all(changed.map((id) => pushUserToClerkWithRetry(id, store.users[id]))).catch((err) => {
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
    clerkKind: clerkKind(),
    expectedKind: expectedClerkKind(),
    mismatch: clerkMismatch(),
    players: Object.keys(store.users).length,
    pending: pending.size,
    lastError,
  };
}

function startSyncLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushPending().catch((err) => console.error("leaderboard pending flush failed", err));
  }, 30 * 1000);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

load();

module.exports = { recordGame, top, hydrateFromClerk, info, startSyncLoop };
