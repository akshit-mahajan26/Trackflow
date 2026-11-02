import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function login(page: Page, username: string, password = "demo12345") {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();
}

async function apiToken(request: APIRequestContext, username: string) {
  const r = await request.post("/api/auth/login", { data: { username, password: "demo12345" } });
  return (await r.json()).access_token as string;
}

async function getIssue(request: APIRequestContext, token: string, key: string) {
  const r = await request.get(`/api/issues/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

test("login fails with a wrong password and succeeds with the right one", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill("marco");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid username or password");
  await login(page, "marco");
});

test("create an issue from the quick-create modal and edit it inline", async ({ page, request }) => {
  await login(page, "lena");
  await page.goto("/projects/WEB/issues");
  await page.getByRole("button", { name: "Create" }).last().click();
  const dialog = page.getByRole("dialog", { name: "Create issue" });
  await dialog.getByLabel("Issue type").selectOption("bug");
  await dialog.getByLabel("Summary").fill("E2E: search results flicker on refresh");
  await dialog.getByLabel("Description").fill("Seen on Chrome. cc @sam");
  await dialog.getByLabel("Priority").selectOption("high");
  await dialog.getByLabel("Story points").fill("3");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page).toHaveURL(/\/issues\/WEB-\d+$/);
  const key = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: "E2E: search results flicker on refresh" })).toBeVisible();

  // inline summary edit is persisted
  await page.getByRole("heading", { name: "E2E: search results flicker on refresh" }).click();
  await page.getByLabel("Summary").fill("E2E: search results flicker after refresh");
  await page.getByLabel("Summary").press("Enter");
  await expect(page.getByRole("heading", { name: "E2E: search results flicker after refresh" })).toBeVisible();

  const token = await apiToken(request, "lena");
  const issue = await getIssue(request, token, key);
  expect(issue.summary).toBe("E2E: search results flicker after refresh");
  expect(issue.issue_type).toBe("bug");
  expect(issue.story_points).toBe(3);

  // @sam was mentioned → sam has a notification
  const samToken = await apiToken(request, "sam");
  const notes = await (await request.get("/api/notifications", { headers: { Authorization: `Bearer ${samToken}` } })).json();
  expect(notes.items.some((n: { kind: string; issue_key: string }) => n.kind === "mention" && n.issue_key === key)).toBe(true);
});

test("drag a card to another column on the scrum board", async ({ page, request }) => {
  await login(page, "sam");
  await page.goto("/projects/WEB/board");
  const card = page.getByLabel(/WEB-25 Show password strength meter/);
  const target = page.getByTestId("column-In Progress");
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 20, { steps: 15 });
  await page.mouse.up();

  await expect(target.getByLabel(/WEB-25/)).toBeVisible();
  const token = await apiToken(request, "sam");
  await expect.poll(async () => (await getIssue(request, token, "WEB-25")).status.name).toBe("In Progress");
});

test("comment on an issue and see it in history", async ({ page }) => {
  await login(page, "ana");
  await page.goto("/issues/WEB-11");
  await page.getByLabel("New comment").fill("QA note: layout breaks below 360px wide.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("QA note: layout breaks below 360px wide.")).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("commented").first()).toBeVisible();
});

test("viewer role sees no create or drag affordances and the API refuses writes", async ({ page, request }) => {
  await login(page, "omar");
  await page.goto("/issues/WEB-11");
  await expect(page.getByLabel("New comment")).toHaveCount(0);
  await expect(page.getByLabel("Change status")).toHaveCount(0);
  const token = await apiToken(request, "omar");
  const r = await request.patch("/api/issues/WEB-11", { data: { summary: "hacked" }, headers: { Authorization: `Bearer ${token}` } });
  expect(r.status()).toBe(403);
});

test("TQL search, saved filter and CSV export", async ({ page }) => {
  await login(page, "marco");
  await page.goto("/projects/WEB/issues");
  await page.getByRole("button", { name: "TQL (advanced)" }).click();
  await page.getByLabel("TQL query").fill("type = bug AND statusCategory != done ORDER BY priority DESC");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/tql=/);
  const rows = page.locator("tbody tr");
  // previous results stay visible while the new query loads, so wait for the filtered set
  await expect.poll(async () => {
    const texts = await rows.allInnerTexts();
    return texts.length > 0 && texts.every((t) => !t.includes("DONE"));
  }).toBe(true);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("issues.csv");

  await page.getByRole("button", { name: /Filters/ }).click();
  await page.getByText("Save current filter…").click();
  await page.getByRole("dialog").getByLabel("Name").fill("Open bugs");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Filter saved")).toBeVisible();
});

test("plan and start a sprint from the backlog", async ({ page, request }) => {
  await login(page, "marco");
  await page.goto("/projects/WEB/backlog");
  await page.getByRole("button", { name: "Create sprint" }).click();
  await page.getByRole("dialog").getByLabel("Sprint name").fill("E2E Sprint");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("E2E Sprint")).toBeVisible();
  const token = await apiToken(request, "marco");
  const sprints = await (await request.get("/api/projects/WEB/sprints", { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(sprints.some((s: { name: string; state: string }) => s.name === "E2E Sprint" && s.state === "future")).toBe(true);
});

test("theme toggle switches to dark mode", async ({ page }) => {
  await login(page, "marco");
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("admin deletes a person who left; they lose access and vanish from user lists", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill("admin");
  await page.getByLabel("Password").fill("admin12345");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();
  await page.goto("/admin?tab=users");
  await page.getByRole("button", { name: "Actions for Ken Watanabe" }).click();
  await page.getByRole("button", { name: "Delete user" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Delete permanently" })).toBeDisabled();
  await dialog.getByLabel("Type ken to confirm").fill("ken");
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByText(/Ken Watanabe deleted/)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "@ken" })).toHaveCount(0);

  const r = await request.post("/api/auth/login", { data: { username: "ken", password: "demo12345" } });
  expect(r.status()).toBe(401);
  await page.goto("/issues/WEB-7");  // bug Ken resolved: history and work remain, attributed to "Former user"
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Former user").first()).toBeVisible();
  await expect(page.getByText("Ken Watanabe")).toHaveCount(0);
});

test("admin row actions menu: deactivate needs confirmation, reactivate is immediate", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill("admin");
  await page.getByLabel("Password").fill("admin12345");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();
  await page.goto("/admin?tab=users");
  await page.getByRole("button", { name: "Actions for Ana Souza" }).click();
  await page.screenshot({ path: "test-results/admin-row-menu.png" });
  await page.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("dialog", { name: "Deactivate Ana Souza?" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText("Ana Souza deactivated")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "@ana" })).toContainText("Deactivated");
  await page.getByRole("button", { name: "Actions for Ana Souza" }).click();
  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(page.getByText("Ana Souza reactivated")).toBeVisible();
  // the admin's own row offers no deactivate/delete
  await page.getByRole("button", { name: "Actions for Administrator" }).click();
  await expect(page.getByRole("button", { name: "Delete user" })).toHaveCount(0);
});

test("typing in the delete-project confirmation keeps focus in the field", async ({ page, request }) => {
  const login = await request.post("/api/auth/login", { data: { username: "admin", password: "admin12345" } });
  const token = (await login.json()).access_token;
  await request.post("/api/projects", { data: { key: "TMP", name: "Temporary" }, headers: { Authorization: `Bearer ${token}` } });

  await page.goto("/login");
  await page.getByLabel("Username or email").fill("admin");
  await page.getByLabel("Password").fill("admin12345");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();
  await page.goto("/projects/TMP/settings?tab=danger");
  await page.getByRole("button", { name: "Delete…" }).click();
  const box = page.getByLabel("Confirm project key");
  await expect(box).toBeFocused();
  await page.keyboard.type("TMP", { delay: 80 });   // real per-key typing, no re-clicking
  await expect(box).toHaveValue("TMP");
  await expect(box).toBeFocused();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  expect((await request.get("/api/projects/TMP", { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(404);
});
