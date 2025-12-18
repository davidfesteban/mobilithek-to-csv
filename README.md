# mobilithek-to-csv (binary downloader)

This is a small, fully static `index.html` tool that:

- extracts all `<binary>` elements from a Mobilithek XML response
- Base64-decodes them
- optionally gunzips them (when the decoded bytes are gzip)
- extracts FuelPricePublication time series and exports CSV (and keeps raw binaries downloadable)

## Use

### Option A (recommended): start the local Ruby helper + UI

On macOS you can just double-click `start.command`.

Or run it manually:

```bash
ruby server.rb
```

This serves the UI at `http://127.0.0.1:5173` and provides `/api/fetch` so the page can fetch Mobilithek using your
`.p12/.pfx` client certificate (mTLS).

### Option B: decode an existing XML response (no server)

1. Open `index.html` in a modern browser (anywhere, including `file://`).
2. Get a Mobilithek response:
   - Click **Open endpoint in new tab** (browser will handle client-certificate selection), then save/copy the XML.
   - Or click **Try fetch**:
     - with a selected `.p12/.pfx`: uses the local helper server (recommended)
     - without a certificate: uses browser `fetch()` (often blocked by CORS)
3. Paste the XML into the textarea (or load the saved XML file) and click **Decode binaries**.
4. Download CSV from the **Fuel prices (time series)** section, or download decoded binaries as `decoded_binaries.json` / `decoded_binaries.xml` to inspect before CSV conversion.

## Helper server notes

- The browser cannot use a user-selected `.p12/.pfx` for mTLS from JavaScript, and Mobilithek responses are often blocked
  by CORS. The Ruby helper server is the portable workaround.
- You can change bind address/port:

```bash
HOST=127.0.0.1 PORT=5173 ruby server.rb
```

If you opened `index.html` via `file://` and still want to use the helper server, open:

- `index.html?helper=http://127.0.0.1:5173`

## Notes / limitations

- Pure client-side `fetch()` cannot attach a user-selected `.p12/.pfx` for mTLS, and cross-origin responses are often blocked by CORS. Use the helper server if you need one-click fetching with the certificate.
- Gzip decompression uses `DecompressionStream('gzip')`. If your browser doesn’t support it, the tool will still let you download the Base64-decoded bytes (often a `.gz`).
