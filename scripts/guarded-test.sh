#!/usr/bin/env bash
# Runs the real hydration.sys binary in an isolated session: clean env,
# temp HOME/XDG dirs, Xvfb display, private D-Bus with a mock notification
# server and tray watcher. Nothing can reach the real desktop session.
#
#   scripts/guarded-test.sh [path/to/hydration-sys]
#
# Needs: Xvfb, dbus-run-session, python3-gobject, xdotool, ImageMagick (import).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${HYDRATION_GUARD:-}" != "inner" ]]; then
  BIN="$(realpath "${1:-$HERE/src-tauri/target/release/hydration-sys}")"
  [[ -x "$BIN" ]] || { echo "binary not found: $BIN (run: npx tauri build --no-bundle)"; exit 2; }
  for tool in Xvfb dbus-run-session xdotool import python3; do
    command -v "$tool" >/dev/null || { echo "missing $tool; GUI tests not run"; exit 3; }
  done
  if pgrep -f "^$BIN" >/dev/null; then
    echo "this binary is already running (pid $(pgrep -f "^$BIN" | tr '\n' ' ')); quit it first so process checks are meaningful"; exit 4
  fi
  ROOT="$(mktemp -d -t hydration-guard.XXXXXX)"
  mkdir -p "$ROOT"/{home,config,data,cache,state,runtime,appdata,ctrl}
  chmod 700 "$ROOT/runtime"
  MARK="$ROOT/marker"; touch "$MARK"
  ls -1 "$HOME/.config/autostart" 2>/dev/null | sort >"$ROOT/autostart.before"
  echo "guard root: $ROOT"

  env -i \
    PATH="/usr/local/bin:/usr/bin:/bin" LANG="${LANG:-C.UTF-8}" \
    HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" \
    XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime" \
    HYDRATION_SYS_DATA_DIR="$ROOT/appdata" HYDRATION_GUARD=inner ROOT="$ROOT" BIN="$BIN" HERE="$HERE" \
    REAL_BUS="${DBUS_SESSION_BUS_ADDRESS:-none}" \
    dbus-run-session -- bash "$0"
  rc=$?

  # The real session must be untouched.
  leaked="$(find "$HOME/.config" "$HOME/.local/share" "$HOME/.cache" -maxdepth 3 -newer "$MARK" -iname '*hydration*' 2>/dev/null)"
  ls -1 "$HOME/.config/autostart" 2>/dev/null | sort >"$ROOT/autostart.after"
  if [[ -n "$leaked" ]] || ! diff -q "$ROOT/autostart.before" "$ROOT/autostart.after" >/dev/null; then
    echo "FAIL real session touched:"; echo "$leaked"; diff "$ROOT/autostart.before" "$ROOT/autostart.after"; rc=1
  else
    echo "PASS real ~/.config, ~/.local/share, ~/.cache and autostart unchanged"
  fi
  if pgrep -f "$ROOT" >/dev/null; then echo "FAIL leftover processes:"; pgrep -af "$ROOT"; rc=1; pkill -f "$ROOT"; fi
  mkdir -p "$HERE/test-results"
  cp "$ROOT"/*.png "$ROOT/report.txt" "$ROOT/notify.log" "$HERE/test-results/" 2>/dev/null
  rm -rf "$ROOT"
  echo "artifacts in test-results/; temp root removed"
  exit "$rc"
fi

# ------------------------------------------------------------------ inner
unset WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE DISPLAY SWAYSOCK XDG_SESSION_ID XDG_SESSION_TYPE \
  XDG_SESSION_DESKTOP XDG_CURRENT_DESKTOP PULSE_SERVER PULSE_RUNTIME_PATH PIPEWIRE_RUNTIME_DIR PIPEWIRE_REMOTE
REPORT="$ROOT/report.txt"; LOG="$ROOT/notify.log"; : >"$LOG"
pass=0; fail=0
ok() { echo "PASS $*" | tee -a "$REPORT"; pass=$((pass + 1)); }
bad() { echo "FAIL $*" | tee -a "$REPORT"; fail=$((fail + 1)); }
note() { echo "     $*" | tee -a "$REPORT"; }

for n in $(seq 91 99); do [[ -e /tmp/.X11-unix/X$n || -e /tmp/.X$n-lock ]] || { DNUM=$n; break; }; done
Xvfb ":$DNUM" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
XPID=$!
sleep 1
export DISPLAY=":$DNUM" GDK_BACKEND=x11 NO_AT_BRIDGE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1

# Fail closed before anything GUI runs.
guard_ok=1
[[ "$DISPLAY" == ":$DNUM" ]] && kill -0 $XPID 2>/dev/null || guard_ok=0
[[ -z "${WAYLAND_DISPLAY:-}" && -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]] || guard_ok=0
[[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" && "$DBUS_SESSION_BUS_ADDRESS" != "$REAL_BUS" ]] || guard_ok=0
[[ "$XDG_RUNTIME_DIR" == "$ROOT"/* ]] || guard_ok=0
echo "env names: $(env | cut -d= -f1 | sort | tr '\n' ' ')" >>"$REPORT"
if [[ $guard_ok != 1 ]]; then bad "guard checks failed; GUI tests NOT RUN"; kill $XPID 2>/dev/null; exit 1; fi
ok "guards: virtual display :$DNUM, private bus, temp runtime dir, no Wayland/Hyprland vars"

python3 "$HERE/tests/native/mock_notifyd.py" "$LOG" "$ROOT/ctrl" &
MPID=$!
for _ in $(seq 50); do grep -q ready "$LOG" && break; sleep 0.1; done

DATA="$ROOT/appdata/hydration.json"
now_ms=$(( $(date +%s) * 1000 ))
today=$(date +%F)
python3 - "$DATA" "$now_ms" "$today" <<'PY'
import json, sys
path, now, today = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = {"version": 1, "entries": [{"id": "seed1", "ts": now - 30*60_000, "date": today, "ml": 250, "offsetMin": 0}],
     "dayGoals": {today: 2000},
     "settings": {"petName": "byte", "goalMl": 2000, "unit": "ml", "activeStart": 0, "activeEnd": 1440,
                  "remindersEnabled": True, "reminderIntervalMin": 15, "minGapMin": 10, "dailyMax": 8,
                  "closeToTray": True, "trayVerified": True, "onboarded": True, "theme": "phosphor"},
     "runtime": {}}
json.dump(d, open(path, "w"))
PY

count() { grep -c "$1" "$LOG" 2>/dev/null || true; }
wait_for() { local pat=$1 n=$2 t=${3:-15}; for _ in $(seq $((t * 10))); do [[ $(count "$pat") -ge $n ]] && return 0; sleep 0.1; done; return 1; }
entries() { python3 -c "import json;print(len(json.load(open('$DATA'))['entries']))"; }
visible() { xdotool search --onlyvisible --name '^hydration\.sys$' 2>/dev/null | head -1; }
alive() { pgrep -f "^$BIN" >/dev/null; }

# T1: login launch, tray verified -> hidden window, native reminder fires once.
"$BIN" --autostarted >"$ROOT/app1.log" 2>&1 &
APID=$!
if wait_for tray_registered 1 40; then ok "tray item registered with StatusNotifierWatcher"; else bad "tray not registered"; fi
if wait_for '"summary"' 1 20; then ok "reminder sent by native scheduler with no visible window"; else bad "no reminder"; fi
sleep 3
[[ $(count '"summary"') -eq 1 ]] && ok "exactly one reminder (no burst)" || bad "expected 1 reminder, got $(count '"summary"')"
[[ -z "$(visible)" ]] && ok "autostart with verified tray stays hidden" || bad "window visible after autostart"
grep '"summary"' "$LOG" | head -1 | sed 's/^/     notify: /' | tee -a "$REPORT" >/dev/null
grep -q '"actions": \["default"' "$LOG" && ok "notification carries open + log actions (server advertises actions)" || bad "no actions"

# T2: duplicate login launch exits and keeps the window hidden.
timeout 10 "$BIN" --autostarted; rc=$?
[[ $rc -eq 0 ]] && ok "duplicate --autostarted launch exited (rc 0)" || bad "duplicate launch rc=$rc"
sleep 1
[[ -z "$(visible)" ]] && ok "duplicate autostart did not open the window" || bad "duplicate autostart showed window"
[[ $(pgrep -fc "^$BIN") -eq 1 ]] && ok "still one process" || bad "process count $(pgrep -fc "^$BIN")"

# T3: manual second launch exits and focuses the existing window.
timeout 10 "$BIN"; rc=$?
sleep 1.5
[[ $rc -eq 0 ]] && ok "second manual launch exited (rc 0)" || bad "second launch rc=$rc"
[[ -n "$(visible)" ]] && ok "second launch showed the existing window" || bad "window not shown by second launch"
sleep 1.5
import -display "$DISPLAY" -window root "$ROOT/xvfb-window.png" 2>/dev/null && note "screenshot: xvfb-window.png"

# T4: tray menu items.
python3 "$HERE/tests/native/tray.py" list >"$ROOT/tray-menu.txt" 2>&1 && note "tray menu: $(cut -f4 "$ROOT/tray-menu.txt" | tr '\n' '|')"
before=$(entries)
python3 "$HERE/tests/native/tray.py" click "log 250" >/dev/null && sleep 1
[[ $(entries) -eq $((before + 1)) ]] && ok "tray 'log 250 mL' saved an entry" || bad "tray log did not save ($before -> $(entries))"
python3 "$HERE/tests/native/tray.py" click "hide" >/dev/null && sleep 1
[[ -z "$(visible)" ]] && ok "tray hide hides the window" || bad "tray hide failed"
python3 "$HERE/tests/native/tray.py" click "show" >/dev/null && sleep 1
[[ -n "$(visible)" ]] && ok "tray show restores the window" || bad "tray show failed"

# T5: clicking the notification's "log 250 mL" action.
before=$(entries)
touch "$ROOT/ctrl/invoke-log-250"; sleep 1.5
[[ $(entries) -eq $((before + 1)) ]] && ok "notification action 'log 250 mL' saved an entry" || bad "notification action did not log"

# T6: quit from the tray really terminates.
python3 "$HERE/tests/native/tray.py" click "quit" >/dev/null
for _ in $(seq 50); do alive || break; sleep 0.1; done
alive && bad "process still running after quit" || ok "tray quit terminated the process"
notify_before=$(count '"summary"')

# T7: restart 5 hours later (sleep/resume or long shutdown): one reminder, not five.
HYDRATION_SYS_CLOCK_OFFSET_MIN=300 "$BIN" --autostarted >"$ROOT/app2.log" 2>&1 &
wait_for '"summary"' $((notify_before + 1)) 20 || true
sleep 4
got=$(( $(count '"summary"') - notify_before ))
[[ $got -eq 1 ]] && ok "after a 5h gap exactly one reminder fired" || bad "after 5h gap got $got reminders"
python3 "$HERE/tests/native/tray.py" click "pause" >/dev/null; sleep 0.5
python3 -c "import json;r=json.load(open('$DATA'))['runtime'];import sys;sys.exit(0 if r.get('pausedDate') else 1)" && ok "tray pause stored pause-for-today" || bad "pause not stored"
python3 "$HERE/tests/native/tray.py" click "quit" >/dev/null
for _ in $(seq 50); do alive || break; sleep 0.1; done
alive && { bad "second instance did not quit"; pkill -f "^$BIN"; }

# T8: storage only inside the temp root.
ls "$ROOT/appdata" | tr '\n' ' ' | sed 's/^/     appdata: /' | tee -a "$REPORT" >/dev/null; echo >>"$REPORT"
[[ -f "$DATA" && -f "$DATA.bak" ]] && ok "data file + backup written in the override dir" || bad "data/backup missing"
python3 -c "import json;json.load(open('$DATA'))" && ok "data file is valid JSON after all writes" || bad "data file corrupt"

# T9: corrupt file recovery on the real binary.
printf '{ broken' >"$DATA"
"$BIN" >"$ROOT/app3.log" 2>&1 &
sleep 4
ls "$ROOT/appdata" | grep -q 'hydration.corrupt-' && ok "corrupt file kept aside and recovered from backup" || bad "no corrupt copy kept"
python3 -c "import json;d=json.load(open('$DATA'));assert len(d['entries'])>=1" && ok "recovered data has entries" || bad "recovered data empty"
import -display "$DISPLAY" -window root "$ROOT/xvfb-recovered.png" 2>/dev/null
python3 "$HERE/tests/native/tray.py" click "quit" >/dev/null; sleep 1
pkill -f "^$BIN" 2>/dev/null

kill $MPID $XPID 2>/dev/null
wait 2>/dev/null
echo "---- $pass passed, $fail failed" | tee -a "$REPORT"
[[ $fail -eq 0 ]]
