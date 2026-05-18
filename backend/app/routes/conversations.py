from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.config import PROJECTS_DIR
from app.llm_service import LLMProvider

router = APIRouter(prefix="/projects/{project_id}/conversations", tags=["conversations"])

DEFAULT_TITLE = "Nouvelle conversation"
# Max length when auto-deriving a title from the first user message — kept
# short so the conversation list stays scannable.
TITLE_MAX_LEN = 60
# Max length for an explicit user-typed rename — more permissive than the
# auto-derived limit since the user has deliberately chosen the title.
RENAME_TITLE_MAX_LEN = 120


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
    # Regenerated answers of the *last* message, kept so the UI can offer
    # left/right navigation between them. `last_variants[last_variant_index]`
    # always mirrors `messages[-1].content`. Empty when the last message was
    # never regenerated. Cleared whenever the conversation gains a new tail
    # (append / full replace). Persisted to disk.
    last_variants: list[str] = []
    last_variant_index: int = 0
    # Pagination metadata: populated on read by `get_conversation`, never
    # written to disk (see `_write_conversation`). Default 0 keeps the model
    # constructible from raw JSON files that don't carry these keys.
    message_count: int = 0
    messages_offset: int = 0


class AppendMessagesPayload(BaseModel):
    messages: list[ConversationMessage]


class AddVariantRequest(BaseModel):
    """A regenerated answer. Role is implied (assistant) — variants only ever
    apply to an assistant reply, so the request can't carry a wrong one."""

    content: str


class SelectVariantRequest(BaseModel):
    index: int


class LastVariantsState(BaseModel):
    """Variant state of a conversation's last message, returned by the
    regenerate (add) and variant-switch endpoints."""

    last_variants: list[str]
    last_variant_index: int
    message_count: int
    updated_at: str


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


_DISK_EXCLUDE_FIELDS = {"message_count", "messages_offset"}


def _write_conversation(path: Path, conv: Conversation) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            conv.model_dump(exclude=_DISK_EXCLUDE_FIELDS),
            ensure_ascii=False,
            indent=2,
        ),
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
async def get_conversation(
    project_id: str,
    conversation_id: str,
    limit: int | None = Query(default=None, ge=1, le=500),
    offset: int | None = Query(default=None, ge=0),
) -> Conversation:
    """Return a conversation, optionally windowed.

    - No `limit`/`offset`: full message array (backward-compat).
    - `limit` only: tail mode — returns the last `limit` messages.
    - `offset`+`limit`: windowed slice `messages[offset:offset+limit]`.
    - `offset` only: from `offset` to the end.

    Always populates `message_count` (total messages on disk) and
    `messages_offset` (index of `messages[0]` in the full conversation) so
    the client can paginate without a second round-trip.
    """
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")

    def _read_windowed() -> Conversation:
        conv = _read_conversation(path)
        total = len(conv.messages)
        if limit is None and offset is None:
            conv.message_count = total
            conv.messages_offset = 0
            return conv
        if offset is None:
            # limit-only → tail
            start = max(0, total - (limit or 0))
            end = total
        else:
            start = min(offset, total)
            end = min(start + (limit or total), total) if limit is not None else total
        conv.messages = conv.messages[start:end]
        conv.message_count = total
        conv.messages_offset = start
        return conv

    return await asyncio.to_thread(_read_windowed)


@router.post("/{conversation_id}/messages", response_model=ConversationSummary)
async def append_messages(
    project_id: str,
    conversation_id: str,
    body: AppendMessagesPayload,
) -> ConversationSummary:
    """Append messages to an existing conversation without reading or
    rewriting the full message history client-side. Designed for the
    tail-loaded chat flow: the client doesn't hold the entire conversation,
    so a full-replace PUT would be destructive."""
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")

    def _append() -> ConversationSummary:
        existing = _read_conversation(path)
        existing.messages.extend(body.messages)
        updated = Conversation(
            id=existing.id,
            title=existing.title,
            provider=existing.provider,
            model=existing.model,
            created_at=existing.created_at,
            updated_at=_bump_ts(existing.updated_at),
            messages=existing.messages,
        )
        _write_conversation(path, updated)
        return ConversationSummary(
            id=updated.id,
            title=updated.title,
            provider=updated.provider,
            model=updated.model,
            created_at=updated.created_at,
            updated_at=updated.updated_at,
            message_count=len(updated.messages),
        )

    return await asyncio.to_thread(_append)


@router.post("/{conversation_id}/messages/last/variants", response_model=LastVariantsState)
async def add_last_variant(
    project_id: str,
    conversation_id: str,
    body: AddVariantRequest,
) -> LastVariantsState:
    """Record a regenerated reply as a new variant of the last message.

    Backs the chat 'regenerate' action: rather than overwriting the previous
    answer, it is kept so the UI can offer left/right navigation. The first
    regeneration seeds the variant list with the answer already on disk, then
    appends the fresh one; later regenerations just append. The new variant
    becomes active (mirrored into `messages[-1]`). The rest of the (possibly
    tail-windowed) history is never read or rewritten client-side."""
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")

    def _add() -> LastVariantsState:
        existing = _read_conversation(path)
        if not existing.messages:
            raise HTTPException(status_code=409, detail="Conversation has no messages")
        # Seed with the answer currently on disk the first time around so the
        # original reply stays reachable alongside the regenerated ones.
        last = existing.messages[-1]
        variants = existing.last_variants or [last.content]
        variants.append(body.content)
        existing.messages[-1] = ConversationMessage(role=last.role, content=body.content)
        updated = Conversation(
            id=existing.id,
            title=existing.title,
            provider=existing.provider,
            model=existing.model,
            created_at=existing.created_at,
            updated_at=_bump_ts(existing.updated_at),
            messages=existing.messages,
            last_variants=variants,
            last_variant_index=len(variants) - 1,
        )
        _write_conversation(path, updated)
        return LastVariantsState(
            last_variants=updated.last_variants,
            last_variant_index=updated.last_variant_index,
            message_count=len(updated.messages),
            updated_at=updated.updated_at,
        )

    return await asyncio.to_thread(_add)


@router.put("/{conversation_id}/messages/last/variant", response_model=LastVariantsState)
async def select_last_variant(
    project_id: str,
    conversation_id: str,
    body: SelectVariantRequest,
) -> LastVariantsState:
    """Switch which recorded variant of the last message is active. The
    chosen variant's content is mirrored back into `messages[-1]`."""
    _require_project(project_id)
    path = _conversation_path(project_id, conversation_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")

    def _select() -> LastVariantsState:
        existing = _read_conversation(path)
        if not existing.messages:
            raise HTTPException(status_code=409, detail="Conversation has no messages")
        if not existing.last_variants:
            raise HTTPException(status_code=409, detail="Last message has no variants")
        if not 0 <= body.index < len(existing.last_variants):
            raise HTTPException(status_code=422, detail="Variant index out of range")
        last = existing.messages[-1]
        existing.messages[-1] = ConversationMessage(
            role=last.role,
            content=existing.last_variants[body.index],
        )
        updated = Conversation(
            id=existing.id,
            title=existing.title,
            provider=existing.provider,
            model=existing.model,
            created_at=existing.created_at,
            updated_at=_bump_ts(existing.updated_at),
            messages=existing.messages,
            last_variants=existing.last_variants,
            last_variant_index=body.index,
        )
        _write_conversation(path, updated)
        return LastVariantsState(
            last_variants=updated.last_variants,
            last_variant_index=updated.last_variant_index,
            message_count=len(updated.messages),
            updated_at=updated.updated_at,
        )

    return await asyncio.to_thread(_select)


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
    if len(title) > RENAME_TITLE_MAX_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"Title must be {RENAME_TITLE_MAX_LEN} characters or fewer",
        )

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
            # A rename touches only the title — keep the tail's variants.
            last_variants=existing.last_variants,
            last_variant_index=existing.last_variant_index,
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
