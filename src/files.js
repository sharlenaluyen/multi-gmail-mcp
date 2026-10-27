import fs from "fs";
import path from "path";
import os from "os";

// The only folder attach_document may read from and download_attachment may
// write to. Without this, a prompt-injected tool call could attach any file
// you can read (e.g. ~/.ssh/id_rsa) to a draft, or overwrite files anywhere.
// Override with the MULTI_GMAIL_MCP_FILES_DIR environment variable.
export const FILES_DIR = process.env.MULTI_GMAIL_MCP_FILES_DIR
  ? path.resolve(process.env.MULTI_GMAIL_MCP_FILES_DIR)
  : path.join(os.homedir(), "Downloads", "gmail-mcp");

function filesRoot() {
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  return fs.realpathSync(FILES_DIR);
}

// Compares real paths (symlinks resolved), so a link inside the folder that
// points elsewhere doesn't get through.
function assertInside(root, realPath, requested) {
  if (!realPath.startsWith(root + path.sep)) {
    throw new Error(
      `"${requested}" is outside the allowed files folder (${FILES_DIR}). Use a file inside that folder.`
    );
  }
}

// A relative path is taken relative to FILES_DIR; an absolute one must point inside it.
export function resolveReadablePath(requested) {
  const root = filesRoot();
  const resolved = path.resolve(root, requested);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(`File not found or not readable: ${resolved}`);
  }
  assertInside(root, real, requested);
  return real;
}

export function resolveWritablePath(requested) {
  const root = filesRoot();
  const resolved = path.resolve(root, requested);
  let dir;
  try {
    dir = fs.realpathSync(path.dirname(resolved));
  } catch {
    throw new Error(`Destination folder doesn't exist: ${path.dirname(resolved)}`);
  }
  const target = path.join(dir, path.basename(resolved));
  assertInside(root, target, requested);
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlink: ${target}`);
  }
  return target;
}
