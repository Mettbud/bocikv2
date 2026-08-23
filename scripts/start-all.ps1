# Uruchamia wszystkie skonfigurowane instancje bota (A/B/C), każdą w
# osobnym oknie PowerShell, jedną komendą.
#
#   .\scripts\start-all.ps1
#
# Odpala A i B zawsze; C tylko jeśli .env.c istnieje (nie każdy testuje
# Slot C). Każde okno samo ustawia swój katalog roboczy, więc możesz
# odpalić ten skrypt z dowolnego miejsca - działa też gdy ścieżka do
# projektu zawiera spacje.
#
# Chcesz mieć je jako panele w jednym oknie Windows Terminal (żeby użyć
# "Toggle broadcast input to all panes")? Po odpaleniu przeciągnij zakładki
# okien na siebie - patrz README, sekcja "Porównanie konfiguracji".

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot

function Start-BotWindow {
    param(
        [string]$Title,
        [string]$EnvPath  # pusty = domyślny .env
    )
    $lines = @("`$host.UI.RawUI.WindowTitle = '$Title'")
    if ($EnvPath) {
        $lines += "`$env:DOTENV_CONFIG_PATH = '$EnvPath'"
    }
    $lines += "npm run bot"
    $command = $lines -join "; "
    Start-Process powershell -WorkingDirectory $projectDir -ArgumentList "-NoExit", "-Command", $command
}

Write-Host "Startuje Slot A (.env)..."
Start-BotWindow -Title "bocik - wersja A" -EnvPath ""

Start-Sleep -Seconds 1
Write-Host "Startuje wersje B (.env.b)..."
Start-BotWindow -Title "bocik - wersja B" -EnvPath ".env.b"

if (Test-Path (Join-Path $projectDir ".env.c")) {
    Start-Sleep -Seconds 1
    Write-Host "Startuje wersje C (.env.c)..."
    Start-BotWindow -Title "bocik - wersja C" -EnvPath ".env.c"
} else {
    Write-Host "Pomijam wersje C - brak pliku .env.c."
}

Write-Host "Gotowe - kazda wersja w osobnym oknie."
