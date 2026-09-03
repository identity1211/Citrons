/* Citrons web push — keep this file at the site root. */
self.addEventListener("push", (event) => {
  let data = {
    title: "Citrons",
    body: "You were invited to play",
    url: "/",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* ignore malformed payloads */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Citrons", {
      body: data.body || "You were invited to play",
      icon: data.icon || "/icon-192.png",
      badge: data.badge || data.icon || "/icon-192.png",
      data: { url: data.url || "/", code: joinCodeFromUrl(data.url) },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/";
  event.waitUntil(openInvite(url, data.code || joinCodeFromUrl(url)));
});

function joinCodeFromUrl(url) {
  try {
    return new URL(url, self.location.origin).searchParams.get("join") || "";
  } catch {
    return "";
  }
}

async function openInvite(url, code) {
  const target = new URL(url, self.location.origin);
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of all) {
    try {
      if (new URL(client.url).origin !== self.location.origin) continue;
    } catch {
      continue;
    }
    if (typeof client.focus === "function") await client.focus();
    client.postMessage({ type: "citrons-join", code: String(code || ""), url: target.href });
    return;
  }
  await self.clients.openWindow(target.href);
}
