"""Export / import d'un projet complet sous forme d'archive `.zip`.

Permet de déplacer un projet d'un PC à un autre en local : l'archive contient
project.json, problematique.json, settings.json, graph.json, `files/`,
`conversations/` et — optionnellement — le vector store ChromaDB (`vectors/`).
"""

from __future__ import annotations

import asyncio
import gc
import io
import json
import shutil
import uuid
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from app.chroma import evict_collection
from app.config import PROJECTS_DIR
from app.graph import evict_graph_lock
from app.routes.projects import ProjectInfo, _read_project

router = APIRouter(prefix="/projects", tags=["project-io"])

MANIFEST_NAME = "_papers_helper_export.json"
EXPORT_FORMAT_VERSION = 1

# Garde-fous sur l'import : l'app est locale, mais une archive piégée
# (zip-bomb) ne doit ni saturer la RAM ni remplir le disque.
_CHUNK = 1 << 16  # 64 KiB
MAX_UPLOAD_BYTES = 1 << 30  # 1 GiB — taille de l'archive .zip téléversée
MAX_UNCOMPRESSED_BYTES = 4 * (1 << 30)  # 4 GiB — total décompressé autorisé

ImportMode = Literal["auto", "replace", "duplicate"]


def _slugify(name: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in name).strip("-")
    return safe.lower() or "projet"


def _release_locks(project_id: str) -> None:
    """Libère le client ChromaDB et le verrou graphe avant de lire / supprimer
    le dossier — indispensable sous Windows où SQLite garde `vectors/` verrouillé
    (même séquence que ``delete_project``)."""
    evict_collection(project_id)
    evict_graph_lock(project_id)
    gc.collect()


class _ZipBuffer:
    """Réceptacle d'écriture pour ``zipfile.ZipFile`` : il n'expose ni ``seek``
    ni ``tell``, ce qui force zipfile en mode non-seekable (data descriptors).
    Un générateur peut ainsi vider (`drain`) les octets produits au fil de
    l'eau au lieu de matérialiser toute l'archive en mémoire ou sur disque."""

    def __init__(self) -> None:
        self._parts: list[bytes] = []

    def write(self, b: bytes, /) -> int:
        self._parts.append(bytes(b))
        return len(b)

    def flush(self) -> None:  # zipfile appelle flush() à la fermeture
        pass

    def close(self) -> None:  # requis par le protocole zipfile._ZipWritable
        pass

    def drain(self) -> bytes:
        chunk = b"".join(self._parts)
        self._parts.clear()
        return chunk


def _iter_archive(project_id: str, name: str, include_vectors: bool) -> Iterator[bytes]:
    """Génère l'archive `.zip` du projet par morceaux, sans la stocker
    entièrement (ni en RAM ni dans un fichier temporaire) — supporte les gros
    projets, vector store inclus."""
    _release_locks(project_id)
    project_dir = PROJECTS_DIR / project_id
    buf = _ZipBuffer()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "format_version": EXPORT_FORMAT_VERSION,
            "exported_at": datetime.now(UTC).isoformat(),
            "include_vectors": include_vectors,
            "project_id": project_id,
            "name": name,
        }
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
        yield buf.drain()

        for path in sorted(project_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(project_dir)
            if not include_vectors and rel.parts and rel.parts[0] == "vectors":
                continue
            zinfo = zipfile.ZipInfo.from_file(path, rel.as_posix())
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            with zf.open(zinfo, "w") as entry, open(path, "rb") as src:
                while block := src.read(_CHUNK):
                    entry.write(block)
                    if chunk := buf.drain():
                        yield chunk
            if chunk := buf.drain():
                yield chunk
    if final := buf.drain():
        yield final


@router.get("/{project_id}/export")
async def export_project(
    project_id: str,
    include_vectors: bool = Query(default=True),
) -> StreamingResponse:
    info = await asyncio.to_thread(_read_project, project_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Project not found")

    filename = f"{_slugify(info.name)}.papers.zip"
    return StreamingResponse(
        _iter_archive(project_id, info.name, include_vectors),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _check_member(name: str) -> None:
    """Rejette les entrées d'archive qui sortiraient du dossier projet."""
    parts = Path(name).parts
    if Path(name).is_absolute() or name.startswith(("/", "\\")) or ".." in parts:
        raise HTTPException(status_code=422, detail=f"Entrée d'archive rejetée : {name}")


def _safe_dest(base: Path, member_name: str) -> Path:
    """Résout la destination d'une entrée et vérifie qu'elle reste bien
    *dans* ``base`` — défense indépendante de ``_check_member``, robuste aux
    cas dépendants de la plateforme (lettres de lecteur / UNC sous Windows)."""
    base_resolved = base.resolve()
    dest = (base / member_name).resolve()
    if dest != base_resolved and base_resolved not in dest.parents:
        raise HTTPException(status_code=422, detail=f"Entrée d'archive rejetée : {member_name}")
    return dest


def _import_archive(raw: bytes, mode: ImportMode) -> ProjectInfo:
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=422, detail="Fichier .zip invalide") from None

    with zf:
        members = zf.infolist()
        for m in members:
            _check_member(m.filename)

        total_uncompressed = sum(m.file_size for m in members)
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
            raise HTTPException(status_code=413, detail="Archive décompressée trop volumineuse")

        try:
            proj_raw = zf.read("project.json")
        except KeyError:
            raise HTTPException(
                status_code=422, detail="Archive invalide : project.json manquant"
            ) from None
        try:
            src = ProjectInfo(**json.loads(proj_raw))
        except Exception as exc:
            raise HTTPException(
                status_code=422, detail="Archive invalide : project.json corrompu"
            ) from exc

        conflict = (PROJECTS_DIR / src.id).exists()
        if mode == "auto" and conflict:
            raise HTTPException(
                status_code=409,
                detail={"conflict": True, "id": src.id, "name": src.name},
            )

        if mode == "duplicate":
            target_id = str(uuid.uuid4())
            target_name = f"{src.name} (copie)"
        else:  # "replace", ou "auto" sans conflit
            target_id = src.id
            target_name = src.name

        target_dir = PROJECTS_DIR / target_id
        final = ProjectInfo(id=target_id, name=target_name, created_at=src.created_at)

        # Extraction crash-safe : on déballe d'abord dans un dossier de transit
        # voisin (même volume → `rename` atomique), puis on bascule. Si
        # l'extraction échoue à mi-chemin (disque plein, membre corrompu), le
        # projet cible existant reste intact — aucune perte de données.
        PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        staging = PROJECTS_DIR / f".import-{uuid.uuid4()}"
        staging.mkdir(parents=True)
        try:
            for m in members:
                if m.is_dir() or m.filename == MANIFEST_NAME:
                    continue
                dest = _safe_dest(staging, m.filename)
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(m) as src_fp, open(dest, "wb") as out_fp:
                    shutil.copyfileobj(src_fp, out_fp)

            # project.json reçoit l'id/nom cible (essentiel en mode duplicate).
            # Le vector store ChromaDB sous `vectors/` est copié verbatim : il
            # est auto-contenu (PersistentClient rooté sur `vectors/`, nom de
            # collection constant `papers`, aucun project_id stocké à
            # l'intérieur), donc le duplicata fonctionne sans réindexation. Le
            # seul cache project_id-keyé (`_collection_cache` / `_client_cache`)
            # est en mémoire et neuf pour le nouvel id.
            (staging / "project.json").write_text(
                json.dumps(final.model_dump(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            # Bascule : la suppression de l'ancien dossier n'a lieu qu'une fois
            # l'extraction entièrement réussie.
            if target_dir.exists():
                _release_locks(target_id)
                shutil.rmtree(target_dir)
            staging.rename(target_dir)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    return final


async def _read_capped(file: UploadFile) -> bytes:
    """Lit le fichier téléversé en bornant la taille pour éviter qu'une archive
    démesurée ne sature la mémoire."""
    parts: list[bytes] = []
    total = 0
    while block := await file.read(_CHUNK):
        total += len(block)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Archive trop volumineuse")
        parts.append(block)
    return b"".join(parts)


@router.post("/import", response_model=ProjectInfo, status_code=201)
async def import_project(
    file: UploadFile = File(...),
    mode: ImportMode = Query(default="auto"),
) -> ProjectInfo:
    raw = await _read_capped(file)
    return await asyncio.to_thread(_import_archive, raw, mode)
