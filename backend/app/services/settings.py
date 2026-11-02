from typing import Any

from sqlalchemy.orm import Session

from app.models import AppSetting

DEFAULTS: dict[str, Any] = {
    "site_name": "TrackFlow",
    "allow_registration": False,
    "allow_project_creation": True,  # non-admin users may create projects
}


def get_setting(db: Session, key: str) -> Any:
    row = db.get(AppSetting, key)
    return row.value if row else DEFAULTS.get(key)


def all_settings(db: Session) -> dict[str, Any]:
    return {k: get_setting(db, k) for k in DEFAULTS}


def set_setting(db: Session, key: str, value: Any) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))
