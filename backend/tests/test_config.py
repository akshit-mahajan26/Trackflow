import pytest

from app.core.config import Settings


@pytest.mark.parametrize("given", [
    "postgres://u:p@db.example.com:26886/defaultdb?sslmode=require",
    "postgresql://u:p@db.example.com:26886/defaultdb?sslmode=require",
    "postgresql+psycopg://u:p@db.example.com:26886/defaultdb?sslmode=require",
    "  postgres://u:p@db.example.com:26886/defaultdb?sslmode=require\n",
])
def test_database_url_accepts_provider_formats(given):
    s = Settings(database_url=given, _env_file=None)
    assert s.database_url == "postgresql+psycopg://u:p@db.example.com:26886/defaultdb?sslmode=require"
