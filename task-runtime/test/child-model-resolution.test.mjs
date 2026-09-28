// Regression for G1 r2 (20260917): in-process child sessions must resolve the
// configured role model from the profile's own extensions, exactly like
// pi-subagents ChildSessionLaunch: fresh ModelRuntime + profile extensionPaths.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  resolveCliModel,
} from "/home/timmypai/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

function profileModelAndExtensions(name) {
  const file = `/home/timmypai/.pi/agent/agents/${name}.md`;
  const text = fs.readFileSync(file, "utf8");
  const model = text.match(/^model: (.+)$/m)?.[1];
  const block = text.match(/^extensions:\n((?: {2}- .+\n)+)/m)?.[1];
  assert.ok(model, `${name} declares a model`);
  assert.ok(block, `${name} declares extensions`);
  return {
    model,
    extensions: block
      .trim()
      .split("\n")
      .map((line) => line.replace(/^ {2}- /, "").trim()),
  };
}

// Mirrors child-session.ts: loader with ONLY the profile's extension paths and
// no ambient discovery; queued provider registrations flushed into one runtime.
async function resolveLikeInProcessChild(profile) {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "child-model-"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: "/home/timmypai/.pi/agent",
    settingsManager: SettingsManager.create(cwd, "/home/timmypai/.pi/agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: profile.extensions,
  });
  await loader.reload();
  const { runtime: runtimeState } = loader.getExtensions();
  for (const { name, config } of runtimeState.pendingProviderRegistrations ??
    [])
    runtime.registerProvider(name, config);
  const resolved = resolveCliModel({
    cliModel: profile.model,
    modelRuntime: runtime,
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  return resolved;
}

test("in-process child sessions resolve their configured profile model", async () => {
  const { model, extensions } = profileModelAndExtensions("team.implementer");
  const resolved = await resolveLikeInProcessChild({ model, extensions });
  assert.equal(
    resolved.error,
    undefined,
    `profile model ${model} must resolve with only profile extensions: ${resolved.error}`,
  );
  assert.equal(resolved.model.provider + "/" + resolved.model.id, model);
});

test("extension-registered providers require the provider extension in profiles", async () => {
  const profile = profileModelAndExtensions("team.implementer");
  const withoutProvider = {
    model: "antigravity/gemini-3.7-flash:high",
    extensions: profile.extensions.filter(
      (file) => !file.includes("pi-antigravity"),
    ),
  };
  const broken = await resolveLikeInProcessChild(withoutProvider);
  assert.match(String(broken.error), /not found/);
});

test("built-in providers resolve with no profile extension at all", async () => {
  const resolved = await resolveLikeInProcessChild({
    model: "openai-codex/gpt-5.6-luna:high",
    extensions: [],
  });
  assert.equal(resolved.error, undefined);
  assert.equal(
    resolved.model.provider + "/" + resolved.model.id,
    "openai-codex/gpt-5.6-luna",
  );
});
