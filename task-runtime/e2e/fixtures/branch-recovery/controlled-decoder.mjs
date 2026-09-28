// Controlled defective first contribution, not a correct product implementation.
export function decodeRecord(line) {
  const [id, label] = line.split("|");
  return { id, label };
}
