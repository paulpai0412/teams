import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [workspace, evidenceDir] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
assert.ok(
  workspace && evidenceDir,
  "usage: browser-todo-check.mjs WORKSPACE EVIDENCE_DIR",
);
const appRoot = path.join(workspace, "app");
const emptyStateVisible =
  "document.querySelector('[data-testid=empty]').checkVisibility({checkOpacity:true,checkVisibilityCSS:true})";
const edge = path.join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
assert.ok(fs.statSync(edge).isFile(), `Microsoft Edge not found: ${edge}`);
fs.mkdirSync(evidenceDir, { recursive: true });

const startedAt = Date.now();
const timings = {};
const runtimeErrors = [];
const ignoredRuntimeEvents = [];
const requests = [];
let browser;
let server;
let socket;
let profile;
let stderr = "";

function elapsed() {
  return Date.now() - startedAt;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) =>
    probe.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for ${url}: ${lastError?.message ?? "unknown"}`,
  );
}

class Cdp {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = ({ data }) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch (error) {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
    };
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const answer = new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.ws.send(JSON.stringify({ id, method, params }));
    return answer;
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text,
    );
  return response.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`browser condition timed out: ${expression}`);
}

async function screenshot(cdp, file) {
  const image = await cdp.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  fs.writeFileSync(file, Buffer.from(image.data, "base64"));
}

try {
  server = http.createServer((request, response) => {
    const requestPath =
      request.url === "/"
        ? "/index.html"
        : new URL(request.url, "http://local").pathname;
    if (requestPath === "/favicon.ico") {
      requests.push({ path: requestPath, status: 204 });
      response.writeHead(204).end();
      return;
    }
    const file = path.resolve(appRoot, `.${requestPath}`);
    if (
      !file.startsWith(`${appRoot}${path.sep}`) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      requests.push({ path: requestPath, status: 404 });
      response.writeHead(404).end("not found");
      return;
    }
    requests.push({ path: requestPath, status: 200 });
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const appPort = server.address().port;
  const debugPort = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "task-pi-edge-"));
  browser = spawn(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  browser.stderr.on("data", (chunk) => {
    if (stderr.length < 16_384) stderr += chunk.toString();
  });
  const version = await waitForJson(
    `http://127.0.0.1:${debugPort}/json/version`,
    15_000,
  );
  timings.browserReadyMs = elapsed();
  const targetResponse = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}/`)}`,
    { method: "PUT" },
  );
  assert.equal(
    targetResponse.ok,
    true,
    `cannot open browser target: ${targetResponse.status}`,
  );
  const target = await targetResponse.json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  socket = cdp;
  cdp.on("Runtime.exceptionThrown", (event) =>
    runtimeErrors.push({
      kind: "exception",
      detail: event.exceptionDetails?.text ?? "unknown",
    }),
  );
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (["error", "warning"].includes(entry?.level))
      runtimeErrors.push({
        kind: `console-${entry.level}`,
        detail: entry.text,
      });
  });
  cdp.on("Network.loadingFailed", (event) => {
    const failure = { kind: "network", detail: event.errorText };
    if (event.canceled || event.errorText === "net::ERR_ABORTED")
      ignoredRuntimeEvents.push(failure);
    else runtimeErrors.push(failure);
  });
  await Promise.all([
    cdp.call("Page.enable"),
    cdp.call("Runtime.enable"),
    cdp.call("Log.enable"),
    cdp.call("Network.enable"),
  ]);
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.call("Page.navigate", { url: `http://127.0.0.1:${appPort}/` });
  await waitFor(cdp, "document.readyState === 'complete'");
  await waitFor(
    cdp,
    "document.querySelector('#todo-form') && document.querySelector('#todo-input') && document.querySelector('#todo-list')",
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelectorAll('#todo-list [data-todo-id]').length",
    ),
    0,
    "initial list is not empty",
  );
  assert.equal(
    await evaluate(
      cdp,
      "Boolean(document.querySelector('[data-testid=empty]'))",
    ),
    true,
    "empty state missing",
  );
  assert.equal(
    await evaluate(cdp, emptyStateVisible),
    true,
    "empty state is not visible for an empty list",
  );

  await evaluate(
    cdp,
    `(() => { const input = document.querySelector('#todo-input'); input.value = 'Ship Task Pi'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#todo-form').requestSubmit(); return true; })()`,
  );
  await waitFor(
    cdp,
    "document.querySelectorAll('#todo-list [data-todo-id]').length === 1",
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelector('#todo-list').textContent.includes('Ship Task Pi')",
    ),
    true,
    "created todo missing",
  );
  assert.equal(
    await evaluate(cdp, emptyStateVisible),
    false,
    "empty state remains visible after creating a todo",
  );
  await evaluate(
    cdp,
    "document.querySelector('#todo-list input[type=checkbox]').click()",
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelector('#todo-list input[type=checkbox]').checked",
    ),
    true,
    "todo was not completed",
  );
  await evaluate(cdp, "document.querySelector('[data-filter=active]').click()");
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelectorAll('#todo-list [data-todo-id]').length",
    ),
    0,
    "active filter is wrong",
  );
  assert.equal(
    await evaluate(cdp, emptyStateVisible),
    true,
    "empty filtered list has no visible empty state",
  );
  await evaluate(
    cdp,
    "document.querySelector('[data-filter=completed]').click()",
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelectorAll('#todo-list [data-todo-id]').length",
    ),
    1,
    "completed filter is wrong",
  );
  await evaluate(
    cdp,
    "document.querySelector('#todo-list [data-action=delete]').click()",
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelectorAll('#todo-list [data-todo-id]').length",
    ),
    0,
    "delete failed",
  );
  assert.equal(
    await evaluate(cdp, emptyStateVisible),
    true,
    "empty state did not reappear after deletion",
  );

  await evaluate(cdp, "document.querySelector('[data-filter=all]').click()");
  await evaluate(
    cdp,
    `(() => { const input = document.querySelector('#todo-input'); input.value = 'Persist across reload'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#todo-form').requestSubmit(); return true; })()`,
  );
  await cdp.call("Page.reload", { ignoreCache: true });
  await waitFor(
    cdp,
    "document.readyState === 'complete' && document.querySelector('#todo-list')?.textContent.includes('Persist across reload')",
  );
  assert.equal(
    await evaluate(cdp, "localStorage.getItem('task-pi-todos-v1') !== null"),
    true,
    "localStorage persistence missing",
  );
  const desktopScreenshot = path.join(evidenceDir, "desktop.png");
  await screenshot(cdp, desktopScreenshot);

  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.call("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.readyState === 'complete'");
  assert.equal(
    await evaluate(
      cdp,
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
    true,
    "mobile horizontal overflow",
  );
  assert.equal(
    await evaluate(
      cdp,
      "(() => { const input = document.querySelector('#todo-input'); input.focus(); const style = getComputedStyle(input); return style.outlineStyle !== 'none' || style.boxShadow !== 'none'; })()",
    ),
    true,
    "focus indicator missing",
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelector('label[for=todo-input]') !== null || document.querySelector('#todo-input').getAttribute('aria-label') !== null",
    ),
    true,
    "todo input has no accessible label",
  );
  const mobileScreenshot = path.join(evidenceDir, "mobile.png");
  await screenshot(cdp, mobileScreenshot);
  await evaluate(
    cdp,
    `(() => { const input = document.querySelector('#todo-input'); input.value = '<svg onload="window.todoXss=1">'; document.querySelector('#todo-form').requestSubmit(); return true; })()`,
  );
  assert.equal(
    await evaluate(
      cdp,
      "document.querySelector('#todo-list svg') === null && document.querySelector('#todo-list').textContent.includes('<svg onload=') && !window.todoXss",
    ),
    true,
    "todo text was interpreted as HTML",
  );
  await evaluate(
    cdp,
    "localStorage.setItem('task-pi-todos-v1', '{broken'); true",
  );
  await cdp.call("Page.reload", { ignoreCache: true });
  await waitFor(
    cdp,
    "document.readyState === 'complete' && document.querySelector('#todo-form')",
  );
  await evaluate(
    cdp,
    "document.querySelector('#todo-input').value = 'Recovered storage'; document.querySelector('#todo-form').requestSubmit(); true",
  );
  await waitFor(
    cdp,
    "document.querySelector('#todo-list')?.textContent.includes('Recovered storage')",
  );
  timings.interactionsCompleteMs = elapsed();

  assert.deepEqual(
    requests.filter((request) => request.status >= 400),
    [],
    "browser requested missing assets",
  );
  assert.deepEqual(runtimeErrors, [], "browser emitted runtime errors");
  const report = {
    schemaVersion: "teams-browser-e2e/1",
    status: "passed",
    browser: version.Browser,
    protocolVersion: version["Protocol-Version"],
    viewports: ["1440x900", "390x844"],
    scenarios: [
      "empty",
      "empty-state-visibility",
      "create",
      "complete",
      "filter",
      "delete",
      "persistence",
      "responsive",
      "focus",
      "accessible-label",
      "text-not-html",
      "corrupt-storage-recovery",
    ],
    timings,
    requests,
    runtimeErrors,
    anomalies: [
      ...ignoredRuntimeEvents.map((event) => ({
        kind: "ignored-navigation-abort",
        detail: event.detail,
      })),
      ...(stderr.trim()
        ? [{ kind: "browser-stderr", detail: stderr.trim().slice(0, 2000) }]
        : []),
    ],
    screenshots: [desktopScreenshot, mobileScreenshot],
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(evidenceDir, "browser-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  socket?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (browser?.pid)
    spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
    });
  if (profile) {
    let cleanupError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        cleanupError = null;
        break;
      } catch (error) {
        cleanupError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (cleanupError) throw cleanupError;
  }
}
