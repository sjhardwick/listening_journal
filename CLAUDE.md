# Listening journal — context for future sessions

## What this is

A personal, hand-curated network of music the owner has listened to. Nodes are **artists** or **albums**; edges are connections the owner draws between them (e.g. "made", "played guitar on", "reissued on", "Jim's fave Basho album"). Published as a single-page vis.js visualization.

## Why it exists (don't forget this — it drives design decisions)

A reaction against streaming-era algorithmic recommendation. The owner wants to discover music through his own listening, reading, and conversations — not through "because you listened to X". **No external music APIs (Spotify / Last.fm / MusicBrainz / etc.) — ever.** Any future "look this up online" suggestion is a misread of the project.

## Data model quirks

`data.csv` is the source of truth. Each row is a node. Outgoing connections live in three pipe-delimited columns that must stay in lockstep — `connections | connection_labels | connection_directions` — which is why hand-editing is error-prone and why the in-app editor exists.

`connection_directions` values:
- `forward` — arrow points from this row's node to the target
- `backward` — arrow points from the target to this row's node
- `none` — undirected

Edges are declared on one node's row (the "owner"), not duplicated on both ends. The in-app editor preserves ownership on round-trip so git diffs stay minimal.

## Architecture (as of 2026-04-18 refactor)

- Host: **Vercel** (moved off GitHub Pages so we can have a serverless save endpoint reachable from iPhone).
- GitHub repo remains the source of truth. `POST /api/save` validates a shared password and commits `data.csv` back to the repo via GitHub contents API. Vercel auto-redeploys on push.
- Vercel env vars required: `GITHUB_TOKEN` (fine-grained PAT, contents:write, this repo only), `GITHUB_REPO` (`sjhardwick/listening_journal`), `EDIT_PASSWORD`.
- Frontend: no build step. Static `index.html` + `app.js` + vendored `lib/vis-9.1.2`.
- `script.ipynb` was the old Python build step (pandas → inline JSON in `index.html`). Removed in favour of runtime `fetch('data.csv')`. Don't reintroduce.

## Owner

Sam Hardwick — economist and policy researcher. Intermediate in R, moderate on the command line. Prefers concise, practical explanations; sentence-case headings.
