---
name: docs-generator
description: Write task-oriented README, API, architecture and operating documentation from actual source and evidence. Use for documentation changes or documentation review, without running commands or publishing.
---

# Evidence-backed documentation

Local role guidance, not an upstream skill bundle. Follow the parent scope and role
contract. This skill grants no tools, publication authority or gate exemptions.
No shell, bootstrap, nested delegation or shared-memory writes. Keep the assigned
outputSchema; writer acceptanceReport is its native sibling, not another schema.

## Work

1. Identify the reader, task and allowed documentation files. Read existing docs,
   actual public entrypoints/config and relevant evidence before writing. Reuse
   existing terminology and structure; do not document speculative features.
2. Put prerequisites, warnings and breaking changes first. Show the shortest path
   from a known starting state to a verifiable result. Explain arguments, defaults,
   required permissions and failure/recovery behavior only where applicable.
3. Derive examples from the actual API/CLI/schema and repository conventions. Mark
   substitutions clearly and exclude real credentials/private identifiers. Never
   invent executable paths, flags, output, deployment receipts or successful checks.
4. Distinguish implemented behavior, planned behavior and unverified behavior.
   Include migration/rollback only for changes that need them; no template ceremony.
5. Check consistency against source, links, option names and expected outputs with
   available read tools. You cannot claim an example was executed from reading it.
   Ask the parent for a scoped example/link check when execution is required.
6. Edit only allowed docs. Send code/config/harness defects to the parent rather
   than silently patching them. Do not install renderers, invoke another skill's
   controller, publish a site, or create a release.

## Delivery

Return exact changed paths, the source/evidence supporting important statements,
checks actually observed, checks requested but not executed, and remaining gaps.
For a required unverified example, report the gap; do not turn it into a pass.
Use the parent's schema when supplied; otherwise give a short Markdown handoff.

## Example-check request (not an instruction to execute)

Name the existing entrypoint and documented command, allowed cwd/test resources,
expected observable output and cleanup. Parent approves and runs it or assigns an
existing execution-capable role. Include the resulting receipt only once it exists.
