# Single image: builds the React UI, then serves UI + API from FastAPI on port 8000.
FROM node:22-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npx vite build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=ui /ui/dist /app/frontend/dist
RUN useradd --create-home trackflow && mkdir -p /data/uploads && chown -R trackflow /data /app
USER trackflow
ENV UPLOAD_DIR=/data/uploads ENVIRONMENT=production
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/api/health').status!=200)"
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --workers 1"]
