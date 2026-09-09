# Independent static review contract — TODO-50ccf1d3

User selected option 1: fresh independent code/security review. User will conduct manual live tests. This authorizes two read-only children, superseding prior main-only for this review only; NOT implementation or live testing.

Cwd: /home/timmypai/apps/vocab-agent (not a Git checkout). Target is /home/timmypai/.pi/agent/teams, NOT the vocab app.
Fixed baseline: audit-fixes-20260908/before-manifest.json and before/; candidate: manifest.json postSha256 and current sources. Parent verified all 23 source/doc/test files match on entry. Manifest digest d485a52501693d1c9e8fb51dbdd4984bf5c26c2f640da8dadc6ee46b91aab587. source-pin.json binds review candidate.

Specification: prior rigorous-audit-20260908/README.md F1–F5 and audit-fixes-20260908/README.md requested fixes/limitations. Read source and tests rather than trusting writer PASS.
Standards: existing single-parent/one-controller lifecycle, no new authority, preserved failed histories, non-replayed effects, no unnecessary abstraction, explicit evidence limits.

Required for this review: candidate/source hash continuity; fresh correctness/Standards/Spec review; fresh static security review; parent disposition of concrete findings. Existing mechanical evidence is reused, not rerun. Live/E2E and performance tests are outside this review, user-owned and still not assumed complete. No release/dependency/publication changes: those gates N/A. Global gateway-policy decision is pending outside this review; do not change configuration or use it as evidence of a new source bug.

Team.reviewer owns correctness, lifecycle/counters/report-only, API parity, legacy compatibility and test adequacy, separately reporting Standards vs Spec. Team.security owns evidence/path binding, input/authority/exfiltration boundaries and producer→consumer trust assumptions. Their independent judgments are the delegation benefit, not duplicate test execution.

Both: fresh context; read-only no shell/edit/write/scanners/model children/install/web/credentials/Goal/memory changes. Read only scoped sources, prior evidence, related local callers and relevant guidance. Return Markdown via managed output only; runtime output capture is allowed. Do not read each other's reports. Stop on source mismatch, missing capability or material unknown; report the gap without broadening tools. At most two launches, concurrency two, child deadline 25min, wave deadline 30min, no automatic retries/repair child. Missing or malformed report is handled by parent from retained evidence, never rerun writer.

Return concrete P0/P1/P2 findings with exact file:lines, reachable input/action sequence, impact, introduced/preexisting status, smallest fix and missing test. Separate limitations/speculation from findings; a malicious parent rewriting trusted state is not automatically a supported-helper vulnerability. Report only what static evidence establishes; do not claim execution. A clean static review does not complete live/product acceptance. Parent will inspect cited code and preserve original reports.
