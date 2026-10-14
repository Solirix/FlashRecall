# FlashRecall

A self-hosted, multi-user Anki-style flashcard web app. Zero npm dependencies —
the backend runs on plain Node.js built-ins (`node:http` + `node:sqlite`), and
scheduling is powered by the FSRS-4.5 spaced-repetition algorithm.

## Features

- Multi-user accounts with scrypt password hashing and session cookies
- Decks (hierarchical, per-deck daily new-card limits)
- Basic and cloze note types (one card per `{{cN::...}}` cloze)
- FSRS-4.5 scheduling with learning steps, lapses, fuzz, and per-user desired retention
- Study queue with answer-time previews, undo, bury/suspend/flag, leech detection
- Statistics: retention, streaks, heatmap, review forecast, card maturity
- Deck sharing between users (deep copy on accept)
- Browser with a mini query language (`deck:"Name"`, `tag:foo`, `is:due`, `-` negation)

## Quickstart (Docker)

```sh
docker compose up -d --build
```

Then open http://localhost:3000 and create an account.

## Local development

Requires Node.js 24+ (`node:sqlite` is used; no install step, no node_modules).

```sh
node server/index.js        # serves API + frontend on http://localhost:3000
npm test                    # or: node --test "server/test/**/*.test.js"
```

## Configuration

| Variable             | Default  | Description                                              |
| -------------------- | -------- | -------------------------------------------------------- |
| `PORT`               | `3000`   | HTTP port                                                |
| `DATA_DIR`           | `./data` | Directory holding `recall.db` (SQLite, WAL mode)         |
| `REGISTRATION_OPEN`  | `true`   | Set to `false` to close sign-ups once ≥1 user exists     |

## Backup

All data lives in a single SQLite database. Back up by copying `recall.db`
out of the data volume:

```sh
docker compose cp recall:/data/recall.db ./backup-recall.db
```

(Or stop the container and copy the file from the `recall-data` volume.)

## API overview

All endpoints are JSON under `/api/*`; everything except `POST /api/register`
and `POST /api/login` requires the session cookie.

- Auth: `register`, `login`, `logout`, `GET /api/me`, `PATCH /api/me`
- Decks: `GET /api/decks/tree`, `POST/PATCH/DELETE /api/decks[/:id]`
- Notes: `POST/GET/PATCH/DELETE /api/notes[/:id]`, `:id/suspend|bury|flag`, `GET /api/browse`
- Study: `GET /api/study/:deckId/queue`, `POST /api/study/answer`, `POST /api/study/undo`
- Stats: `GET /api/stats/summary?deckId=&rangeDays=`
- Settings: `GET/PUT /api/settings`
- Sharing: `POST/GET /api/shares`, `POST /api/shares/:id/accept|decline`
