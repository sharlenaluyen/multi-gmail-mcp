#!/usr/bin/env node
// Usage:
//   node src/default-from.js <alias> [email]  -> show or set the default From address
//   node src/default-from.js --clear <alias>  -> send from the primary address again
//
// Connecting accounts moved to google-mcp-accounts (node auth.js <alias>).
// This stays here because it's Gmail-specific: it checks the address against
// the account's verified Send-as list, the same way set_default_from does.

import {
  getAccountInfo,
  gmailClientFor,
  findSendAsAddress,
  formatFromHeader,
  setDefaultFrom,
} from "./gmail.js";

function fail(err) {
  console.error(err.message);
  process.exit(1);
}

// Same check as the set_default_from tool: only a verified Send-as address
// is accepted, since Gmail silently falls back to the primary otherwise.
async function from(alias, email) {
  if (!alias) {
    console.error("Usage: node src/default-from.js <alias> [email]");
    process.exit(1);
  }
  let info;
  try {
    info = getAccountInfo(alias);
  } catch (err) {
    fail(err);
  }
  let gmail;
  try {
    gmail = gmailClientFor(alias);
  } catch (err) {
    fail(err);
  }
  if (!email) {
    const { data } = await gmail.users.settings.sendAs.list({ userId: "me" }).catch(fail);
    const usable = (data.sendAs || []).filter((s) => s.isPrimary || s.verificationStatus === "accepted");
    console.log(`"${info.alias}" currently sends as ${info.default_from || info.email}\n`);
    console.log("Verified addresses you can use:");
    for (const s of usable) console.log(`  ${s.sendAsEmail}${s.isPrimary ? "  (primary)" : ""}`);
    console.log(`\nSet one with: node src/default-from.js ${info.alias} <email>`);
    return;
  }
  const match = await findSendAsAddress(gmail, info, email).catch(fail);
  const header = formatFromHeader(match.displayName, match.sendAsEmail);
  await setDefaultFrom(info.alias, header).catch(fail);
  console.log(`"${info.alias}" now sends as ${header}.`);
}

async function clear(alias) {
  if (!alias) {
    console.error("Usage: node src/default-from.js --clear <alias>");
    process.exit(1);
  }
  const owner = await setDefaultFrom(alias, null).catch(fail);
  console.log(`"${owner}" now sends from its primary address.`);
}

const args = process.argv.slice(2);
if (args[0] === "--clear") await clear(args[1]);
else await from(args[0], args[1]);
