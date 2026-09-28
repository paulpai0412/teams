import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { measureSessionBytes } from "../task-usage.mjs";
import { historicalUsage } from "../e2e/run-todo-flow.mjs";

const keys = ["input", "output", "cacheRead", "cacheWrite"];
const root = fileURLToPath(
  new URL(
    "../../goal-team-evidence/task-runtime-g1-request-driven-20260922-r18/",
    import.meta.url,
  ),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const vector = (value) =>
  Object.fromEntries(keys.map((key) => [key, value[key]]));
const sum = (rows) =>
  Object.fromEntries(
    [...keys, "total"].map((key) => [
      key,
      rows.reduce((n, row) => n + row[key], 0),
    ]),
  );

// Evidence-only readback: native identity + exact source bytes + per-component
// usage, not an arithmetic guess that two equal scalar totals are the same run.
function readback(correction, original) {
  const l0 = original.sources[0];
  const bytes = fs.readFileSync(l0.file);
  assert.equal(digest(bytes), correction.sources[0].sha256);
  const measured = measureSessionBytes(bytes);
  assert.equal(measured.sessionId, correction.sources[0].sessionId);
  const rows = bytes.toString("utf8").trim().split("\n").map(JSON.parse);
  const nested = rows.filter(
    (row) =>
      row.message?.role === "toolResult" &&
      row.message.usage &&
      row.message.toolName === "subagent",
  );
  const links = new Map();
  for (const entry of nested) {
    const info = entry.message.details;
    assert.equal(info?.results?.length, 1, "ambiguous native result");
    assert.ok(!links.has(info.runId), "duplicate native run");
    links.set(info.runId, {
      entryId: entry.id,
      ...info.results[0],
      usage: entry.message.usage,
    });
  }
  assert.equal(
    links.size,
    correction.sources.length - 1,
    "nested inventory incomplete",
  );
  const nativeRows = correction.sources.slice(1).map((source) => {
    const link = links.get(source.runId);
    assert.ok(link, "native run identity absent");
    assert.equal(link.entryId, source.l0ToolResultEntryId);
    assert.equal(
      link.sessionFile,
      original.sources.find((row) => row.sessionId === source.sessionId)?.file,
    );
    const childBytes = fs.readFileSync(link.sessionFile);
    assert.equal(digest(childBytes), source.sha256);
    const child = measureSessionBytes(childBytes);
    assert.equal(child.sessionId, source.sessionId);
    for (const key of keys) assert.equal(link.usage[key], child.usage[key]);
    assert.equal(link.usage.totalTokens, child.usage.total);
    assert.deepEqual(
      { ...vector(child.usage), total: child.usage.total },
      source.usage,
    );
    return child.usage;
  });
  const own = Object.fromEntries(
    keys.map((key) => [key, measured.usage[key] - sum(nativeRows)[key]]),
  );
  assert.ok(keys.every((key) => own[key] >= 0));
  own.total = keys.reduce((n, key) => n + own[key], 0);
  assert.deepEqual(own, correction.sources[0].usage);
  assert.deepEqual(measured.usage.total, correction.deduplicatedR18Usage.total);
  assert.deepEqual(sum([own, ...nativeRows]), correction.deduplicatedR18Usage);
  return { own, nativeRows, measured };
}

test("r18 original files: toolResult nested run/session identity, source hashes and RPC total agree", () => {
  const correction = JSON.parse(
    fs.readFileSync(path.join(root, "r18-usage-correction.json")),
  );
  const original = JSON.parse(
    fs.readFileSync(path.join(root, "r18-accounting.json")),
  );
  assert.equal(
    digest(fs.readFileSync(path.join(root, "r18-accounting.json"))),
    correction.supersedesForAccounting.sha256,
  );
  const rpc = fs.readFileSync(path.join(root, correction.rpcObservation.file));
  assert.equal(digest(rpc), correction.rpcObservation.sha256);
  const { measured, nativeRows } = readback(correction, original);
  assert.equal(nativeRows.length, 2);
  assert.deepEqual(vector(JSON.parse(rpc).rootUsage), vector(measured.usage));
  assert.equal(JSON.parse(rpc).rootUsage.total, measured.usage.total);
  const originalRows = sum(original.sources.map((row) => row.usage));
  assert.equal(
    originalRows.total - measured.usage.total,
    sum(nativeRows).total,
  );
  assert.equal(original.totals.cacheRead - originalRows.cacheRead, 40000);
  assert.equal(original.totals.total - originalRows.total, 40000);
});

test("production campaign reader counts r18 direct children only once in either source order", () => {
  const original = JSON.parse(
    fs.readFileSync(path.join(root, "r18-accounting.json")),
  );
  const sources = original.sources.map(({ file, sha256 }) => ({
    file,
    sha256,
  }));
  for (const rows of [
    sources,
    [...sources].reverse(),
    sources.slice(0, 2),
    sources.slice(0, 1),
  ]) {
    const measured = historicalUsage(rows, "different-current-parent");
    assert.equal(measured.totals.total, 546532);
    assert.equal(measured.totals.cacheRead, 407552);
    assert.equal(
      measured.sources.filter((row) => row.countedInParent).length,
      rows.length - 1,
    );
  }
  assert.throws(
    () =>
      historicalUsage(
        [sources[0], { ...sources[1], sha256: "f".repeat(64) }],
        "different-current-parent",
      ),
    /bytes changed/,
  );
});

test("production reader adds independent usage, includes failed runs, and rejects unbound child evidence", (t) => {
  const original = JSON.parse(
    fs.readFileSync(path.join(root, "r18-accounting.json")),
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r18-overlap-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const other = path.join(tmp, "other.jsonl");
  fs.writeFileSync(
    other,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "independent-1",
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        id: "failed-turn",
        message: {
          role: "assistant",
          stopReason: "error",
          usage: {
            input: 4,
            output: 1,
            cacheRead: 13,
            cacheWrite: 0,
            totalTokens: 18,
          },
        },
      }),
    ].join("\n") + "\n",
  );
  const independent = { file: other, sha256: digest(fs.readFileSync(other)) };
  const rootSource = original.sources[0];
  assert.equal(
    historicalUsage([rootSource, independent], "other-parent").totals.total,
    546550,
  );
  // A nonzero native exit still incurs its previously recorded consumption.
  const parent = path.join(tmp, "parent.jsonl");
  const modified = fs
    .readFileSync(rootSource.file, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const native = modified.find((entry) => entry.id === "db4ab757");
  native.message.details.results[0].exitCode = 1;
  fs.writeFileSync(parent, modified.map(JSON.stringify).join("\n") + "\n");
  const failed = { file: parent, sha256: digest(fs.readFileSync(parent)) };
  assert.equal(
    historicalUsage([failed, original.sources[1]], "other-parent").totals.total,
    546532,
  );
  delete native.message.details.results[0].sessionFile;
  fs.writeFileSync(parent, modified.map(JSON.stringify).join("\n") + "\n");
  const unbound = { file: parent, sha256: digest(fs.readFileSync(parent)) };
  assert.throws(
    () => historicalUsage([unbound, original.sources[1]], "other-parent"),
    /unbound subagent usage/,
  );
});

test("overlap classification counts an attested nested child once, keeps independent child and cache", () => {
  const parent = {
    input: 5,
    output: 2,
    cacheRead: 11,
    cacheWrite: 1,
    total: 19,
  };
  const embedded = {
    input: 3,
    output: 1,
    cacheRead: 7,
    cacheWrite: 0,
    total: 11,
  };
  const independent = {
    input: 4,
    output: 1,
    cacheRead: 13,
    cacheWrite: 0,
    total: 18,
  };
  const partial = {
    input: 2,
    output: 0,
    cacheRead: 5,
    cacheWrite: 0,
    total: 7,
  };
  // A partial overlap is neither all-or-none nor a scalar subtraction:
  // only independently identified sessions not in the parent's bound entries add cost.
  function reconcile(parentRow, otherSessions, boundIds) {
    for (const session of otherSessions) {
      assert.match(session.id, /^[a-z]+$/);
      assert.match(session.sha256, /^[a-f0-9]{64}$/);
      assert.ok(
        session.usage &&
          keys.every((key) => Number.isSafeInteger(session.usage[key])),
      );
      if (boundIds.has(session.id))
        assert.deepEqual(session.usage, boundIds.get(session.id));
    }
    assert.equal(
      new Set(otherSessions.map((session) => session.id)).size,
      otherSessions.length,
    );
    for (const id of boundIds.keys())
      assert.ok(
        otherSessions.some((session) => session.id === id),
        "missing nested session proof",
      );
    return sum([
      parentRow,
      ...otherSessions
        .filter((row) => !boundIds.has(row.id))
        .map((row) => row.usage),
    ]);
  }
  const sessions = [embedded, independent, partial].map((usage, index) => ({
    id: ["embedded", "independent", "partial"][index],
    sha256: "a".repeat(64),
    usage,
  }));
  assert.equal(
    reconcile(
      parent,
      sessions,
      new Map([
        ["embedded", embedded],
        ["partial", partial],
      ]),
    ).total,
    37,
  );
  assert.equal(reconcile(parent, sessions, new Map()).total, 55);
  assert.throws(
    () => reconcile(parent, sessions, new Map([["missing", embedded]])),
    /missing nested/,
  );
  assert.throws(
    () =>
      reconcile(
        parent,
        sessions.map((x, i) => (i ? x : { ...x, sha256: "bad" })),
        new Map(),
      ),
    /match/,
  );
  assert.throws(
    () =>
      reconcile(
        parent,
        sessions,
        new Map([["embedded", { ...embedded, cacheRead: 0 }]]),
      ),
    /deep-equal/,
  );
});
