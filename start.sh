#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi
exec uv run main.py "$@"
