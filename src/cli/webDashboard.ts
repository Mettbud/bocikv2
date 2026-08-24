import { createServer, type Server } from "node:http";
import type { DashboardState } from "./dashboard.js";
import { handleLine, type CommandDeps } from "./commands.js";
import type { Logger } from "../logger.js";

/**
 * A tiny localhost-only web page mirroring the terminal dashboard, with
 * buy/sell/panic buttons wired to the exact same command path as typing
 * "buy a" / "sell b" / "panic" in the terminal (handleLine() - see
 * commands.ts - so every existing safety check, e.g. "already in a
 * position" or the live MIN_SOL_RESERVE guard, applies identically here;
 * a button is just a different way to submit the same command string).
 *
 * Exists because terminal-based live redraws depend on the terminal
 * correctly executing ANSI cursor-movement/screen-clear escape codes -
 * which, across several rounds of fixes, turned out to be unreliable in
 * at least one real Windows console even though basic color codes worked
 * fine there. A browser tab has no equivalent failure mode: the page's
 * own JavaScript just replaces DOM content on a timer, which every
 * browser does correctly by construction.
 *
 * Deliberately not built as a SPA/bundle - one dependency-free HTML file
 * with inline CSS/JS, served directly by node:http. Binds to 127.0.0.1
 * only (never 0.0.0.0): the page has no auth and shows wallet balances
 * and can submit trades, so it must never be reachable from the network.
 */

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

// Matches http://127.0.0.1:<port> or http://localhost:<port> only - each
// bot instance (A/B/C) runs its own server on its own port, and the combined
// view (see PAGE_HTML) needs to fetch a sibling instance's /api/state and
// POST its /api/command cross-port, which the browser treats as
// cross-origin. Reflecting only same-machine localhost origins (never "*")
// keeps this from becoming an open CORS endpoint any website could hit.
const LOCALHOST_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

function applyCors(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  allowCommands: boolean,
): void {
  const origin = req.headers.origin;
  if (origin && LOCALHOST_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", allowCommands ? "GET, POST, OPTIONS" : "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

/** The bare HTTP server, with no listening/logging wired up - split out so tests can drive it on an ephemeral port. */
export function createDashboardHttpServer(getSnapshot: () => DashboardState, deps: CommandDeps): Server {
  return createServer((req, res) => {
    applyCors(req, res, true);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }
    if (req.method === "POST" && req.url === "/api/command") {
      readJsonBody(req)
        .then(async (body) => {
          const line = typeof body === "object" && body !== null ? (body as { line?: unknown }).line : undefined;
          if (typeof line !== "string" || line.trim().length === 0) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "missing 'line'" }));
            return;
          }
          await handleLine(line.trim(), deps);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }));
        });
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

/**
 * A genuinely read-only sibling server: it serves snapshots and HTML but has
 * no route that reaches CommandDeps/handleLine. This is intentionally a
 * separate port, so hiding buttons in the browser cannot be bypassed by
 * manually POSTing to the control dashboard's command endpoint.
 */
export function createReadOnlyDashboardHttpServer(getSnapshot: () => DashboardState): Server {
  return createServer((req, res) => {
    applyCors(req, res, false);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readOnlyPageHtml());
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

export function startWebDashboard(
  getSnapshot: () => DashboardState,
  deps: CommandDeps,
  port: number,
  logger: Logger,
): { close: () => void } {
  const server = createDashboardHttpServer(getSnapshot, deps);

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

export function startReadOnlyWebDashboard(
  getSnapshot: () => DashboardState,
  port: number,
  logger: Logger,
): { close: () => void } {
  const server = createReadOnlyDashboardHttpServer(getSnapshot);

  server.on("error", (err) => {
    logger.warn("read-only web dashboard failed to start - continuing without it", {
      error: String((err as Error).message ?? err),
      port,
    });
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info(`read-only web dashboard listening at http://127.0.0.1:${port} (localhost only)`);
  });

  return { close: () => server.close() };
}

function readOnlyPageHtml(): string {
  return PAGE_HTML
    .replace("<body>", '<body class="read-only">')
    .replace("<h1>bocik</h1>", "<h1>bocik — podgląd tylko</h1>")
    .replace("const READ_ONLY = false;", "const READ_ONLY = true;")
    .replace(
      "const peerPorts = { b: 4174, c: 4175, ...savedPeerPorts };",
      "const peerPorts = { b: 4274, c: 4275, ...savedPeerPorts };",
    );
}

const PAGE_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>bocik dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d12; --panel: #161a24; --panel2: #1b2130; --border: #262c3a; --text: #e4e8f1; --muted: #7b8496;
    --green: #4ade80; --red: #f87171; --yellow: #fbbf24; --accent: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 28px; max-width: 980px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 0 0 20px; letter-spacing: 0.02em; }
  .instance { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; margin-bottom: 18px; overflow: hidden; }
  .instance-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 20px; cursor: pointer; user-select: none;
  }
  .instance-head:hover { background: rgba(255,255,255,0.02); }
  .instance-title { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 700; }
  #renameSelfBtn {
    padding: 1px 6px; border: 0; background: transparent; color: var(--muted);
    font-size: 13px; line-height: 1; opacity: 0.7;
  }
  #renameSelfBtn:hover { color: var(--accent); opacity: 1; }
  .instance-price { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }
  .chevron { color: var(--muted); font-size: 11px; transition: transform 0.15s; }
  .instance.collapsed .chevron { transform: rotate(-90deg); }
  .instance.collapsed .instance-body { display: none; }
  .instance-body { padding: 0 20px 20px; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }
  .badge-live { background: rgba(248,113,113,0.15); color: var(--red); }
  .badge-paper { background: rgba(74,222,128,0.15); color: var(--green); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
  .dot.stale { background: var(--red); }
  .connect-form { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .connect-form input {
    width: 72px; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 4px 8px; font: inherit;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .slot { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .slot.collapsed .slot-body { display: none; }
  .slot-head { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; margin-bottom: 2px; }
  .slot-head h3 { font-size: 13.5px; margin: 0; font-weight: 700; }
  .slot.collapsed .chevron { transform: rotate(-90deg); }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 2.5px 0; font-size: 12.5px; }
  .label { color: var(--muted); }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .muted { color: var(--muted); }
  .warn { color: var(--yellow); }
  .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 7px;
    border: 1px solid var(--border); background: #232a3a; color: var(--text); cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: 0.3; cursor: not-allowed; }
  button.buy { color: var(--green); }
  button.sell { color: var(--yellow); }
  button.panic { color: var(--red); }
  .summary { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .toast {
    position: fixed; bottom: 20px; right: 20px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 10px 16px; font-size: 13px; max-width: 360px; opacity: 0; transform: translateY(8px);
    transition: opacity 0.2s, transform 0.2s; pointer-events: none; z-index: 10;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  table.trades { border-collapse: collapse; font-size: 12.5px; width: 100%; }
  table.trades td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
  h4 { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 8px; }
  .placeholder { color: var(--muted); font-size: 13px; padding: 4px 0 12px; }
</style>
</head>
<body>
  <h1>bocik</h1>

  <div class="instance" data-instance="self">
    <div class="instance-head" data-action="toggleInstance" data-instance="self">
      <span class="instance-title"><span class="dot" data-role="dot"></span> <span id="selfLabel">Ta instancja</span>
        <button type="button" id="renameSelfBtn" title="Zmień nazwę" data-action="renameSelf">&#9998;</button>
        <span class="instance-price" data-role="price"></span></span>
      <span class="chevron">&#9660;</span>
    </div>
    <div class="instance-body" data-role="body"><p class="placeholder">Ładowanie...</p></div>
  </div>

  <div class="instance" data-instance="b">
    <div class="instance-head" data-action="toggleInstance" data-instance="b">
      <span class="instance-title"><span class="dot" data-role="dot"></span> Instancja B <span class="instance-price" data-role="price"></span></span>
      <span class="chevron">&#9660;</span>
    </div>
    <div class="instance-body" data-role="body"></div>
  </div>

  <div class="instance" data-instance="c">
    <div class="instance-head" data-action="toggleInstance" data-instance="c">
      <span class="instance-title"><span class="dot" data-role="dot"></span> Instancja C <span class="instance-price" data-role="price"></span></span>
      <span class="chevron">&#9660;</span>
    </div>
    <div class="instance-body" data-role="body"></div>
  </div>

  <div class="toast" id="toast"></div>
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
  if (n === undefined || n === null) return "";
  return n < 0 ? "neg" : "pos";
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function row(label, valueHtml) {
  return '<div class="row"><span class="label">' + label + ':</span><span>' + valueHtml + "</span></div>";
}

const READ_ONLY = false;

const slotCollapsed = JSON.parse(localStorage.getItem("bocik.slotCollapsed") || "{}");
const instanceCollapsed = JSON.parse(localStorage.getItem("bocik.instanceCollapsed") || "{}");
const savedPeerPorts = JSON.parse(localStorage.getItem("bocik.peerPorts") || "{}");
// The page on 4173 is the single control panel. Connect its two peer panels
// automatically, while still allowing manually saved ports to override the
// defaults for an unusual local setup.
const peerPorts = { b: 4174, c: 4175, ...savedPeerPorts };

function renderSlotBody(slot, tokenSymbol) {
  let html = "";
  const p = slot.position;
  if (p) {
    html += row("Pozycja", p.tokenAmount.toLocaleString("en-US") + " " + esc(tokenSymbol));
    html += row("Wartość", usd(p.positionValueUsd));
    html += row("Cena wejścia", usd(p.buyPriceUsd, 8));
    html += row("Niezrealizowane", '<span class="' + signClass(p.unrealizedPercent) + '">' + pct(p.unrealizedPercent) +
      " (" + usd(p.unrealizedUsd, 2) + ")</span>");
    html += row("Cel sprzedaży", usd(p.sellTargetUsd, 8) + " (+" + p.targetGainPercent.toFixed(2) + "%)");
    if (p.netIfSoldNowPercent !== undefined) {
      const wouldSell = p.netIfSoldNowPercent >= slot.minNetProfitPercent;
      html += row("Netto teraz", '<span class="' + signClass(p.netIfSoldNowPercent) + '">' + pct(p.netIfSoldNowPercent) +
        " (" + usd(p.netIfSoldNowUsd, 2) + ")</span> " +
        (wouldSell ? '<span class="pos">(sprzedałby)</span>' : '<span class="muted">(za mało netto)</span>'));
    }
    if (p.stopLossPriceUsd !== undefined) {
      html += row("Stop loss", usd(p.stopLossPriceUsd, 8) + " (-" + (p.stopLossPercent || 0).toFixed(2) + "%)");
    }
    if (p.trailingStop) {
      const t = p.trailingStop;
      const peakGainPercent = ((t.peakPriceUsd / p.buyPriceUsd) - 1) * 100;
      html += t.armed && t.triggerPriceUsd !== undefined
        ? row("Trailing stop", '<span class="pos">UZBROJONY</span>, szczyt ' + usd(t.peakPriceUsd, 8) + " (" + pct(peakGainPercent) + " od wejścia), próg cofnięcia " + usd(t.triggerPriceUsd, 8) + " (" + pct(((t.triggerPriceUsd / p.buyPriceUsd) - 1) * 100) + " od wejścia); sprzeda tylko przy netto &ge; +" + slot.minNetProfitPercent.toFixed(2) + "%")
        : row("Trailing stop", '<span class="muted">nieuzbrojony</span> (szczyt ' + usd(t.peakPriceUsd, 8) + ", " + pct(peakGainPercent) + " od wejścia)");
    }
  } else if (slot.requireManualNextBuy) {
    html += row("Pozycja", '<span class="muted">brak - czeka na sygnał kupna</span>');
    html += row("Uwaga", '<span class="warn">czeka na ręczne "buy"</span> (ostatnia sprzedaż była ręczna/panic)');
  } else if (slot.reinforcement) {
    const r = slot.reinforcement;
    if (!r.enabled) {
      html += row("Status", '<span class="muted">wyłączony</span>');
    } else if (r.slotADrawdownPercent === undefined) {
      html += row("Status", "czeka na otwartą pozycję w Slocie A");
    } else {
      html += row("Czeka aż Slot A będzie na", '<span class="warn">-' + r.triggerDropPercent.toFixed(2) + '%</span> (teraz: <span class="' +
        signClass(r.slotADrawdownPercent) + '">' + pct(r.slotADrawdownPercent) + "</span>)");
    }
  } else {
    html += row("Pozycja", '<span class="muted">brak - czeka na sygnał kupna</span>');
    if (slot.rebuyTriggerUsd !== undefined) {
      html += row("Odkup poniżej", usd(slot.rebuyTriggerUsd, 8) + " (ostatnia sprzedaż " + usd(slot.lastSellPriceUsd, 8) + ")");
    } else {
      html += row("Info", "pierwsze wejście - kupi przy najbliższym ticku");
    }
    if (slot.breakoutBuy) {
      const b = slot.breakoutBuy;
      html += b.peakUsd === undefined
        ? row("Wybicie", '<span class="muted">śledzenie nieaktywne</span>')
        : row("Wybicie", "szczyt " + usd(b.peakUsd, 8) + ", kupi poniżej " + usd(b.triggerPriceUsd, 8));
    }
  }

  if (!p) {
    if (slot.autoBuyPausedSecondsLeft !== undefined) {
      html += row("Auto-kupno", '<span class="neg">WSTRZYMANE</span> (' + slot.autoBuyPausedSecondsLeft + "s)");
    }
    if (slot.pendingManualBuy) {
      const m = slot.pendingManualBuy;
      const amountLabel = m.usdAmount !== undefined ? usd(m.usdAmount, 2) : slot.sizePercent + "% salda";
      html += row("Oczekujące zlecenie", '<span class="warn">kup ' + amountLabel + " przy cenie &le; " + usd(m.maxPriceUsd, 8) + "</span>");
    }
    if (slot.nextBuyUsdEstimate !== undefined) {
      html += row("Wielkość kupna", slot.sizePercent + "% salda (~" + usd(slot.nextBuyUsdEstimate, 2) + ")");
    }
    html += slot.adaptiveTargetEnabled
      ? row("Następny cel", '<span class="pos">adaptacyjny</span>, obecnie ' + (slot.nextTargetGainPercent !== undefined ? "+" + slot.nextTargetGainPercent.toFixed(2) + "%" : "-"))
      : row("Następny cel", '<span class="muted">stały</span> +' + slot.staticTargetGainPercent.toFixed(2) + "%");
  }

  html += row("Ukończone flipy", String(slot.completedFlips));
  return html;
}

function renderSlot(instanceKey, slot, tokenSymbol) {
  const ckey = instanceKey + ":" + slot.label;
  const isCollapsed = !!slotCollapsed[ckey];
  let html = '<div class="slot' + (isCollapsed ? " collapsed" : "") + '">';
  html += '<div class="slot-head" data-action="toggleSlot" data-instance="' + instanceKey + '" data-slot="' + slot.label + '">' +
    "<h3>Slot " + slot.label + " (" + slot.sizePercent + "%)</h3>" +
    '<span class="chevron">&#9660;</span></div>';
  html += '<div class="slot-body">';
  html += renderSlotBody(slot, tokenSymbol);
  if (!READ_ONLY) {
    html += '<div class="actions">';
    html += '<button class="buy" data-action="buy" data-instance="' + instanceKey + '" data-slot="' + slot.label + '" ' + (slot.position ? "disabled" : "") + '>Kup</button>';
    html += '<button class="sell" data-action="sell" data-instance="' + instanceKey + '" data-slot="' + slot.label + '" ' + (slot.position ? "" : "disabled") + '>Sprzedaj</button>';
    html += '<button class="panic" data-action="panic" data-instance="' + instanceKey + '" data-slot="' + slot.label + '" ' + (slot.position ? "" : "disabled") + '>Panic</button>';
    if (slot.pendingManualBuy) {
      html += '<button data-action="cancel" data-instance="' + instanceKey + '" data-slot="' + slot.label + '">Anuluj zlecenie</button>';
    }
    html += "</div>";
  }
  html += "</div></div>";
  return html;
}

function renderInstanceBody(instanceKey, s) {
  let html = '<div class="grid">';
  html += renderSlot(instanceKey, s.slotA, s.tokenSymbol);
  html += renderSlot(instanceKey, s.slotB, s.tokenSymbol);
  if (s.slotC) html += renderSlot(instanceKey, s.slotC, s.tokenSymbol);
  html += "</div>";

  html += '<div class="summary">';
  html += row("Realized PnL", '<span class="' + signClass(s.realizedPnlUsd) + '">' + usd(s.realizedPnlUsd, 2) + "</span>");
  html += row("W rynku teraz", usd(s.investedUsd, 2) + (s.investedPercentOfEquity !== undefined ? " (" + s.investedPercentOfEquity.toFixed(1) + "% portfela)" : ""));
  html += row("W SOL teraz", s.solBalance.toFixed(6) + " SOL" + (s.solValueUsd !== undefined ? " (" + usd(s.solValueUsd, 2) + ")" : ""));
  html += row("Rezerwa SOL", s.minSolReserve.toFixed(6) + " SOL");
  html += row("Dostępne na kupna", s.availableSolForBuys.toFixed(6) + " SOL" + (s.availableUsdForBuys !== undefined ? " (" + usd(s.availableUsdForBuys, 2) + ")" : ""));
  html += row("Kapitał początkowy", usd(s.initialPortfolioUsd, 2));
  html += row(esc(s.tokenSymbol) + " balance", s.tokenBalance.toLocaleString("en-US"));
  if (s.paperUsdBalance !== undefined) html += row("Paper equity", usd(s.paperUsdBalance, 2));
  html += row("Spread puli", (s.spreadPercent !== undefined ? s.spreadPercent.toFixed(2) + "%" : "-") + " (max " + s.maxSpreadPercent + "%)");
  html += "</div>";

  if (s.recentTrades && s.recentTrades.length > 0) {
    html += "<h4>Ostatnie transakcje</h4><table class=\\"trades\\"><tbody>";
    for (const t of s.recentTrades) {
      html += "<tr><td>" + (t.side === "BUY" ? '<span class="warn">KUPNO</span>' : '<span class="pos">SPRZEDAŻ</span>') +
        "</td><td>Slot " + t.slot + "</td><td>" + t.tokenAmount.toLocaleString("en-US") + " " + esc(s.tokenSymbol) +
        "</td><td>" + usd(t.priceUsd, 8) + "</td><td>" +
        (t.netProfitPercent !== undefined ? '<span class="' + signClass(t.netProfitPercent) + '">' + pct(t.netProfitPercent) + "</span>" : "") +
        "</td></tr>";
    }
    html += "</tbody></table>";
  }

  if (s.lastErrorMessage) {
    html += '<h4>Ostatni błąd</h4><div class="warn">' + esc(s.lastErrorMessage) + "</div>";
  }
  return html;
}

function connectForm(instanceKey) {
  return '<div class="connect-form">Port: <input type="number" placeholder="np. 417' + (instanceKey === "b" ? "4" : "5") +
    '" data-role="portInput" data-instance="' + instanceKey + '"> ' +
    '<button data-action="connect" data-instance="' + instanceKey + '">Połącz</button></div>';
}

function panelEl(instanceKey) {
  return document.querySelector('.instance[data-instance="' + instanceKey + '"]');
}

function setInstanceCollapsed(instanceKey, value) {
  panelEl(instanceKey).classList.toggle("collapsed", value);
  instanceCollapsed[instanceKey] = value;
  localStorage.setItem("bocik.instanceCollapsed", JSON.stringify(instanceCollapsed));
}

const instances = {
  self: { baseUrl: "", configured: true, failures: 0, lastState: null },
  b: { baseUrl: null, configured: false, failures: 0, lastState: null },
  c: { baseUrl: null, configured: false, failures: 0, lastState: null },
};

function initPeer(key) {
  const port = peerPorts[key];
  const panel = panelEl(key);
  if (!port) {
    panel.querySelector('[data-role="body"]').innerHTML =
      '<div class="placeholder">Ta instancja nie jest tu skonfigurowana.</div>' + connectForm(key);
    return;
  }
  instances[key].baseUrl = "http://127.0.0.1:" + port;
  instances[key].configured = true;
  tick(key);
}

async function sendCommand(instanceKey, line, successMsg) {
  const inst = instances[instanceKey];
  try {
    const res = await fetch(inst.baseUrl + "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(successMsg || ("wysłano: " + line), false);
      tick(instanceKey);
    } else {
      showToast("błąd: " + (data.error || "nieznany"), true);
    }
  } catch (err) {
    showToast("błąd połączenia: " + err.message, true);
  }
}

function showToast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.borderColor = isError ? "var(--red)" : "var(--border)";
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3500);
}

async function tick(instanceKey) {
  const inst = instances[instanceKey];
  if (!inst.configured) return;
  const panel = panelEl(instanceKey);
  const dot = panel.querySelector('[data-role="dot"]');
  const priceEl = panel.querySelector('[data-role="price"]');
  const body = panel.querySelector('[data-role="body"]');
  try {
    const res = await fetch(inst.baseUrl + "/api/state", { cache: "no-store" });
    const state = await res.json();
    inst.lastState = state;
    inst.failures = 0;
    dot.classList.remove("stale");
    priceEl.innerHTML = usd(state.priceUsd, 8) + ' <span class="badge badge-' + state.mode.toLowerCase() + '">' + state.mode + "</span>";
    body.innerHTML = renderInstanceBody(instanceKey, state);
  } catch (err) {
    inst.failures++;
    dot.classList.add("stale");
    if (inst.failures >= 3) {
      body.innerHTML = '<p class="placeholder">Brak połączenia z instancją ' + esc(instanceKey) + " (" + esc(inst.baseUrl) + ").</p>" +
        (instanceKey === "self" ? "" : connectForm(instanceKey));
    }
  }
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const key = el.dataset.instance;
  const slot = el.dataset.slot;

  if (action === "toggleInstance") {
    setInstanceCollapsed(key, !panelEl(key).classList.contains("collapsed"));
    return;
  }
  if (action === "renameSelf") {
    const currentName = localStorage.getItem(selfNameStorageKey) || "";
    const enteredName = prompt("Nazwa tej instancji (pusta = nazwa domyślna):", currentName);
    if (enteredName === null) return;
    const nextName = enteredName.trim().slice(0, 40);
    if (nextName) localStorage.setItem(selfNameStorageKey, nextName);
    else localStorage.removeItem(selfNameStorageKey);
    applySelfName();
    return;
  }
  if (action === "toggleSlot") {
    const ckey = key + ":" + slot;
    slotCollapsed[ckey] = !slotCollapsed[ckey];
    localStorage.setItem("bocik.slotCollapsed", JSON.stringify(slotCollapsed));
    if (instances[key].lastState) {
      panelEl(key).querySelector('[data-role="body"]').innerHTML = renderInstanceBody(key, instances[key].lastState);
    }
    return;
  }
  if (action === "connect") {
    const input = panelEl(key).querySelector('[data-role="portInput"]');
    const port = parseInt(input.value, 10);
    if (!port || port < 1 || port > 65535) { showToast("podaj prawidłowy numer portu", true); return; }
    peerPorts[key] = port;
    localStorage.setItem("bocik.peerPorts", JSON.stringify(peerPorts));
    initPeer(key);
    return;
  }
  if (action === "buy") { sendCommand(key, "buy " + slot.toLowerCase(), "Kupno zlecone (Slot " + slot + ")"); return; }
  if (action === "sell") { if (confirm("Sprzedać całą pozycję Slotu " + slot + "?")) sendCommand(key, "sell 100 " + slot.toLowerCase(), "Sprzedaż zlecona (Slot " + slot + ")"); return; }
  if (action === "panic") { if (confirm("PANIC - natychmiastowa sprzedaż Slotu " + slot + "?")) sendCommand(key, "panic " + slot.toLowerCase(), "Panic wysłany (Slot " + slot + ")"); return; }
  if (action === "cancel") { sendCommand(key, "cancel " + slot.toLowerCase(), "Zlecenie anulowane"); return; }
});

if (instanceCollapsed.self) setInstanceCollapsed("self", true);
if (instanceCollapsed.b) setInstanceCollapsed("b", true);
if (instanceCollapsed.c) setInstanceCollapsed("c", true);

// A custom label is local to this browser and this exact port, so three
// concurrently-running instances can be named independently (for example
// LIVE, PAPER B and PAPER C) without changing bot configuration.
const selfNameStorageKey = "bocik.selfName." + location.port;
function applySelfName() {
  const customName = (localStorage.getItem(selfNameStorageKey) || "").trim();
  const displayName = customName || "Ta instancja";
  document.title = (customName ? customName + " - " : "") + "bocik :" + location.port;
  document.getElementById("selfLabel").textContent = displayName + " (port " + location.port + ")";
}
applySelfName();

tick("self");
initPeer("b");
initPeer("c");
setInterval(() => { tick("self"); tick("b"); tick("c"); }, 1000);
</script>
</body>
</html>
`;
