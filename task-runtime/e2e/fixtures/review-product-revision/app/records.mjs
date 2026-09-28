// Incomplete starting point. The task is to satisfy requirements.md, not preserve this codec.
export function encodeRecord({ id, label }) {
  return `${id}|${label}`;
}

export function decodeRecord(line) {
  const separator = line.indexOf("|");
  if (separator < 0) throw new Error("record separator missing");
  return { id: line.slice(0, separator), label: line.slice(separator + 1) };
}
