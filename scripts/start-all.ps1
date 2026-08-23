# Uruchamia wszystkie skonfigurowane instancje bota (A/B/C) jako panele
# w JEDNYM oknie Windows Terminal (dołącza do ostatnio uzywanego okna, albo
# otwiera nowe jesli zadne nie jest otwarte).
#
#   .\scripts\start-all.ps1
#
# Wymaga Windows Terminal (polecenie "wt" w PATH - jest domyslnie na
# Windows 10/11 z zainstalowanym Windows Terminal). Jesli go nie ma, spada
# do starego trybu: kazda wersja w osobnym, oddzielnym oknie PowerShell.

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot
$hasC = Test-Path (Join-Path $projectDir ".env.c")

function Build-BotCommand {
    param([string]$Title, [string]$EnvPath)
    $lines = @("`$host.UI.RawUI.WindowTitle = '$Title'")
    if ($EnvPath) { $lines += "`$env:DOTENV_CONFIG_PATH = '$EnvPath'" }
    $lines += "npm run bot"
    return ($lines -join "; ")
}

$cmdA = Build-BotCommand -Title "bocik - wersja A" -EnvPath ""
$cmdB = Build-BotCommand -Title "bocik - wersja B" -EnvPath ".env.b"
$cmdC = if ($hasC) { Build-BotCommand -Title "bocik - wersja C" -EnvPath ".env.c" } else { $null }

if (Get-Command wt -ErrorAction SilentlyContinue) {
    Write-Host "Otwieram panele w Windows Terminal (A + B$(if ($hasC) { ' + C' }))..."
    # "-w 0" = dolacz do ostatnio uzywanego okna Windows Terminal (albo
    # otworz nowe, jesli zadne jeszcze nie dziala). Semikolony poprzedzone
    # backtickiem to literalne ";" przekazywane do "wt" - to WT dzieli je
    # na kolejne pod-komendy (new-tab / split-pane), nie PowerShell.
    if ($hasC) {
        wt -w 0 new-tab -d $projectDir powershell -NoExit -Command $cmdA `; split-pane -H -d $projectDir powershell -NoExit -Command $cmdB `; split-pane -V -d $projectDir powershell -NoExit -Command $cmdC
    } else {
        wt -w 0 new-tab -d $projectDir powershell -NoExit -Command $cmdA `; split-pane -H -d $projectDir powershell -NoExit -Command $cmdB
    }
    Write-Host "Gotowe."
    return
}

Write-Host "Windows Terminal (polecenie 'wt') nie znaleziony - odpalam w osobnych oknach zamiast paneli."
function Start-BotWindow {
    param([string]$Title, [string]$EnvPath)
    $command = Build-BotCommand -Title $Title -EnvPath $EnvPath
    Start-Process powershell -WorkingDirectory $projectDir -ArgumentList "-NoExit", "-Command", $command
}
Start-BotWindow -Title "bocik - wersja A" -EnvPath ""
Start-Sleep -Seconds 1
Start-BotWindow -Title "bocik - wersja B" -EnvPath ".env.b"
if ($hasC) {
    Start-Sleep -Seconds 1
    Start-BotWindow -Title "bocik - wersja C" -EnvPath ".env.c"
}
Write-Host "Gotowe - kazda wersja w osobnym oknie."
