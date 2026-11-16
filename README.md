# Vending Survey — Progressive Web App (PWA)

A mobile-first (390 px), offline-capable Progressive Web App for surveying vending machines in Singapore, one machine at a time, with local IndexedDB storage, Google Drive backup (`drive.file` scope), ZIP export/restore, and an OpenStreetMap / OneMap leaflet map.

## Architectural Choices (Where the Brief Left Options Open)

- **Front-end stack:** Plain HTML5, CSS3, and native ES-module JavaScript with zero build step. Any static host can serve the folder directly.
- **Recommended static host:** **GitHub Pages** (free, automatic HTTPS, custom domain optional, zero server maintenance). Netlify free tier and Hostinger static hosting also work identically.
- **Camera input:** `<input type="file" accept="image/*" capture="environment">` instead of `getUserMedia`. On Android Chrome (Oppo Find N3) and iOS Safari, the native camera input preserves hardware autofocus, HDR, and flash without viewfinder permission quirks, and relies on the Review screen's manual crop box for framing adjustments.
- **Photo crop storage:** Single-copy replacement. Cropping on the Review screen (or in Developer Mode) replaces the stored compressed blob and thumbnail, keeping local storage predictable and Drive sync simple.
- **Default photo compression:** Longest side `1600 px`, JPEG quality `0.78` (both editable in Settings).
- **Offline ZIP export/import:** Custom zero-dependency pure-JS `zip.js` (STORE method with CRC32) so export and restore work offline without external libraries.
- **Map tiles:** OpenStreetMap standard tiles (`tile.openstreetmap.org`) by default with `© OpenStreetMap contributors` attribution and `strict-origin-when-cross-origin` referrer. Optional switchable **OneMap (Singapore Land Authority)** basemap (`onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png`) with required OneMap logo and SLA attribution. Neither tile server is cached or prefetched by the Service Worker, honoring the OSM tile usage policy. Note: if many contributors use the app later, a dedicated commercial tile provider or self-hosted tiles will be needed.

## Running Locally

Because ES modules, Service Workers, Geolocation, and Google OAuth require HTTP/HTTPS (not `file://`), serve the folder with any local static server:

```bash
cd vending-survey
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome. (`localhost` is treated as a secure context by Chrome for Service Workers and Geolocation.)

## Deploying Over HTTPS (GitHub Pages)

1. Create a GitHub repository (public or private on paid plans; public is free for GitHub Pages) and push all files from `vending-survey/` to the `main` branch root.
2. In GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch (`main` / `/ (root)`)**.
3. Wait 1–2 minutes for your `https://<username>.github.io/<repo>/` URL.

## IndexedDB Data Layout (`vending_survey_db`, Schema v1)

Metadata and image blobs are stored in separate object stores so listing 50,000+ machines stays fast without loading full image binaries into memory.

- **`machines`** (keyPath: `id` — UUID v4 generated on device)
  - `schemaVersion`: `1` (migration handled in `db.js` `onupgradeneeded`)
  - `serialLabel`: display-only label (`VM-000001`), never used as primary key
  - `createdAt`, `updatedAt`, `isDraft` (boolean, saved after every photo/edit)
  - `contributorId`, `contributorRole` (`'contributor'` or `'developer'`)
  - `measuredGps`: `{ lat, lng, accuracyM, timestamp }` (never overwritten after capture)
  - `gpsHistory`: array of recent fixes during capture
  - `confirmedPosition`: `null` or `{ lat, lng, method, timestamp }` (written only when nudged)
  - `name`, `building`, `floor`, `status` (`Unknown / Not checked` default, `Working`, `Broken`, `Gone`), `note`, `colocatedNote`, `tags`
  - `photos`: array of `{ id, role, tags, width, height, originalWidth, originalHeight, mimeType, byteSize, thumbDataUrl, crop, driveFileId, driveByteSize, backupState, createdAt }`
  - `backupState`: `'not_backed_up' | 'uploading' | 'verified' | 'failed'`
  - `backupError`, `lastBackedUpAt`, `driveFolderId`
- **`photoBlobs`** (keyPath: `photoId`, index: `machineId`)
  - `{ photoId, machineId, blob, byteSize, updatedAt }`
  - Working-set eviction removes blobs only for `verified` machines beyond the configured `workingSetLimit` (default 25 most recent), keeping `thumbDataUrl` and `driveFileId` for on-demand re-download.
- **`settings`** (keyPath: `key`): `appSettings`, `googleOAuthClientId`, `deviceId`, `serialCounter`.
- **`meta`** (keyPath: `key`): reserved for future schema migrations.

## Google Drive Folder & File Layout

Uses the narrow `https://www.googleapis.com/auth/drive.file` scope (accesses only folders/files created by this app).

```text
My Drive/
└── Vending Survey/
    └── VM-000001_<machine-uuid>/
        ├── machine_<machine-uuid>.json
        ├── photo_<photo-uuid>_Front.jpg
        └── photo_<photo-uuid>_Shelf_1.jpg
```

Syncing is idempotent: `appProperties` (`machineId`, `photoId`, `kind`) and stable filenames are checked before upload so retries update existing files (`PATCH`) instead of creating duplicates. After upload, the app fetches file metadata from Drive and checks `size === localByteSize` before marking `verified`.
