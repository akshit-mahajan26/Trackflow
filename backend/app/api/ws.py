from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.deps import accessible_project_ids, user_from_token
from app.core.database import SessionLocal
from app.services.realtime import manager

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str | None = None):
    # Browsers cannot set Authorization headers on WebSockets, so the JWT is passed as a query param.
    with SessionLocal() as db:
        user = user_from_token(db, token)
        if not user:
            await ws.close(code=4401)
            return
        ids = accessible_project_ids(db, user)
        user_id = user.id
    await manager.connect(ws, user_id, None if ids is None else set(ids))
    try:
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_text('{"type":"pong"}')
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws, user_id)
