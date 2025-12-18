function setStatus(message, { error = false } = {}) {
  const el = document.getElementById("status");
  el.textContent = message || "";
  el.classList.toggle("error", Boolean(error));
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("Unexpected file reader result"));
      const commaIdx = result.indexOf(",");
      if (commaIdx === -1) return reject(new Error("Invalid data URL"));
      resolve(result.slice(commaIdx + 1));
    };
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeFileName(value) {
  const base = String(value || "file").trim() || "file";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 180) || "file";
}

function bytesToHex(bytes, max = 16) {
  const slice = bytes.subarray(0, Math.min(bytes.length, max));
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function looksGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function looksZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function looksLikeText(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
  if (sample.length === 0) return false;
  let controlish = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x09) controlish++;
    else if (b > 0x0d && b < 0x20) controlish++;
  }
  return controlish / sample.length < 0.05;
}

function describeBytes(bytes) {
  if (looksGzip(bytes)) return { ext: "gz", mime: "application/gzip", isText: false };
  if (looksZip(bytes)) return { ext: "zip", mime: "application/zip", isText: false };
  const isText = looksLikeText(bytes);
  if (!isText) return { ext: "bin", mime: "application/octet-stream", isText: false };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).trimStart();
  if (text.startsWith("<?xml") || text.startsWith("<")) return { ext: "xml", mime: "application/xml", isText: true };
  if (text.includes("\n") && (text.includes(",") || text.includes(";"))) return { ext: "csv", mime: "text/csv", isText: true };
  return { ext: "txt", mime: "text/plain", isText: true };
}

function makePreview(bytes) {
  const info = describeBytes(bytes);
  if (!info.isText) {
    return `Binary preview (hex): ${bytesToHex(bytes, 64)}${bytes.length > 64 ? "…" : ""}`;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 48 * 1024)));
  const maxChars = 4000;
  const trimmed = text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
  return trimmed;
}

function base64ToBytes(base64Input) {
  let base64 = String(base64Input || "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!base64) return new Uint8Array();
  const mod = base64.length % 4;
  if (mod) base64 += "=".repeat(4 - mod);

  const chunkSize = 32768; // must be a multiple of 4
  const parts = [];
  let total = 0;
  for (let i = 0; i < base64.length; i += chunkSize) {
    const chunk = base64.slice(i, i + chunkSize);
    const bin = atob(chunk);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    parts.push(bytes);
    total += bytes.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function gunzipBytes(bytes) {
  if (!looksGzip(bytes)) return null;
  if (!("DecompressionStream" in window)) {
    throw new Error("This browser cannot gunzip (DecompressionStream not supported).");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function triggerDownload(filename, bytes, mime) {
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function extractBinaryItems(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error("Invalid XML (parser error).");
  }

  const binaries = Array.from(doc.getElementsByTagNameNS("*", "binary"));
  return binaries.map((el, index) => {
    const id = el.getAttribute("id") || `binary-${index + 1}`;
    const type = el.getAttribute("type") || "binary";
    const base64 = (el.textContent || "").trim().replace(/\s+/g, "");
    return { index, id, type, base64 };
  });
}

async function decodeXmlToItems(xmlText) {
  const bins = extractBinaryItems(xmlText);
  const out = [];
  for (const bin of bins) {
    if (!bin.base64) {
      out.push({ ...bin, error: "Empty <binary> content." });
      continue;
    }
    try {
      const rawBytes = base64ToBytes(bin.base64);
      const rawInfo = describeBytes(rawBytes);

      let gunzippedBytes = null;
      let gunzipError = null;
      if (looksGzip(rawBytes)) {
        try {
          gunzippedBytes = await gunzipBytes(rawBytes);
        } catch (e) {
          gunzipError = e && e.message ? e.message : "Failed to gunzip.";
        }
      }

      const decodedBytes = gunzippedBytes || rawBytes;
      const decodedInfo = describeBytes(decodedBytes);

      const baseName = safeFileName(`${bin.id}_${bin.type}`);
      const rawFilename = `${baseName}.${rawInfo.ext}`;
      const decodedFilename = `${baseName}.${decodedInfo.ext}`;

      out.push({
        ...bin,
        wasGunzipped: Boolean(gunzippedBytes),
        rawBytes,
        rawInfo,
        decodedBytes,
        decodedInfo,
        rawFilename,
        decodedFilename,
        gunzipError,
        preview: makePreview(decodedBytes),
      });
    } catch (e) {
      out.push({ ...bin, error: e && e.message ? e.message : "Failed to decode." });
    }
  }
  return out;
}

function renderResults(items) {
  const results = document.getElementById("results");
  results.innerHTML = "";

  if (items.length === 0) {
    results.innerHTML = `<div class="muted">No &lt;binary&gt; blocks found in the response.</div>`;
    return;
  }

  for (const item of items) {
    const title = `${item.id || "(no id)"} (${item.type || "binary"})`;
    const preview = item.preview ? `<pre class="preview">${escapeHtml(item.preview)}</pre>` : "";
    const error = item.error ? `<div class="muted" style="color: var(--danger); font-weight: 700;">${escapeHtml(item.error)}</div>` : "";
    const gunzipNote = item.gunzipError
      ? `<div class="muted small" style="color: var(--danger);">${escapeHtml(item.gunzipError)} (download raw instead)</div>`
      : "";

    const downloads = `
      <div class="downloads">
        <button class="btn" data-action="download-raw">Download base64-decoded</button>
        ${
          item.wasGunzipped && !item.error
            ? `<button class="btn primary" data-action="download-decoded">Download gunzipped</button>`
            : ""
        }
      </div>
    `;

    const card = document.createElement("div");
    card.className = "result";
    const base64Meta = `<div><code>base64-decoded</code>: ${escapeHtml(String(item.rawBytes ? item.rawBytes.length : 0))} bytes · ${escapeHtml(item.rawInfo ? item.rawInfo.mime : "application/octet-stream")} · .${escapeHtml(item.rawInfo ? item.rawInfo.ext : "bin")}</div>`;
    const gunzipMeta = item.wasGunzipped
      ? `<div><code>gunzipped</code>: ${escapeHtml(String(item.decodedBytes ? item.decodedBytes.length : 0))} bytes · ${escapeHtml(item.decodedInfo ? item.decodedInfo.mime : "application/octet-stream")} · .${escapeHtml(item.decodedInfo ? item.decodedInfo.ext : "bin")}</div>`
      : item.gunzipError
        ? `<div><code>gunzip</code>: failed</div>`
        : "";

    card.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      <div class="meta">
        ${base64Meta}
        ${gunzipMeta}
      </div>
      ${downloads}
      ${gunzipNote}
      ${error}
      ${preview}
    `;
    const rawBtn = card.querySelector('[data-action="download-raw"]');
    const decodedBtn = card.querySelector('[data-action="download-decoded"]');

    if (rawBtn) {
      rawBtn.disabled = !item.rawBytes || item.rawBytes.length === 0;
      rawBtn.addEventListener("click", () => {
        triggerDownload(item.rawFilename || "raw.bin", item.rawBytes, item.rawInfo ? item.rawInfo.mime : undefined);
      });
    }
    if (decodedBtn) {
      decodedBtn.disabled = !item.decodedBytes || item.decodedBytes.length === 0 || Boolean(item.error);
      decodedBtn.addEventListener("click", () => {
        triggerDownload(
          item.decodedFilename || "decoded.bin",
          item.decodedBytes,
          item.decodedInfo ? item.decodedInfo.mime : undefined,
        );
      });
    }
    results.appendChild(card);
  }
}

function setXmlText(value) {
  document.getElementById("xmlText").value = value || "";
}

function getXmlText() {
  return document.getElementById("xmlText").value || "";
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

function helperServerBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = (params.get("helper") || "").trim();
  if (fromQuery) return fromQuery.replace(/\/+$/, "");
  if (window.location.protocol === "file:") return "http://127.0.0.1:5173";
  return window.location.origin;
}

async function tryFetchViaHelperServer(endpoint, p12File, passphrase) {
  const baseUrl = helperServerBaseUrl();
  const apiUrl = `${baseUrl}/api/fetch`;

  setStatus(`Reading certificate…`);
  const p12Base64 = await fileToBase64(p12File);

  setStatus(`Fetching via helper server (${baseUrl})…`);
  let res;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, p12Base64, passphrase }),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach helper server at ${baseUrl}. Start it with “ruby server.rb” (no Node needed) or “node server.mjs” (requires Node.js), or open the page with ?helper=http://127.0.0.1:5173`,
    );
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Helper server returned non-JSON (${res.status}). Is it running at ${baseUrl}?`);
  }

  if (!res.ok) {
    throw new Error(json && json.error ? json.error : `Helper server error (${res.status}).`);
  }

  if (!json.ok) {
    const snippet = typeof json.text === "string" ? json.text.slice(0, 220).replace(/\s+/g, " ").trim() : "";
    throw new Error(
      `Mobilithek returned ${json.upstreamStatus} ${json.upstreamStatusText || ""}.${snippet ? ` Response: ${snippet}` : ""}`,
    );
  }

  if (typeof json.text !== "string") throw new Error("Helper server did not return response text.");
  return json.text;
}

async function tryFetchEndpoint() {
  const endpoint = (document.getElementById("endpoint").value || "").trim();
  if (!endpoint) throw new Error("Endpoint is required.");
  if (!endpoint.startsWith("https://")) throw new Error("Endpoint must start with https://");

  const p12File = document.getElementById("p12").files && document.getElementById("p12").files[0];
  const passphrase = document.getElementById("passphrase").value || "";

  if (p12File) {
    return await tryFetchViaHelperServer(endpoint, p12File, passphrase);
  }

  setStatus("Fetching (browser)…");
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/xml,text/xml,application/xhtml+xml,text/plain,*/*" },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = text && text.length < 400 ? ` Response: ${text}` : "";
      throw new Error(`Fetch failed (${res.status} ${res.statusText}).${hint}`);
    }
    return text;
  } catch (e) {
    let endpointOrigin = "";
    try {
      endpointOrigin = new URL(endpoint).origin;
    } catch {
      endpointOrigin = "(invalid url)";
    }
    const pageOrigin = window.location.origin;
    const crossOrigin = endpointOrigin && pageOrigin && endpointOrigin !== pageOrigin;
    const fileOrigin = window.location.protocol === "file:";

    const details = [];
    if (crossOrigin) details.push(`Cross-origin request (${pageOrigin} → ${endpointOrigin}).`);
    if (fileOrigin) details.push("Running from file:// (origin is 'null').");
    details.push("If the endpoint works in a normal tab but not here, it's almost certainly CORS.");
    details.push("Use “Open endpoint in new tab”, then save/copy the XML and paste/upload it here.");

    const base = e && e.message ? e.message : "Failed to fetch.";
    throw new Error(`${base} ${details.join(" ")}`);
  }
}

async function decodeAndRender(xmlText) {
  const normalized = String(xmlText || "").trim();
  if (!normalized) {
    setStatus("Paste or load an XML response first.", { error: true });
    renderResults([]);
    return;
  }
  setStatus("Extracting <binary> blocks…");
  const items = await decodeXmlToItems(normalized);
  setStatus(`Found ${items.length} binary item(s).`);
  renderResults(items);
}

function downloadResponseXml() {
  const xmlText = getXmlText().trim();
  if (!xmlText) {
    setStatus("Nothing to download (response is empty).", { error: true });
    return;
  }
  triggerDownload("response.xml", new TextEncoder().encode(xmlText), "application/xml");
}

document.getElementById("fetch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("");
  try {
    const xml = await tryFetchEndpoint();
    setXmlText(xml);
    await decodeAndRender(xml);
  } catch (err) {
    const msg = err && err.message ? err.message : "Failed to fetch.";
    setStatus(msg, { error: true });
  }
});

document.getElementById("open").addEventListener("click", () => {
  const endpoint = (document.getElementById("endpoint").value || "").trim();
  if (!endpoint) {
    setStatus("Endpoint is required.", { error: true });
    return;
  }
  window.open(endpoint, "_blank", "noopener,noreferrer");
});

document.getElementById("clear").addEventListener("click", () => {
  document.getElementById("fetch-form").reset();
  setXmlText("");
  setStatus("");
  renderResults([]);
});

document.getElementById("xmlFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  setStatus("Reading response file…");
  try {
    const text = await readFileAsText(file);
    setXmlText(text);
    setStatus("Loaded file. Ready to decode.");
  } catch (err) {
    setStatus(err && err.message ? err.message : "Failed to read file.", { error: true });
  }
});

document.getElementById("decode").addEventListener("click", async () => {
  setStatus("");
  await decodeAndRender(getXmlText());
});

document.getElementById("downloadResponse").addEventListener("click", downloadResponseXml);
