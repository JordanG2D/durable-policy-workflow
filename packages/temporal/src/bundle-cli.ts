/** Prebuild the workflow bundle (production workers load it instead of running webpack at startup). */
import { writeFile } from "node:fs/promises";
import { bundleWorkflows } from "./worker.js";

const out = process.argv[2] ?? "dist/workflow-bundle.js";
const { code } = await bundleWorkflows();
await writeFile(out, code);
console.log(`wrote ${out} (${code.length} bytes)`);
