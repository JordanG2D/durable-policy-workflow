import { pino, type Logger } from "pino";

export type { Logger };

/**
 * Structured JSON logs. Every log line about a workflow is written through a
 * child logger carrying `correlationId` and `workflowId`, so one grep (or one
 * log query) reconstructs a workflow's history across API and worker processes.
 */
export function createLogger(level = "info", destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "policy-workflow" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
