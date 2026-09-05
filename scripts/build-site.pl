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
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=overlays-content" />
  <meta name="theme-color" content="#145230" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Citrons" />
  <link rel="manifest" href="manifest.webmanifest" />
  <!-- keep ?v= in sync with HOME_ICON_VERSION in canvases/card-game.canvas.tsx -->
  <link rel="apple-touch-icon" href="apple-touch-icon.png?v=1" />
  <title>Citrons — TwoCircles Edition</title>
  <meta name="description" content="Citrons card game. Solo against bots." />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a6b3c'/><text x='16' y='22' text-anchor='middle' font-size='16' fill='%23f5f0e6'>C</text></svg>" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #145230; overflow: hidden; }
    html { position: fixed; inset: 0; width: 100%; height: 100%; }
    html:fullscreen, html:-webkit-full-screen, body:fullscreen, body:-webkit-full-screen {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      background: #145230;
    }
    #root { position: absolute; inset: 0; overflow: hidden; width: 100%; height: 100%; }
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
