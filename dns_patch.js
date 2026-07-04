/**
 * DNS patch for Polymarket (Argentina ISP block) — Node.js v24+
 *
 * Patches https.request AND https.get to replace Polymarket hostnames
 * with hardcoded Cloudflare IPs. Handles both string URLs and options objects.
 *
 * USAGE:
 *   require('./dns_patch');
 *   // Now all https/http requests to polymarket domains go through IP 104.18.34.205
 *
 * IMPORTANT: This must be loaded BEFORE any other module that makes HTTP requests
 * (including @polymarket/client, axios, etc.).
 *
 * WHY NOT dns.lookup? Node v24's dns.lookup callback returns the IP correctly but
 * the internal TCP stack loses the reference and throws "Invalid IP address: undefined".
 * Patching the request options to use the IP directly bypasses DNS entirely.
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");

const PM_HOSTS = [
    "clob.polymarket.com",
    "gamma-api.polymarket.com",
    "data-api.polymarket.com",
    "relayer-v2.polymarket.com",
    "polymarket.com",
];
const PM_IP = "104.18.34.205";

function patchHost(opts) {
    let options;

    // Handle string URLs (used by https.get, fetch polyfills, etc.)
    if (typeof opts === "string" || opts instanceof URL) {
        const u = typeof opts === "string" ? new URL(opts) : opts;
        options = {
            protocol: u.protocol,
            host: u.hostname,
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search,
        };
    } else if (opts && typeof opts === "object") {
        options = { ...opts };
    } else {
        // Can't patch — pass through
        return undefined;
    }

    const hostname = options.hostname || options.host || "";
    if (PM_HOSTS.includes(hostname)) {
        options = {
            ...options,
            host: PM_IP,           // MUST use 'host' (not just 'hostname') — hostname-only causes timeouts
            hostname: PM_IP,
            servername: hostname,   // TLS SNI — Cloudflare needs the original domain
            headers: {
                ...(options.headers || {}),
                Host: hostname,     // Cloudflare requires the Host header
            },
        };
    }

    return options;
}

function patchModule(mod) {
    const origRequest = mod.request;
    const origGet = mod.get;

    // Patch request
    mod.request = function (opts, ...args) {
        const patched = patchHost(opts);
        if (patched === undefined) {
            return origRequest.call(mod, opts, ...args);
        }
        return origRequest.call(mod, patched, ...args);
    };

    // Patch get — MUST use origGet (NOT mod.request) so req.end() is called
    if (origGet) {
        mod.get = function (opts, ...args) {
            const patched = patchHost(opts);
            if (patched === undefined) {
                return origGet.call(mod, opts, ...args);
            }
            return origGet.call(mod, patched, ...args);
        };
    }
}

patchModule(https);
patchModule(http);

module.exports = { PM_HOSTS, PM_IP };
