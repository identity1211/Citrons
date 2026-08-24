"use strict";

const crypto = require("crypto");

const DEFAULT_CLERK_PK = process.env.CLERK_PUBLISHABLE_KEY || "pk_test_YXB0LXR1cnRsZS00MTg3LmNsZXJrLmFjY291bnRzLmRldiQ";

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
  return { ok: true, userId: sub };
}

function clerkConfigured() {
  return !!DEFAULT_CLERK_PK;
}

module.exports = { verifyClerkToken, clerkConfigured };
