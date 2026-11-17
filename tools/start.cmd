@echo off
rem Startet Kartenhain. Wird von Start.bat und "Demo starten.bat" aufgerufen.
rem Diese Datei wird bei jedem Update mit erneuert, Start.bat selbst bleibt immer gleich.
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

if /i "%~1"=="--demo" goto demo

echo.
echo  Kartenhain Preistracker startet ...
echo  Der Browser oeffnet sich gleich von selbst.
echo  Beim allerersten Start werden die Cardmarket-Preise geladen (1-2 Minuten).
echo  Zum Beenden einfach dieses Fenster schliessen.
echo.
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/server.js --open %*
goto ende

:demo
echo.
echo  Kartenhain Preistracker startet im DEMO-Modus (erfundene Preise) ...
echo  Der Browser oeffnet sich gleich von selbst.
echo.
node --disable-warning=ExperimentalWarning src/server.js --open %*
goto ende

:ende
echo.
echo  Der Preistracker wurde beendet.
pause
exit /b

:nonode
echo.
echo  Node.js ist nicht installiert.
echo.
echo  So geht's:
echo   1. Auf https://nodejs.org die Version "LTS" herunterladen und installieren.
echo   2. Danach Start.bat noch einmal doppelklicken.
echo.
start "" https://nodejs.org/de/download
pause
exit /b

:oldnode
echo.
echo  Deine Node.js-Version ist zu alt. Benoetigt wird Version 22.13 oder neuer.
echo  Bitte auf https://nodejs.org die aktuelle "LTS"-Version installieren
echo  und danach Start.bat noch einmal doppelklicken.
echo.
start "" https://nodejs.org/de/download
pause
exit /b
