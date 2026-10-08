# Paperless Mobile

Expo/React Native app for shop-floor staff: view live workstation status,
open and annotate production BOMs, prepare orders and print prep labels,
complete orders on a kiosk, run the standard check and quality control, and
see daily stats. Runs on Android tablets and, as a web build served by the
backend, in a browser.

It is the client for the companion **`paperless_backend`** service.

---

## 1. Tech stack

| Layer              | Choice                                                    |
| ------------------ | --------------------------------------------------------- |
| Framework          | Expo SDK 54 / React Native 0.81, React 19                 |
| Routing            | `expo-router` (file-based, in `app/`)                     |
| Data fetching      | `@tanstack/react-query` + Axios                           |
| Realtime           | `socket.io-client`                                        |
| UI kit             | `react-native-paper`, `@expo/vector-icons`                |
| Drawing/annotation | `react-native-svg` + a custom `DrawingCanvas`             |
| Barcode scanning   | `expo-camera`                                             |
| Localization       | Lightweight `t()` helper — Czech, English, Ukrainian      |
| Testing            | Jest + `jest-expo` + `@testing-library/react-native`      |

## 2. Project layout

```text
app/                             # expo-router screens (file-based routing)
├── _layout.tsx                  # Root layout (providers, query client)
├── (tabs)/
│   ├── _layout.tsx              # Bottom tab bar
│   ├── index.tsx                # Workstations — live status cards
│   ├── search.tsx               # Search BOM (+ barcode scan, print documentation)
│   ├── revisions.tsx            # Documents overview with status/check/QC filters
│   ├── prep-queue.tsx           # Prep-station queue by date/workplace/hardware type
│   └── stats.tsx                # Completed/checked products per day
├── admin/employees.tsx          # Hidden admin: employees, quality engineers, BAAN codes
├── document/[id].tsx            # Document viewer + annotation, check/QC, completion
└── kiosk.tsx                    # Kiosk mode: order completion / status

src/
├── api/client.ts                # Axios instance (X-API-Key)
├── config/env.ts                # Backend URL + API key resolution
├── services/socket.ts           # Socket.IO client, connects to backend
├── components/                  # Modals (prep label, QC, admin PIN, manual completion,
│   │                            # barcode scanner, …), DrawingCanvas, CycleHistory
│   └── __tests__/
├── hooks/                       # Barcode scan, connectivity, employees, language
├── i18n/                        # cs.json / en.json / uk.json + t() helper
└── types/index.ts               # Shared TS types
```

## 3. Screens at a glance

- **Workstations** (`(tabs)/index.tsx`) — cards for each tracked workstation
  with current order + cycle progress, live-updated via Socket.IO
  (`workstation-order-update`, `workstations-updated`) rather than polling.
- **Search BOM** — find an order by number or by scanning its label with
  the tablet camera, then open a BOM (a picker when a position has several
  types). The printer icon on a position prints the order's documentation
  again, even if it was already printed.
- **Documents** (`revisions.tsx`) — every opened document with its status
  (complete / with changes / missing part / incomplete), check and QC
  progress and "awaiting fix"; filters for each.
- **Prep queue** — orders to prepare ahead of production, filterable by
  date, workplace and hardware type; locked orders (Masterplan) can't be
  prepared. "Open BOM" reviews the document first; the *print without
  opening PDF* switch goes straight to the print dialog.
- **Stats** — completed / checked products per day. Long-pressing the day
  title + admin PIN opens the hidden **admin** screen (employees, quality
  engineers with their PINs, BAAN codes for the prep checklist).
- **Document viewer** (`document/[id].tsx`) — opens a PDF, lets staff draw
  annotations and saves edited revisions. Depending on the order's state,
  the header offers:
  - **Print label** — the prep-label dialog: checklist of items not in P2L,
    who prepared it, one label per door. Once printed, the same dialog
    reprints chosen doors instead (shown on any document whose label was
    already printed).
  - **Check** — the standard per-cycle check of finished cycles, with the
    full cycle history.
  - **Quality control** — QC sign-off unlocked by the quality engineer's
    personal PIN; a problem sends the cycle to "awaiting fix".
  - **Finish order** (flag) — turns a non-"complete" completion into
    "complete" (and so closes the order in the ERP).
  - *Hidden:* long-pressing the document title + admin PIN opens a manual
    completion (non-"complete" statuses only) for orders that never go
    through P2L.
- **Kiosk** (`kiosk.tsx`) — a fixed-station mode (keeps the screen awake)
  with two sub-modes:
  - *Completion kiosk* — the last workstation: who finished the order and
    its status (`complete` / `complete_with_changes` / `missing_product` /
    `shipped_incomplete`), with a backlog of cycles still waiting.
  - *Status kiosk* — shows the current order at the workstation.

## 4. Connecting to the backend

`src/config/env.ts` resolves the backend URL:

- **Web build** — the backend serves the app itself, so the API is the
  page's own origin.
- **Expo Go / dev client** — the dev machine's IP, `http://<ip>:5300`.
- **Standalone build** — `https://<EXPO_PUBLIC_BACKEND_HOST or
  tocz-app4.toors.cz>:5300` when `EXPO_PUBLIC_BACKEND_USE_HTTPS=true`,
  otherwise `http://10.110.10.6:5300` (`localhost` in `__DEV__`).

Every request carries `EXPO_PUBLIC_API_KEY` as the `X-API-Key` header (and
the Socket.IO connection carries it too) — it must match the backend's
`API_KEY`. See `.env.example`. `EXPO_PUBLIC_*` values are inlined at build
time, so changing them needs a new build.

## 5. Running locally

```bash
npm install
cp .env.example .env   # set EXPO_PUBLIC_API_KEY
npm start              # expo start — scan QR with Expo Go, or press a/w
npm run android        # expo run:android
npm run web            # expo start --web
npm test               # jest (jest-expo preset)
```

The backend (`paperless_backend`) must be running and reachable from your
device/emulator on port `5300` — see its README for setup. When testing on
a physical device via Expo Go, the app auto-detects your dev machine's IP
as long as phone and computer are on the same network.

For the web build served by the backend, run `npx expo export --platform
web` and copy `dist/` to the backend's `WEB_BUILD_PATH` (see the backend
README, §8).

## 6. Localization

UI strings live in `src/i18n/cs.json`, `en.json` and `uk.json`, resolved by
`t(key, params?)` in `src/i18n/index.ts`. Czech is the default; the
language switcher in the header changes it per device (remembered in
AsyncStorage). Add every new key to all three files.

## 7. How this connects to the backend

This app is a **thin client** over the `paperless_backend` service — almost
no state lives on-device beyond React Query's cache:

| Mobile does this…                       | …by calling backend                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Show live workstation cards             | `GET /workstations`, refreshed on `workstation-order-update` / `workstations-updated` socket events    |
| Search / scan an order, open a BOM      | `GET /workstations/search-pbom`, `/resolve-scan`, `/pbom-types`, `POST /workstations/import-pbom`      |
| Print an order's documentation          | `POST /workstations/print-documents`                                                                   |
| Documents overview / open a document    | `GET /files`, `GET /files/:id`, `GET /workstations/documents/:id/render`                               |
| Save an annotated document              | `POST /workstations/save-edited`                                                                       |
| Prep queue and checklist                | `GET /prep-queue`, `/prep-queue/items`, `POST /prep-queue/items/check`, `/uncheck`, `/refresh`         |
| Print / reprint prep labels             | `GET /workstations/prep-label-status`, `POST /workstations/print-prep-label`, `/reprint-prep-label`    |
| Kiosk completion / finish order         | `POST /workstations/order-completion`, `GET /workstations/completion-queue`                            |
| Manual completion (hidden)              | `POST /workstations/manual-completion` (`X-Admin-Pin`)                                                 |
| Standard check                          | `POST /workstations/order-check`                                                                       |
| Quality control                         | `POST /workstations/qc-check/verify`, `/order-qc-check` (`X-QC-Pin`)                                   |
| Stats                                   | `GET /workstations/stats`                                                                              |
| Employee pickers                        | `GET /employees`                                                                                       |
| Admin screen                            | `/employees/admin/…` (`X-Admin-Pin`)                                                                   |

The backend is also the one that receives the **actual production-floor
events** (`POST /workstations/order-update` from the production system),
prints labels and documentation, and fans updates out over Socket.IO — the
mobile app never talks to the production system or the printers directly.
See the [backend repo's README](https://github.com/bourama1/paperless_backend/blob/main/README.md)
for the full API surface and event list.
