# Wdrożenie na Mikrusie (1 GiB RAM)

Bot działa jako trzy niezależne usługi systemd:

- `bocikv2@a` — profil A, panel `127.0.0.1:4173`;
- `bocikv2@b` — profil B, panel `127.0.0.1:4174`;
- `bocikv2@c` — profil C, panel `127.0.0.1:4175`.

Konfiguracje znajdują się poza repozytorium w `/etc/bocikv2/a.env`,
`b.env` i `c.env`, z prawami `0600`. Nie commitujemy ani nie kopiujemy
sekretów do GitHuba.

## Panel przez bezpieczny tunel

Dashboard ma endpointy wykonujące komendy, dlatego pozostaje dostępny tylko
na localhost serwera. Na swoim komputerze uruchom:

```powershell
ssh -N -i "$env:USERPROFILE\.ssh\bocikv2_mikrus_ed25519" -p 10304 `
  -L 4173:127.0.0.1:4173 `
  -L 4174:127.0.0.1:4174 `
  -L 4175:127.0.0.1:4175 `
  root@eve304.mikrus.xyz
```

Następnie otwórz tylko `http://127.0.0.1:4173`. Główny panel sam dołączy
instancje B i C.

### Osobny panel tylko do obserwowania

Porty `4273`–`4275` nie udostępniają endpointu komend. Aby korzystać z
panelu bez możliwości kupna, sprzedaży lub panic, zestaw tunel:

```powershell
ssh -N -i "$env:USERPROFILE\.ssh\bocikv2_mikrus_ed25519" -p 10304 `
  -L 4273:127.0.0.1:4273 `
  -L 4274:127.0.0.1:4274 `
  -L 4275:127.0.0.1:4275 `
  root@eve304.mikrus.xyz
```

Następnie otwórz `http://127.0.0.1:4273`. Strona pokazuje stan i ostatnie
transakcje wszystkich instancji, ale serwer na tych portach nie przyjmuje
`POST /api/command`.

### Telefon bez tunelu SSH

`bocikv2-readonly-tunnel.service` może wystawić wyłącznie port 4273 przez
Cloudflare Quick Tunnel. Mobilny widok jest pod ścieżką `/live`, wymaga
Basic Auth i pokazuje tylko instancję LIVE A. Panel kontrolny 4173 nigdy nie
jest przekazywany do Cloudflare.

Quick Tunnel nie wymaga konta ani domeny, ale jego losowy adres
`*.trycloudflare.com` może zmienić się po restarcie procesu i Cloudflare nie
gwarantuje dla niego SLA. Stały adres wymaga nazwanego tunelu oraz domeny na
koncie Cloudflare.

Aktualny adres można odczytać bez wyświetlania konfiguracji bota:

```bash
journalctl -u bocikv2-readonly-tunnel -n 50 --no-pager \
  | grep -o 'https://[^ ]*\.trycloudflare\.com' | tail -n 1
```

## Obsługa

```bash
systemctl status 'bocikv2@*'
journalctl -u bocikv2@a -f
journalctl -u bocikv2@b -f
journalctl -u bocikv2@c -f
systemctl restart bocikv2@a bocikv2@b bocikv2@c
```

Po zmianie dowolnego pliku `/etc/bocikv2/*.env` trzeba zrestartować
odpowiednią usługę. Sam restart bota nie usuwa zapisanej pozycji ani historii.

## Aktualizacja kodu

```bash
cd /opt/bocikv2
git pull --ff-only
npm ci
npm run build
chown -R bocikv2:bocikv2 /opt/bocikv2
systemctl restart bocikv2@a bocikv2@b bocikv2@c
```
