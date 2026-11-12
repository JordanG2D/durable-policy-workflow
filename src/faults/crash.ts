import { writeSync } from "node:fs";

/**
 * Crash injection for fault tests.
 *
 * `CRASH_AT` is a comma-separated list of crash points, e.g.
 * `after-side-effect:policy.bound`. When the worker reaches a listed point it
 * SIGKILLs itself: no `finally` blocks, no rollback hooks, no graceful
 * shutdown. That is the closest a test can get to a power cut or OOM kill.
 *
 * Crash points used by the relay and steps:
 *   after-claim:<event>        lease taken, nothing else done
 *   after-side-effect:<event>  external call succeeded, DB not yet updated
 *   after-commit:<event>       step committed, next event not yet claimed
 */
export type CrashHook = (point: string) => void;

export const noCrash: CrashHook = () => undefined;

export function crashHookFromEnv(env: NodeJS.ProcessEnv = process.env): CrashHook {
  const points = new Set(
    (env.CRASH_AT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (points.size === 0) return noCrash;
  return (point) => {
    if (!points.has(point)) return;
    // Synchronous write so the marker survives the kill; tests wait for it.
    writeSync(2, `${JSON.stringify({ level: "fatal", msg: "injected crash", point })}\n`);
    process.kill(process.pid, "SIGKILL");
  };
}
