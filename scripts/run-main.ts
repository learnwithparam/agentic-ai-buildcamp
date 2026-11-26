// The one way a script starts its main(). A script's exit code is what the pre-push hook, CI and
// `npm run check` read, so a rejected promise must never end as exit 0.
// Any error that is not a clean verdict prints "<name> did not finish" and exits 1. A clean verdict
// (a red gate, a failed check) sets process.exitCode itself and returns.

export type RunMainOptions = {
  /** Shown in the message, for example "Release gate". */
  name: string;
  /** Replaced in tests. */
  exit?: (code: number) => void;
  log?: (line: string) => void;
};

export function didNotFinishMessage(name: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${name}: did not finish, so this is NOT a pass. ${reason}`;
}

export async function runMain(main: () => unknown, options: RunMainOptions): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => console.error(line));
  try {
    await main();
  } catch (error) {
    log(didNotFinishMessage(options.name, error));
    if (error instanceof Error && error.stack && process.env.DEBUG) log(error.stack);
    exit(1);
  }
}
