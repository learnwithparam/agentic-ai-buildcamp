// Plain terminal output for the checks: a coloured badge and a boxed title.
const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: number, text: string): string {
  return COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const green = (text: string): string => paint(32, text);
export const red = (text: string): string => paint(31, text);
export const dim = (text: string): string => paint(2, text);

export function badge(passed: boolean): string {
  return passed ? green("PASS") : red("FAIL");
}

export function box(title: string): string {
  const line = "-".repeat(title.length + 2);
  return `+${line}+\n| ${title} |\n+${line}+`;
}
