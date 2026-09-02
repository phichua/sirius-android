/*
 * Sirius protocol client - talks straight to the dog from the phone.
 *
 * Firmware 2.4.3 serves ws://<ip>:8765/?audience=web with LOWERCASE command
 * names in a request/response envelope, and pushes emotion_update events.
 * There is no laptop and no bridge in this path.
 */

const PORT_WS = 8765;
const PORT_VIDEO = 8080;
const CONTROL_HZ = 8;
const ACTION_PRIORITY = 5;      // below this, autonomous behaviour wins
const AUDIO_NODE = "wmix_audio_player_node";   // volume lives on a ROS parameter

export class Sirius extends EventTarget {
  constructor() {
    super();
    this.host = null;
    this.ws = null;
    this.connected = false;
    this.estop = false;
    this.version = null;
    this.robotMode = null;
    this.actions = [];
    this.battery = {};
    this.emotion = {};
    this.vel = { linear_x: 0, linear_y: 0, angular_z: 0 };
    this.posture = { body_pitch: 0, body_yaw: 0, body_roll: 0, head_pitch: 0, head_yaw: 0 };
    this.throttle = 0.6;
    this.volume = null;
    this.log = [];
    this._pending = new Map();
    this._seq = 0;
    this._timer = null;
  }

  note(msg) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    this.dispatchEvent(new CustomEvent("log", { detail: line }));
  }

  changed() {
    this.dispatchEvent(new Event("change"));
  }

  // ---- connection --------------------------------------------------
  connect(host) {
    return new Promise((resolve) => {
      this.disconnect();
      this.host = host;
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(`ws://${host}:${PORT_WS}/?audience=web`);
      } catch (e) {
        this.note(`Could not open socket: ${e}`);
        return resolve(false);
      }
      this.ws = ws;

      const fail = (why) => {
        if (settled) return;
        settled = true;
        this.connected = false;
        this.note(why);
        this.changed();
        resolve(false);
      };

      const guard = setTimeout(() => {
        try { ws.close(); } catch (e) { /* already gone */ }
        fail(`No answer from ${host}:${PORT_WS}. Same Wi-Fi as the dog?`);
      }, 8000);

      ws.onopen = async () => {
        clearTimeout(guard);
        settled = true;
        this.connected = true;
        this.estop = false;
        this.note(`Connected to ${host}`);
        this.changed();
        this._startLoop();
        await this._hello();
        resolve(true);
      };
      ws.onerror = () => { clearTimeout(guard); fail(`Connection to ${host} failed.`); };
      ws.onclose = () => {
        clearTimeout(guard);
        if (this.connected) {
          this.connected = false;
          this.note("Link lost.");
          this.changed();
        }
        this._stopLoop();
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
    });
  }

  disconnect() {
    this._stopLoop();
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* already gone */ }
    }
    this.ws = null;
    this.connected = false;
  }

  async _hello() {
    const info = await this.request("check_update");
    if (info) {
      this.version = info.current_version;
      this.note(`firmware ${info.current_version}`
        + (info.latest_version ? ` (latest ${info.latest_version})` : ""));
    }
    const mode = await this.request("get_robot_mode");
    if (mode) this.robotMode = mode.robot_mode;
    if (this.robotMode === "desktop") {
      this.note("Desktop mode: gait is restricted so it will not walk off a table.");
    }
    const list = await this.request("get_actions", {}, 10000);
    if (list) this.actions = list.actions || [];
    this.note(`${this.actions.length} actions available`);
    this.refreshBattery();
    this.getVolume();
    this.changed();
  }

  // ---- transport ---------------------------------------------------
  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    const rid = msg.request_id;
    if (rid && this._pending.has(rid)) {
      const { resolve, timer } = this._pending.get(rid);
      clearTimeout(timer);
      this._pending.delete(rid);
      if (msg.success) resolve(msg.data || {});
      else { this.note(`${rid.split("|")[1] || "request"}: ${msg.error}`); resolve(null); }
      return;
    }
    if (msg.event_type === "emotion_update") {
      this.emotion = msg.data || {};
      this.changed();
    }
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }

  /** Fire and forget - used for the 8 Hz control stream. */
  fire(name, data = {}) {
    return this._send({
      type: "request", request_type: name,
      request_id: `f${++this._seq}|${name}`, data,
    });
  }

  /** Send and await the reply. Resolves to data, or null on error/timeout. */
  request(name, data = {}, timeout = 6000) {
    return new Promise((resolve) => {
      const rid = `r${++this._seq}|${name}`;
      const timer = setTimeout(() => {
        this._pending.delete(rid);
        this.note(`${name}: no reply`);
        resolve(null);
      }, timeout);
      this._pending.set(rid, { resolve, timer });
      if (!this._send({ type: "request", request_type: name, request_id: rid, data })) {
        clearTimeout(timer);
        this._pending.delete(rid);
        resolve(null);
      }
    });
  }

  // ---- driving -----------------------------------------------------
  setVelocity(v) {
    const clamp = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
    if ("linear_x" in v) this.vel.linear_x = clamp(v.linear_x);
    if ("linear_y" in v) this.vel.linear_y = clamp(v.linear_y);
    if ("angular_z" in v) this.vel.angular_z = clamp(v.angular_z);
  }

  get moving() {
    return Math.abs(this.vel.linear_x) > 0.001
      || Math.abs(this.vel.linear_y) > 0.001
      || Math.abs(this.vel.angular_z) > 0.001;
  }

  _startLoop() {
    this._stopLoop();
    this._timer = setInterval(() => {
      if (!this.connected || this.estop) return;
      if (this.moving) {
        const s = this.throttle;
        this.fire("gait_control", {
          linear_x: +(this.vel.linear_x * s).toFixed(4),
          linear_y: +(this.vel.linear_y * s).toFixed(4),
          angular_z: +(this.vel.angular_z * s).toFixed(4),
        });
      }
    }, 1000 / CONTROL_HZ);
  }

  _stopLoop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  setPosture(p) {
    const clamp = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
    for (const k of Object.keys(this.posture)) {
      if (k in p) this.posture[k] = clamp(p[k]);
    }
    // Documented safe range is well inside +/-0.524 rad.
    const out = {};
    for (const [k, v] of Object.entries(this.posture)) out[k] = +(v * 0.35).toFixed(4);
    this.fire("attitude_control", out);
  }

  /** Zero the gait and cancel anything playing. Repeated - a frame can drop. */
  async stop() {
    this.vel = { linear_x: 0, linear_y: 0, angular_z: 0 };
    for (let i = 0; i < 2; i++) {
      this.fire("gait_control", { linear_x: 0, linear_y: 0, angular_z: 0 });
      this.fire("stop_all_motions");
      this.fire("cancel_motion");
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async emergencyStop() {
    this.estop = true;
    await this.stop();
    this.fire("set_behavior_pause", { paused: true });
    this.note("EMERGENCY STOP");
    this.changed();
  }

  clearEstop() {
    this.estop = false;
    this.fire("set_behavior_pause", { paused: false });
    this.note("Emergency stop cleared");
    this.changed();
  }

  // ---- actions and modes -------------------------------------------
  play(id) {
    const a = this.actions.find((x) => (x.id || x.filename) === id);
    if (!a) return false;
    this.fire("play_motion", {
      file_path: a.full_path, loop: false,
      priority: ACTION_PRIORITY, torque: 2047,
    });
    this.note(`action: ${a.display_name || id}`);
    return true;
  }

  standUp() {
    this.fire("self_recover");
    this.note("stand up");
  }

  async setRobotMode(mode) {
    if (mode !== "ground" && mode !== "desktop") return false;
    const ok = await this.request("set_robot_mode", { robot_mode: mode });
    if (ok !== null) {
      this.robotMode = mode;
      this.note(`walking mode -> ${mode}`);
      this.changed();
      return true;
    }
    return false;
  }

  /**
   * Volume is not a command - it is a ROS parameter on the audio node, reached
   * through get/set_node_parameter. Range 0-100.
   */
  async getVolume() {
    const r = await this.request("get_node_parameter",
      { node_name: AUDIO_NODE, parameter_name: "audio_volume" });
    const v = r && r.parameters && r.parameters.audio_volume;
    if (typeof v === "number") { this.volume = v; this.changed(); }
    return this.volume;
  }

  async setVolume(v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const r = await this.request("set_node_parameter",
      { node_name: AUDIO_NODE, parameter_name: "audio_volume", parameter_value: v });
    if (r === null) { this.note("could not set the volume"); return false; }
    this.volume = v;
    this.note(`volume ${v}%`);
    this.changed();
    return true;
  }

  async refreshBattery() {
    const b = await this.request("get_battery_status", {}, 5000);
    if (b) { this.battery = b; this.changed(); }
  }

  /**
   * The MJPEG server answers on /video_stream even when nothing is publishing
   * into it - you get headers, then silence, and the picture never appears.
   * enable_detection is what actually starts the frames ("Web streaming
   * enabled"), so the camera must always be switched on before the <img> loads.
   */
  async enableVision(on) {
    const r = await this.request("enable_detection", { enabled: !!on });
    this.note(on
      ? (r ? "camera streaming on" : "could not start the camera")
      : "camera streaming off");
    return r !== null;
  }

  streamUrl() {
    return `http://${this.host}:${PORT_VIDEO}/video_stream`;
  }
}
