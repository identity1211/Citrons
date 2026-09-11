"use strict";

const crypto = require("crypto");

const DEFAULT_CLERK_PK = process.env.CLERK_PUBLISHABLE_KEY || "pk_live_Y2xlcmsuY2l0cm9ucy5sYXQk";
const PLUS_PLAN = "plus";
const PLUS_FEATURE = "plus_perks";

function clerkSecret() {
  return String(process.env.CLERK_SECRET_KEY || "").trim();
}

function frontendApiFromPk(pk) {
  try {
    const part = String(pk || "").split("_")[2] || "";
    return Buffer.from(part, "base64").toString("utf8").replace(/\$+$/g, "");
  } catch {
    return "";
  }
}

function issuerFromPk(pk) {
  const env = String(process.env.CLERK_ISSUER || "").replace(/\/$/, "");
  if (env) return env;
  const host = frontendApiFromPk(pk);
  if (!host) return "";
  return host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host}`;
}

let jwksCache = { issuer: "", keys: [], at: 0 };
const plusCache = new Map(); // userId -> { plus, at }

function b64urlToBuf(s) {
  const pad = 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + (pad === 4 ? "" : "=".repeat(pad));
  return Buffer.from(b64, "base64");
}

async function loadJwks(issuer) {
  const now = Date.now();
  if (jwksCache.issuer === issuer && now - jwksCache.at < 60 * 60 * 1000 && jwksCache.keys.length) {
    return jwksCache.keys;
  }
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error("jwks");
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { issuer, keys, at: now };
  return keys;
}

function verifyRs256(data, signature, jwk) {
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verify = crypto.createVerify("SHA256");
  verify.update(data);
  verify.end();
  return verify.verify(key, signature);
}

function claimsIndicatePlus(payload) {
  if (!payload || typeof payload !== "object") return false;
  const pla = String(payload.pla || payload.plan || "");
  const fea = String(payload.fea || payload.features || "");
  if (/\bu:plus\b/i.test(pla) || /(^|[,:])plus($|[,:])/i.test(pla)) return true;
  if (/\bu:plus_perks\b/i.test(fea) || /(^|[,:])plus_perks($|[,:])/i.test(fea)) return true;
  return false;
}

async function verifyClerkToken(token) {
  const pk = DEFAULT_CLERK_PK;
  if (!pk) return { ok: false, reason: "no-clerk" };
  const raw = String(token || "").trim();
  if (!raw) return { ok: false, reason: "no-token" };
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "jwt" };
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "jwt" };
  }
  const expectedIss = issuerFromPk(pk);
  if (expectedIss && payload.iss && String(payload.iss).replace(/\/$/, "") !== expectedIss) {
    return { ok: false, reason: "iss" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.nbf && Number(payload.nbf) - 60 > now) return { ok: false, reason: "nbf" };
  if (payload.exp && Number(payload.exp) + 60 < now) return { ok: false, reason: "exp" };
  try {
    const issuer = String(payload.iss || expectedIss).replace(/\/$/, "");
    if (!issuer) return { ok: false, reason: "iss" };
    const keys = await loadJwks(issuer);
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
    if (!jwk) return { ok: false, reason: "jwks" };
    const ok = verifyRs256(`${parts[0]}.${parts[1]}`, b64urlToBuf(parts[2]), jwk);
    if (!ok) return { ok: false, reason: "sig" };
  } catch (err) {
    console.warn("clerk verify", err && err.message);
    return { ok: false, reason: "verify" };
  }
  const sub = String(payload.sub || "");
  if (!sub) return { ok: false, reason: "sub" };
  const plus = claimsIndicatePlus(payload);
  if (plus) plusCache.set(sub, { plus: true, at: Date.now() });
  return { ok: true, userId: sub, plus };
}

async function clerkApi(method, urlPath) {
  const key = clerkSecret();
  if (!key) return null;
  const res = await fetch(`https://api.clerk.com/v1${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`clerk ${method} ${urlPath} ${res.status} ${text.slice(0, 160)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function subscriptionLooksPlus(data) {
  if (!data || typeof data !== "object") return false;
  const items = Array.isArray(data.subscription_items)
    ? data.subscription_items
    : Array.isArray(data.items)
      ? data.items
      : [];
  for (const item of items) {
    const status = String((item && item.status) || data.status || "").toLowerCase();
    if (status && status !== "active" && status !== "trialing" && status !== "past_due") continue;
    const plan = (item && item.plan) || data.plan || {};
    const slug = String(plan.slug || plan.name || "").toLowerCase();
    if (slug === PLUS_PLAN || slug === `u:${PLUS_PLAN}`) return true;
    const feats = Array.isArray(plan.features) ? plan.features : [];
    if (feats.some((f) => String((f && f.slug) || f || "").toLowerCase() === PLUS_FEATURE)) return true;
  }
  const topSlug = String((data.plan && data.plan.slug) || "").toLowerCase();
  return topSlug === PLUS_PLAN;
}

/**
 * Future perk gates: true if Clerk Billing says this user is on Plus.
 * Prefers short cache; falls back to Backend billing subscription lookup.
 */
async function userHasPlus(userId) {
  const id = String(userId || "").trim();
  if (!id) return false;
  const cached = plusCache.get(id);
  if (cached && Date.now() - cached.at < 60 * 1000) return !!cached.plus;
  if (!clerkSecret()) return !!(cached && cached.plus);
  try {
    // Newer Billing API paths; tolerate 404 on older instances.
    let data =
      (await clerkApi("GET", `/users/${encodeURIComponent(id)}/billing/subscription`)) ||
      (await clerkApi("GET", `/billing/users/${encodeURIComponent(id)}/subscriptions`)) ||
      (await clerkApi("GET", `/users/${encodeURIComponent(id)}`));
    let plus = false;
    if (data && data.public_metadata && data.public_metadata.citrons_plus) {
      plus = true;
    } else if (Array.isArray(data && data.data)) {
      plus = data.data.some(subscriptionLooksPlus);
    } else {
      plus = subscriptionLooksPlus(data);
    }
    plusCache.set(id, { plus, at: Date.now() });
    return plus;
  } catch (err) {
    console.warn("clerk userHasPlus", err && err.message);
    return !!(cached && cached.plus);
  }
}

function clerkConfigured() {
  return !!DEFAULT_CLERK_PK;
}

module.exports = {
  verifyClerkToken,
  clerkConfigured,
  userHasPlus,
  claimsIndicatePlus,
  PLUS_PLAN,
  PLUS_FEATURE,
};
