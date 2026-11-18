@echo off
chcp 65001 >nul
title Kartenhain Preistracker
cd /d "%~dp0"
rem 1. Neueste Version von GitHub holen. Deine Daten im Ordner "data" und die Datei ".env" bleiben.
rem 2. Kartenhain starten. Alles Weitere steht in tools\start.cmd.
rem Diese Datei selbst wird bei Updates nie veraendert.
if not defined KARTENHAIN_NO_UPDATE if exist "tools\update.js" (
  where node >nul 2>nul && node "tools\update.js"
)
if not exist "tools\start.cmd" goto fehlt
"tools\start.cmd" %*

:fehlt
echo.
echo  Die Datei tools\start.cmd fehlt. Bitte Kartenhain neu herunterladen:
echo  https://github.com/philipmaxhai/Kartenhain  (gruener Knopf "Code", dann "Download ZIP")
echo.
pause
