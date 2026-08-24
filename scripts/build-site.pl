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
const { useState, useEffect, useRef, useCallback } = React;
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
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#145230" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Citrons" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="apple-touch-icon" href="icon.svg" />
  <title>Citrons — TwoCircles Edition</title>
  <meta name="description" content="Карточная игра Citrons. Соло против ботов." />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a6b3c'/><text x='16' y='22' text-anchor='middle' font-size='16' fill='%23f5f0e6'>C</text></svg>" />
  <style>
    html, body { margin: 0; height: 100%; height: 100dvh; background: #145230; overflow: hidden; }
    html:fullscreen, html:-webkit-full-screen, body:fullscreen { height: 100% !important; width: 100% !important; }
    #root { height: 100%; overflow: hidden; }
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
</head>
<body>
  <div id="root"><p style="color:#f5f0e6;text-align:center;padding:48px 16px;letter-spacing:0.04em">Загрузка Citrons…</p></div>
  <script src="$react" crossorigin></script>
  <script src="$reactdom" crossorigin></script>
  <script src="$babel"></script>
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
        var src = document.getElementById("citrons-src").textContent;
        var result = Babel.transform(src, {
          presets: ["typescript", "react"],
          filename: "game.tsx"
        });
        new Function(result.code)();
      } catch (err) {
        if (root) {
          root.innerHTML = '<pre style="color:#f5f0e6;padding:24px;white-space:pre-wrap">' +
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
