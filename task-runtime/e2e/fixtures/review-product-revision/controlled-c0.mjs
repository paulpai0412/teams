export function encodeRecord({ id, label }) {
  const escape = (value) => value.replaceAll("|", "\\|");
  return `${escape(id)}|${escape(label)}`;
}

export function decodeRecord(line) {
  const fields = ["", ""];
  let field = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\") {
      if (index + 1 >= line.length || !"\\|".includes(line[index + 1])) {
        throw new Error("invalid escape");
      }
      fields[field] += line[index + 1];
      index += 1;
    } else if (character === "|") {
      if (field === 1) throw new Error("record separator count");
      field = 1;
    } else {
      fields[field] += character;
    }
  }

  if (field === 0) throw new Error("record separator missing");
  return { id: fields[0], label: fields[1] };
}

export function groupByLabel(records) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.label);
    if (group) {
      group.push(record);
    } else {
      groups.set(record.label, [record]);
    }
  }
  return groups;
}
