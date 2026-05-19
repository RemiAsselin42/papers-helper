# Papers Helper

Outil **local** de gestion bibliographique pour l'écriture académique.
Organise tes documents (PDF, DOCX, EPUB…), citations, auteurs et thématiques par projet — avec recherche sémantique locale, assistant de rédaction et résumés via LLM. Tout tourne sur ta machine.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Lancement (développement)](#lancement-développement)
- [Configuration](#configuration)
- [Stack technique](#stack-technique)
- [Structure du projet](#structure-du-projet)
- [Commandes utiles](#commandes-utiles)

---

## Fonctionnalités

- **Projets** — chaque projet est isolé sur disque (documents, métadonnées, vecteurs).
- **Ingestion multi-formats** — PDF, DOCX, TXT, ODT, RTF, HTML, EPUB ; les `.bib` servent de manifeste de métadonnées. Import par fichier, ZIP ou URL. Progression diffusée en temps réel (SSE).
- **Recherche sémantique** — indexation vectorielle locale (ChromaDB) ; retrouve des passages par sens, pas seulement par mots-clés.
- **Citations** — recherche de passages pertinents avec filtres multi-critères (source, auteur, catégorie).
- **Chat RAG** — discute avec ton corpus ; mentionne des documents pour injecter leur contexte.
- **Problématique** — éditeur dédié pour cadrer la question de recherche du projet.
- **Assistant de rédaction** — éditeur A4 paginé avec mode focus, génération de sections assistée par LLM et export du document.
- **Graphe de connaissances** — visualisation des liens entre documents, auteurs et catégories.
- **Catégorisation** — classement automatique des documents.
- **Export / import de projet** — échange complet d'un projet entre machines.
- **Multi-fournisseur LLM** — Ollama (local) par défaut ; OpenAI et Anthropic également supportés.

---

## Architecture

```
                 ┌─────────────────────┐
                 │  Browser (Vite SPA) │  :5173
                 │    React + SCSS     │
                 └──────────┬──────────┘
                            │ HTTP /api/*
                 ┌──────────▼─────────┐
                 │  FastAPI backend   │  :8000
                 │    Python 3.12     │
                 └───┬────────────┬───┘
                     │            │
        ┌────────────▼────┐ ┌─────▼───────────────┐
        │ Stockage disque │ │  Fournisseur LLM    │
        │ data/projects/  │ │  Ollama (local) /   │
        │ JSON + fichiers │ │  OpenAI / Anthropic │
        └────────┬────────┘ └─────────────────────┘
                 │
        ┌────────▼────────┐
        │    ChromaDB     │
        │   (vecteurs,    │
        │   par projet)   │
        └─────────────────┘
```

Application à deux étages avec stockage **sur disque, par projet** :

- **Frontend** (`frontend/`) — SPA Vite 6 + React 19 + TypeScript. `/api/*` est proxifié vers `localhost:8000` en dev.
- **Backend** (`backend/`) — FastAPI (Python 3.12). Routeurs : `projects`, `papers`, `chat`, `categorize`, `conversations`, `citations`, `graph`, `settings`, `writing`, `project_io`.
- **Stockage** — `data/projects/<uuid>/` par projet : `project.json`, `problematique.json`, `files/` (documents sources), `vectors/` (ChromaDB `PersistentClient` dédié). Aucune base SQL applicative — les métadonnées vivent dans des fichiers JSON et dans les métadonnées Chroma.
- **Parsers** (`backend/app/parsers/`) — un parser enfichable par extension. Limites : 50 Mo par fichier, 200 Mo par requête d'upload.
- **Ingestion** — pipeline : parse → normalisation → découpage (~500 mots, sensible aux paragraphes) → embeddings → upsert dans Chroma avec métadonnées riches (titre, auteur, année, champs BibTeX, résumé, notes, catégories).

---

## Prérequis

| Outil   | Version | Installation                                                            |
| ------- | ------- | ----------------------------------------------------------------------- |
| Node.js | ≥ 22    | [nodejs.org](https://nodejs.org)                                        |
| pnpm    | ≥ 11    | `npm i -g pnpm`                                                         |
| Python  | ≥ 3.12  | [python.org](https://python.org)                                        |
| UV      | latest  | `pip install uv` ou `winget install astral-sh.uv`                       |
| Ollama  | latest  | [ollama.com](https://ollama.com) — requis pour le mode local par défaut |

> Ollama est nécessaire pour le fonctionnement local par défaut. Pour utiliser OpenAI ou Anthropic à la place, voir [Configuration](#configuration).

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

# 3. Backend (inclut les dépendances de dev)
cd backend
uv sync --group dev
cd ..

# 4. Modèles LLM locaux (mode Ollama par défaut)
ollama pull nomic-embed-text   # embeddings
ollama pull llama3             # génération
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
  "ollama_models": [
    { "name": "nomic-embed-text", "available": true },
    { "name": "llama3", "available": true }
  ],
  "ollama_url": "http://localhost:11434",
  "storage": "accessible"
}
```

> Si `ollama` est `"unavailable"`, lance Ollama Desktop ou `ollama serve`.

---

## Configuration

Tout se configure par variables d'environnement (backend) :

| Variable                  | Défaut                        | Description                                     |
| ------------------------- | ----------------------------- | ----------------------------------------------- |
| `OLLAMA_BASE_URL`         | `http://localhost:11434`      | URL du serveur Ollama                           |
| `OLLAMA_EMBED_MODEL`      | `nomic-embed-text`            | Modèle d'embeddings                             |
| `OLLAMA_GENERATION_MODEL` | `llama3`                      | Modèle de génération                            |
| `DATA_DIR`                | `<repo>/data`                 | Répertoire de stockage des projets              |
| `CORS_ORIGINS`            | `http://localhost:5173`       | Origines CORS autorisées (séparées par virgule) |
| `CORS_METHODS`            | `GET,POST,PUT,DELETE,OPTIONS` | Méthodes CORS autorisées                        |
| `CORS_HEADERS`            | voir `app/main.py`            | En-têtes CORS autorisés                         |

D'autres variables affinent le découpage et l'injection de contexte (`MAX_CHUNK_CHARS`, `CHAT_*`, `CONDENSE_*`, `WRITING_*`) — voir `backend/app/config.py`.

> Si tu changes `OLLAMA_EMBED_MODEL`, la collection ChromaDB du projet est recréée automatiquement au prochain accès.

**Autres fournisseurs LLM** — l'UI (vue Paramètres) permet de basculer sur OpenAI ou Anthropic ; la clé API est transmise au backend par en-tête de requête.

---

## Stack technique

| Couche                   | Technologie                                                                   |
| ------------------------ | ----------------------------------------------------------------------------- |
| Frontend                 | Vite 6, React 19, TypeScript 5, SCSS modules, Lucide React                    |
| Éditeur de rédaction     | Tiptap, Paged.js                                                              |
| Graphe                   | Cytoscape                                                                     |
| Backend                  | FastAPI, Python 3.12, UV                                                      |
| Recherche sémantique     | ChromaDB (vecteurs locaux)                                                    |
| LLM                      | Ollama (local) — `nomic-embed-text` + `llama3` ; OpenAI / Anthropic en option |
| Extraction documents     | pypdf, python-docx, odfpy, striprtf, ebooklib, bibtexparser                   |
| Linter / format frontend | ESLint 9 + typescript-eslint + Prettier                                       |
| Tests frontend           | Vitest + Testing Library (jsdom)                                              |
| Linter / typage backend  | Ruff + mypy (strict)                                                          |
| Tests backend            | pytest                                                                        |
| CI/CD                    | GitHub Actions                                                                |

---

## Structure du projet

```
papers-helper/
├── frontend/              # SPA Vite + React
│   └── src/
│       ├── api/           # appels fetch vers /api/*
│       ├── components/    # chat, citations, graph, sources, writing…
│       └── hooks/
├── backend/
│   └── app/
│       ├── main.py        # entrypoint FastAPI
│       ├── config.py      # variables d'environnement
│       ├── routes/        # routeurs API
│       ├── parsers/       # parsers enfichables par extension
│       ├── chroma.py      # client ChromaDB par projet
│       └── ingestion.py   # pipeline d'ingestion (SSE)
├── data/
│   └── projects/<uuid>/   # stockage par projet (gitignored)
│       ├── project.json
│       ├── problematique.json
│       ├── files/         # documents sources
│       └── vectors/       # données ChromaDB
└── .github/workflows/     # CI lint + typecheck + tests
```

---

## Commandes utiles

### Backend (depuis `backend/`)

```bash
uv sync --group dev                       # installer (avec deps dev)
uv run uvicorn app.main:app --reload      # serveur dev :8000
uv run ruff check .                       # lint
uv run ruff format .                      # format
uv run mypy app/                          # typecheck strict
uv run pytest tests/ -v                   # tests
```

### Frontend (depuis `frontend/`)

```bash
pnpm install
pnpm dev              # :5173, proxy /api → :8000
pnpm build            # tsc -b && vite build
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run (jsdom)
pnpm format           # prettier --write src/
```
