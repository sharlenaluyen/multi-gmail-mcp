import fs from "fs";
import path from "path";
import { CONFIG_DIR, ensureConfigDir } from "./store.js";

export const AUDIT_LOG_PATH = path.join(CONFIG_DIR, "audit.log");

// Append-only JSONL log of every send and delete. Each line is one JSON
// object, so the file is append-safe (no read-modify-write race like
// accounts.json has) and easy to tail or grep:
//   tail -f ~/.multi-gmail-mcp/audit.log
//
// Deliberately never logs email bodies - just enough to answer "what did
// this server send or delete, from which account, and when" after the fact.
export function logAuditEvent({ action, account, email, outcome, detail }) {
  ensureConfigDir();
  const line = {
    ts: new Date().toISOString(),
    action, // "send_email" | "reply_to_message" | "delete_draft"
    account,
    email,
    outcome, // "sent" | "dry_run" | "deleted" | "error"
    detail, // small plain object: { to, subject, message_id, draft_id, ... } - no bodies
  };
  try {
    // First write to this file in the process: make sure it's owner-only.
    const exists = fs.existsSync(AUDIT_LOG_PATH);
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(line) + "\n", { mode: 0o600 });
    if (!exists) fs.chmodSync(AUDIT_LOG_PATH, 0o600);
  } catch {
    // Audit logging is best-effort - never let a logging failure block or
    // crash the actual email action it's trying to record.
  }
}
