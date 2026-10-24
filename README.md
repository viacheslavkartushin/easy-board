# Easy Board

A local infinite whiteboard: drawing, notes, Markdown, code with syntax highlighting, images (including from the clipboard), PDF, audio and video, and connections between cards.
Everything is stored on your disk in the `data/` folder (no cloud; the server listens on `127.0.0.1` only).

## Running

```
uv run main.py
```

or double-click `start.bat`. A browser opens at http://localhost:8765/.
Options: `--port 9000`, `--data D:\boards\work` (a different data folder), `--no-browser`.
Only uv is required: it installs Python and the dependencies itself (on first run `faster-whisper` ≈ 200 MB is downloaded — that is for transcription). The JS libraries (marked, DOMPurify, highlight.js) live in `web/vendor/`.
More options: `--device cpu` (transcribe on the CPU only), `--gc` (delete files that no project references, then exit).

## Controls

| Action | How |
|---|---|
| Pan the canvas | space + mouse, middle button, the Hand tool (H) |
| Zoom | wheel (Ctrl+wheel always zooms; the mouse button in the corner switches the wheel to scrolling), `+` `-` `0`, `F` — fit everything |
| Pen / eraser | P / E; color, size, opacity in the top panel. The eraser erases part of a stroke; "Whole stroke" removes a stroke entirely |
| Note / text / Markdown / code | buttons on the left; double-click on empty space for free text |
| Files | the "upload" button, drag and drop from the file manager, or Ctrl+V (screenshots and images from the clipboard, text) |
| Editing | double-click a card or the pencil above it; Esc to exit. Available for notes, text, Markdown, code, audio, video |
| Audio/video | in normal mode, play only plays the selected range. In edit mode drag the handles on the timeline or type a time; `⌖` takes the current position |
| Connections | drag from the circle on the right of a card (or the L tool) to another card; click a connection for color, thickness, arrow, dashes, label |
| PDF | first click selects, second click scrolls inside |
| Code language | the drop-down in the panel above a code card: "auto" (detected from the text, the detected language is shown) or any from the list |
| Transcription | at the bottom of an audio or video card: choose a model and a language (or "auto") and press "Transcribe". One line stays under the card (the first phrase); the arrow expands the full list: timecode on the left, text on the right. Clicking a phrase seeks the file to that second and starts playback (even outside the selected range). Buttons on the right: copy with timecodes, redo, delete |
| Projects | the button with the name in the top left corner: list, create, rename, copy, delete (to `data/trash`), export to `.zip` (board + files) and import from `.zip` |
| Links | the 🔗 button (Ctrl+K), or just Ctrl+V / dropping an address — see "Links" below |
| Search | Ctrl+F: text, titles, file names, transcripts (with timecode), `#tags` |
| Frames | the "Frame" button in the left panel or "wrap in frame" above selected cards |
| Alignment | the top panel when 2+ cards are selected; while dragging, guides appear, Alt disables snapping |
| Copying | Ctrl+C / Ctrl+X / Ctrl+V for selected cards (with the connections between them), including between projects and tabs |
| Selection | marquee, Shift+click; Del deletes; Ctrl+D duplicates; Ctrl+Z / Ctrl+Shift+Z undo/redo |
| Drawing layer | the layers button: above or below the cards |

Data: `data/projects/<id>/board.json` (the board, autosaved; `board.json.bak` next to it is a copy made once a minute), `data/assets/` (uploaded files, shared by all projects), `data/models/` (whisper models), `data/trash/` (deleted projects).

### Transcription
Runs locally via faster-whisper. A model is downloaded once on first use (small ≈ 480 MB, large-v3 ≈ 3 GB); after that no internet is needed. If you have an NVIDIA GPU with CUDA it is used, otherwise the CPU (int8). Recognition runs in the background and survives a page reload; the result is saved in the project.

### Links

Paste an address (Ctrl+V), drag a link from the browser, or press 🔗 / Ctrl+K. The server decides what you get:

| Address | Card |
|---|---|
| image, audio, video, PDF | the file is downloaded and shown as a regular card |
| `.md`, `.txt`, source files | text in a Markdown / note / code card |
| any other page | a bookmark: title, description, image, site icon |
| YouTube, Vimeo, RuTube, Dailymotion, Twitch, Spotify, SoundCloud, Loom | a player: the cover and title are saved, the player itself starts on click (internet required) |
| a card address (`#` in the card panel) | a card link: a click jumps to the card, including in another project |

- **The original address is kept**: the ↗ button above the card opens it in the browser.
- **There are no automatic updates.** The copy lives in `data/assets` and does not change, even if the file on the site disappears or changes. The ↻ button downloads again and replaces the copy; Ctrl+Z brings the old one back.
- If a page is unavailable, a bookmark with the address itself and an error note remains.
- YouTube videos are **not downloaded**, only the cover and metadata are saved; pages are not archived whole (only title, description and image).
- A card address contains the server port (`http://localhost:8765/?p=…#card=…`): if you run on another port (`--port`), previously copied addresses will stop opening.
- Card links can also be written directly in Markdown — they work as jumps too.

### Frames, tags, search

- **A frame** is a named area. Drag its title: the cards inside move along with it. Double-click the title to rename; the color is chosen at the top. Frames sit below the cards and do not get in the way of marquee-selecting what is inside.
- **Tags and the color label** are set in the panel above a selected card. Clicking a tag under a card (or in search) turns on a filter: the other cards are dimmed. The "Filter" badge at the top clears it.
- **Snapping**: a card sticks by its edges and centers to its neighbors; the grid button also turns on a grid. Alignment and equal spacing work on selected cards.
- **Minimap** at the bottom right: click and drag to move the camera; the button in the top right corner can hide it.

### Quotes from a transcript

Ctrl/Shift+click on a phrase (or the circle to its left) selects it; the "To note" button (or ❝ in the transcript header — the whole recording) creates a Markdown card. The timecode in it is a link: a click opens the recording's card and starts it from that point. Such links work from other projects too (`…#card=<id>&t=<seconds>`).

### Version history and cache

In the projects menu: **"Version history…"** — auto-snapshots (at most once per 10 minutes when there are changes; old ones are thinned out: 6 hours — all, a week — one per hour, after that — one per day, 90 days at most); manual versions ("Save version now") are kept until you delete them. A rollback first saves the current state, so it can be undone the same way. Snapshots are in `data/projects/<id>/history/`.

**"Files and cache…"** shows the files in `data/assets` that no card, no project and no history snapshot references, and deletes the ones you select. The same from the console: `uv run main.py --gc`.

### Page copy

For page bookmarks the server also saves a **single HTML file**: styles and images are embedded; scripts, frames and event handlers are removed. The "open copy" link at the bottom of the card opens it without internet. Limits: up to ~14 MB of embedded resources, images from CSS backgrounds and fonts only if small, and pages rendered by scripts (SPAs) may come out empty. The copy opens under a strict security policy (no scripts and no network).

### Export

The down-arrow button at the top right:
- **Markdown + files (zip)** — the whole board or the selected cards: top-to-bottom order, frames become headings, transcripts become lists with timecodes, files go in `assets/`.
- **PDF / print** — "fit everything" or "as currently on screen"; in the print dialog choose "Save as PDF". Printing is A4 landscape, as on screen. There is no PNG export: use a screenshot for an image.

### Models in memory and text recognition in images

The chip button at the top right opens the **"Models"** panel. Each model has a toggle: switch it on and the model is loaded into memory (the GPU) and waits; switch it off and the memory is freed. If a model was loaded on its own (you pressed "Transcribe" or "Recognize text" while the toggle was off), it is unloaded after idling; the time is chosen in the panel (10 minutes by default, or "never"). A green dot on the button means something is in memory right now. A model cannot be switched off while it is working.

- **Speech → text**: Whisper, as before; it can be loaded ahead of time so the first transcription does not wait.
- **Text in images**: images have a "Recognize text" button. The result sits under the image (the first line by default); it can be copied, turned into a note, and it is included in search (Ctrl+F) and the Markdown export. Image formats: PNG, JPG, WebP. The engine is chosen in the panel: **llama.cpp** (default) or Ollama.
- **llama.cpp**: the board launches `llama-server` with a vision model itself when you switch the toggle on or press "Recognize", and **stops the process** when you switch it off or after idling, so memory (including VRAM) is freed completely. In the panel enter: the path to `llama-server.exe`, the model (a `.gguf` file + an `mmproj-….gguf` file, or a Hugging Face repository such as `ggml-org/GLM-OCR-GGUF` — then `-hf` downloads everything itself on first launch) and the arguments (default `-c 12000 -ngl 99 --flash-attn off`: all layers on the GPU; for GLM-OCR flash-attn must be off). The board sets the host and port itself. Startup log: `data/.tmp/llama-server.log`. For `glm-ocr` models the prompt `Text Recognition:` is used.
- Ollama, if you want it: the default address is `http://127.0.0.1:11434`, another one via `uv run main.py --ollama http://host:11434`.
