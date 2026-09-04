"use strict";

const fs = require("fs");
const path = require("path");

const TOP = 25;
const CLERK_META_KEY = "citrons";
const DEFAULT_LIVE_PK = "pk_live_";
const RECENT_MAX = 40;

let store = { users: {}, matches: 0 };
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

function emptyPlaces() {
  return [0, 0, 0, 0, 0];
}

function emptyFields() {
  return { 2: 0, 3: 0, 4: 0, 5: 0 };
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function numPlaces(v) {
  const out = emptyPlaces();
  if (Array.isArray(v)) {
    for (let i = 0; i < 5; i++) out[i] = num(v[i]);
  } else if (v && typeof v === "object") {
    for (let i = 0; i < 5; i++) out[i] = num(v[i + 1] ?? v[String(i + 1)]);
  }
  return out;
}

function numFields(v) {
  const out = emptyFields();
  if (!v || typeof v !== "object") return out;
  for (const n of [2, 3, 4, 5]) out[n] = num(v[n] ?? v[String(n)]);
  return out;
}

function numRecent(list) {
  if (!Array.isArray(list)) return [];
  const rows = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const field = num(item.field);
    const place = num(item.place);
    if (field < 2 || field > 5 || place < 1 || place > field) continue;
    rows.push({
      at: num(item.at) || Date.now(),
      field,
      place,
      points: num(item.points) || Math.max(0, field - place),
    });
  }
  return rows.slice(-RECENT_MAX);
}

function emptySeason() {
  return { games: 0, wins: 0, lasts: 0 };
}

function numSeason(v) {
  if (!v || typeof v !== "object") return emptySeason();
  return { games: num(v.games), wins: num(v.wins), lasts: num(v.lasts) };
}

function seasonHasData(s) {
  return !!(s && (num(s.games) || num(s.wins) || num(s.lasts)));
}

function normalizeRow(raw) {
  const prev = raw && typeof raw === "object" ? raw : {};
  const name = sanitizeName(prev.name);
  const avatar = sanitizeAvatar(prev.avatar);
  if (prev.season1 && typeof prev.season1 === "object") {
    const places = numPlaces(prev.places);
    const fields = numFields(prev.fields);
    const points = num(prev.points);
    return {
      name,
      avatar,
      season1: numSeason(prev.season1),
      points,
      games: num(prev.games),
      wins: num(prev.wins),
      lasts: num(prev.lasts),
      places,
      fields,
      beaten: num(prev.beaten) || points,
      faced: num(prev.faced),
      streak: num(prev.streak),
      bestStreak: num(prev.bestStreak),
      lastPlace: num(prev.lastPlace),
      lastField: num(prev.lastField),
      lastPoints: num(prev.lastPoints),
      lastPlayedAt: num(prev.lastPlayedAt) || num(prev.updatedAt),
      updatedAt: num(prev.updatedAt) || Date.now(),
      recent: numRecent(prev.recent),
    };
  }
  return {
    name,
    avatar,
    season1: {
      games: num(prev.games),
      wins: num(prev.wins) || numPlaces(prev.places)[0],
      lasts: num(prev.lasts),
    },
    points: 0,
    games: 0,
    wins: 0,
    lasts: 0,
    places: emptyPlaces(),
    fields: emptyFields(),
    beaten: 0,
    faced: 0,
    streak: 0,
    bestStreak: 0,
    lastPlace: 0,
    lastField: 0,
    lastPoints: 0,
    lastPlayedAt: 0,
    updatedAt: num(prev.updatedAt) || Date.now(),
    recent: [],
  };
}

function winsTotal() {
  let n = 0;
  for (const row of Object.values(store.users)) {
    const u = row || {};
    n += num(u.wins);
    n += num(u.season1 && u.season1.wins);
  }
  return n;
}

function liftMatches() {
  const floor = winsTotal();
  if (num(store.matches) < floor) store.matches = floor;
}

function load() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.users && typeof parsed.users === "object") {
      const users = {};
      for (const [id, row] of Object.entries(parsed.users)) {
        const clean = sanitizeId(id);
        if (clean) users[clean] = normalizeRow(row);
      }
      store = { users, matches: num(parsed.matches) };
    }
    if (Array.isArray(parsed && parsed.pending)) {
      for (const id of parsed.pending) {
        if (sanitizeId(id)) pending.add(sanitizeId(id));
      }
    }
    liftMatches();
    saveSafe();
  } catch {
    store = { users: {}, matches: 0 };
  }
}

function save() {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ users: store.users, matches: num(store.matches), pending: [...pending] }, null, 2)
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

function rowNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const aGames = num(a.games);
  const bGames = num(b.games);
  if (aGames !== bGames) return aGames > bGames;
  const aPts = num(a.points);
  const bPts = num(b.points);
  if (aPts !== bPts) return aPts > bPts;
  return (num(a.updatedAt) || 0) >= (num(b.updatedAt) || 0);
}

function bump(userId, name, avatar, { place, field }) {
  const id = sanitizeId(userId);
  if (!id) return "";
  const n = num(field);
  const p = num(place);
  if (n < 2 || n > 5 || p < 1 || p > n) return "";
  const pts = n - p;
  const prev = normalizeRow(store.users[id]);
  const places = [...prev.places];
  places[p - 1] += 1;
  const fields = { ...prev.fields };
  fields[n] = (fields[n] || 0) + 1;
  const win = p === 1;
  const last = p === n;
  const streak = win ? prev.streak + 1 : 0;
  const recent = [
    ...prev.recent,
    { at: Date.now(), field: n, place: p, points: pts },
  ].slice(-RECENT_MAX);
  store.users[id] = {
    name: sanitizeName(name) || prev.name,
    avatar: sanitizeAvatar(avatar) || prev.avatar,
    season1: prev.season1 || emptySeason(),
    points: prev.points + pts,
    games: prev.games + 1,
    wins: prev.wins + (win ? 1 : 0),
    lasts: prev.lasts + (last ? 1 : 0),
    places,
    fields,
    beaten: prev.beaten + pts,
    faced: prev.faced + (n - 1),
    streak,
    bestStreak: Math.max(prev.bestStreak, streak),
    lastPlace: p,
    lastField: n,
    lastPoints: pts,
    lastPlayedAt: Date.now(),
    updatedAt: Date.now(),
    recent,
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
  const row = normalizeRow({
    ...meta,
    name: meta.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username,
    avatar: meta.avatar || user.image_url,
  });
  if (row.games <= 0 && row.wins <= 0 && row.points <= 0 && !seasonHasData(row.season1)) return null;
  const id = sanitizeId(user.id);
  if (!id) return null;
  return { id, row };
}

function citronsPayload(row) {
  const n = normalizeRow(row);
  return {
    name: n.name,
    avatar: n.avatar,
    season1: n.season1,
    points: n.points,
    games: n.games,
    wins: n.wins,
    lasts: n.lasts,
    places: n.places,
    fields: n.fields,
    beaten: n.beaten,
    faced: n.faced,
    streak: n.streak,
    bestStreak: n.bestStreak,
    lastPlace: n.lastPlace,
    lastField: n.lastField,
    lastPoints: n.lastPoints,
    lastPlayedAt: n.lastPlayedAt,
    updatedAt: n.updatedAt,
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
  const next = normalizeRow(parsed.row);
  const prev = store.users[parsed.id];
  if (rowNewer(next, prev)) {
    const season1 = seasonHasData(next.season1) ? next.season1 : (prev && prev.season1) || next.season1;
    store.users[parsed.id] = {
      ...next,
      season1,
      recent: (prev && prev.recent) || next.recent || [],
    };
    pending.delete(parsed.id);
    return true;
  }
  if (prev && !rowNewer(next, prev)) pending.add(parsed.id);
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
  liftMatches();
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
  const field = order.length;
  if (field < 2 || field > 5) return;
  const seen = new Set();
  const changed = [];
  for (let i = 0; i < order.length; i++) {
    const player = seats[order[i]];
    if (!player || !player.clerkUserId) continue;
    const id = sanitizeId(player.clerkUserId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    bump(id, player.name, player.avatar, { place: i + 1, field });
    pending.add(id);
    changed.push(id);
  }
  store.matches = num(store.matches) + 1;
  saveSafe();
  if (changed.length === 0) return;
  Promise.all(changed.map((id) => pushUserToClerkWithRetry(id, store.users[id]))).catch((err) => {
    console.error("leaderboard clerk sync failed", err);
  });
}

function onBoard(u) {
  return num(u.games) > 0 || num(u.points) > 0 || seasonHasData(u.season1);
}

function top(limit) {
  const n = Math.max(1, Math.min(100, Number(limit) || TOP));
  return Object.keys(store.users)
    .map((id) => {
      const u = normalizeRow(store.users[id]);
      return {
        id,
        name: u.name,
        avatar: u.avatar,
        points: u.points,
        games: u.games,
        wins: u.wins,
        lasts: u.lasts,
        season1: u.season1,
      };
    })
    .filter((row) => onBoard(row))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.games - a.games ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    )
    .slice(0, n)
    .map(({ season1: _season1, ...row }, i) => ({ rank: i + 1, ...row }));
}

function matches() {
  return num(store.matches);
}

function stats(userId) {
  const id = sanitizeId(userId);
  const stored = id ? store.users[id] : null;
  if (!stored) {
    return {
      id: id || "",
      name: "Player",
      avatar: "",
      season1: { games: 0, wins: 0 },
      season: { games: 0, points: 0, wins: 0, lasts: 0 },
    };
  }
  const u = normalizeRow(stored);
  return {
    id,
    name: u.name,
    avatar: u.avatar,
    season1: { games: u.season1.games, wins: u.season1.wins },
    season: {
      games: u.games,
      points: u.points,
      wins: u.wins,
      lasts: u.lasts,
    },
  };
}

function info() {
  return {
    file: filePath(),
    clerk: !!clerkKey(),
    clerkKind: clerkKind(),
    expectedKind: expectedClerkKind(),
    mismatch: clerkMismatch(),
    players: Object.keys(store.users).length,
    matches: num(store.matches),
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

module.exports = { recordGame, top, matches, stats, hydrateFromClerk, info, startSyncLoop };
