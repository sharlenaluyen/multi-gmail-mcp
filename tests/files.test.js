import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// files.js reads the folder from the environment at import time, so point it
// at a throwaway directory first - never the real ~/Downloads/gmail-mcp.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mgmcp-files-")));
const filesDir = path.join(tmp, "files");
process.env.MULTI_GMAIL_MCP_FILES_DIR = filesDir;

const { FILES_DIR, resolveReadablePath, resolveWritablePath } = await import("../src/files.js");
const outside = path.join(tmp, "secret.txt");
fs.writeFileSync(outside, "do not attach");

test("the files folder comes from MULTI_GMAIL_MCP_FILES_DIR and is created on demand", () => {
  assert.equal(FILES_DIR, filesDir);
  resolveWritablePath("x.pdf");
  assert.ok(fs.statSync(filesDir).isDirectory());
});

test("files inside the folder resolve, by relative or absolute path", () => {
  fs.writeFileSync(path.join(filesDir, "ok.txt"), "hi");
  assert.equal(resolveReadablePath("ok.txt"), path.join(filesDir, "ok.txt"));
  assert.equal(resolveReadablePath(path.join(filesDir, "ok.txt")), path.join(filesDir, "ok.txt"));
  assert.equal(resolveWritablePath("new.pdf"), path.join(filesDir, "new.pdf"));
});

test("reading outside the folder is refused, including via ../ and symlinks", () => {
  assert.throws(() => resolveReadablePath(outside), /outside the allowed files folder/);
  assert.throws(() => resolveReadablePath("../secret.txt"), /outside the allowed files folder/);
  fs.symlinkSync(outside, path.join(filesDir, "link.txt"));
  assert.throws(() => resolveReadablePath("link.txt"), /outside the allowed files folder/);
  assert.throws(() => resolveReadablePath(path.join(os.homedir(), ".ssh", "id_rsa")), /outside|not found/);
});

test("writing outside the folder or through a symlink is refused", () => {
  assert.throws(() => resolveWritablePath(path.join(tmp, "evil.sh")), /outside the allowed files folder/);
  assert.throws(() => resolveWritablePath("../evil.sh"), /outside the allowed files folder/);
  assert.throws(() => resolveWritablePath("link.txt"), /symlink/);
  assert.throws(() => resolveWritablePath("missing-dir/x.pdf"), /Destination folder doesn't exist/);
});
