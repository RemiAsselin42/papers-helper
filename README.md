# Papers Helper

Outil local de gestion bibliographique pour l'écriture académique.
Organise tes PDFs, citations, auteurs et thématiques par projet — avec recherche sémantique locale et résumés via LLM (Ollama).

---

## Architecture

```
           ┌─────────────────────┐
           │  Browser (Vite SPA) │  :5173
           │    React + SCSS     │
           └──────────┬──────────┘
                      │ HTTP /api/*
           ┌──────────▼──────────┐
           │   FastAPI backend   │  :8000
           │   Python + SQLite   │
           └──────┬────────────┬─┘
                  │            │
           ┌──────▼───────┐  ┌─▼────────────┐
           │   ChromaDB   │  │    Ollama    │
           │  (vecteurs)  │  │  llama3:8b   │
           └──────┬───────┘  └──────────────┘
                  │   
           ┌──────▼───────────────┐
           │  liteparse CLI (lit) │
           │  OCR + texte PDF     │
           └──────────────────────┘
```

---

## Prérequis

| Outil | Version | Installation |
|-------|---------|--------------|
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Python | ≥ 3.12 | [python.org](https://python.org) |
| UV | latest | `pip install uv` ou `winget install astral-sh.uv` |
| Ollama | latest | [ollama.com](https://ollama.com) |
| liteparse | latest | `npm i -g @llamaindex/liteparse` |

---

## Installation

```bash
# 1. Cloner le repo
git clone https://github.com/<toi>/papers-helper.git
cd papers-helper

# 2. Frontend
cd frontend
pnpm install
cd ..

# 3. Backend
cd backend
uv sync
cd ..

# 4. Modèle LLM local
ollama pull llama3:8b

# 5. Vérifier liteparse
lit --version
```

---

## Lancement (développement)

Ouvrir deux terminaux :

```bash
# Terminal 1 — frontend
cd frontend
pnpm dev
# → http://localhost:5173

# Terminal 2 — backend
cd backend
uv run uvicorn app.main:app --reload
# → http://localhost:8000
```

Vérifier que tout tourne : `GET http://localhost:8000/health`

```json
{
  "status": "ok",
  "ollama": "connected",
  "storage": "accessible"
}
```

> Si `ollama` est `"unavailable"`, lance Ollama Desktop ou `ollama serve`.

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Frontend | Vite 6, React 19, TypeScript 5, SCSS, Lucide React |
| Backend | FastAPI, Python 3.12, UV |
| Base de données | SQLite (SQLAlchemy) |
| Recherche sémantique | ChromaDB (vecteurs locaux) |
| LLM | Ollama — llama3:8b |
| Extraction PDF | liteparse (`lit`) |
| Linter frontend | ESLint 9 + typescript-eslint + Prettier |
| Linter backend | Ruff |
| CI/CD | GitHub Actions |

---

## Structure du projet

```
papers-helper/
├── frontend/          # SPA Vite + React
├── backend/           # API FastAPI
│   └── app/
│       └── main.py
├── data/
│   ├── pdfs/          # PDFs uploadés (gitignored)
│   └── vectors/       # Données ChromaDB (gitignored)
└── .github/workflows/ # CI lint + typecheck
```
