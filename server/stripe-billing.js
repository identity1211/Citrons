"use strict";

const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const clerk = require("./clerk");

const APP_ORIGIN = "https://citrons.lat";
const META_PLUS = "citrons_plus";
const META_SUPPORTER = "citrons_supporter";
const META_PLUS_UNTIL = "citrons_plus_until";
const META_CUSTOMER = "stripeCustomerId";
const META_SUB = "stripeSubscriptionId";
const GOAL_CENTS = 3000; // €30
const DONATE_MIN_CENTS = 100; // €1
const DONATE_MAX_CENTS = 10000; // €100
const DONATE_PLUS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days of Plus perks per tip
const PROCESSED_MAX = 400;
const SPONSORS_MAX = 60;
const SPONSORS_REFRESH_MS = 10 * 60 * 1000;

function stripeSecret() {
  return String(process.env.STRIPE_SECRET_KEY || "").trim();
}

function webhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
}

function pricePlus() {
  return String(process.env.STRIPE_PRICE_PLUS || "").trim();
}

function stripeConfigured() {
  return !!(stripeSecret() && pricePlus());
}

function getStripe() {
  const key = stripeSecret();
  if (!key) return null;
  return new Stripe(key);
}

function dataDir() {
  const vol = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim().replace(/\/$/, "");
  if (vol) return vol;
  return path.join(__dirname, "..", "data");
}

function fundPath() {
  if (process.env.DONATIONS_FILE) return process.env.DONATIONS_FILE;
  return path.join(dataDir(), "donations.json");
}

function emptyFund() {
  return { raisedCents: 0, processed: [], sponsors: [], updatedAt: 0 };
}

let fund = emptyFund();
let sponsorsRefreshAt = 0;

function normalizeSponsor(raw) {
  const id = String((raw && raw.id) || "").trim();
  if (!id) return null;
  const name =
    String((raw && raw.name) || "Player")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 18) || "Player";
  return {
    id,
    name,
    avatar: String((raw && raw.avatar) || "").trim().slice(0, 500),
    plus: !!(raw && raw.plus),
    supporter: !!(raw && raw.supporter),
    at: Number((raw && raw.at) || 0) || Date.now(),
  };
}

function loadFund() {
  try {
    const raw = fs.readFileSync(fundPath(), "utf8");
    const parsed = JSON.parse(raw);
    const sponsors = Array.isArray(parsed.sponsors)
      ? parsed.sponsors.map(normalizeSponsor).filter(Boolean)
      : [];
    fund = {
      raisedCents: Math.max(0, Math.floor(Number(parsed.raisedCents) || 0)),
      processed: Array.isArray(parsed.processed) ? parsed.processed.map(String).slice(-PROCESSED_MAX) : [],
      sponsors,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    fund = emptyFund();
  }
  return fund;
}

function saveFund() {
  try {
    fs.mkdirSync(path.dirname(fundPath()), { recursive: true });
    const tmp = `${fundPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fund, null, 0));
    fs.renameSync(tmp, fundPath());
  } catch (err) {
    console.warn("donations save", err && err.message);
  }
}

loadFund();

function info() {
  return {
    ready: stripeConfigured(),
    hasSecret: !!stripeSecret(),
    hasWebhookSecret: !!webhookSecret(),
    hasPrice: !!pricePlus(),
    raisedCents: fund.raisedCents,
    goalCents: GOAL_CENTS,
  };
}

function plusUntilMs(meta) {
  if (!meta || typeof meta !== "object") return 0;
  const v = meta[META_PLUS_UNTIL] ?? meta.citronsPlusUntil;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function metaHasActivePlus(meta) {
  if (!meta || typeof meta !== "object") return false;
  const flag = meta[META_PLUS] ?? meta.citronsPlus;
  if (flag === true || flag === 1 || flag === "1" || String(flag).toLowerCase() === "true") return true;
  return plusUntilMs(meta) > Date.now();
}

function nextDonatePlusUntil(meta) {
  const existing = plusUntilMs(meta);
  const base = Math.max(Date.now(), existing);
  return base + DONATE_PLUS_MS;
}

function raisedPublic() {
  return {
    raisedCents: fund.raisedCents,
    goalCents: GOAL_CENTS,
    currency: "eur",
  };
}

function sponsorDisplayName(user) {
  if (!user || typeof user !== "object") return "Player";
  const unsafe = user.unsafe_metadata || {};
  const nick = String(unsafe.nickname || "").replace(/\s+/g, " ").trim();
  if (nick) return nick.slice(0, 18);
  const first = String(user.first_name || "").replace(/\s+/g, " ").trim();
  if (first) return first.slice(0, 18);
  const username = String(user.username || "").replace(/\s+/g, " ").trim();
  if (username) return username.slice(0, 18);
  const email = primaryEmail(user);
  if (email.includes("@")) return email.split("@")[0].slice(0, 18) || "Player";
  return "Player";
}

function writeSponsor(entry) {
  const next = normalizeSponsor(entry);
  if (!next) return;
  if (!next.plus && !next.supporter) {
    fund.sponsors = fund.sponsors.filter((s) => s.id !== next.id);
    fund.updatedAt = Date.now();
    saveFund();
    return;
  }
  const i = fund.sponsors.findIndex((s) => s.id === next.id);
  if (i >= 0) fund.sponsors[i] = { ...fund.sponsors[i], ...next, at: Date.now() };
  else fund.sponsors.push({ ...next, at: Date.now() });
  fund.sponsors.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (fund.sponsors.length > SPONSORS_MAX) fund.sponsors = fund.sponsors.slice(0, SPONSORS_MAX);
  fund.updatedAt = Date.now();
  saveFund();
}

async function syncSponsor(userId) {
  const id = String(userId || "").trim();
  if (!id) return;
  let user = null;
  try {
    user = await loadClerkUser(id);
  } catch (err) {
    console.warn("sponsor sync load", err && err.message);
  }
  if (!user) return;
  const meta = user.public_metadata || {};
  writeSponsor({
    id,
    name: sponsorDisplayName(user),
    avatar: String(user.image_url || "").trim(),
    plus: metaHasActivePlus(meta),
    supporter: !!meta[META_SUPPORTER],
  });
}

function clerkUsersFromResponse(batch) {
  if (Array.isArray(batch)) return batch;
  if (batch && Array.isArray(batch.data)) return batch.data;
  return [];
}

async function refreshSponsorsFromClerk(force) {
  if (!force && Date.now() - sponsorsRefreshAt < SPONSORS_REFRESH_MS && fund.sponsors.length) {
    return;
  }
  const key = String(process.env.CLERK_SECRET_KEY || "").trim();
  if (!key) {
    sponsorsRefreshAt = Date.now();
    return;
  }
  const found = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    let batch;
    try {
      batch = await clerkApi("GET", `/users?limit=100&offset=${offset}&order_by=-updated_at`);
    } catch {
      try {
        batch = await clerkApi("GET", `/users?limit=100&offset=${offset}`);
      } catch (err) {
        console.warn("sponsors clerk list", err && err.message);
        break;
      }
    }
    const list = clerkUsersFromResponse(batch);
    if (!list.length) break;
    for (const user of list) {
      if (!user || !user.id) continue;
      const meta = user.public_metadata || {};
      const plus = metaHasActivePlus(meta);
      const supporter = !!meta[META_SUPPORTER];
      if (!plus && !supporter) continue;
      // One-time backfill: lifetime tippers without an expiry get 30 days of Plus from now.
      if (supporter && !meta[META_PLUS] && !plusUntilMs(meta)) {
        try {
          await patchPlusMetadata(user.id, { plusUntil: Date.now() + DONATE_PLUS_MS });
        } catch (err) {
          console.warn("sponsor tip-plus backfill", err && err.message);
        }
      }
      found.push(
        normalizeSponsor({
          id: user.id,
          name: sponsorDisplayName(user),
          avatar: String(user.image_url || "").trim(),
          plus: metaHasActivePlus(meta) || (supporter && !plusUntilMs(meta)),
          supporter,
          at: Number(user.updated_at) || Date.now(),
        })
      );
    }
    offset += list.length;
    if (list.length < 100) break;
  }
  // Keep newer local timestamps when present
  const byId = new Map();
  for (const s of fund.sponsors) byId.set(s.id, s);
  for (const s of found) {
    if (!s) continue;
    const prev = byId.get(s.id);
    byId.set(s.id, prev ? { ...s, at: Math.max(prev.at || 0, s.at || 0) } : s);
  }
  fund.sponsors = [...byId.values()]
    .filter((s) => s && (s.plus || s.supporter))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, SPONSORS_MAX);
  fund.updatedAt = Date.now();
  sponsorsRefreshAt = Date.now();
  saveFund();
}

async function sponsorsPublic() {
  try {
    await refreshSponsorsFromClerk(false);
  } catch (err) {
    console.warn("sponsors refresh", err && err.message);
  }
  return {
    sponsors: fund.sponsors.map((s) => ({
      id: s.id,
      name: s.name,
      avatar: s.avatar,
      plus: !!s.plus,
      supporter: !!s.supporter,
    })),
  };
}

function creditRaised(sessionId, amountCents) {
  const id = String(sessionId || "").trim();
  const amount = Math.floor(Number(amountCents) || 0);
  if (!id || amount <= 0) return false;
  if (fund.processed.includes(id)) return false;
  fund.processed.push(id);
  if (fund.processed.length > PROCESSED_MAX) {
    fund.processed = fund.processed.slice(-PROCESSED_MAX);
  }
  fund.raisedCents += amount;
  fund.updatedAt = Date.now();
  saveFund();
  return true;
}

async function clerkApi(method, urlPath, body) {
  const key = String(process.env.CLERK_SECRET_KEY || "").trim();
  if (!key) return null;
  const res = await fetch(`https://api.clerk.com/v1${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`clerk ${method} ${urlPath} ${res.status} ${text.slice(0, 180)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function primaryEmail(user) {
  if (!user || typeof user !== "object") return "";
  const primaryId = user.primary_email_address_id;
  const list = Array.isArray(user.email_addresses) ? user.email_addresses : [];
  const hit = list.find((e) => e && e.id === primaryId) || list[0];
  return String((hit && hit.email_address) || "").trim();
}

async function loadClerkUser(userId) {
  return clerkApi("GET", `/users/${encodeURIComponent(userId)}`);
}

async function patchPlusMetadata(userId, patch) {
  const id = String(userId || "").trim();
  if (!id) return;
  const public_metadata = {};
  if (Object.prototype.hasOwnProperty.call(patch, "plus")) {
    public_metadata[META_PLUS] = !!patch.plus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "supporter")) {
    public_metadata[META_SUPPORTER] = !!patch.supporter;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "plusUntil")) {
    const until = Math.floor(Number(patch.plusUntil) || 0);
    public_metadata[META_PLUS_UNTIL] = until > 0 ? until : 0;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "customerId") && patch.customerId) {
    public_metadata[META_CUSTOMER] = String(patch.customerId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "subscriptionId") && patch.subscriptionId) {
    public_metadata[META_SUB] = String(patch.subscriptionId);
  }
  if (Object.keys(public_metadata).length === 0) return;
  await clerkApi("PATCH", `/users/${encodeURIComponent(id)}/metadata`, { public_metadata });
  if (Object.prototype.hasOwnProperty.call(patch, "plus") || Object.prototype.hasOwnProperty.call(patch, "plusUntil")) {
    try {
      const user = await loadClerkUser(id);
      clerk.setPlusCache(id, metaHasActivePlus((user && user.public_metadata) || {}));
    } catch {
      if (Object.prototype.hasOwnProperty.call(patch, "plus")) clerk.setPlusCache(id, !!patch.plus);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "supporter")) {
    clerk.setSupporterCache(id, !!patch.supporter);
  }
  try {
    await syncSponsor(id);
  } catch (err) {
    console.warn("sponsor sync after metadata", err && err.message);
  }
}

function subscriptionIsPlus(status) {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "trialing" || s === "past_due";
}

function resolveUrls(successUrl, cancelUrl, fallbackOk, fallbackCancel) {
  const ok = String(successUrl || "").trim() || fallbackOk;
  const cancel = String(cancelUrl || "").trim() || fallbackCancel;
  return { success_url: ok, cancel_url: cancel };
}

async function createCheckoutSession({ userId, successUrl, cancelUrl }) {
  const stripe = getStripe();
  const price = pricePlus();
  if (!stripe || !price) {
    const err = new Error("Billing is not configured");
    err.code = "stripe_off";
    throw err;
  }
  const id = String(userId || "").trim();
  if (!id) {
    const err = new Error("Sign in required");
    err.code = "auth";
    throw err;
  }
  const user = await loadClerkUser(id);
  const email = primaryEmail(user);
  const meta = (user && user.public_metadata) || {};
  const existingCustomer = String(meta[META_CUSTOMER] || "").trim();
  const urls = resolveUrls(
    successUrl,
    cancelUrl,
    `${APP_ORIGIN}/?plus=success`,
    `${APP_ORIGIN}/?plus=cancel`
  );

  const params = {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: urls.success_url,
    cancel_url: urls.cancel_url,
    client_reference_id: id,
    metadata: { clerkUserId: id, kind: "plus" },
    subscription_data: {
      metadata: { clerkUserId: id, kind: "plus" },
    },
    allow_promotion_codes: false,
    billing_address_collection: "auto",
  };
  if (existingCustomer) {
    params.customer = existingCustomer;
  } else if (email) {
    params.customer_email = email;
  }

  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url, id: session.id };
}

async function createDonateSession({ amountCents, userId, successUrl, cancelUrl }) {
  const stripe = getStripe();
  if (!stripe || !stripeSecret()) {
    const err = new Error("Billing is not configured");
    err.code = "stripe_off";
    throw err;
  }
  const amount = Math.floor(Number(amountCents) || 0);
  if (amount < DONATE_MIN_CENTS || amount > DONATE_MAX_CENTS) {
    const err = new Error(`Donate between €${(DONATE_MIN_CENTS / 100).toFixed(0)} and €${(DONATE_MAX_CENTS / 100).toFixed(0)}`);
    err.code = "bad_amount";
    throw err;
  }
  const id = String(userId || "").trim();
  const urls = resolveUrls(
    successUrl,
    cancelUrl,
    `${APP_ORIGIN}/?donate=success`,
    `${APP_ORIGIN}/?donate=cancel`
  );

  const params = {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: amount,
          product_data: {
            name: "Citrons tip",
            description: "One-time support for Citrons",
          },
        },
      },
    ],
    success_url: urls.success_url,
    cancel_url: urls.cancel_url,
    metadata: { kind: "donate", clerkUserId: id || "" },
    submit_type: "donate",
    allow_promotion_codes: false,
    billing_address_collection: "auto",
  };
  if (id) {
    params.client_reference_id = id;
    const user = await loadClerkUser(id);
    const email = primaryEmail(user);
    const meta = (user && user.public_metadata) || {};
    const existingCustomer = String(meta[META_CUSTOMER] || "").trim();
    if (existingCustomer) params.customer = existingCustomer;
    else if (email) params.customer_email = email;
  }

  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url, id: session.id };
}

async function createPortalSession({ userId, returnUrl }) {
  const stripe = getStripe();
  if (!stripe) {
    const err = new Error("Billing is not configured");
    err.code = "stripe_off";
    throw err;
  }
  const id = String(userId || "").trim();
  if (!id) {
    const err = new Error("Sign in required");
    err.code = "auth";
    throw err;
  }
  const user = await loadClerkUser(id);
  const meta = (user && user.public_metadata) || {};
  const customerId = String(meta[META_CUSTOMER] || "").trim();
  if (!customerId) {
    const err = new Error("No Stripe customer yet — subscribe first");
    err.code = "no_customer";
    throw err;
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: String(returnUrl || "").trim() || `${APP_ORIGIN}/`,
  });
  return { url: session.url };
}

async function statusForUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return { plus: false };
  const cached = clerk.peekPlusCache(id);
  if (cached) return { plus: cached.plus };
  const user = await loadClerkUser(id);
  const meta = (user && user.public_metadata) || {};
  const plus = metaHasActivePlus(meta);
  clerk.setPlusCache(id, plus);
  return {
    plus,
    plusUntil: plusUntilMs(meta) || null,
    customerId: meta[META_CUSTOMER] || null,
    subscriptionId: meta[META_SUB] || null,
  };
}

async function applySubscription(clerkUserId, subscription) {
  const id = String(clerkUserId || "").trim();
  if (!id || !subscription) return;
  const plus = subscriptionIsPlus(subscription.status);
  await patchPlusMetadata(id, {
    plus,
    customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    subscriptionId: subscription.id,
  });
}

async function handleCheckoutCompleted(session) {
  const kind = String((session && session.metadata && session.metadata.kind) || "").toLowerCase();
  const mode = String((session && session.mode) || "").toLowerCase();
  const amount = Math.floor(Number(session.amount_total) || 0);
  const currency = String(session.currency || "").toLowerCase();
  if (session.payment_status === "paid" && amount > 0 && currency === "eur") {
    creditRaised(session.id, amount);
  }

  if (kind === "donate" || mode === "payment") {
    const clerkUserId = String(
      (session && session.metadata && session.metadata.clerkUserId) || session.client_reference_id || ""
    ).trim();
    if (clerkUserId && session.payment_status === "paid") {
      try {
        const user = await loadClerkUser(clerkUserId);
        const meta = (user && user.public_metadata) || {};
        await patchPlusMetadata(clerkUserId, {
          supporter: true,
          plusUntil: nextDonatePlusUntil(meta),
        });
      } catch (err) {
        console.warn("donate supporter/plus grant", err && err.message);
      }
    }
    return;
  }

  const clerkUserId =
    String((session && session.metadata && session.metadata.clerkUserId) || session.client_reference_id || "").trim();
  if (!clerkUserId) return;
  const customerId = typeof session.customer === "string" ? session.customer : "";
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  const stripe = getStripe();
  if (subscriptionId && stripe) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    await applySubscription(clerkUserId, sub);
    return;
  }
  if (mode === "subscription" || kind === "plus") {
    await patchPlusMetadata(clerkUserId, {
      plus: true,
      customerId: customerId || undefined,
      subscriptionId: subscriptionId || undefined,
    });
  }
}

async function handleSubscriptionEvent(subscription) {
  const clerkUserId = String((subscription.metadata && subscription.metadata.clerkUserId) || "").trim();
  if (!clerkUserId) {
    console.warn("stripe subscription event missing clerkUserId", subscription.id);
    return;
  }
  await applySubscription(clerkUserId, subscription);
}

async function handleInvoiceEvent(invoice) {
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription && invoice.subscription.id
        ? invoice.subscription.id
        : "";
  if (!subscriptionId) return;
  const stripe = getStripe();
  if (!stripe) return;
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const clerkUserId = String((sub.metadata && sub.metadata.clerkUserId) || "").trim();
  if (!clerkUserId) {
    console.warn("stripe invoice without clerkUserId on subscription", subscriptionId);
    return;
  }
  await applySubscription(clerkUserId, sub);
  const amount = Math.floor(Number(invoice.amount_paid) || 0);
  const currency = String(invoice.currency || "").toLowerCase();
  const invId = String(invoice.id || "").trim();
  if (amount > 0 && currency === "eur" && invId) {
    creditRaised(`inv_${invId}`, amount);
  }
}

async function handleWebhook(rawBody, signatureHeader) {
  const stripe = getStripe();
  const secret = webhookSecret();
  if (!stripe || !secret) {
    const err = new Error("Webhook not configured");
    err.code = "stripe_off";
    throw err;
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
  } catch (err) {
    const e = new Error(err && err.message ? err.message : "invalid signature");
    e.code = "bad_sig";
    throw e;
  }

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object);
      break;
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionEvent(event.data.object);
      break;
    case "invoice.paid":
      await handleInvoiceEvent(event.data.object);
      break;
    case "invoice.payment_failed":
      await handleInvoiceEvent(event.data.object);
      break;
    default:
      break;
  }
  return { received: true, type: event.type };
}

module.exports = {
  info,
  stripeConfigured,
  createCheckoutSession,
  createDonateSession,
  createPortalSession,
  statusForUser,
  handleWebhook,
  raisedPublic,
  sponsorsPublic,
  GOAL_CENTS,
  DONATE_MIN_CENTS,
  DONATE_MAX_CENTS,
  META_PLUS,
  META_SUPPORTER,
  META_PLUS_UNTIL,
};
