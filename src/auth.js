#!/usr/bin/env node
// Usage:
//   node src/auth.js <alias>         -> connect/re-auth one Gmail account under this alias
//   node src/auth.js --list          -> list connected accounts
//   node src/auth.js --remove <alias> -> disconnect an account
//   node src/auth.js --nick <alias> <nickname> -> add another name for an account
//   node src/auth.js --unnick <nickname>       -> remove a nickname
//   node src/auth.js --from <alias> [email]    -> show or set the default From address
//   node src/auth.js --from-clear <alias>      -> send from the primary address again

import http from "http";
import { URL } from "url";
import { google } from "googleapis";
import open from "open";
import {
  loadCredentials,
  upsertAccount,
  loadAccounts,
  removeAccount,
  addNickname,
  removeNickname,
  setDefaultFrom,
} from "./store.js";
import { getAccountInfo, gmailClientFor, findSendAsAddress, formatFromHeader } from "./gmail.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/userinfo.email",
];

const NAME_PATTERN = /^[a-z0-9_-]+$/i;

function parseArgs() {
  const args = process.argv.slice(2);
  if (args[0] === "--list") return { cmd: "list" };
  if (args[0] === "--remove") return { cmd: "remove", alias: args[1] };
  if (args[0] === "--nick") return { cmd: "nick", alias: args[1], nickname: args[2] };
  if (args[0] === "--unnick") return { cmd: "unnick", nickname: args[1] };
  if (args[0] === "--from") return { cmd: "from", alias: args[1], email: args[2] };
  if (args[0] === "--from-clear") return { cmd: "from-clear", alias: args[1] };
  if (args[0] && !args[0].startsWith("--")) return { cmd: "connect", alias: args[0] };
  return { cmd: "help" };
}

async function connect(alias) {
  if (!alias || !NAME_PATTERN.test(alias)) {
    console.error("Give this account a short alias, e.g.: node src/auth.js personal");
    process.exit(1);
  }

  const { clientId, clientSecret, redirectUri } = loadCredentials();
  const url = new URL(redirectUri);
  // Desktop-app clients list a bare "http://localhost"; Google accepts any loopback
  // port for them, so pin one we can listen on and send that same URI to Google.
  if (!url.port) url.port = "53682";
  const port = Number(url.port);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, url.toString());
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token every time, important when re-connecting
    scope: SCOPES,
  });

  console.log(`\nConnecting Gmail account as alias "${alias}".`);
  console.log(`Opening your browser for Google sign-in...\n`);
  console.log(`If it doesn't open automatically, visit:\n${authUrl}\n`);

  const codePromise = waitForCode(port, url.pathname);
  open(authUrl).catch(() => {});
  const code = await codePromise;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();

  const saved = await upsertAccount(alias, {
    email: data.email,
    refresh_token: tokens.refresh_token,
    // access_token/expiry are re-fetched at runtime; we don't need to persist them.
  }).catch(fail);

  if (saved.alias !== alias) {
    console.log(
      `\n${data.email} was already connected as "${saved.alias}" - refreshed its token and added "${alias}" as a nickname.`
    );
  } else {
    console.log(`\nConnected: alias "${alias}" -> ${data.email}`);
  }
  console.log(`Run "node src/auth.js --list" to see all connected accounts.\n`);
  process.exit(0);
}

function waitForCode(port, pathname) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname !== (pathname || "/oauth2callback")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end(`<h2>Authorization failed: ${error}</h2>You can close this tab.`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      res.end(`<h2>Account connected.</h2>You can close this tab and go back to the terminal.`);
      server.close();
      resolve(code);
    });
    server.listen(port);
  });
}

async function list() {
  const accounts = loadAccounts();
  const aliases = Object.keys(accounts);
  if (aliases.length === 0) {
    console.log("No Gmail accounts connected yet. Run: node src/auth.js <alias>");
    return;
  }
  console.log("Connected Gmail accounts:\n");
  for (const alias of aliases) {
    const nicknames = accounts[alias].nicknames || [];
    const also = nicknames.length ? `  (also: ${nicknames.join(", ")})` : "";
    const from = accounts[alias].default_from ? `  [sends as ${accounts[alias].default_from}]` : "";
    console.log(`  ${alias}  ->  ${accounts[alias].email}${also}${from}`);
  }
  console.log("");
}

async function remove(alias) {
  if (!alias) {
    console.error("Usage: node src/auth.js --remove <alias>");
    process.exit(1);
  }
  await removeAccount(alias).catch(fail);
  console.log(
    `Removed alias "${alias}". (This only deletes the local token; it does not revoke Google access. Revoke at https://myaccount.google.com/permissions if you want to fully disconnect.)`
  );
}

function fail(err) {
  console.error(err.message);
  process.exit(1);
}

async function nick(alias, nickname) {
  if (!alias || !nickname || !NAME_PATTERN.test(nickname)) {
    console.error("Usage: node src/auth.js --nick <alias> <nickname>   (nickname: letters, digits, - or _)");
    process.exit(1);
  }
  const owner = await addNickname(alias, nickname).catch(fail);
  console.log(`"${nickname}" now points to account "${owner}".`);
}

async function unnick(nickname) {
  if (!nickname) {
    console.error("Usage: node src/auth.js --unnick <nickname>");
    process.exit(1);
  }
  const owner = await removeNickname(nickname).catch(fail);
  console.log(`Removed nickname "${nickname}" from account "${owner}".`);
}

// Same check as the set_default_from tool: only a verified Send-as address
// is accepted, since Gmail silently falls back to the primary otherwise.
async function from(alias, email) {
  if (!alias) {
    console.error("Usage: node src/auth.js --from <alias> [email]");
    process.exit(1);
  }
  let info;
  try {
    info = getAccountInfo(alias);
  } catch (err) {
    fail(err);
  }
  const gmail = gmailClientFor(alias);
  if (!email) {
    const { data } = await gmail.users.settings.sendAs.list({ userId: "me" }).catch(fail);
    const usable = (data.sendAs || []).filter((s) => s.isPrimary || s.verificationStatus === "accepted");
    console.log(`"${info.alias}" currently sends as ${info.default_from || info.email}\n`);
    console.log("Verified addresses you can use:");
    for (const s of usable) console.log(`  ${s.sendAsEmail}${s.isPrimary ? "  (primary)" : ""}`);
    console.log(`\nSet one with: node src/auth.js --from ${info.alias} <email>`);
    return;
  }
  const match = await findSendAsAddress(gmail, info, email).catch(fail);
  const header = formatFromHeader(match.displayName, match.sendAsEmail);
  await setDefaultFrom(info.alias, header).catch(fail);
  console.log(`"${info.alias}" now sends as ${header}.`);
}

async function fromClear(alias) {
  if (!alias) {
    console.error("Usage: node src/auth.js --from-clear <alias>");
    process.exit(1);
  }
  const owner = await setDefaultFrom(alias, null).catch(fail);
  console.log(`"${owner}" now sends from its primary address.`);
}

function help() {
  console.log(`
Multi-Gmail MCP - account setup

  node src/auth.js <alias>          connect or re-authorize a Gmail account under <alias>
  node src/auth.js --list           list connected accounts
  node src/auth.js --remove <alias> disconnect an account (local token only)
  node src/auth.js --nick <alias> <nickname>
                                    add another name for an already-connected account
  node src/auth.js --unnick <nickname>
                                    remove a nickname (the account stays connected)
  node src/auth.js --from <alias> [email]
                                    show the account's verified Send-as addresses,
                                    or make <email> its default From address
  node src/auth.js --from-clear <alias>
                                    send from the account's primary address again

Example:
  node src/auth.js personal
  node src/auth.js work
  node src/auth.js dodobumbum
  node src/auth.js --nick dodobumbum dodo
  node src/auth.js --from dodobumbum inquiries@dodobumbum.com
`);
}

const { cmd, alias, nickname, email } = parseArgs();
if (cmd === "connect") await connect(alias);
else if (cmd === "list") await list();
else if (cmd === "remove") await remove(alias);
else if (cmd === "nick") await nick(alias, nickname);
else if (cmd === "unnick") await unnick(nickname);
else if (cmd === "from") await from(alias, email);
else if (cmd === "from-clear") await fromClear(alias);
else help();
