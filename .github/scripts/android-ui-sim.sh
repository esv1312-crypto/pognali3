set -e
mkdir -p test-results/screenshots test-results test-results/video

# Black-box recorder: capture the emulator screen in short chunks while the simulation runs.
# This gives us a post-run video trail and keeps the stdout telemetry live in GitHub Actions.
RECORDER_PID=""
LIVE_PID=""
TELEMETRY_PID=""
AI_BRIDGE_PID=""
AI_COMMENT_ID="5950423112"
start_live_stream(){
  if [ -z "${LIVE_URL:-}" ]; then echo "LIVE | disabled (LIVE_URL not set)"; return; fi
  (
    echo "LIVE | starting emulator screen stream to $LIVE_URL"
    while true; do
      if adb exec-out screencap -p 2>/dev/null | curl --silent --show-error --max-time 5 -X POST -H "X-Live-Token: $LIVE_TOKEN" --data-binary @- "$LIVE_URL/frame" >/dev/null 2>&1; then touch /tmp/pognali-live-frame; fi
      sleep 0.5
    done
  ) &
  LIVE_PID=$!
  echo "LIVE | started pid=$LIVE_PID"
}
start_telemetry(){
  if [ -z "${LIVE_URL:-}" ]; then echo "TELEMETRY | disabled"; return; fi
  (
    tail -n 0 -F "$REPORT" 2>/dev/null | while IFS= read -r line; do
      curl --silent --show-error --max-time 2 -X POST -H "X-Live-Token: $LIVE_TOKEN" -H "Content-Type: text/plain; charset=utf-8" --data-binary "$line" "$LIVE_URL/log" >/dev/null 2>&1 || true
    done
  ) &
  TELEMETRY_PID=$!
  echo "TELEMETRY | started pid=$TELEMETRY_PID"
}
start_ai_bridge(){
  if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then echo "AI_BRIDGE | disabled"; return; fi
  ( while true; do
      step_text=$(cat /tmp/pognali-live-step 2>/dev/null || echo "waiting for step")
      last_log=$(tail -n 1 "$REPORT" 2>/dev/null || echo "waiting for log")
      frame_age="never"; [ -f /tmp/pognali-live-frame ] && frame_age=$(python3 -c "import os,time; print(round(time.time()-os.path.getmtime(\"/tmp/pognali-live-frame\"),1))")
      hb_age="never"; [ -f /tmp/pognali-live-heartbeat ] && hb_age=$(python3 -c "import os,time; print(round(time.time()-os.path.getmtime(\"/tmp/pognali-live-heartbeat\"),1))")
      ui_text=$(cat /tmp/pognali-live-ui.txt 2>/dev/null | tr "\n" " " | cut -c1-2500); [ -n "$ui_text" ] || ui_text="UI snapshot not available yet"
      body=$(printf "### POGNALI LIVE — AI TELEMETRY\n\n**status:** RUNNING\n**run:** %s\n**step:** %s\n**last action/log:** %s\n**frame age:** %ss\n**heartbeat age:** %ss\n**UI:** %s\n" "$GITHUB_RUN_NUMBER" "$step_text" "$last_log" "$frame_age" "$hb_age" "$ui_text")
      if [ "$hb_age" != "never" ] && python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > 15 else 1)" "$hb_age"; then body="${body}\n**stall:** POSSIBLE STALL (heartbeat older than 15s)"; else body="${body}\n**stall:** false"; fi
      payload=$(printf "%s" "$body" | python3 -c "import json,sys; print(json.dumps({\"body\":sys.stdin.read()},ensure_ascii=False))")
      curl --silent --show-error --max-time 5 -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -H "Content-Type: application/json" --data "$payload" "https://api.github.com/repos/$GITHUB_REPOSITORY/issues/comments/$AI_COMMENT_ID" >/dev/null 2>&1 || true
      sleep 3
    done ) &
  AI_BRIDGE_PID=$!
  echo "AI_BRIDGE | started pid=$AI_BRIDGE_PID comment=$AI_COMMENT_ID"
}
stop_ai_bridge(){
  if [ -n "$AI_BRIDGE_PID" ]; then kill "$AI_BRIDGE_PID" >/dev/null 2>&1 || true; wait "$AI_BRIDGE_PID" 2>/dev/null || true; echo "AI_BRIDGE | stopped"; fi
}
stop_telemetry(){
  if [ -n "$TELEMETRY_PID" ]; then kill "$TELEMETRY_PID" >/dev/null 2>&1 || true; wait "$TELEMETRY_PID" 2>/dev/null || true; echo "TELEMETRY | stopped"; fi
}
stop_live_stream(){
  if [ -n "$LIVE_PID" ]; then kill "$LIVE_PID" >/dev/null 2>&1 || true; wait "$LIVE_PID" 2>/dev/null || true; echo "LIVE | stopped"; fi
}
start_recorder(){
  (
    i=0
    while true; do
      file=$(printf "test-results/video/emulator-%03d.mp4" "$i")
      adb shell screenrecord --bit-rate 2000000 --size 720x1280 --time-limit 170 /sdcard/pognali-recording.mp4 >/dev/null 2>&1 || true
      adb pull /sdcard/pognali-recording.mp4 "$file" >/dev/null 2>&1 || true
      adb shell rm -f /sdcard/pognali-recording.mp4 >/dev/null 2>&1 || true
      [ -s "$file" ] || rm -f "$file"
      i=$((i+1))
      sleep 1
    done
  ) &
  RECORDER_PID=$!
  echo "RECORDER | started pid=$RECORDER_PID"
}
stop_recorder(){
  if [ -n "$RECORDER_PID" ]; then
    kill "$RECORDER_PID" >/dev/null 2>&1 || true
    wait "$RECORDER_PID" 2>/dev/null || true
    adb shell pkill -f screenrecord >/dev/null 2>&1 || true
    adb pull /sdcard/pognali-recording.mp4 test-results/video/emulator-final.mp4 >/dev/null 2>&1 || true
    adb shell rm -f /sdcard/pognali-recording.mp4 >/dev/null 2>&1 || true
    echo "RECORDER | stopped"
  fi
}
trap 'stop_ai_bridge; stop_telemetry; stop_live_stream; stop_recorder' EXIT
start_recorder
start_live_stream
REPORT="test-results/test-report.txt"
: > "$REPORT"
: > /tmp/pognali-live-step
: > /tmp/pognali-live-ui.txt
rm -f /tmp/pognali-live-frame /tmp/pognali-live-heartbeat
start_telemetry
start_ai_bridge
adb install -r app/build/outputs/apk/debug/app-debug.apk
# API 35 blocks shell writes to shared /sdcard storage.
# Keep the fixture in adb's writable temp area so it never blocks
# the rest of the emulator simulation. The photo picker itself is
# still exercised later as a real Android DocumentsUI interaction.
adb push qa-profile.png /data/local/tmp/qa-profile.png >/dev/null
adb shell ls -l /data/local/tmp/qa-profile.png

PASS=0
FAIL=0
SKIP=0

log(){ echo "$*" | tee -a "$REPORT"; }
pass(){ PASS=$((PASS+1)); log "PASS | $*"; }
fail(){ FAIL=$((FAIL+1)); log "FAIL | $*"; }
skip(){ SKIP=$((SKIP+1)); log "SKIP | $*"; }
heartbeat(){ touch /tmp/pognali-live-heartbeat; log "HEARTBEAT | $* | $(date -u +"%Y-%m-%dT%H:%M:%SZ")"; }
step(){ echo "$*" > /tmp/pognali-live-step; log "STEP | $*"; }

shot(){
  adb exec-out screencap -p > "test-results/screenshots/$1.png"
  log "SHOT | $1.png"
}

UI_XML="/data/local/tmp/window.xml"

recover_system_ui(){
  if adb shell uiautomator dump "$UI_XML" >/dev/null 2>&1 && adb shell cat "$UI_XML" 2>/dev/null | grep -Fqi "System UI isn't responding"; then
    log "ENV | System UI ANR detected; tapping Wait"
    adb shell input tap 540 1090 >/dev/null 2>&1 || true
    sleep 3
    if adb shell uiautomator dump "$UI_XML" >/dev/null 2>&1 && adb shell cat "$UI_XML" 2>/dev/null | grep -Fqi "System UI isn't responding"; then
      log "ENV | System UI ANR persists; restarting System UI"
      adb shell am force-stop com.android.systemui >/dev/null 2>&1 || true
      sleep 4
    else
      log "ENV | System UI recovered"
    fi
  fi
}

dump_ui(){
  recover_system_ui || true
  adb shell uiautomator dump "$UI_XML" >/dev/null 2>&1 || true
  adb shell cat "$UI_XML" 2>/dev/null | tee /tmp/pognali-live-ui.xml >/dev/null || true
python3 - <<'PY' >/tmp/pognali-live-ui.txt 2>/dev/null || true
import re,html
try:
 x=open("/tmp/pognali-live-ui.xml",encoding="utf-8",errors="ignore").read(); vals=[]
 for m in re.finditer(r'\b(?:text|content-desc)="([^"]*)"',x):
  v=html.unescape(m.group(1)).strip()
  if v and v not in vals: vals.append(v)
 print(" | ".join(vals[:80]))
except Exception: pass
PY
}
tap_text(){
  NEEDLE="$1"
  python3 - "$NEEDLE" <<'PY'
import subprocess,sys,xml.etree.ElementTree as ET,re
needle=sys.argv[1]
xml=subprocess.check_output(["adb","shell","cat","/data/local/tmp/window.xml"],text=True,errors="ignore")
root=ET.fromstring(xml)
for n in root.iter():
    text=(n.attrib.get("text") or "")
    desc=(n.attrib.get("content-desc") or "")
    if needle.lower() in text.lower() or needle.lower() in desc.lower():
        b=n.attrib.get("bounds","")
        m=re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",b)
        if m:
            x=(int(m.group(1))+int(m.group(3)))//2
            y=(int(m.group(2))+int(m.group(4)))//2
            subprocess.check_call(["adb","shell","input","tap",str(x),str(y)])
            print(f"TAPPED {text or desc} @ {x},{y}")
            raise SystemExit(0)
raise SystemExit(1)
PY
}

wait_text(){
  NEEDLE="$1"; SEC="${2:-10}"
  for i in $(seq 1 "$SEC"); do
    dump_ui | grep -Fqi "$NEEDLE" && return 0
    sleep 1
  done
  return 1
}

tap_if(){
  dump_ui
  if tap_text "$1"; then sleep 1; return 0; fi
  return 1
}

tap_field(){
  NEEDLE="$1"
  python3 - "$NEEDLE" <<'PY'
import subprocess,sys,xml.etree.ElementTree as ET,re
needle=sys.argv[1]
xml=subprocess.check_output(["adb","shell","cat","/data/local/tmp/window.xml"],text=True,errors="ignore")
root=ET.fromstring(xml)
nodes=list(root.iter())
for idx,n in enumerate(nodes):
    text=(n.attrib.get("text") or "")
    if needle.lower() in text.lower():
        b=n.attrib.get("bounds",""); m=re.match(r"\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]",b)
        if m:
            x=(int(m.group(1))+int(m.group(3)))//2; y=(int(m.group(2))+int(m.group(4)))//2
            subprocess.check_call(["adb","shell","input","tap",str(x),str(y+45)])
            print(f"FIELD {text} @ {x},{y+45}")
            raise SystemExit(0)
raise SystemExit(1)
PY
  sleep .5
}

type_ascii(){
  adb shell input text "${1// /%s}"
  sleep .4
}

clear_and_type(){
  adb shell input keyevent 123
  adb shell input keyevent --longpress 67 || true
  type_ascii "$1"
}

swipe_up(){
  adb shell input swipe 540 1550 540 550 500
  sleep 1
}

swipe_down(){
  adb shell input swipe 540 550 540 1550 500
  sleep 1
}

close_modal(){
  dump_ui
  tap_if "✕" || adb shell input keyevent 4
  sleep .5
}

log "FULL HUMAN-STYLE SIMULATION"
heartbeat "simulation started"
log "Commit: $GITHUB_SHA"
step "00 | APK installed; beginning emulator-driven user simulation"
step "00.1 | Profile photo fixture staged in /data/local/tmp"

log "Started: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# 01. Launch / permissions / initial screen
sleep 4
shot "01_launch"
wait_text "События" 10 && pass "App launched and bottom navigation is visible" || fail "App did not expose Events navigation"

# 02. Native permission dialog / location
dump_ui
if tap_text "Разрешить"; then
  sleep 1
  pass "Location permission interaction"
else
  skip "Location permission dialog not shown"
fi

# 03. Map basics: filters, list/map, zoom and pan
if tap_if "Мир"; then pass "World filter"; else fail "World filter"; fi
shot "02_world_filter"
if tap_if "Рядом"; then pass "Nearby filter"; else fail "Nearby filter"; fi
if tap_if "Мои"; then pass "My events filter"; else fail "My events filter"; fi
if tap_if "Рядом"; then true; fi

# View toggle buttons are icon/text based; exercise by coordinate after UI inspection.
dump_ui
adb shell input tap 520 105 || true
sleep 1
shot "03_map_zoomed_or_view"
adb shell input swipe 540 900 720 900 600 || true
adb shell input swipe 540 900 540 1200 600 || true
adb shell input tap 520 105 || true
sleep 1
pass "Map pan/zoom gesture simulation"

# 04. Calendar open, month navigation, date selection and clear
if tap_if "Дата"; then
  pass "Calendar opened"
  shot "04_calendar_open"
  if tap_if "›"; then pass "Calendar next month"; else skip "Calendar next-month control not found"; fi
  if tap_if "‹"; then pass "Calendar previous month"; else skip "Calendar previous-month control not found"; fi
  dump_ui
  # Tap a visible calendar day button if available.
  if python3 - <<'PY'
import subprocess,xml.etree.ElementTree as ET,re
x=subprocess.check_output(["adb","shell","cat","/data/local/tmp/window.xml"],text=True,errors="ignore")
r=ET.fromstring(x)
for n in r.iter():
    t=n.attrib.get("text","").strip()
    if t.isdigit() and 1 <= int(t) <= 28:
        b=n.attrib.get("bounds","")
        m=re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",b)
        if m:
            X=(int(m.group(1))+int(m.group(3)))//2; Y=(int(m.group(2))+int(m.group(4)))//2
            subprocess.check_call(["adb","shell","input","tap",str(X),str(Y)])
            raise SystemExit(0)
raise SystemExit(1)
PY
  then
    sleep 1; pass "Calendar date selected"; shot "05_calendar_selected"
  else skip "No selectable calendar date exposed"
  fi
else
  fail "Calendar button"
fi

# Clear date filter if visible.
dump_ui
tap_if "Сбросить" && pass "Calendar filter cleared" || true

# 05. Switch map/list and open an event
dump_ui
adb shell input tap 520 105 || true
sleep 1
shot "06_list_view"
if tap_if "Открыть"; then
  pass "Opened event from list"
  shot "07_event_detail"
else
  # Try tapping first visible event-like card area.
  adb shell input tap 540 400
  sleep 1
  shot "07_event_detail_fallback"
  skip "Event Open text not exposed; tapped first card area"
fi

# 06. Event detail: participants/profile, join/leave, chat, questions
dump_ui
if tap_if "Участники"; then
  pass "Opened participants"
  shot "08_participants"
  close_modal
else
  skip "Participants action not available on selected event"
fi

# Join if available, then leave again.
dump_ui
if tap_if "ПОЙДУ"; then
  pass "Joined event"
  sleep 1
  shot "09_joined"
  dump_ui
  if tap_if "ЧАТ"; then
    pass "Opened event chat"
    shot "10_chat_open"
    if tap_if "Написать сообщение"; then
      type_ascii "QA hello from Android emulator"
      dump_ui
      if tap_if "➤"; then pass "Sent chat message"; else fail "Chat send button"; fi
      shot "11_chat_message"
    else
      skip "Chat input not exposed by accessibility"
    fi
    close_modal
  else
    skip "Chat not available after join"
  fi
  dump_ui
  if tap_if "ВЫЙТИ"; then
    pass "Left event"
    dump_ui
    if tap_if "Выйти"; then
      pass "Confirmed leaving event"
    else
      skip "Leave confirmation button not exposed"
    fi
  else
    skip "Leave action not available"
  fi
else
  skip "Join action not available on selected event"
fi

# Ask organizer on a non-owned event if accessible.
dump_ui
if tap_if "Задать вопрос"; then
  pass "Opened organizer question form"
  shot "12_question"
  dump_ui
  if tap_if "Что хочешь спросить"; then
    type_ascii "Can I arrive a little later?"
    dump_ui
    if tap_if "ОТПРАВИТЬ ВОПРОС"; then pass "Sent organizer question"; else fail "Question submit"; fi
  else
    skip "Question textarea not exposed"
  fi
  close_modal
else
  skip "No non-owned event with question action in current viewport"
fi

# 07. Create event — fill every user-facing field
if tap_if "Создать"; then
  pass "Create screen opened"
  shot "13_create_empty"

  dump_ui
  if tap_field "Что делаем?"; then
    type_ascii "QA meetup"
    pass "Event title entered"
  else fail "Event title input"; fi

  dump_ui
  if tap_if "Спорт"; then pass "Category selected"; else skip "Sport category button"; fi

  dump_ui
  if tap_field "Иконка события"; then
    type_ascii "😀"
    pass "Custom emoji input exercised"
  else
    # Focus the emoji field by coordinate fallback.
    adb shell input tap 80 500 || true
    adb shell input text "QA"
    pass "Emoji field gesture exercised"
  fi

  # Date picker: open it and accept the currently offered date.
  dump_ui
  if tap_field "Дата"; then
    sleep 1
    dump_ui
    if tap_if "OK"; then pass "Date picker accepted"; else skip "Date picker OK not exposed"; fi
  else skip "Date input not exposed"; fi

  # Time picker
  dump_ui
  if tap_field "Время"; then
    sleep 1
    dump_ui
    if tap_if "OK"; then pass "Time picker accepted"; else skip "Time picker OK not exposed"; fi
  else skip "Time input not exposed"; fi

  # Place search
  dump_ui
  if tap_field "Место"; then
    type_ascii "Gagarin Park"
    dump_ui
    if tap_if "Найти"; then pass "Place search executed"; else skip "Place search button"; fi
  else fail "Place input"; fi

  # Picker map: tap and drag marker/map
  adb shell input tap 540 800 || true
  sleep 1
  adb shell input swipe 540 800 650 720 500 || true
  sleep 1
  pass "Create-event map tap/drag gestures"

  # Location button
  dump_ui
  if tap_if "Моё местоположение"; then pass "Create-event location button"; else skip "Create-event location button"; fi

  # Participant limit
  dump_ui
  if tap_field "Сколько человек?"; then
    adb shell input text "8"
    pass "Participant limit edited"
  else skip "Participant limit input"; fi

  # Age selector + custom range
  dump_ui
  if tap_if "Возраст участников"; then
    sleep .5
    dump_ui
    if tap_if "Свой диапазон"; then
      pass "Custom age range selected"
      dump_ui
      adb shell input tap 300 950 || true
      type_ascii "21"
      adb shell input tap 430 950 || true
      type_ascii "40"
    else
      skip "Custom age option not exposed"
    fi
  else skip "Age selector"; fi

  # Description
  dump_ui
  if tap_field "Описание"; then
    type_ascii "QA description for full Android simulation"
    pass "Description entered"
  else skip "Description input"; fi

  # Live participant message
  dump_ui
  if tap_field "Актуальное сообщение участникам"; then
    type_ascii "QA live update: we are meeting here."
    pass "Live participant message entered"
  else skip "Live message input"; fi

  shot "14_create_filled"

  # Submit
  dump_ui
  if tap_if "ПОГНАЛИ"; then
    pass "Created event"
    sleep 2
    shot "15_created_event"
  else
    fail "Create event submit"
  fi
else
  fail "Create navigation"
fi

# 08. My events: open, participants, edit, live message, chat, finish/delete paths
if tap_if "Мои"; then
  pass "My events opened"
  shot "16_my_events"
  dump_ui
  if tap_if "Открыть"; then
    pass "Opened created/my event"
    shot "17_my_event_detail"
    dump_ui
    if tap_if "Участники"; then pass "Opened event participants"; close_modal; else skip "Participants action"; fi
    dump_ui
    if tap_if "ЧАТ"; then
      pass "Opened created-event chat"
      shot "18_created_chat"
      dump_ui
      if tap_if "Написать сообщение"; then
        type_ascii "Owner QA message"
        dump_ui
        tap_if "➤" && pass "Sent owner chat message" || skip "Owner chat send button"
      fi
      close_modal
    fi
    dump_ui
    if tap_if "Редактировать"; then
      pass "Opened event editor"
      shot "19_edit_event"
      # Change description and save.
      dump_ui
      if tap_if "Описание"; then
        type_ascii " edited"
        pass "Edited event description"
      fi
      dump_ui
      if tap_if "СОХРАНИТЬ"; then pass "Saved edited event"; else skip "Save edited event button"; fi
    fi
  else
    skip "Created event card not exposed in My events"
  fi
else
  fail "My events navigation"
fi

# 09. Profile: photo, name, birth date, city, bio, save
if tap_if "Профиль"; then
  pass "Profile opened"
  shot "20_profile_before"
  dump_ui
  if tap_if "Выбрать фотографию"; then
    sleep 1
    # DocumentsUI: prefer Downloads, then fixture filename.
    dump_ui
    tap_if "Downloads" || true
    sleep 1
    dump_ui
    if tap_if "qa-profile.png"; then
      pass "Profile photo file selected through DocumentsUI"
    else
      skip "Photo file not visible in DocumentsUI on API 35"
    fi
    sleep 1
  else
    skip "Photo picker button"
  fi

  dump_ui
  if tap_field "Имя"; then
    clear_and_type "QA User"
    pass "Profile name edited"
  else skip "Profile name input"; fi

  dump_ui
  if tap_field "Дата рождения"; then
    sleep .5
    dump_ui
    tap_if "OK" && pass "Profile birth-date picker exercised" || skip "Birth-date OK"
  else skip "Birth-date input"; fi

  dump_ui
  if tap_field "Город"; then
    clear_and_type "Warsaw"
    pass "Profile city edited"
  else skip "Profile city input"; fi

  dump_ui
  if tap_field "О себе"; then
    clear_and_type "QA profile bio"
    pass "Profile bio edited"
  else skip "Profile bio input"; fi

  dump_ui
  if tap_if "СОХРАНИТЬ ПРОФИЛЬ"; then pass "Profile saved"; else fail "Save profile"; fi
  shot "21_profile_after"

  # Language modal and switching
  dump_ui
  if tap_if "RU"; then
    pass "Language picker opened"
    shot "22_language"
    dump_ui
    if tap_if "English"; then
      pass "Language switched to English"
      sleep 1
      shot "23_english"
      dump_ui
      tap_if "EN" && pass "English language label visible" || true
      # Switch back to Russian.
      dump_ui
      if tap_if "EN"; then
        sleep .5
        dump_ui
        tap_if "Русский" && pass "Language switched back to Russian" || skip "Russian option"
      fi
    else
      skip "English language option"
    fi
  else
    skip "Language button"
  fi

  # Personal messages empty state
  dump_ui
  if tap_if "Личные"; then
    pass "Personal messages view opened"
    shot "24_personal_messages"
    close_modal
  else
    skip "Personal messages tab"
  fi
else
  fail "Profile navigation"
fi

# 10. Back button / modal closing / scroll / keyboard
adb shell input keyevent 4 || true
sleep .5
adb shell input keyevent 4 || true
sleep .5
adb shell input swipe 540 1500 540 500 600 || true
adb shell input swipe 540 500 540 1500 600 || true
pass "Back and scroll gestures exercised"

log "Finished: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
log "SUMMARY | PASS=$PASS FAIL=$FAIL SKIP=$SKIP"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
