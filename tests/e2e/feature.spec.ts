import { expect, test } from "@playwright/test";
import { openTwoPeers } from "@baditaflorin/mesh-common/testing";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
};
const storagePrefix = pkg.name;

test("alice opens a market → bob sees it and can bet", async ({ browser, baseURL }) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", { storagePrefix });
  try {
    await a.getByPlaceholder("your name").fill("alice");
    await b.getByPlaceholder("your name").fill("bob");
    await a.waitForTimeout(500);

    await a.getByPlaceholder("question").fill("Will alice ship by friday?");
    await a.getByRole("button", { name: "open market", exact: true }).click();

    await expect(b.locator(".pp-market")).toContainText("Will alice ship by friday?");
    await expect(b.locator(".pp-market")).toContainText("alice");

    // bob bets 100 yes
    await b.locator('.pp-market input[type="number"]').first().fill("100");
    await b.getByRole("button", { name: "bet yes", exact: true }).click();
    await a.waitForTimeout(400);

    // alice sees bet total
    await expect(a.locator(".pp-market")).toContainText("100");
  } finally {
    await cleanup();
  }
});
