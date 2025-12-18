# mobilithek-to-csv (binary downloader)

This is a small, fully static `index.html` tool that:

- extracts all `<binary>` elements from a Mobilithek XML response
- Base64-decodes them
- optionally gunzips them (when the decoded bytes are gzip)
- extracts FuelPricePublication time series and exports CSV (and keeps raw binaries downloadable)

## Use

1. Open `index.html` in a modern browser.
2. Get a Mobilithek response:
   - Click **Open endpoint in new tab** (browser will handle client-certificate selection), then save/copy the XML.
   - Or click **Try fetch**:
     - with a selected `.p12/.pfx`: uses the local helper server (recommended)
     - without a certificate: uses browser `fetch()` (often blocked by CORS)
3. Paste the XML into the textarea (or load the saved XML file) and click **Decode binaries**.
4. Download CSV from the **Fuel prices (time series)** section, or download decoded binaries as `decoded_binaries.json` / `decoded_binaries.xml` to inspect before CSV conversion.

## Optional: local helper server (recommended)

If you want the page to fetch Mobilithek using your `.p12/.pfx` + passphrase, run the included helper server (Ruby recommended if you don’t have Node):

1. Run one of:
   - `ruby server.rb`
   - `node server.mjs` (Node.js 18+)
     - Install Node with: `brew install node`
2. Open: `http://127.0.0.1:5173`
3. Select the `.p12`, enter the passphrase, and click **Try fetch**.

If you opened `index.html` via `file://` and still want to use the helper server, open:

- `index.html?helper=http://127.0.0.1:5173`

## Notes / limitations

- Pure client-side `fetch()` cannot attach a user-selected `.p12/.pfx` for mTLS, and cross-origin responses are often blocked by CORS. Use the helper server if you need one-click fetching with the certificate.
- Gzip decompression uses `DecompressionStream('gzip')`. If your browser doesn’t support it, the tool will still let you download the Base64-decoded bytes (often a `.gz`).
