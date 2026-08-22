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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Citrons — TwoCircles Edition</title>
  <meta name="description" content="Карточная игра Citrons. Соло против ботов." />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a6b3c'/><text x='16' y='22' text-anchor='middle' font-size='16' fill='%23f5f0e6'>C</text></svg>" />
  <style>
    html, body, #root { margin: 0; height: 100%; background: #145230; }
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    button { font-family: inherit; }
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
