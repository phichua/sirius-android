# Sirius — Android app for the Hengbot Sirius robot dog

A standalone Android app that drives the dog directly over Wi-Fi. **No laptop, no
bridge, no cloud.** The phone opens a WebSocket to the robot and talks to it.

Built because the official app never shipped a working build, and because the two
community control tools both target a firmware generation this dog does not run.

```
Phone ──ws://192.168.1.91:8765──► Dog
```

---

## Install

Every push to `main` builds an APK in GitHub Actions and attaches it to a release.

1. Open the repo's **Releases** page on your phone.
2. Download the newest `sirius-N.apk`.
3. Android will ask you to allow installing from your browser. Allow it.
4. Open **Sirius**, type the dog's IP, press Connect. The address is remembered.

The IP is on the dog's face screen under **Connection** — use the **WiFi** line
(e.g. `192.168.1.91`), *not* the Hotspot line (`192.168.233.1`), which is the
network the dog itself broadcasts.

---

## What it does

- **Two thumb pads** — left drives, right turns, with a throttle slider.
- **180 built-in actions**, searchable — barks, sits, stretches, tricks.
- **Posture** — body pitch/yaw and head pitch/yaw (roll is not implemented in this firmware).
- **Camera** — read natively (a Capacitor plugin) and shown frame by frame; the WebView cannot display the raw MJPEG stream directly.
- **Telemetry** — battery percentage, voltage, temperature, mood, satiety, firmware.
- **Walking mode** — desktop (restricted) vs ground (full gait).
- **STOP** — always visible in the top bar.

---

## The protocol

Firmware 2.4.3 serves a dialect that is documented nowhere. Hengbot's manual and
official SDK describe `ws://<ip>:10710/getjson` — **that port is closed**. The
community kit describes port 8765 with UPPERCASE names — **all rejected** with
`Unknown request type`. What this robot actually speaks:

```
ws://<ip>:8765/?audience=web        lowercase command names
http://<ip>:8080                     MJPEG camera
```

```json
{"type":"request","request_type":"gait_control","request_id":"r1",
 "data":{"linear_x":0.6,"linear_y":0,"angular_z":0}}
```

It also pushes `{"type":"event","event_type":"emotion_update"}` frames carrying
mood, arousal, satiety and fatigue.

`attitude_control` takes `body_pitch`, `body_yaw`, `head_pitch`, `head_yaw` in
radians — confirmed by moving the robot and measuring the camera image. `body_roll`
and every alternative spelling of roll do nothing, so this firmware is pitch and
yaw only.

Commands used here: `gait_control` · `play_motion` · `cancel_motion` ·
`stop_all_motions` · `self_recover` · `attitude_control` · `set_robot_mode` ·
`set_behavior_pause` · `get_actions` · `get_battery_status` · `get_robot_mode` ·
`check_update`. The full 41-command map is in `../sirius-console/README.md`.

### The camera needs a native reader

The dog serves the camera as `multipart/x-mixed-replace` MJPEG on port 8080, and
it only produces frames after `enable_detection {enabled:true}`. A desktop browser
renders that stream, but the Android WebView refuses it in an `<img>`, a `fetch`
(also no CORS header) and an `<iframe>`. So the app reads it in native code
(`CameraStreamPlugin`), splits it into complete JPEGs, and hands the WebView one
at a time as a `data:` URI — which renders everywhere.

### Three traps

1. **Velocities are fractions of full travel in −1..1, not m/s.** Send `0.15` and
   you get 15% throttle — the stride collapses and the dog marches on the spot
   while echoing your value back.
2. **The dog boots in `desktop` mode**, which restricts the gait so it will not
   stride off a table. Real walking needs `ground`.
3. **Actions at default priority lose** to the robot's autonomous behaviour.
   This app sends `priority: 5`.

---

## Why it must be an APK

An `https://` page cannot open a `ws://` connection to a private IP — browsers
block it as mixed content. So a PWA hosted on Vercel or anywhere else **cannot**
talk to the dog. An Android WebView can, provided two settings:

- `capacitor.config.json` → `server.androidScheme: "http"` (the default is
  `https`, which would block every call)
- `AndroidManifest.xml` → `android:usesCleartextTraffic="true"` (cleartext is off
  by default from Android 9)

Both are set. Change either and the app will connect to nothing.

---

## Safety

- **Nothing on this robot detects a table edge.** Floor only, especially in ground mode.
- Backgrounding the app, locking the phone or losing focus **stops the dog** —
  otherwise a held pad would leave it walking.
- The screen is held awake while connected, because a phone that sleeps mid-drive
  is exactly when you need the stop button.
- **STOP** zeroes the gait, cancels any playing action and pauses autonomous
  behaviour, sent twice because a single frame can drop.
- There is **no authentication on the robot**. Anyone on the Wi-Fi can drive it.

---

## Support this

Free, and it stays free. It exists because the official app never shipped a
working build and a lot of us ended up with an expensive paperweight — the
protocol here was reconstructed by probing a real robot, and it is documented
in full above so anyone can build on it.

If it brought your dog back to life and you feel like saying thanks, PayPal
donations are welcome and entirely optional:

**`philipchuaonline@gmail.com`**

No obligation whatsoever. Bug reports, firmware findings from other versions,
and pull requests are worth just as much — especially if you can map the
command set on firmware 2.4.5 and later.

## Developing

```bash
npm install
npx cap sync android      # copy www/ into the Android project
python make_icons.py      # regenerate launcher icons
```

The UI is plain ES modules in `www/` — no build step. `www/sirius.js` is the
protocol client, `www/app.js` is the interface. Edit, push, and CI builds the APK.

To build locally instead you would need a JDK and the Android SDK; the GitHub
Actions workflow exists precisely so you do not.

## Firmware

The dog reports **2.4.3**, with **2.4.8 available** as an OTA update. Updating may
change the command names — this app would need remapping. Firmware 2.4.7 also
moves the camera to WebRTC, which would break the MJPEG view. **Do not go to
2.5.5**: the ToF distance sensor is disabled in firmware there.
