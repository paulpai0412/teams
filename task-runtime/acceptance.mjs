import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readEvidenceBytes,
  runCheck,
  snapshot,
  verifyCheck,
} from "../host-evidence.mjs";
import { digest, validateTaskResult } from "./contracts.mjs";
import { Mailbox } from "./mailbox.mjs";
import { assertTaskBudgetUsage } from "./task-budget.mjs";
import { stageIntegration, readIntegrationRehearsal } from "./integration.mjs";
import { processTerminalProof } from "./orchestrator.mjs";
import { inspectWorktreeBase } from "./role-wave.mjs";
import {
  measureClosedExecutionUsage,
  reviewUsageAdmission,
} from "./task-usage.mjs";
import { prepareIntegrationReview } from "./integration-review.mjs";
import {
  planReviewWave,
  startReviewWave,
  collectReviewWave,
  sealReviewCandidate,
  readAppliedReviewCandidate,
  readSealedReviewCandidate,
} from "./review-runs.mjs";
import { integrationReviewBinding } from "./integration-authority.mjs";
import {
  verifyWorkspaceScope,
  verifyWorkspaceResult,
} from "./workspace-scope.mjs";
import {
  prepareIntegrationApply,
  executeIntegrationApply,
  inspectIntegrationApply,
  verifyIntegrationApply,
} from "./integration-apply.mjs";

function checkInput(contract, check) {
  return {
    cwd: check.cwd,
    sourcePaths: contract.workspace.sourcePaths,
    argv: [check.executable, ...check.argv],
    timeoutMs: check.timeoutMs,
  };
}

function verifyNativeStepAcceptance(step, mode) {
  assert.equal(step.status, "complete", "native step did not complete");
  const acceptance = step.acceptance;
  if (acceptance?.effectiveAcceptance?.review?.required)
    assert.equal(
      acceptance.status,
      "reviewed",
      "native review gate is not satisfied",
    );
  if (mode === "mutation" || mode === "check")
    assert.ok(
      ["checked", "verified", "reviewed"].includes(acceptance?.status),
      "native writer evidence gate is not satisfied",
    );
  else
    assert.notEqual(acceptance?.status, "rejected", "native review rejected");
}

export function verifyNativeRoleStatus(status, { runId, cwd, mode, members }) {
  assert.equal(status.runId, runId, "native run identity mismatch");
  assert.equal(
    fs.realpathSync(status.cwd),
    fs.realpathSync(cwd),
    "native cwd mismatch",
  );
  assert.equal(status.state, "complete", "native role is not complete");
  assert.equal(
    status.processTerminal?.version,
    1,
    "native terminal proof version missing",
  );
  assert.equal(
    status.processTerminal?.runId,
    runId,
    "native terminal identity mismatch",
  );
  assert.equal(
    status.processTerminal?.state,
    "observed",
    "native terminal proof missing",
  );
  assert.ok(status.steps?.length > 0, "native step results missing");
  if (members) {
    assert.equal(
      status.steps.length,
      members.length,
      "native wave member count mismatch",
    );
    assert.ok(
      !members.some((member) => member.isolation === "worktree"),
      "worktree handoff and integration verification required before acceptance",
    );
  }
  for (const [index, step] of status.steps.entries()) {
    const member = members?.[index];
    if (member)
      assert.equal(
        step.agent,
        member.role,
        "native wave member identity mismatch",
      );
    verifyNativeStepAcceptance(step, member?.mode ?? mode);
  }
  assert.notEqual(
    status.usageBudget?.exhausted,
    true,
    "native usage budget exhausted",
  );
}

function nativeRoleReceipts(mailbox, contract, result) {
  const roles = mailbox
    .listEvents()
    .filter((event) => event.type === "progress")
    .map((event) => mailbox.readJson(event.payloadRef, 16 * 1024))
    .filter((event) => event.kind === "role-started");
  assert.deepEqual(
    roles.map((role) => role.runId).sort(),
    [...result.childRunRefs].sort(),
    "result omitted or invented a role run",
  );
  return roles.map((role) => {
    assert.ok(
      typeof role.asyncDir === "string" && path.isAbsolute(role.asyncDir),
      "native status directory missing",
    );
    const file = path.join(role.asyncDir, "status.json");
    assert.ok(
      fs.statSync(file).size <= 1024 * 1024,
      "native status exceeds 1 MiB",
    );
    let status;
    try {
      status = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (cause) {
      throw new Error(`invalid native status: ${role.runId}`, { cause });
    }
    verifyNativeRoleStatus(status, {
      runId: role.runId,
      cwd: contract.workspace.sourceRoot,
      mode: role.mode,
      members: role.members,
    });
    return { runId: role.runId, statusRef: file, statusDigest: digest(status) };
  });
}

export class HostAcceptance {
  constructor({ orchestrator }) {
    assert.ok(orchestrator?.ledger, "TaskOrchestrator required");
    this.orchestrator = orchestrator;
  }

  #context(executionId) {
    const execution = this.orchestrator.ledger.getExecution(executionId);
    this.orchestrator.assertController(execution.projectId);
    const contract = this.orchestrator.ledger.getContract(executionId);
    const mailbox = Mailbox.open(
      path.join(
        this.orchestrator.runtimeRoot,
        "projects",
        execution.projectId,
        "executions",
        executionId,
      ),
      executionId,
    );
    verifyWorkspaceScope(contract, mailbox);
    return { execution, contract, mailbox };
  }

  #integrationContext(executionId, expectedState = "RESULT_READY") {
    const { execution, contract, mailbox } = this.#context(executionId);
    assert.equal(
      execution.state,
      expectedState,
      "integration requires the expected execution state",
    );
    const stored = this.orchestrator.ledger.getLatestResult(executionId);
    const result = mailbox.readJson(
      path.relative(mailbox.root, stored.resultRef),
    );
    validateTaskResult(result, contract, execution.requestDigest);
    assert.equal(digest(result), stored.resultDigest, "stored result changed");
    assert.equal(
      result.outcome,
      "ready_for_acceptance",
      "integration requires a ready candidate",
    );
    const context = {
      mailbox,
      contract,
      result,
      ownerSessionId: this.orchestrator.ownerSessionId,
      assertApplyGates: async (staged) => {
        if (contract.schemaVersion === "teams-task-runtime/3") {
          const candidate = await readSealedReviewCandidate(context);
          return integrationReviewBinding(context, staged, candidate);
        }
        assert.ok(
          contract.criteria.every((criterion) =>
            criterion.requiredEvidenceKinds.every(
              (kind) => kind === "host-check",
            ),
          ),
          "final integrated-source evidence binding required before apply",
        );
        const roles = mailbox
          .listEvents()
          .filter((event) => event.type === "progress")
          .map((event) => mailbox.readJson(event.payloadRef, 16 * 1024))
          .filter((event) => event.kind === "role-started");
        assert.deepEqual(
          roles.map((role) => role.runId).sort(),
          [...result.childRunRefs].sort(),
          "integration role inventory changed",
        );
        for (const role of roles) {
          const captured = staged.captures.filter(
            (file) => file.origin === path.join(role.asyncDir, "status.json"),
          );
          assert.equal(captured.length, 1, "captured native status required");
          let status;
          try {
            status = JSON.parse(
              readEvidenceBytes(
                path.join(mailbox.root, "integration", captured[0].saved),
              ).toString("utf8"),
            );
          } catch (cause) {
            throw new Error("invalid captured native status", { cause });
          }
          for (const [index, step] of status.steps.entries()) {
            const mode = role.members?.[index]?.mode ?? role.mode;
            verifyNativeStepAcceptance(step, mode);
            if (mode === "mutation" || mode === "check")
              assert.equal(
                step.acceptance?.effectiveAcceptance?.review?.required,
                false,
                "native review policy missing or final integrated-source review binding required (D4)",
              );
            else
              assert.ok(
                !step.acceptance?.effectiveAcceptance?.review?.required,
                "final integrated-source review binding required before apply (D4)",
              );
          }
        }
      },
      assertOwner: () => {
        const current = this.orchestrator.ledger.getExecution(executionId);
        this.orchestrator.assertExecutionOwner(current);
        const controller = this.orchestrator.assertController(
          execution.projectId,
        );
        assert.equal(
          controller.ownerEpoch,
          execution.ownerEpoch,
          "integration controller epoch changed",
        );
        assert.equal(
          this.orchestrator.ledger.getExecution(executionId).state,
          expectedState,
          "execution changed during integration",
        );
        verifyWorkspaceScope(contract, mailbox);
      },
    };
    return context;
  }

  stageIntegration(executionId) {
    const context = this.#integrationContext(executionId);
    verifyWorkspaceResult(context.contract, context.mailbox, context.result);
    return stageIntegration(context);
  }

  prepareIntegrationReview(executionId) {
    return prepareIntegrationReview(this.#integrationContext(executionId));
  }

  planIntegrationReview(executionId, wave, adapter) {
    return planReviewWave(this.#integrationContext(executionId), wave, adapter);
  }

  startIntegrationReview(executionId, key, planDigest, adapter) {
    return startReviewWave(
      this.#integrationContext(executionId),
      key,
      planDigest,
      adapter,
    );
  }

  collectIntegrationReview(executionId, key, planDigest) {
    return collectReviewWave(
      this.#integrationContext(executionId),
      key,
      planDigest,
    );
  }

  sealIntegrationReview(executionId) {
    return sealReviewCandidate(this.#integrationContext(executionId));
  }

  readAppliedIntegrationReview(executionId, planDigest) {
    return readAppliedReviewCandidate(
      this.#integrationContext(executionId),
      planDigest,
    );
  }

  verifyIntegrationApply(executionId, planDigest) {
    return verifyIntegrationApply(
      this.#integrationContext(executionId),
      planDigest,
    );
  }

  prepareIntegrationApply(executionId) {
    return prepareIntegrationApply(this.#integrationContext(executionId));
  }

  inspectIntegrationApply(executionId, planDigest) {
    return inspectIntegrationApply(
      this.#integrationContext(executionId),
      planDigest,
    );
  }

  async applyIntegration(executionId, planDigest, confirm) {
    const context = this.#integrationContext(executionId);
    const receipt = await executeIntegrationApply(context, {
      action: "apply",
      planDigest,
      confirm,
    });
    if (
      context.contract.schemaVersion === "teams-task-runtime/3" &&
      receipt.status === "applied"
    )
      await readAppliedReviewCandidate(context, planDigest);
    return receipt;
  }

  rollbackIntegration(executionId, planDigest, confirm) {
    return executeIntegrationApply(this.#integrationContext(executionId), {
      action: "rollback",
      planDigest,
      confirm,
    });
  }

  runChecks(executionId) {
    const { execution, contract, mailbox } = this.#context(executionId);
    assert.equal(
      execution.state,
      "RESULT_READY",
      "host checks require a result-ready execution",
    );
    if (
      contract.schemaVersion === "teams-task-runtime/3" &&
      contract.policy.integrationMode === "verify-only" &&
      fs.existsSync(path.join(mailbox.root, "integration/receipt.json"))
    ) {
      const context = this.#integrationContext(executionId);
      verifyWorkspaceResult(contract, mailbox, context.result);
      inspectWorktreeBase(
        contract.workspace.sourceRoot,
        contract.workspace.baseCommit,
      );
      const staged = readIntegrationRehearsal(context);
      return contract.checks.map((check) =>
        verifyCheck(
          checkInput(contract, { ...check, cwd: staged.cwd }),
          path.join(
            mailbox.root,
            "integration",
            `check-${check.commandId}.json`,
          ),
        ),
      );
    }
    let result, applied;
    if (
      contract.schemaVersion === "teams-task-runtime/3" &&
      fs.existsSync(
        path.join(mailbox.root, "integration/target-apply/apply-receipt.json"),
      )
    ) {
      const context = this.#integrationContext(executionId);
      const planDigest = this.#finalPlan(context);
      applied = () => verifyIntegrationApply(context, planDigest);
      applied();
    }
    if (contract.schemaVersion === "teams-task-runtime/3" && !applied) {
      const stored = this.orchestrator.ledger.getLatestResult(executionId);
      result = mailbox.readJson(path.relative(mailbox.root, stored.resultRef));
      assert.equal(
        digest(result),
        stored.resultDigest,
        "stored result changed",
      );
      verifyWorkspaceResult(contract, mailbox, result);
    }
    const checks = contract.checks.map((check) => {
      const receiptFile = path.join(
        mailbox.root,
        "evidence",
        `${applied ? "host-final-check" : "host-check"}-${check.commandId}.json`,
      );
      const input = checkInput(contract, check);
      if (fs.existsSync(receiptFile)) return verifyCheck(input, receiptFile);
      const receipt = runCheck(input, receiptFile);
      assert.equal(
        receipt.status,
        "verified",
        `host check failed: ${check.commandId}`,
      );
      return {
        status: receipt.status,
        receipt: receiptFile,
        sourceDigest: receipt.after.digest,
      };
    });
    if (applied) applied();
    if (result) {
      this.#context(executionId);
      verifyWorkspaceResult(contract, mailbox, result);
    }
    return checks;
  }

  #finalPlan({ contract, mailbox }) {
    if (contract.policy.integrationMode === "verify-only") {
      assert.ok(
        !fs.existsSync(path.join(mailbox.root, "integration/target-apply")),
        "verify-only cannot accept a target operation journal",
      );
      assert.ok(
        [
          "review-request.json",
          "review-candidate.json",
          "review-candidate-intent.json",
        ].every((name) =>
          fs.existsSync(path.join(mailbox.root, "integration", name)),
        ),
        "final review binding requires an existing sealed patch review",
      );
      return null;
    }
    const relative = "integration/target-apply/plan.json";
    assert.ok(
      contract.policy.integrationMode === "approved-integration" &&
        fs.existsSync(path.join(mailbox.root, relative)),
      "final review binding requires an existing approved target apply plan",
    );
    return mailbox.readJson(relative).planDigest;
  }

  async #finalEvidence(context) {
    const { contract, mailbox, result } = context;
    const planDigest = this.#finalPlan(context);
    const patchOnly = planDigest === null;
    const candidate = patchOnly
      ? await readSealedReviewCandidate(context)
      : await readAppliedReviewCandidate(context, planDigest);
    const application = patchOnly
      ? null
      : verifyIntegrationApply(context, planDigest);
    const staged = readIntegrationRehearsal(context);
    const binding = integrationReviewBinding(context, staged, candidate);
    if (application)
      assert.deepEqual(
        application.reviewBinding,
        binding,
        "final review binding changed",
      );
    const manifest = mailbox.readJson(result.source.manifestRef);
    assert.equal(
      manifest.cwd,
      contract.workspace.sourceRoot,
      "candidate manifest cwd changed",
    );
    assert.equal(
      digest(manifest.files),
      result.source.sourceDigest,
      "candidate manifest changed",
    );
    assert.equal(
      manifest.digest,
      result.source.sourceDigest,
      "candidate manifest digest changed",
    );
    for (const evidence of result.evidence)
      assert.equal(
        mailbox.digestRelative(evidence.uri),
        evidence.sha256,
        `evidence changed: ${evidence.evidenceId}`,
      );
    const usage = reviewUsageAdmission(
      context,
      { reservedTokens: 0 },
      measureClosedExecutionUsage({
        ...context,
        assertStopped: (boot) =>
          assert.equal(
            processTerminalProof(boot).terminal,
            true,
            "Worker must exit before final acceptance",
          ),
      }),
      { checkpointOnly: true },
    );
    assertTaskBudgetUsage(context, usage.sources, { complete: true });
    const source = snapshot(
      patchOnly ? staged.cwd : contract.workspace.sourceRoot,
      contract.workspace.sourcePaths,
    );
    assert.equal(
      source.digest,
      staged.sourceDigest,
      "delivered source differs from reviewed source",
    );
    const checks = contract.checks.map((check) => {
      const file = path.join(
        mailbox.root,
        patchOnly ? "integration" : "evidence",
        `${patchOnly ? "check" : "host-final-check"}-${check.commandId}.json`,
      );
      assert.ok(
        fs.existsSync(file),
        `missing final host check: ${check.commandId}`,
      );
      const verified = verifyCheck(
        checkInput(contract, patchOnly ? { ...check, cwd: staged.cwd } : check),
        file,
      );
      assert.equal(
        verified.sourceDigest,
        source.digest,
        `stale final host check: ${check.commandId}`,
      );
      return {
        commandId: check.commandId,
        receiptRef: file,
        digest: mailbox.digestRelative(path.relative(mailbox.root, file)),
      };
    });
    const criteria = contract.criteria.map((criterion) => {
      const row = result.criterionResults.find(
        (row) => row.criterionId === criterion.id,
      );
      assert.ok(
        ["met", "indeterminate"].includes(row.status),
        `criterion not met: ${criterion.id}`,
      );
      const ids = contract.checks
        .filter((check) => check.criterionIds.includes(criterion.id))
        .map((check) => check.commandId);
      assert.ok(
        ids.length > 0 &&
          ids.every((id) => checks.some((check) => check.commandId === id)),
        `criterion lacks final host checks: ${criterion.id}`,
      );
      return {
        criterionId: criterion.id,
        decision: "accepted",
        taskEvidenceIds: row.evidenceIds,
        hostCheckIds: ids,
      };
    });
    context.assertOwner();
    let delivery;
    if (patchOnly) {
      this.#finalPlan(context);
      verifyWorkspaceResult(contract, mailbox, result);
      inspectWorktreeBase(
        contract.workspace.sourceRoot,
        contract.workspace.baseCommit,
      );
      assert.equal(
        digest(readIntegrationRehearsal(context)),
        digest(staged),
        "verified patch rehearsal changed",
      );
      const request = mailbox.readJson(
        "integration/review-request.json",
        1024 * 1024,
      );
      const patchDigest = mailbox.digestRelative("integration/review.patch");
      assert.equal(
        patchDigest,
        request.subject.patch.sha256,
        "verified patch bytes changed",
      );
      delivery = {
        kind: "verified-patch",
        targetModified: false,
        targetRoot: contract.workspace.sourceRoot,
        sourceRoot: staged.cwd,
        baseCommit: contract.workspace.baseCommit,
        tree: staged.tree,
        patchRef: path.join(mailbox.root, "integration/review.patch"),
        patchDigest,
      };
    } else verifyIntegrationApply(context, planDigest);
    return {
      ...(patchOnly
        ? { delivery }
        : { planDigest, applicationDigest: digest(application) }),
      reviewBinding: binding,
      sourceDigest: source.digest,
      checks,
      criteria,
      usage,
      bootDigest: mailbox.digestRelative("receipts/boot.json"),
      bootstrapDigest: mailbox.digestRelative("bootstrap.json"),
      lifecycleDigest: digest(mailbox.listEvents()),
    };
  }

  async #acceptIntegrated(executionId) {
    const context = this.#integrationContext(executionId);
    const execution = this.orchestrator.ledger.getExecution(executionId);
    this.orchestrator.assertExecutionOwner(execution);
    assert.match(
      context.mailbox.readJson("bootstrap.json").controller?.instanceId ?? "",
      /^[a-f0-9-]{36}$/,
      "final acceptance requires the metered L0 lifecycle contract",
    );
    assert.equal(
      execution.unresolvedRunCount,
      0,
      "execution has unresolved runs",
    );
    const finalEvidence = await this.#finalEvidence(context);
    // Awaited native readback must not let two acceptors publish competing receipts.
    context.assertOwner();
    this.orchestrator.assertExecutionOwner(
      this.orchestrator.ledger.getExecution(executionId),
    );
    this.orchestrator.ledger.transition(
      executionId,
      "RESULT_READY",
      execution.revision,
      "VALIDATING",
    );
    const acceptanceId = randomUUID();
    const receipt = {
      schemaVersion:
        finalEvidence.delivery?.kind === "verified-patch"
          ? "teams-task-acceptance/3"
          : "teams-task-acceptance/2",
      acceptanceId,
      executionId,
      requestDigest: execution.requestDigest,
      resultDigest: digest(context.result),
      candidateSourceDigest: context.result.source.sourceDigest,
      sourceDigest: finalEvidence.sourceDigest,
      decision: "accepted",
      criteria: finalEvidence.criteria,
      finalEvidence,
      paneId: execution.paneId,
      receiptRef: path.join(
        context.mailbox.root,
        "receipts",
        `acceptance-${acceptanceId}.json`,
      ),
      controllerEpoch: execution.ownerEpoch,
      acceptedBySessionId: this.orchestrator.ownerSessionId,
      acceptedAt: new Date().toISOString(),
    };
    context.mailbox.writeReceipt(`acceptance-${acceptanceId}`, receipt);
    this.orchestrator.ledger.saveAcceptance(receipt);
    return {
      receipt,
      execution: this.orchestrator.ledger.getExecution(executionId),
    };
  }

  async verifyAccepted(executionId) {
    const context = this.#integrationContext(executionId, "ACCEPTED");
    const stored = this.orchestrator.ledger.getAcceptance(executionId);
    assert.ok(
      stored?.decision === "accepted",
      "accepted ledger receipt missing",
    );
    const receipt = context.mailbox.readJson(
      path.relative(context.mailbox.root, stored.receiptRef),
      1024 * 1024,
    );
    assert.equal(
      receipt.schemaVersion,
      context.contract.policy.integrationMode === "verify-only"
        ? "teams-task-acceptance/3"
        : "teams-task-acceptance/2",
      "final acceptance schema unavailable",
    );
    const execution = this.orchestrator.ledger.getExecution(executionId);
    for (const key of [
      "acceptanceId",
      "executionId",
      "requestDigest",
      "resultDigest",
      "sourceDigest",
      "receiptRef",
      "controllerEpoch",
      "decision",
      "acceptedAt",
    ])
      assert.equal(receipt[key], stored[key], `acceptance ${key} changed`);
    assert.equal(
      receipt.acceptedBySessionId,
      this.orchestrator.ownerSessionId,
      "acceptance owner changed",
    );
    assert.equal(
      receipt.candidateSourceDigest,
      context.result.source.sourceDigest,
      "accepted candidate changed",
    );
    assert.equal(receipt.paneId, execution.paneId, "accepted pane changed");
    assert.equal(
      execution.unresolvedRunCount,
      0,
      "accepted execution has unresolved runs",
    );
    const finalEvidence = await this.#finalEvidence(context);
    assert.deepEqual(
      receipt.finalEvidence,
      finalEvidence,
      "final acceptance evidence changed",
    );
    assert.equal(
      receipt.sourceDigest,
      finalEvidence.sourceDigest,
      "accepted source changed",
    );
    assert.deepEqual(
      receipt.criteria,
      finalEvidence.criteria,
      "accepted criteria changed",
    );
    return {
      receipt,
      execution: this.orchestrator.ledger.getExecution(executionId),
    };
  }

  accept(executionId) {
    let { execution, contract, mailbox } = this.#context(executionId);
    if (contract.schemaVersion === "teams-task-runtime/3") {
      if (execution.state === "ACCEPTED")
        return this.verifyAccepted(executionId);
      this.#finalPlan({ contract, mailbox });
      return this.#acceptIntegrated(executionId);
    }
    assert.equal(
      execution.state,
      "RESULT_READY",
      "execution is not ready for acceptance",
    );
    const stored = this.orchestrator.ledger.getLatestResult(executionId);
    const relativeResult = path.relative(mailbox.root, stored.resultRef);
    assert.ok(
      relativeResult && !relativeResult.startsWith(".."),
      "stored result escapes mailbox",
    );
    const result = mailbox.readJson(relativeResult);
    validateTaskResult(result, contract, execution.requestDigest);
    assert.equal(digest(result), stored.resultDigest, "stored result changed");
    verifyWorkspaceResult(contract, mailbox, result);
    const roleReceipts = nativeRoleReceipts(mailbox, contract, result);
    assert.equal(
      result.outcome,
      "ready_for_acceptance",
      "Task Pi did not submit an acceptable outcome",
    );
    for (const evidence of result.evidence)
      assert.equal(
        mailbox.digestRelative(evidence.uri),
        evidence.sha256,
        `evidence changed: ${evidence.evidenceId}`,
      );
    const manifest = mailbox.readJson(result.source.manifestRef);
    assert.equal(
      manifest.digest,
      result.source.sourceDigest,
      "source manifest mismatch",
    );

    const hostChecks = new Map();
    for (const check of contract.checks) {
      const receiptFile = path.join(
        mailbox.root,
        "evidence",
        `host-check-${check.commandId}.json`,
      );
      assert.ok(
        fs.existsSync(receiptFile),
        `missing host check: ${check.commandId}`,
      );
      const verified = verifyCheck(checkInput(contract, check), receiptFile);
      assert.equal(
        verified.sourceDigest,
        result.source.sourceDigest,
        `stale host check: ${check.commandId}`,
      );
      hostChecks.set(check.commandId, verified);
    }
    const criteria = contract.criteria.map((criterion) => {
      const row = result.criterionResults.find(
        (candidate) => candidate.criterionId === criterion.id,
      );
      const pendingHost =
        ["teams-task-runtime/2", "teams-task-runtime/3"].includes(
          contract.schemaVersion,
        ) &&
        row.status === "indeterminate" &&
        criterion.requiredEvidenceKinds.includes("host-check");
      assert.ok(
        row.status === "met" || pendingHost,
        `criterion not met: ${criterion.id}`,
      );
      const checkIds = contract.checks
        .filter((check) => check.criterionIds.includes(criterion.id))
        .map((check) => check.commandId);
      if (criterion.requiredEvidenceKinds.includes("host-check"))
        assert.ok(
          checkIds.length > 0 && checkIds.every((id) => hostChecks.has(id)),
          `criterion lacks host checks: ${criterion.id}`,
        );
      return {
        criterionId: criterion.id,
        decision: "accepted",
        taskEvidenceIds: row.evidenceIds,
        hostCheckIds: checkIds,
      };
    });
    const current = snapshot(
      contract.workspace.sourceRoot,
      contract.workspace.sourcePaths,
    );
    assert.equal(
      current.digest,
      result.source.sourceDigest,
      "source changed before acceptance",
    );

    execution = this.orchestrator.ledger.transition(
      executionId,
      "RESULT_READY",
      execution.revision,
      "VALIDATING",
    );
    const confirmed = snapshot(
      contract.workspace.sourceRoot,
      contract.workspace.sourcePaths,
    );
    assert.equal(
      confirmed.digest,
      current.digest,
      "source changed during acceptance",
    );
    const acceptanceId = randomUUID();
    const receiptName = `acceptance-${acceptanceId}`;
    const receiptRef = path.join(
      mailbox.root,
      "receipts",
      `${receiptName}.json`,
    );
    const receipt = {
      schemaVersion: "teams-task-acceptance/1",
      acceptanceId,
      executionId,
      requestDigest: execution.requestDigest,
      resultDigest: stored.resultDigest,
      sourceDigest: current.digest,
      decision: "accepted",
      criteria,
      roleReceipts,
      receiptRef,
      controllerEpoch: execution.ownerEpoch,
      acceptedBySessionId: this.orchestrator.ownerSessionId,
      acceptedAt: new Date().toISOString(),
    };
    mailbox.writeReceipt(receiptName, receipt);
    this.orchestrator.ledger.saveAcceptance(receipt);
    return {
      receipt,
      execution: this.orchestrator.ledger.getExecution(executionId),
    };
  }
}
