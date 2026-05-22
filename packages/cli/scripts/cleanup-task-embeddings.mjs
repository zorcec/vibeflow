#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] ?? ".");
const tasksDir = join(projectDir, ".proto", "tasks");
const legacyKeys = ["embedding", "embeddings", "vector", "vectors"];

let cleaned = 0;
for (const entry of readdirSync(tasksDir)) {
  if (!entry.endsWith(".json")) continue;
  const filePath = join(tasksDir, entry);
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  let changed = false;
  for (const key of legacyKeys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      delete raw[key];
      changed = true;
    }
  }
  if (!changed) continue;
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  cleaned += 1;
}

console.log(`Cleaned legacy embedding fields from ${cleaned} task file(s).`);
