from __future__ import annotations

import asyncio
import gc
import json
import shutil
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.chroma import evict_collection
from app.config import PROJECTS_DIR

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectInfo(BaseModel):
    id: str
    name: str
    created_at: str


class CreateProjectRequest(BaseModel):
    name: str


def _read_project(project_id: str) -> ProjectInfo | None:
    path = PROJECTS_DIR / project_id / "project.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return ProjectInfo(**data)


def _list_all_projects() -> list[ProjectInfo]:
    if not PROJECTS_DIR.exists():
        return []
    projects: list[ProjectInfo] = []
    for entry in PROJECTS_DIR.iterdir():
        if not entry.is_dir():
            continue
        p = _read_project(entry.name)
        if p is not None:
            projects.append(p)
    return sorted(projects, key=lambda p: p.created_at, reverse=True)


@router.get("/", response_model=list[ProjectInfo])
async def list_projects() -> list[ProjectInfo]:
    return await asyncio.to_thread(_list_all_projects)


@router.post("/", response_model=ProjectInfo, status_code=201)
async def create_project(body: CreateProjectRequest) -> ProjectInfo:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Project name cannot be empty")
    if len(name) > 80:
        raise HTTPException(status_code=422, detail="Project name must be 80 characters or fewer")

    project_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()

    def _create() -> ProjectInfo:
        project_dir = PROJECTS_DIR / project_id
        (project_dir / "pdfs").mkdir(parents=True, exist_ok=True)
        (project_dir / "vectors").mkdir(parents=True, exist_ok=True)
        info = ProjectInfo(id=project_id, name=name, created_at=created_at)
        (project_dir / "project.json").write_text(
            json.dumps(info.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return info

    return await asyncio.to_thread(_create)


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str) -> None:
    info = await asyncio.to_thread(_read_project, project_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Project not found")

    evict_collection(project_id)
    gc.collect()

    await asyncio.to_thread(shutil.rmtree, str(PROJECTS_DIR / project_id))
