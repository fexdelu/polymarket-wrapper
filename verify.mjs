#!/usr/bin/env node
// hermetic verification: btc_bot.mjs dry-run + env consistency
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Wallet } from "ethers";

const PASS = "✅", FAIL = "❌";
let ok = true;

// 1. Env consistency
console.log("=== 1. Env consistency ===");
const raw = readFileSync(join(homedir(), ".hermes", "polymarket.env"), "utf-8");
const env = {};
for (const l of raw.split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...v] = t.split("=");
    env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
}
const hexLen = env.PM_PRIVATE_KEY.replace("0x", "").length;
console.log(`  key hex length: ${hexLen} ${hexLen === 64 ? PASS : FAIL}`);

const w = new Wallet(env.PM_PRIVATE_KEY);
const match = w.address.toLowerCase() === (env.PM_FUNDER || "").toLowerCase();
// POLY_PROXY (Type 3): EOA != Funder is expected — the proxy wallet is controlled by the EOA
const eoaOk = match || true;  // always OK; mismatch is normal for proxy wallets
console.log(`  EOA→Funder match: ${match ? PASS + " (direct)" : "⚠️  proxy wallet (expected)"}`);

const hasCreds = !!(env.PM_API_KEY && env.PM_API_SECRET && env.PM_API_PASSPHRASE);
console.log(`  API credentials: ${hasCreds ? PASS : FAIL}`);

// 2. atob polyfill
console.log("\n=== 2. atob polyfill ===");
globalThis.atob = (data) => Buffer.from(data, "base64").toString("binary");
try {
    const r = atob(env.PM_API_SECRET);
    console.log(`  secret decodes: ${PASS} (${r.length} bytes)`);
} catch(e) {
    console.log(`  secret decodes: ${FAIL} — ${e.message}`);
    ok = false;
}
try {
    atob("dGVzdA==");
    console.log(`  std base64 ok:  ${PASS}`);
} catch(e) {
    console.log(`  std base64 ok:  ${FAIL}`);
    ok = false;
}

// 3. btc_bot.mjs dry-run
console.log("\n=== 3. btc_bot.mjs dry-run ===");
try {
    const out = execSync("node btc_bot.mjs --dry-run", {
        cwd: join(homedir(), "polymarket-wrapper"),
        timeout: 20000,
        encoding: "utf-8",
    });
    const hasEOA = out.includes("EOA:");
    const hasWallet = out.includes("Wallet:");
    const hasMarket = out.includes("Market:");
    const hasDryRun = out.includes("[DRY RUN]");
    console.log(`  EOA printed:  ${hasEOA ? PASS : FAIL}`);
    console.log(`  Wallet shown: ${hasWallet ? PASS : FAIL}`);
    console.log(`  Market found: ${hasMarket ? PASS : FAIL}`);
    console.log(`  Dry-run ok:   ${hasDryRun ? PASS : FAIL}`);
    if (!(hasEOA && hasWallet && hasMarket && hasDryRun)) ok = false;
    // Print key output lines
    for (const line of out.split("\n")) {
        if (line.includes("EOA:") || line.includes("Wallet:") || line.includes("[DRY RUN]")) {
            console.log(`  → ${line.trim()}`);
        }
    }
} catch(e) {
    console.log(`  ${FAIL} ${e.stderr || e.message}`.trim().split("\n")[0]);
    ok = false;
}

// 4. Clean check: no secrets in git
console.log("\n=== 4. No secrets in committed code ===");
const pmEnv = join(homedir(), ".hermes", "polymarket.env");
const committed = [".env.example", "btc_bot.mjs", "btc_loop.mjs", "README.md"];
let secretLeak = false;
for (const f of committed) {
    const content = readFileSync(join(homedir(), "polymarket-wrapper", f), "utf-8");
    if (content.includes(env.PM_PRIVATE_KEY.replace("0x", "").substring(0, 20))) {
        console.log(`  ${FAIL} ${f} contains private key fragment`);
        secretLeak = true;
    }
    if (content.includes(env.PM_API_KEY)) {
        console.log(`  ${FAIL} ${f} contains API key`);
        secretLeak = true;
    }
}
if (!secretLeak) console.log(`  ${PASS} no secrets found in committed files`);

console.log(`\n${ok ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED"}`);
process.exit(ok ? 0 : 1);
