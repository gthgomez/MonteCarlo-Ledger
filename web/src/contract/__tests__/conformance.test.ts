import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import { runScenario, runScenarioSafe } from "../engine";

// Mirror the cross-engine pipeline semantics (tools/conformance/run_python.py): JSON-schema
// validation precedes engine semantics, so a structurally invalid scenario is SCHEMA_INVALID
// even when the engine itself would raise a more specific code. Formats are not validated,
// matching python-jsonschema's default behaviour.
const ajv = new Ajv2020({ validateFormats: false, strict: false });

function findRepoRoot(): string {
  let curr = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(curr, "fixtures")) && fs.existsSync(path.join(curr, "schemas"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  throw new Error("Could not locate repository root (fixtures/ + schemas/) from " + __dirname);
}

function findJsonFiles(dir: string, skip: RegExp | null = null): string[] {
  let files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip === null || !skip.test(entry.name)) {
        files = files.concat(findJsonFiles(full, skip));
      }
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".schema.json")) {
      files.push(full);
    }
  }
  return files;
}

const REPO_ROOT = findRepoRoot();
const FIXTURES_ROOT = path.join(REPO_ROOT, "fixtures");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "scenario.schema.json");

const schemaValidator = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));

interface FixtureDoc {
  scenario: any;
  expected: any;
  expected_status?: string;
  notes?: string;
}

function loadFixtures(dirName: string): Array<{ file: string; rel: string; doc: FixtureDoc }> {
  return findJsonFiles(path.join(FIXTURES_ROOT, dirName)).map((file) => {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as FixtureDoc;
    return { file, rel: path.relative(FIXTURES_ROOT, file), doc };
  });
}

const validFixtures = loadFixtures(".").filter(
  ({ rel }) => !rel.startsWith("invalid/")
);
const invalidFixtures = loadFixtures("invalid");

// Golden-corpus discipline: the counts are part of the contract evidence (MC-07). A corpus
// change must consciously update these pins together with the cross-engine baselines.
const EXPECTED_VALID_COUNT = 31;
const EXPECTED_INVALID_COUNT = 7;

test("fixture corpus counts match the pinned golden corpus", () => {
  assert.equal(
    validFixtures.length,
    EXPECTED_VALID_COUNT,
    `expected ${EXPECTED_VALID_COUNT} valid fixtures (got ${validFixtures.length}); update EXPECTED_VALID_COUNT and the cross-engine baselines together`
  );
  assert.equal(
    invalidFixtures.length,
    EXPECTED_INVALID_COUNT,
    `expected ${EXPECTED_INVALID_COUNT} invalid fixtures (got ${invalidFixtures.length}); update EXPECTED_INVALID_COUNT and the cross-engine baselines together`
  );
  for (const { rel, doc } of validFixtures) {
    assert.ok(doc.scenario, `fixture ${rel} has no scenario`);
    assert.ok(doc.expected, `fixture ${rel} has no expected result (frozen corpus required)`);
  }
  for (const { rel, doc } of invalidFixtures) {
    assert.ok(doc.scenario, `fixture ${rel} has no scenario`);
    assert.ok(
      doc.expected && typeof doc.expected.error === "string",
      `invalid fixture ${rel} must declare expected.error`
    );
  }
});

for (const { rel, doc } of validFixtures) {
  test(`valid fixture: ${rel}`, () => {
    if (doc.expected_status === "pending-generation") return; // mirrors Python conformance
    const actual = runScenario(doc.scenario);
    assert.deepEqual(
      actual,
      doc.expected,
      `mismatch on ${rel}`
    );
  });
}

for (const { rel, doc } of invalidFixtures) {
  test(`invalid fixture is rejected: ${rel}`, () => {
    // Pipeline semantics, mirroring tools/conformance/run_python.py: schema validation
    // precedes engine semantics, so a structurally invalid scenario never reaches the
    // engine and the pipeline reports SCHEMA_INVALID.
    const schemaInvalid = schemaValidator(doc.scenario) === false;
    const actual = schemaInvalid ? { error: "SCHEMA_INVALID" } : runScenarioSafe(doc.scenario);
    assert.deepEqual(
      actual,
      { error: doc.expected.error },
      `${rel}: expected pipeline rejection with ${doc.expected.error}`
    );
    // Independent invariant: the engine itself must still refuse to evaluate the scenario.
    assert.ok(
      "error" in runScenarioSafe(doc.scenario),
      `${rel}: engine must reject an invalid scenario, never return numbers`
    );
  });
}

// Sensitivity self-check: prove the harness actually detects divergence. If this test ever
// fails, the comparison above is broken and a green run means nothing.
test("harness sensitivity: a mutated result must not match the expected corpus", () => {
  const probe = validFixtures.find(({ rel }) => rel.includes("safe-to-spend")) ?? validFixtures[0];
  const actual = runScenario(probe.doc.scenario);
  assert.deepEqual(actual, probe.doc.expected);
  const mutated = JSON.parse(JSON.stringify(actual));
  const firstKey = Object.keys(mutated.forecast)[0];
  if (typeof mutated.forecast[firstKey] === "number") {
    mutated.forecast[firstKey] = mutated.forecast[firstKey] + 1;
  } else {
    mutated.forecast[firstKey] = "MUTATED";
  }
  assert.notDeepEqual(mutated, probe.doc.expected, "mutation must be detected");
});
