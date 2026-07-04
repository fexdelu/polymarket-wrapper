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
const BOT_DIR = join(homedir(), "polymarket-wrapper");
const BOT_CMD = "node btc_loop.mjs";
const HTML_FILE = join(dirname(new URL(import.meta.url).pathname), "dashboard.html");

// ── Bot process tracking ────────────────────────────────────────────────────
let botProcess = null;
let botStartTime = null;

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

// ── Bot status & control ────────────────────────────────────────────────────
import { spawn, execSync as exec } from "child_process";

function getBotStatus() {
    // Check our tracked process first
    if (botProcess && botProcess.exitCode === null) {
        return {
            running: true,
            pid: botProcess.pid,
            uptime: botStartTime ? elapsed(botStartTime) : "?",
            managed: true,
            lastOrder: null,
        };
    }
    // Fallback: scan ps
    try {
        const out = exec("ps aux | grep 'node btc_loop' | grep -v grep", {
            encoding: "utf-8", timeout: 3000,
        }).trim();
        if (!out) return { running: false, pid: null, uptime: null, managed: false, lastOrder: null };
        const parts = out.split(/\s+/);
        return { running: true, pid: parseInt(parts[1]), uptime: parts[9] || "?", managed: false, lastOrder: null };
    } catch {
        return { running: false, pid: null, uptime: null, managed: false, lastOrder: null };
    }
}

function elapsed(since) {
    const diff = Math.floor((Date.now() - since) / 1000);
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function stopBot() {
    return new Promise((resolve) => {
        if (botProcess && botProcess.exitCode === null) {
            botProcess.on("exit", () => resolve({ ok: true, msg: "Bot detenido (managed)" }));
            botProcess.kill("SIGTERM");
            setTimeout(() => {
                if (botProcess.exitCode === null) { botProcess.kill("SIGKILL"); }
            }, 5000);
        } else {
            // Try kill via ps
            try {
                exec("pkill -f 'node btc_loop' 2>/dev/null; pkill -f 'btc_loop.mjs' 2>/dev/null", { timeout: 3000 });
                resolve({ ok: true, msg: "Bot detenido (pkill)" });
            } catch { resolve({ ok: true, msg: "No se encontró proceso del bot" }); }
        }
    });
}

function startBot() {
    return new Promise((resolve) => {
        if (botProcess && botProcess.exitCode === null) {
            resolve({ ok: false, msg: "Bot ya está corriendo (managed)", pid: botProcess.pid });
            return;
        }
        // Check for existing bot process
        try {
            const out = exec("ps aux | grep 'node btc_loop' | grep -v grep", { encoding: "utf-8", timeout: 3000 }).trim();
            if (out) {
                const parts = out.split(/\s+/);
                resolve({ ok: false, msg: "Bot ya está corriendo", pid: parseInt(parts[1]) });
                return;
            }
        } catch {}
        try {
            botProcess = spawn("node", ["btc_loop.mjs"], {
                cwd: BOT_DIR, detached: true, stdio: "ignore",
            });
            botProcess.unref();
            botStartTime = Date.now();
            resolve({ ok: true, msg: "Bot iniciado", pid: botProcess.pid });
        } catch (e) {
            resolve({ ok: false, msg: e.message });
        }
    });
}

// ── Chart data (cumulative P&L from activity) ──────────────────────────────
async function getChartData(env) {
    const activity = await getActivity(env);
    if (!activity.length) return [];

    // Build cumulative P&L, newest first → reverse to chronological
    const reversed = [...activity].reverse();
    let cum = 0;
    const points = [];

    for (const a of reversed) {
        if (a.type === "REDEEM") cum += parseFloat(a.usdcAmount || a.shares || 0);
        if (a.type === "TRADE" && a.side === "BUY") cum -= parseFloat(a.usdcAmount || 0);
        points.push({
            time: a.timestamp,
            value: Math.round(cum * 100) / 100,
            type: a.type,
            title: (a.title || "").substring(0, 40),
        });
    }
    return points;
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
        const data = await httpGet("data-api.polymarket.com",
            `/activity?user=${funder}&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`);
        if (!Array.isArray(data)) return [];
        return data.map(a => ({
            type: a.type,
            title: a.title,
            side: a.side,
            outcome: a.outcome,
            outcomeIndex: a.outcomeIndex,
            shares: a.size,                         // "size" not "shares"
            usdcAmount: a.usdcSize,                  // "usdcSize" not "usdcAmount"
            price: a.price,                          // already in USD
            timestamp: a.timestamp * 1000,            // epoch SECONDS → ms
        }));
    } catch { return []; }
}

async function getBalance(env) {
    // No direct balance API — compute from activity + known deposit
    try {
        const activity = await getActivity(env);
        const chrono = [...activity].reverse(); // oldest first
        let bal = 0;
        for (const a of chrono) {
            if (a.type === "REDEEM") bal += a.usdcAmount || 0;
            if (a.type === "TRADE" && a.side === "BUY") bal -= a.usdcAmount || 0;
            if (a.type === "TRADE" && a.side === "SELL") bal += a.usdcAmount || 0;
        }
        // Add initial deposit (not in activity API — hardcoded for now)
        const initialDeposit = parseFloat(env.PM_INITIAL_DEPOSIT || "0");
        return { pnl: Math.round(bal * 100) / 100, total: Math.round((bal + initialDeposit) * 100) / 100, initialDeposit };
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

    // Enrich orders with results from activity (match by bucket time)
    const enrichedOrders = orders.map(order => {
        const bucketTime = order.bucket?.match(/(\d+:\d+[AP]M-\d+:\d+[AP]M)/)?.[1] || "";
        // Find matching activity: REDEEM = win, TRADE with usdcSize≈0 = loss
        const result = activity.find(a => {
            const aTime = a.title?.match(/(\d+:\d+[AP]M-\d+:\d+[AP]M)/)?.[1] || "";
            return aTime === bucketTime && (a.type === "REDEEM" || (a.type === "TRADE" && !a.usdcAmount));
        });
        return {
            ...order,
            result: result ? {
                type: result.type === "REDEEM" ? "GANANCIA" : "PÉRDIDA",
                amount: result.usdcAmount || -(order.making || 1),
                net: (result.usdcAmount || 0) - (order.making || 0),
            } : null, // pending — still open
        };
    });

    jsonReply(res, { bot, orders: enrichedOrders, activity, balance, market });
}

async function apiChart(res, env) {
    const data = await getChartData(env);
    jsonReply(res, data);
}

async function apiBotStart(res) {
    const r = await startBot();
    jsonReply(res, r, r.ok ? 200 : 409);
}

async function apiBotStop(res) {
    const r = await stopBot();
    jsonReply(res, r);
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
            case "/api/chart":    return await apiChart(res, env);
            case "/api/bot/start": return await apiBotStart(res);
            case "/api/bot/stop":  return await apiBotStop(res);

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
