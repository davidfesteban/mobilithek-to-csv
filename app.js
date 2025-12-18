function setStatus(message, { error = false } = {}) {
  const el = document.getElementById("status");
  el.textContent = message || "";
  el.classList.toggle("error", Boolean(error));
}

let lastDecodedItems = [];
let lastResponseXml = "";

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

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

function rowsToCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const lines = [header];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function downloadCsv(filename, rows, columns) {
  const csv = rowsToCsv(rows, columns);
  triggerDownload(filename, new TextEncoder().encode(csv), "text/csv");
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

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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

function tryParseXmlText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return null;
  if (!normalized.startsWith("<") && !normalized.startsWith("<?xml")) return null;

  const parser = new DOMParser();
  const doc = parser.parseFromString(normalized, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) return null;
  return doc;
}

function getText(el) {
  if (!el) return "";
  return (el.textContent || "").trim();
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function extractFuelPricePublication(doc, { binaryId }) {
  const root = doc.documentElement;
  const extensionName = root ? root.getAttribute("extensionName") || "" : "";

  const payloads = Array.from(doc.getElementsByTagNameNS("*", "payloadPublication"));
  const isFuelPrice =
    extensionName === "FuelPricePublication" ||
    payloads.some((p) => (p.getAttribute("xsi:type") || "").includes("FuelPricePublication"));
  if (!isFuelPrice) return null;

  const fuelRows = [];
  const overrideRows = [];

  for (const payload of payloads) {
    const publicationId = payload.getAttribute("id") || "";
    const publicationType = payload.getAttribute("xsi:type") || extensionName || "";

    const stationInfos = Array.from(payload.getElementsByTagNameNS("*", "petrolStationInformation"));
    for (const info of stationInfos) {
      const stationRef = info.getElementsByTagNameNS("*", "petrolStationReference")[0] || null;
      const stationId = stationRef ? stationRef.getAttribute("id") || "" : "";
      const stationVersion = stationRef ? stationRef.getAttribute("version") || "" : "";

      for (const child of Array.from(info.children || [])) {
        const local = child.localName || "";
        if (!local.startsWith("fuelPrice")) continue;
        const fuel = local.replace(/^fuelPrice/, "") || "Unknown";
        const price = getText(child.getElementsByTagNameNS("*", "price")[0]);
        const dateOfPrice = getText(child.getElementsByTagNameNS("*", "dateOfPrice")[0]);
        if (!price && !dateOfPrice) continue;

        fuelRows.push({
          station_id: stationId,
          station_version: stationVersion,
          fuel,
          price,
          date_of_price: dateOfPrice,
          publication_id: publicationId,
          publication_type: publicationType,
          binary_id: binaryId,
        });
      }

      const overrides = Array.from(info.getElementsByTagNameNS("*", "overrideOpen"));
      for (const ov of overrides) {
        const startOfPeriod = getText(ov.getElementsByTagNameNS("*", "startOfPeriod")[0]);
        const endOfPeriod = getText(ov.getElementsByTagNameNS("*", "endOfPeriod")[0]);
        if (!startOfPeriod && !endOfPeriod) continue;
        overrideRows.push({
          station_id: stationId,
          station_version: stationVersion,
          start_of_period: startOfPeriod,
          end_of_period: endOfPeriod,
          publication_id: publicationId,
          publication_type: publicationType,
          binary_id: binaryId,
        });
      }
    }
  }

  return { fuelRows, overrideRows };
}

function wideFuelRowsForStation(rows) {
  const fuels = Array.from(new Set(rows.map((r) => r.fuel))).filter(Boolean).sort();
  const byDate = groupBy(rows, (r) => r.date_of_price || "");
  const dates = Array.from(byDate.keys()).filter(Boolean).sort();

  const out = [];
  for (const date of dates) {
    const row = { date_of_price: date };
    for (const fuel of fuels) row[fuel] = "";
    for (const r of byDate.get(date) || []) row[r.fuel] = r.price;
    out.push(row);
  }

  return { fuels, rows: out };
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

function renderRawBinaries(items, targetEl) {
  const results = targetEl || document.getElementById("rawResults") || document.getElementById("results");
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

function renderTimeSeriesFromItems(items) {
  const results = document.getElementById("results");
  results.innerHTML = "";

  if (!items || items.length === 0) {
    return { fuelRows: 0, overrideRows: 0, parsedXmlBinaries: 0, fuelBinaries: 0 };
  }

  const fuelRows = [];
  const overrideRows = [];
  let parsedXmlBinaries = 0;
  let fuelBinaries = 0;

  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (const item of items) {
    if (item.error) continue;
    if (!item.decodedBytes || !item.decodedInfo || item.decodedInfo.ext !== "xml") continue;

    const text = decoder.decode(item.decodedBytes);
    const doc = tryParseXmlText(text);
    if (!doc) continue;
    parsedXmlBinaries++;

    const extracted = extractFuelPricePublication(doc, { binaryId: item.id || String(item.index + 1) });
    if (!extracted) continue;
    fuelBinaries++;
    fuelRows.push(...extracted.fuelRows);
    overrideRows.push(...extracted.overrideRows);
  }

  const hasFuel = fuelRows.length > 0;
  const hasOverrides = overrideRows.length > 0;

  if (!hasFuel && !hasOverrides) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = `No FuelPricePublication records extracted (parsed XML binaries: ${parsedXmlBinaries}/${items.length}). Showing raw binaries below.`;
    results.appendChild(empty);

    const rawDetails = document.createElement("details");
    rawDetails.className = "details";
    rawDetails.open = false;
    rawDetails.innerHTML = `<summary>Raw binaries (${items.length})</summary><div id="rawResults" class="results"></div>`;
    results.appendChild(rawDetails);
    renderRawBinaries(items, rawDetails.querySelector("#rawResults"));
    return { fuelRows: 0, overrideRows: 0, parsedXmlBinaries, fuelBinaries };
  }

  if (hasFuel) {
    const byStation = groupBy(fuelRows, (r) => r.station_id || "(missing station_id)");
    const stations = Array.from(byStation.keys()).sort();

    const card = document.createElement("div");
    card.className = "result";
    card.innerHTML = `
      <h3>Fuel prices (time series)</h3>
      <div class="meta">
        <div><code>rows</code>: ${fuelRows.length}</div>
        <div><code>stations</code>: ${stations.length}</div>
      </div>
      <div class="downloads">
        <button class="btn primary" data-action="download-fuel-all">Download all (long CSV)</button>
      </div>
      <div class="field">
        <label for="fuelFilter">Filter station id</label>
        <input id="fuelFilter" type="text" spellcheck="false" placeholder="Type to filter…">
      </div>
      <div class="table-wrap"><table class="table" data-kind="fuel">
        <thead><tr>
          <th>Station id</th>
          <th>Rows</th>
          <th>Date range</th>
          <th>Fuels</th>
          <th>Download</th>
        </tr></thead>
        <tbody></tbody>
      </table></div>
      <details class="details" data-kind="preview">
        <summary>Preview station (wide table)</summary>
        <div class="field">
          <label for="fuelPreviewStation">Station id</label>
          <input id="fuelPreviewStation" type="text" spellcheck="false" placeholder="Click a station above or paste id…">
        </div>
        <div class="table-wrap"><table class="table" data-kind="fuel-preview">
          <thead></thead>
          <tbody></tbody>
        </table></div>
        <p class="muted small" data-kind="fuel-preview-hint"></p>
      </details>
    `;

    const downloadAll = card.querySelector('[data-action="download-fuel-all"]');
    downloadAll.addEventListener("click", () => {
      const sorted = [...fuelRows].sort((a, b) => String(a.date_of_price).localeCompare(String(b.date_of_price)));
      downloadCsv("fuel_prices_long.csv", sorted, [
        "station_id",
        "station_version",
        "fuel",
        "price",
        "date_of_price",
        "publication_id",
        "publication_type",
        "binary_id",
      ]);
    });

    const tbody = card.querySelector('table[data-kind="fuel"] tbody');
    const filterInput = card.querySelector("#fuelFilter");
    const previewDetails = card.querySelector('details[data-kind="preview"]');
    const previewInput = card.querySelector("#fuelPreviewStation");
    const previewThead = card.querySelector('table[data-kind="fuel-preview"] thead');
    const previewTbody = card.querySelector('table[data-kind="fuel-preview"] tbody');
    const previewHint = card.querySelector('[data-kind="fuel-preview-hint"]');

    const renderPreview = () => {
      const stationId = (previewInput.value || "").trim();
      previewThead.innerHTML = "";
      previewTbody.innerHTML = "";
      previewHint.textContent = "";

      if (!stationId) return;
      const rows = byStation.get(stationId);
      if (!rows || rows.length === 0) {
        previewHint.textContent = "No rows found for this station id.";
        return;
      }

      const { fuels: fuelCols, rows: wideRows } = wideFuelRowsForStation(rows);
      const cols = ["date_of_price", ...fuelCols];

      const trHead = document.createElement("tr");
      for (const col of cols) {
        const th = document.createElement("th");
        th.textContent = col;
        trHead.appendChild(th);
      }
      previewThead.appendChild(trHead);

      const limit = 50;
      const shown = wideRows.slice(0, limit);
      for (const r of shown) {
        const tr = document.createElement("tr");
        for (const col of cols) {
          const td = document.createElement("td");
          td.textContent = r[col] || "";
          tr.appendChild(td);
        }
        previewTbody.appendChild(tr);
      }
      previewHint.textContent = wideRows.length > limit ? `Showing first ${limit} row(s) of ${wideRows.length}.` : "";
    };

    const renderTable = () => {
      const q = (filterInput.value || "").trim().toLowerCase();
      tbody.innerHTML = "";

      for (const stationId of stations) {
        if (q && !stationId.toLowerCase().includes(q)) continue;
        const rows = byStation.get(stationId) || [];
        const fuels = Array.from(new Set(rows.map((r) => r.fuel))).filter(Boolean).sort();
        const dates = rows.map((r) => r.date_of_price).filter(Boolean).sort();
        const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "—";

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="clickable"><code>${escapeHtml(stationId)}</code></td>
          <td>${rows.length}</td>
          <td>${escapeHtml(range)}</td>
          <td>${escapeHtml(fuels.join(", "))}</td>
          <td class="actions-cell">
            <button class="btn" data-action="dl-long">CSV (long)</button>
            <button class="btn" data-action="dl-wide">CSV (wide)</button>
          </td>
        `;

        tr.querySelector("td.clickable").addEventListener("click", () => {
          previewInput.value = stationId;
          previewDetails.open = true;
          renderPreview();
        });

        tr.querySelector('[data-action="dl-long"]').addEventListener("click", () => {
          const sorted = [...rows].sort((a, b) => String(a.date_of_price).localeCompare(String(b.date_of_price)));
          downloadCsv(`fuel_prices_${safeFileName(stationId)}_long.csv`, sorted, [
            "station_id",
            "station_version",
            "fuel",
            "price",
            "date_of_price",
            "publication_id",
            "publication_type",
            "binary_id",
          ]);
        });

        tr.querySelector('[data-action="dl-wide"]').addEventListener("click", () => {
          const { fuels: fuelCols, rows: wideRows } = wideFuelRowsForStation(rows);
          const cols = ["date_of_price", ...fuelCols];
          downloadCsv(`fuel_prices_${safeFileName(stationId)}_wide.csv`, wideRows, cols);
        });

        tbody.appendChild(tr);
      }
    };

    filterInput.addEventListener("input", renderTable);
    previewInput.addEventListener("input", renderPreview);
    renderTable();

    results.appendChild(card);
  }

  if (hasOverrides) {
    const byStation = groupBy(overrideRows, (r) => r.station_id || "(missing station_id)");
    const stations = Array.from(byStation.keys()).sort();

    const card = document.createElement("div");
    card.className = "result";
    card.innerHTML = `
      <h3>Override open periods</h3>
      <div class="meta">
        <div><code>rows</code>: ${overrideRows.length}</div>
        <div><code>stations</code>: ${stations.length}</div>
      </div>
      <div class="downloads">
        <button class="btn primary" data-action="download-ov-all">Download all (CSV)</button>
      </div>
    `;
    card.querySelector('[data-action="download-ov-all"]').addEventListener("click", () => {
      const sorted = [...overrideRows].sort((a, b) => String(a.start_of_period).localeCompare(String(b.start_of_period)));
      downloadCsv("override_open.csv", sorted, [
        "station_id",
        "station_version",
        "start_of_period",
        "end_of_period",
        "publication_id",
        "publication_type",
        "binary_id",
      ]);
    });

    results.appendChild(card);
  }

  const rawDetails = document.createElement("details");
  rawDetails.className = "details";
  rawDetails.open = false;
  rawDetails.innerHTML = `<summary>Raw binaries (${items.length})</summary><div id="rawResults" class="results"></div>`;
  results.appendChild(rawDetails);
  renderRawBinaries(items, rawDetails.querySelector("#rawResults"));

  return { fuelRows: fuelRows.length, overrideRows: overrideRows.length, parsedXmlBinaries, fuelBinaries };
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
    renderTimeSeriesFromItems([]);
    return;
  }
  setStatus("Extracting <binary> blocks…");
  const items = await decodeXmlToItems(normalized);
  lastResponseXml = normalized;
  lastDecodedItems = items;

  setStatus(`Decoded ${items.length} binary item(s). Building time series…`);
  const summary = renderTimeSeriesFromItems(items);
  if (summary.fuelRows || summary.overrideRows) {
    setStatus(
      `Fuel rows: ${summary.fuelRows || 0} · Overrides: ${summary.overrideRows || 0} · Parsed XML: ${summary.parsedXmlBinaries}/${items.length}`,
    );
  } else {
    setStatus(`Decoded ${items.length} binary item(s).`);
  }
}

function downloadResponseXml() {
  const xmlText = getXmlText().trim();
  if (!xmlText) {
    setStatus("Nothing to download (response is empty).", { error: true });
    return;
  }
  triggerDownload("response.xml", new TextEncoder().encode(xmlText), "application/xml");
}

function safeCdataText(text) {
  return String(text || "").replaceAll("]]>", "]]]]><![CDATA[>");
}

function escapeXmlAttr(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requireDecodedItems() {
  const currentXml = getXmlText().trim();
  if (currentXml && lastResponseXml && currentXml !== lastResponseXml) {
    setStatus("XML changed since last decode. Click “Decode binaries” again first.", { error: true });
    return null;
  }
  if (!lastDecodedItems || lastDecodedItems.length === 0) {
    setStatus("Nothing decoded yet. Click “Decode binaries” first.", { error: true });
    return null;
  }
  return lastDecodedItems;
}

function downloadDecodedJson() {
  const items = requireDecodedItems();
  if (!items) return;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const exported = items.map((it) => {
    const raw = {
      bytes: it.rawBytes ? it.rawBytes.length : 0,
      ext: it.rawInfo ? it.rawInfo.ext : "",
      mime: it.rawInfo ? it.rawInfo.mime : "",
    };
    const decoded = {
      bytes: it.decodedBytes ? it.decodedBytes.length : 0,
      ext: it.decodedInfo ? it.decodedInfo.ext : "",
      mime: it.decodedInfo ? it.decodedInfo.mime : "",
      isText: it.decodedInfo ? Boolean(it.decodedInfo.isText) : false,
    };

    const out = {
      id: it.id || "",
      type: it.type || "",
      wasGunzipped: Boolean(it.wasGunzipped),
      error: it.error || null,
      gunzipError: it.gunzipError || null,
      raw,
      decoded,
      preview: it.preview || "",
    };

    if (!it.error && it.decodedBytes && decoded.isText) {
      out.decodedText = decoder.decode(it.decodedBytes);
    } else if (!it.error && it.decodedBytes) {
      out.decodedBase64 = bytesToBase64(it.decodedBytes);
    }

    return out;
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    responseXmlLength: lastResponseXml ? lastResponseXml.length : 0,
    items: exported,
  };

  triggerDownload(
    "decoded_binaries.json",
    new TextEncoder().encode(JSON.stringify(payload, null, 2)),
    "application/json",
  );
}

function downloadDecodedXml() {
  const items = requireDecodedItems();
  if (!items) return;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<decodedBinaries generatedAt="${escapeXmlAttr(new Date().toISOString())}">\n`;

  for (const it of items) {
    const id = it.id || "";
    const type = it.type || "";
    const rawBytes = it.rawBytes ? it.rawBytes.length : 0;
    const decodedBytes = it.decodedBytes ? it.decodedBytes.length : 0;
    const rawExt = it.rawInfo ? it.rawInfo.ext : "";
    const decodedExt = it.decodedInfo ? it.decodedInfo.ext : "";
    const rawMime = it.rawInfo ? it.rawInfo.mime : "";
    const decodedMime = it.decodedInfo ? it.decodedInfo.mime : "";

    xml += `  <binary id="${escapeXmlAttr(id)}" type="${escapeXmlAttr(type)}" rawBytes="${rawBytes}" decodedBytes="${decodedBytes}" rawExt="${escapeXmlAttr(rawExt)}" decodedExt="${escapeXmlAttr(decodedExt)}" rawMime="${escapeXmlAttr(rawMime)}" decodedMime="${escapeXmlAttr(decodedMime)}" wasGunzipped="${it.wasGunzipped ? "true" : "false"}">\n`;

    if (it.error) {
      xml += `    <error><![CDATA[${safeCdataText(it.error)}]]></error>\n`;
    } else if (it.gunzipError) {
      xml += `    <gunzipError><![CDATA[${safeCdataText(it.gunzipError)}]]></gunzipError>\n`;
    }

    if (!it.error && it.decodedBytes && it.decodedInfo && it.decodedInfo.isText) {
      const text = decoder.decode(it.decodedBytes);
      xml += `    <decoded><![CDATA[${safeCdataText(text)}]]></decoded>\n`;
    } else if (!it.error && it.decodedBytes) {
      xml += `    <decodedBase64><![CDATA[${bytesToBase64(it.decodedBytes)}]]></decodedBase64>\n`;
    }

    xml += "  </binary>\n";
  }

  xml += `</decodedBinaries>\n`;
  triggerDownload("decoded_binaries.xml", new TextEncoder().encode(xml), "application/xml");
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
  lastResponseXml = "";
  lastDecodedItems = [];
  renderTimeSeriesFromItems([]);
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
document.getElementById("downloadDecodedJson").addEventListener("click", downloadDecodedJson);
document.getElementById("downloadDecodedXml").addEventListener("click", downloadDecodedXml);
