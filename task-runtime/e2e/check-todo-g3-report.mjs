#!/usr/bin/env node
// Read-only host check for the disposable G3 Todo fixture. Never executes Worker code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, kind] = process.argv.slice(2);
assert.ok(root && ["a", "b"].includes(kind), "usage: check-todo-g3-report.mjs ROOT a|b");
const input = JSON.parse(fs.readFileSync(path.join(root, "fixtures", `${kind}.json`), "utf8"));
assert.ok(Array.isArray(input) && input.length > 0, "Todo fixture required");
const chosen = input.filter((todo) => todo.completed === (kind === "b"));
const actual = JSON.parse(fs.readFileSync(path.join(root, "reports", `${kind}.json`), "utf8"));
assert.deepEqual(actual, { kind, count: chosen.length, firstText: chosen[0]?.text ?? null });
console.log(JSON.stringify({status:"pass",kind,count:actual.count}));
