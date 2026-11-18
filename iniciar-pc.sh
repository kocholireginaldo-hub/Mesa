#!/bin/sh
cd "$(dirname "$0")" && (command -v xdg-open >/dev/null && xdg-open http://localhost:8080 >/dev/null 2>&1 &) ; node servidor.js
