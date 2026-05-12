from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import PROJECTS_DIR
from app.llm_service import LLMProvider

router = APIRouter(prefix="/projects/{project_id}/conversations", tags=["conversations"])

DEFAULT_TITLE = "Nouvelle conversation"
TITLE_MAX_LEN = 60


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ConversationSummary(BaseModel):
    id: str
    title: str
    provider: LLMProvider
    model: str
    created_at: str
    updated_at: str
    message_count: int


class Conversation(BaseModel):
    id: str
    title: str
    provider: LLMProvider
    model: str
    created_at: str
    updated_at: str
    messages: list[ConversationMessage]


class CreateConversationRequest(BaseModel):
    title: str | None = None
    provider: LLMProvider
    model: str
    messages: list[ConversationMessage]


class UpdateConversationRequest(BaseModel):
    title: str | None = None
    provider: LLMProvider
    model: str
    messages: list[ConversationMessage]


class RenameConversationRequest(BaseModel):
    title: str


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _conversations_dir(project_id: str) -> Path:
    return _project_dir(project_id) / "conversations"


def _conversation_path(project_id: str, conversation_id: str) -> Path:
    return _conversations_dir(project_id) / f"{conversation_id}.json"


def _require_project(project_id: str) -> None:
    if not _project_dir(project_id).exists():
        raise HTTPException(status_code=404, detail="Project not found")


def _bump_ts(existing: str) -> str:
    """Return now() ISO string, guaranteed strictly greater than `existing`."""
    now = datetime.now(UTC).isoformat()
    if now <= existing:
        return (datetime.fromisoformat(existing) + timedelta(microseconds=1)).isoformat()
    return now


def _derive_title(messages: list[ConversationMessage]) -> str:
    for m in messages:
        if m.role == "user":
            stripped = m.content.strip()
            if stripped:
                return stripped[:TITLE_MAX_LEN]
    return DEFAULT_TITLE


def _read_conversation(path: Path) -> Conversation:
    data = json.loads(path.read_text(encoding="utf-8"))
    return Conversation(**data)


def _write_conversation(path: Path, conv: Conversation) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(conv.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


@router.get("/", response_model=list[ConversationSummary])
async def list_conversations(project_id: str) -> list[ConversationSummary]:
    _require_project(project_id)

    def _scan() -> list[ConversationSummary]:
        cdir = _conversations_dir(project_id)
        if not cdir.exists():
            return []
        out: list[ConversationSummary] = []
        for entry in cdir.iterdir():
            if not entry.is_file() or entry.suffix != ".json":
                continue
            try:
                conv = _read_conversation(entry)
            except (json.JSONDecodeError, ValueError):
                continue
            out.append(
                ConversationSummary(
                    id=conv.id,
                    title=conv.title,
                    provider=conv.provider,
                    model=conv.model,
                    created_at=conv.created_at,
                    updated_at=conv.updated_at,
                    message_count=len(conv.messages),
                )
            )
        return sorted(out, key=lambda c: c.updated_at, reverse=True)

    return await asyncio.to_thread(_scan)


@router.post("/", response_model=Conversation, status_code=201)
async def create_conversation(project_id: str, body: CreateConversationRequest) -> Conversation:
    _require_project(project_id)

    now = datetime.now(UTC).isoformat()
    explicit = body.title.strip() if body.title else ""
    title = explicit or _derive_title(body.messages)
    conv = Conversation(
        id=str(uuid.uuid4()),
        title=title,
        provider=body.provider,
        model=body.model,
        created_at=now,
        updated_at=now,
        messages=body.messages,
    )

    def _write() -> Conversation:
        _write_conversation(_conversation_path(project_id, conv.id), conv)
        return conv

    return await asyncio.to_thread(_write)


@router.get("/{conversation_id}", response_model=Conversation)
async def get_conversation(project_id: str, conversation_id: str) -> Conversation:
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")
    return await asyncio.to_thread(_read_conversation, path)


@router.put("/{conversation_id}", response_model=Conversation)
async def update_conversation(
    project_id: str,
    conversation_id: str,
    body: UpdateConversationRequest,
) -> Conversation:
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")

    def _write() -> Conversation:
        existing = _read_conversation(path)
        title = (
            body.title.strip()
            if body.title and body.title.strip()
            else existing.title or _derive_title(body.messages)
        )
        updated = Conversation(
            id=existing.id,
            title=title,
            provider=body.provider,
            model=body.model,
            created_at=existing.created_at,
            updated_at=_bump_ts(existing.updated_at),
            messages=body.messages,
        )
        _write_conversation(path, updated)
        return updated

    return await asyncio.to_thread(_write)


@router.patch("/{conversation_id}", response_model=Conversation)
async def rename_conversation(
    project_id: str,
    conversation_id: str,
    body: RenameConversationRequest,
) -> Conversation:
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")

    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Title cannot be empty")
    if len(title) > 120:
        raise HTTPException(status_code=422, detail="Title must be 120 characters or fewer")

    def _write() -> Conversation:
        existing = _read_conversation(path)
        updated = Conversation(
            id=existing.id,
            title=title,
            provider=existing.provider,
            model=existing.model,
            created_at=existing.created_at,
            updated_at=_bump_ts(existing.updated_at),
            messages=existing.messages,
        )
        _write_conversation(path, updated)
        return updated

    return await asyncio.to_thread(_write)


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(project_id: str, conversation_id: str) -> None:
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")
    await asyncio.to_thread(path.unlink)
