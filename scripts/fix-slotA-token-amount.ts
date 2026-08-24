// Jednorazowa korekta driftu ledgera w data/state.json.
//
// Przyczyna: przed poprawką w src/trader.ts, executeLeg() po każdym live
// swapie zapisywał tokenAmount wyliczony z quote.outAmount (szacunku
// sprzed transakcji), a nie z faktycznie otrzymanej ilości po
// potwierdzeniu na chainie. Jupiter dopuszcza wykonanie przy gorszym
// kursie niż w quocie (w granicach MAX_SLIPPAGE_BPS), więc realnie
// dostajesz zwykle nieco mniej. Po kilku flipach ten błąd się skumulował:
// slot A ma zapisane więcej CYBERLEEK, niż faktycznie jest w portfelu, więc
// każda próba sprzedaży failuje w symulacji z "insufficient funds" (0x1788)
// - bot próbuje przesunąć więcej tokenów, niż fizycznie posiada.
//
// Ten skrypt koryguje tylko slotA.tokenAmount do realnego salda on-chain
// (odczytanego wcześniej przez RPC getTokenAccountsByOwner). Nowy kod w
// trader.ts zapobiega ponownemu powstaniu tego driftu - reconciluje
// tokenAmount/paperSolBalance z rzeczywistym wynikiem transakcji po
// każdym kolejnym fillu.
//
// Użycie:  npx tsx scripts/fix-slotA-token-amount.ts

import fs from "node:fs";
import path from "node:path";

const STATE_PATH = path.resolve(process.cwd(), "data", "state.json");
const REAL_ON_CHAIN_BALANCE = 177.209114811;

const raw = fs.readFileSync(STATE_PATH, "utf8");
const state = JSON.parse(raw);

const before = state.slotA?.tokenAmount;
if (before === undefined) {
  throw new Error("state.slotA.tokenAmount not found - nothing to fix.");
}

console.log(`slotA.tokenAmount: ${before} -> ${REAL_ON_CHAIN_BALANCE}`);
state.slotA.tokenAmount = REAL_ON_CHAIN_BALANCE;

fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log("data/state.json updated.");
