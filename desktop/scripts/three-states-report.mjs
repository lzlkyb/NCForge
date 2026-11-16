#!/usr/bin/env node
/** 三态覆盖审计（DESIGN.md R6）。用法：node scripts/three-states-report.mjs [--json] */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, formatReport } from "./lib/three-states.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ path: relative(ROOT, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));
const rows = audit(files);

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else console.log(`三态覆盖审计（DESIGN.md R6）\n\n${formatReport(rows)}`);
