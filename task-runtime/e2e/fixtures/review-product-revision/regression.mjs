import assert from "node:assert/strict";
import {
  decodeRecord,
  encodeRecord,
  groupByLabel,
} from "/work/app/records.mjs";

const records = [
  { id: "", label: "" },
  { id: "a|b", label: "red|blue" },
  { id: "a\\b", label: "x\\y" },
  { id: "\\|", label: "|\\" },
  { id: "\\\\|tail", label: "\\\\|\\|" },
  { id: "U+1", label: "雪|\\☃" },
];
for (const record of records) {
  const wire = encodeRecord(record);
  assert.deepEqual(
    decodeRecord(wire),
    record,
    `lossless round trip ${JSON.stringify(record)}`,
  );
  assert.equal(encodeRecord(decodeRecord(wire)), wire, "stable wire encoding");
}
assert.equal(encodeRecord({ id: "a|b", label: "x\\y" }), "a\\|b|x\\\\y");
assert.deepEqual(decodeRecord("a\\|b|x\\\\y"), { id: "a|b", label: "x\\y" });
assert.deepEqual(decodeRecord("|"), { id: "", label: "" });
const original = [
  { id: "1", label: "" },
  { id: "2", label: "Red" },
  { id: "3", label: "red" },
  { id: "4", label: "" },
];
const before = JSON.stringify(original);
const groups = groupByLabel(original);
assert.ok(groups instanceof Map);
assert.deepEqual([...groups.keys()], ["", "Red", "red"]);
assert.deepEqual(groups.get(""), [original[0], original[3]]);
assert.equal(groups.get("")[0], original[0], "retain original object identity");
assert.equal(JSON.stringify(original), before, "do not mutate input");
console.log(
  "regression: escaped delimiters/backslashes, empty fields, Unicode, case and order PASS",
);
