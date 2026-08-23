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

Im większa transakcja, tym mniejszy % zjadają opłaty sieciowe - przy $200+
nawet 3-4% celu brutto już ma sens. Przy $20-30 lepiej trzymać się 6%+, bo
stałe opłaty sieciowe to relatywnie duży kawałek. Automatyczne kupno nie ma
stałej kwoty w dolarach - to `TRADE_SIZE_PERCENT` (domyślnie 50%) aktualnego
salda ponad `MIN_SOL_RESERVE`, więc wielkość transakcji rośnie/maleje razem z
kontem w miarę zysków/strat.

Te liczby to punkt startowy, nie wyrocznia - realny spread zależy od
płynności konkretnej puli w danym momencie, dlatego bot i tak liczy to na
żywo, a nie tylko ufa ustawieniom w `.env`.

### Osobny bezpiecznik: `MAX_SPREAD_BPS`

Powyższe koszty (`buy impact`/`sell impact`) liczone są **dla wielkości
naszej transakcji** - im większe zlecenie, tym większy wpływ na cenę.
`MAX_SPREAD_BPS` to co innego: bot bierze małą, stałą kwotę referencyjną
(`PRICE_REFERENCE_SOL_AMOUNT`, domyślnie 0.01 SOL) i sprawdza, ile z niej
wraca po odbiciu tam i z powrotem - to bazowy spread samej puli, **niezależny
od wielkości naszego zlecenia**. Jeśli akurat jest szeroki (płynność się
wyparowała, ktoś robi dziwną świecę), bot w ogóle nie handluje, nawet gdyby
próg zysku był spełniony - to sygnał "ta pula teraz nie nadaje się do
handlu", nie tylko "ta transakcja jest za droga". Domyślnie `MAX_SPREAD_BPS=100`
(1%); dashboard pokazuje to na żywo w linii `Spread: X% (max Y%)`.

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

## Analiza rynku: ile CYBERLEEK faktycznie się rusza

Zanim ustawisz `TARGET_GAIN_PERCENT` na wyczucie, zmierz to:

```bash
npm run analyze                          # zbiera 15 minut próbek
ANALYZE_DURATION_MINUTES=60 npm run analyze   # dłuższa, dokładniejsza próbka
```

Skrypt (`scripts/analyzeVolatility.ts`) najpierw pokazuje **historię** -
Jupiter nie ma endpointu z przeszłością (umie odpowiedzieć tylko "jaka jest
cena teraz"), więc na start pyta darmowe API DexScreener o zmianę ceny z
ostatnich 5 min / 1h / 6h / 24h, wolumen i płynność puli - to jedyny sposób,
żeby zobaczyć coś sprzed uruchomienia skryptu, bez czekania.

Potem przechodzi do pomiaru **na żywo**: pyta o **prawdziwą cenę CYBERLEEK z
Jupitera** co `PRICE_POLL_INTERVAL_MS` (dokładnie tak samo jak robi to bot
podczas handlu) przez `ANALYZE_DURATION_MINUTES` (domyślnie 15 min - kończy
się samo, albo przerwij Ctrl+C w dowolnym momencie i tak zobaczysz raport z
tego, co zdążyło się zebrać). Po zebraniu próbek pokazuje:

- ile realnie porusza się cena w oknach 5s/15s/30s/1min/5min (średnia,
  mediana, max w górę, max w dół),
- zmierzoną zmienność i - na jej podstawie (model losowego błądzenia) -
  orientacyjny czas oczekiwania na ruch +2%, +3%, +4%, +6%, +8%, +10%,
- zestawienie z aktualnym `TARGET_GAIN_PERCENT`, żeby było widać, czy cel
  jest w ogóle realistyczny dla tego, jak ten konkretny token się zachowuje.

To jest szacunek (memecoiny ruszają się "skokowo", nie jak czysty random
walk), ale dużo lepszy punkt startowy niż zgadywanie.

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
  sizing.ts       - wielkość automatycznego kupna jako % salda
  dexscreener.ts  - historyczna zmiana ceny (5m/1h/6h/24h) dla scripts/analyzeVolatility.ts
  cli/
    format.ts     - kolory/formatowanie liczb w terminalu
    dashboard.ts  - czyste renderowanie ekranu stanu (testowalne bez I/O)
    commands.ts   - komendy z stdin: buy/sell/panic/reset/status/quit
  index.ts        - pętla główna: strategia + dashboard + komendy
scripts/
  analyzeVolatility.ts - narzędzie do pomiaru realnej zmienności tokena
tests/
  strategy.test.ts, costModel.test.ts, dashboard.test.ts, sizing.test.ts,
  analyzeVolatility.test.ts - testy jednostkowe
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
3. Zasil portfel odpowiednią ilością SOL - bot wyda `TRADE_SIZE_PERCENT`%
   salda ponad `MIN_SOL_RESERVE` (bufor na opłaty sieciowe, nigdy nie zejdzie
   poniżej tego minimum).
4. Zacznij od małego `TRADE_SIZE_PERCENT` (np. 10-20%) i obserwuj `data/bot.log` oraz
   `data/trades.csv` przez kilka pełnych cykli, zanim zwiększysz stawkę.

## Świadome uproszczenia względem `botrade`

Ten bot **nie** ma: kaskadowego take-profit, blokady zysku (profit lock),
trailing stopa, auto-buy na dołkach, wykrywania crashu, wielu poziomów
take-profit, watchera on-chain puli. To były realne funkcje w `botrade`, ale
dokładnie ta rozbudowa jest tym, co miało zniknąć - jedna strategia, jeden
plik do przeczytania w pięć minut, mniej rzeczy które mogą się rozjechać.
