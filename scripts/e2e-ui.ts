// Browser steps shared by the e2e run and the screenshot script.
// Each step finds things by role or visible text, so it does not depend on a CSS class.
import type { Page } from "playwright";

const WAIT_MS = 30_000;

// Ask one question in the chat box and wait for an answer to show up.
export async function askQuestion(page: Page, question: string): Promise<void> {
  const box = page.getByRole("textbox").first();
  await box.fill(question);
  await box.press("Enter");
  await page
    .getByText(/answer|territory|total/i)
    .first()
    .waitFor({ timeout: WAIT_MS });
}

// Click the chart the Agent Chat UI draws for a numbers answer.
export async function clickChart(page: Page): Promise<void> {
  const chart = page.locator("svg, canvas, [role='img']").first();
  await chart.waitFor({ state: "visible", timeout: WAIT_MS });
  await chart.click();
}

// Click the approval card. Pass "Approve" or "Reject" to choose the answer.
export async function clickApproval(page: Page, choice: "Approve" | "Reject" = "Approve") {
  const button = page.getByRole("button", { name: new RegExp(choice, "i") }).first();
  await button.waitFor({ state: "visible", timeout: WAIT_MS });
  await button.click();
}
