"use strict";

const Stripe = require("stripe");
const clerk = require("./clerk");

const APP_ORIGIN = "https://citrons.lat";
const META_PLUS = "citrons_plus";
const META_CUSTOMER = "stripeCustomerId";
const META_SUB = "stripeSubscriptionId";

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

function info() {
  return {
    ready: stripeConfigured(),
    hasSecret: !!stripeSecret(),
    hasWebhookSecret: !!webhookSecret(),
    hasPrice: !!pricePlus(),
  };
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
  if (Object.prototype.hasOwnProperty.call(patch, "customerId") && patch.customerId) {
    public_metadata[META_CUSTOMER] = String(patch.customerId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "subscriptionId") && patch.subscriptionId) {
    public_metadata[META_SUB] = String(patch.subscriptionId);
  }
  if (Object.keys(public_metadata).length === 0) return;
  await clerkApi("PATCH", `/users/${encodeURIComponent(id)}/metadata`, { public_metadata });
  if (Object.prototype.hasOwnProperty.call(patch, "plus")) {
    clerk.setPlusCache(id, !!patch.plus);
  }
}

function subscriptionIsPlus(status) {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "trialing" || s === "past_due";
}

function resolveUrls(successUrl, cancelUrl) {
  const ok = String(successUrl || "").trim() || `${APP_ORIGIN}/?plus=success`;
  const cancel = String(cancelUrl || "").trim() || `${APP_ORIGIN}/?plus=cancel`;
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
  const urls = resolveUrls(successUrl, cancelUrl);

  const params = {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: urls.success_url,
    cancel_url: urls.cancel_url,
    client_reference_id: id,
    metadata: { clerkUserId: id },
    subscription_data: {
      metadata: { clerkUserId: id },
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
  let customerId = String(meta[META_CUSTOMER] || "").trim();
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
  const plus = !!meta[META_PLUS];
  clerk.setPlusCache(id, plus);
  return {
    plus,
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
  await patchPlusMetadata(clerkUserId, {
    plus: true,
    customerId: customerId || undefined,
    subscriptionId: subscriptionId || undefined,
  });
}

async function handleSubscriptionEvent(subscription) {
  const clerkUserId = String((subscription.metadata && subscription.metadata.clerkUserId) || "").trim();
  let userId = clerkUserId;
  if (!userId && subscription.customer) {
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    // Fallback: look up by scanning is expensive; store customer→user only via metadata.
    // If metadata missing, still try Clerk users with this stripeCustomerId is not feasible without search.
    userId = "";
    void customerId;
  }
  if (!userId) {
    console.warn("stripe subscription event missing clerkUserId", subscription.id);
    return;
  }
  await applySubscription(userId, subscription);
}

async function handleInvoiceEvent(invoice, paid) {
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
  if (paid) {
    await applySubscription(clerkUserId, sub);
  } else {
    // Keep access on past_due; only clear when subscription is canceled/unpaid via subscription events.
    await applySubscription(clerkUserId, sub);
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
      await handleInvoiceEvent(event.data.object, true);
      break;
    case "invoice.payment_failed":
      await handleInvoiceEvent(event.data.object, false);
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
  createPortalSession,
  statusForUser,
  handleWebhook,
  META_PLUS,
};
