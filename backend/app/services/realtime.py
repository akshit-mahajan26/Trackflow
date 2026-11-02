"""In-process WebSocket fan-out.

Events are queued on the SQLAlchemy session (`queue_event`) and only published once
the transaction commits, so clients never see changes that were rolled back.

This runs in a single process. For multiple uvicorn workers, replace `publish` with a
Redis pub/sub bridge.
"""

import asyncio
import json
import logging
from collections import defaultdict

from fastapi import WebSocket
from sqlalchemy import event
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self._by_user: dict[int, set[WebSocket]] = defaultdict(set)
        self._project_access: dict[WebSocket, set[int] | None] = {}

    async def connect(self, ws: WebSocket, user_id: int, project_ids: set[int] | None) -> None:
        await ws.accept()
        self._by_user[user_id].add(ws)
        self._project_access[ws] = project_ids

    def disconnect(self, ws: WebSocket, user_id: int) -> None:
        self._by_user[user_id].discard(ws)
        self._project_access.pop(ws, None)

    def update_access(self, user_id: int, project_ids: set[int] | None) -> None:
        for ws in self._by_user.get(user_id, ()):
            self._project_access[ws] = project_ids

    @property
    def connection_count(self) -> int:
        return len(self._project_access)

    async def _send(self, ws: WebSocket, message: str) -> None:
        try:
            await ws.send_text(message)
        except Exception:  # noqa: BLE001 - dropped connections are cleaned up by the receive loop
            log.debug("websocket send failed", exc_info=True)

    async def _dispatch(self, evt: dict) -> None:
        message = json.dumps(evt, default=str)
        targets: list[WebSocket] = []
        if (uid := evt.get("user_id")) is not None:
            targets = list(self._by_user.get(uid, ()))
        elif (pid := evt.get("project_id")) is not None:
            targets = [ws for ws, access in self._project_access.items() if access is None or pid in access]
        await asyncio.gather(*(self._send(ws, message) for ws in targets))

    def publish(self, evt: dict) -> None:
        if self.loop is None or self.loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.loop.create_task(self._dispatch(evt))
        else:
            asyncio.run_coroutine_threadsafe(self._dispatch(evt), self.loop)


manager = ConnectionManager()


def queue_event(db: Session, type_: str, *, project_id: int | None = None, user_id: int | None = None, **data) -> None:
    db.info.setdefault("pending_events", []).append(
        {"type": type_, "project_id": project_id, "user_id": user_id, **data}
    )


@event.listens_for(Session, "after_commit")
def _flush_events(session: Session) -> None:
    for evt in session.info.pop("pending_events", []):
        manager.publish(evt)


@event.listens_for(Session, "after_rollback")
def _drop_events(session: Session) -> None:
    session.info.pop("pending_events", None)
