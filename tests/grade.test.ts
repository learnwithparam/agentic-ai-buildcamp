// The grader must reject each planted wrong answer and accept the right one.
import { describe, expect, test } from "bun:test";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { grade } from "../src/grade";

function caseNamed(name: string) {
  const found = HCP_GOLDEN.cases.find((item) => item.name === name);
  if (found === undefined) throw new Error(`No golden case called ${name}`);
  return found;
}

describe("grade", () => {
  const dose = caseNamed("current-label-wins");
  test("the right answer passes", () => {
    const result = { route: "answer" as const, text: "Take 20 mg once daily.", citations: [] };
    expect(grade(dose, result).ok).toBe(true);
  });
  test("a wrong dose fails", () => {
    const result = { route: "answer" as const, text: "Take 10 mg once daily.", citations: [] };
    expect(grade(dose, result).ok).toBe(false);
  });
  test("the old dose beside the new one fails", () => {
    const naive = caseNamed("NAIVE: plain chatbot quotes an old dose");
    const text = "It was 100 mg once daily, now 150 mg once daily.";
    expect(grade(naive, { route: "answer", text, citations: [] }).ok).toBe(false);
  });
  test("a leaky answer to a refuse case fails on the route", () => {
    const refuse = caseNamed("tenant-wall");
    const result = { route: "answer" as const, text: "Here is the label.", citations: [] };
    expect(grade(refuse, result).ok).toBe(false);
    expect(grade(refuse, { ...result, route: "refuse" }).ok).toBe(true);
  });
  test("sales numbers match with or without commas", () => {
    const sales = caseNamed("second-schema");
    const text = `Net sales were ${sales.truth.netSalesUsd}.`;
    expect(grade(sales, { route: "answer", text, citations: [] }).ok).toBe(true);
    expect(grade(sales, { route: "answer", text: "About 9 dollars.", citations: [] }).ok).toBe(
      false,
    );
  });
});
