import http from "http";
import https from "https";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "5173", 10);
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function corsOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return "";
  if (origin === "null") return "null";
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return "";
    if (u.port !== String(PORT)) return "";
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return "";
    return origin;
  } catch {
    return "";
  }
}

function setCors(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

async function readRequestBody(req, limitBytes) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        req.destroy();
        reject(new Error("Request body too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request aborted.")));
  });
}

function decodeBase64(base64Input) {
  const cleaned = String(base64Input || "").replace(/\s+/g, "");
  if (!cleaned) return Buffer.alloc(0);
  return Buffer.from(cleaned, "base64");
}

async function fetchWithClientCert(endpoint, pfx, passphrase) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Endpoint must be https://");

  const options = {
    method: "GET",
    hostname: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 443,
    path: `${url.pathname}${url.search}`,
    headers: {
      Accept: "application/xml,text/xml,application/xhtml+xml,text/plain,*/*",
      "User-Agent": "mobilithek-to-csv-local/1.0",
    },
    pfx,
    passphrase,
  };

  return await new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        let body = Buffer.concat(chunks);
        const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
        try {
          if (encoding.includes("gzip")) body = zlib.gunzipSync(body);
          else if (encoding.includes("deflate")) body = zlib.inflateSync(body);
        } catch (e) {
          reject(new Error(`Failed to decompress upstream response (${encoding || "unknown"}).`));
          return;
        }
        resolve({
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          headers: response.headers,
          body,
        });
      });
    });

    request.on("error", reject);
    request.end();
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  const relPath = pathname.replace(/^\/+/, "");
  const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(__dirname, safePath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request.");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": contentTypes.get(ext) || "application/octet-stream",
      "Content-Length": String(data.length),
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (url.pathname === "/api/fetch") {
      setCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed." });
        return;
      }

      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.toLowerCase().includes("application/json")) {
        sendJson(res, 415, { error: "Content-Type must be application/json." });
        return;
      }

      const body = await readRequestBody(req, MAX_BODY_BYTES);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "Invalid JSON." });
        return;
      }

      const endpoint = String(payload.endpoint || "").trim();
      const p12Base64 = String(payload.p12Base64 || "").trim();
      const passphrase = String(payload.passphrase || "");

      if (!endpoint) {
        sendJson(res, 400, { error: "Missing endpoint." });
        return;
      }
      if (!endpoint.startsWith("https://")) {
        sendJson(res, 400, { error: "Endpoint must start with https://." });
        return;
      }
      if (!p12Base64) {
        sendJson(res, 400, { error: "Missing p12Base64." });
        return;
      }

      const pfx = decodeBase64(p12Base64);
      if (pfx.length === 0) {
        sendJson(res, 400, { error: "Invalid certificate (empty after base64 decode)." });
        return;
      }

      const upstream = await fetchWithClientCert(endpoint, pfx, passphrase);
      const text = upstream.body.toString("utf8");

      sendJson(res, 200, {
        ok: upstream.status >= 200 && upstream.status < 300,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        contentType: upstream.headers["content-type"] || "",
        text,
      });
      return;
    }

    await serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: e && e.message ? e.message : "Internal error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running: http://${HOST}:${PORT}`);
  console.log("Open it in your browser, then use the .p12 + passphrase to fetch via /api/fetch.");
});
