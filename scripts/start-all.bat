@echo off
REM Double-click this file to run start-all.ps1.
REM
REM Windows opens a .ps1 file in Notepad on double-click by default (a
REM safety choice - it never runs a script just because you opened its
REM icon), so start-all.ps1 itself can't be double-clicked directly. A
REM .bat file doesn't have that restriction, so this one just calls
REM PowerShell to run it, with -ExecutionPolicy Bypass so it works
REM regardless of whatever the machine's default script policy is.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
pause
