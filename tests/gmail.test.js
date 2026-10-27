import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRawMessage,
  extractPlainTextBody,
  headerValue,
  computeStatus,
  guessMimeType,
  withRetry,
  HeaderInjectionError,
  extractEmailAddress,
  splitAddressList,
  removeAddress,
  listAttachmentParts,
} from "../src/gmail.js";

function decodeRaw(raw) {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

test("buildRawMessage includes headers and body", () => {
  const raw = buildRawMessage({ to: "x@example.com", subject: "Hi", body: "Hello there" });
  const msg = decodeRaw(raw);
  assert.match(msg, /To: x@example\.com/);
  assert.match(msg, /Subject: Hi/);
  assert.match(msg, /Hello there/);
});

test("buildRawMessage rejects CRLF injection in To (header/BCC injection guard)", () => {
  assert.throws(
    () => buildRawMessage({ to: "victim@example.com\r\nBcc: attacker@evil.com", subject: "Hi", body: "x" }),
    HeaderInjectionError
  );
});

test("buildRawMessage rejects CRLF injection in Subject", () => {
  assert.throws(
    () => buildRawMessage({ to: "x@example.com", subject: "Hi\r\nBcc: attacker@evil.com", body: "x" }),
    HeaderInjectionError
  );
});

test("buildRawMessage rejects an overlong subject", () => {
  assert.throws(() => buildRawMessage({ to: "x@example.com", subject: "a".repeat(2000), body: "x" }));
});

test("buildRawMessage RFC2047-encodes a non-ASCII subject", () => {
  const raw = buildRawMessage({ to: "x@example.com", subject: "héllo", body: "x" });
  const msg = decodeRaw(raw);
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
});

test("buildRawMessage with an attachment builds multipart/mixed", () => {
  const raw = buildRawMessage({
    to: "x@example.com",
    subject: "Doc",
    body: "see attached",
    attachments: [{ filename: "report.pdf", mimeType: "application/pdf", contentBase64: "AAAA" }],
  });
  const msg = decodeRaw(raw);
  assert.match(msg, /multipart\/mixed/);
  assert.match(msg, /Content-Disposition: attachment; filename="report\.pdf"/);
});

test("buildRawMessage rejects a header-injecting attachment filename", () => {
  assert.throws(() =>
    buildRawMessage({
      to: "x@example.com",
      subject: "Doc",
      body: "b",
      attachments: [
        { filename: 'evil.pdf"\r\nX-Injected: yes', mimeType: "application/pdf", contentBase64: "AAAA" },
      ],
    })
  );
});

test("extractPlainTextBody finds text/plain nested inside multipart/alternative", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: Buffer.from("<p>hi</p>").toString("base64") } },
      { mimeType: "text/plain", body: { data: Buffer.from("hi").toString("base64") } },
    ],
  };
  assert.equal(extractPlainTextBody(payload), "hi");
});

test("headerValue matches case-insensitively and returns '' when missing", () => {
  const headers = [{ name: "Subject", value: "Hello" }];
  assert.equal(headerValue(headers, "subject"), "Hello");
  assert.equal(headerValue(headers, "SUBJECT"), "Hello");
  assert.equal(headerValue(headers, "missing"), "");
});

test("computeStatus reports draft + unread", () => {
  assert.deepEqual(computeStatus(["DRAFT", "UNREAD"]).sort(), ["draft", "unread"].sort());
});

test("computeStatus reports sent + read", () => {
  const status = computeStatus(["SENT"]);
  assert.ok(status.includes("sent"));
  assert.ok(status.includes("read"));
});

test("computeStatus falls back to archived with no bucket label", () => {
  assert.ok(computeStatus(["UNREAD"]).includes("archived"));
});

test("guessMimeType maps known extensions case-insensitively and falls back otherwise", () => {
  assert.equal(guessMimeType("report.pdf"), "application/pdf");
  assert.equal(guessMimeType("photo.JPG"), "image/jpeg");
  assert.equal(guessMimeType("mystery.xyz"), "application/octet-stream");
});

test("withRetry retries on a 429 and eventually succeeds", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("rate limited");
        err.code = 429;
        throw err;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withRetry does not retry a non-retryable error", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        const err = new Error("bad request");
        err.code = 400;
        throw err;
      },
      { retries: 5, baseDelayMs: 1 }
    )
  );
  assert.equal(attempts, 1);
});

test("extractEmailAddress pulls the address out of a display-name form", () => {
  assert.equal(extractEmailAddress("Jane Doe <jane@example.com>"), "jane@example.com");
  assert.equal(extractEmailAddress("jane@example.com"), "jane@example.com");
  assert.equal(extractEmailAddress("Jane Doe <JANE@EXAMPLE.COM>"), "jane@example.com");
});

test("splitAddressList splits a comma-separated header into trimmed entries", () => {
  assert.deepEqual(splitAddressList("a@x.com, b@x.com ,  c@x.com"), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.deepEqual(splitAddressList(""), []);
  assert.deepEqual(splitAddressList(undefined), []);
});

test("removeAddress filters by email regardless of display name or case", () => {
  const list = ["Jane <jane@example.com>", "bob@example.com"];
  assert.deepEqual(removeAddress(list, "JANE@EXAMPLE.COM"), ["bob@example.com"]);
  assert.deepEqual(removeAddress(list, "nobody@example.com"), list);
});

test("listAttachmentParts finds real attachments and skips inline body parts", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: "aGk=" } }, // inline body, no filename -> not an attachment
      {
        mimeType: "application/pdf",
        filename: "report.pdf",
        body: { attachmentId: "ATT1", size: 1234 },
      },
      {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "image/png", filename: "logo.png", body: { attachmentId: "ATT2", size: 42 } }],
      },
    ],
  };
  const atts = listAttachmentParts(payload);
  assert.equal(atts.length, 2);
  assert.equal(atts[0].filename, "report.pdf");
  assert.equal(atts[0].attachmentId, "ATT1");
  assert.equal(atts[1].filename, "logo.png");
});
