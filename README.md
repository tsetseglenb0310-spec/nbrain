# NBrain — turn any book into a personal study course

[![Live](https://img.shields.io/badge/live-app.nbrain--ts.org-2ea44f)](https://app.nbrain-ts.org)
![Python](https://img.shields.io/badge/python-3.11%2B-blue)
![Dependencies](https://img.shields.io/badge/runtime%20deps-3-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

NBrain is a self-hosted web app that takes a PDF, EPUB or TXT book, indexes it
for semantic search, answers questions **only from the text it found** (with
page-level sources you can verify), and then builds a study plan around the
book: lessons with summaries, quizzes, spaced-repetition flashcards and a
progress dashboard.

I built it because I read a lot of technical and management books and kept
losing what I had read. A chatbot that "knows" the book was not enough — I
wanted something that shows me the page it is quoting and makes me come back.

<!-- TODO: add screenshot -->
<!-- ![NBrain — reader and lesson view](docs/screenshot.png) -->

> 🇷🇺 Подробная техническая документация на русском: [docs/README.ru.md](docs/README.ru.md)

## What it does

- **Upload & index** — PDF/EPUB/TXT → text extraction → 450-word chunks with
  overlap → OpenAI embeddings → normalized float32 vectors in SQLite.
  Indexing runs in a background worker pool; the UI polls status, you can close the tab.
- **Semantic search & grounded answers** — cosine search over the whole library
  (one numpy matrix product, pure-Python fallback), then an OpenAI or Claude
  answer built strictly from the six best fragments, each shown as a clickable source.
- **Reader** — books are stored a second time as plain pages for reading;
  position, bookmarks and notes are kept server-side so you can continue from your phone.
- **Study plan** — the book is split into lessons by *text volume*, not page count,
  and scheduled from your minutes-per-day and target date.
- **Lessons** — summary, key ideas, terms, quotes, a practical task, five quiz
  questions and six flashcards, all generated from the pages of that lesson only.
  Any citation outside the lesson range is discarded: a wrong page number is worse than none.
- **Spaced repetition** — SM-2 scheduling (1 day, 6 days, then by ease factor);
  a quiz score under 70 % sends the lesson's cards back into rotation.
- **Progress** — streaks, minutes, average score, a 30-day chart and achievements.
  Achievements are *derived* from the activity log, never stored, so they cannot drift from the facts.
- **Multi-user** — private libraries per account, e-mail verification and password
  reset, admin console, per-account rate limits, one-click export and deletion of all your data.

## Architecture

```
web/  (vanilla JS, no framework)  ──HTTP/JSON──▶  server.py  (single file, ~5 000 lines)
                                                     ├─ http.server + threads   ← no web framework
                                                     ├─ SQLite  (books, chunks, users, plans, cards)
                                                     ├─ OpenAI API  (embeddings, answers)   via urllib
                                                     └─ Anthropic API  (analysis, optional)  via urllib
```

Deliberate choices:

- **Standard library first.** The server is `http.server` + `sqlite3` + `threading`;
  the only runtime dependencies are `pypdf`, `numpy` (optional accelerator) and
  a few exporters. No Flask, no ORM, no OpenAI SDK — every HTTP call to the
  model providers is a plain `urllib` request, which made retries, timeouts and
  cost control easy to reason about and the whole app trivial to deploy.
- **SQLite on purpose.** The product must start with one command and no Docker.
  Vectors are stored as normalized float32 BLOBs (6 KB instead of 31 KB as JSON),
  so cosine similarity is a dot product and a library of tens of thousands of chunks
  searches in milliseconds. The storage layer is isolated; PostgreSQL + pgvector is the planned next step.
- **Security done properly for a personal cloud app.** PBKDF2-SHA256 passwords,
  cookies signed with the owner's password fingerprint (changing a password logs out only that account),
  login throttling that only trusts `X-Forwarded-For` behind a declared proxy,
  refusal to start in no-auth mode on a non-loopback interface, per-account quotas on every paid operation.
- **Structure from code, content from the book.** The lesson planner computes
  *where* lessons begin and end; the model only writes *what* is on those pages.

## Run it locally

Python 3.11+, an OpenAI API key and internet access.

```bash
git clone https://github.com/tsetseglenb0310-spec/nbrain.git
cd nbrain
python -m pip install -r requirements.txt
cp .env.example .env          # set OPENAI_API_KEY, NBRAIN_ADMIN_PASSWORD, NBRAIN_SESSION_SECRET
python server.py
```

Open http://127.0.0.1:8000. The first account is created from `.env`; other
users register themselves (or set `NBRAIN_REGISTRATION_OPEN=0`).

Docker: `docker compose up -d --build`. Deployment notes for Render are in
[RENDER_DEPLOY.md](RENDER_DEPLOY.md); the full list of environment variables is in [.env.example](.env.example).

Tests: `python -m unittest discover tests` (HTTP API, RAG pipeline, path-traversal protection).

## API

Everything except `/api/health` and `/api/auth/*` is scoped to the signed-in
account — another user's `book_id` simply does not exist for you.

| Area | Endpoints |
|---|---|
| Books | `GET/POST /api/books`, `/api/books/reindex`, `/api/books/delete` |
| Search & answers | `POST /api/search`, `POST /api/answer` |
| Reader | `/api/reader/state`, `/api/reader/page`, `/api/reader/progress`, `/api/reader/bookmark`, `/api/notes` |
| Learning | `/api/plans`, `/api/plan`, `/api/lesson`, `/api/lesson/generate`, `/api/lesson/quiz`, `/api/flashcards`, `/api/flashcards/review`, `/api/progress` |
| Accounts | `/api/auth/{login,register,verify,forgot,reset}`, `/api/onboarding`, `/api/account/{export,delete}` |
| Admin | `/api/users`, `/api/users/delete`, `/api/users/password`, `/api/admin/mail-log` |

Full table with descriptions: [docs/README.ru.md](docs/README.ru.md#api).

## Limitations & roadmap

- PDFs need a text layer — no OCR yet.
- Search is a full library scan; fine up to tens of thousands of chunks, then a vector index (pgvector / sqlite-vec) is needed.
- Next: PostgreSQL + pgvector, indexing queue as a separate worker, OCR, hybrid search + reranking, team roles.

## About

Built by [Tsetseglen B.](https://github.com/tsetseglenb0310-spec) — Information
Systems Manager at a manufacturing company in Ulaanbaatar, Mongolia.
I started this project with no programming background and built it
iteratively with AI coding assistants (Claude, Codex), reviewing and
understanding every change before shipping it. The result runs in production at
[app.nbrain-ts.org](https://app.nbrain-ts.org).

License: MIT.
