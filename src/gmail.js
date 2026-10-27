import { google } from "googleapis";
import { loadCredentials, loadAccounts, resolveAlias } from "./store.js";

// Cache one authed gmail client per account (keyed by main alias) per process run.
const clientCache = new Map();

// One main alias per connected mailbox - nicknames are not included, so
// anything that loops over these touches each mailbox exactly once.
export function getConnectedAliases() {
  return Object.keys(loadAccounts());
}

// Accepts a main alias or a nickname. The returned info includes `alias`,
// the main alias it resolved to.
export function getAccountInfo(name) {
  const accounts = loadAccounts();
  const alias = resolveAlias(accounts, name);
  if (!alias) {
    const known =
      Object.keys(accounts)
        .flatMap((a) => [a, ...(accounts[a].nicknames || [])])
        .join(", ") || "(none connected)";
    throw new Error(`Unknown account alias "${name}". Connected aliases: ${known}`);
  }
  return { alias, nicknames: [], ...accounts[alias] };
}

export function gmailClientFor(name) {
  const acct = getAccountInfo(name);
  const alias = acct.alias;
  if (clientCache.has(alias)) return clientCache.get(alias);

  const { clientId, clientSecret, redirectUri } = loadCredentials();

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: acct.refresh_token });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  clientCache.set(alias, gmail);
  return gmail;
}

function b64urlEncode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Header injection / SMTP-smuggling guard -------------------------------
// Every value that ends up on a header line is attacker-controllable the
// moment it comes from an LLM tool call. A bare CR or LF in a "To" or
// "Subject" value could inject a forged header (e.g. an extra Bcc:) or start
// a new header entirely. Gmail's API does its own validation too, but we
// reject here first so the failure is immediate, local, and easy to explain.
export class HeaderInjectionError extends Error {}

function assertSafeHeaderValue(fieldName, value) {
  if (value == null) return value;
  const str = String(value);
  if (/[\r\n]/.test(str)) {
    throw new HeaderInjectionError(
      `Refusing to build email: "${fieldName}" contains a line break, which could be used to inject extra headers.`
    );
  }
  return str;
}

const MAX_SUBJECT_LENGTH = 998; // RFC 5322 soft line-length guidance
const MAX_BODY_LENGTH = 2_000_000; // generous plain-text cap, well under Gmail's message size limit

function assertReasonableLength(fieldName, value, max) {
  if (value != null && String(value).length > max) {
    throw new Error(`"${fieldName}" is too long (${String(value).length} chars, max ${max}).`);
  }
}

/**
 * Build a base64url-encoded RFC 2822 message, optionally multipart/mixed
 * with attachments. `attachments` is an array of
 * { filename, mimeType, contentBase64 } with contentBase64 already
 * standard-base64 encoded file bytes.
 */
export function buildRawMessage({ to, cc, bcc, subject, body, from, inReplyTo, references, attachments }) {
  assertSafeHeaderValue("to", to);
  assertSafeHeaderValue("cc", cc);
  assertSafeHeaderValue("bcc", bcc);
  assertSafeHeaderValue("subject", subject);
  assertSafeHeaderValue("from", from);
  assertSafeHeaderValue("in-reply-to", inReplyTo);
  assertSafeHeaderValue("references", references);
  assertReasonableLength("subject", subject, MAX_SUBJECT_LENGTH);
  assertReasonableLength("body", body, MAX_BODY_LENGTH);

  const headers = [`To: ${to}`];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (from) headers.push(`From: ${from}`);
  headers.push(`Subject: ${encodeHeaderIfNeeded(subject || "")}`);
  headers.push(`MIME-Version: 1.0`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  if (!attachments || attachments.length === 0) {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    const message = `${headers.join("\r\n")}\r\n\r\n${body || ""}`;
    return b64urlEncode(message);
  }

  // multipart/mixed: one text/plain part, then one part per attachment.
  const boundary = `mgmcp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [];
  parts.push(`--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body || ""}`);
  for (const att of attachments) {
    assertSafeHeaderValue("attachment filename", att.filename);
    parts.push(
      `--${boundary}\r\n` +
        `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${att.filename}"\r\n` +
        `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        `${att.contentBase64}`
    );
  }
  parts.push(`--${boundary}--`);

  const message = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n\r\n")}`;
  return b64urlEncode(message);
}

// Subjects can contain non-ASCII text; RFC 2047 encode defensively so Gmail
// (and any other MTA in the path) renders it correctly instead of mangling it.
function encodeHeaderIfNeeded(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value; // pure printable ASCII, no encoding needed
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function decodeBase64Url(data) {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Depth-first search for a specific MIME type, so a text/plain part buried
// under a text/html sibling (common in multipart/alternative) is still
// found regardless of part order.
function findPartData(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload.body.data;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findPartData(part, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function findAnyPartData(payload) {
  if (!payload) return null;
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findAnyPartData(part);
      if (found) return found;
    }
  }
  if (payload.body?.data) return payload.body.data;
  return null;
}

export function extractPlainTextBody(payload) {
  const plain = findPartData(payload, "text/plain");
  if (plain) return decodeBase64Url(plain);
  // No text/plain part anywhere in the tree - fall back to whatever body
  // content exists (e.g. an HTML-only email) rather than returning nothing.
  const any = findAnyPartData(payload);
  return any ? decodeBase64Url(any) : "";
}

export function headerValue(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// --- Status -----------------------------------------------------------
// Gmail doesn't expose a single "status" field; it's derived from labelIds.
export function computeStatus(labelIds) {
  const labels = new Set(labelIds || []);
  const flags = [];
  if (labels.has("DRAFT")) flags.push("draft");
  if (labels.has("SENT")) flags.push("sent");
  if (labels.has("TRASH")) flags.push("trash");
  if (labels.has("SPAM")) flags.push("spam");
  if (labels.has("INBOX")) flags.push("inbox");
  if (
    !labels.has("TRASH") &&
    !labels.has("SPAM") &&
    !labels.has("INBOX") &&
    !labels.has("SENT") &&
    !labels.has("DRAFT")
  ) {
    flags.push("archived");
  }
  flags.push(labels.has("UNREAD") ? "unread" : "read");
  if (labels.has("STARRED")) flags.push("starred");
  return flags;
}

// --- Retry with backoff -------------------------------------------------
// Gmail's API returns 429 (rate limit) and transient 5xx errors under load.
// Retrying a *read* is always safe; we only apply this wrapper to idempotent
// calls (reads, and label modifications, which are idempotent by nature) -
// callers decide which calls get wrapped. Sends/drafts are deliberately
// never silently retried, to avoid a double-send on a flaky connection.
export async function withRetry(fn, { retries = 3, baseDelayMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.code || err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// --- MIME type guessing for attachments ----------------------------------
const EXT_TO_MIME = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

export function guessMimeType(filename) {
  const match = /\.[a-z0-9]+$/i.exec(filename || "");
  const ext = match ? match[0].toLowerCase() : "";
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

// --- Draft helpers --------------------------------------------------------
// Fetch a draft's current fields so a "modify just the subject" tool can
// rebuild the full message without clobbering the parts it wasn't told to
// change.
// --- Address-list helpers (for reply-all) --------------------------------
export function extractEmailAddress(addr) {
  if (!addr) return "";
  const match = /<([^>]+)>/.exec(addr);
  return (match ? match[1] : addr).trim().toLowerCase();
}

export function splitAddressList(value) {
  if (!value) return [];
  // Naive comma-split - good enough for typical headers. A quoted display
  // name containing a literal comma is rare and out of scope for this
  // tool; full RFC 5322 address-list parsing isn't worth the weight here.
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function removeAddress(list, addressToRemove) {
  const target = extractEmailAddress(addressToRemove);
  return list.filter((a) => extractEmailAddress(a) !== target);
}

// --- From address ---------------------------------------------------------
// The From header for a new message: a per-call override, else the account's
// saved default_from, else its primary address.
export function fromAddressFor(info, override) {
  return override || info.default_from || info.email;
}

export function formatFromHeader(displayName, email) {
  const name = (displayName || "").replace(/["\\]/g, "").trim();
  if (!name) return email;
  const encoded = encodeHeaderIfNeeded(name);
  return encoded === name ? `"${name}" <${email}>` : `${encoded} <${email}>`;
}

// Gmail silently rewrites From to the primary address when it isn't one of
// the account's verified "Send mail as" addresses, so check before relying on
// one. Returns the matching sendAs entry; throws with the valid options if
// there is none.
export async function findSendAsAddress(gmail, info, address) {
  const wanted = extractEmailAddress(address);
  const { data } = await withRetry(() => gmail.users.settings.sendAs.list({ userId: "me" }));
  const sendAs = data.sendAs || [];
  const usable = sendAs.filter((s) => s.isPrimary || s.verificationStatus === "accepted");
  const match = sendAs.find((s) => s.sendAsEmail.toLowerCase() === wanted);
  const options = usable.map((s) => s.sendAsEmail).join(", ");
  if (!match) {
    throw new Error(
      `${wanted} isn't a "Send mail as" address on ${info.email}. Add it in Gmail Settings -> Accounts -> Send mail as. Usable addresses: ${options}`
    );
  }
  if (!usable.includes(match)) {
    throw new Error(
      `${wanted} is set up on ${info.email} but not verified yet (status: ${match.verificationStatus}). Usable addresses: ${options}`
    );
  }
  return match;
}

// --- Attachments ----------------------------------------------------------
// Walk a message payload tree and collect every part that represents a real
// attachment (has a filename and an attachmentId) as opposed to an inline
// body part.
export function listAttachmentParts(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      partId: payload.partId,
      filename: payload.filename,
      mimeType: payload.mimeType,
      attachmentId: payload.body.attachmentId,
      size: payload.body.size,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) listAttachmentParts(part, out);
  }
  return out;
}

export async function getDraftFields(gmail, draftId) {
  const { data: draft } = await withRetry(() =>
    gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" })
  );
  const payload = draft.message?.payload;
  return {
    draftId: draft.id,
    messageId: draft.message?.id,
    threadId: draft.message?.threadId,
    to: headerValue(payload?.headers, "To"),
    cc: headerValue(payload?.headers, "Cc"),
    bcc: headerValue(payload?.headers, "Bcc"),
    subject: headerValue(payload?.headers, "Subject"),
    from: headerValue(payload?.headers, "From"),
    // Reply headers, so rebuilding a reply draft keeps it threaded.
    inReplyTo: headerValue(payload?.headers, "In-Reply-To"),
    references: headerValue(payload?.headers, "References"),
    body: extractPlainTextBody(payload),
  };
}
