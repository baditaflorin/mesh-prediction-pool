import { expect, test, type Page } from "@playwright/test";
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

/** Read the shared market id and a peer's own id from the live Yjs doc. */
async function readRoom(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __ppRoom?: {
        doc: { getArray: (k: string) => { toArray: () => unknown[] } };
        peerId: string;
      };
    };
    const h = w.__ppRoom;
    if (!h) throw new Error("test handle window.__ppRoom not present");
    const markets = h.doc.getArray("markets").toArray() as { id: string; peerId: string }[];
    return { peerId: h.peerId, marketId: markets[0]?.id ?? null };
  });
}

/** Seed one bet straight into the shared `bets` Y.Array from a peer's process. */
async function seedBet(
  page: Page,
  bet: { marketId: string; peerId: string; side: "yes" | "no"; amount: number },
) {
  await page.evaluate((b) => {
    const w = window as unknown as {
      __ppRoom?: { doc: { getArray: (k: string) => { push: (xs: unknown[]) => void } } };
    };
    const h = w.__ppRoom;
    if (!h) throw new Error("test handle window.__ppRoom not present");
    h.doc.getArray("bets").push([
      {
        id: Math.random().toString(36).slice(2, 10),
        marketId: b.marketId,
        peerId: b.peerId,
        side: b.side,
        amount: b.amount,
        ts: Date.now(),
      },
    ]);
  }, bet);
}

/**
 * Load-bearing payout test: resolving a market must pay each winner their
 * stake back PLUS a share of the losers' pool that is PROPORTIONAL to their
 * stake among the winners — and both peers must compute the same balances.
 *
 * Scenario (single market, resolved YES):
 *   alice  300 YES   ─┐ winners, wTotal = 400
 *   bob    100 YES   ─┘
 *   bob    200 NO     →  losers' pool = 200
 *
 * Proportional split of the 200 pool by winning stake (300:100 = 3:1):
 *   alice payout = 300 + (300/400)*200 = 450   → balance 1000-300+450 = 1150
 *   bob   payout = 100 + (100/400)*200 = 150   → balance 1000-100-200+150 = 850
 *   (tokens conserved: 1150 + 850 = 2000)
 *
 * Catches: equal-split (would pay each winner 100 of the pool → 1100/900),
 * winner-takes-whole-pool, payouts written to local-only state (peer B would
 * disagree), or stake not returned. A naive 50/50 stub cannot fake 1150/850.
 */
test("resolved market splits the losers' pool proportionally; both peers agree on balances", async ({
  browser,
  baseURL,
}) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", { storagePrefix });
  try {
    await a.getByPlaceholder("your name").fill("alice");
    await b.getByPlaceholder("your name").fill("bob");
    await a.waitForTimeout(500);

    // Alice opens the market (so the resolve buttons are hers).
    await a.getByPlaceholder("question").fill("Will the pool split correctly?");
    await a.getByRole("button", { name: "open market", exact: true }).click();
    await expect(b.locator(".pp-market")).toContainText("Will the pool split correctly?");

    // Resolve the market id from the shared doc on both peers.
    const aInfo = await readRoom(a);
    const bInfo = await readRoom(b);
    expect(aInfo.marketId).not.toBeNull();
    expect(bInfo.marketId).toBe(aInfo.marketId);
    const mid = aInfo.marketId as string;

    // Seed exact bets: two winners on YES (300 + 100) and one loser on NO (200).
    await seedBet(a, { marketId: mid, peerId: aInfo.peerId, side: "yes", amount: 300 });
    await seedBet(b, { marketId: mid, peerId: bInfo.peerId, side: "yes", amount: 100 });
    await seedBet(b, { marketId: mid, peerId: bInfo.peerId, side: "no", amount: 200 });

    // Wait until all three bets have propagated into BOTH peers' docs.
    for (const page of [a, b]) {
      await page.waitForFunction(() => {
        const w = window as unknown as {
          __ppRoom?: { doc: { getArray: (k: string) => { length: number } } };
        };
        return (w.__ppRoom?.doc.getArray("bets").length ?? 0) === 3;
      });
    }

    // Sanity: pre-resolution the totals show 400 yes / 200 no on both peers.
    for (const page of [a, b]) {
      await expect(page.locator(`.pp-market[data-market-id="${mid}"] .pp-totals`)).toContainText(
        "yes: 400",
      );
      await expect(page.locator(`.pp-market[data-market-id="${mid}"] .pp-totals`)).toContainText(
        "no: 200",
      );
    }

    // Alice resolves YES → settlement runs in the shared doc.
    await a.getByRole("button", { name: "resolve YES", exact: true }).click();

    // --- Each peer's OWN balance, computed from the shared payout map ---
    // alice 1150 (1000-300+450), bob 850 (1000-100-200+150).
    await expect(a.locator(".pp-balance")).toContainText("your balance: 1150");
    await expect(b.locator(".pp-balance")).toContainText("your balance: 850");

    // --- CROSS-PEER agreement: read the shared payout map from BOTH peers and
    // assert each computes the same proportional split. This is what fails if
    // payouts are local-only (peer B would see zeros) or the math is wrong. ---
    const split = async (page: Page) =>
      page.evaluate(
        ({ mid, alice, bob }) => {
          const w = window as unknown as {
            __ppRoom?: { doc: { getMap: (k: string) => Map<string, number> } };
          };
          const p = w.__ppRoom!.doc.getMap("payouts");
          return {
            alice: p.get(`${mid}|${alice}`) ?? 0,
            bob: p.get(`${mid}|${bob}`) ?? 0,
          };
        },
        { mid, alice: aInfo.peerId, bob: bInfo.peerId },
      );

    // Wait for the settled-payout map (2 winner entries + the __settled tag)
    // to propagate into BOTH peers' docs before reading the split.
    for (const page of [a, b]) {
      await page.waitForFunction(() => {
        const w = window as unknown as {
          __ppRoom?: { doc: { getMap: (k: string) => { size: number } } };
        };
        return (w.__ppRoom?.doc.getMap("payouts").size ?? 0) >= 3;
      });
    }

    const aSplit = await split(a);
    const bSplit = await split(b);
    // Alice (winning stake 300) takes 300 + (300/400)*200 = 450.
    // Bob   (winning stake 100) takes 100 + (100/400)*200 = 150.
    expect(aSplit).toEqual({ alice: 450, bob: 150 });
    expect(bSplit).toEqual({ alice: 450, bob: 150 });

    // Alice's per-market payout chip shows HER 450 on both peers' market view.
    await expect(a.locator(`.pp-market[data-market-id="${mid}"] .pp-resolved`)).toContainText(
      "your payout: 450",
    );
  } finally {
    await cleanup();
  }
});
