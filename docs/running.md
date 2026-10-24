# Running and options

## Start

| How | Needs |
|---|---|
| `uv run main.py`, `start.bat`, `./start.sh` | [uv](https://docs.astral.sh/uv/) installs Python and dependencies itself |
| `start-pip.bat`, `./start-pip.sh` | Python 3.10+ and pip; creates `.venv` and installs `requirements.txt` on the first run |
| `python main.py` | Python 3.10+; everything except transcription works on the standard library |

The browser opens at http://localhost:8765/. `faster-whisper` (about 200 MB) is only needed for transcription. Start scripts pass arguments through: `./start-pip.sh --port 9000`.

## Options

`uv run main.py --help` lists them.

| Option | Meaning |
|---|---|
| `--port 9000` | port (default 8765) |
| `--host IP` | address to listen on (default `127.0.0.1`) |
| `--data D:\boards\work` | another data folder |
| `--device cpu` | transcribe on the CPU only |
| `--ollama http://host:11434` | Ollama address |
| `--gc` | delete unreferenced files, then exit |
| `--no-browser`, `--verbose` | do not open the browser; log requests |

## Settings

Models and llama.cpp are configured in the Models panel and stored in `data/settings.json` (`whisper_idle`, `vl_idle`, `vl_engine`, `vl_model`, `llama_bin`, `llama_model`, `llama_mmproj`, `llama_args`). Interface preferences (theme, pen, wheel mode) are stored in the browser; the default theme is dark.

## Listening on a network

`--host 0.0.0.0` lets other computers on the local network open the board. There is **no password and no encryption**: anyone who can reach the address can read and change your boards. Use it only on a trusted network, never behind a public address or port forwarding. In this mode the llama.cpp program paths can only be changed from the computer running the board (or in `settings.json`).
