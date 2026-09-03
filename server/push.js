"use strict";

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const SITE = "https://citrons.lat";
const MAX_USERS = 80;
const MAX_SUBS = 4;

let store = { users: {} };
let vapid = { publicKey: "", privateKey: "" };

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
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadStore() {
  const parsed = loadJson(storePath(), null);
  if (parsed && parsed.users && typeof parsed.users === "object") store = { users: parsed.users };
}

function saveStore() {
  try {
    saveJson(storePath(), store);
  } catch (err) {
    console.error("push store save failed", err);
  }
}

function loadVapid() {
  const envPub = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const envPriv = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  if (envPub && envPriv) {
    vapid = { publicKey: envPub, privateKey: envPriv };
    return;
  }
  const saved = loadJson(vapidPath(), null);
  if (saved && saved.publicKey && saved.privateKey) {
    vapid = { publicKey: String(saved.publicKey), privateKey: String(saved.privateKey) };
    return;
  }
  vapid = webpush.generateVAPIDKeys();
  try {
    saveJson(vapidPath(), vapid);
    console.log("push: generated VAPID keys — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY on Railway to keep them across deploys");
  } catch (err) {
    console.error("push: could not persist VAPID keys", err);
  }
}

function init() {
  loadStore();
  loadVapid();
  if (!vapid.publicKey || !vapid.privateKey) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || SITE, vapid.publicKey, vapid.privateKey);
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
  return true;
}

function unsubscribe(userId, endpoint) {
  const id = sanitizeId(userId);
  const ep = String(endpoint || "").trim();
  const row = store.users[id];
  if (!row || !ep) return;
  row.subs = (row.subs || []).filter((s) => s.endpoint !== ep);
  row.updatedAt = Date.now();
  if (row.subs.length === 0) delete store.users[id];
  saveStore();
}

function dropEndpoint(endpoint) {
  const ep = String(endpoint || "").trim();
  if (!ep) return;
  let changed = false;
  for (const id of Object.keys(store.users)) {
    const row = store.users[id];
    const next = (row.subs || []).filter((s) => s.endpoint !== ep);
    if (next.length !== (row.subs || []).length) {
      changed = true;
      if (next.length === 0) delete store.users[id];
      else {
        row.subs = next;
        row.updatedAt = Date.now();
      }
    }
  }
  if (changed) saveStore();
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
};
