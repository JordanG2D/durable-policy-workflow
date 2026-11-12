import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DeterminismViolationError } from "@temporalio/workflow";
import { Worker, type WorkflowBundle } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { workflowSpanSinks } from "../src/tracing.js";
import { bundleWorkflows } from "../src/worker.js";
import { withTimeout } from "./support/env.js";

/**
 * Determinism guard. Temporal rebuilds a workflow's state by re-running its
 * code against the recorded history, so a code change that issues commands
 * in a different order breaks every workflow that is still running.
 *
 * The histories in fixtures/histories were recorded from real runs (see
 * support/record-histories.ts). Each must replay cleanly against the current
 * workflow code. A deliberately reordered workflow must fail, which proves
 * the check has teeth. No Temporal server is needed.
 */
const historiesDir = fileURLToPath(new URL("./fixtures/histories/", import.meta.url));
const files = (await readdir(historiesDir)).filter((f) => f.endsWith(".json")).sort();
const load = async (f: string): Promise<unknown> => JSON.parse(await readFile(`${historiesDir}${f}`, "utf8"));

let current: WorkflowBundle;
let reordered: WorkflowBundle;
beforeAll(async () => {
  current = await withTimeout(bundleWorkflows(), 60_000, "bundling workflow code");
  reordered = await withTimeout(
    bundleWorkflows(fileURLToPath(new URL("./fixtures/reorderedWorkflow.ts", import.meta.url))),
    60_000,
    "bundling the reordered workflow",
  );
});

describe("replay: recorded histories against the current workflow code", () => {
  it("has recorded histories to replay", () => {
    expect(files).toEqual(
      expect.arrayContaining(["callback-wins-with-duplicates.json", "documents-down-dead-lettered.json", "happy-path.json"]),
    );
  });

  for (const f of files) {
    it(`replays ${f} without a determinism violation`, async () => {
      await withTimeout(
        Worker.runReplayHistory({ workflowBundle: current, sinks: workflowSpanSinks(), replayName: f }, await load(f)),
        20_000,
        `replaying ${f}`,
      );
    });
  }

  it("rejects a workflow change that reorders side effects", async () => {
    await expect(
      withTimeout(
        Worker.runReplayHistory({ workflowBundle: reordered, replayName: "reordered" }, await load("happy-path.json")),
        20_000,
        "replaying against the reordered workflow",
      ),
    ).rejects.toThrow(DeterminismViolationError);
  });
});
