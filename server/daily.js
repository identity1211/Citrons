"use strict";

const cache = new Map();
let lastError = "";

function apiKey() {
  return String(process.env.DAILY_API_KEY || "").trim();
}

function domainHost() {
  let d = String(process.env.DAILY_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  if (!d) return "";
  if (!d.includes(".")) d = `${d}.daily.co`;
  return d;
}

function ready() {
  return !!(apiKey() && domainHost());
}

function roomNameForCode(code) {
  const clean = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  if (!clean) return "";
  return `citrons-${clean.toLowerCase()}`;
}

function roomUrl(name) {
  return `https://${domainHost()}/${name}`;
}

async function dailyFetch(method, path, body) {
  const key = apiKey();
  if (!key) throw new Error("Daily is not configured");
  const res = await fetch(`https://api.daily.co/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 180) };
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.info || data.message)) || text.slice(0, 180);
    const err = new Error(`daily ${method} ${path} ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function ensureRoom(code) {
  const name = roomNameForCode(code);
  if (!name) throw new Error("Invalid room code");
  const cached = cache.get(name);
  if (cached && cached.url) return cached;

  try {
    await dailyFetch("POST", "/rooms", {
      name,
      privacy: "private",
      properties: {
        // Long-lived: card lobbies can sit open; short exp would kill voice mid-match.
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        eject_at_room_exp: true,
        enable_screenshare: false,
        start_audio_off: true,
        start_video_off: true,
        max_participants: 24,
        permissions: {
          canSend: ["audio"],
        },
      },
    });
  } catch (err) {
    // Room already exists — reuse it.
    if (!(err && (err.status === 400 || err.status === 409))) throw err;
  }

  const info = { name, url: roomUrl(name) };
  cache.set(name, info);
  lastError = "";
  return info;
}

function forgetRoom(code) {
  const name = roomNameForCode(code);
  if (name) cache.delete(name);
}

async function meetingToken({ code, userName, userId }) {
  if (!ready()) throw new Error("Voice chat is not configured");
  const props = {
    user_name:
      String(userName || "Player")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32) || "Player",
    user_id: String(userId || "")
      .replace(/[^\w-]/g, "")
      .slice(0, 64),
    enable_screenshare: false,
    start_audio_off: true,
    start_video_off: true,
    is_owner: false,
  };

  async function mint(room) {
    const data = await dailyFetch("POST", "/meeting-tokens", {
      properties: { ...props, room_name: room.name },
    });
    if (!data || !data.token) throw new Error("Daily did not return a token");
    return data.token;
  }

  let room = await ensureRoom(code);
  try {
    const token = await mint(room);
    lastError = "";
    return { url: room.url, token, room: room.name };
  } catch (err) {
    // Stale cache after Daily expired/deleted the room — recreate once.
    forgetRoom(code);
    room = await ensureRoom(code);
    const token = await mint(room);
    lastError = "";
    return { url: room.url, token, room: room.name };
  }
}

function info() {
  return {
    ready: ready(),
    domain: domainHost() || undefined,
    roomsCached: cache.size,
    lastError: lastError || undefined,
  };
}

function noteError(err) {
  lastError = String((err && err.message) || err).slice(0, 180);
  console.error("daily", err);
}

module.exports = {
  ready,
  meetingToken,
  info,
  noteError,
};
