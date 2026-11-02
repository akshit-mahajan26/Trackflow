import { defineConfig, devices } from "@playwright/test";

// E2E runs against a dedicated, freshly reset database so it never touches dev data.
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgresql+psycopg://trackflow:trackflow_dev_pw@localhost:5434/trackflow_e2e";
const PORT = 8011;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: `npm run build && cd ../backend && .venv/bin/python -m scripts.reset_db && .venv/bin/uvicorn app.main:app --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_URL: E2E_DB, ENVIRONMENT: "development", UPLOAD_DIR: "./.e2e-uploads" },
  },
});
