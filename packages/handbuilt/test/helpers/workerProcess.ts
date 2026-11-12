import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_URL } from "./db.js";
import type { Harness } from "./harness.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Lease used by spawned workers, short so a dead worker's claim expires quickly. */
export const SPAWNED_WORKER_LEASE_MS = 400;

/**
 * Run a worker as a separate Node process (real process death, no shared
 * memory with the test). It can SIGKILL itself at a crash point via CRASH_AT.
 */
export function spawnWorker(
  h: Harness,
  env: Record<string, string> = {},
): { child: ChildProcess; exited: Promise<NodeJS.Signals | number | null> } {
  const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", "src/main.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      ROLE: "worker",
      PORT: "0",
      LOG_LEVEL: "warn",
      PAYMENT_PROVIDER_URL: h.paymentUrl,
      DOCUMENT_SERVICE_URL: h.documentsUrl,
      PAYMENT_CALLBACK_URL: `${h.apiUrl}/webhooks/payments`,
      EXTERNAL_CALL_TIMEOUT_MS: "300",
      RELAY_POLL_INTERVAL_MS: "20",
      RELAY_LEASE_MS: String(SPAWNED_WORKER_LEASE_MS),
      RETRY_MAX_ATTEMPTS: "6",
      RETRY_BASE_DELAY_MS: "20",
      RETRY_MAX_DELAY_MS: "100",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal !== "SIGKILL" && code !== 0) console.error(stderr);
      resolve(signal ?? code);
    });
  });
  return { child, exited };
}
