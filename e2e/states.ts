// A state is a page after something goes wrong or a list is empty.
import type { Page } from "@playwright/test";

export type PageState = { name: string; path: string; prepare: (page: Page) => Promise<void> };

const LEDGER = "http://localhost:7700/ledger";

export const states: PageState[] = [
  {
    name: "ledger with no invoices",
    path: LEDGER,
    prepare: async (page) => {
      await page.route("**/api/ledger", (route) => route.fulfill({ json: [] }));
      await page.waitForSelector("[data-empty-state]", { timeout: 5000 }).catch(() => null);
    },
  },
  {
    name: "ledger that did not load",
    path: LEDGER,
    prepare: async (page) => {
      await page.route("**/api/ledger", (route) => route.abort());
      await page.waitForSelector("[role=alert]:not([hidden])", { timeout: 5000 }).catch(() => null);
    },
  },
];
