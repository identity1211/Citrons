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
  return { raisedCents: 0, processed: [], sponsors: [], sponsorsPaidBackfill: false, updatedAt: 0 };
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
  const amountCents = Math.max(0, Math.floor(Number((raw && raw.amountCents) || 0)));
  return {
    id,
    name,
    avatar: String((raw && raw.avatar) || "").trim().slice(0, 500),
    plus: !!(raw && raw.plus),
    supporter: !!(raw && raw.supporter),
    amountCents,
    at: Number((raw && raw.at) || 0) || Date.now(),
  };
}

function sortSponsorsInPlace() {
  fund.sponsors = (fund.sponsors || [])
    .filter((s) => s && s.id && (s.amountCents || 0) > 0)
    .sort((a, b) => {
      const byAmount = (b.amountCents || 0) - (a.amountCents || 0);
      if (byAmount) return byAmount;
      return (b.at || 0) - (a.at || 0);
    })
    .slice(0, SPONSORS_MAX);
}

function loadFund() {
  try {
    const raw = fs.readFileSync(fundPath(), "utf8");
    const parsed = JSON.parse(raw);
    const sponsors = Array.isArray(parsed.sponsors)
      ? parsed.sponsors
          .map(normalizeSponsor)
          .filter((s) => s && s.amountCents > 0)
      : [];
    fund = {
      raisedCents: Math.max(0, Math.floor(Number(parsed.raisedCents) || 0)),
      processed: Array.isArray(parsed.processed) ? parsed.processed.map(String).slice(-PROCESSED_MAX) : [],
      sponsors,
      sponsorsPaidBackfill: !!parsed.sponsorsPaidBackfill,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
    sortSponsorsInPlace();
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
  if (!next || next.amountCents <= 0) {
    if (next && next.id) {
      fund.sponsors = fund.sponsors.filter((s) => s.id !== next.id);
      fund.updatedAt = Date.now();
      saveFund();
    }
    return;
  }
  const i = fund.sponsors.findIndex((s) => s.id === next.id);
  if (i >= 0) {
    const prev = fund.sponsors[i];
    fund.sponsors[i] = {
      ...prev,
      ...next,
      amountCents: Math.max(prev.amountCents || 0, next.amountCents || 0),
      at: Date.now(),
    };
  } else {
    fund.sponsors.push({ ...next, at: Date.now() });
  }
  sortSponsorsInPlace();
  fund.updatedAt = Date.now();
  saveFund();
}

/** Add paid euros to a signed-in payer. Never invents sponsors from unpaid metadata. */
function bumpSponsorAmount(userId, amountCents) {
  const id = String(userId || "").trim();
  const amount = Math.floor(Number(amountCents) || 0);
  if (!id || amount <= 0) return;
  const i = fund.sponsors.findIndex((s) => s.id === id);
  if (i >= 0) {
    fund.sponsors[i].amountCents = (fund.sponsors[i].amountCents || 0) + amount;
    fund.sponsors[i].at = Date.now();
  } else {
    fund.sponsors.push({
      id,
      name: "Player",
      avatar: "",
      plus: false,
      supporter: false,
      amountCents: amount,
      at: Date.now(),
    });
  }
  sortSponsorsInPlace();
}

/** Refresh name/avatar/flags for an existing paying sponsor only. */
async function syncSponsor(userId) {
  const id = String(userId || "").trim();
  if (!id) return;
  const i = fund.sponsors.findIndex((s) => s.id === id);
  if (i < 0) return;
  if ((fund.sponsors[i].amountCents || 0) <= 0) {
    fund.sponsors.splice(i, 1);
    sortSponsorsInPlace();
    fund.updatedAt = Date.now();
    saveFund();
    return;
  }
  let user = null;
  try {
    user = await loadClerkUser(id);
  } catch (err) {
    console.warn("sponsor sync load", err && err.message);
  }
  if (!user) return;
  const meta = user.public_metadata || {};
  fund.sponsors[i] = {
    ...fund.sponsors[i],
    name: sponsorDisplayName(user),
    avatar: String(user.image_url || "").trim(),
    plus: metaHasActivePlus(meta),
    supporter: !!meta[META_SUPPORTER],
  };
  sortSponsorsInPlace();
  fund.updatedAt = Date.now();
  saveFund();
}

/** Only refresh profiles for people who already paid. */
async function refreshSponsorsFromClerk(force) {
  if (!force && Date.now() - sponsorsRefreshAt < SPONSORS_REFRESH_MS) return;
  const key = String(process.env.CLERK_SECRET_KEY || "").trim();
  if (!key) {
    sponsorsRefreshAt = Date.now();
    return;
  }
  const paid = fund.sponsors.filter((s) => s && (s.amountCents || 0) > 0);
  for (const row of paid) {
    try {
      await syncSponsor(row.id);
    } catch (err) {
      console.warn("sponsor profile refresh", err && err.message);
    }
  }
  sortSponsorsInPlace();
  sponsorsRefreshAt = Date.now();
  saveFund();
}

async function sponsorsPublic() {
  try {
    const hasPaid = fund.sponsors.some((s) => s && (s.amountCents || 0) > 0);
    if (!fund.sponsorsPaidBackfill || !hasPaid) {
      await rebuildSponsorsFromStripe();
    }
  } catch (err) {
    console.warn("sponsors stripe backfill", err && err.message);
  }
  try {
    await refreshSponsorsFromClerk(false);
  } catch (err) {
    console.warn("sponsors refresh", err && err.message);
  }
  sortSponsorsInPlace();
  return {
    sponsors: fund.sponsors
      .filter((s) => s && (s.amountCents || 0) > 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        avatar: s.avatar,
        plus: !!s.plus,
        supporter: !!s.supporter,
        amountCents: Math.max(0, Math.floor(Number(s.amountCents) || 0)),
      })),
  };
}

/**
 * Rebuild per-user paid totals from Stripe history.
 * Tips = paid checkout sessions (mode=payment); Plus = paid invoices.
 * Does not change raisedCents / processed — only sponsors[].amountCents.
 */
async function rebuildSponsorsFromStripe() {
  const stripe = getStripe();
  if (!stripe) {
    fund.sponsorsPaidBackfill = true;
    saveFund();
    return;
  }

  const totals = new Map(); // userId -> { amountCents, at }
  const add = (userId, amountCents, at) => {
    const id = String(userId || "").trim();
    const amount = Math.floor(Number(amountCents) || 0);
    if (!id || amount <= 0) return;
    const prev = totals.get(id) || { amountCents: 0, at: 0 };
    totals.set(id, {
      amountCents: prev.amountCents + amount,
      at: Math.max(prev.at || 0, Number(at) || 0),
    });
  };

  // One-time tips / donate checkouts
  let startingAfter;
  for (let page = 0; page < 30; page++) {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const list = await stripe.checkout.sessions.list(params);
    for (const session of list.data || []) {
      if (String(session.payment_status || "") !== "paid") continue;
      if (String(session.currency || "").toLowerCase() !== "eur") continue;
      const mode = String(session.mode || "").toLowerCase();
      // Subscription money is counted via invoices to avoid double-counting.
      if (mode === "subscription") continue;
      const amount = Math.floor(Number(session.amount_total) || 0);
      if (amount <= 0) continue;
      const uid = String(
        (session.metadata && session.metadata.clerkUserId) || session.client_reference_id || ""
      ).trim();
      if (!uid) continue;
      add(uid, amount, (session.created || 0) * 1000);
    }
    if (!list.has_more || !(list.data && list.data.length)) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  // Subscription invoices
  startingAfter = undefined;
  const subClerkCache = new Map();
  for (let page = 0; page < 30; page++) {
    const params = { limit: 100, status: "paid" };
    if (startingAfter) params.starting_after = startingAfter;
    const list = await stripe.invoices.list(params);
    for (const invoice of list.data || []) {
      if (String(invoice.currency || "").toLowerCase() !== "eur") continue;
      const amount = Math.floor(Number(invoice.amount_paid) || 0);
      if (amount <= 0) continue;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription && invoice.subscription.id
            ? invoice.subscription.id
            : "";
      let uid = String(
        (invoice.subscription_details &&
          invoice.subscription_details.metadata &&
          invoice.subscription_details.metadata.clerkUserId) ||
          (invoice.metadata && invoice.metadata.clerkUserId) ||
          ""
      ).trim();
      if (!uid && subscriptionId) {
        if (subClerkCache.has(subscriptionId)) {
          uid = subClerkCache.get(subscriptionId);
        } else {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            uid = String((sub.metadata && sub.metadata.clerkUserId) || "").trim();
          } catch (err) {
            console.warn("sponsors backfill sub", err && err.message);
            uid = "";
          }
          subClerkCache.set(subscriptionId, uid);
        }
      }
      if (!uid) continue;
      add(uid, amount, (invoice.created || 0) * 1000);
    }
    if (!list.has_more || !(list.data && list.data.length)) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  const prevById = new Map();
  for (const s of fund.sponsors || []) {
    if (s && s.id) prevById.set(s.id, s);
  }

  const next = [];
  for (const [id, row] of totals.entries()) {
    const prev = prevById.get(id);
    let name = (prev && prev.name) || "Player";
    let avatar = (prev && prev.avatar) || "";
    let plus = !!(prev && prev.plus);
    let supporter = !!(prev && prev.supporter);
    try {
      const user = await loadClerkUser(id);
      if (user) {
        const meta = user.public_metadata || {};
        name = sponsorDisplayName(user);
        avatar = String(user.image_url || "").trim();
        plus = metaHasActivePlus(meta);
        supporter = !!meta[META_SUPPORTER];
      }
    } catch {
      /* keep previous */
    }
    next.push(
      normalizeSponsor({
        id,
        name,
        avatar,
        plus,
        supporter,
        amountCents: row.amountCents,
        at: row.at || Date.now(),
      })
    );
  }

  fund.sponsors = next.filter(Boolean);
  fund.sponsorsPaidBackfill = true;
  fund.updatedAt = Date.now();
  sortSponsorsInPlace();
  saveFund();
  sponsorsRefreshAt = 0;
  console.log("sponsors stripe backfill", fund.sponsors.length, "payers");
}

function creditRaised(sessionId, amountCents, payerUserId) {
  const id = String(sessionId || "").trim();
  const amount = Math.floor(Number(amountCents) || 0);
  if (!id || amount <= 0) return false;
  if (fund.processed.includes(id)) return false;
  fund.processed.push(id);
  if (fund.processed.length > PROCESSED_MAX) {
    fund.processed = fund.processed.slice(-PROCESSED_MAX);
  }
  fund.raisedCents += amount;
  const uid = String(payerUserId || "").trim();
  if (uid) bumpSponsorAmount(uid, amount);
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
  const clerkUserId = String(
    (session && session.metadata && session.metadata.clerkUserId) || session.client_reference_id || ""
  ).trim();

  if (kind === "donate" || mode === "payment") {
    const paid = session.payment_status === "paid" && amount > 0 && currency === "eur";
    if (paid) {
      creditRaised(session.id, amount, clerkUserId || undefined);
    }
    if (clerkUserId && paid) {
      try {
        const user = await loadClerkUser(clerkUserId);
        const meta = (user && user.public_metadata) || {};
        await patchPlusMetadata(clerkUserId, {
          supporter: true,
          plusUntil: nextDonatePlusUntil(meta),
        });
        await syncSponsor(clerkUserId);
      } catch (err) {
        console.warn("donate supporter/plus grant", err && err.message);
      }
    }
    return;
  }

  // Subscription checkout: attribute money on invoice.paid (avoids double-count with session total).
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
    if (creditRaised(`inv_${invId}`, amount, clerkUserId)) {
      try {
        await syncSponsor(clerkUserId);
      } catch (err) {
        console.warn("sponsor sync after invoice", err && err.message);
      }
    }
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
