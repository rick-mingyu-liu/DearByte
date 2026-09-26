// Persona packs: list them, check them the way CI does, and regenerate the
// record in personas/INDEX.md.
//
//   npm run personas                 # every pack, with whether it passes
//   npm run personas -- check [id]   # the checks CI runs; exits 1 on a problem
//   npm run personas -- index        # rewrites personas/INDEX.md from the manifests

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPack, listPersonas, loadPack, PERSONA_DIR, personaIndex, strayEntries } from "../src/agent/persona.ts";
import { ROOT } from "../src/config.ts";

const INDEX = join(ROOT, PERSONA_DIR, "INDEX.md");
const [command = "list", only] = process.argv.slice(2);
const ids = only ? [only] : listPersonas(ROOT);

if (command === "index") {
  writeFileSync(INDEX, personaIndex(ROOT));
  console.log(`Wrote ${PERSONA_DIR}/INDEX.md (${listPersonas(ROOT).length} packs).`);
} else if (command === "check" || command === "list") {
  let failed = false;
  for (const id of ids) {
    const problems = checkPack(ROOT, id);
    failed ||= problems.length > 0;
    if (command === "list" && !problems.length) {
      const m = loadPack(ROOT, id).manifest;
      console.log(`✓ ${id.padEnd(16)} ${m.name} ${m.version} (${m.language}) by ${m.authors.map((a) => a.name).join(", ")}`);
    } else if (!problems.length) console.log(`✓ ${id}`);
    else console.log(`✗ ${id}\n${problems.map((p) => `  - ${p.replace(/\n/g, "\n    ")}`).join("\n")}`);
  }
  for (const stray of only ? [] : strayEntries(ROOT)) {
    failed = true;
    console.log(`✗ ${stray}`);
  }
  let current = "";
  try {
    current = readFileSync(INDEX, "utf8");
  } catch {
    // no index yet
  }
  if (!only && current.replace(/\r\n/g, "\n") !== personaIndex(ROOT)) {
    failed = true;
    console.log(`✗ ${PERSONA_DIR}/INDEX.md is out of date: run npm run personas -- index`);
  }
  if (failed) process.exitCode = 1;
} else {
  console.error("usage: npm run personas [-- check [id] | index]");
  process.exitCode = 2;
}
