import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_PROJECT = "barber-a01e7";
const HML_PROJECT = "teste-483f6";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function walkScripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkScripts(fullPath);
    return entry.name.endsWith(".mjs") || entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

const firebaseRc = JSON.parse(read(".firebaserc"));
assert.equal(firebaseRc.projects?.default, undefined, "production cannot be Firebase CLI default");
assert.notEqual(firebaseRc.projects?.default, PRODUCTION_PROJECT, "production default is forbidden");

const scriptFiles = walkScripts(path.join(ROOT, "scripts"));
const mutableFirebaseInvocations = [];
for (const file of scriptFiles) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/firebase\s+(deploy|use|functions:|hosting:|firestore:)/i.test(line)) return;
    if (!/(--project(?:=|\s)|project(?:Id|_id)?\s*[:=])/.test(line)) {
      mutableFirebaseInvocations.push(`${path.relative(ROOT, file)}:${index + 1}`);
    }
  });
}
assert.deepEqual(mutableFirebaseInvocations, [], `Firebase CLI invocation without explicit project: ${mutableFirebaseInvocations.join(", ")}`);

const context = read("PROJECT_CONTEXT.md");
assert.match(context, /PRODUCTION_PROJECT\s*=\s*`?barber-a01e7`?/);
assert.match(context, /HML_PROJECT\s*=\s*`?teste-483f6`?/);
assert.match(context, /DEFAULT_PROJECT\s*=\s*(?:NONE|`?NONE`?)/);
assert.match(context, /EXPLICIT_PROJECT_REQUIRED\s*=\s*SIM/);

console.log(JSON.stringify({
  FIREBASE_DEFAULT_PROJECT_REMOVED: true,
  EXPLICIT_PROJECT_REQUIRED: true,
  MUTABLE_SCRIPTS_AUDITED: true,
  DEFAULT_PRODUCTION_FALLBACK: false,
  HML_PROJECT,
  PRODUCTION_PROJECT,
}, null, 2));
