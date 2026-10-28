import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The shared store (google-mcp-accounts) computes CONFIG_DIR from
// GOOGLE_MCP_DIR at import time, so point it at a throwaway temp directory
// before importing - this keeps the test from ever touching the real
// ~/.google-mcp on the machine running it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mgmcp-test-"));
process.env.GOOGLE_MCP_DIR = path.join(tmpHome, ".google-mcp");

const store = await import("google-mcp-accounts/store");
const { setDefaultFrom } = await import("../src/gmail.js");

test("upsertAccount persists an account and loadAccounts reads it back", async () => {
  await store.upsertAccount("alias1", { email: "a@example.com", refresh_token: "rt1" });
  const accounts = store.loadAccounts();
  assert.equal(accounts.alias1.email, "a@example.com");
  assert.equal(accounts.alias1.refresh_token, "rt1");
});

test("accounts.json is written with owner-only permissions", async () => {
  const stat = fs.statSync(store.ACCOUNTS_PATH);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("concurrent upserts are serialized, not lost", async () => {
  await Promise.all([
    store.upsertAccount("a", { email: "1@x.com", refresh_token: "r1" }),
    store.upsertAccount("b", { email: "2@x.com", refresh_token: "r2" }),
    store.upsertAccount("c", { email: "3@x.com", refresh_token: "r3" }),
  ]);
  const accounts = store.loadAccounts();
  assert.equal(accounts.a.email, "1@x.com");
  assert.equal(accounts.b.email, "2@x.com");
  assert.equal(accounts.c.email, "3@x.com");
});

test("removeAccount deletes only the named alias", async () => {
  await store.removeAccount("alias1");
  const accounts = store.loadAccounts();
  assert.equal(accounts.alias1, undefined);
  assert.equal(accounts.a.email, "1@x.com"); // untouched
});

test("saveAccounts never leaves a stray .tmp file behind", () => {
  const dir = fs.readdirSync(store.CONFIG_DIR);
  assert.ok(!dir.some((f) => f.endsWith(".tmp")));
});

test("connecting an already-connected email under a new alias adds a nickname, not a second entry", async () => {
  await store.upsertAccount("main", { email: "same@x.com", refresh_token: "old" });
  const saved = await store.upsertAccount("other", { email: "same@x.com", refresh_token: "new" });
  const accounts = store.loadAccounts();
  assert.equal(saved.alias, "main");
  assert.equal(accounts.other, undefined);
  assert.deepEqual(accounts.main.nicknames, ["other"]);
  assert.equal(accounts.main.refresh_token, "new"); // one token, the freshest one
});

test("re-authorizing via a nickname refreshes the main entry", async () => {
  await store.upsertAccount("other", { email: "same@x.com", refresh_token: "newer" });
  const accounts = store.loadAccounts();
  assert.equal(accounts.other, undefined);
  assert.equal(accounts.main.refresh_token, "newer");
  assert.deepEqual(accounts.main.nicknames, ["other"]);
});

test("addNickname rejects a name already in use, and resolveAlias follows nicknames", async () => {
  await store.addNickname("main", "m");
  await assert.rejects(store.addNickname("a", "m"), /already used by account "main"/);
  await assert.rejects(store.addNickname("a", "main"), /already used/);
  const accounts = store.loadAccounts();
  assert.equal(store.resolveAlias(accounts, "m"), "main");
  assert.equal(store.resolveAlias(accounts, "main"), "main");
  assert.equal(store.resolveAlias(accounts, "nope"), undefined);
});

test("removeAccount refuses a nickname; removeNickname keeps the account", async () => {
  await assert.rejects(store.removeAccount("m"), /is a nickname of "main"/);
  await store.removeNickname("m");
  const accounts = store.loadAccounts();
  assert.deepEqual(accounts.main.nicknames, ["other"]);
  await assert.rejects(store.removeNickname("main"), /not a nickname/);
});

test("an alias can't be silently re-pointed at a mailbox connected under another alias", async () => {
  await assert.rejects(
    store.upsertAccount("a", { email: "same@x.com", refresh_token: "x" }),
    /already connected/
  );
  assert.equal(store.loadAccounts().a.email, "1@x.com");
});

test("gmail.js resolves nicknames and lists each mailbox once", async () => {
  const { getAccountInfo, getConnectedAliases } = await import("../src/gmail.js");
  const info = getAccountInfo("other");
  assert.equal(info.alias, "main");
  assert.equal(info.email, "same@x.com");
  const aliases = getConnectedAliases();
  assert.equal(aliases.filter((a) => a === "main").length, 1);
  assert.ok(!aliases.includes("other"));
  assert.throws(() => getAccountInfo("nope"), /Connected aliases: .*other/);
});

test("setDefaultFrom saves and clears default_from, and re-authorizing keeps it", async () => {
  await setDefaultFrom("other", '"Me" <me@custom.com>'); // via a nickname
  assert.equal(store.loadAccounts().main.default_from, '"Me" <me@custom.com>');
  await store.upsertAccount("main", { email: "same@x.com", refresh_token: "fresh" });
  assert.equal(store.loadAccounts().main.default_from, '"Me" <me@custom.com>');
  await setDefaultFrom("main", null);
  assert.equal(store.loadAccounts().main.default_from, undefined);
  await assert.rejects(setDefaultFrom("nope", "x@y.com"), /Unknown account alias/);
});
