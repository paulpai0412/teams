---
name: browser-automation
description: Execute approved browser acceptance journeys using an existing Playwright or agent-browser harness, preserving real-entrypoint evidence and owned-resource cleanup. No installation or production sessions.
---

# Scoped browser acceptance

Local role guidance. Parent intent, tool permissions and assigned outputSchema win.
No bootstrap, package/browser downloads, delegation, production sessions or shared
memory writes. A shell-capable role is not an OS sandbox; tests may write state.

## Before execution

- Confirm exact cwd/source, allowed URL, scenarios, expected outcomes, synthetic data,
  artifact directory and owned process/session resources. Missing authority blocks.
- Read the existing harness and approved commands. Check installed runner/browser
  availability and version without installing anything or exposing credentials.
  Do not use a command that may implicitly download a missing executable.
- Confirm no writer is editing the checkout. Use a fresh browser context/session and
  isolated storage. A desktop viewport is not proof of mobile-device coverage.
- Reuse the approved harness. If it needs source/config/script changes, return the
  defect to the parent/writer; do not bypass no-write restrictions through shell.

## Execute the relevant journeys

1. Use the real user entrypoint. Assert user-visible outcomes, not internal state
   alone. Exercise the assigned success and error/recovery paths; include reload or
   readback when persistence is part of the requirement.
2. Prefer accessible role/label locators or existing explicit test IDs. With an
   existing agent-browser runner, obtain fresh element references after navigation
   or material DOM changes; do not guess them.
3. Use actionability checks and web-first assertions, not arbitrary sleeps or a
   blanket network-idle wait. A timeout needs diagnosis, not blind retries.
4. Check assigned keyboard/focus/labels, viewport overflow and interaction targets.
   A screenshot alone proves neither functionality nor accessibility compliance.
   Verify user impact before assigning severity to a tiny animation/rounding delta.
5. Capture relevant console/page/network errors and required screenshots/traces.
   Keep evidence local to the approved directory, using synthetic/test data. Traces
   can contain headers/cookies/user data: do not record production credentials or
   upload artifacts; ask the parent if safe capture cannot be assured.
6. In cleanup, close only your browser context/session and terminate only processes
   you started and still own. Never kill a process merely because it uses a port.
   Report cleanup uncertainty; do not silently start another server on a new port.

## Evidence and stopping

Report source, URL, runner/browser version, viewport, exact existing command and
exit/result, per-scenario expected versus observed behavior, artifact paths and
cleanup outcome. Label mocks and intercepted dependencies: they do not establish
real integration success. Prefer the parent's requested schema over new fields.

Missing runner/browser/auth/fixture is an environment blocker, not a product failure
or permission to install. No browser run means no E2E pass. Preserve failed evidence;
request a bounded fix or investigation rather than repeatedly rerunning the journey.

## Optional reference

[Playwright best practices](https://playwright.dev/docs/best-practices).
Documentation examples are guidance, not permission to install tools or broaden scope.
