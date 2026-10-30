// Exercises startup failures against the real capture entry point; no app/server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const capture = join(dirname(fileURLToPath(import.meta.url)), 'capture.mjs');
for (const failure of ['missing browser', 'missing recording helper']) {
  test(`${failure}: startup failure removes its recording directory and preserves unrelated files`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'showcase-cleanup-test-'));
    try {
      await writeFile(join(fixture, 'keep-me'), 'unrelated fixture');
      const result = spawnSync(process.execPath, [capture], {
        env: {
          ...process.env,
          TMPDIR: fixture,
          SHOWCASE_URL: 'http://127.0.0.1:1',
          CHROMIUM_PATH: failure === 'missing browser'
            ? join(fixture, 'missing-chromium')
            : process.env.SHOWCASE_TEST_CHROMIUM_PATH || '/usr/bin/chromium',
          PLAYWRIGHT_BROWSERS_PATH: join(fixture, 'missing-playwright-cache'),
        },
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(result.error, undefined, 'capture must exit after the intended startup failure');
      assert.notEqual(result.status, 0, 'fixture must trigger startup failure');
      assert.match(result.stderr, /executable.*doesn.t exist|Executable doesn.t exist/i);
      const recordings = (await readdir(fixture)).filter(name => name.startsWith('readme-showcase-'));
      assert.deepEqual(recordings, [], 'failed startup leaked its task-created recording directory');
      assert.equal(await readFile(join(fixture, 'keep-me'), 'utf8'), 'unrelated fixture');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
