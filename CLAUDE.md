# reitrn Print Agent

Electron tray app for warehouse PCs that prints thermal labels (ZPL/TSPL) on USB
printers. Full-featured variant — connects to Firebase AND serves a local HTTP(S)
API. Repo: github.com/reitrn/reitrn-print-agent. Windows-only.

## Working rules (regression prevention)

This runs unattended on live warehouse PCs — a broken build means labels stop
printing and receiving stalls.

1. **Plain JS, no compiler net**: after ANY change, run `node --check` on every
   touched file and start the app (`npm start`) before declaring done. CI
   syntax-checks all JS on push (`.github/workflows/ci.yml`); the existing
   build.yml also packages on every master push.
2. **One concern per change**; no drive-by refactors.
3. Printing has a deliberate fallback chain (USB direct → PowerShell → copy /b →
   WinSpool) — never simplify it away; each layer exists because the previous
   one failed on some warehouse PC.
4. PowerShell helper scripts must stay UTF-16 LE with BOM, written to temp files
   (inline -Command breaks; avoid em dashes in PS strings).

## Stack

- Electron 28 + electron-builder (NSIS + portable, x64), no framework in renderer
- `firebase` (modular SDK, Firestore) + `electron-store` for settings/job history
- No native printer module in production — printing goes through Windows fallbacks

## How it fits in

- Companion to **ReturnHub** (app.reitrn.com). Two print paths:
  1. **Firestore** (`firebase-listener.js`): listens to `printJobs` where
     `status == 'pending'`; claims jobs atomically via transaction (prevents two
     agents double-printing); routes by `targetStation` (`'*'`/missing = anyone).
  2. **Local server** on `127.0.0.1:3010` (HTTPS using wildcard cert for
     `local.reitrn.com` in `assets/`, falls back to HTTP if certs missing) —
     ~50ms vs ~1s via the cloud. Endpoints: `/ping`, `/status`, `POST /print`.
- Registers itself in Firestore `printStations` (heartbeat 30s, offline on quit,
  deletes old doc on rename) so apps can discover stations.
- Two printer roles: **courier** (4x6") and **barcode** (62x35mm), routed by
  `job.printerRole`.

## Commands

- `npm start` — run locally
- `npm run build` — Windows installer + portable (`electron-builder --win`)
- GitHub Actions workflow builds and releases the installer on push

## Key files

- `main.js` — tray/window, local server, label builders (`buildZPL`/`buildTSPL`),
  `renderJob()`, IPC
- `firebase-listener.js` — Firestore listener, station registration, job claiming
- `printer.js` — printer listing + raw printing fallback chain

## Decisions & gotchas

- **Printer language auto-detected from printer name** (`detectLang`): TSC/TTP/TEx/TPx
  → TSPL, everything else → ZPL. ReturnHub sends both `zpl` + `tspl` fields; mobile
  sends structured `labelData`; legacy jobs send pre-rendered `data`.
- **Raw print fallback chain**: direct Node write to `\\.\USBxxx` (port looked up
  via wmic, cached) → PowerShell CreateFile P/Invoke → `copy /b` → WinSpool P/Invoke.
- **wmic only here** — this repo's `getInstalledPrinters` has NO `Get-Printer`
  PowerShell fallback; on Windows 11 22H2+ (wmic removed) printer listing fails.
  The fix exists in reitrn-lite-print-agent's `printer.js` — port it if needed.
- PowerShell scripts are written to temp files as **UTF-16 LE with BOM** (inline
  commands broke on length/escaping/encoding; avoid em dashes in PS strings).
- Taskbar/tray theme: Electron's `nativeTheme` reads the *app* theme; the taskbar
  theme requires reading registry `SystemUsesLightTheme`.
- `/print` responds `202` immediately and prints in the background — don't make
  the browser wait for the physical print.
- Chrome Private Network Access header (`Access-Control-Allow-Private-Network`)
  is required for https pages to reach localhost.
- Firebase config in `firebase-listener.js` is the same project as ReturnHub
  (client-side web config). Never add server keys/secrets to this repo.
