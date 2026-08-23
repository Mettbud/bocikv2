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
stałe opłaty sieciowe to relatywnie duży kawałek. Każdy slot ma **stałą**
kwotę: `SLOT_A_SIZE_PERCENT`/`SLOT_B_SIZE_PERCENT` (domyślnie 30%+30%)
salda **startowego**, nie aktualnego - więc wielkość pojedynczej transakcji
się nie zmienia, nawet jak konto urośnie albo skurczy się od PnL.

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
  - pierwszy cykl: kupujemy od razu (ustalamy punkt wejścia) - chyba że
    `SLOT_A_REQUIRE_MANUAL_FIRST_BUY=true` (domyślnie), wtedy to *pierwsze
    w historii* wejście Slotu A czeka na ręczną komendę `buy` w konsoli;
    każdy kolejny odkup po zamknięciu tej pozycji znowu jest w pełni
    automatyczny, bez wyjątków,
  - kolejne cykle: kupujemy dopiero gdy cena spadnie do (lub poniżej) ceny
    ostatniej sprzedaży (`REBUY_DROP_PERCENT` dodaje dodatkowy margines).
    Jeśli cena po sprzedaży tylko rośnie i nigdy nie wraca do tego poziomu -
    bot świadomie nie kupuje, dopóki nie wróci; to jest cena bezpieczeństwa
    "nigdy nie kupuj drożej niż ostatnio sprzedałeś", nie błąd. Opcjonalny
    wyjątek: `BREAKOUT_BUY_ENABLED=true` (domyślnie **wyłączone**) dodaje
    drugi, niezależny sposób na kupno - śledzi szczyt ruchu w górę powyżej
    ostatniej sprzedaży i kupuje na potwierdzonym cofnięciu od niego
    (`BREAKOUT_BUY_MULTIPLIER` × typowy ruch, z limitami MIN/MAX, plus
    `BREAKOUT_BUY_CONFIRMATION_MS` - identyczny mechanizm co trailing stop,
    tylko dla kupna zamiast sprzedaży). To realna zmiana strategii
    (kupowanie w siłę rynku, nie tylko w dołki) - patrz sekcja "Porównanie
    dwóch konfiguracji" niżej, żeby przetestować to bezpiecznie obok
    głównej konfiguracji, zamiast włączać od razu na produkcji.
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

### Trailing stop: zamek na zysk, gdy rynek się nie decyduje

Na rynku bocznym (cena kręci się np. między -3% a +3%, nigdy nie dobija do
celu 6-7%) pozycja może teoretycznie czekać w nieskończoność. Trailing stop
to na to lekarstwo - zamiast czekać wyłącznie na pełny cel, sprzedaje
wcześniej, gdy widzi że zysk, który już był, zaczyna znikać.

Działanie w dwóch krokach (domyślnie `TRAILING_STOP_ARM_PERCENT=4`,
`TRAILING_STOP_PERCENT=2`):

1. **Uzbrojenie** - dopiero gdy najwyższa cena od zakupu osiągnie +4% zysku.
   Pozycja, która nigdy nie doszła nawet do +4%, nie ma jeszcze realnego
   zysku do obrony, więc nic się nie dzieje.
2. **Wyzwolenie** - od tego momentu bot śledzi szczyt. Jeśli cena spadnie o
   2% od tego szczytu, sprzedaje **z tym, co akurat jest** - nie na
   szczycie (nie zgadujemy górki), tylko przy pierwszym potwierdzonym
   cofnięciu.

Przykład liczbowy: kupno przy $1.00, cel 6% ($1.06). Cena rośnie do $1.05
(+5%, szczyt) - trailing stop się uzbraja (bo +5% > próg 4%). Cena spada do
$1.029 (2% poniżej szczytu $1.05) - **sprzedaż teraz**, z zyskiem ok. +2.9%
zamiast czekać (może bez końca) na pełne +6%.

Sprzedaje się **cała pozycja na raz** (100%, tak jak przy zwykłym trafieniu
celu) - i tak samo jak normalne trafienie celu, ta sprzedaż nadal musi
przejść przez `MIN_NET_PROFIT_PERCENT` liczone na żywo. Jeśli akurat po
kosztach netto by nie wyszło - bot czeka i sprawdza ponownie przy
następnym ticku, zamiast wymuszać sprzedaż na stracie.

Dashboard pokazuje status: `Trailing stop: UZBROJONY, szczyt $X, sprzeda
poniżej $Y` albo `nieuzbrojony (szczyt $X, jeszcze za mało zysku)`. Wyłącz
`TRAILING_STOP_ENABLED=false`, żeby wrócić do czekania wyłącznie na pełny cel.

**Uwaga na "szczyt":** to cena z jednego, pojedynczego ticku (co
`PRICE_POLL_INTERVAL_MS`, domyślnie 5s) - chwilowy spike/knot ustawia
szczyt tak samo jak prawdziwy ruch. Żeby pojedynczy szum nie wywoływał
przedwczesnej sprzedaży, `TRAILING_STOP_CONFIRMATION_MS` (domyślnie 4000)
wymaga, żeby cofnięcie od szczytu utrzymało się **nieprzerwanie** przez
tyle milisekund (kilka ticków z rzędu), zanim bot faktycznie sprzeda -
dokładnie ten sam mechanizm co `STOP_CONFIRMATION_MS` w oryginalnym
`botrade`. Ustaw na `0`, żeby sprzedawać natychmiast przy pierwszym ticku
spełniającym warunek.

## Dwa sloty: Slot A + Slot B jako "dobicie"

Bot prowadzi **dwie niezależne pozycje jednocześnie**, każda po
`SLOT_A_SIZE_PERCENT`/`SLOT_B_SIZE_PERCENT` (domyślnie 30%+30%) - policzone
**od salda startowego**, nie od aktualnego (patrz sekcja o wielkości
transakcji wyżej). Przy $1000 na start to $300 do Slotu A i $300 do Slotu
B, zawsze, niezależnie od tego jak zmienia się saldo w trakcie handlu:

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
i blok Slotu B - każdy z pozycją (jeśli otwarta), live PnL **w procentach i
w dolarach**, tym ile zostałoby netto gdyby sprzedać teraz, celem sprzedaży,
statusem trailing stopu - plus zrealizowany PnL (oba sloty razem), ile jest
aktualnie "w rynku", salda i spread puli. Na dole ekranu widać też
**ostatnie kilka transakcji** (obu slotów, najnowsza na górze) - nie trzeba
zaglądać do `data/trades.csv`, żeby zobaczyć co się działo w ostatniej
godzinie. Pełny log zdarzeń nadal leci do `data/bot.log`, a kompletna
historia zawsze jest w `data/trades.csv`.

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
  sizing.ts       - wielkość automatycznego kupna jako stały % salda startowego
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

### Porównanie dwóch konfiguracji obok siebie (A/B)

Żeby przetestować dwa różne ustawienia równolegle (np. `.env` = wersja
bezpieczna, `.env.b` z `BREAKOUT_BUY_ENABLED=true` żeby zobaczyć czy
kupowanie na wybiciach faktycznie się opłaca) - **nie trzeba kopiować
całego kodu**. Ten sam bot, dwa pliki `.env`, dwa terminale:

```bash
cp .env .env.b
```

W `.env.b` zmień to, co chcesz porównać, oraz koniecznie te trzy ścieżki
(żeby obie instancje nie nadpisywały sobie danych):

```
STATE_FILE=./data/state-b.json
TRADES_CSV=./data/trades-b.csv
LOG_FILE=./data/bot-b.log
```

Odpal obie (dwa terminale/dwa okna):

```bash
npm run bot                                    # wersja A, .env
DOTENV_CONFIG_PATH=.env.b npm run bot          # wersja B, .env.b (Linux/Mac)
```

Na Windows (PowerShell) ustaw zmienną osobno:

```powershell
$env:DOTENV_CONFIG_PATH=".env.b"; npm run bot
```

Po kilku godzinach porównaj `data/trades.csv` i `data/trades-b.csv` -
liczba flipów, zrealizowany PnL, ile razy trailing stop faktycznie
zadziałał vs. ile razy był to fałszywy alarm odfiltrowany przez
potwierdzenie.

## Świadome uproszczenia względem `botrade`

Ten bot **nie** ma: kaskadowego take-profit, blokady zysku (profit lock),
trailing stopa, auto-buy na dołkach, wykrywania crashu, wielu poziomów
take-profit, watchera on-chain puli. To były realne funkcje w `botrade`, ale
dokładnie ta rozbudowa jest tym, co miało zniknąć - jedna strategia, jeden
plik do przeczytania w pięć minut, mniej rzeczy które mogą się rozjechać.
