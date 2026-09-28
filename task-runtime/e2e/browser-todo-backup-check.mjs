#!/usr/bin/env node
// Browser E2E for the independent, disposable Todo backup inspector. The
// candidate's JavaScript runs only in a fresh headless browser, not in Node.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { observedHostAdGuardInjection } from "./browser-request-attribution.mjs";

const [sourceArg, evidenceArg, mode] = process.argv.slice(2);
assert.ok(
  sourceArg && evidenceArg && (!mode || mode === "combined"),
  "usage: browser-todo-backup-check.mjs WORKSPACE EVIDENCE_DIR [combined]",
);
const sourceRoot = path.resolve(sourceArg);
const evidenceDir = path.resolve(evidenceArg);
const documentRoot =
  mode === "combined" ? sourceRoot : path.join(sourceRoot, "backup");
const edge = path.join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
assert.ok(
  fs.statSync(edge).isFile(),
  "designated Microsoft Edge is unavailable",
);
fs.mkdirSync(evidenceDir, { recursive: true });
const errors = [],
  externalRequests = [],
  environmentRequests = [],
  checks = [];
let server,
  browser,
  socket,
  profile,
  phase = "startup",
  stderr = "";
let lastExpression;
function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) =>
    probe.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function waitForJson(url) {
  let lastError;
  for (let i = 0; i < 300; i += 1) {
    try {
      const reply = await fetch(url);
      if (reply.ok) return reply.json();
      lastError = new Error(`HTTP ${reply.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `browser did not become ready: ${lastError?.message ?? "unknown"}`,
  );
}
class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = ({ data }) => {
      let event;
      try {
        event = JSON.parse(String(data));
      } catch (error) {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        return;
      }
      if (!event || typeof event !== "object") return;
      if (event.id) {
        const pending = this.pending.get(event.id);
        if (!pending) return;
        this.pending.delete(event.id);
        if (event.error) pending.reject(new Error(event.error.message));
        else pending.resolve(event.result ?? {});
      } else
        for (const callback of this.listeners.get(event.method) ?? [])
          callback(event.params ?? {});
    };
  }
  on(name, callback) {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    const response = new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.ws.send(JSON.stringify({ id, method, params }));
    return response;
  }
  close() {
    this.ws.close();
  }
}
async function evaluate(expression) {
  lastExpression = expression;
  const result = await socket.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  return result.result?.value;
}
async function until(expression) {
  for (let i = 0; i < 125; i += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`browser condition timed out: ${expression}`);
}
async function image(file) {
  const shot = await socket.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  fs.writeFileSync(
    path.join(evidenceDir, file),
    Buffer.from(shot.data, "base64"),
  );
}
function report(status, extra = {}) {
  const value = {
    schemaVersion: "teams-browser-backup-e2e/1",
    status,
    mode: mode ?? "standalone",
    phase,
    checks,
    errors,
    externalRequests,
    environmentRequests,
    expression: lastExpression,
    finishedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(
    path.join(evidenceDir, "browser-report.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
  return value;
}
try {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://local").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const allowed =
      mode !== "combined" ||
      pathname.startsWith("/app/") ||
      pathname.startsWith("/backup/");
    const route = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const file = path.resolve(documentRoot, `.${route}`);
    if (
      !allowed ||
      !file.startsWith(`${documentRoot}${path.sep}`) ||
      !fs.existsSync(file) ||
      !fs.lstatSync(file).isFile() ||
      !fs.realpathSync(file).startsWith(`${documentRoot}${path.sep}`)
    ) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const debugPort = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "task-pi-backup-edge-"));
  browser = spawn(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  browser.stderr.on("data", (chunk) => {
    if (stderr.length < 8192) stderr += String(chunk);
  });
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const targetResponse = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  assert.equal(targetResponse.ok, true, "cannot open browser target");
  socket = new Cdp((await targetResponse.json()).webSocketDebuggerUrl);
  socket.on("Runtime.exceptionThrown", (event) =>
    errors.push(event.exceptionDetails?.text ?? "runtime exception"),
  );
  socket.on("Log.entryAdded", ({ entry }) => {
    if (["error", "warning"].includes(entry?.level)) errors.push(entry.text);
  });
  socket.on("Network.requestWillBeSent", (event) => {
    const url = event.request?.url ?? "";
    if (!/^https?:/.test(url) || url.startsWith(base + "/")) return;
    if (observedHostAdGuardInjection(event, documentRoot, base))
      environmentRequests.push(url);
    else externalRequests.push(url);
  });
  await Promise.all(
    ["Page", "Runtime", "Log", "Network"].map((area) =>
      socket.call(`${area}.enable`),
    ),
  );
  await socket.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  let actualAppData = null;
  if (mode === "combined") {
    phase = "combined-app-to-backup";
    await socket.call("Page.navigate", { url: `${base}/app/` });
    await until(
      "document.readyState === 'complete' && !!document.querySelector('#todo-form')",
    );
    await evaluate(`(() => { const form=document.querySelector('#todo-form');
      const input=document.querySelector('#todo-input'); input.value='From live Todo — 合併驗證';
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; })()`);
    await until(
      "!!localStorage.getItem('task-pi-todos-v1') && !!document.querySelector('#todo-list [data-todo-id]')",
    );
    actualAppData = await evaluate("localStorage.getItem('task-pi-todos-v1')");
    assert.ok(
      Array.isArray(JSON.parse(actualAppData)) &&
        JSON.parse(actualAppData).length >= 1,
      "app did not store compatible Todo array",
    );
    checks.push("app-live-storage");
  }
  phase = "initial-backup";
  await socket.call("Page.navigate", {
    url: mode === "combined" ? `${base}/backup/` : `${base}/`,
  });
  await until(
    "document.readyState === 'complete' && !!document.querySelector('#backup-json') && !!document.querySelector('#preview-button')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('label[for=backup-json]')?.textContent.trim().length > 0",
    ),
    true,
  );
  assert.equal(
    await evaluate("document.querySelector('#backup-json').tagName"),
    "TEXTAREA",
  );
  checks.push("label-and-entrypoint");
  const sample = [
    { id: "a", text: "Todo — 日本語, commas", completed: false },
    { id: "b", text: "<svg onload=alert(1)> & quotes", completed: true },
  ];
  const data = actualAppData ?? JSON.stringify(sample);
  phase = "preview";
  await evaluate(`(() => { const input=document.querySelector('#backup-json'); input.value=${JSON.stringify(data)};
    document.querySelector('#preview-button').click(); return true; })()`);
  await until(
    "document.querySelectorAll('#backup-list [data-todo-id]').length >= 1",
  );
  const preview =
    await evaluate(`(() => ({rows:[...document.querySelectorAll('#backup-list [data-todo-id]')].map(row=>({id:row.getAttribute('data-todo-id'),text:row.textContent})),
    alert:document.querySelector('#backup-error')?.textContent??'',
    count:document.querySelector('#backup-count')?.textContent??'',
    injected:!!document.querySelector('#backup-list svg'),
    href:document.querySelector('#download-backup')?.href??''}))()`);
  const parsed = JSON.parse(data);
  assert.equal(
    preview.rows.length,
    parsed.length,
    "preview row count differs from input",
  );
  assert.equal(
    preview.rows[0].text.includes(parsed[0].text),
    true,
    "preview lost Todo text",
  );
  assert.equal(preview.injected, false, "preview parsed Todo text as HTML");
  assert.equal(
    preview.alert.trim(),
    "",
    "valid input unexpectedly reported an error",
  );
  assert.ok(
    preview.count.includes(String(parsed.length)),
    "count did not match input",
  );
  assert.ok(
    preview.href.startsWith("blob:"),
    "valid backup has no downloadable Blob URL",
  );
  const exported = await evaluate(
    `fetch(${JSON.stringify(preview.href)}).then(r=>r.text())`,
  );
  assert.deepEqual(
    JSON.parse(exported),
    parsed,
    "downloaded backup differs from preview input",
  );
  checks.push("valid-preview-text-not-html-count-and-download");
  await image("desktop.png");
  phase = "invalid-json";
  await evaluate(`(() => { document.querySelector('#backup-json').value='{malformed';
    document.querySelector('#preview-button').click(); return true; })()`);
  await until("!!document.querySelector('#backup-error')?.textContent.trim()");
  assert.equal(
    await evaluate(
      "document.querySelector('#backup-error').getAttribute('role')",
    ),
    "alert",
  );
  assert.equal(
    await evaluate(
      "!document.querySelector('#download-backup')?.href.startsWith('blob:') || document.querySelector('#download-backup').hidden",
    ),
    true,
    "stale valid backup remained downloadable after invalid input",
  );
  checks.push("malformed-json-rejected-no-stale-download");
  phase = "missing-required-field";
  await evaluate(`(() => { document.querySelector('#backup-json').value=${JSON.stringify(JSON.stringify(sample))};
    document.querySelector('#preview-button').click(); return true; })()`);
  await until(
    "document.querySelector('#download-backup')?.href.startsWith('blob:')",
  );
  await evaluate(`(() => { document.querySelector('#backup-json').value='[{"id":"missing","text":"no completed flag"}]';
    document.querySelector('#preview-button').click(); return true; })()`);
  await until("!!document.querySelector('#backup-error')?.textContent.trim()");
  assert.match(
    await evaluate("document.querySelector('#backup-error').textContent"),
    /missing|required|completed/i,
  );
  assert.equal(
    await evaluate(
      "!document.querySelector('#download-backup')?.href.startsWith('blob:') || document.querySelector('#download-backup').hidden",
    ),
    true,
    "missing-field input left a stale valid download",
  );
  checks.push("missing-field-rejected-no-stale-download");
  phase = "mobile";
  await socket.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
    "mobile horizontal overflow",
  );
  await image("mobile.png");
  checks.push("mobile-no-overflow");
  assert.deepEqual(errors, [], "browser runtime errors");
  assert.deepEqual(
    externalRequests,
    [],
    "external network request from candidate",
  );
  console.log(
    JSON.stringify(
      report("passed", {
        screenshots: ["desktop.png", "mobile.png"],
        browserStderr: stderr.slice(0, 2000),
      }),
    ),
  );
} catch (error) {
  report("failed", {
    error: String(error.stack ?? error).slice(0, 8000),
    browserStderr: stderr.slice(0, 2000),
  });
  throw error;
} finally {
  socket?.close();
  if (browser?.pid)
    spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15000,
    });
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (profile) {
    let failure;
    for (let i = 0; i < 20; i += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        failure = null;
        break;
      } catch (error) {
        failure = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (failure) {
      console.error(`browser profile cleanup failed: ${failure.message}`);
      process.exitCode = 1;
    }
  }
}
