import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, name: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page
    .getByRole("button", { name: new RegExp(`Continue as ${name}`) })
    .click();
}

test("login routes a user into only projects authorized by the gateway", async ({
  page,
}) => {
  await signIn(page, "Maya Chen");

  await expect(page).toHaveURL(/\/projects\/project-hydb$/);
  await expect(page.getByTestId("current-user")).toContainText("Maya Chen");
  await expect(page.getByRole("button", { name: /HyDB launch/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Studio refresh/ }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Harden incremental joins" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Polish workspace navigation" }),
  ).not.toBeVisible();
});

test("my tasks routes to the principal's assigned work", async ({ page }) => {
  await signIn(page, "Maya Chen");
  await page.getByRole("button", { name: /My tasks/ }).click();

  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Harden incremental joins" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Design command ergonomics" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Polish workspace navigation" }),
  ).not.toBeVisible();
});

test("team routes to the readable directory with authorized workloads", async ({
  page,
}) => {
  await signIn(page, "Maya Chen");
  await page.getByRole("button", { name: "Team" }).click();

  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  for (const name of ["Maya Chen", "Jon Bell", "Nia Okafor", "Luca Reyes"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.getByTestId("team-member-user-maya")).toContainText(
    "1 assigned task",
  );
});

test("an authorized command updates the live board and survives reload", async ({
  page,
}) => {
  await signIn(page, "Maya Chen");
  await expect(page.getByTestId("current-user")).toContainText("Maya Chen");

  await page.getByRole("button", { name: "Add task" }).first().click();
  await page.getByLabel("Task title").fill("Verify durable gateway writes");
  await page
    .getByLabel("Description")
    .fill("Created through a policy-aware HyApp command.");
  await page.getByRole("button", { name: "Create task" }).click();

  const createdTask = page.getByRole("heading", {
    name: "Verify durable gateway writes",
  });
  await expect(createdTask).toBeVisible();

  await page.reload();
  await expect(createdTask).toBeVisible();
});

test("logging out and changing identity replaces the synchronized workspace", async ({
  page,
}) => {
  await signIn(page, "Maya Chen");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: /Continue as Jon Bell/ }).click();

  await expect(page).toHaveURL(/\/projects\/project-studio$/);
  await expect(page.getByTestId("current-user")).toContainText("Jon Bell");
  await expect(
    page.getByRole("button", { name: /Studio refresh/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /HyDB launch/ }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Polish workspace navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Harden incremental joins" }),
  ).not.toBeVisible();
});
