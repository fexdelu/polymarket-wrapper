#!/usr/bin/env node
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import dns from "dns";
import https from "https";

// ── DNS patch (Argentina) ───────────────────────────────────────────────────
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

const funder = env.PM_FUNDER;
console.log("🔍 Funder:", funder);
console.log("🔑 Key hex chars:", env.PM_PRIVATE_KEY.replace("0x", "").length, "(needs 64)");
console.log("");

// ── Helpers ─────────────────────────────────────────────────────────────────
function get(hostname, path) {
    return new Promise((res, rej) => {
        https.get({ hostname, path, headers: { "User-Agent": "bot/1.0" } }, r => {
            let d = "";
            r.on("data", c => d += c);
            r.on("end", () => { try { res(JSON.parse(d)); } catch { res(d); } });
        }).on("error", rej);
    });
}

function ago(ts) {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m hace`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h hace`;
    return `${Math.floor(hrs/24)}d hace`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    // 1. Activity from data-api
    console.log("═══ ACTIVIDAD RECIENTE ═══\n");
    try {
        const act = await get("data-api.polymarket.com", `/activity?user=${funder}&limit=30&sortBy=TIMESTAMP&sortDirection=DESC`);
        if (Array.isArray(act) && act.length > 0) {
            for (const a of act) {
                const type = a.type || "?";
                const title = (a.title || "").substring(0, 55);
                const side = a.side || "";
                const outcome = a.outcome || "";
                
                // Determine value
                let value = "";
                if (type === "REDEEM") {
                    value = `+$${a.usdcAmount || a.amount || "?"}`;
                } else if (type === "TRADE" && side === "BUY") {
                    value = `-$${a.usdcAmount || a.amount || "?"}`;
                } else if (type === "TRADE" && side === "SELL") {
                    value = `+$${a.usdcAmount || a.amount || "?"}`;
                } else {
                    value = `$${a.usdcAmount || a.amount || "?"}`;
                }
                
                const time = a.timestamp ? ago(a.timestamp) : "?";
                const shares = a.shares || a.size || "";
                
                console.log(`${type.padEnd(8)} │ ${title}`);
                console.log(`         │ ${value}  ${shares ? shares + " shares" : ""}  ${outcome}  ${time}`);
                console.log("");
            }
        } else {
            console.log("  (sin actividad)\n");
        }
    } catch (e) { console.log("  Error activity:", e.message, "\n"); }

    // 2. Detailed trades from CLOB
    console.log("═══ TRADES (CLOB) ═══\n");
    try {
        const trades = await get("clob.polymarket.com", `/data/trades?maker=${funder}&limit=10`);
        if (Array.isArray(trades)) {
            for (const t of trades.slice(0, 10)) {
                const price = parseFloat(t.price || 0).toFixed(4);
                const size = parseFloat(t.size || 0).toFixed(4);
                const cost = (parseFloat(t.price) * parseFloat(t.size)).toFixed(2);
                const ts = t.match_time || t.created_at;
                console.log(`  ${t.side?.padEnd(4)} │ $${price} x ${size} = $${cost} │ ${ts || "?"}`);
            }
            if (trades.length === 0) console.log("  (sin trades)");
        }
    } catch (e) { console.log("  Error trades:", e.message); }

    // 3. Balances
    console.log("\n═══ BALANCE ═══");
    try {
        const bal = await get("data-api.polymarket.com", `/balances?user=${funder}`);
        console.log(" ", JSON.stringify(bal).substring(0, 300));
    } catch (e) { console.log("  Error balance:", e.message); }
}

main().catch(e => console.error("💥 Fatal:", e.message));
