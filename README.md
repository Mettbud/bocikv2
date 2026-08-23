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
stałe opłaty sieciowe to relatywnie duży kawałek. Żaden slot nie ma stałej
kwoty w dolarach - to `SLOT_A_SIZE_PERCENT`/`SLOT_B_SIZE_PERCENT` (domyślnie
30%+30%) aktualnego salda ponad `MIN_SOL_RESERVE`, więc wielkość transakcji
rośnie/maleje razem z kontem w miarę zysków/strat.

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
- **AWAITING_SELL** - czekamy, aż cena osiągnie `buyPrice * (1 + cel%)`
  (patrz niżej, skąd bierze się "cel"). Wtedy bot pobiera świeżą wycenę
  sprzedaży, liczy realny koszt rundy (noga kupna zapisana przy wejściu +
  noga sprzedaży na żywo) i sprzedaje tylko jeśli zostanie co najmniej
  `MIN_NET_PROFIT_PERCENT` netto. Jeśli nie - trzyma dalej i sprawdza
  ponownie przy następnym ticku.
- **STOP_LOSS_PERCENT** - niezależna siatka bezpieczeństwa (nie część
  strategii "kup nisko/sprzedaj wysoko"), która wymusza wyjście, gdyby cena
  poszła mocno w dół i "sprzedaj wysoko" nigdy by nie nadeszło. Ustaw na 0,
  żeby wyłączyć.

### Adaptacyjny cel: bot sam dostosowuje % do tego, jak rynek się zachowuje

Domyślnie (`ADAPTIVE_TARGET_ENABLED=true`) cel sprzedaży **nie jest** sztywnym
`TARGET_GAIN_PERCENT` z `.env` - bot trzyma w pamięci ostatnie
`VOLATILITY_LOOKBACK_MS` (domyślnie 5 min) cen (dokładnie to, co mierzy
`npm run analyze`, tylko ciągle, na żywo) i przy **każdym nowym kupnie**
liczy:

```
cel = typowy ostatni ruch (mediana z 5 min) × ADAPTIVE_TARGET_MULTIPLIER
      przycięty do [ADAPTIVE_TARGET_MIN_PERCENT, ADAPTIVE_TARGET_MAX_PERCENT]
```

Spokojny token dostaje mniejszy, szybszy do osiągnięcia cel; token, który
akurat oszalał, dostaje większy - żeby nie sprzedawać w zwykły szum. Cel
**zamraża się w momencie zakupu** i nie zmienia się, dopóki pozycja jest
otwarta (inaczej gonilibyśmy przesuwającą się linię mety) - dopiero
następne kupno liczy własny, świeży cel.

Dwa niezależne bezpieczniki działają zawsze, bez względu na to co policzy
adaptacyjny cel:
- `ADAPTIVE_TARGET_MIN_PERCENT`/`MAX_PERCENT` - twardy dół/góra na sam cel,
- `MIN_NET_PROFIT_PERCENT`/`MAX_ROUND_TRIP_COST_PERCENT`/`MAX_SPREAD_BPS` -
  realny koszt liczony na żywo przy każdej faktycznej transakcji, całkiem
  niezależnie od tego, jaki cel akurat obowiązuje.

Dashboard pokazuje na bieżąco, jaki cel obowiązuje otwartą pozycję
(`Sell target: ... cel +X%, ustalony przy zakupie`), a przy braku pozycji -
jaki cel policzyłby następny zakup już teraz (`Next target: adaptive,
aktualnie liczyłby +X%`). Wyłącz `ADAPTIVE_TARGET_ENABLED=false`, żeby
wrócić do sztywnego `TARGET_GAIN_PERCENT`.

## Dwa sloty: Slot A + Slot B jako "dobicie"

Bot prowadzi **dwie niezależne pozycje jednocześnie**, każda po
`SLOT_A_SIZE_PERCENT`/`SLOT_B_SIZE_PERCENT` portfela (domyślnie 30%+30%):

- **Slot A** działa dokładnie jak opisano wyżej - samodzielnie kupuje,
  sprzedaje, odkupuje na spadku. Główna, "zwykła" pozycja.
- **Slot B** NIGDY nie kupuje z własnej inicjatywy. Kupuje wyłącznie jako
  "dobicie", gdy **Slot A jest akurat otwarty i na stracie** większej niż
  adaptacyjnie wyliczony próg:

  ```
  próg = typowy ostatni ruch (mediana z VOLATILITY_LOOKBACK_MS) × DUAL_TRIGGER_MULTIPLIER
         przycięty do [DUAL_TRIGGER_MIN_PERCENT, DUAL_TRIGGER_MAX_PERCENT]
  ```

  Ta sama matematyka co adaptacyjny cel sprzedaży, tylko osobne mnożnik/
  limity. Po zakupie Slot B ma **własny, niezależny cel sprzedaży**
  (liczony tak samo jak dla Slotu A) i sprzedaje samodzielnie, gdy go
  osiągnie - nie czeka na Slot A. Po sprzedaży wraca do obserwowania Slotu
  A i czeka na kolejną okazję do dobicia.

Domyślnie `DUAL_TRIGGER_MAX_PERCENT=20` jest **poniżej**
`STOP_LOSS_PERCENT=25` - to celowe: Slot B ma szansę zareagować, zanim
Slot A dostanie stop-lossa. Ustaw `DUAL_SLOT_ENABLED=false`, żeby Slot B
nigdy nie kupował - bot zachowuje się wtedy jak wersja jednosolotowa.

Dashboard pokazuje oba sloty osobno, a Slot B dodatkowo linię w stylu
`Czeka aż Slot A będzie na -8.00% (teraz: -5.20%)`, gdy Slot A jest otwarty
ale jeszcze nie na tyle nisko.

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
stanu (co `DASHBOARD_REFRESH_MS`, domyślnie 1s): aktualną cenę, blok Slotu A
i blok Slotu B - każdy z pozycją (jeśli otwarta), live PnL, tym ile zostałoby
netto gdyby sprzedać teraz, celem sprzedaży - plus zrealizowany PnL (oba
sloty razem), salda i spread puli. Pełny log zdarzeń nadal leci do
`data/bot.log`.

W tym samym terminalu działają komendy (wpisz i Enter). Domyślny slot to
`a`, gdy pominięty:

```
buy <usd> [a|b]       - kup ręcznie za tyle USD w danym slocie (pomija sygnał strategii, ale nie limity bezpieczeństwa)
sell [percent] [a|b]  - sprzedaj tyle % pozycji w danym slocie (domyślnie 100%), pomija wymóg minimalnego zysku netto
panic [a|b]           - natychmiastowe wyjście z pozycji; bez argumentu wychodzi z OBU slotów
reset                 - (tylko paper) zeruje saldo i oba sloty do stanu startowego
status                - wymusza odświeżenie (dashboard i tak odświeża się sam)
quit / exit           - zamyka bota, zapisując stan
```

Przykłady: `buy 50 b` (kup za $50 w Slocie B), `sell 50` (sprzedaj 50%
Slotu A), `sell b` (sprzedaj całość Slotu B), `panic` (wyjdź ze wszystkiego).

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
  volatility.ts   - zmienność/adaptacyjny cel, współdzielone z scripts/analyzeVolatility.ts
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
  volatility.test.ts, dexscreener.test.ts - testy jednostkowe
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
3. Zasil portfel odpowiednią ilością SOL - w najgorszym razie oba sloty
   otwarte naraz to `SLOT_A_SIZE_PERCENT + SLOT_B_SIZE_PERCENT`% salda
   ponad `MIN_SOL_RESERVE` (bufor na opłaty sieciowe, nigdy nie zejdzie
   poniżej tego minimum).
4. Zacznij od małych `SLOT_A_SIZE_PERCENT`/`SLOT_B_SIZE_PERCENT` (np. 10%)
   i obserwuj `data/bot.log` oraz `data/trades.csv` przez kilka pełnych
   cykli, zanim zwiększysz stawkę. Rozważ też start z `DUAL_SLOT_ENABLED=false`,
   żeby najpierw zobaczyć jak radzi sobie sam Slot A.

## Świadome uproszczenia względem `botrade`

Ten bot **nie** ma: kaskadowego take-profit, blokady zysku (profit lock),
trailing stopa, auto-buy na dołkach, wykrywania crashu, wielu poziomów
take-profit, watchera on-chain puli. To były realne funkcje w `botrade`, ale
dokładnie ta rozbudowa jest tym, co miało zniknąć - jedna strategia, jeden
plik do przeczytania w pięć minut, mniej rzeczy które mogą się rozjechać.
