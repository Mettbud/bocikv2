# Uruchamia wszystkie skonfigurowane instancje bota (A/B/C), każdą w
# osobnym oknie PowerShell, jedną komendą - i, dla każdej z nich, gdzie
# DASHBOARD_WEB_ENABLED=true, otwiera jej webowy dashboard w przeglądarce.
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

# Reads DASHBOARD_WEB_ENABLED/DASHBOARD_WEB_PORT straight out of the given
# .env file (read-only - never echoes the rest of the file, which has
# secrets) and returns that instance's dashboard URL, or $null if it
# doesn't have the web dashboard turned on.
function Get-DashboardUrl {
    param([string]$EnvFileName)  # "" = default .env
    $path = Join-Path $projectDir ($(if ($EnvFileName) { $EnvFileName } else { ".env" }))
    if (-not (Test-Path $path)) { return $null }
    $content = Get-Content $path -Raw
    if ($content -notmatch "(?m)^DASHBOARD_WEB_ENABLED=true\s*$") { return $null }
    $port = 4173
    if ($content -match "(?m)^DASHBOARD_WEB_PORT=(\d+)\s*$") { $port = $Matches[1] }
    return "http://127.0.0.1:$port"
}

# Start-Process with a bare URL asks Windows to look up the registered
# handler for "http" - on some machines that association is broken or
# points somewhere unexpected (seen here opening Notepad instead of a
# browser). Launching a known browser executable directly with the URL
# as its argument sidesteps that lookup entirely.
function Open-DashboardUrl {
    param([string]$Url)
    $browserPaths = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Mozilla Firefox\firefox.exe"
    )
    $browser = $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($browser) {
        Start-Process -FilePath $browser -ArgumentList $Url
    } else {
        Write-Host "Nie znalazlem Edge/Chrome/Firefox w standardowej lokalizacji - otworz recznie: $Url"
    }
}

$dashboardUrls = @()

Write-Host "Startuje Slot A (.env)..."
Start-BotWindow -Title "bocik - wersja A" -EnvPath ""
$dashboardUrls += Get-DashboardUrl -EnvFileName ""

Start-Sleep -Seconds 1
Write-Host "Startuje wersje B (.env.b)..."
Start-BotWindow -Title "bocik - wersja B" -EnvPath ".env.b"
$dashboardUrls += Get-DashboardUrl -EnvFileName ".env.b"

if (Test-Path (Join-Path $projectDir ".env.c")) {
    Start-Sleep -Seconds 1
    Write-Host "Startuje wersje C (.env.c)..."
    Start-BotWindow -Title "bocik - wersja C" -EnvPath ".env.c"
    $dashboardUrls += Get-DashboardUrl -EnvFileName ".env.c"
} else {
    Write-Host "Pomijam wersje C - brak pliku .env.c."
}

Write-Host "Gotowe - kazda wersja w osobnym oknie."

$dashboardUrls = $dashboardUrls | Where-Object { $_ }
if ($dashboardUrls.Count -gt 0) {
    Write-Host "Czekam, az boty wystartuja, zeby otworzyc ich dashboardy w przegladarce..."
    Start-Sleep -Seconds 6
    foreach ($url in $dashboardUrls) {
        Write-Host "Otwieram $url"
        Open-DashboardUrl -Url $url
    }
} else {
    Write-Host "Zaden .env nie ma DASHBOARD_WEB_ENABLED=true - pomijam otwieranie przegladarki."
    Write-Host "(Dodaj DASHBOARD_WEB_ENABLED=true w .env / .env.b / .env.c, zeby to wlaczyc.)"
}
