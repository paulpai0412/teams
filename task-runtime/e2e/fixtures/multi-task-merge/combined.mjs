import assert from "node:assert/strict";
import { encodeRecord, decodeRecord, groupByLabel } from "./app/index.mjs";

// Exercise the shipped entrypoint as one pipeline, not independent module passes.
const inputs = [
  { id: "", label: "" },
  { id: "a|\\b", label: "同|\\組" },
  { id: "second", label: "同|\\組" },
  { id: "emoji 🧪", label: "__proto__" },
  { id: "fourth", label: "Group" },
  { id: "fifth", label: "group" },
  { id: "\\\\||", label: "" },
].map(Object.freeze);
Object.freeze(inputs);
const wires = inputs.map(encodeRecord);
assert.equal(wires[1], "a\\|\\\\b|同\\|\\\\組");
const decoded = wires.map(decodeRecord);
assert.deepEqual(decoded, inputs);
const before = structuredClone(decoded);
decoded.forEach(Object.freeze);
Object.freeze(decoded);
const groups = groupByLabel(decoded);
assert.ok(groups instanceof Map);
assert.deepEqual(
  [...groups.keys()],
  ["", "同|\\組", "__proto__", "Group", "group"],
);
assert.deepEqual(
  [...groups.values()].map((rows) => rows.map((row) => row.id)),
  [["", "\\\\||"], ["a|\\b", "second"], ["emoji 🧪"], ["fourth"], ["fifth"]],
);
assert.equal(groups.get("同|\\組")[0], decoded[1]);
assert.equal(groups.get("同|\\組")[1], decoded[2]);
assert.equal(groups.get("")[1], decoded[6]);
assert.deepEqual(decoded, before);
assert.deepEqual([...groupByLabel([].map(encodeRecord).map(decodeRecord))], []);
console.log(
  JSON.stringify({
    status: "passed",
    entrypoint: "app/index.mjs",
    scenarios: [
      "wire-escaping",
      "pipeline-roundtrip",
      "exact-grouping-order",
      "identity-and-nonmutation",
      "empty-pipeline",
    ],
  }),
);
