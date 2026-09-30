#!/usr/bin/env bash
set -u
set -o pipefail
OUT="$GITHUB_WORKSPACE/test-results/emulator-health"
REPORT="$OUT/report.txt"
mkdir -p "$OUT"
: > "$REPORT"
log(){ echo "$*" | tee -a "$REPORT"; }
log "HEALTH | started $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
adb wait-for-device
log "HEALTH | adb device connected"
log "BOOT | sys.boot_completed=$(adb shell getprop sys.boot_completed | tr -d '\r')"
log "BOOT | bootanim=$(adb shell getprop init.svc.bootanim | tr -d '\r')"
log "PROC | system_server=$(adb shell pidof system_server | tr -d '\r')"
log "PROC | systemui=$(adb shell pidof com.android.systemui | tr -d '\r')"
failures=0
for i in $(seq 1 12); do
  stamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  boot=$(adb shell getprop sys.boot_completed | tr -d '\r')
  ss=$(adb shell pidof system_server | tr -d '\r')
  su=$(adb shell pidof com.android.systemui | tr -d '\r')
  timeout=$(adb shell settings get system screen_off_timeout | tr -d '\r')
  ping=$(adb shell echo ok | tr -d '\r')
  log "HEARTBEAT $i | $stamp | boot=$boot system_server=$ss systemui=$su adb_echo=$ping timeout=$timeout"
  if [ "$boot" != "1" ] || [ -z "$ss" ] || [ -z "$su" ] || [ "$ping" != "ok" ]; then
    failures=$((failures+1))
    log "WARN | unstable heartbeat $i"
  fi
  adb shell uiautomator dump /data/local/tmp/health-window.xml >/dev/null 2>&1 || true
  if adb shell cat /data/local/tmp/health-window.xml 2>/dev/null | grep -Fqi "isn't responding"; then
    log "ANR | system dialog detected"
  fi
  sleep 3
done
adb shell dumpsys activity top > "$OUT/activity-top.txt" 2>&1 || true
adb shell dumpsys window > "$OUT/window.txt" 2>&1 || true
adb shell dumpsys meminfo system_server > "$OUT/system-server-mem.txt" 2>&1 || true
adb shell getprop > "$OUT/getprop.txt" 2>&1 || true
adb exec-out screencap -p > "$OUT/final.png" || true
log "HEALTH | finished $(date -u +'%Y-%m-%dT%H:%M:%SZ') | unstable_heartbeats=$failures"
if [ "$failures" -gt 0 ]; then exit 1; fi
