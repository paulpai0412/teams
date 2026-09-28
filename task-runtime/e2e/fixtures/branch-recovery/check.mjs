// Trusted checker, executed only inside the credential-free wrapper sandbox.
import assert from "node:assert/strict";
const phase = process.argv[2];
assert.ok(["encode", "decode", "codec", "groups"].includes(phase));
const fields = ["", "A", "資料☃", "|", "\\", "\\\\", "\\|", "|\\"];
const escape = (text) => text.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
let checks = 0;
try {
  if (phase === "groups") {
    const { groupByLabel } = await import("./app/groups.mjs");
    const labels = [
      "__proto__",
      "",
      "A",
      "a",
      "資料☃",
      "|\\",
      "A",
      "__proto__",
      "",
    ];
    const records = Object.freeze(
      labels.map((label, i) => Object.freeze({ id: String(i), label })),
    );
    const grouped = groupByLabel(records);
    assert.ok(grouped instanceof Map);
    assert.deepEqual([...grouped.keys()], [...new Set(labels)]);
    for (const label of new Set(labels)) {
      const expected = records.filter((record) => record.label === label);
      assert.equal(grouped.get(label).length, expected.length);
      expected.forEach((record, index) =>
        assert.equal(grouped.get(label)[index], record),
      );
      checks++;
    }
    assert.deepEqual(groupByLabel(Object.freeze([])), new Map());
    checks++;
  } else {
    const library =
      phase === "codec"
        ? await import("./app/codec.mjs")
        : await import(`./app/${phase}.mjs`);
    for (const id of fields)
      for (const label of fields) {
        const record = Object.freeze({ id, label });
        const wire = `${escape(id)}|${escape(label)}`;
        if (phase !== "decode")
          assert.equal(library.encodeRecord(record), wire);
        if (phase !== "encode")
          assert.deepEqual(library.decodeRecord(wire), record);
        if (phase === "codec")
          assert.deepEqual(
            library.decodeRecord(library.encodeRecord(record)),
            record,
          );
        checks++;
      }
  }
  console.log(JSON.stringify({ status: "PASS", phase, checks }));
} catch (error) {
  console.error(
    JSON.stringify({
      status: "FAIL",
      phase,
      checks,
      message: String(error.message).slice(0, 1600),
    }),
  );
  process.exitCode = 1;
}
