import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../../goal-request.mjs', import.meta.url).pathname;

test('CLI still prepares valid attempts without launching a child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-valid-dispatch-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'input.txt'), 'fixture');
    for (const attempt of [1, 2, 3]) {
      const file = join(dir, `request-${attempt}.json`);
      writeFileSync(file, JSON.stringify({
        work: { kind: 'review', criteria: ['C1: source reviewed'], checks: [] },
        missionId: 'mission', goalId: 'goal', taskId: 'task', phase: 'review',
        attempt, agent: 'team.reviewer', task: 'Static source review only.',
        cwd: dir, sourcePaths: ['src'], sourceState: 'sha256:fixture',
        goalStatus: 'active', taskStatus: 'pending', timeoutMs: 1000,
      }));
      const result = spawnSync(process.execPath, [cli, '--dispatch', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const prepared = JSON.parse(result.stdout);
      assert.equal(prepared.dispatchArgs.context, 'fresh');
      assert.equal(prepared.dispatchArgs.maxSubagentSpawnsPerRun, 1);
      assert.match(prepared.requestDigest, /^[a-f0-9]{64}$/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects out-of-budget attempts before creating dispatch artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-dispatch-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'input.txt'), 'fixture');
    const file = join(dir, 'request.json');
    for (const attempt of [4, 0, -1, 1.5, '1', null]) {
      writeFileSync(file, JSON.stringify({
        missionId: 'mission', goalId: 'goal', taskId: 'task', phase: 'review',
        attempt, agent: 'team.reviewer', task: 'Static source review only.',
        cwd: dir, sourcePaths: ['src'], sourceState: 'sha256:fixture',
        goalStatus: 'active', taskStatus: 'pending', timeoutMs: 1000,
      }));
      for (const mode of [[], ['--dispatch']]) {
        const result = spawnSync(process.execPath, [cli, ...mode, file], { encoding: 'utf8' });
        assert.equal(result.status, 1, `attempt ${JSON.stringify(attempt)} must fail at preparation (${mode})`);
        assert.match(result.stderr, /Attempt must be 1\.\.3/);
        assert.equal(result.stdout, '');
        assert.deepEqual(readdirSync(dir).sort(), ['request.json', 'src']);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
