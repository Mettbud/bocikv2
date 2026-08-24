import { createServer, type Server } from "node:http";
import type { DashboardState } from "./dashboard.js";
import type { Logger } from "../logger.js";

/**
 * A tiny localhost-only web page mirroring the terminal dashboard.
 *
 * Exists because terminal-based live redraws depend on the terminal
 * correctly executing ANSI cursor-movement/screen-clear escape codes -
 * which, across several rounds of fixes, turned out to be unreliable in
 * at least one real Windows console even though basic color codes worked
 * fine there. A browser tab has no equivalent failure mode: the page's
 * own JavaScript just replaces DOM content on a timer, which every
 * browser does correctly by construction - there's no "did the terminal
 * interpret this control code" question to get wrong.
 *
 * Deliberately not built as a SPA/bundle - one dependency-free HTML file
 * with inline CSS/JS, served directly by node:http. Binds to 127.0.0.1
 * only (never 0.0.0.0): the page has no auth and shows wallet balances
 * and position sizes, so it must never be reachable from the network.
 */
/** The bare HTTP server, with no listening/logging wired up - split out so tests can drive it on an ephemeral port. */
export function createDashboardHttpServer(getSnapshot: () => DashboardState): Server {
  return createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

export function startWebDashboard(
  getSnapshot: () => DashboardState,
  port: number,
  logger: Logger,
): { close: () => void } {
  const server = createDashboardHttpServer(getSnapshot);

  server.on("error", (err) => {
    logger.warn("web dashboard failed to start - continuing without it", {
      error: String((err as Error).message ?? err),
      port,
    });
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info(`web dashboard listening at http://127.0.0.1:${port} (localhost only)`);
  });

  return { close: () => server.close() };
}

const PAGE_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>bocik dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body {
    background: #0b0e14; color: #d8dee9; font: 14px/1.5 "Cascadia Code", "Consolas", monospace;
    margin: 0; padding: 24px;
  }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .price { font-size: 20px; margin: 0 0 20px; }
  .slot { border: 1px solid #2a2f3a; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; max-width: 560px; }
  .slot h2 { font-size: 14px; margin: 0 0 8px; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .row + .row { margin-top: 2px; }
  .label { color: #8b93a7; }
  .pos { color: #6bcf7f; }
  .neg { color: #ef6b6b; }
  .mode-live { color: #ef6b6b; font-weight: bold; }
  .mode-paper { color: #6bcf7f; font-weight: bold; }
  .muted { color: #5c6376; }
  .stale { opacity: 0.5; }
  table.trades { border-collapse: collapse; font-size: 13px; }
  table.trades td { padding: 2px 10px 2px 0; }
</style>
</head>
<body>
  <div id="app">Ładowanie...</div>
<script>
function usd(n, d) {
  d = d === undefined ? 2 : d;
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  return "$" + n.toFixed(d);
}
function pct(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}
function signClass(n) {
  return n !== undefined && n < 0 ? "neg" : "pos";
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderSlot(slot, tokenSymbol) {
  let html = '<div class="slot"><h2>Slot ' + slot.label + ' (' + slot.sizePercent + '% portfela)</h2>';
  const p = slot.position;
  if (p) {
    html += row("Pozycja", p.tokenAmount.toLocaleString("en-US") + " " + esc(tokenSymbol));
    html += row("Wartość", usd(p.positionValueUsd));
    html += row("Cena wejścia", usd(p.buyPriceUsd, 8));
    html += row(
      "Niezrealizowane",
      '<span class="' + signClass(p.unrealizedPercent) + '">' + pct(p.unrealizedPercent) +
        " (" + usd(p.unrealizedUsd, 2) + ")</span>",
    );
    html += row("Cel sprzedaży", usd(p.sellTargetUsd, 8) + " (+" + p.targetGainPercent.toFixed(2) + "%)");
    if (p.stopLossPriceUsd !== undefined) {
      html += row("Stop loss", usd(p.stopLossPriceUsd, 8) + " (" + pct(p.stopLossPercent) + ")");
    }
    if (p.trailingStop) {
      html += row(
        "Trailing stop",
        (p.trailingStop.armed ? "uzbrojony" : "nieuzbrojony") + ", szczyt " + usd(p.trailingStop.peakPriceUsd, 8),
      );
    }
  } else {
    html += row("Pozycja", '<span class="muted">brak - czeka na sygnał kupna</span>');
  }
  html += row("Ukończone flipy", String(slot.completedFlips));
  html += "</div>";
  return html;
}

function row(label, valueHtml) {
  return '<div class="row"><span class="label">' + label + ':</span><span>' + valueHtml + "</span></div>";
}

function render(s) {
  let html = "<h1>" + esc(s.tokenSymbol) + "</h1>";
  html += '<div class="price">' + usd(s.priceUsd, 8) + "</div>";
  html += renderSlot(s.slotA, s.tokenSymbol);
  html += renderSlot(s.slotB, s.tokenSymbol);
  if (s.slotC) html += renderSlot(s.slotC, s.tokenSymbol);

  html += '<div class="row"><span class="label">Realized PnL:</span><span class="' +
    signClass(s.realizedPnlUsd) + '">' + usd(s.realizedPnlUsd, 2) + "</span></div>";
  html += '<div class="row"><span class="label">SOL balance:</span><span>' + s.solBalance.toFixed(6) + "</span></div>";
  html += '<div class="row"><span class="label">' + esc(s.tokenSymbol) + ' balance:</span><span>' +
    s.tokenBalance.toLocaleString("en-US") + "</span></div>";

  if (s.recentTrades && s.recentTrades.length > 0) {
    html += "<h2>Ostatnie transakcje</h2><table class=\\"trades\\">";
    for (const t of s.recentTrades) {
      html += "<tr><td>" + t.side + "</td><td>Slot " + t.slot + "</td><td>" +
        t.tokenAmount.toFixed(2) + " " + esc(s.tokenSymbol) + "</td><td>" + usd(t.priceUsd, 8) + "</td><td>" +
        (t.netProfitPercent !== undefined
          ? '<span class="' + signClass(t.netProfitPercent) + '">' + pct(t.netProfitPercent) + "</span>"
          : "") +
        "</td></tr>";
    }
    html += "</table>";
  }

  html += '<div class="row" style="margin-top:16px"><span class="label">Mode:</span><span class="mode-' +
    s.mode.toLowerCase() + '">' + s.mode + "</span></div>";

  document.getElementById("app").innerHTML = html;
}

let failures = 0;
async function tick() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const state = await res.json();
    failures = 0;
    render(state);
  } catch (err) {
    failures++;
    if (failures === 3) {
      document.getElementById("app").innerHTML =
        '<p class="muted">Nie mogę połączyć się z botem - upewnij się, że nadal działa.</p>';
    }
  }
}
tick();
setInterval(tick, 1000);
</script>
</body>
</html>
`;
