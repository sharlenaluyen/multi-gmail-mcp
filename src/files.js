import path from "path";
import os from "os";
import { createFilesFolder } from "google-mcp-accounts";

// The only folder attach_document may read from and download_attachment may
// write to. Without this, a prompt-injected tool call could attach any file
// you can read (e.g. ~/.ssh/id_rsa) to a draft, or overwrite files anywhere.
// Override with the MULTI_GMAIL_MCP_FILES_DIR environment variable. The
// checks themselves are the shared ones from google-mcp-accounts.
export const { FILES_DIR, resolveReadablePath, resolveWritablePath } = createFilesFolder(
  process.env.MULTI_GMAIL_MCP_FILES_DIR
    ? path.resolve(process.env.MULTI_GMAIL_MCP_FILES_DIR)
    : path.join(os.homedir(), "Downloads", "gmail-mcp")
);
