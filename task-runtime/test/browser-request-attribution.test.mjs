import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { observedHostAdGuardInjection } from "../e2e/browser-request-attribution.mjs";

const base = "http://127.0.0.1:49154",
  page = `${base}/`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-attribution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<!doctype html>\n<script src="client.js"></script>\n',
  );
  return root;
}
const content = {
  request: {
    url: `http://local.adguard.org/?type=content-script&dmn=127.0.0.1:49154&url=${encodeURIComponent(page)}&app=msedge.exe&css=2&js=1`,
  },
  documentURL: page,
  initiator: { type: "parser", url: page, lineNumber: 0, columnNumber: 350 },
};
const extra = {
  request: {
    url: "http://local.adguard.org/?name=AdGuard%20Extra&name=AdGuard%20Popup%20Blocker&type=user-script",
  },
  documentURL: page,
  initiator: { type: "parser", url: page, lineNumber: 0, columnNumber: 550 },
};
const subordinate = {
  request: {
    url: `http://local.adguard.org/?type=sfbr-script&u=${encodeURIComponent(page)}`,
  },
  documentURL: page,
  initiator: {
    type: "script",
    stack: {
      callFrames: [{ url: "http://local.adguard.org/?type=content-script" }],
    },
  },
};

test("classifies only observed injected AdGuard signatures as host-origin", (t) => {
  const root = fixture(t);
  for (const event of [content, extra, subordinate])
    assert.equal(observedHostAdGuardInjection(event, root, base), true);
  fs.writeFileSync(
    path.join(root, "index.html"),
    "<!doctype html>".padEnd(800, " "),
  );
  assert.equal(
    observedHostAdGuardInjection(content, root, base),
    true,
    "minified HTML must not change attribution",
  );
});
test("candidate external network and lookalikes remain failures", (t) => {
  const root = fixture(t);
  const bad = [
    { ...content, request: { url: "https://external.example/api" } },
    {
      ...content,
      request: { url: "http://local.adguard.org/?type=content-script" },
    },
    { ...content, initiator: { ...content.initiator, columnNumber: -1 } },
    {
      ...content,
      initiator: {
        type: "script",
        stack: { callFrames: [{ url: `${base}/client.js` }] },
      },
    },
    { ...content, documentURL: "http://127.0.0.1:9999/" },
    {
      ...subordinate,
      initiator: {
        type: "script",
        stack: { callFrames: [{ url: `${base}/client.js` }] },
      },
    },
    {
      ...subordinate,
      request: { url: "http://local.adguard.org/?type=unrecognized" },
    },
    {
      ...extra,
      initiator: { ...extra.initiator, url: "http://other.example/" },
    },
  ];
  for (const event of bad)
    assert.equal(
      observedHostAdGuardInjection(event, root, base),
      false,
      JSON.stringify(event),
    );
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<script src="http://local.adguard.org/?type=content-script"></script>',
  );
  assert.equal(
    observedHostAdGuardInjection(content, root, base),
    false,
    "an authored external script must never be dismissed",
  );
});
