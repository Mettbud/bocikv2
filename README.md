# bocik-flip-bot

Dużo prostsza wersja bota niż `botrade`. Jedna strategia, zrobiona porządnie:

> Kupujemy taniej, sprzedajemy drożej. Gdy cena spadnie z powrotem poniżej
> ceny, po jakiej sprzedaliśmy - kupujemy znowu i czekamy, aż wzrośnie.

Bot **nie** sprzedaje tylko dlatego, że cena wzrosła o zadeklarowany procent -
najpierw sprawdza na żywo, ile naprawdę kosztuje ta konkretna runda
kupno+sprzedaż (spread/impact + opłaty sieciowe), i sprzedaje tylko wtedy, gdy
po odjęciu tych kosztów zostaje realny zysk.

## Dlaczego to jest sedno sprawy: koszt rundy (SPREAD/"podatek")

Każda para transakcji (kupno + sprzedaż) płaci za siebie **dwa razy**, zanim
zobaczymy jakikolwiek zysk:

1. **Spread / opłata puli (AMM)** - różnica między ceną "idealną" a tym, co
   faktycznie dostajemy. Jupiter zwraca to jako `priceImpactPct` w każdej
   wycenie (`quote`) - to już zawiera opłatę swapu puli (np. ~0.25% na
   Raydium) plus wpływ wielkości naszego zlecenia na cenę. Płacimy to **na
   obu nogach** - i przy kupnie, i przy sprzedaży, bo to dwa osobne swapy.
2. **Opłaty sieciowe Solany** (priority fee + opłata za podpis) - stała
   kwota w lamportach, niezależna od wielkości transakcji. Im mniejsza
   transakcja, tym większy % zjadają.

Bot liczy to na żywo przed każdą decyzją (`src/costModel.ts`), pobierając
prawdziwe wyceny z Jupitera - nie zgaduje z góry ustalonej liczby.

### Ile procent zysku na transakcję potrzeba, żeby się opłacało?

Dla typowej konfiguracji testowej (transakcja $50, mało płynny token na
Raydium, SOL ~$150-200):

| Składnik kosztu               | Typowo         | Gorszy przypadek |
|--------------------------------|----------------|-------------------|
| Impact/spread - noga kupna     | ~0.3-0.8%      | do 1.5% (limit)   |
| Impact/spread - noga sprzedaży | ~0.3-0.8%      | do 1.5% (limit)   |
| Opłaty sieciowe (2 transakcje) | ~1.0-1.5%      | ~1.5-2%           |
| **Razem, koszt rundy**         | **~2-3%**      | **~4-5%**         |

Wniosek: **cel zysku brutto poniżej ~4-5% praktycznie nigdy się nie opłaca**
na transakcjach tej wielkości - koszty zjadają cały zysk albo go przewyższają.
Dlatego domyślne ustawienia to:

- `TARGET_GAIN_PERCENT=6` - próg, od którego w ogóle rozważamy sprzedaż,
- `MIN_NET_PROFIT_PERCENT=2` - ile ma zostać **po** odjęciu realnych kosztów,
- `MAX_ROUND_TRIP_COST_PERCENT=4` - jeśli koszty akurat wystrzelą powyżej tego
  (słaba płynność, szeroki spread), bot w ogóle nie wchodzi w pozycję.

Im większa transakcja (`TRADE_USD`), tym mniejszy % zjadają opłaty sieciowe -
przy $200+ nawet 3-4% celu brutto już ma sens. Przy $20-30 lepiej trzymać się
6%+, bo stałe opłaty sieciowe to relatywnie duży kawałek.

Te liczby to punkt startowy, nie wyrocznia - realny spread zależy od
płynności konkretnej puli w danym momencie, dlatego bot i tak liczy to na
żywo, a nie tylko ufa ustawieniom w `.env`.

## Jak działa strategia (`src/strategy.ts`)

Jeden stan na raz, bez uśredniania pozycji, bez kaskadowych częściowych
wyjść:

- **AWAITING_BUY** - czekamy na sygnał kupna:
  - pierwszy cykl: kupujemy od razu (ustalamy punkt wejścia),
  - kolejne cykle: kupujemy dopiero gdy cena spadnie do (lub poniżej) ceny
    ostatniej sprzedaży (`REBUY_DROP_PERCENT` dodaje dodatkowy margines).
- Zanim bot faktycznie kupi, sprawdza **żywy koszt rundy** - jeśli jest za
  wysoki (`MAX_ROUND_TRIP_COST_PERCENT`), pomija ten tick i czeka dalej.
- **AWAITING_SELL** - czekamy, aż cena osiągnie `buyPrice * (1 +
  TARGET_GAIN_PERCENT%)`. Wtedy bot pobiera świeżą wycenę sprzedaży,
  liczy realny koszt rundy (noga kupna zapisana przy wejściu + noga
  sprzedaży na żywo) i sprzedaje tylko jeśli zostanie co najmniej
  `MIN_NET_PROFIT_PERCENT` netto. Jeśli nie - trzyma dalej i sprawdza
  ponownie przy następnym ticku.
- **STOP_LOSS_PERCENT** - niezależna siatka bezpieczeństwa (nie część
  strategii "kup nisko/sprzedaj wysoko"), która wymusza wyjście, gdyby cena
  poszła mocno w dół i "sprzedaj wysoko" nigdy by nie nadeszło. Ustaw na 0,
  żeby wyłączyć.

## Dashboard i komendy

Zamiast przewijanych logów, `npm run bot` odświeża w terminalu jeden ekran
stanu (co `DASHBOARD_REFRESH_MS`, domyślnie 1s): aktualną cenę, pozycję (jeśli
otwarta) z live PnL i tym, ile zostałoby netto gdyby sprzedać teraz, cel
sprzedaży, próg odkupu, zrealizowany PnL, salda i aktualny szacowany koszt
rundy. Pełny log zdarzeń nadal leci do `data/bot.log`.

W tym samym terminalu działają komendy (wpisz i Enter):

```
buy <usd>       - kup ręcznie za tyle USD (pomija sygnał strategii, ale nie limity bezpieczeństwa)
sell [percent]  - sprzedaj tyle % pozycji (domyślnie 100%), pomija wymóg minimalnego zysku netto
panic           - natychmiastowe wyjście z całej pozycji
reset           - (tylko paper) zeruje saldo i pozycję do stanu startowego
status          - wymusza odświeżenie (dashboard i tak odświeża się sam)
quit / exit     - zamyka bota, zapisując stan
```

## Struktura kodu

```
src/
  config.ts     - wczytywanie .env (celowo mało zmiennych)
  strategy.ts    - czysty automat stanów (BUY/SELL), w pełni testowalny
  costModel.ts   - liczenie kosztu rundy i zysku netto
  jupiter.ts     - klienta Jupiter (quote + swap)
  chain.ts       - RPC Solany: decimals, salda, cena SOL/USD
  trader.ts      - wykonanie nogi (paper: symulacja z prawdziwej wyceny;
                    live: podpisanie i wysłanie transakcji)
  ledger.ts      - trwały stan (data/state.json) + log transakcji (data/trades.csv)
  wallet.ts       - wczytanie klucza portfela (tylko tryb live)
  cli/
    format.ts     - kolory/formatowanie liczb w terminalu
    dashboard.ts  - czyste renderowanie ekranu stanu (testowalne bez I/O)
    commands.ts   - komendy z stdin: buy/sell/panic/reset/status/quit
  index.ts        - pętla główna: strategia + dashboard + komendy
tests/
  strategy.test.ts, costModel.test.ts, dashboard.test.ts - testy jednostkowe
```

## Uruchomienie

```bash
npm install
cp .env.example .env      # uzupełnij WALLET_PRIVATE_KEY/JUPITER_API_KEY tylko dla trybu live
npm run typecheck
npm test
npm run bot                # domyślnie TRADING_MODE=paper
```

Tryb `paper` symuluje wypełnienia na podstawie prawdziwych wycen z Jupitera
(łącznie z realnym price impact), więc liczby w `data/trades.csv` są
wiarygodnym oszacowaniem tego, co dałaby prawdziwa transakcja - bez ryzykowania
środków.

### Przejście na handel live

1. Ustaw `TRADING_MODE=live`.
2. Utwórz **dedykowany** hot-wallet (nigdy głównego portfela) i wklej jego
   klucz prywatny (base58 albo tablica JSON z `solana-keygen`) do
   `WALLET_PRIVATE_KEY`.
3. Zasil portfel odpowiednią ilością SOL - `TRADE_USD` na kupno plus
   `MIN_SOL_RESERVE` jako bufor na opłaty sieciowe (bot nigdy nie zejdzie
   poniżej tego minimum).
4. Zacznij od małego `TRADE_USD` i obserwuj `data/bot.log` oraz
   `data/trades.csv` przez kilka pełnych cykli, zanim zwiększysz stawkę.

## Świadome uproszczenia względem `botrade`

Ten bot **nie** ma: kaskadowego take-profit, blokady zysku (profit lock),
trailing stopa, auto-buy na dołkach, wykrywania crashu, wielu poziomów
take-profit, watchera on-chain puli. To były realne funkcje w `botrade`, ale
dokładnie ta rozbudowa jest tym, co miało zniknąć - jedna strategia, jeden
plik do przeczytania w pięć minut, mniej rzeczy które mogą się rozjechać.
