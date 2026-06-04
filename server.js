/**
 * DeoLib Key Server
 * -----------------
 * GET  /whitelist?HWID=          → portal page
 * POST /api/register             { hwid, username } → register + return key
 * GET  /api/key?hwid=            → get key for HWID
 * GET  /api/validate?hwid=&key=  → { valid: true/false } called by Lua
 *
 * Data is stored on a Railway persistent volume mounted at /data
 * Set DATA_DIR env var if deploying elsewhere (default: /data, fallback: ./data)
 */

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR
    || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const DATA_FILE = path.join(DATA_DIR, "keys.json");
const HTML_FILE = path.join(__dirname, "public", "index.html");

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── KEY FORMULA — must match Lua exactly ─────────────────────
function generateKey(userId) {
    const n = BigInt(userId);
    return userId + "-" + ((n / 7n) + 42n).toString();
}

// ── DATA ──────────────────────────────────────────────────────
function loadKeys() {
    try {
        if (!fs.existsSync(DATA_FILE)) return {};
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch { return {}; }
}

function saveKeys(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── ROBLOX USERNAME → ID ──────────────────────────────────────
function robloxLookup(username) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ usernames: [username], excludeBannedUsers: false });
        const req  = https.request({
            hostname: "users.roblox.com",
            path:     "/v1/usernames/users",
            method:   "POST",
            headers: {
                "Content-Type":   "application/json",
                "Content-Length": Buffer.byteLength(body)
            }
        }, res => {
            let raw = "";
            res.on("data", d => raw += d);
            res.on("end", () => {
                try {
                    const data = JSON.parse(raw);
                    if (!data.data || data.data.length === 0)
                        return reject(new Error("User not found"));
                    resolve({ id: data.data[0].id.toString(), name: data.data[0].name });
                } catch { reject(new Error("Roblox API error")); }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ── HELPERS ───────────────────────────────────────────────────
function setCORS(res) {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, data) {
    setCORS(res);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data",  c => body += c);
        req.on("end",   () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
        req.on("error", reject);
    });
}

// ── SERVER ────────────────────────────────────────────────────
http.createServer(async (req, res) => {
    const parsed   = url.parse(req.url, true);
    const pathname = parsed.pathname.replace(/\/$/, "") || "/";
    const query    = parsed.query;

    if (req.method === "OPTIONS") {
        setCORS(res); res.writeHead(204); res.end(); return;
    }

    // Portal page
    if (req.method === "GET" && (pathname === "/" || pathname === "/whitelist")) {
        try {
            const html = fs.readFileSync(HTML_FILE, "utf8");
            setCORS(res);
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
        } catch {
            res.writeHead(500); res.end("Portal page missing");
        }
        return;
    }

    // POST /api/register
    if (req.method === "POST" && pathname === "/api/register") {
        const body     = await readBody(req);
        const hwid     = (body.hwid     || "").trim();
        const username = (body.username || "").trim();

        if (!hwid)     return json(res, 400, { error: "Missing hwid" });
        if (!username) return json(res, 400, { error: "Missing username" });

        let userId, displayName;
        try {
            const r = await robloxLookup(username);
            userId      = r.id;
            displayName = r.name;
        } catch (e) {
            return json(res, 404, { error: e.message });
        }

        const keys = loadKeys();

        if (keys[hwid]) {
            return json(res, 200, {
                key:      keys[hwid].key,
                userId:   keys[hwid].userId,
                username: keys[hwid].username,
                existing: true
            });
        }

        const key  = generateKey(userId);
        keys[hwid] = { key, userId, username: displayName, hwid, registeredAt: new Date().toISOString() };
        saveKeys(keys);

        console.log(`[+] ${displayName} (${userId}) HWID:${hwid.slice(0,12)}...`);
        return json(res, 200, { key, userId, username: displayName, existing: false });
    }

    // GET /api/key?hwid=
    if (req.method === "GET" && pathname === "/api/key") {
        const hwid  = (query.hwid || "").trim();
        if (!hwid)  return json(res, 400, { error: "Missing hwid" });
        const entry = loadKeys()[hwid];
        if (!entry) return json(res, 404, { error: "HWID not registered" });
        return json(res, 200, { key: entry.key, userId: entry.userId, username: entry.username });
    }

    // GET /api/validate?hwid=&key=
    if (req.method === "GET" && pathname === "/api/validate") {
        const hwid = (query.hwid || "").trim();
        const key  = (query.key  || "").trim();
        if (!hwid || !key) return json(res, 400, { error: "Missing params" });
        const entry = loadKeys()[hwid];
        const valid = !!(entry && entry.key === key);
        return json(res, 200, { valid, userId: valid ? entry.userId : null });
    }

    json(res, 404, { error: "Not found" });

}).listen(PORT, () => {
    console.log(`[DeoLib] Running on port ${PORT}`);
    console.log(`[DeoLib] Data:   ${DATA_FILE}`);
    console.log(`[DeoLib] Portal: http://localhost:${PORT}/whitelist`);
});
