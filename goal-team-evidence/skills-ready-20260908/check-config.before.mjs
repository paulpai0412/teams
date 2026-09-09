// Local configuration/integration checks: no model calls and no child agents.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";
import {
  DefaultResourceLoader,
  ModelRuntime,
} from "/home/timmypai/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

process.env.PI_OFFLINE = "1";
process.env.PI_MEMORY_EXIT_SUMMARY = "off";
const root = path.join(os.homedir(), ".pi/agent");
const modelsOnly = process.argv.includes("--models-only");
const rolesOnly = process.argv.includes("--roles-only");
assert.ok(!(modelsOnly && rolesOnly), "choose one check scope");
const args = process.argv.slice(2);
const roleArgs = args.filter((arg) => arg.startsWith("--roles="));
assert.ok(roleArgs.length <= 1, "specify --roles only once");
assert.ok(!roleArgs.length || rolesOnly, "--roles requires --roles-only");
const selectedRoles = roleArgs.length
  ? roleArgs[0].slice("--roles=".length).split(",")
  : null;
assert.ok(
  !selectedRoles ||
    (selectedRoles.every((name) => /^team\.[a-z]+$/.test(name)) &&
      new Set(selectedRoles).size === selectedRoles.length),
  "--roles requires unique canonical team.* names",
);
for (const arg of args) {
  assert.ok(
    !arg.startsWith("-") ||
      ["--models-only", "--roles-only"].includes(arg) ||
      arg.startsWith("--roles="),
    "unknown option: " + arg,
  );
}
const cwdArgs = args.filter((arg) => !arg.startsWith("-"));
assert.ok(cwdArgs.length <= 1, "specify at most one cwd");
const cwdArg = cwdArgs[0];
const cwd = cwdArg ? path.resolve(cwdArg) : process.cwd();
const json = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch {
    throw new Error("Invalid or unreadable configuration: " + file);
  }
};
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-tui":
      "/home/timmypai/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
  },
});
const pkg = path.join(root, "npm/node_modules/pi-subagents/src");
const { discoverAgents } = await jiti.import(
  path.join(pkg, "agents/agents.ts"),
);
const { resolveSkills } = await jiti.import(path.join(pkg, "agents/skills.ts"));
const { validatePermissionConfig, resolvePermissionRules, permissionDecision } =
  await jiti.import(path.join(pkg, "runs/shared/permissions.ts"));
const { resolveMcpDirectToolResolution } = await jiti.import(
  path.join(pkg, "runs/shared/mcp-direct-tool-allowlist.ts"),
);
const { loadConfig } = await jiti.import(path.join(pkg, "extension/config.ts"));
const { resolveModelScopesForAgent, checkModelScope } = await jiti.import(
  path.join(pkg, "runs/shared/model-scope.ts"),
);
const settings = json("settings.json");
const config = json("extensions/subagent/config.json");
const permissions = validatePermissionConfig(config.permissions);
const loadedConfig = loadConfig();
assert.equal(
  loadedConfig.globalConcurrencyLimit,
  3,
  "runtime must not silently fall back to defaults",
);
assert.equal(loadedConfig.maxSubagentSpawnsPerRun, 8);
assert.equal(
  settings.defaultProvider + "/" + settings.defaultModel,
  "openai-codex/gpt-5.6-sol",
);
assert.equal(settings.defaultThinkingLevel, "high");
assert.equal(settings.subagents.disableBuiltins, true);
assert.deepEqual(settings.subagents.defaultExtensions, []);
assert.equal(settings.subagents.defaultModel, "openai-codex/gpt-5.6-luna");
assert.equal(settings.subagents.modelScope.enforce, true);
assert.equal(settings.subagents.modelScope.strict, true);
assert.deepEqual(settings.subagents.modelScope.allow, [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-6-astra",
]);
assert.equal(settings.subagents.maxThinking, "max");
const models = await ModelRuntime.create({ allowModelNetwork: false });
for (const id of [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-6-astra",
])
  assert.ok(
    models.getModel("openai-codex", id),
    id + " must exist in the local registry",
  );
assert.equal(config.maxSubagentDepth, 1);
assert.equal(config.maxActiveAsyncRunsPerSession, 1);
assert.equal(config.scheduledRuns.enabled, false);
assert.equal(config.authorityPolicy.scheduleCreate, "forbid");
for (const action of [
  "discardWorktree",
  "destructiveCleanup",
  "spawnBudgetGrant",
])
  assert.equal(config.authorityPolicy[action], "confirm");
assert.equal(settings.subagents.watchdog.enabled, false);
const expected = [
  "advisor",
  "challenger",
  "curator",
  "debugger",
  "docs",
  "e2e",
  "implementer",
  "planner",
  "qa",
  "release",
  "researcher",
  "reviewer",
  "security",
  "verifier",
]
  .map((x) => "team." + x)
  .sort();
const discovered = discoverAgents(cwd, "both");
assert.deepEqual(discovered.agentDiagnostics, []);
if (selectedRoles) {
  for (const name of selectedRoles) {
    assert.ok(expected.includes(name), "unknown team role: " + name);
    assert.equal(
      discovered.agents.filter((agent) => agent.name === name).length,
      1,
      "selected role missing or ambiguous: " + name,
    );
  }
} else {
  assert.deepEqual(
    discovered.agents.map((x) => x.name).sort(),
    expected,
    "unexpected legacy/project agent or missing team role",
  );
}
const agentsToCheck = discovered.agents.filter(
  (agent) => !selectedRoles || selectedRoles.includes(agent.name),
);
const rows = [];
const failures = [];
for (const agent of agentsToCheck) {
  try {
    const advisor = agent.name === "team.advisor";
    const deep = ["team.challenger", "team.reviewer", "team.security"].includes(
      agent.name,
    );
    const expectedModel =
      "openai-codex/" +
      (advisor
        ? "gpt-6-astra"
        : agent.name === "team.planner"
          ? "gpt-5.6-sol"
          : deep
            ? "gpt-5.6-terra"
            : "gpt-5.6-luna");
    const expectedThinking =
      agent.name === "team.advisor"
        ? "medium"
        : ["team.verifier", "team.curator"].includes(agent.name)
          ? "low"
          : ["team.docs", "team.e2e", "team.qa", "team.researcher"].includes(
                agent.name,
              )
            ? "medium"
            : "high";
    assert.equal(agent.model, expectedModel);
    assert.equal(agent.thinking, expectedThinking);
    assert.equal(agent.fallbackModels?.length ?? 0, 0);
    assert.deepEqual(discovered.modelScope.agents[agent.name].allow, [
      expectedModel,
    ]);
    const scopes = resolveModelScopesForAgent(
      discovered.modelScope,
      agent.name,
      {
        provider: "openai-codex",
        id: "gpt-6-astra",
      },
    );
    for (const source of ["explicit", "inherited"]) {
      assert.ok(
        scopes.every((scope) => !checkModelScope(expectedModel, scope, source)),
      );
      for (const forbidden of [
        "github-copilot/gpt-5.6-luna",
        ...(!advisor ? ["openai-codex/gpt-6-astra:high"] : []),
      ]) {
        assert.ok(
          scopes.some(
            (scope) =>
              checkModelScope(forbidden, scope, source)?.severity === "error",
          ),
          agent.name + " must reject " + forbidden,
        );
      }
    }
    if (modelsOnly) {
      rows.push({
        name: agent.name,
        model: agent.model,
        thinking: agent.thinking,
      });
      continue;
    }
    assert.equal(agent.defaultContext, "fresh");
    assert.equal(agent.inheritSkills, false);
    assert.equal(agent.inheritGlobalContext, false);
    assert.equal(agent.memory.scope, "project");
    assert.ok(Array.isArray(agent.extensions));
    for (const extension of [
      ...agent.extensions,
      ...(agent.subagentOnlyExtensions ?? []),
    ]) {
      assert.ok(fs.existsSync(extension), extension);
      assert.ok(
        !/pi-goal-x/.test(extension),
        agent.name + " must not load goal runtime",
      );
    }
    for (const tool of [
      "subagent",
      "workflow",
      "mcp",
      "mcpScript",
      "memory_write",
      "agent_send",
      "send_to_session",
      "create_goal",
      "get_goal",
      "update_goal",
      "set_goal_tasks",
      "update_goal_task",
    ])
      assert.ok(
        !agent.tools.includes(tool),
        agent.name + " unexpected " + tool,
      );
    const skills = resolveSkills(
      agent.skills,
      cwd,
      agent.skillPath,
      path.dirname(agent.filePath),
    );
    if (skills.missing.length)
      throw Object.assign(
        new Error(agent.name + " missing skill: " + skills.missing.join(", ")),
        { missingSkills: skills.missing },
      );
    assert.ok(agent.skills.includes("team-member"));
    const mcp = resolveMcpDirectToolResolution(agent.mcpDirectTools, cwd);
    assert.deepEqual(
      mcp.unresolvedSelectors,
      [],
      agent.name + ": refresh MCP metadata via /mcp reconnect before launch",
    );
    assert.equal(mcp.selections.length, agent.mcpDirectTools?.length ?? 0);
    for (const selection of mcp.selections)
      assert.ok(!/index_repository|delete|manage|ingest/.test(selection.name));
    const writer = ["team.implementer", "team.docs", "team.release"].includes(
      agent.name,
    );
    if (writer)
      assert.equal(
        agent.defaultAcceptance?.report,
        "on",
        agent.name + " must require native acceptanceReport",
      );
    assert.ok(
      agent.systemPrompt.includes("outputSchema"),
      agent.name + " must defer to the assigned format",
    );
    assert.ok(
      !agent.systemPrompt.includes("Always include verdict"),
      "generic handoff must not add forbidden schema fields",
    );
    const rules = resolvePermissionRules(permissions, agent.permissions);
    for (const tool of ["write", "edit"]) {
      assert.equal(agent.tools.includes(tool), writer);
      assert.equal(permissionDecision(rules, tool), writer ? "allow" : "deny");
    }
    const shell = [
      "team.implementer",
      "team.verifier",
      "team.e2e",
      "team.debugger",
    ].includes(agent.name);
    assert.equal(agent.tools.includes("bash"), shell);
    if (agent.name === "team.debugger") {
      const implementer = discovered.agents.find(
        (x) => x.name === "team.implementer",
      );
      assert.deepEqual(
        [...agent.tools].sort(),
        implementer.tools.filter((x) => !["write", "edit"].includes(x)).sort(),
      );
      assert.deepEqual(agent.mcpDirectTools, implementer.mcpDirectTools);
      assert.deepEqual(agent.extensions, implementer.extensions);
      assert.deepEqual(agent.skills, [
        "team-member",
        "diagnosing-bugs",
        "codebase-memory",
      ]);
      assert.equal(agent.acceptanceRole, "read-only");
      assert.equal(agent.memory.path, "team-debugger");
      assert.equal(agent.maxSubagentDepth, 1);
      assert.equal(agent.defaultTimeoutMs, 1800000);
      assert.equal(agent.defaultAsync, true);
    }
    rows.push({
      name: agent.name,
      model: agent.model,
      thinking: agent.thinking,
      tools: [...agent.tools, ...mcp.selections.map((x) => x.name)],
      extensions: agent.extensions,
      skills: skills.resolved.map((x) => ({ name: x.name, path: x.path })),
    });
  } catch (error) {
    failures.push({
      name: agent.name,
      message: error.message,
      kind: Array.isArray(error.missingSkills)
        ? "missing-declared-skill"
        : "role-contract",
      ...(Array.isArray(error.missingSkills)
        ? { missingSkills: error.missingSkills }
        : {}),
    });
  }
}
if (failures.length) {
  console.log(
    JSON.stringify(
      {
        status: "FAIL",
        scope: modelsOnly
          ? "model-routing-only"
          : selectedRoles
            ? "selected-role-contracts-only"
            : "role-contracts-only",
        requestedRoles: selectedRoles,
        cwd,
        modelCalls: 0,
        childAgents: 0,
        roles: rows,
        failures,
        uncheckedRoles: discovered.agents
          .filter((agent) => !agentsToCheck.includes(agent))
          .map((agent) => agent.name),
        limitations: [
          "Every selected role was inspected; failed roles are not launch-ready. Global extension loading and live environment readiness are not certified.",
          "Missing declared guidance is distinct from a missing executable. Parent must review remediation; never install capabilities or remove requirements automatically. Checks after the failure remain unverified.",
        ],
      },
      null,
      2,
    ),
  );
  console.error(failures.map((failure) => failure.message).join("\n"));
  process.exit(1);
}
if (modelsOnly) {
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        scope: "model-routing-only",
        modelCalls: 0,
        childAgents: 0,
        cwd,
        roles: rows,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (rolesOnly) {
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        scope: selectedRoles
          ? "selected-role-contracts-only"
          : "role-contracts-only",
        requestedRoles: selectedRoles,
        uncheckedRoles: discovered.agents
          .filter((agent) => !agentsToCheck.includes(agent))
          .map((agent) => agent.name),
        modelCalls: 0,
        childAgents: 0,
        cwd,
        roles: rows,
        limitations: [
          "Checks selected role models, skills, MCP selectors and permissions; shared safety settings and discovery diagnostics remain blocking. Unchecked roles are not certified. Without --roles all role contracts are checked. Not global extension loading, live child execution or OS isolation.",
        ],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const mcp = json("mcp.json");
assert.equal(mcp.settings.sampling, false);
assert.equal(mcp.settings.approveTools, true);
assert.equal(mcp.settings.toolPrefix, "server");
assert.deepEqual(Object.keys(mcp.mcpServers), ["codebase-memory-mcp"]);
assert.deepEqual(mcp.mcpServers["codebase-memory-mcp"].approveTools, [
  "index_repository",
]);
assert.ok(
  !mcp.mcpServers["codebase-memory-mcp"].includeTools.includes(
    "delete_project",
  ),
);
const loader = new DefaultResourceLoader({ cwd, agentDir: root });
await loader.reload();
const extensions = loader.getExtensions();
assert.deepEqual(extensions.errors, []);
for (const ext of extensions.extensions) {
  assert.ok(
    !/harness-x|pi-brainstorm|pi-gateway|remote-pi|extensions\/(workflow|loop|control)\//.test(
      ext.path,
    ),
    "unexpected active extension " + ext.path,
  );
}
const available = new Set(
  extensions.extensions.flatMap((ext) => [...ext.tools.keys()]),
);
for (const tool of [
  "subagent",
  "ask_user",
  "memory_write",
  "web_search",
  "mcp",
  "create_goal",
  "get_goal",
  "update_goal",
  "set_goal_tasks",
  "update_goal_task",
])
  assert.ok(available.has(tool), "missing main tool " + tool);
for (const tool of [
  "workflow",
  "agent_send",
  "send_to_session",
  "gateway_start",
  "meeting_append_entry",
])
  assert.ok(!available.has(tool), "unexpected main tool " + tool);
for (const row of rows)
  for (const tool of row.tools) {
    if (
      !["read", "grep", "find", "ls", "edit", "write", "bash"].includes(tool) &&
      !tool.startsWith("codebase-memory-mcp_")
    )
      assert.ok(
        available.has(tool),
        row.name + " missing provider tool " + tool,
      );
  }
assert.ok(
  loader
    .getAgentsFiles()
    .agentsFiles.some((x) => x.path === path.join(root, "AGENTS.md")),
);
assert.ok(loader.getSkills().skills.some((x) => x.name === "team-flow"));
assert.ok(loader.getPrompts().prompts.some((x) => x.name === "team"));
assert.deepEqual(loader.getSkills().diagnostics, []);

// Shared gate regression also runs independently of global extension discovery.
const { checkOutcomeGate } = await import("./check-team-outcomes.mjs");
const checks = await checkOutcomeGate();
const { checkHandoffContract } = await import("./check-handoff-contract.mjs");
const handoffChecks = await checkHandoffContract();
console.log(
  JSON.stringify(
    {
      status: "PASS",
      modelCalls: 0,
      childAgents: 0,
      cwd,
      roles: rows,
      activeExtensions: extensions.extensions.map((x) => x.path),
      mainSkills: loader.getSkills().skills.map((x) => x.name),
      gateCases: checks,
      handoffCases: handoffChecks,
      limitations: [
        "No live model/child E2E; no OS sandbox; source attestation is rechecked by parent; project/per-call overrides remain trusted authority.",
      ],
    },
    null,
    2,
  ),
);
process.exit(0);
