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

**`AUTO_BUY_ENABLED=false`** (domyślnie **włączone**, bez zmiany
zachowania) to główny wyłącznik automatycznych kupna - gdy false, żaden
slot nigdy nie kupuje sam z siebie (bez auto-odkupu Slotu A, bez dobicia
Slotu B/C, bez breakout buy), tylko ręczne `buy`/`buy ... @cena` w konsoli.
Sprzedaż zostaje zawsze w pełni automatyczna - cel, stop-loss i trailing
stop nadal zarządzają każdą już otwartą pozycją bez zmian. Przydatne, gdy
chcesz pełną ręczną kontrolę nad tym, kiedy i po ile bot wchodzi w rynek,
ale nie chcesz pilnować wyjścia ręcznie.

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

**Zaraz po starcie (świeży restart)** bot jeszcze nie ma własnej, żywej
historii cen - Jupiter nie ma endpointu historycznego, więc bufor zawsze
zaczyna się pusty. Zamiast liczyć wtedy cel/próg na sztywnym
`TARGET_GAIN_PERCENT` (ta sama liczba po każdym restarcie, każdego
portfela, bez związku z tym co token akurat robi - stąd np. zawsze "6%" na
starcie mimo trzech różnych instancji), bot **raz, na starcie, pyta
DexScreener** o realną zmianę ceny z ostatnich 5 minut i używa jej jako
pierwszego oszacowania zmienności (dokładnie ten sam pomysł co historyczny
snapshot w `npm run analyze`) - dopóki nie zbierze wystarczająco własnej
historii live, po czym płynnie przechodzi na nią. To dotyczy nie tylko
celu sprzedaży, ale też progów Slotu B/C i cofnięcia breakout buy - każdy
z nich korzysta z tego samego, jednorazowego oszacowania. Best-effort: jeśli
zapytanie się nie uda (np. token jeszcze nie zindeksowany), wraca do starego
zachowania (sztywna wartość) bez żadnego błędu.

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
wymaga, żeby cofnięcie od szczytu utrzymało się przez tyle milisekund
(kilka ticków z rzędu), zanim bot faktycznie sprzeda - dokładnie ten sam
mechanizm co `STOP_CONFIRMATION_MS` w oryginalnym `botrade`. Ustaw na `0`,
żeby sprzedawać natychmiast przy pierwszym ticku spełniającym warunek.

Na bardzo zmiennym tokenie wymóg "dokładnie za progiem na **każdym** ticku
bez wyjątku" bywa zbyt sztywny - jeden tick cofający się o ułamek procenta
zerowałby cały licznik od nowa, więc 4 sekundy praktycznie nigdy by nie
minęły. `TRAILING_STOP_CONFIRMATION_TOLERANCE_PERCENT` (domyślnie 0.5)
rozwiązuje to: licznik nie zeruje się, dopóki cena nie odbije więcej niż o
ten % od progu - drobne odbicie w tym paśmie nie przerywa odliczania.
Prawdziwa sprzedaż nadal wymaga przejścia przez **właściwy, nierozluźniony**
próg `TRAILING_STOP_PERCENT` - tolerancja wpływa tylko na to, czy licznik
czasu żyje dalej, nie na to, czy bot faktycznie sprzeda.

**Uzbrojona pozycja, która koczuje w miejscu:** raz uzbrojony trailing stop
czeka na jedno z dwóch: nowy szczyt (dalej podąża w górę) albo realny spadek
`TRAILING_STOP_PERCENT` od szczytu (sprzedaje). Token, który po prostu
chodzi w wąskim paśmie tuż pod szczytem - bez nowych maksimów, ale też bez
spadku wystarczająco głębokiego, żeby odpalić sprzedaż - może tak stać
bardzo długo. Opcjonalne (WYŁĄCZONE domyślnie, `TRAILING_STOP_STAGNATION_MS=0`):
gdy > 0, jeśli szczyt nie zrobił nowego maksimum przez tyle ms, bot
przestaje czekać i sprzedaje po aktualnej cenie - nadal musi przejść przez
`MIN_NET_PROFIT_PERCENT`, więc to tylko realizuje zysk, który już faktycznie
jest, zamiast pozwolić mu bez końca "kręcić się w kółko". Np.
`TRAILING_STOP_STAGNATION_MS=600000` (10 minut).

**Wąskie, boczne pasmo pod wodą - luka, na którą trailing stop nie
pomaga:** trailing stop chroni zysk dopiero gdy pozycja realnie weszła na
plus (`TRAILING_STOP_ARM_PERCENT`). Jeśli cena kilkadziesiąt minut kręci
się w wąskim paśmie, które nigdy nie sięga tego progu (np. cały czas
między -10% a -1% od ceny zakupu), ani cel sprzedaży, ani trailing stop
się nie uzbroją - bot świadomie czeka, bo sprzedanie na lokalnym "szczycie"
tego pasma wciąż byłoby sprzedażą na stracie (złamałoby
`MIN_NET_PROFIT_PERCENT`). To dotyczy obu slotów tak samo, ale Slot B ma
dodatkową furtkę: `SLOT_B_TRAILING_STOP_ARM_PERCENT` /
`SLOT_B_TRAILING_STOP_PERCENT` pozwalają dać **tylko Slotowi B** niższy
próg uzbrojenia niż Slotowi A (domyślnie identyczny - zero zmiany
zachowania, dopóki go nie obniżysz). Ma to sens dla B, bo B i tak kupuje
"w dołku" (podczas drawdownu A) i jego rola to szybkie, drobne flipy - więc
niższy próg pozwala mu złapać nawet niewielkie odbicie w górę zamiast
czekać na duży ruch, którego wąskie pasmo może nigdy nie dać.

## Sloty A + B (+ opcjonalny C) jako "dobicie"

Bot prowadzi **dwie niezależne pozycje jednocześnie**, każda po
`SLOT_A_SIZE_PERCENT`/`SLOT_B_SIZE_PERCENT` (domyślnie 30%+30%) - policzone
**od salda startowego**, nie od aktualnego (patrz sekcja o wielkości
transakcji wyżej). Przy $1000 na start to $300 do Slotu A i $300 do Slotu
B, zawsze, niezależnie od tego jak zmienia się saldo w trakcie handlu -
**także po wpłacie/wypłacie środków na portfel** (świadomie, żeby PnL nie
"dokompoundowywał się" po cichu w wielkość transakcji). Jeśli chcesz, żeby
30%/30%/20% liczyło się od nowego, aktualnego salda po wpłacie - użyj
komendy `rebase` w konsoli (patrz niżej).

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

### Slot C - opcjonalny, jeszcze głębszy poziom dobicia (drabinka DCA)

Wyłączony domyślnie (`SLOT_C_ENABLED=false`). Działa **dokładnie jak Slot
B**, tym samym mechanizmem, tylko z **własnym, głębszym progiem**
(`SLOT_C_TRIGGER_MULTIPLIER`/`MIN`/`MAX_PERCENT`, domyślnie 2× mnożnik i
próg 10-22% zamiast 3-20% jak Slot B) - i **niezależnie od tego, czy Slot B
akurat trzyma pozycję**. Slot B leci na swoim własnym cyklu (kupuje,
sprzedaje, znowu czeka), więc uzależnianie Slotu C od chwilowej fazy Slotu
B zrobiłoby wejścia C nieprzewidywalnymi - Slot C patrzy wyłącznie na to,
jak głęboko pod wodą jest **Slot A**, tak samo jak Slot B.

To jest w praktyce **drabinka DCA** (dokupowanie w miarę spadku): im
głębszy dołek, tym lepsza cena wejścia dla C, dobre na rynku, który
faktycznie odbija się od dna. Ale w realnym trendzie spadkowym każdy
kolejny poziom dokłada kolejną porcję kapitału na kolejnej stracie - w
najgorszym razie Slot A + Slot B + Slot C są otwarte jednocześnie.
Dlatego domyślnie `SLOT_C_SIZE_PERCENT=20` jest mniejszy niż A/B, a
`SLOT_C_TRIGGER_MAX_PERCENT=22` zostaje **poniżej** `STOP_LOSS_PERCENT=25`,
z tego samego powodu co próg Slotu B.

**Nie włączaj tego na głównej konfiguracji bez sprawdzenia najpierw**, czy
ten konkretny token faktycznie zachowuje się jak odbijający się od dna
(dobre dla C) czy jak trend spadkowy (złe dla C) - `npm run analyze` pokaże
realny, zmierzony charakter ruchu ceny. Testuj na trzeciej, osobnej
konfiguracji (`.env.c.example` → `.env.c`, patrz sekcja "Porównanie
konfiguracji" niżej) zamiast włączać od razu na głównym koncie.

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
buy [usd] [a|b|c] [@maxPrice] - kup ręcznie w danym slocie (pomija sygnał strategii, ale nie limity bezpieczeństwa);
                         bez kwoty użyty jest normalny stały rozmiar slotu (SLOT_A/B/C_SIZE_PERCENT); z "@cena" NIE
                         kupuje od razu - czeka (sprawdzane co tick), aż cena spadnie do tej wartości lub niżej
cancel [a|b|c]         - odwołuje oczekujące zlecenie "buy ... @cena" dla danego slotu (domyślnie A); nic nie robi,
                         jeśli nic nie czeka
sell [percent] [a|b|c] - sprzedaj tyle % pozycji w danym slocie (domyślnie 100%), pomija wymóg minimalnego zysku netto
panic [a|b|c]          - natychmiastowe wyjście z pozycji; bez argumentu wychodzi ze WSZYSTKICH slotów
reset                  - (tylko paper) zeruje saldo i WSZYSTKIE sloty do stanu startowego - od zera, łącznie z
                         lastSellPrice i licznikiem flipów, więc jeśli masz SLOT_A_REQUIRE_MANUAL_FIRST_BUY=true,
                         po resecie znowu czeka na ręczny "buy" zamiast odkupować automatycznie
rebase                 - przelicza bazę SLOT_A/B/C_SIZE_PERCENT na aktualną, prawdziwą wartość portfela (patrz
                         niżej) - użyj po wpłacie/wypłacie środków; nie rusza otwartych pozycji ani historii,
                         działa w obu trybach (paper i live)
status                - wymusza odświeżenie (dashboard i tak odświeża się sam)
quit / exit           - zamyka bota, zapisując stan
```

Przykłady: `buy` (kup w Slocie A za normalny % portfela), `buy b` (to samo
w Slocie B), `buy 50 b` (wymuś dokładnie $50 w Slocie B), `buy a @0.025`
(czekaj z normalnym rozmiarem, aż cena Slotu A spadnie do $0.025 lub niżej),
`cancel a` (odwołaj to oczekujące zlecenie), `sell 50`
(sprzedaj 50% Slotu A), `sell b` (sprzedaj całość Slotu B), `panic`
(wyjdź ze wszystkiego).

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

### Porównanie kilku konfiguracji obok siebie (A/B/C)

Żeby przetestować różne ustawienia równolegle (np. `.env` = wersja
bezpieczna, `.env.b` z `BREAKOUT_BUY_ENABLED=true` żeby zobaczyć czy
kupowanie na wybiciach faktycznie się opłaca, `.env.c` z `SLOT_C_ENABLED=true`
żeby przetestować głębszą drabinkę dobicia) - **nie trzeba kopiować całego
kodu**. Ten sam bot, osobny plik `.env.*` na instancję, osobny terminal na
instancję. Gotowe szablony są już w repo:

```bash
cp .env.b.example .env.b   # wersja B: breakout buy włączony
cp .env.c.example .env.c   # wersja C: Slot C (głębsze dobicie) włączony
# uzupełnij WALLET_PRIVATE_KEY / JUPITER_API_KEY w każdym tak samo jak w .env
```

Albo zrób to ręcznie z dowolnego innego punktu startowego:

```bash
cp .env .env.b
```

W nowym pliku zmień to, co chcesz porównać, oraz koniecznie te trzy ścieżki
(żeby instancje nie nadpisywały sobie nawzajem danych) - `.env.b.example` i
`.env.c.example` mają to już ustawione:

```
STATE_FILE=./data/state-b.json
TRADES_CSV=./data/trades-b.csv
LOG_FILE=./data/bot-b.log
```

Odpal tyle instancji, ile chcesz porównać (każda w osobnym terminalu):

```bash
npm run bot                                    # wersja A, .env
DOTENV_CONFIG_PATH=.env.b npm run bot          # wersja B, .env.b (Linux/Mac)
DOTENV_CONFIG_PATH=.env.c npm run bot          # wersja C, .env.c (Linux/Mac)
```

Na Windows (PowerShell) ustaw zmienną osobno, w każdym oknie:

```powershell
$env:DOTENV_CONFIG_PATH=".env.b"; npm run bot
$env:DOTENV_CONFIG_PATH=".env.c"; npm run bot
```

Na Windows jest też skrypt, który odpala wszystkie skonfigurowane wersje
naraz (A, B, i C jeśli `.env.c` istnieje), każdą w osobnym oknie, jedną
komendą:

```powershell
npm run bot:all
```

Dashboard każdej wersji co sekundę czyści i przerysowuje cały ekran, więc
trzy instancje **nie mogą** dzielić jednego okna terminala - `npm run bot:all`
otwiera je jako trzy osobne okna, nie trzy panele w jednym.

Jeśli chcesz wpisywać jedną komendę (np. `panic`) i mieć ją wysłaną do
wszystkich naraz, Windows Terminal ma to wbudowane: przeciągnij zakładki
trzech okien na siebie, żeby stały się panelami jednego okna Windows
Terminal (albo podziel widok ręcznie, `Alt+Shift+D`), potem kliknij w
dowolny panel, `Ctrl+Shift+P` → wpisz "broadcast" → **"Toggle broadcast
input to all panes"**. Od tej chwili to, co wpiszesz, trafia do wszystkich
zaznaczonych paneli jednocześnie, a każdy z nich nadal rysuje swój własny
dashboard bez konfliktu. Wyłączasz tą samą komendą jeszcze raz.

Po kilku godzinach porównaj `data/trades.csv`, `data/trades-b.csv` i
`data/trades-c.csv` - liczba flipów, zrealizowany PnL, ile razy trailing
stop faktycznie zadziałał vs. ile razy był to fałszywy alarm odfiltrowany
przez
potwierdzenie.

## Gdy auto-kupno przestaje się udawać (circuit breaker)

Każda próba kupna jest najpierw **symulowana** przez sieć Solana, zanim
cokolwiek faktycznie się wykona - jeśli symulacja się nie powiedzie
(np. `custom program error`), transakcja **nigdy nie trafia na
blockchain**, więc nic nie jest tracone. Ale jeśli token ma jakąś
nietypową charakterystykę (np. opłatę przy transferze), która systematycznie
nie zgadza się z tym, co zakłada prosta wycena Jupitera, każda kolejna
próba może failować identycznie w kółko.

Po `AUTO_BUY_FAILURE_LIMIT` (domyślnie 3) nieudanych próbach **z rzędu** dla
danego slotu, bot **wstrzymuje automatyczne kupno tego slotu** na
`AUTO_BUY_COOLDOWN_MS` (domyślnie 5 minut), zamiast próbować w kółko co
tick bez końca. Ręczne `buy`/`buy ... @cena` nadal działa normalnie w tym
czasie. Licznik i wstrzymanie resetują się przy pierwszym udanym kupnie
(automatycznym albo ręcznym). Dashboard pokazuje to wyraźnie w bloku danego
slotu: `Auto-kupno WSTRZYMANE (Xs)`.

Jeśli problem nie ustępuje - kolejny cykl 3 nieudanych prób z rzędu po
wznowieniu - cooldown **podwaja się** przy każdym kolejnym wstrzymaniu
(5 min → 10 min → 20 min → ...), aż do sufitu `AUTO_BUY_MAX_COOLDOWN_MS`
(domyślnie 1 godzina). Eskalacja resetuje się do zera po pierwszym udanym
automatycznym kupnie. Dzięki temu bot nie wali RPC/Jupitera w nieskończoność
identycznym failującym requestem co kilkanaście sekund przez całą noc, ale
też nie próbuje w kółko z tą samą częstotliwością bez końca, jeśli problem
jest trwały.

Osobno: błąd w jednym slocie (np. Slot B ciągle failuje) **nigdy nie
blokuje** ewaluacji pozostałych slotów w tym samym ticku - każdy slot jest
sprawdzany niezależnie, z własnym łapaniem błędów.

## Ręczna sprzedaż nie wywołuje auto-rebuy

Jeśli sprzedasz pozycję ręcznie (`sell`/`sell 50`) albo użyjesz `panic`, bot
**nie kupi automatycznie z powrotem** na tym slocie - "chciałem wyjść" nie
powinno być natychmiast nadpisane przez bota kupującego z powrotem na
najbliższym ticku. Żeby slot znów zaczął handlować, trzeba wpisać `buy`
ręcznie - to otwiera nową pozycję i od tego momentu automatyka (rebuy,
wzmocnienie B, breakout) znów działa normalnie.

Automatyczna sprzedaż (target, stop-loss, trailing stop, stagnacja) **nie**
ustawia tej blokady - to strategia działa zgodnie z planem, więc auto-rebuy
działa dalej jak zwykle.

## Świadome uproszczenia względem `botrade`

Ten bot **nie** ma: kaskadowego take-profit, blokady zysku (profit lock),
trailing stopa, auto-buy na dołkach, wykrywania crashu, wielu poziomów
take-profit, watchera on-chain puli. To były realne funkcje w `botrade`, ale
dokładnie ta rozbudowa jest tym, co miało zniknąć - jedna strategia, jeden
plik do przeczytania w pięć minut, mniej rzeczy które mogą się rozjechać.
