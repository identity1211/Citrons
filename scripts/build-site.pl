#!/usr/bin/perl
use strict;
use warnings;
use utf8;
use Encode qw(decode encode);

my $src = "/Users/denis/Downloads/projects/c-Users-Deniss-Desktop-Citron/canvases/card-game.canvas.tsx";
open my $in, "<:raw", $src or die $!;
local $/;
my $game = decode("UTF-8", <$in>);
close $in;

$game =~ s/^import .*?;\r?\n//mg;
$game =~ s/export default function CardGame/function CardGame/;

my $shims = <<'SHIMS';
const { useState, useEffect, useLayoutEffect, useRef, useCallback, createContext, useContext } = React;
type CSSProperties = React.CSSProperties;
type ReactNode = React.ReactNode;

function useHostTheme() {
  return {
    bg: { editor: "#145230" },
    text: {
      primary: "#f5f0e6",
      secondary: "rgba(255,255,255,0.72)",
      tertiary: "rgba(255,255,255,0.5)",
    },
    stroke: {
      focused: "rgba(255,255,255,0.45)",
      secondary: "rgba(255,255,255,0.28)",
    },
    fill: {
      secondary: "rgba(255,255,255,0.16)",
      tertiary: "rgba(0,0,0,0.28)",
    },
    accent: {
      control: "#1e8449",
    },
  };
}

function Text({ style, children }: { style?: CSSProperties; children?: ReactNode }) {
  return <span style={style}>{children}</span>;
}

function Row({ gap, children }: { gap?: number; children?: ReactNode }) {
  return <div style={{ display: "flex", gap: gap ?? 8, alignItems: "center" }}>{children}</div>;
}

function Spacer() {
  return <div style={{ flex: 1 }} />;
}

SHIMS

my $react = "https://cdn.jsdelivr.net/npm/react\@18.3.1/umd/react.production.min.js";
my $reactdom = "https://cdn.jsdelivr.net/npm/react-dom\@18.3.1/umd/react-dom.production.min.js";
my $babel = "https://cdn.jsdelivr.net/npm/\@babel/standalone\@7.26.10/babel.min.js";

my $html = <<"HTML";
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-visual" />
  <meta name="theme-color" content="#145230" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Citrons" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="apple-touch-icon" href="apple-touch-icon.png" />
  <link rel="apple-touch-startup-image" href="splash/640x1136.png" media="(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/1136x640.png" media="(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/750x1334.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/1334x750.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/828x1792.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/1792x828.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2436x1125.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2532x1170.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1179x2556.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2556x1179.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1284x2778.png" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2778x1284.png" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1290x2796.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2796x1290.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1206x2622.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2622x1206.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <link rel="apple-touch-startup-image" href="splash/1320x2868.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
  <link rel="apple-touch-startup-image" href="splash/2868x1320.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
  <title>Citrons — TwoCircles Edition</title>
  <meta name="description" content="Citrons card game. Solo against bots." />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a6b3c'/><text x='16' y='22' text-anchor='middle' font-size='16' fill='%23f5f0e6'>C</text></svg>" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #145230 !important; overflow: hidden; }
    html { height: 100%; min-height: 100%; min-height: 100vh; min-height: 100dvh; min-height: -webkit-fill-available; }
    html:not(.standalone):not(.ios) { position: fixed; inset: 0; width: 100%; height: 100%; }
    html.standalone, html.ios, html:fullscreen, html:-webkit-full-screen, body:fullscreen, body:-webkit-full-screen {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      width: 100% !important;
      height: var(--app-h, 100%) !important;
      min-height: var(--app-h, 100vh) !important;
      max-width: none !important;
      max-height: none !important;
      background: #145230 !important;
    }
    html.standalone body, html.ios body, html.standalone #root, html.ios #root {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: var(--app-h, 100%) !important;
      min-height: var(--app-h, 100vh) !important;
      background: #145230 !important;
    }
    #root { position: absolute; inset: 0; overflow: hidden; width: 100%; height: 100%; min-height: 100%; background: #145230; }
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; -webkit-text-size-adjust: 100%; }
    button { font-family: inherit; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    \@media (max-width: 640px) {
      .lobby-fs-hint { display: none !important; }
    }
    \@media (orientation: landscape) and (max-height: 520px) {
      .lobby-title { font-size: 30px !important; }
      .lobby-fan-wrap { height: 52px !important; margin: 0 0 0 !important; transform: scale(0.68); transform-origin: top center; }
      .lobby-fan-wrap .lobby-fan-card { top: 0 !important; }
      .lobby-fs-hint { display: none !important; }
      .lobby-play-btn, .lobby-ghost-btn { height: 42px !important; }
    }
  </style>
  <script>
    (function () {
      var ua = navigator.userAgent || "";
      var ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      var standalone = false;
      try {
        standalone = !!(navigator.standalone || window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches);
      } catch (e) {}
      if (ios) document.documentElement.classList.add("ios");
      if (standalone || ios) document.documentElement.classList.add("standalone");
      function fit() {
        var vv = window.visualViewport;
        var w = Math.round((vv && vv.width) || window.innerWidth || screen.width || 0);
        var h = Math.round((vv && vv.height) || window.innerHeight || screen.height || 0);
        if (w < 40) w = screen.width || 390;
        if (h < 40) h = screen.height || 844;
        document.documentElement.style.setProperty("--app-w", w + "px");
        document.documentElement.style.setProperty("--app-h", h + "px");
        var root = document.getElementById("root");
        if (root) {
          root.style.width = w + "px";
          root.style.height = h + "px";
        }
      }
      fit();
      document.addEventListener("DOMContentLoaded", fit);
      window.addEventListener("load", fit);
      window.addEventListener("resize", fit);
      window.addEventListener("orientationchange", function () {
        window.setTimeout(fit, 50);
        window.setTimeout(fit, 300);
      });
      if (window.visualViewport) window.visualViewport.addEventListener("resize", fit);
      window.__citronsBootFail = function (msg) {
        var root = document.getElementById("root");
        if (root) {
          root.style.background = "#145230";
          root.innerHTML = '<p style="color:#f5f0e6;text-align:center;padding:48px 16px">' + msg + "</p>";
        }
      };
      var host = location.hostname;
      if (host === "identity1211.github.io") {
        location.replace("https://citrons.lat/" + location.search + location.hash);
        return;
      }
      if ((host === "citrons.lat" || host === "www.citrons.lat") && location.protocol === "http:") {
        location.replace("https://" + host + location.pathname + location.search + location.hash);
      }
    })();
  </script>
</head>
<body>
  <script>window.CITRONS_WS = window.CITRONS_WS || "wss://web-production-b9cc89.up.railway.app"; window.CLERK_PK = window.CLERK_PK || "pk_live_Y2xlcmsuY2l0cm9ucy5sYXQk";</script>
  <div id="root"><p style="color:#f5f0e6;text-align:center;padding:48px 16px;letter-spacing:0.04em;background:#145230">Loading Citrons…</p></div>
  <script src="$react" crossorigin onerror="window.__citronsBootFail && window.__citronsBootFail('Could not load React')"></script>
  <script src="$reactdom" crossorigin onerror="window.__citronsBootFail && window.__citronsBootFail('Could not load ReactDOM')"></script>
  <script src="$babel" onerror="window.__citronsBootFail && window.__citronsBootFail('Could not load the game compiler')"></script>
  <script type="text/plain" id="citrons-src">
$shims$game

const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(<CardGame />);
}
  </script>
  <script>
    (function () {
      var root = document.getElementById("root");
      try {
        if (!window.Babel) throw new Error("Could not load the game compiler");
        var src = document.getElementById("citrons-src").textContent;
        var result = Babel.transform(src, {
          presets: ["typescript", "react"],
          filename: "game.tsx"
        });
        new Function(result.code)();
      } catch (err) {
        if (root) {
          root.style.background = "#145230";
          root.innerHTML = '<pre style="color:#f5f0e6;padding:24px;white-space:pre-wrap;background:#145230">' +
            String(err && err.message ? err.message : err) + "</pre>";
        }
        throw err;
      }
    })();
  </script>
</body>
</html>
HTML

my $out = "/Users/denis/Downloads/projects/c-Users-Deniss-Desktop-Citron/docs/index.html";
open my $fh, ">:raw", $out or die $!;
print $fh encode("UTF-8", $html);
close $fh;
print "wrote $out (", -s $out, " bytes)\n";
