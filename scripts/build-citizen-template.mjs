#!/usr/bin/env node
// Regenerate src/citizen-template.js from the canonical agents/pack-citizen/agent.py.
// Run after editing the template. test/citizen.test.js asserts the two stay in sync.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "agents/pack-citizen/agent.py"), "utf8");
const out = `// GENERATED from agents/pack-citizen/agent.py by scripts/build-citizen-template.mjs.
// Do not edit by hand — edit the canonical .py and re-run the build script.
export const CITIZEN_TEMPLATE = ${JSON.stringify(src)};
`;
writeFileSync(join(root, "src/citizen-template.js"), out);
console.log(`src/citizen-template.js regenerated (${src.length} bytes of template)`);
