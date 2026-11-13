# Citrons — handoff for Claude Code

Online multiplayer card game (Citron / “lemons”), plus a two-player **Secret code** mini-game. Live site: **https://citrons.lat**  
Repo: `identity1211/Citrons` · Branch: `main` · public

Owner prefers Russian for chat; code/commits in English. After any gameplay/UI change, do a bug pass (seats, reconnect, spectators, scoring) before stopping.

---

## Architecture (split hosting)

| Layer | Where | Notes |
|--------|--------|--------|
| **Frontend** | GitHub Pages (`docs/`) | Custom domain `citrons.lat` → `identity1211.github.io` |
| **DNS** | Cloudflare | Nameservers `donald.ns.cloudflare.com`, `sarah.ns.cloudflare.com` |
| **Backend** | Railway | `node server/index.js` · WS default `wss://web-production-b9cc89.up.railway.app` |
| **Android** | Sideload WebView APK | Loads `https://citrons.lat` · package `lat.citrons.app.debug` (debug builds) · current **1.0.6** |

Client does **not** talk to GitHub for gameplay — only static assets. Multiplayer is Railway WebSocket + REST.

Carrier “unsafe site” warnings when opening the site are suspected **GitHub Pages IP/hosting**, not the APK. Planned fix: serve `docs/` from Railway and point DNS `citrons.lat` at Railway (plan discussed; **not implemented**).

Railway project: `easygoing-blessing`, environment `production`, service `Citrons`. Volume `web-volume`, mount `RAILWAY_VOLUME_MOUNT_PATH=/data`. Health check: `GET /health`. Config: `railway.toml` (`startCommand = node server/index.js`). CLI config-as-code migration was warned and must not be done unless asked.

---

## Services

Values live in the Railway dashboard or in Cloudflare. Do not commit them, and do not paste keys into chat. The gift PDF and the one-shot sent flag stay on the volume (`server/private/` is gitignored).

| Service | Role | Where | Config (names only) |
|--------|------|--------|---------------------|
| **GitHub** | Source and GitHub Pages | `identity1211/Citrons`, branch `main` | Pages serves `docs/`. `docs/CNAME` is `citrons.lat` |
| **Cloudflare** | DNS for `citrons.lat` | Dashboard for that zone | Site still points at GitHub Pages. Resend records below stay **DNS only** (grey cloud) |
| **Railway** | Game server: rooms, rules, billing webhooks, voice tokens, push, prize mail | `https://web-production-b9cc89.up.railway.app` | `PORT` (provided), `RAILWAY_VOLUME_MOUNT_PATH`. Optional file overrides: `LEADERBOARD_FILE`, `PUSH_FILE`, `VAPID_FILE`, `DONATIONS_FILE`, `PRIZE_FILE` |
| **Clerk** | Google sign-in, user id, Plus / supporter metadata, primary email for the prize | Frontend API `https://clerk.citrons.lat`. Client loads `@clerk/clerk-js@6` from jsDelivr | `CLERK_SECRET_KEY`. Optional: `CLERK_PUBLISHABLE_KEY`, `CLERK_ISSUER`. Publishable key is also embedded in the client |
| **Stripe** | Citrons Plus checkout, billing portal, donations | `api.stripe.com` via the `stripe` npm package. Routes: `POST /billing/checkout`, `POST /billing/webhook`, `POST /billing/donate`, `GET /billing/raised`, `GET /billing/sponsors`, `POST /billing/portal`, `GET /billing/status` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PLUS` |
| **Daily** | In-room voice | `https://api.daily.co/v1`. Client loads `@daily-co/daily-js@0.80.0` from jsDelivr | `DAILY_API_KEY`, `DAILY_DOMAIN` (host or subdomain; `.daily.co` is appended if there is no dot) |
| **Web Push** | Browser invites | `web-push` npm package. `GET /push/vapid` returns the public key | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (defaults to `https://citrons.lat`). If unset, keys are generated and stored on the volume |
| **Resend** | One prize email with `present.pdf`, only after the configured Clerk account wins a Secret code tournament | `POST https://api.resend.com/emails`. Sending domain `citrons.lat`. `present@citrons.lat` is a From header only; there is no mailbox | `RESEND_API_KEY`, `PRIZE_FROM`, `PRIZE_EMAIL`. Optional `PRIZE_FILE`. Sent-flag: `prize-sent.json` on the volume |
| **jsDelivr** | Browser CDN | React 18.3.1, ReactDOM, `@babel/standalone` 7.26.10, Clerk JS, Daily JS | No keys. The page does not boot if the CDN is blocked |
| **Google** | Sign-in provider | Through Clerk, not a separate Google API client in this repo | On Android, Google may open Chrome Custom Tabs if it blocks the WebView |
| **Android sideload** | WebView shell, not Play Store | APKs under `docs/app/` | Profile → **Refresh game** reloads the site. **Update app** downloads a new APK |

Resend DNS on Cloudflare (names only, already public):

- TXT `resend._domainkey` — DKIM
- CNAME `rsend` → `rsend-euw1.forge.rmta.net`
- CNAME `send` → `send.forge.rmta.net`
- TXT `_dmarc`

Volume files (do not wipe the volume): leaderboard JSON, push subscriptions, VAPID key file, donations JSON, `present.pdf`, `prize-sent.json`.

---

## Source of truth / build pipeline

1. Edit game UI in **`canvases/card-game.canvas.tsx`** (single React file).
2. Rebuild static site:  
   `perl scripts/build-site.pl`  
   → writes **`docs/index.html`** (Babel-in-browser + React CDN, strips TS imports, injects shims).
3. Commit **both** `canvases/card-game.canvas.tsx` and `docs/index.html` (and assets under `docs/` if changed).
4. Push `main` → GitHub Pages updates `citrons.lat` (cache ~minutes).
5. Railway redeploys on push for **server/** only (unless you add static serving).

**Never edit `docs/index.html` by hand** for game logic — it will be overwritten by `build-site.pl`.

Android-only UI: gate with `isCitronsAndroidApp()` (`User-Agent` contains `CitronsAndroid`). Browser must stay unchanged when user asks not to touch web.

---

## Key paths

```
canvases/card-game.canvas.tsx   # ALL client game + lobby + profile + chat + voice + Secret code UI
scripts/build-site.pl           # canvas → docs/index.html
docs/                           # GitHub Pages root (CNAME: citrons.lat)
docs/app/*.apk                  # published sideload APKs (versioned + citrons-android.apk)
docs/fonts/                     # IBM Plex Mono (OFL) for Secret code, self-hosted so it needs no CDN
server/index.js                 # HTTP + WebSocket rooms
server/engine.js                # card game rules
server/elimination.js           # elimination mode
server/codegame.js              # Secret code rooms, duel / tournament
server/prize.js                 # Resend prize letter
server/leaderboard.js           # stats, achievements, volume JSON
server/clerk.js                 # Clerk token verify + primary email
server/stripe-billing.js        # Citrons Plus + donations
server/daily.js                 # Daily.co voice
server/push.js                  # web-push
android/                        # WebView shell (Kotlin)
railway.toml                    # start: node server/index.js, /health
```

Client WS: `DEFAULT_WS` in the canvas.  
Clerk publishable key is embedded in the canvas and the `docs` build. Secrets stay on Railway.

---

## Railway env (server)

Set in the Railway dashboard, not in git:

- `PORT` (provided)
- `RAILWAY_VOLUME_MOUNT_PATH` (`/data`)
- `CLERK_SECRET_KEY` (optional `CLERK_PUBLISHABLE_KEY`, `CLERK_ISSUER`)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PLUS`
- `DAILY_API_KEY`, `DAILY_DOMAIN`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (or let the server generate them onto the volume)
- `RESEND_API_KEY`, `PRIZE_FROM`, `PRIZE_EMAIL` (optional `PRIZE_FILE`)
- Optional path overrides: `LEADERBOARD_FILE`, `PUSH_FILE`, `VAPID_FILE`, `DONATIONS_FILE`

---

## Android shell

- Build: JDK **21** (not 25). Example:  
  `JAVA_HOME=$HOME/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home`  
  `cd android && ./gradlew assembleDebug --no-daemon`
- Output → copy to `docs/app/citrons-android.apk` and `docs/app/citrons-android-VERSION.apk`
- UA: `CitronsAndroid/1.0` · JS bridge `window.CitronsAndroid.refreshGame()` / `openApkUpdate(url)`
- Immersive fullscreen; IME: pad root for keyboard insets; softInput `adjustResize`
- Profile in app: **Refresh game** = reload website only; **Update app** = download new APK
- Toast on boot shows shell version (`boot_version` string)

`gh` may be at `~/.local/bin/gh` if not on PATH.

---

## Product features (high level)

- Lobby: solo / multiplayer / leaderboard, table skins, card backs
- Online rooms: seats, spectators, queue, kick votes, chat, Daily voice
- Modes: standard + elimination
- Secret code: 4 digits, repeats allowed, no timer, Easy vs Hard. One look, the dossier (the classic felt look was removed). Start screen: **Create a room** for online play, plus two solo modes that need no sign-in. Duel (one round) or Tournament (first to 3) and the difficulty are chosen in the room while the host is alone. One Clerk account cannot sit in a card room and a code room at once
- Secret code invite link: `https://citrons.lat/?room=CODE` opens Secret code and joins that room after sign-in. `?room=daily` opens the daily code. The code is kept in `sessionStorage` (`citrons-code-join`) so it survives the Google redirect, and the parameter is stripped from the address
- Secret code solo modes run in the browser only, with a copy of the server's `feedback()` rules (`codeFeedback` in the canvas; keep the two in step). **Vs computer** (Agent Zero) is deliberately imperfect: about 7 guesses on Easy and 11 on Hard. **Daily code** is one code per UTC day derived from the date (`codeDailySecret`), Easy rules, progress and streak in `localStorage` (`citrons-code-daily`, `citrons-code-daily-stats`). Neither mode can win the tournament prize
- Secret code feedback: tiles flip on a new guess, sounds are synthesized soft sine tones and bells, by the owner's choice over 8-bit beeps and typewriter clicks (toggle stored in `citrons-code-sound`), the keypad dims digits that Easy feedback has ruled out, tapping a digit in the live row locks it, a result card closes each round with rematch and share. First visit shows a how-to card (`citrons-code-howto-seen`)
- Tournament prize: server emails `present.pdf` once, and only when the winner’s Clerk primary email matches `PRIZE_EMAIL`. Do not rehearse that win on the prize account
- Auth: Clerk (Google) via `clerk.citrons.lat`
- Plus billing: Stripe checkout + webhook
- Achievements incl. Toxic Lemon (career 🖕 / `fuckReacts` — local on server, not public Clerk wipe)
- Burn pile uses host card back; messy stack layout
- PWA / iOS home icon lemon emblem

---

## Open / next work

1. **Move frontend off GitHub Pages → Railway** (carrier security warnings on site visit)  
   - Serve `docs/` from `server/index.js`  
   - Custom domain `citrons.lat` on Railway  
   - DNS away from `identity1211.github.io`  
   - Optionally `DEFAULT_WS` → `wss://citrons.lat`  
   - Full plan was written in chat (Oct 2026); code not started
2. **Secret code rework (13 Nov 2026, commits `117683c` and `fdf0076`) is live but not checked on real devices.** Still to verify by hand:
   - Google sign-in, then two real players in one room joined by a `?room=CODE` link, including rematch
   - Safari on iPhone and the Android WebView app (Profile → **Refresh game** first)
   - The system share sheet, and how loud the sounds are
   - It was tested only in headless Chrome against a local copy of `server/codegame.js` with a fake sign-in. That test rig was not saved in the repo
   - Decisions already made by the owner, do not undo: soft sine tones and bells for sound (no clicks, no 8-bit beeps); the Classic look stays removed; the server was not changed for this work
3. Android UX polish as needed (lobby spacing / keyboard mostly fixed in 1.0.5–1.0.6)
4. Do not commit: `.cursor/`, `previews/`, `android/.kotlin/`, canvas status/tsconfig, `server/private/` unless asked

---

## Commands cheat sheet

```bash
# Rebuild website from canvas
perl scripts/build-site.pl

# Server locally
npm start   # or node server/index.js

# Tests
npm test    # elimination.test.js and codegame.test.js

# Android debug APK (JDK 21)
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home"
cd android && ./gradlew assembleDebug --no-daemon
cp app/build/outputs/apk/debug/app-debug.apk ../docs/app/citrons-android.apk
```

After website-only fixes: user in APK does Profile → **Refresh game**.  
After native shell fixes: reinstall APK (Profile → **Update app** or versioned URL under `/app/`).

---

## Commit / push norms

- Commit only when user asks
- Don’t commit secrets (`.env*`, `server/private/`)
- Prefer small commits; message focuses on why
- Bug pass after gameplay changes (see `.cursor/rules/review-after-changes.mdc`)

---

## Quick mental model for edits

| Change | Touch |
|--------|--------|
| Lobby/table/cards/chat/Secret code UI | `canvases/card-game.canvas.tsx` → `build-site.pl` → commit `docs/index.html` |
| Card rules / rooms / scoring | `server/engine.js`, `server/index.js`, maybe `elimination.js` |
| Secret code rules / tournament | `server/codegame.js`, `server/index.js` |
| Prize email | `server/prize.js` (letter only; PDF stays on the volume) |
| Stats / achievements | `server/leaderboard.js` + canvas meta |
| Plus / donations | `server/stripe-billing.js` + canvas Plus UI |
| Voice | `server/daily.js` + canvas mic UI |
| APK chrome / fullscreen / IME | `android/.../MainActivity.kt` (+ rebuild APK into `docs/app/`) |
| App-only hide Fullscreen btn | already: `WindowButton` returns null if `isCitronsAndroidApp()` |
