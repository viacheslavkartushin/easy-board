# Data, history, export

Everything is in the `data/` folder next to the program (or the folder given by `--data`). Copy it to back up or move the board.

| Path | Content |
|---|---|
| `data/projects/<id>/board.json` | the board, saved automatically (`board.json.bak` is a copy made once a minute) |
| `data/projects/<id>/history/` | version snapshots |
| `data/assets/` | all uploaded and downloaded files, named by content hash and shared by all projects (the same file is stored once) |
| `data/models/` | Whisper models |
| `data/settings.json` | model and llama.cpp settings |
| `data/trash/` | deleted projects |

Pen, theme and other interface preferences are kept in the browser, not in `data/`.

## Version history

Projects menu, "Version history": automatic snapshots at most every 10 minutes when something changed (the last 6 hours are kept, then one per hour for a week, then one per day, 90 days at most), plus manual ones that are kept until you delete them. Restoring saves the current state first.

## Cache cleanup

"Files and cache" lists files in `data/assets` that no card, project or snapshot uses and deletes the ones you select. Console: `uv run main.py --gc`.

## Export

- **Markdown + files (zip)**: the whole board or the selected cards, top to bottom; frames become headings, checklists `- [x]`, transcripts lists with timecodes, files go to `assets/`.
- **PDF / print**: via the browser print dialog (A4 landscape). There is no PNG export.
- **Project `.zip`**: board plus files; import it from the projects menu.
