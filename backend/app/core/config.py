from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "TrackFlow"
    environment: str = "development"
    database_url: str = "postgresql+psycopg://trackflow:trackflow_dev_pw@localhost:5434/trackflow"

    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 60 * 12
    jwt_algorithm: str = "HS256"

    upload_dir: Path = BASE_DIR / "uploads"
    max_upload_mb: int = 25
    allowed_upload_extensions: str = (
        "png,jpg,jpeg,gif,webp,pdf,txt,md,csv,log,json,xml,yaml,yml,zip,gz,tar,doc,docx,xls,xlsx,ppt,pptx"
    )

    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    frontend_dist: Path = BASE_DIR.parent / "frontend" / "dist"

    # Bootstrap admin created on first startup if no users exist.
    bootstrap_admin_email: str = "admin@trackflow.local"
    bootstrap_admin_password: str = "admin12345"

    @field_validator("database_url")
    @classmethod
    def normalize_database_url(cls, v: str) -> str:
        """Accept the URL formats hosting providers hand out (Aiven, Heroku, Render…): postgres://…,
        postgresql://… — and use the psycopg 3 driver this app ships with."""
        v = v.strip()
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v

    @property
    def allowed_extensions(self) -> set[str]:
        return {e.strip().lower() for e in self.allowed_upload_extensions.split(",") if e.strip()}

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
