# hydration.sys: notes for the next session

**Keep this file current.** Whenever you change the project (architecture,
commands, tests, known issues, what's verified), update this file in the same
commit so the next session starts from the truth.

Also follow `~/Work/CLAUDE.md`: commit and push this repo after changes, then
run `~/Work/bin/work-sync`. System-level pieces (Hyprland window rule, tray
pin, install) are reproduced by `~/Work/Malek-Omarchy/setup.sh` (section
`hydration`); change both together.

## What it is

Tauri v2 desktop app (Rust + vanilla TypeScript/Vite, no UI framework): a
terminal-styled pixel pet ("Byte") that reminds the user to drink water, gets
hungry when ignored, and shows a git-style history. Linux (Omarchy:
Hyprland 0.56 Lua config + Quickshell shell) is the main target; Windows is
supported but has never been run. See README.md for features and user docs.

## Layout

- `src-tauri/src/core/`: all pure logic, no Tauri types, unit-tested.
  - `model.rs` data types, validation (`validate_data` strict for import,
    `sanitize` lenient repair on load).
  - `time.rs` local-day/DST helpers (generic over `TimeZone`).
  - `hunger.rs` hunger stage + pet mood, derived from timestamps (never stored).
  - `reminders.rs` `evaluate()`: fire or not + next due time.
  - `state.rs` `Core`: the one authoritative copy of data + every mutation + `view()` snapshot.
  - `storage.rs` atomic JSON save, `.bak`, corrupt/repair recovery.
  - `voice.rs` Byte's lines for notifications/tray, read from `src/core/copy.json`.
- `src-tauri/src/lib.rs`: Tauri glue: `App` state, scheduler thread
  (`scheduler`, supervised), commands, window/tray events, startup.
- `src-tauri/src/notify.rs`: Linux = zbus straight to org.freedesktop.Notifications
  (replace-in-place, click = open, "log 250" action, re-probe on failure);
  Windows = tauri-plugin-notification.
- `src-tauri/src/tray.rs`: tray menu; **only call `Tray::update` on the main thread**.
- `src-tauri/src/platform.rs`: startup-route detection, Omarchy theme reader.
- `src/core/`: pure TS (commands whitelist, units, dates, history/hash/heatmap/tags,
  copy picker, sprite grid, color contrast). `src/ui/`: views. `src/mock.ts`:
  browser fake backend (only in `--mode mock`, tree-shaken from real builds).
- `scripts/`: `install-linux.sh` (user-local install/uninstall), `gen-icons.mjs`
  (icons from the sprite grid, needs ImageMagick), `guarded-test.sh` (real
  binary in Xvfb + private D-Bus), `shots.mjs` (mock screenshots).
- `tests/unit` (vitest), `tests/e2e` (Playwright on the mock), `tests/native`
  (mock notification/tray D-Bus server, dbusmenu driver).

## Invariants (don't break these)

- The native process is the only scheduler and the only writer of the data file.
  The webview renders snapshots (`snapshot` event + command replies, ordered by `seq`).
- Never hold one of our Mutexes across a call that dispatches to the main
  thread and waits (tray `set_text`, window getters from other threads).
  That deadlocked once; tray updates go through `run_on_main_thread`.
- A reminder counts (interval, daily max) only once delivered.
- Text from data is only ever set via `textContent` (`src/ui/dom.ts`); never innerHTML.
- Capabilities (`src-tauri/capabilities/main.json`) grant event listen/unlisten
  and our own commands only; new commands must be added to `build.rs` and the
  capability. No fs/shell/dialog/http permissions for the webview.
- Copy must never shame, threaten or make medical claims (a unit test greps for it).

## Commands

```sh
npm ci
npx tsc --noEmit && npm test            # TS types + 29 unit tests
npm run test:rust                       # 52 Rust tests
npx playwright test                     # 14 headless UI tests (starts vite --mode mock)
npx tauri build --no-bundle             # release binary -> src-tauri/target/release/hydration-sys
scripts/guarded-test.sh                 # 22 native checks, isolated from the real session
scripts/install-linux.sh                # install to ~/.local (rebuild first if code changed)
npm run icons                           # icons + docs/icon.svg
node scripts/readme-shots.mjs           # README screenshots -> docs/screens
```

`cargo build --release` alone does NOT embed the frontend (it points at the dev
server); always build through `npx tauri build`.

## Gotchas found the hard way

- `python3` in Malek's interactive PATH is a shim that refuses scripts; use
  `/usr/bin/python3` (the guarded test runs with a clean PATH, so it's fine there).
- Run anything with a private D-Bus under `env -i` (see guarded-test.sh). A run
  that inherited WAYLAND_DISPLAY spawned a private xdg-desktop-portal-hyprland
  that segfaulted and showed a "process crashed" notification on the real desktop.
- Under Xvfb, WebKitGTK startup takes ~20 s (portal activation timeouts) and
  screenshots can show repaint garbage; neither happens on the real session.
- The Omarchy tray hides icons in a drawer unless pinned; the SNI id is
  `tray-icon tray app main`.
- Wayland app class is `hydration-sys`.
- "Freezes" on tab switch (2026-10-28, Malek's hybrid Intel/NVIDIA laptop):
  input and DOM updates kept working, but WebKitGTK's DMA-BUF renderer stopped
  presenting frames until the window was resized. `main.rs` now sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux unless already set. The stall
  never reproduced on demand (hide/show, workspace switch, screensaver and tray
  paths were all tried); confirm with a resize if it ever comes back.

## Status (2026-10-27)

Verified on the real Omarchy session: window renders with the Nord theme,
float rule applies (440x700 centered), tray icon shows pinned in the bar,
tray menu (via dbusmenu) correct, a real reminder rendered by Quickshell with
the icon, second launch exits in 0.05 s and focuses the window, XDG autostart
is honored by this session (uwsm runs `xdg-desktop-autostart.target`).

Not verified yet: clicking the Quickshell notification or its action button by
hand, real login autostart after a reboot, close-to-tray via the window's
close button on Hyprland, anything on Windows. See the checklist in the final
report / README.

Secrets: none in this repo. Machine-local notes (e.g. credentials) belong in
`CLAUDE.local.md`, which is gitignored.
