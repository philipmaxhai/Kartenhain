@echo off
chcp 65001 >nul
title Kartenhain Preistracker (Demo)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

if exist package-lock.json if not exist node_modules (
  echo Installiere benoetigte Pakete ...
  call npm install
)

echo.
echo  Kartenhain Preistracker startet im DEMO-Modus (erfundene Preise) ...
echo  Der Browser oeffnet sich gleich von selbst.
echo.
node --disable-warning=ExperimentalWarning src/server.js --demo --open %*
echo.
echo Der Preistracker wurde beendet.
pause
exit /b

:nonode
echo.
echo  Node.js ist nicht installiert.
echo.
echo  So geht's:
echo   1. Auf https://nodejs.org die Version "LTS" herunterladen und installieren.
echo   2. Danach diese Datei noch einmal doppelklicken.
echo.
start "" https://nodejs.org/de/download
pause
exit /b

:oldnode
echo.
echo  Deine Node.js-Version ist zu alt. Benoetigt wird Version 22.13 oder neuer.
echo  Bitte auf https://nodejs.org die aktuelle "LTS"-Version installieren
echo  und danach diese Datei noch einmal doppelklicken.
echo.
start "" https://nodejs.org/de/download
pause
exit /b
