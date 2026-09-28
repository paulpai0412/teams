# Two independent library deliverables

Deliver two separately reviewed verify-only patches and two AcceptanceReceipts, not an installed target. The codec and grouping library have no dependency on each other's implementation.

## Codec

`app/codec.mjs` is the public entrypoint, re-exporting `encodeRecord({id,label})` from `app/encode.mjs` and `decodeRecord(line)` from `app/decode.mjs`. Both fields are strings including empty strings and Unicode. The wire format is `id|label`; in each field encode every backslash as two backslashes and every pipe as backslash-pipe. A backslash escapes exactly the next backslash or pipe. Decode valid wire strings into the exact original fields. Preserve all combinations of consecutive backslashes and pipes. Only `app/encode.mjs` and `app/decode.mjs` need implementation; do not change the entrypoint.

## Grouping

`app/groups.mjs` exports `groupByLabel(records)`, returning a Map keyed by exact case-sensitive labels. Keep original record object identities, order of records within each group and first-occurrence order of keys. Empty input gives an empty Map. Empty, Unicode, pipe/backslash and `__proto__` labels are ordinary keys. Do not mutate input objects or the input array. This library is independent of the codec.

No dependencies, installation, network, filesystem access, deployment, publication, commit or push during delivery. Trusted host checks run through the supplied credential-free sandbox wrapper; do not import/execute candidate code directly on the host.

The canary's first decoder contribution is a controlled defective input, not a correct answer. It must produce a real typed product failure from the trusted decoder check, with honest native acceptance evidence. Only that decoder contribution may then be replaced through same-execution Task-local recovery. Preserve the successful encoder contribution, independent grouping Task progress and every failed attempt/usage record. Final codec checks and source-bound review evaluate the FULL codec requirement, not only the initial failing case.
