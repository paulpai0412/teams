// Shared declared responsibilities; not a prose classifier or an OS permission gate.
import assert from 'node:assert/strict';
const roles = {
  review: ['team.reviewer', 'team.security'],
  scenarios: ['team.qa'],
  browser: ['team.verifier', 'team.e2e'],
  mechanical: ['team.verifier'],
  implementation: ['team.implementer', 'team.docs', 'team.release'],
  analysis: ['team.planner', 'team.challenger', 'team.researcher', 'team.debugger', 'team.curator'],
};
export function validateWork(agent, work) {
  assert.ok(work && typeof work === 'object' && !Array.isArray(work), 'explicit work contract required');
  assert.deepEqual(Object.keys(work).sort(), ['checks', 'criteria', 'kind'], 'work fields: kind, criteria, checks only');
  assert.ok(Object.hasOwn(roles, work.kind) && roles[work.kind].includes(agent), 'role responsibility mismatch: ' + work.kind);
  assert.ok(Array.isArray(work.criteria) && work.criteria.length > 0 && work.criteria.length <= 30 &&
    work.criteria.every(x => typeof x === 'string' && x.trim()), '1..30 fixed criteria required');
  assert.equal(new Set(work.criteria).size, work.criteria.length, 'duplicate criterion');
  assert.ok(Array.isArray(work.checks), 'explicit checks required');
  if (['browser', 'mechanical'].includes(work.kind))
    assert.ok(work.checks.length > 0, 'execution responsibility requires a check');
  if (['review', 'scenarios'].includes(work.kind))
    assert.equal(work.checks.length, 0, 'static responsibility cannot own execution checks');
  for (const check of work.checks) {
    assert.ok(check && typeof check.command === 'string' && check.command.trim(), 'check command required');
    assert.ok(['child-safe', 'isolated-only'].includes(check.location), 'parent-only/unknown check cannot go to child');
    if (check.location === 'isolated-only')
      assert.ok(typeof check.resource === 'string' && check.resource.trim(), 'isolated-only requires resource');
  }
  return work;
}
