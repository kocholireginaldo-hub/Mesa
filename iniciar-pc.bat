@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js NAO esta instalado neste PC.
  echo  - Para CONTROLAR a mesa e usar a IA em nuvem: instale o Node.js LTS em https://nodejs.org e rode este arquivo de novo.
  echo  - Abrindo agora em MODO DEMO (sem mesa e sem IA em nuvem): EQ, gravador, importar audio e analises locais funcionam.
  echo.
  start "" "%~dp0index.html"
  pause
  exit /b
)
start "" http://localhost:8080
node servidor.js
pause
