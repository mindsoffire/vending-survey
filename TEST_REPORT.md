# Test Report — Vending Survey PWA

**Date:** 2026-11-16  
**Environment:** Sandbox VM (Node v18.20.4, Python 3.11.2, Pillow)

## 1. What Was Actually Tested & Passed

| Check | Method | Outcome | Notes |
| :--- | :--- | :--- | :--- |
| Static PWA file serving & manifest | Python `http.server` + `urllib` | **Passed** | All 13 files (`index.html`, `manifest.webmanifest`, `sw.js`, `styles.css`, 7 JS modules, 2 PNG icons) returned HTTP 200; `manifest.webmanifest` parsed with 2 icons (`192x192`, `512x512`) and `display: standalone`. |
| Config & data model helpers | Node ES module unit tests | **Passed** | Verified `APP_CONFIG.appName === 'Vending Survey'`, empty `googleOAuthClientId`, 13 photo roles, 11 preset tags, Haversine distance (`44 m` check), and `confirmedPosition` overriding `measuredGps` in `getDisplayCoords()`. |
| Custom tag spellcheck | Node unit tests (`photo.js`) | **Passed** | `getTagSpellingSuggestion('sugarcne')` returned `'sugarcane'`; exact words (`'durian'`) and brand names (`'iJooz'`) returned `null` without silent replacement. |
| Offline ZIP export/restore format | Node unit tests (`zip.js`) | **Passed** | `createZipBlob` + `parseZipBuffer` round-tripped `machines.json` and binary JPEG bytes (`346 B` archive) with zero external libraries. |
| Photo compression & legibility | Pillow benchmark on 3000×4000 synthetic shelf/price/hotline image | **Passed** | Resized to `1200×1600` (`1600 px` max side) at `0.78` JPEG quality: `263,403 B` → `33,361 B` (`32.6 KB`). Inspected 1:1 crop (`OPERATOR HOTLINE: +65 6123 4567`, `MACHINE REF: SG-TAMPINES-04`); text remained sharp and legible. At `1200 px` @ `0.70`, size dropped to `20.4 KB` with softer edges. Recommended default: **`1600 px` at `0.78`**. |

## 2. What Could NOT Be Tested Here (Requires Your Device & Live HTTPS)

Headless Chromium in this sandbox has an organization URL policy blocking `http://localhost` / `http://127.0.0.1` and no outbound internet, so live browser UI, real hardware, and Google Drive API flows could not be executed here:

- **Install on Android Chrome (Oppo Find N3)** and **iPhone Safari** (Add to Home Screen, standalone launch).
- **Real camera capture** (`<input type="file" accept="image/*" capture="environment">`) and **real GPS `watchPosition`** (permission granted, denied, timeout, and outdoor accuracy readings in Singapore).
- **Leaving/closing the app mid-capture and reopening** (live IndexedDB draft recovery banner in Chrome).
- **Airplane mode capture → reconnect → automatic Drive backup** and **Service Worker offline reload**.
- **Google OAuth sign-in, Drive folder creation, idempotent upload, size verification, and Drive restore onto a clean browser profile** (requires your real Google Cloud OAuth Client ID and live HTTPS origin).
- **Low-storage / quota-exceeded behavior** and `navigator.storage.estimate()` / `persist()` on Android Chrome.
- **Interactive Leaflet map display, OSM / OneMap tile loading, and tap popups** on phone and desktop.

## 3. Known Limits & Open Issues

- **Browsers can evict site data:** Even with `navigator.storage.persist()`, browsers do not guarantee immunity or send a pre-eviction warning, and cannot run background Drive uploads while the app is closed. Keep the Home screen "not backed up" count at zero by syncing when online.
- **ZIP import format:** `zip.js` uses uncompressed `STORE` entries so it works 100% offline; it imports ZIPs exported by Vending Survey, not arbitrary deflate-compressed archives.
- **Developer Mode:** The toggle in Settings is a UI convenience only, not security; multi-user permissions later require server-side identity checks.
- **OSM / OneMap tiles:** Not cached offline per OSM tile usage policy; map background tiles require an internet connection, while your machine pins and popups still load from IndexedDB.
