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

/** The bare HTTP server, with no listening/logging wired up - split out so tests can drive it on an ephemeral port. */
export function createDashboardHttpServer(getSnapshot: () => DashboardState, deps: CommandDeps): Server {
  return createServer((req, res) => {
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

const PAGE_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>bocik dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1017; --panel: #161a24; --border: #262c3a; --text: #dfe4ee; --muted: #7b8496;
    --green: #4ade80; --red: #f87171; --yellow: #fbbf24; --accent: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, "Segoe UI", "Cascadia Code", Roboto, sans-serif;
    margin: 0; padding: 28px; max-width: 920px; margin-inline: auto;
  }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: 0.02em; }
  .price { font-size: 28px; font-variant-numeric: tabular-nums; margin: 2px 0 22px; color: var(--accent); }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
  .badge-live { background: rgba(248,113,113,0.15); color: var(--red); }
  .badge-paper { background: rgba(74,222,128,0.15); color: var(--green); }
  .conn { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .dot.stale { background: var(--red); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .slot { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; transition: opacity 0.15s; }
  .slot.collapsed .slot-body { display: none; }
  .slot-head { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
  .slot-head h2 { font-size: 15px; margin: 0; }
  .slot-head .chevron { color: var(--muted); font-size: 12px; transition: transform 0.15s; }
  .slot.collapsed .chevron { transform: rotate(-90deg); }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 13px; }
  .label { color: var(--muted); }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .muted { color: var(--muted); }
  .warn { color: var(--yellow); }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 12px; font-weight: 600; padding: 7px 14px; border-radius: 8px;
    border: 1px solid var(--border); background: #1d2330; color: var(--text); cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.35; cursor: not-allowed; }
  button.buy { color: var(--green); }
  button.sell { color: var(--yellow); }
  button.panic { color: var(--red); }
  .summary { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 10px 16px; font-size: 13px; max-width: 360px; opacity: 0; transform: translateY(8px);
    transition: opacity 0.2s, transform 0.2s; }
  .toast.show { opacity: 1; transform: translateY(0); }
  table.trades { border-collapse: collapse; font-size: 13px; width: 100%; }
  table.trades td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
  h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 24px 0 10px; }
</style>
</head>
<body>
  <header>
    <h1>bocik</h1>
    <span class="conn"><span class="dot" id="dot"></span><span id="connLabel">łączenie...</span></span>
  </header>
  <div id="app">Ładowanie...</div>
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

const collapsed = JSON.parse(localStorage.getItem("bocik.collapsed") || "{}");
function toggleSlot(label) {
  collapsed[label] = !collapsed[label];
  localStorage.setItem("bocik.collapsed", JSON.stringify(collapsed));
  renderLast();
}

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
      html += t.armed && t.triggerPriceUsd !== undefined
        ? row("Trailing stop", '<span class="pos">UZBROJONY</span>, szczyt ' + usd(t.peakPriceUsd, 8) + ", sprzeda poniżej " + usd(t.triggerPriceUsd, 8))
        : row("Trailing stop", '<span class="muted">nieuzbrojony</span> (szczyt ' + usd(t.peakPriceUsd, 8) + ")");
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

function renderSlot(slot, tokenSymbol) {
  const isCollapsed = !!collapsed[slot.label];
  let html = '<div class="slot' + (isCollapsed ? " collapsed" : "") + '" data-slot="' + slot.label + '">';
  html += '<div class="slot-head" onclick="toggleSlot(\\'' + slot.label + '\\')">' +
    "<h2>Slot " + slot.label + " (" + slot.sizePercent + "% portfela)</h2>" +
    '<span class="chevron">&#9660;</span></div>';
  html += '<div class="slot-body">';
  html += renderSlotBody(slot, tokenSymbol);
  html += '<div class="actions" onclick="event.stopPropagation()">';
  html += '<button class="buy" ' + (slot.position ? "disabled" : "") + ' onclick="sendCommand(\\'buy ' + slot.label.toLowerCase() + '\\', \\'Kupno zlecone (Slot ' + slot.label + ')\\')">Kup</button>';
  html += '<button class="sell" ' + (slot.position ? "" : "disabled") + ' onclick="if(confirm(\\'Sprzedać całą pozycję Slotu ' + slot.label + '?\\')) sendCommand(\\'sell 100 ' + slot.label.toLowerCase() + '\\', \\'Sprzedaż zlecona (Slot ' + slot.label + ')\\')">Sprzedaj</button>';
  html += '<button class="panic" ' + (slot.position ? "" : "disabled") + ' onclick="if(confirm(\\'PANIC - natychmiastowa sprzedaż Slotu ' + slot.label + '?\\')) sendCommand(\\'panic ' + slot.label.toLowerCase() + '\\', \\'Panic wysłany (Slot ' + slot.label + ')\\')">Panic</button>';
  if (slot.pendingManualBuy) {
    html += '<button onclick="sendCommand(\\'cancel ' + slot.label.toLowerCase() + '\\', \\'Zlecenie anulowane\\')">Anuluj zlecenie</button>';
  }
  html += "</div></div></div>";
  return html;
}

let lastState = null;
function renderLast() { if (lastState) render(lastState); }

function render(s) {
  lastState = s;
  let html = '<div class="price">' + usd(s.priceUsd, 8) +
    ' <span class="badge badge-' + s.mode.toLowerCase() + '">' + s.mode + "</span></div>";

  html += '<div class="grid">';
  html += renderSlot(s.slotA, s.tokenSymbol);
  html += renderSlot(s.slotB, s.tokenSymbol);
  if (s.slotC) html += renderSlot(s.slotC, s.tokenSymbol);
  html += "</div>";

  html += '<div class="summary">';
  html += row("Realized PnL", '<span class="' + signClass(s.realizedPnlUsd) + '">' + usd(s.realizedPnlUsd, 2) + "</span>");
  html += row("W rynku teraz", usd(s.investedUsd, 2) + (s.investedPercentOfEquity !== undefined ? " (" + s.investedPercentOfEquity.toFixed(1) + "% portfela)" : ""));
  html += row("SOL balance", s.solBalance.toFixed(6));
  html += row(esc(s.tokenSymbol) + " balance", s.tokenBalance.toLocaleString("en-US"));
  if (s.paperUsdBalance !== undefined) html += row("Paper equity", usd(s.paperUsdBalance, 2));
  html += row("Spread puli", (s.spreadPercent !== undefined ? s.spreadPercent.toFixed(2) + "%" : "-") + " (max " + s.maxSpreadPercent + "%)");
  html += "</div>";

  if (s.recentTrades && s.recentTrades.length > 0) {
    html += "<h3>Ostatnie transakcje</h3><table class=\\"trades\\"><tbody>";
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
    html += '<h3>Ostatni błąd</h3><div class="warn">' + esc(s.lastErrorMessage) + "</div>";
  }

  document.getElementById("app").innerHTML = html;
}

function showToast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.borderColor = isError ? "var(--red)" : "var(--border)";
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3500);
}

async function sendCommand(line, successMsg) {
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(successMsg || ("wysłano: " + line), false);
      tick();
    } else {
      showToast("błąd: " + (data.error || "nieznany"), true);
    }
  } catch (err) {
    showToast("błąd połączenia: " + err.message, true);
  }
}

let failures = 0;
async function tick() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const state = await res.json();
    failures = 0;
    document.getElementById("dot").classList.remove("stale");
    document.getElementById("connLabel").textContent = "połączono";
    render(state);
  } catch (err) {
    failures++;
    document.getElementById("dot").classList.add("stale");
    document.getElementById("connLabel").textContent = "brak połączenia";
    if (failures === 3) {
      document.getElementById("app").innerHTML = '<p class="muted">Nie mogę połączyć się z botem - upewnij się, że nadal działa.</p>';
    }
  }
}
tick();
setInterval(tick, 1000);
</script>
</body>
</html>
`;
