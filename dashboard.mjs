#!/usr/bin/env node
/**
 * PAPURRI BTC BOT — Dashboard Server
 * Corre en http://localhost:3000 — abrí desde Windows
 *
 * Uso: node dashboard.mjs [--port 3000]
 */

// ── Polyfill: atob via Buffer ───────────────────────────────────────────────
globalThis.atob = (data) => Buffer.from(data, "base64").toString("binary");

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { execSync } from "child_process";
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
const PORT = parseInt(process.argv.find((_, i) => process.argv[i - 1] === "--port") || "3000");
const LOG_FILE = join(homedir(), "polymarket-wrapper", "btc_bot.log");
const ENV_FILE = join(homedir(), ".hermes", "polymarket.env");
const HTML_FILE = join(dirname(new URL(import.meta.url).pathname), "dashboard.html");

// ── Env ─────────────────────────────────────────────────────────────────────
function loadEnv() {
    const raw = readFileSync(ENV_FILE, "utf-8");
    const env = {};
    for (const l of raw.split("\n")) {
        const t = l.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const [k, ...v] = t.split("=");
        env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
    }
    return env;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function httpGet(hostname, path) {
    return new Promise((res, rej) => {
        https.get({ hostname, path, headers: { "User-Agent": "dashboard/1.0" } }, r => {
            let d = "";
            r.on("data", c => d += c);
            r.on("end", () => { try { res(JSON.parse(d)); } catch { res(d); } });
        }).on("error", rej);
    });
}

function jsonReply(res, data, code = 200) {
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
}

// ── Bot status ──────────────────────────────────────────────────────────────
function getBotStatus() {
    try {
        const out = execSync("ps aux | grep 'node btc_loop' | grep -v grep", {
            encoding: "utf-8",
            timeout: 3000,
        }).trim();
        if (!out) return { running: false, pid: null, uptime: null, lastOrder: null };

        const parts = out.split(/\s+/);
        const pid = parseInt(parts[1]);
        // uptime from ps: field 9 is elapsed time
        const elapsed = parts[9] || "?";

        return { running: true, pid, uptime: elapsed, lastOrder: null };
    } catch {
        return { running: false, pid: null, uptime: null, lastOrder: null };
    }
}

// ── Parse log ───────────────────────────────────────────────────────────────
function parseLog() {
    if (!existsSync(LOG_FILE)) return [];

    const raw = readFileSync(LOG_FILE, "utf-8");
    const lines = raw.trim().split("\n");
    const orders = [];
    let currentBucket = null;
    let currentBook = null;
    let currentReasoning = null;
    let sessionStart = null;

    for (const line of lines) {
        const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
        const ts = tsMatch ? tsMatch[1] : null;

        if (line.includes("Loop START LIVE")) {
            const amt = line.match(/amount: \$(\d+)/);
            sessionStart = { time: ts, amount: amt ? parseInt(amt[1]) : 1 };
        }

        const bucketMatch = line.match(/Bucket (\d+).*?(Bitcoin Up or Down.*?ET)/);
        if (bucketMatch) {
            currentBucket = { id: bucketMatch[1], name: bucketMatch[2] };
            currentBook = null;
            currentReasoning = null;
        }

        const bookMatch = line.match(/Book: bid=([\d.]+) ask=([\d.]+)/);
        if (bookMatch) {
            currentBook = { bid: parseFloat(bookMatch[1]), ask: parseFloat(bookMatch[2]) };
        }

        // Reasoning line
        const reasoningMatch = line.match(/🧠 REASONING: (.+)$/);
        if (reasoningMatch) {
            currentReasoning = reasoningMatch[1];
        }

        const orderMatch = line.match(/ORDER: status=(\S+) making=\$(\S+) taking=(\S+) tx=(\S+)/);
        if (orderMatch && currentBucket) {
            const price = currentBook
                ? (orderMatch[1] === "matched" ? currentBook.ask : currentBook.bid)
                : 0;
            orders.push({
                time: ts,
                bucket: currentBucket.name,
                bucketId: currentBucket.id,
                status: orderMatch[1],
                making: parseFloat(orderMatch[2]),
                taking: parseFloat(orderMatch[3]),
                tx: orderMatch[4],
                price: price,
                bid: currentBook?.bid || 0,
                ask: currentBook?.ask || 0,
                side: "BUY",
                reasoning: currentReasoning || "BUY UP (no reasoning data)",
            });
        }
    }

    return orders.reverse();
}

// ── Polymarket API wrappers ─────────────────────────────────────────────────
async function getActivity(env) {
    try {
        const funder = env.PM_FUNDER;
        const data = await httpGet("data-api.polymarket.com", `/activity?user=${funder}&limit=30&sortBy=TIMESTAMP&sortDirection=DESC`);
        if (!Array.isArray(data)) return [];
        return data.map(a => ({
            type: a.type,
            title: a.title,
            side: a.side,
            outcome: a.outcome,
            shares: a.shares || a.size,
            usdcAmount: a.usdcAmount || a.amount,
            price: a.price,
            timestamp: a.timestamp,
        }));
    } catch { return []; }
}

async function getBalance(env) {
    try {
        return await httpGet("data-api.polymarket.com", `/balances?user=${env.PM_FUNDER}`);
    } catch { return null; }
}

async function getCurrentMarket() {
    try {
        const now = Math.floor(Date.now() / 1000);
        const bucket = now - (now % 300);
        const evs = await httpGet("gamma-api.polymarket.com", `/events?slug=btc-updown-5m-${bucket}`);
        if (!evs?.[0]) return null;
        const m = evs[0];
        const mkt = m.markets?.[0];
        const prices = mkt?.outcomePrices ? JSON.parse(mkt.outcomePrices) : [0, 0];
        const tokens = mkt?.clobTokenIds ? JSON.parse(mkt.clobTokenIds) : [];
        return {
            title: m.title,
            bucket,
            upPrice: parseFloat(prices[0]),
            downPrice: parseFloat(prices[1]),
            volume: parseFloat(mkt?.volume || "0"),
            tokenId: tokens[0]?.substring(0, 16) + "...",
        };
    } catch { return null; }
}

// ── API Routes ──────────────────────────────────────────────────────────────
async function apiStatus(res, env) {
    const bot = getBotStatus();
    const orders = parseLog();
    if (orders.length > 0) bot.lastOrder = orders[0];
    jsonReply(res, bot);
}

async function apiOrders(res) {
    jsonReply(res, parseLog());
}

async function apiActivity(res, env) {
    const activity = await getActivity(env);
    jsonReply(res, activity);
}

async function apiBalance(res, env) {
    const balance = await getBalance(env);
    jsonReply(res, balance || { error: "unavailable" });
}

async function apiMarket(res) {
    const market = await getCurrentMarket();
    jsonReply(res, market || { error: "no active market" });
}

async function apiFull(res, env) {
    const [bot, orders, activity, balance, market] = await Promise.all([
        Promise.resolve(getBotStatus()),
        Promise.resolve(parseLog()),
        getActivity(env),
        getBalance(env),
        getCurrentMarket(),
    ]);
    if (orders.length > 0) bot.lastOrder = orders[0];
    jsonReply(res, { bot, orders, activity, balance, market });
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const env = loadEnv();

        switch (path) {
            case "/api/status":   return await apiStatus(res, env);
            case "/api/orders":   return await apiOrders(res);
            case "/api/activity": return await apiActivity(res, env);
            case "/api/balance":  return await apiBalance(res, env);
            case "/api/market":   return await apiMarket(res);
            case "/api/full":     return await apiFull(res, env);

            case "/":
            case "/index.html":
                if (existsSync(HTML_FILE)) {
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(readFileSync(HTML_FILE, "utf-8"));
                } else {
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(getInlineHTML());
                }
                return;

            default:
                res.writeHead(404);
                res.end("Not found");
        }
    } catch (e) {
        jsonReply(res, { error: e.message }, 500);
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`📊 Dashboard → http://localhost:${PORT}`);
    console.log(`   Abrí eso en Chrome/Edge desde Windows`);
    console.log(`   API: /api/full | /api/status | /api/orders | /api/activity | /api/balance | /api/market`);
});

// ── Inline HTML (fallback si no existe dashboard.html) ──────────────────────
function getInlineHTML() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Papurri BTC Bot</title>
<style>body{background:#0d0f12;color:#fff;font-family:system-ui;padding:20px}
h1{color:#4af}</style></head><body><h1>📊 Papurri BTC Bot</h1><p>Creá dashboard.html para la vista completa</p></body></html>`;
}
