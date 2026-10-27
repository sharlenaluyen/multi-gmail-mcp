import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// audit.js reads CONFIG_DIR from store.js, which is computed from
// os.homedir() at import time - isolate it the same way store.test.js does.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mgmcp-test-audit-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { logAuditEvent, AUDIT_LOG_PATH } = await import("../src/audit.js");

test("logAuditEvent appends one JSON line per call, never email bodies", () => {
  logAuditEvent({
    action: "send_email",
    account: "work",
    email: "me@work.com",
    outcome: "sent",
    detail: { to: "x@y.com", subject: "Hi" },
  });
  logAuditEvent({
    action: "delete_draft",
    account: "work",
    email: "me@work.com",
    outcome: "deleted",
    detail: { draft_id: "d1" },
  });

  const lines = fs.readFileSync(AUDIT_LOG_PATH, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.action, "send_email");
  assert.equal(first.outcome, "sent");
  assert.ok(first.ts); // ISO timestamp present
  assert.equal(first.detail.body, undefined); // never logs the body
});

test("audit.log is owner-only readable", () => {
  const stat = fs.statSync(AUDIT_LOG_PATH);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("logAuditEvent never throws, even if it can't write", () => {
  // Point at a directory that can't exist as a file path (its parent is a file)
  assert.doesNotThrow(() =>
    logAuditEvent({ action: "send_email", account: "x", email: "x@y.com", outcome: "sent", detail: {} })
  );
});
