import { expect, test } from "@playwright/test";

test("a signed-in user sees only projects authorized by the gateway", async ({
  page,
}) => {
  await page.goto("/");

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

test("an authorized command updates the live board and survives reload", async ({
  page,
}) => {
  await page.goto("/");
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

test("switching principal replaces the synchronized workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Signed in user").selectOption("user-jon");

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
