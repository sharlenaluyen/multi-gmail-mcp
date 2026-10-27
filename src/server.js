#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getConnectedAliases,
  getAccountInfo,
  gmailClientFor,
  buildRawMessage,
  extractPlainTextBody,
  headerValue,
  computeStatus,
  withRetry,
  guessMimeType,
  getDraftFields,
  splitAddressList,
  removeAddress,
  listAttachmentParts,
} from "./gmail.js";
import { logAuditEvent } from "./audit.js";

const server = new McpServer({
  name: "multi-gmail-mcp",
  version: "1.2.0",
});

function aliasEnumHint() {
  const aliases = getConnectedAliases();
  const described = aliases.map((alias) => {
    const { nicknames } = getAccountInfo(alias);
    return nicknames.length ? `${alias} (also: ${nicknames.join(", ")})` : alias;
  });
  return aliases.length
    ? ` Connected aliases: ${described.join(", ")}. A nickname works anywhere an alias does.`
    : " No accounts connected yet - run the auth script.";
}

// Every tool handler goes through this wrapper. An uncaught exception inside
// a tool (a Gmail API error, a bad file path, an injection guard tripping)
// should turn into a clean MCP error result, never crash the stdio loop
// that every other tool call also depends on.
function defineTool(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `${name} failed: ${err?.message || String(err)}` }],
      };
    }
  });
}

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Account discovery
// ---------------------------------------------------------------------------

defineTool(
  "list_accounts",
  "List every Gmail account connected to this server, with its alias, any nicknames, and email address. A nickname can be passed anywhere an alias is accepted. Always call this first if you don't already know the aliases.",
  {},
  async () => {
    const aliases = getConnectedAliases();
    const accounts = aliases.map((alias) => {
      const info = getAccountInfo(alias);
      return { alias, nicknames: info.nicknames, email: info.email };
    });
    return jsonResult({ accounts });
  }
);

// ---------------------------------------------------------------------------
// Search / read
// ---------------------------------------------------------------------------

defineTool(
  "search_emails",
  `Search one connected Gmail account using Gmail's search syntax (e.g. "from:boss@work.com is:unread", "subject:invoice newer_than:7d").${aliasEnumHint()}`,
  {
    account: z.string().describe("Account alias to search, from list_accounts"),
    query: z.string().max(500),
    max_results: z.number().int().min(1).max(50).default(10),
  },
  async ({ account, query, max_results }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const { data } = await withRetry(() =>
      gmail.users.messages.list({ userId: "me", q: query, maxResults: max_results })
    );

    const messages = data.messages || [];
    const detailed = await Promise.all(
      messages.map(async (m) => {
        const { data: msg } = await withRetry(() =>
          gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          })
        );
        return {
          id: msg.id,
          threadId: msg.threadId,
          snippet: msg.snippet,
          from: headerValue(msg.payload?.headers, "From"),
          to: headerValue(msg.payload?.headers, "To"),
          subject: headerValue(msg.payload?.headers, "Subject"),
          date: headerValue(msg.payload?.headers, "Date"),
          status: computeStatus(msg.labelIds),
        };
      })
    );

    return jsonResult({ account, email: info.email, count: detailed.length, messages: detailed });
  }
);

defineTool(
  "search_all_accounts",
  `Run the same Gmail search query across every connected account at once (each mailbox once, even if it has nicknames), with each result tagged by its main account alias.${aliasEnumHint()}`,
  {
    query: z.string().max(500),
    max_results_per_account: z.number().int().min(1).max(25).default(5),
  },
  async ({ query, max_results_per_account }) => {
    const aliases = getConnectedAliases();
    const results = {};
    for (const alias of aliases) {
      const gmail = gmailClientFor(alias);
      const { data } = await withRetry(() =>
        gmail.users.messages.list({ userId: "me", q: query, maxResults: max_results_per_account })
      );
      const messages = data.messages || [];
      results[alias] = await Promise.all(
        messages.map(async (m) => {
          const { data: msg } = await withRetry(() =>
            gmail.users.messages.get({
              userId: "me",
              id: m.id,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date"],
            })
          );
          return {
            id: msg.id,
            threadId: msg.threadId,
            snippet: msg.snippet,
            from: headerValue(msg.payload?.headers, "From"),
            subject: headerValue(msg.payload?.headers, "Subject"),
            date: headerValue(msg.payload?.headers, "Date"),
            status: computeStatus(msg.labelIds),
          };
        })
      );
    }
    return jsonResult(results);
  }
);

defineTool(
  "get_message",
  `Fetch the full content (headers + plain-text body) of one email by its message id.${aliasEnumHint()}`,
  { account: z.string(), message_id: z.string() },
  async ({ account, message_id }) => {
    const gmail = gmailClientFor(account);
    const { data: msg } = await withRetry(() =>
      gmail.users.messages.get({ userId: "me", id: message_id, format: "full" })
    );
    const body = extractPlainTextBody(msg.payload);
    return jsonResult({
      account,
      id: msg.id,
      threadId: msg.threadId,
      from: headerValue(msg.payload?.headers, "From"),
      to: headerValue(msg.payload?.headers, "To"),
      subject: headerValue(msg.payload?.headers, "Subject"),
      date: headerValue(msg.payload?.headers, "Date"),
      status: computeStatus(msg.labelIds),
      body,
    });
  }
);

defineTool(
  "get_attachments",
  `List the attachments on a message (filename, type, size, and an attachment_id you pass to download_attachment) - does not download anything.${aliasEnumHint()}`,
  { account: z.string(), message_id: z.string() },
  async ({ account, message_id }) => {
    const gmail = gmailClientFor(account);
    const { data: msg } = await withRetry(() =>
      gmail.users.messages.get({ userId: "me", id: message_id, format: "full" })
    );
    const attachments = listAttachmentParts(msg.payload);
    return jsonResult({ account, message_id, attachments });
  }
);

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // Gmail's own per-message/attachment ceiling

defineTool(
  "download_attachment",
  `Download one attachment from a message (by the attachment_id from get_attachments) and save it to a local file path on this machine.${aliasEnumHint()}`,
  {
    account: z.string(),
    message_id: z.string(),
    attachment_id: z.string(),
    save_path: z
      .string()
      .max(4096)
      .describe("Where to write the file on this machine, e.g. /home/you/Downloads/invoice.pdf"),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Must be true to overwrite a file that already exists at save_path"),
  },
  async ({ account, message_id, attachment_id, save_path, overwrite }) => {
    const resolved = path.resolve(save_path);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Destination folder doesn't exist: ${dir}`);
    }
    if (fs.existsSync(resolved) && !overwrite) {
      throw new Error(`A file already exists at ${resolved}. Pass overwrite: true to replace it.`);
    }

    const gmail = gmailClientFor(account);
    const { data } = await withRetry(() =>
      gmail.users.messages.attachments.get({ userId: "me", messageId: message_id, id: attachment_id })
    );
    const sizeEstimate = data.size || 0;
    if (sizeEstimate > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `Attachment is ${(sizeEstimate / 1024 / 1024).toFixed(1)}MB, over the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB ceiling.`
      );
    }

    const buffer = Buffer.from((data.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
    fs.writeFileSync(resolved, buffer);
    return jsonResult({ account, saved_to: resolved, size_bytes: buffer.length });
  }
);

defineTool(
  "get_recipient",
  `Get just the To/Cc/Bcc recipients of a message or draft by its message id.${aliasEnumHint()}`,
  { account: z.string(), message_id: z.string() },
  async ({ account, message_id }) => {
    const gmail = gmailClientFor(account);
    const { data: msg } = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "metadata",
        metadataHeaders: ["To", "Cc", "Bcc"],
      })
    );
    return jsonResult({
      account,
      id: msg.id,
      to: headerValue(msg.payload?.headers, "To"),
      cc: headerValue(msg.payload?.headers, "Cc"),
      bcc: headerValue(msg.payload?.headers, "Bcc"),
    });
  }
);

defineTool(
  "get_subject_line",
  `Get just the subject line of a message or draft by its message id.${aliasEnumHint()}`,
  { account: z.string(), message_id: z.string() },
  async ({ account, message_id }) => {
    const gmail = gmailClientFor(account);
    const { data: msg } = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "metadata",
        metadataHeaders: ["Subject"],
      })
    );
    return jsonResult({ account, id: msg.id, subject: headerValue(msg.payload?.headers, "Subject") });
  }
);

defineTool(
  "get_status",
  `Get the status of a message (sent, draft, trash, spam, inbox, archived, read/unread, starred) by its message id.${aliasEnumHint()}`,
  { account: z.string(), message_id: z.string() },
  async ({ account, message_id }) => {
    const gmail = gmailClientFor(account);
    const { data: msg } = await withRetry(() =>
      gmail.users.messages.get({ userId: "me", id: message_id, format: "minimal" })
    );
    return jsonResult({ account, id: msg.id, status: computeStatus(msg.labelIds), labelIds: msg.labelIds });
  }
);

defineTool(
  "list_labels",
  `List all Gmail labels/folders for one connected account.${aliasEnumHint()}`,
  { account: z.string() },
  async ({ account }) => {
    const gmail = gmailClientFor(account);
    const { data } = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
    return jsonResult(data.labels || []);
  }
);

// ---------------------------------------------------------------------------
// Sending (not retried - a flaky connection must never cause a double-send)
// ---------------------------------------------------------------------------

defineTool(
  "send_email",
  `Send an email from one connected Gmail account. By default this is a DRY RUN: it returns a preview of exactly what would be sent and does NOT contact Gmail. Pass confirm_send: true only once you (or the person you're acting for) have actually reviewed and approved that preview.${aliasEnumHint()}`,
  {
    account: z.string(),
    to: z.string().max(2000),
    subject: z.string().max(998),
    body: z.string().max(2_000_000),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
    confirm_send: z
      .boolean()
      .default(false)
      .describe("Must be explicitly true to actually send. False (default) returns a preview only."),
  },
  async ({ account, to, subject, body, cc, bcc, confirm_send }) => {
    const info = getAccountInfo(account);
    const preview = { sent_from: info.email, to, cc, bcc, subject, body };

    if (!confirm_send) {
      logAuditEvent({
        action: "send_email",
        account,
        email: info.email,
        outcome: "dry_run",
        detail: { to, subject },
      });
      return jsonResult({
        dry_run: true,
        would_send: preview,
        note: "Re-call with confirm_send: true to actually send this.",
      });
    }

    const gmail = gmailClientFor(account);
    const raw = buildRawMessage({ to, cc, bcc, subject, body, from: info.email });
    try {
      const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      logAuditEvent({
        action: "send_email",
        account,
        email: info.email,
        outcome: "sent",
        detail: { to, subject, message_id: data.id },
      });
      return jsonResult({ sent_from: info.email, message_id: data.id, threadId: data.threadId });
    } catch (err) {
      logAuditEvent({
        action: "send_email",
        account,
        email: info.email,
        outcome: "error",
        detail: { to, subject, error: err?.message },
      });
      throw err;
    }
  }
);

defineTool(
  "draft_reply_to_message",
  `Create a DRAFT reply to an email, in-thread (sets In-Reply-To/References and keeps Gmail's thread view intact). This NEVER sends anything - it only ever creates a draft, the same way create_draft does. To actually send it, the draft still has to be sent manually from Gmail (there is deliberately no tool in this server that sends a reply).${aliasEnumHint()}`,
  {
    account: z.string(),
    message_id: z.string(),
    body: z.string().max(2_000_000),
    reply_all: z
      .boolean()
      .default(false)
      .describe("Also Cc everyone who was on the original To/Cc, not just the original sender"),
  },
  async ({ account, message_id, body, reply_all }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);

    const { data: original } = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Message-Id", "References"],
      })
    );
    const headers = original.payload?.headers;
    const originalFrom = headerValue(headers, "From");
    const originalSubject = headerValue(headers, "Subject");
    const originalMessageId = headerValue(headers, "Message-Id");
    const originalReferences = headerValue(headers, "References");

    const to = originalFrom;
    let cc;
    if (reply_all) {
      const combined = [
        ...splitAddressList(headerValue(headers, "To")),
        ...splitAddressList(headerValue(headers, "Cc")),
      ];
      const withoutSelf = removeAddress(combined, info.email);
      const withoutReplyTarget = removeAddress(withoutSelf, originalFrom);
      cc = withoutReplyTarget.length ? withoutReplyTarget.join(", ") : undefined;
    }
    const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    const references = [originalReferences, originalMessageId].filter(Boolean).join(" ");

    const raw = buildRawMessage({
      to,
      cc,
      subject,
      body,
      from: info.email,
      inReplyTo: originalMessageId,
      references,
    });
    try {
      // drafts.create (not messages.send) - this tool can only ever produce
      // a draft sitting in the thread, never an outbound email.
      const { data } = await withRetry(() =>
        gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw, threadId: original.threadId } },
        })
      );
      logAuditEvent({
        action: "draft_reply_to_message",
        account,
        email: info.email,
        outcome: "drafted",
        detail: { to, subject, draft_id: data.id },
      });
      return jsonResult({
        account: info.email,
        draft_id: data.id,
        message_id: data.message?.id,
        threadId: data.message?.threadId,
        to,
        cc,
        subject,
      });
    } catch (err) {
      logAuditEvent({
        action: "draft_reply_to_message",
        account,
        email: info.email,
        outcome: "error",
        detail: { to, subject, error: err?.message },
      });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

defineTool(
  "create_draft",
  `Create a draft email in one connected Gmail account (does not send it).${aliasEnumHint()}`,
  {
    account: z.string(),
    to: z.string().max(2000),
    subject: z.string().max(998),
    body: z.string().max(2_000_000),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
  },
  async ({ account, to, subject, body, cc, bcc }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const raw = buildRawMessage({ to, cc, bcc, subject, body, from: info.email });
    const { data } = await withRetry(() =>
      gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } })
    );
    return jsonResult({ account: info.email, draft_id: data.id, message_id: data.message?.id });
  }
);

defineTool(
  "list_drafts",
  `List drafts in one connected account, with each draft's id, recipient, subject and a short snippet - so you can find a draft_id without already knowing it.${aliasEnumHint()}`,
  { account: z.string(), max_results: z.number().int().min(1).max(50).default(20) },
  async ({ account, max_results }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const { data } = await withRetry(() =>
      gmail.users.drafts.list({ userId: "me", maxResults: max_results })
    );
    const drafts = data.drafts || [];
    const detailed = await Promise.all(
      drafts.map(async (d) => {
        const { data: draft } = await withRetry(() =>
          gmail.users.drafts.get({
            userId: "me",
            id: d.id,
            format: "metadata",
            metadataHeaders: ["To", "Subject"],
          })
        );
        return {
          draft_id: draft.id,
          message_id: draft.message?.id,
          to: headerValue(draft.message?.payload?.headers, "To"),
          subject: headerValue(draft.message?.payload?.headers, "Subject"),
          snippet: draft.message?.snippet,
        };
      })
    );
    return jsonResult({ account: info.email, count: detailed.length, drafts: detailed });
  }
);

defineTool(
  "modify_draft",
  `Replace a draft's recipient, subject, and body all at once. Any field left out keeps its current value.${aliasEnumHint()}`,
  {
    account: z.string(),
    draft_id: z.string(),
    to: z.string().max(2000).optional(),
    subject: z.string().max(998).optional(),
    body: z.string().max(2_000_000).optional(),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
  },
  async ({ account, draft_id, to, subject, body, cc, bcc }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const current = await getDraftFields(gmail, draft_id);
    const raw = buildRawMessage({
      to: to ?? current.to,
      cc: cc ?? current.cc,
      bcc: bcc ?? current.bcc,
      subject: subject ?? current.subject,
      body: body ?? current.body,
      from: info.email,
    });
    const { data } = await withRetry(() =>
      gmail.users.drafts.update({ userId: "me", id: draft_id, requestBody: { message: { raw } } })
    );
    return jsonResult({ account: info.email, draft_id: data.id, message_id: data.message?.id });
  }
);

defineTool(
  "modify_draft_recipient",
  `Change only the To recipient of an existing draft, keeping its subject and body.${aliasEnumHint()}`,
  { account: z.string(), draft_id: z.string(), to: z.string().max(2000) },
  async ({ account, draft_id, to }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const current = await getDraftFields(gmail, draft_id);
    const raw = buildRawMessage({ ...current, to, from: info.email });
    const { data } = await withRetry(() =>
      gmail.users.drafts.update({ userId: "me", id: draft_id, requestBody: { message: { raw } } })
    );
    return jsonResult({ account: info.email, draft_id: data.id, to });
  }
);

defineTool(
  "modify_draft_subject_line",
  `Change only the subject line of an existing draft, keeping its recipient and body.${aliasEnumHint()}`,
  { account: z.string(), draft_id: z.string(), subject: z.string().max(998) },
  async ({ account, draft_id, subject }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const current = await getDraftFields(gmail, draft_id);
    const raw = buildRawMessage({ ...current, subject, from: info.email });
    const { data } = await withRetry(() =>
      gmail.users.drafts.update({ userId: "me", id: draft_id, requestBody: { message: { raw } } })
    );
    return jsonResult({ account: info.email, draft_id: data.id, subject });
  }
);

defineTool(
  "modify_draft_message",
  `Change only the body text of an existing draft, keeping its recipient and subject.${aliasEnumHint()}`,
  { account: z.string(), draft_id: z.string(), body: z.string().max(2_000_000) },
  async ({ account, draft_id, body }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const current = await getDraftFields(gmail, draft_id);
    const raw = buildRawMessage({ ...current, body, from: info.email });
    const { data } = await withRetry(() =>
      gmail.users.drafts.update({ userId: "me", id: draft_id, requestBody: { message: { raw } } })
    );
    return jsonResult({ account: info.email, draft_id: data.id });
  }
);

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // Gmail's own per-message limit

defineTool(
  "attach_document",
  `Attach a local file to an existing draft (rebuilds the draft as multipart, adding this file alongside its existing text). The file must already exist on this machine, readable by this server process, and be 25MB or smaller.${aliasEnumHint()}`,
  { account: z.string(), draft_id: z.string(), file_path: z.string().max(4096) },
  async ({ account, draft_id, file_path }) => {
    const resolved = path.resolve(file_path);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`File not found or not readable: ${resolved}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${resolved}`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `File is ${(stat.size / 1024 / 1024).toFixed(1)}MB, which is over Gmail's 25MB attachment limit.`
      );
    }

    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    const current = await getDraftFields(gmail, draft_id);
    const contentBase64 = fs.readFileSync(resolved).toString("base64");
    const filename = path.basename(resolved);

    const raw = buildRawMessage({
      ...current,
      from: info.email,
      attachments: [{ filename, mimeType: guessMimeType(filename), contentBase64 }],
    });
    const { data } = await withRetry(() =>
      gmail.users.drafts.update({ userId: "me", id: draft_id, requestBody: { message: { raw } } })
    );
    return jsonResult({ account: info.email, draft_id: data.id, attached: filename, size_bytes: stat.size });
  }
);

defineTool(
  "delete_draft",
  `Permanently delete a draft (not a sent message - this cannot delete something already sent). This does not go to Trash first; it's immediate.${aliasEnumHint()}`,
  { account: z.string(), draft_id: z.string() },
  async ({ account, draft_id }) => {
    const gmail = gmailClientFor(account);
    const info = getAccountInfo(account);
    try {
      // Deleting is idempotent (deleting an already-gone draft just 404s), so
      // retrying on a transient error is safe, unlike send_email.
      await withRetry(() => gmail.users.drafts.delete({ userId: "me", id: draft_id }));
      logAuditEvent({
        action: "delete_draft",
        account,
        email: info.email,
        outcome: "deleted",
        detail: { draft_id },
      });
      return jsonResult({ account: info.email, deleted_draft_id: draft_id });
    } catch (err) {
      logAuditEvent({
        action: "delete_draft",
        account,
        email: info.email,
        outcome: "error",
        detail: { draft_id, error: err?.message },
      });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Labels (idempotent - safe to retry)
// ---------------------------------------------------------------------------

defineTool(
  "modify_message_labels",
  `Add or remove labels on a message - e.g. archive (remove INBOX), mark read (remove UNREAD), star (add STARRED), trash (add TRASH).${aliasEnumHint()}`,
  {
    account: z.string(),
    message_id: z.string(),
    add_labels: z.array(z.string()).default([]),
    remove_labels: z.array(z.string()).default([]),
  },
  async ({ account, message_id, add_labels, remove_labels }) => {
    const gmail = gmailClientFor(account);
    const { data } = await withRetry(() =>
      gmail.users.messages.modify({
        userId: "me",
        id: message_id,
        requestBody: { addLabelIds: add_labels, removeLabelIds: remove_labels },
      })
    );
    return jsonResult({ id: data.id, labelIds: data.labelIds, status: computeStatus(data.labelIds) });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
