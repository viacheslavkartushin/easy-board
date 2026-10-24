#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python) || { echo "Python 3.10+ not found." >&2; exit 1; }
if [ ! -x .venv/bin/python ]; then "$PY" -m venv .venv || exit 1; fi
if [ ! -f .venv/.installed ]; then
  echo "First run: installing requirements.txt (faster-whisper, ~200 MB, only for transcription)..."
  .venv/bin/python -m pip install -r requirements.txt || exit 1
  touch .venv/.installed
fi
exec .venv/bin/python main.py "$@"
