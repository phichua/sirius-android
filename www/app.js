import { Sirius } from "./sirius.js";

const $ = (s) => document.querySelector(s);
const dog = new Sirius();
let actionsRendered = -1;

/* ---------------- connect gate ---------------- */
const HOST_KEY = "siriusHost";
$("#host").value = localStorage.getItem(HOST_KEY) || "";

function gateMsg(text, kind) {
  const el = $("#gateMsg");
  if (!text) { el.className = "msg"; return; }
  el.textContent = text;
  el.className = "msg show " + (kind || "warn");
}

async function doConnect() {
  const host = $("#host").value.trim();
  if (!host) return;
  $("#go").disabled = true;
  gateMsg("Connecting…", "warn");
  const ok = await dog.connect(host);
  $("#go").disabled = false;
  if (ok) {
    localStorage.setItem(HOST_KEY, host);
    $("#gate").classList.add("hide");
    gateMsg("");
    holdScreen();
  } else {
    gateMsg(`Could not reach ${host}:8765. Check the dog is on and that this `
      + `phone is on the same Wi-Fi — not the dog's own sirius_ hotspot.`, "bad");
  }
}
$("#go").onclick = doConnect;
$("#host").addEventListener("keydown", (e) => { if (e.key === "Enter") doConnect(); });
$("#disconnect").onclick = async () => {
  camStop();
  if (dog.connected) await dog.enableVision(false);
  dog.disconnect();
  releaseScreen();
  $("#gate").classList.remove("hide");
};

/* ---------------- tabs ---------------- */
document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".pane").forEach((p) => {
      p.classList.toggle("on", p.id === "pane-" + b.dataset.tab);
    });
  };
});

/* ---------------- thumb pads ---------------- */
function makePad(el, onMove) {
  const nub = el.querySelector(".nub");
  let id = null;
  const place = (x, y) => {
    const r = el.getBoundingClientRect();
    const R = r.width / 2 - r.width * 0.17;
    let dx = x - (r.left + r.width / 2);
    let dy = y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
    nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    onMove(Math.max(-1, Math.min(1, dx / R)), Math.max(-1, Math.min(1, -dy / R)));
  };
  const release = () => {
    id = null;
    el.classList.remove("live");
    nub.style.transform = "translate(-50%,-50%)";
    onMove(0, 0);
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    id = e.pointerId;
    el.setPointerCapture(id);
    el.classList.add("live");
    place(e.clientX, e.clientY);
  });
  el.addEventListener("pointermove", (e) => { if (e.pointerId === id) place(e.clientX, e.clientY); });
  el.addEventListener("pointerup", (e) => { if (e.pointerId === id) release(); });
  el.addEventListener("pointercancel", release);
  el.addEventListener("lostpointercapture", release);
}
makePad($("#padMove"), (x, y) => dog.setVelocity({ linear_y: -x, linear_x: y }));
makePad($("#padTurn"), (x) => dog.setVelocity({ angular_z: -x }));

/* ---------------- throttle + posture ---------------- */
$("#throttle").addEventListener("input", (e) => {
  dog.throttle = parseFloat(e.target.value);
  $("#outThrottle").textContent = Math.round(dog.throttle * 100) + "%";
});

const SLIDERS = [
  ["body_pitch", "body pitch"], ["body_yaw", "body yaw"], ["body_roll", "body roll"],
  ["head_pitch", "head pitch"], ["head_yaw", "head yaw"],
];
$("#sliders").innerHTML = SLIDERS.map(([k, label]) =>
  `<div class="sl"><span class="lab">${label}</span>
     <input type="range" id="sl_${k}" min="-1" max="1" step="0.02" value="0" data-k="${k}">
     <output id="out_${k}">0.00</output></div>`).join("")
  + `<button id="centre" style="width:100%;margin-top:6px">Centre all</button>`;

$("#sliders").addEventListener("input", (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  const v = parseFloat(e.target.value);
  $("#out_" + k).textContent = v.toFixed(2);
  dog.setPosture({ [k]: v });
});
$("#centre").onclick = () => {
  const zero = {};
  SLIDERS.forEach(([k]) => {
    zero[k] = 0;
    $("#sl_" + k).value = 0;
    $("#out_" + k).textContent = "0.00";
  });
  dog.setPosture(zero);
};

/* ---------------- buttons ---------------- */
// Update the number as it moves, but only send on release - dragging would
// otherwise fire a request per pixel.
let volumeTouched = false;
$("#volume").addEventListener("input", (e) => {
  volumeTouched = true;
  $("#outVolume").textContent = e.target.value;
});
$("#volume").addEventListener("change", (e) => {
  volumeTouched = false;
  dog.setVolume(e.target.value);
});

$("#stop").onclick = () => dog.stop();
$("#standup").onclick = () => dog.standUp();
$("#estop").onclick = () => (dog.estop ? dog.clearEstop() : dog.emergencyStop());
$("#modeGround").onclick = () => dog.setRobotMode("ground");
$("#modeDesktop").onclick = () => dog.setRobotMode("desktop");

/* ---------------- actions ---------------- */
function renderActions() {
  const q = $("#search").value.trim().toLowerCase();
  const list = dog.actions.filter((a) => !q
    || (a.display_name || a.id || "").toLowerCase().includes(q)
    || (a.category || "").toLowerCase().includes(q));
  $("#actions").innerHTML = list.length
    ? list.map((a) => `<button class="act" data-a="${a.id || a.filename}">`
        + `${a.display_name || a.id}<small>${a.category || ""}</small></button>`).join("")
    : `<p class="muted">No matching actions.</p>`;
}
$("#search").addEventListener("input", renderActions);
$("#actions").addEventListener("click", (e) => {
  const btn = e.target.closest(".act");
  if (btn) dog.play(btn.dataset.a);
});

/* ---------------- camera ---------------- */
let camImg = null;
function camStop(msg) {
  if (camImg) { camImg.remove(); camImg = null; }
  $("#camMsg").hidden = false;
  $("#camMsg").textContent = msg || "Camera off";
}
$("#camOn").onclick = async () => {
  if (!dog.connected) { camStop("Connect first."); return; }
  camStop();
  $("#camMsg").textContent = "Starting the camera…";
  // Without this the stream connects and then sits silent forever.
  const ok = await dog.enableVision(true);
  if (!ok) { camStop("The dog refused to start the camera."); return; }
  const img = document.createElement("img");
  img.alt = "Live view from the camera in the dog's head";
  img.onload = () => { $("#camMsg").hidden = true; };
  img.onerror = () => camStop("No MJPEG stream on port 8080.");
  img.src = dog.streamUrl() + "?t=" + Date.now();
  camImg = img;
  $("#camBox").appendChild(img);
};
$("#camOff").onclick = () => {
  camStop();
  if (dog.connected) dog.enableVision(false);   // stop burning battery on both ends
};

/* ---------------- safety ---------------- */
// Keep the screen awake while connected: a phone that sleeps mid-drive with a
// pad held is exactly when you need the stop button.
let wakeLock = null;
async function holdScreen() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); }
  catch (e) { /* denied or unsupported - not fatal */ }
}
function releaseScreen() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// Backgrounding the app while a pad is held would otherwise leave the dog walking.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && dog.connected) {
    dog.setVelocity({ linear_x: 0, linear_y: 0, angular_z: 0 });
    dog.stop();
    releaseScreen();
  } else if (!document.hidden && dog.connected) {
    holdScreen();
  }
});
window.addEventListener("pagehide", () => { if (dog.connected) dog.stop(); });
window.addEventListener("blur", () => {
  if (dog.connected && dog.moving) {
    dog.setVelocity({ linear_x: 0, linear_y: 0, angular_z: 0 });
    dog.stop();
  }
});

/* ---------------- render ---------------- */
function render() {
  $("#dot").className = "dot" + (dog.connected ? " on" : "");
  $("#status").textContent = dog.connected
    ? `${dog.host} · fw ${dog.version || "?"} · ${dog.robotMode || "—"}`
    : "offline";
  $("#estop").textContent = dog.estop ? "RESUME" : "STOP";
  $("#modeGround").classList.toggle("on", dog.robotMode === "ground");
  $("#modeDesktop").classList.toggle("on", dog.robotMode === "desktop");

  if (dog.actions.length !== actionsRendered) {
    actionsRendered = dog.actions.length;
    $("#search").placeholder = `search ${actionsRendered} actions`;
    renderActions();
  }

  // Don't yank the slider out from under a thumb that is mid-drag.
  if (dog.volume != null && !volumeTouched && document.activeElement !== $("#volume")) {
    $("#volume").value = dog.volume;
    $("#outVolume").textContent = dog.volume;
  }

  const b = dog.battery, e = dog.emotion;
  const pct = typeof b.percentage === "number" ? Math.round(b.percentage * 100) + "%" : "—";
  const rows = [
    ["Battery", pct],
    ["Voltage", b.voltage ? b.voltage.toFixed(2) + " V" : "—"],
    ["Temperature", b.temperature ? b.temperature.toFixed(1) + " °C" : "—"],
    ["Walking mode", dog.robotMode || "—"],
    ["Mood", e.emotion_state || "—"],
    ["Satiety", e.satiety_value != null ? Math.round(e.satiety_value) : "—"],
    ["Firmware", dog.version || "—"],
  ];
  $("#tel").innerHTML = rows.map(([k, v]) =>
    `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join("");

  const log = $("#log");
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = dog.log.join("\n");
  if (atEnd) log.scrollTop = log.scrollHeight;
}
dog.addEventListener("change", render);
dog.addEventListener("log", render);
render();

setInterval(() => { if (dog.connected) dog.refreshBattery(); }, 20000);

// Reconnect straight away if we already know the address.
if ($("#host").value) doConnect();
