"""Endpoints for the two-layer application settings.

- ``/settings``                      — global defaults (GET / PUT).
- ``/projects/{id}/settings``         — per-project overrides (GET / PUT). The
  GET returns the overrides, the global defaults, and the resolved effective
  values in one payload so the UI needs a single round-trip.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import PROJECTS_DIR
from app.settings import (
    AppSettings,
    ProjectSettings,
    ResolvedSettings,
    read_global_settings,
    read_project_settings,
    resolve_settings,
    write_global_settings,
    write_project_settings,
)

router = APIRouter(tags=["settings"])


class ProjectSettingsBundle(BaseModel):
    """Everything the project settings UI needs in one fetch."""

    overrides: ProjectSettings
    global_defaults: AppSettings
    resolved: ResolvedSettings


def _project_exists(project_id: str) -> bool:
    return (PROJECTS_DIR / project_id).exists()


def _bundle(project_id: str) -> ProjectSettingsBundle:
    return ProjectSettingsBundle(
        overrides=read_project_settings(project_id),
        global_defaults=read_global_settings(),
        resolved=resolve_settings(project_id),
    )


@router.get("/settings", response_model=AppSettings)
async def get_global_settings() -> AppSettings:
    return await asyncio.to_thread(read_global_settings)


@router.put("/settings", response_model=AppSettings)
async def put_global_settings(body: AppSettings) -> AppSettings:
    return await asyncio.to_thread(write_global_settings, body)


@router.get("/projects/{project_id}/settings", response_model=ProjectSettingsBundle)
async def get_project_settings(project_id: str) -> ProjectSettingsBundle:
    if not _project_exists(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    return await asyncio.to_thread(_bundle, project_id)


@router.put("/projects/{project_id}/settings", response_model=ProjectSettingsBundle)
async def put_project_settings(project_id: str, body: ProjectSettings) -> ProjectSettingsBundle:
    if not _project_exists(project_id):
        raise HTTPException(status_code=404, detail="Project not found")

    def _write() -> ProjectSettingsBundle:
        write_project_settings(project_id, body)
        return _bundle(project_id)

    return await asyncio.to_thread(_write)


__all__ = ["ProjectSettingsBundle", "router"]
