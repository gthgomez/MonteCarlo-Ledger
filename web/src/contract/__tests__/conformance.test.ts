import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runScenario } from "../engine";

function getFixturesRoot(): string {
  let curr = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(curr, "fixtures");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    curr = path.dirname(curr);
  }
  throw new Error("Could not locate fixtures directory from " + __dirname);
}

function findJsonFiles(dir: string): string[] {
  let files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "invalid") {
        files = files.concat(findJsonFiles(full));
      }
    } else if (entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

test("Contract 2.0 Conformance Suite against golden fixtures", () => {
  const fixturesRoot = getFixturesRoot();
  const fixtureFiles = findJsonFiles(fixturesRoot);
  assert.ok(fixtureFiles.length > 0, "No fixture files found");

  let passed = 0;
  for (const file of fixtureFiles) {
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    const scenario = content.scenario;
    const expected = content.expected;
    if (!scenario || !expected) continue;

    const actual = runScenario(scenario);
    assert.deepEqual(
      actual,
      expected,
      `Mismatch on fixture: ${path.relative(fixturesRoot, file)}`
    );
    passed++;
  }
  console.log(`\n🎉 [PASS] Passed ${passed} golden Contract 2.0 fixtures bit-for-bit in TypeScript!\n`);
});
