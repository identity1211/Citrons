"use strict";

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const SITE = "https://citrons.lat";
const MAX_USERS = 80;
const MAX_SUBS = 4;
const CLERK_PUSH_KEY = "citrons_push";

let store = { users: {} };
let vapid = { publicKey: "", privateKey: "" };
let vapidSource = "none";
let lastError = "";
const pending = new Set();
let flushTimer = null;

function clerkKey() {
  return String(process.env.CLERK_SECRET_KEY || "").trim();
}

function dataDir() {
  const vol = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").replace(/\/$/, "");
  if (vol) return vol;
  return path.join(__dirname, "..", "data");
}

function storePath() {
  if (process.env.PUSH_FILE) return process.env.PUSH_FILE;
  return path.join(dataDir(), "push.json");
}

function vapidPath() {
  if (process.env.VAPID_FILE) return process.env.VAPID_FILE;
  return path.join(dataDir(), "vapid.json");
}

function volumeMounted() {
  return !!String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
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

function validSub(sub) {
  if (!sub || typeof sub !== "object") return null;
  const endpoint = String(sub.endpoint || "").trim();
  const p256dh = String((sub.keys && sub.keys.p256dh) || "").trim();
  const auth = String((sub.keys && sub.keys.auth) || "").trim();
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 4000) return null;
  if (p256dh.length < 20 || p256dh.length > 400) return null;
  if (auth.length < 8 || auth.length > 200) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function normalizeSubs(raw) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const sub = validSub(item);
    if (!sub || seen.has(sub.endpoint)) continue;
    seen.add(sub.endpoint);
    out.push({
      ...sub,
      updatedAt: Number(item && item.updatedAt) || Date.now(),
    });
    if (out.length >= MAX_SUBS) break;
  }
  return out;
}

function normalizeRow(raw, fallbackName, fallbackAvatar) {
  const prev = raw && typeof raw === "object" ? raw : {};
  return {
    name: sanitizeName(prev.name || fallbackName),
    avatar: sanitizeAvatar(prev.avatar || fallbackAvatar),
    subs: normalizeSubs(prev.subs),
    updatedAt: Number(prev.updatedAt) || Date.now(),
  };
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, body);
  try {
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    /* some hosts disallow fsync; rename still helps */
  }
  fs.renameSync(tmp, file);
}

function loadStore() {
  const parsed = loadJson(storePath(), null);
  if (!parsed || !parsed.users || typeof parsed.users !== "object") return;
  const users = {};
  for (const [id, row] of Object.entries(parsed.users)) {
    const clean = sanitizeId(id);
    if (!clean) continue;
    const next = normalizeRow(row);
    if (next.subs.length === 0) continue;
    users[clean] = next;
  }
  store = { users };
}

function saveStore() {
  try {
    saveJson(storePath(), store);
    lastError = "";
  } catch (err) {
    lastError = String((err && err.message) || err).slice(0, 180);
    console.error("push store save failed", err);
  }
}

function loadVapid() {
  const envPub = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const envPriv = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  if (envPub && envPriv) {
    vapid = { publicKey: envPub, privateKey: envPriv };
    vapidSource = "env";
    return;
  }
  const saved = loadJson(vapidPath(), null);
  if (saved && saved.publicKey && saved.privateKey) {
    vapid = { publicKey: String(saved.publicKey), privateKey: String(saved.privateKey) };
    vapidSource = "file";
    return;
  }
  vapid = webpush.generateVAPIDKeys();
  vapidSource = "generated";
  try {
    saveJson(vapidPath(), vapid);
    console.log(
      "push: generated VAPID keys and saved to",
      vapidPath(),
      "— set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY on Railway so keys never rotate"
    );
  } catch (err) {
    lastError = String((err && err.message) || err).slice(0, 180);
    console.error(
      "push: CRITICAL could not persist VAPID keys; invites will break after the next redeploy",
      err
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function clerkPayload(row) {
  const n = normalizeRow(row);
  return {
    name: n.name,
    avatar: n.avatar,
    subs: n.subs,
    updatedAt: n.updatedAt,
  };
}

async function pushUserToClerk(id, row) {
  if (!clerkKey() || !id || !row) return;
  await clerkApi("PATCH", `/users/${encodeURIComponent(id)}/metadata`, {
    private_metadata: {
      [CLERK_PUSH_KEY]: clerkPayload(row),
    },
  });
}

async function pushUserToClerkWithRetry(id, row, attempts = 5) {
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
      await sleep(350 * 2 ** i);
    }
  }
  pending.add(id);
  lastError = String((lastErr && lastErr.message) || lastErr || "clerk push sync failed").slice(0, 180);
  console.error("push clerk sync failed", lastErr);
  return false;
}

function queueClerkSync(id) {
  const row = store.users[id];
  if (!row || !clerkKey()) return;
  pending.add(id);
  void pushUserToClerkWithRetry(id, row);
}

async function clearClerkPush(id) {
  if (!clerkKey() || !id) return;
  try {
    await clerkApi("PATCH", `/users/${encodeURIComponent(id)}/metadata`, {
      private_metadata: {
        [CLERK_PUSH_KEY]: null,
      },
    });
    pending.delete(id);
  } catch (err) {
    pending.add(id);
    lastError = String((err && err.message) || err).slice(0, 180);
    console.error("push clerk clear failed", err);
  }
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
    console.warn("push clerk list with order_by failed, retrying", err && err.message);
    return clerkUsersFromResponse(await clerkApi("GET", `/users?limit=100&offset=${offset}`));
  }
}

function mergeRow(into, from) {
  const a = normalizeRow(into);
  const b = normalizeRow(from);
  const byEp = new Map();
  for (const sub of [...b.subs, ...a.subs]) {
    if (!byEp.has(sub.endpoint)) byEp.set(sub.endpoint, sub);
  }
  const subs = [...byEp.values()]
    .sort((x, y) => (Number(y.updatedAt) || 0) - (Number(x.updatedAt) || 0))
    .slice(0, MAX_SUBS);
  return {
    name: a.updatedAt >= b.updatedAt ? a.name : b.name || a.name,
    avatar: a.updatedAt >= b.updatedAt ? a.avatar || b.avatar : b.avatar || a.avatar,
    subs,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

async function healClerkFromStore() {
  if (!clerkKey()) return;
  const ids = Object.keys(store.users);
  for (const id of ids) {
    await pushUserToClerkWithRetry(id, store.users[id], 4);
  }
}

async function hydrateFromClerk() {
  if (!clerkKey()) {
    console.warn("push: CLERK_SECRET_KEY missing; invite list will not survive redeploys without a Railway volume");
    return { found: 0 };
  }
  let offset = 0;
  let found = 0;
  for (;;) {
    const batch = await listClerkUsers(offset);
    if (!batch.length) break;
    for (const user of batch) {
      const id = sanitizeId(user && user.id);
      const meta = user && user.private_metadata && user.private_metadata[CLERK_PUSH_KEY];
      if (!id || !meta || typeof meta !== "object") continue;
      const incoming = normalizeRow(meta, [user.first_name, user.last_name].filter(Boolean).join(" "), user.image_url);
      if (incoming.subs.length === 0) continue;
      store.users[id] = store.users[id] ? mergeRow(store.users[id], incoming) : incoming;
      found += 1;
    }
    if (batch.length < 100) break;
    offset += batch.length;
    if (offset > 2000) break;
  }
  if (found) saveStore();
  console.log(
    `push hydrate clerk users=${found} store=${Object.keys(store.users).length} file=${storePath()} volume=${volumeMounted()}`
  );
  await flushPending();
  await healClerkFromStore();
  return { found };
}

async function flushPending() {
  if (!clerkKey() || pending.size === 0) return;
  for (const id of [...pending]) {
    const row = store.users[id];
    if (!row) {
      pending.delete(id);
      void clearClerkPush(id);
      continue;
    }
    await pushUserToClerkWithRetry(id, row, 3);
  }
}

function startSyncLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushPending().catch((err) => console.error("push pending flush failed", err));
  }, 30 * 1000);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

function init() {
  loadStore();
  loadVapid();
  if (!vapid.publicKey || !vapid.privateKey) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || SITE, vapid.publicKey, vapid.privateKey);
  console.log(
    `push ready file=${storePath()} vapid=${vapidSource} users=${Object.keys(store.users).length} volume=${volumeMounted()} clerk=${!!clerkKey()}`
  );
  if (!volumeMounted() && vapidSource !== "env") {
    console.error(
      "push: Railway volume not mounted and VAPID is not in env — set RAILWAY_VOLUME_MOUNT_PATH or VAPID_* so invites survive deploys"
    );
  }
}

function publicKey() {
  return vapid.publicKey || "";
}

function ready() {
  return !!(vapid.publicKey && vapid.privateKey);
}

function subscribe(userId, name, avatar, subscription) {
  const id = sanitizeId(userId);
  const sub = validSub(subscription);
  if (!id || !sub) return false;
  const prev = store.users[id] || { name: "Player", avatar: "", subs: [], updatedAt: 0 };
  const rest = (Array.isArray(prev.subs) ? prev.subs : []).filter((s) => s && s.endpoint !== sub.endpoint);
  rest.unshift({ ...sub, updatedAt: Date.now() });
  store.users[id] = {
    name: sanitizeName(name) || prev.name,
    avatar: sanitizeAvatar(avatar) || prev.avatar,
    subs: rest.slice(0, MAX_SUBS),
    updatedAt: Date.now(),
  };
  saveStore();
  queueClerkSync(id);
  return true;
}

function unsubscribe(userId, endpoint) {
  const id = sanitizeId(userId);
  const ep = String(endpoint || "").trim();
  const row = store.users[id];
  if (!row || !ep) return;
  row.subs = (row.subs || []).filter((s) => s.endpoint !== ep);
  row.updatedAt = Date.now();
  if (row.subs.length === 0) {
    delete store.users[id];
    saveStore();
    void clearClerkPush(id);
    return;
  }
  saveStore();
  queueClerkSync(id);
}

function dropEndpoint(endpoint) {
  const ep = String(endpoint || "").trim();
  if (!ep) return;
  let changed = false;
  const cleared = [];
  for (const id of Object.keys(store.users)) {
    const row = store.users[id];
    const next = (row.subs || []).filter((s) => s.endpoint !== ep);
    if (next.length !== (row.subs || []).length) {
      changed = true;
      if (next.length === 0) {
        delete store.users[id];
        cleared.push(id);
      } else {
        row.subs = next;
        row.updatedAt = Date.now();
        queueClerkSync(id);
      }
    }
  }
  if (changed) saveStore();
  for (const id of cleared) void clearClerkPush(id);
}

function listUsers(exceptId) {
  const skip = sanitizeId(exceptId);
  const rows = [];
  for (const [id, row] of Object.entries(store.users)) {
    if (id === skip) continue;
    if (!row || !Array.isArray(row.subs) || row.subs.length === 0) continue;
    rows.push({
      id,
      name: sanitizeName(row.name),
      avatar: sanitizeAvatar(row.avatar),
      updatedAt: Number(row.updatedAt) || 0,
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, MAX_USERS).map(({ id, name, avatar }) => ({ id, name, avatar }));
}

async function sendOne(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      { TTL: 300, urgency: "high" }
    );
    return true;
  } catch (err) {
    const status = err && (err.statusCode || err.status);
    if (status === 404 || status === 410) dropEndpoint(sub.endpoint);
    else console.error("push send failed", status || err);
    return false;
  }
}

async function sendToUser(userId, payload) {
  if (!ready()) return { sent: 0, failed: 1 };
  const id = sanitizeId(userId);
  const row = store.users[id];
  const subs = row && Array.isArray(row.subs) ? row.subs : [];
  if (!id || subs.length === 0) return { sent: 0, failed: 1 };
  let ok = false;
  for (const sub of subs) {
    if (await sendOne(sub, payload)) ok = true;
  }
  return ok ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 };
}

function sitePayload(body, url) {
  return {
    title: "Citrons",
    body,
    url: url || SITE,
    icon: `${SITE}/icon-192.png`,
    badge: `${SITE}/icon-192.png`,
  };
}

async function sendWelcome(userId) {
  return sendToUser(userId, sitePayload("Invites are on. This is how a table invite will look.", SITE));
}

async function sendTest(userId) {
  return sendToUser(userId, sitePayload("Test ping from Citrons.", SITE));
}

async function sendInvite({ fromName, code, title, userIds }) {
  if (!ready()) return { sent: 0, failed: userIds.length };
  const bodyTitle = sanitizeName(fromName);
  const room = String(code || "")
    .trim()
    .toUpperCase()
    .slice(0, 12);
  const roomTitle = String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
  const payload = sitePayload(
    roomTitle ? `${bodyTitle} invited you to ${roomTitle}` : `${bodyTitle} invited you to play · ${room}`,
    `${SITE}/?join=${encodeURIComponent(room)}`
  );
  let sent = 0;
  let failed = 0;
  const seen = new Set();
  for (const rawId of userIds) {
    const id = sanitizeId(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const result = await sendToUser(id, payload);
    if (result.sent) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}

function info() {
  let reachable = 0;
  for (const row of Object.values(store.users)) {
    if (row && Array.isArray(row.subs) && row.subs.length) reachable += 1;
  }
  return {
    ready: ready(),
    file: storePath(),
    vapidFile: vapidPath(),
    vapidSource,
    volume: volumeMounted(),
    clerk: !!clerkKey(),
    users: Object.keys(store.users).length,
    reachable,
    pending: pending.size,
    lastError: lastError || undefined,
  };
}

module.exports = {
  init,
  ready,
  publicKey,
  subscribe,
  unsubscribe,
  listUsers,
  sendInvite,
  sendWelcome,
  sendTest,
  hydrateFromClerk,
  startSyncLoop,
  info,
};
