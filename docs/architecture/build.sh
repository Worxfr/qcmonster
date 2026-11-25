#!/usr/bin/env bash
# Régénère tous les schémas. Prérequis: venv dédié (voir README.md). Usage: ./build.sh [NN_nom.py ...]
set -euo pipefail
cd "$(dirname "$0")"
VENV="${QCM_DIAGRAMS_VENV:?définir QCM_DIAGRAMS_VENV (voir README.md)}"
# `dot` natif si présent, sinon l'adaptateur Graphviz WebAssembly du venv (voir README.md).
if ! command -v dot >/dev/null 2>&1; then export PATH="$VENV/shim:$PATH"; fi
files=("$@"); [ ${#files[@]} -gt 0 ] || files=([0-9][0-9]_*.py)
for f in "${files[@]}"; do echo "== $f"; "$VENV/bin/python" "$f"; done
# diagrams laisse le source DOT sans extension: on le supprime.
find . -maxdepth 1 -type f -name '[0-9][0-9]_*' ! -name '*.*' -delete
