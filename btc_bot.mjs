#!/usr/bin/env node
/**
 * BTC 5-MIN TRADING BOT — Polymarket v3 via @polymarket/client SDK.
 *
 * Usage:  node btc_bot.mjs [--dry-run] [--amount 5] [--side BUY]
 *
 * DNS overridden for Argentina (all *.polymarket.com → direct IP).
 * Tested & working: 2026-07-04 — placed BUY $1.00 FOK, matched.
 */

// ── Polyfill: atob via Buffer (tolera base64url + padding imperfecto) ──────
globalThis.atob = (data) => Buffer.from(data, "base64").toString("binary");

import { createSecureClient } from "./node_modules/@polymarket/client/dist/index.js";
import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import dns from "dns";
import https from "https";

// ── DNS (Argentina block) ───────────────────────────────────────────────────
const PM_IP = "104.18.34.205";
const origLookup = dns.lookup;
dns.lookup = function (h, o, cb) {
    let c = cb, opts = o;
    if (typeof o === "function") { c = o; opts = {}; }
    if (h.endsWith(".polymarket.com") || h === "polymarket.com") {
        opts.all ? c(null, [{ address: PM_IP, family: 4 }]) : c(null, PM_IP, 4);
        return;
    }
    origLookup(h, o, cb);
};
const origReq = https.request;
https.request = function (o, cb) {
    if (typeof o === "string") o = new URL(o);
    const hn = o.hostname || o.host || "";
    if (hn.endsWith(".polymarket.com") || hn === "polymarket.com") {
        o = { ...o, hostname: PM_IP, host: PM_IP, servername: hn };
        if (!o.headers) o.headers = {};
        if (!o.headers["Host"]) o.headers["Host"] = hn;
    }
    return origReq.call(https, o, cb);
};
const origGet = https.get;
https.get = function (o, cb) {
    if (typeof o === "string") o = new URL(o);
    const hn = o.hostname || o.host || "";
    if (hn.endsWith(".polymarket.com") || hn === "polymarket.com") {
        o = { ...o, hostname: PM_IP, host: PM_IP, servername: hn };
        if (!o.headers) o.headers = {};
        if (!o.headers["Host"]) o.headers["Host"] = hn;
    }
    return origGet.call(https, o, cb);
};

// ── Env ─────────────────────────────────────────────────────────────────────
const envFile = join(homedir(), ".hermes", "polymarket.env");
const lines = readFileSync(envFile, "utf-8").split("\n");
const env = {};
for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.substring(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.substring(0, eq).trim()] = v;
}

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AMOUNT = parseFloat(args.find((_, i) => args[i - 1] === "--amount") || "1");
const SIDE = args.find((_, i) => args[i - 1] === "--side") || "BUY";

// ── Helpers ─────────────────────────────────────────────────────────────────
function gammaGet(path) {
    return new Promise((res, rej) => {
        https.get({ hostname: "gamma-api.polymarket.com", path }, r => {
            let d = "";
            r.on("data", c => d += c);
            r.on("end", () => { try { res(JSON.parse(d)); } catch { res(d); } });
        }).on("error", rej);
    });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log("💰 BTC 5-min Bot", DRY_RUN ? "(DRY RUN)" : "");

    const ethWallet = new Wallet(env.PM_PRIVATE_KEY);
    const signer = {
        getAddress: () => ethWallet.getAddress(),
        signTypedData: (td) => ethWallet.signTypedData(td.domain, td.types, td.message),
    };

    const client = await createSecureClient({
        signer,
        credentials: { key: env.PM_API_KEY, secret: env.PM_API_SECRET, passphrase: env.PM_API_PASSPHRASE },
        wallet: env.PM_FUNDER,
    });

    console.log("EOA:", await signer.getAddress());
    console.log("Wallet:", client.account.wallet, "Type:", client.account.walletType);

    // Market
    const now = Math.floor(Date.now() / 1000);
    const bucket = now - (now % 300);
    const evs = await gammaGet("/events?slug=btc-updown-5m-" + bucket);
    if (!evs?.[0]) { console.log("❌ No active BTC 5m market"); return; }
    const mkt = evs[0];
    const tokenId = JSON.parse(mkt.markets[0].clobTokenIds || "[]")[0];

    console.log("Market:", mkt.title);
    console.log("Token:", tokenId.substring(0, 16) + "...");

    // Book
    const book = await client.fetchOrderBook({ tokenId });
    const bid = book.bids?.[0]?.price || "0.01";
    const ask = book.asks?.[0]?.price || "0.99";
    console.log("Bid:", bid, "Ask:", ask);

    if (DRY_RUN) {
        console.log(`[DRY RUN] Would ${SIDE} $${AMOUNT} (min $1.00)`);
        return;
    }

    // Place order
    console.log(`\n📝 ${SIDE} $${AMOUNT} FOK...`);
    const r = await client.placeMarketOrder({
        tokenId,
        side: SIDE,
        amount: Math.max(AMOUNT, 1.0),
        orderType: "FOK",
    });

    console.log("✅ OK:", r.status);
    console.log("Order ID:", r.orderId);
    console.log("Making:", r.makingAmount, "Taking:", r.takingAmount);
    if (r.transactionsHashes?.length) console.log("TX:", r.transactionsHashes[0]);
}

main().catch(e => {
    console.error("Fatal:", e.message?.substring(0, 400));
    process.exit(1);
});
