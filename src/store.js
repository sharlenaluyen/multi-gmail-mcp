import fs from "fs";
import path from "path";
import os from "os";

// Where everything lives: ~/.multi-gmail-mcp/
export const CONFIG_DIR = path.join(os.homedir(), ".multi-gmail-mcp");
export const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json"); // Google OAuth client (you provide this)
export const ACCOUNTS_PATH = path.join(CONFIG_DIR, "accounts.json"); // alias -> tokens + email + nicknames, written by auth.js

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `No Google OAuth client credentials found at ${CREDENTIALS_PATH}.\n` +
        `Download the OAuth client JSON from Google Cloud Console (APIs & Services -> Credentials)\n` +
        `and save it at that exact path, then re-run.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const key = raw.installed || raw.web;
  if (!key) {
    throw new Error(
      `credentials.json doesn't look like a Google OAuth client file (expected an "installed" or "web" key).`
    );
  }
  return {
    clientId: key.client_id,
    clientSecret: key.client_secret,
    redirectUri: (key.redirect_uris && key.redirect_uris[0]) || "http://localhost:53682/oauth2callback",
  };
}

export function loadAccounts() {
  ensureConfigDir();
  if (!fs.existsSync(ACCOUNTS_PATH)) return {};
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
}

export function saveAccounts(accounts) {
  ensureConfigDir();
  // Atomic write: write to a temp file in the same directory, then rename.
  // Rename is atomic on the same filesystem, so a crash or a concurrent
  // reader never observes a half-written accounts.json.
  const tmpPath = `${ACCOUNTS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, ACCOUNTS_PATH);
}

// Serialize read-modify-write cycles within this process so two concurrent
// calls (e.g. two tool invocations racing) can't clobber each other with a
// stale read. This does not protect against a second OS process writing at
// the same time, but the atomic rename in saveAccounts() keeps the file
// itself consistent even then.
let writeQueue = Promise.resolve();
function serialized(fn) {
  const result = writeQueue.then(fn);
  // Keep the queue alive even if this write fails, so later writes still run.
  writeQueue = result.catch(() => {});
  return result;
}

// Each entry in accounts.json is keyed by its main alias and may carry a
// `nicknames` list of extra names that point at the same account (and the
// same refresh token). Returns the main alias that `name` refers to, or
// undefined if nothing matches.
export function resolveAlias(accounts, name) {
  if (Object.hasOwn(accounts, name)) return name;
  return Object.keys(accounts).find((alias) => (accounts[alias].nicknames || []).includes(name));
}

// Connect or re-authorize. If `data.email` is already connected under a
// different alias, that entry gets the fresh token and `alias` becomes one of
// its nicknames, so one mailbox never ends up with two entries.
export function upsertAccount(alias, data) {
  return serialized(() => {
    const accounts = loadAccounts();
    const existing = resolveAlias(accounts, alias);
    const sameEmail = data.email && Object.keys(accounts).find((a) => accounts[a].email === data.email);

    if (sameEmail && sameEmail !== existing) {
      if (existing === alias) {
        throw new Error(
          `"${alias}" is already connected to ${accounts[alias].email}, and ${data.email} is already connected as "${sameEmail}". ` +
            `Remove "${alias}" first, or add it as a nickname of "${sameEmail}".`
        );
      }
      if (existing) dropNickname(accounts, existing, alias); // nickname moving to a different mailbox
      const target = accounts[sameEmail];
      accounts[sameEmail] = { ...target, ...data, nicknames: [...(target.nicknames || []), alias] };
      saveAccounts(accounts);
      return { alias: sameEmail, ...accounts[sameEmail] };
    }

    const key = existing || alias;
    accounts[key] = { nicknames: [], ...accounts[key], ...data };
    saveAccounts(accounts);
    return { alias: key, ...accounts[key] };
  });
}

function dropNickname(accounts, alias, nickname) {
  accounts[alias].nicknames = (accounts[alias].nicknames || []).filter((n) => n !== nickname);
}

export function addNickname(name, nickname) {
  return serialized(() => {
    const accounts = loadAccounts();
    const alias = resolveAlias(accounts, name);
    if (!alias) throw new Error(`Unknown account alias "${name}".`);
    const taken = resolveAlias(accounts, nickname);
    if (taken) throw new Error(`"${nickname}" is already used by account "${taken}".`);
    accounts[alias].nicknames = [...(accounts[alias].nicknames || []), nickname];
    saveAccounts(accounts);
    return alias;
  });
}

export function removeNickname(nickname) {
  return serialized(() => {
    const accounts = loadAccounts();
    const alias = resolveAlias(accounts, nickname);
    if (!alias || alias === nickname) throw new Error(`"${nickname}" is not a nickname.`);
    dropNickname(accounts, alias, nickname);
    saveAccounts(accounts);
    return alias;
  });
}

// Removes the whole account (token and all nicknames). Refuses a nickname so
// a typo can't disconnect a mailbox you meant to keep.
export function removeAccount(alias) {
  return serialized(() => {
    const accounts = loadAccounts();
    const owner = resolveAlias(accounts, alias);
    if (owner && owner !== alias) {
      throw new Error(
        `"${alias}" is a nickname of "${owner}". Use --unnick ${alias} to remove just the nickname.`
      );
    }
    delete accounts[alias];
    saveAccounts(accounts);
  });
}
