# Uruchamia wszystkie skonfigurowane instancje bota (A/B/C), każdą w
# osobnym oknie PowerShell, jedną komendą. W przeglądarce otwiera wyłącznie
# główny panel http://127.0.0.1:4173, który pokazuje także B (4174) i C (4175).
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
    # Minimized so three (or more) of these don't take over the screen -
    # the bot itself doesn't need the window visible to run; open it back
    # up from the taskbar whenever you actually want to watch the terminal
    # dashboard or type a command into it.
    Start-Process powershell -WorkingDirectory $projectDir -WindowStyle Minimized -ArgumentList "-NoExit", "-Command", $command
}

# Start-Process with a bare URL asks Windows to look up the registered
# handler for "http" - on some machines that association is broken or
# points somewhere unexpected (seen here opening Notepad instead of a
# browser). Reading the actual default-browser registration out of the
# registry and launching that .exe directly sidesteps that lookup
# entirely, and - unlike hardcoding a specific browser - keeps working
# correctly whatever you have set as your default, including after you
# change it.
function Get-DefaultBrowserPath {
    try {
        $progId = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" -ErrorAction Stop).ProgId
        $cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop).'(default)'
        if ($cmd -match '^"([^"]+)"') {
            $exePath = $Matches[1]
            if (Test-Path $exePath) { return $exePath }
        }
    } catch {
        # Fall through - Open-DashboardUrl falls back to a fixed list below.
    }
    return $null
}

function Open-DashboardUrl {
    param([string]$Url)
    $browser = Get-DefaultBrowserPath
    if (-not $browser) {
        # Only reached if reading the registered default browser failed
        # outright (unusual) - a best-effort fallback so this still opens
        # something rather than nothing.
        $fallbackPaths = @(
            "$env:LocalAppData\Programs\Opera GX\opera.exe",
            "$env:LocalAppData\Programs\Opera\opera.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:ProgramFiles\Mozilla Firefox\firefox.exe"
        )
        $browser = $fallbackPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if ($browser) {
        Start-Process -FilePath $browser -ArgumentList $Url
    } else {
        Write-Host "Nie udalo sie ustalic przegladarki - otworz recznie: $Url"
    }
}

$mainDashboardUrl = "http://127.0.0.1:4173"

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

Write-Host "Czekam, az boty wystartuja, zeby otworzyc glowny dashboard..."
Start-Sleep -Seconds 6
Write-Host "Otwieram tylko $mainDashboardUrl (B:4174, C:4175 sa w tym samym panelu)"
Open-DashboardUrl -Url $mainDashboardUrl
