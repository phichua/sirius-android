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

// body_roll is deliberately absent: measured on the robot, it does nothing
// under any field name. This firmware does pitch and yaw only.
const SLIDERS = [
  ["body_pitch", "body pitch"], ["body_yaw", "body yaw"],
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
// On the device, frames come from the native CameraStream plugin (a native
// socket read is immune to the WebView policies that blocked <img>, fetch and
// iframe). Each frame is a complete base64 JPEG shown via a data: URI. In a
// plain browser (dev) the plugin is absent, so we fall back to an iframe.
const CameraStream = (window.Capacitor && window.Capacitor.Plugins
  && window.Capacitor.Plugins.CameraStream) || null;

let camImg = null;
let camFrame = null;
let camListeners = [];
let camReveal = null;
let lastFrameB64 = null;         // newest JPEG, for snapshots
let recCanvas = null, recCtx = null;
let mediaRecorder = null, recChunks = [], recTimer = null, recStart = 0;

function saveMsg(text) {
  const el = $("#saveMsg");
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = text;
}

function setCamButtons(live) {
  $("#snap").disabled = !live;
  $("#rec").disabled = !live;
  if (!live) stopRecording(true);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fitCamera() {
  if (!camFrame) return;
  camFrame.style.transform = "scale(" + ($("#camBox").clientWidth / 640) + ")";
}
addEventListener("resize", fitCamera);
addEventListener("orientationchange", () => setTimeout(fitCamera, 200));

async function camStop(msg) {
  if (camReveal) { clearTimeout(camReveal); camReveal = null; }
  stopRecording(true);
  for (const h of camListeners) { try { (await h).remove(); } catch (e) { /* gone */ } }
  camListeners = [];
  if (CameraStream) { try { await CameraStream.stop(); } catch (e) { /* not running */ } }
  if (camImg) { camImg.remove(); camImg = null; }
  if (camFrame) { camFrame.remove(); camFrame = null; }
  lastFrameB64 = null;
  setCamButtons(false);
  $("#camMsg").hidden = false;
  $("#camMsg").textContent = msg || "Camera off";
}

$("#camOn").onclick = async () => {
  if (!dog.connected) { camStop("Connect first."); return; }
  camStop();
  $("#camMsg").textContent = "Starting the camera…";
  const ok = await dog.enableVision(true);
  if (!ok) { camStop("The dog refused to start the camera."); return; }

  let settled = false;
  const reveal = () => { if (!settled) { settled = true; $("#camMsg").hidden = true; } };

  if (CameraStream) {
    const img = document.createElement("img");
    img.alt = "Live view from the camera in the dog's head";
    camImg = img;
    $("#camBox").appendChild(img);
    camListeners.push(CameraStream.addListener("frame", (ev) => {
      if (img !== camImg) return;
      lastFrameB64 = ev.data;
      img.src = "data:image/jpeg;base64," + ev.data;
      reveal();
      setCamButtons(true);
      if (recCtx) drawFrameToCanvas(ev.data);   // feed the recorder
    }));
    camListeners.push(CameraStream.addListener("error", (ev) => {
      camStop("Camera: " + (ev && ev.message ? ev.message : "stream error"));
    }));
    try {
      await CameraStream.start({ url: dog.streamUrl() });
    } catch (e) {
      camStop("Could not start the camera reader.");
      return;
    }
    // If no frame has painted in a few seconds, say so rather than hang.
    camReveal = setTimeout(() => {
      if (!settled) camStop("No frames from the camera.");
    }, 6000);
  } else {
    // Dev fallback: an iframe renders the multipart stream in a desktop browser.
    const frame = document.createElement("iframe");
    frame.title = "Live view from the camera in the dog's head";
    frame.setAttribute("scrolling", "no");
    camFrame = frame;
    $("#camBox").appendChild(frame);
    fitCamera();
    camReveal = setTimeout(reveal, 1400);
    frame.src = dog.streamUrl() + "?t=" + Date.now();
  }
};

$("#camOff").onclick = () => {
  camStop();
  if (dog.connected) dog.enableVision(false);   // stop burning battery on both ends
};

/* ---------------- photo + recording ---------------- */
$("#snap").onclick = async () => {
  if (!lastFrameB64) { saveMsg("No frame to save yet."); return; }
  if (!CameraStream) { saveMsg("Saving needs the app, not a browser."); return; }
  try {
    await CameraStream.saveMedia({
      base64: lastFrameB64, mime: "image/jpeg", filename: "sirius_" + stamp() + ".jpg",
    });
    saveMsg("Photo saved to your gallery (Sirius album).");
  } catch (e) {
    saveMsg("Could not save the photo: " + (e && e.message ? e.message : e));
  }
};

function drawFrameToCanvas(b64) {
  const blob = b64ToBlob(b64, "image/jpeg");
  createImageBitmap(blob).then((bm) => {
    recCtx.drawImage(bm, 0, 0, recCanvas.width, recCanvas.height);
    bm.close();
  }).catch(() => { /* skip a bad frame */ });
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function updateRecTimer() {
  const secs = Math.floor((Date.now() - recStart) / 1000);
  $("#recDot").textContent = "REC " + Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
}

$("#rec").onclick = () => {
  if (mediaRecorder) { stopRecording(false); return; }
  if (!camImg || !lastFrameB64) { saveMsg("Start the camera first."); return; }
  if (typeof MediaRecorder === "undefined") { saveMsg("Recording is not supported here."); return; }

  recCanvas = document.createElement("canvas");
  recCanvas.width = 640; recCanvas.height = 360;
  recCtx = recCanvas.getContext("2d");
  drawFrameToCanvas(lastFrameB64);

  const stream = recCanvas.captureStream(12);
  const mime = ["video/webm;codecs=vp8", "video/webm"].find(
    (m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "video/webm";
  recChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start(1000);

  recStart = Date.now();
  $("#recDot").hidden = false;
  updateRecTimer();
  recTimer = setInterval(updateRecTimer, 1000);
  $("#rec").textContent = "Stop recording";
  $("#rec").classList.add("on");
  saveMsg("");
};

function stopRecording(silent) {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $("#recDot").hidden = true;
  $("#rec").textContent = "Record";
  $("#rec").classList.remove("on");
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    if (silent) mediaRecorder.onstop = null;    // discard on teardown
    try { mediaRecorder.stop(); } catch (e) { /* already stopped */ }
  }
  if (silent) { mediaRecorder = null; recCtx = null; recCanvas = null; recChunks = []; }
}

async function onRecordingStopped() {
  const chunks = recChunks;
  mediaRecorder = null; recCtx = null; recCanvas = null; recChunks = [];
  if (!chunks.length) { saveMsg("Nothing was recorded."); return; }
  saveMsg("Saving the clip…");
  try {
    const blob = new Blob(chunks, { type: "video/webm" });
    const b64 = await blobToB64(blob);
    await CameraStream.saveMedia({
      base64: b64, mime: "video/webm", filename: "sirius_" + stamp() + ".webm",
    });
    saveMsg("Video saved to your gallery (Sirius album).");
  } catch (e) {
    saveMsg("Could not save the video: " + (e && e.message ? e.message : e));
  }
}

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
