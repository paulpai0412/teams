import assert from "node:assert/strict";
import {
  decodeRecord,
  encodeRecord,
  groupByLabel,
} from "/work/app/records.mjs";

for (const record of [
  { id: "a", label: "red" },
  { id: "b", label: "blue" },
]) {
  assert.deepEqual(decodeRecord(encodeRecord(record)), record);
}
const first = { id: "a", label: "red" };
const second = { id: "b", label: "blue" };
const third = { id: "c", label: "red" };
const input = [first, second, third];
const groups = groupByLabel(input);
assert.ok(groups instanceof Map, "groupByLabel returns a Map");
assert.deepEqual([...groups.keys()], ["red", "blue"]);
assert.deepEqual(groups.get("red"), [first, third]);
assert.deepEqual(groups.get("blue"), [second]);
assert.deepEqual(input, [first, second, third]);
console.log(
  "smoke: simple round trips and stable grouping PASS (not edge-case coverage)",
);
