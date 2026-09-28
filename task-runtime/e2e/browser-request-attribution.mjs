// A Windows AdGuard installation can inject its own scripts into local Edge
// pages, including a fresh profile with --disable-extensions. CDP then reports
// them as page requests. Classify only the observed host-injected signatures;
// every other external request still fails the candidate-network assertion.
import fs from "node:fs";
import path from "node:path";

const ADGUARD_ORIGIN = "http://local.adguard.org";

export function observedHostAdGuardInjection(event, documentRoot, base) {
  const { request, initiator, documentURL } = event ?? {};
  if (typeof documentURL !== "string" || !documentURL.startsWith(`${base}/`))
    return false;
  let remote, document;
  try {
    remote = new URL(request?.url);
    document = new URL(documentURL);
  } catch {
    return false;
  }
  if (remote.origin !== ADGUARD_ORIGIN || document.origin !== base)
    return false;
  const type = remote.searchParams.get("type");
  if (type === "sfbr-script") {
    const frames = initiator?.stack?.callFrames;
    return (
      remote.searchParams.get("u") === documentURL &&
      initiator?.type === "script" &&
      Array.isArray(frames) &&
      frames.length > 0 &&
      frames.every(
        (frame) =>
          typeof frame.url === "string" &&
          frame.url.startsWith(`${ADGUARD_ORIGIN}/`),
      )
    );
  }
  if (
    initiator?.type !== "parser" ||
    initiator.url !== documentURL ||
    !Number.isSafeInteger(initiator.lineNumber) ||
    initiator.lineNumber < 0 ||
    !Number.isSafeInteger(initiator.columnNumber) ||
    initiator.columnNumber < 0
  )
    return false;
  if (type === "content-script") {
    if (
      remote.searchParams.get("app") !== "msedge.exe" ||
      remote.searchParams.get("url") !== documentURL ||
      remote.searchParams.get("dmn") !== document.host
    )
      return false;
  } else if (type === "user-script") {
    if (
      !remote.searchParams.getAll("name").includes("AdGuard Extra") ||
      !remote.searchParams.getAll("name").includes("AdGuard Popup Blocker")
    )
      return false;
  } else return false;
  // The observed injected script URL must be absent from authored HTML;
  // do not require any particular formatting of the candidate document.
  try {
    const pathname = document.pathname;
    const route = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const file = path.resolve(documentRoot, `.${route}`);
    if (
      !file.startsWith(`${documentRoot}${path.sep}`) ||
      !fs.lstatSync(file).isFile() ||
      !fs.realpathSync(file).startsWith(`${documentRoot}${path.sep}`) ||
      fs.statSync(file).size > 1024 * 1024
    )
      return false;
    const authored = fs.readFileSync(file, "utf8");
    const line = authored.split(/\r?\n/)[initiator.lineNumber];
    return (
      typeof line === "string" &&
      !authored.toLowerCase().includes("local.adguard.org")
    );
  } catch {
    return false;
  }
}
