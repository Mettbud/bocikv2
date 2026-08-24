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
