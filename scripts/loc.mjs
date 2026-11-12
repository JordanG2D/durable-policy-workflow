// Lines of code per package: non-blank lines that are not only comments.
// Usage: node scripts/loc.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "fixtures" ? [] : files(p);
    return p.endsWith(".ts") ? [p] : [];
  });

function count(path) {
  let inBlock = false;
  let n = 0;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      continue;
    }
    n++;
  }
  return n;
}

const rows = [];
for (const pkg of ["domain", "parity", "handbuilt", "temporal"]) {
  for (const part of ["src", "test"]) {
    let dir;
    try {
      dir = files(join("packages", pkg, part));
    } catch {
      continue;
    }
    rows.push({ package: pkg, part, files: dir.length, loc: dir.reduce((s, f) => s + count(f), 0) });
  }
}
console.table(rows);
