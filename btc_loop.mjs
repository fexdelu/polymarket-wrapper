#!/usr/bin/env node
/**
 * BTC 5-MIN LOOP — Monitorea y opera cada bucket automáticamente.
 * Log en ~/polymarket-wrapper/btc_bot.log
 *
 * Uso: node btc_loop.mjs [--dry-run] [--amount 5]
 */

// ── Polyfill: atob via Buffer (tolera base64url + padding imperfecto) ──────
globalThis.atob = (data) => Buffer.from(data, "base64").toString("binary");

import { createSecureClient } from "./node_modules/@polymarket/client/dist/index.js";
import { Wallet } from "ethers";
import { readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import dns from "dns";
import https from "https";

// ── DNS ────────────────────────────────────────────────────────────────────
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

// ── Config ──────────────────────────────────────────────────────────────────
const LOG_FILE = join(homedir(), "polymarket-wrapper", "btc_bot.log");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AMOUNT = parseFloat(args.find((_, i) => args[i - 1] === "--amount") || "1");

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
    env[t.substring(0, eq).trim()] = v;
}

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
    const line = `[${ts}] ${msg}`;
    console.log(line);
    try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main loop ───────────────────────────────────────────────────────────────
async function main() {
    log("══════ BTC 5-min Loop START " + (DRY_RUN ? "(DRY RUN)" : "LIVE") + " — amount: $" + AMOUNT + " ══════");

    const ethWallet = new Wallet(env.PM_PRIVATE_KEY);
    const signer = {
        getAddress: () => ethWallet.getAddress(),
        signTypedData: (td) => ethWallet.signTypedData(td.domain, td.types, td.message),
    };

    let client;
    let lastBucket = 0;

    while (true) {
        try {
            // Reconnect each cycle (tokens expire)
            client = await createSecureClient({
                signer,
                credentials: { key: env.PM_API_KEY, secret: env.PM_API_SECRET, passphrase: env.PM_API_PASSPHRASE },
                wallet: env.PM_FUNDER,
            });

            // Current bucket
            const now = Math.floor(Date.now() / 1000);
            const bucket = now - (now % 300);

            if (bucket === lastBucket) {
                // Same bucket — wait until next one
                const nextBucket = bucket + 300;
                const waitSec = nextBucket - Math.floor(Date.now() / 1000);
                if (waitSec > 0 && waitSec < 290) {
                    await sleep(waitSec * 1000 * 0.8); // wait 80% of remaining time
                    continue;
                }
                await sleep(10000);
                continue;
            }
            lastBucket = bucket;

            // Find market
            const evs = await gammaGet("/events?slug=btc-updown-5m-" + bucket);
            if (!evs?.[0]) {
                log(`SKIP bucket ${bucket} — no market yet`);
                await sleep(15000);
                continue;
            }

            const mkt = evs[0];
            const tokenId = JSON.parse(mkt.markets[0].clobTokenIds || "[]")[0];
            if (!tokenId) { log("SKIP — no tokenId"); await sleep(10000); continue; }

            log(`── Bucket ${bucket} — ${mkt.title} ──`);

            // Order book
            const book = await client.fetchOrderBook({ tokenId });
            const bid = book.bids?.[0]?.price || "0.01";
            const ask = book.asks?.[0]?.price || "0.99";
            log(`Book: bid=${bid} ask=${ask}`);

            if (DRY_RUN) {
                log(`[DRY RUN] Would BUY $${AMOUNT} FOK`);
                await sleep(15000);
                continue;
            }

            // Place order
            try {
                const r = await client.placeMarketOrder({
                    tokenId,
                    side: "BUY",
                    amount: AMOUNT,
                    orderType: "FOK",
                });
                log(`✅ ORDER: status=${r.status} making=$${r.makingAmount} taking=${r.takingAmount} tx=${r.transactionsHashes?.[0]?.substring(0,16)}...`);
            } catch (e) {
                log(`❌ ORDER FAILED: ${e.message?.substring(0, 200)}`);
            }

            // Wait a bit before checking next bucket
            await sleep(30000);

        } catch (e) {
            log(`⚠️  Loop error: ${e.message?.substring(0, 200)}`);
            await sleep(30000);
        }
    }
}

main().catch(e => {
    log(`FATAL: ${e.message?.substring(0, 300)}`);
    process.exit(1);
});
