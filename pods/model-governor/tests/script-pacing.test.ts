import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const cli = fileURLToPath(new URL('../bin/check-script-pacing.mjs', import.meta.url));
const spoken = { start: 0, end: 5, vo: 'Which cable powers the lamp?' };

function run(shots: unknown, timings: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'pacing-'));
  try {
    const paths = [join(dir, 'shots.json'), join(dir, 'timings.json')];
    writeFileSync(paths[0], JSON.stringify(shots));
    writeFileSync(paths[1], JSON.stringify(timings));
    const result = spawnSync(process.execPath, [cli, ...paths], { encoding: 'utf8' });
    return { code: result.status, report: JSON.parse(result.stdout) };
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('uses pre-fit duration and reports the line and duration target for rewriting', () => {
  const { code, report } = run([spoken], [
    { shot: 1, vo: spoken.vo, nativeSeconds: 6.5, audioStart: 0, audioEnd: 4.8, playbackRate: 1 },
  ]);
  assert.equal(code, 1);
  assert.equal(report.status, 'needs_rewrite');
  assert.equal(report.rewrite.length, 1);
  const [issue] = report.rewrite;
  assert.equal(issue.shot, 1);
  assert.equal(issue.vo, spoken.vo);
  assert.equal(issue.requiredSpeed, report.maxSpeed);
  assert.ok(Math.abs(report.maxSpeed - 6.5 / 4.82) < 1e-12);
  assert.ok(Math.abs(issue.maxNaturalSeconds - 6.025) < 1e-12);
});

test('accepts the inclusive threshold, silent beats and a retimed take with unchanged text', () => {
  const shots = [{ start: 0, end: 3, vo: '' }, { ...spoken, start: 3, end: 8 }];
  const { code, report } = run(shots, [{ shot: 2, vo: spoken.vo, shotStart: 4, shotEnd: 9, naturalSeconds: 6.025 }]);
  assert.equal(code, 0);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.rewrite, []);
  assert.equal(run([spoken], [{ shot: 1, vo: spoken.vo, naturalSeconds: 6.026 }]).code, 1);
});

test('incomplete timings cannot pass, even when a fitted duration is available', () => {
  for (const timings of [[], [{ shot: 1, vo: spoken.vo, audioStart: 0, audioEnd: 4 }]]) {
    const result = run([spoken], timings);
    assert.equal(result.code, 2);
    assert.equal(result.report.status, 'unknown');
    assert.deepEqual(result.report.missing, [{ shot: 1, vo: spoken.vo }]);
  }
});

test('rejects stale, duplicate and malformed measurements and invalid shot windows', () => {
  const take = { shot: 1, vo: spoken.vo, naturalSeconds: 3 };
  for (const timings of [[{ ...take, vo: 'Old line' }], [take, take], [{ ...take, naturalSeconds: -1 }], [{ ...take, shot: 2 }]]) {
    assert.equal(run([spoken], timings).report.status, 'invalid');
  }
  assert.equal(run([spoken, spoken], []).report.status, 'invalid');
  assert.equal(run([{ ...spoken, end: 0.15 }], [take]).report.status, 'invalid');
});
