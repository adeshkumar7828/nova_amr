/*
  safedrive.cjs - LiDAR-aware driving for NOVA (copied from Scout's robot-server/safedrive.js).
  Runs inside Nova's server (app/server/server.js) on the laptop or the Jetson.

  1. SAFE DRIVE GATE (the "Safe drive" tab)
     Manual commands from that tab pass through gate() before they reach the robot:
       - forward is slowed when something is closer than slowCm
       - forward is refused when something is closer than stopCm,
         or when the LiDAR data is missing or older than 0.5 s
       - reverse and turning on the spot always pass, so you can always get out
     The check runs here (not in the page) so no page, phone or old tab can skip it.

  2. AUTO FORWARD ("wander")
     drive forward -> obstacle closer than stopCm -> stop
       -> look at the whole LiDAR scan, pick the open direction closest to straight ahead
       -> turn that way UNTIL THE LIDAR SAYS THE WAY AHEAD IS CLEAR (no timers to calibrate)
       -> drive forward again
     Stops by itself when: STOP / any drive button,
     no screen is open, the robot or the LiDAR goes quiet, blocked 4 times in a row,
     turning for 10 s without finding space, or no open direction anywhere.

  LiDAR input: POST /api/lidar {bins:[360 numbers], ageMs} from scan_to_front.py (ROS).
    bins[i] = closest return in cm at i degrees in the ROBOT's frame
              (0 = straight ahead, 90 = left, 270 = right), 0 = nothing seen.

  Distances:
    "corridor" = closest point inside a strip as wide as the robot (+ margin),
                 pointing in a given direction. A narrow cone would miss things that
                 hit the robot's corners.
    clear space ahead = corridor straight ahead minus frontCm (LiDAR -> front edge).
*/
"use strict";
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  stopCm: 50,      // closer than this (from the robot's front edge): no forward
  slowCm: 100,     // closer than this: forward speed is reduced
  widthCm: 40,     // robot width including wheels   (Nova: MEASURE and set on the page)
  frontCm: 15,     // LiDAR centre -> robot's front edge (Nova: MEASURE and set on the page)
  marginCm: 3,     // extra on each side of the corridor
  autoSpeed: 0.4,  // Auto forward drive power (0..1)
  autoTurn: 0.55,  // Auto forward turn power (0..1)
};
const LIMITS = {
  stopCm: [15, 200], slowCm: [25, 400], widthCm: [8, 100], frontCm: [0, 60],
  marginCm: [0, 20], autoSpeed: [0.2, 1], autoTurn: [0.2, 1],
};
const TICK_MS = 100;            // Auto forward control loop, 10x per second
const FRESH_MS = 500;           // LiDAR older than this = no data
const LOST_MS = 2000;           // Auto forward waits this long for LiDAR data, then gives up
const ROBOT_FRESH_MS = 1200;    // no telemetry for this long = robot lost
const TURN_TIMEOUT_MS = 10000;          // Nova is heavier and turns slower than Scout
const RETRY_WINDOW_MS = 2000;   // blocked again this soon after a turn counts as "tried again"
const MAX_TRIES = 4;
const MAX_CM = 600;
const D2R = Math.PI / 180;

function createSafeDrive({ dataDir, sendRobot, broadcast, setFrontSensor, onAutoStart, log = console.log }) {
  // ---------------------------------------------------------------- settings
  let st = { ...DEFAULTS };
  const file = path.join(dataDir, "safe.json");
  try { st = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { /* first run */ }
  function save() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(st, null, 2)); }
    catch (e) { log("[safe] could not save settings: " + e.message); }
  }

  // ------------------------------------------------------------------- state
  let bins = null, binsAt = 0, binsAge = 0;
  let lastTelemetryAt = 0, uiCount = 0, refusedAt = 0, lastBroadcast = 0;
  const auto = { state: "idle", msg: "", cls: "", since: 0, dir: 0, need: 0, tries: 0, lastTurnEnd: 0, lostSince: 0 };
  const autoActive = () => auto.state === "drive" || auto.state === "turn";

  // ---------------------------------------------------------------- geometry
  const fresh = (now = Date.now()) => !!bins && now - binsAt < FRESH_MS && binsAge < FRESH_MS;

  // Closest point (cm, measured from the LiDAR) inside a robot-wide strip pointing at
  // angle th (degrees, 0 = ahead, + = left). Points inside the robot's own outline
  // (its frame, standoffs, cables) are ignored.
  function corridor(th) {
    const half = st.widthCm / 2 + st.marginCm, c = Math.cos(th * D2R), s = Math.sin(th * D2R);
    let best = MAX_CM;
    for (let i = 0; i < 360; i++) {
      const r = bins[i];
      if (!r) continue;
      const x = r * Math.cos(i * D2R), y = r * Math.sin(i * D2R);
      if (Math.abs(y) <= st.widthCm / 2 && Math.abs(x) <= st.frontCm) continue;   // own body
      const xr = x * c + y * s, yr = -x * s + y * c;                               // rotate by -th
      if (xr > 0 && Math.abs(yr) <= half && xr < best) best = xr;
    }
    return best;
  }
  const aheadCm = () => Math.max(0, corridor(0) - st.frontCm);     // clear space in front of the bumper

  function zoneNow() {
    if (!fresh()) return { zone: "nodata", d: null };
    const d = aheadCm();
    return { zone: d < st.stopCm ? "blocked" : d < st.slowCm ? "slow" : "clear", d };
  }
  // speed factor in the slow zone: 35 % at the stop line, 100 % at the slow line
  const slowFactor = (d) => 0.35 + 0.65 * Math.max(0, Math.min(1, (d - st.stopCm) / (st.slowCm - st.stopCm)));

  // ------------------------------------------------------------- 1. the gate
  function gate(lin, ang) {
    if (lin <= 0) return { lin, ang };                              // reverse / turning: always allowed
    const z = zoneNow();
    if (z.zone === "blocked" || z.zone === "nodata") { refusedAt = Date.now(); return { lin: 0, ang }; }
    if (z.zone === "slow") return { lin: lin * slowFactor(z.d), ang };
    return { lin, ang };
  }

  // ------------------------------------------------------- 2. auto forward
  const cmd = (lin, ang) => sendRobot({ type: "velocity", linear: lin, angular: ang });
  const cmdStop = () => sendRobot({ type: "stop" });
  function setMsg(msg, cls) { if (auto.msg !== msg || auto.cls !== cls) { auto.msg = msg; auto.cls = cls; push(); } }

  function stopAuto(msg, cls = "alert", state = "idle") {
    const was = autoActive();
    auto.state = state; auto.msg = msg; auto.cls = cls;
    if (was) { cmdStop(); log("[safe] auto forward: " + msg); }
    push();
  }

  // Open direction closest to straight ahead (left first on a tie), in 15 degree steps.
  // Prefers directions with slowCm of space; otherwise the roomiest one with a little space.
  function pickDirection() {
    let fallback = null, fbD = 0;
    for (let a = 15; a <= 180; a += 15) {
      for (const th of a === 180 ? [180] : [a, -a]) {
        const d = corridor(th) - st.frontCm;
        if (d >= st.slowCm) return { th, need: st.slowCm };
        if (d > fbD) { fbD = d; fallback = th; }
      }
    }
    return fbD >= st.stopCm + 15 ? { th: fallback, need: st.stopCm + 15 } : null;
  }

  function startAuto() {
    const now = Date.now();
    if (now - lastTelemetryAt > ROBOT_FRESH_MS) return setMsg("Robot is offline: can't start.", "bad");
    if (!fresh(now)) return setMsg("No LiDAR data yet: see “LiDAR link” on this page.", "bad");
    onAutoStart();                                                  // a running Playground mission stops
    Object.assign(auto, { state: "drive", tries: 0, lastTurnEnd: 0, lostSince: 0, since: now });
    setMsg("Driving forward.", "run");
    log("[safe] auto forward started");
  }

  function tick() {
    const now = Date.now();
    // keep the "front_distance" reading honest when scans stop (missions + Sensor tab see it)
    if (bins && !fresh(now) && now - binsAt < 60000) {
      setFrontSensor({ value: MAX_CM, unit: "cm", valid: false, ageMs: now - binsAt, health: "no_signal", source: "lidar" });
    }
    if (uiCount > 0 && now - lastBroadcast >= 200) push();
    if (!autoActive()) return;

    if (now - lastTelemetryAt > ROBOT_FRESH_MS) return stopAuto("Lost contact with the robot: Auto forward stopped.", "bad");
    if (!fresh(now)) {
      if (!auto.lostSince) auto.lostSince = now;
      if (now - auto.lostSince > LOST_MS) return stopAuto("LiDAR data stopped arriving: Auto forward stopped.", "bad");
      setMsg("Waiting for LiDAR data…", "alert");
      return cmdStop();
    }
    auto.lostSince = 0;
    const d = aheadCm();

    if (auto.state === "drive") {
      if (d < st.stopCm) {
        auto.tries = now - auto.lastTurnEnd < RETRY_WINDOW_MS ? auto.tries + 1 : 1;
        if (auto.tries > MAX_TRIES) return stopAuto(`Stuck: blocked ${MAX_TRIES} times in a row. Clear the way, then press Auto forward again.`, "bad", "stuck");
        const p = pickDirection();
        if (!p) return stopAuto("Boxed in: no open direction anywhere around the robot.", "bad", "stuck");
        Object.assign(auto, { state: "turn", dir: p.th, need: p.need, since: now });
        setMsg(`Obstacle ${d.toFixed(0)} cm ahead. Turning ${p.th > 0 ? "left" : "right"} towards open space (about ${Math.abs(p.th)}°).`, "alert");
        log(`[safe] obstacle at ${d.toFixed(0)} cm, turning towards ${p.th}°`);
        return cmdStop();
      }
      if (d < st.slowCm) { setMsg(`Slowing down: something ${d.toFixed(0)} cm ahead.`, "run"); return cmd(st.autoSpeed * slowFactor(d), 0); }
      setMsg("Driving forward. Way ahead is clear.", "run");
      return cmd(st.autoSpeed, 0);
    }

    // turning: until the way ahead is clear enough
    if (d >= auto.need) {
      auto.state = "drive"; auto.lastTurnEnd = now;
      setMsg("Way clear. Driving forward.", "run");
      return cmdStop();                                             // drive resumes on the next tick
    }
    if (now - auto.since > TURN_TIMEOUT_MS) return stopAuto("Turned for 10 s without finding a clear way. Clear the way, then try again.", "bad", "stuck");
    return cmd(0, st.autoTurn * Math.sign(auto.dir));
  }
  setInterval(tick, TICK_MS);

  // ---------------------------------------------------------------- outputs
  function radar() {                                                // 72 bins of 5 degrees for the page
    const out = new Array(72).fill(0);
    if (!bins) return out;
    for (let i = 0; i < 360; i++) {
      const r = bins[i], k = Math.floor(i / 5);
      if (r && (!out[k] || r < out[k])) out[k] = r;
    }
    return out;
  }
  function snapshot() {
    const now = Date.now(), z = zoneNow();
    return {
      type: "safe", fresh: fresh(now), ageMs: bins ? now - binsAt + binsAge : null,
      ahead: z.d === null ? null : Math.round(z.d), zone: z.zone, refused: now - refusedAt < 700,
      st, auto: { state: auto.state, msg: auto.msg, cls: auto.cls }, radar: radar(),
    };
  }
  function push() { lastBroadcast = Date.now(); if (uiCount > 0) broadcast(snapshot()); }

  // ----------------------------------------------------------------- events
  function onScan(body) {
    if (!body || !Array.isArray(body.bins) || body.bins.length !== 360) throw new Error("bins must be 360 numbers");
    bins = body.bins.map((v) => (Number(v) > 0 ? Number(v) : 0));
    binsAt = Date.now(); binsAge = Math.max(0, Number(body.ageMs) || 0);
    const front = Math.min(MAX_CM, corridor(0));                    // from the LiDAR, like the old ultrasonic
    setFrontSensor({ value: Math.round(front * 10) / 10, unit: "cm", valid: binsAge < FRESH_MS,
      ageMs: binsAge, health: binsAge < FRESH_MS ? "ok" : "no_signal", source: "lidar" });
  }

  function onIntent(m) {
    switch (m.action) {
      case "autoStart": if (!autoActive()) startAuto(); break;
      case "autoStop": stopAuto("Auto forward stopped."); break;
      case "settings": {
        const v = m.settings || {};
        for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
          const n = Number(v[k]);
          if (v[k] !== undefined && v[k] !== "" && Number.isFinite(n)) st[k] = Math.max(lo, Math.min(hi, n));
        }
        if (st.slowCm < st.stopCm + 10) st.slowCm = st.stopCm + 10;
        save(); log(`[safe] settings: stop ${st.stopCm} cm, slow ${st.slowCm} cm, width ${st.widthCm} cm, front ${st.frontCm} cm`);
        push(); break;
      }
      default: return;
    }
  }

  return {
    gate, onScan, onIntent, snapshot,
    isActive: autoActive,
    onTelemetry() { lastTelemetryAt = Date.now(); },
    onManualDrive() { if (autoActive()) stopAuto("Manual driving took over: Auto forward stopped."); },
    cancel(reason) { if (autoActive()) stopAuto(reason); },
    onRobotConnected(c) { if (!c && autoActive()) stopAuto("Robot disconnected: Auto forward stopped.", "bad"); },
    onUiCount(n) { uiCount = n; if (n === 0 && autoActive()) stopAuto("No screen is open: Auto forward stopped."); },
  };
}

module.exports = { createSafeDrive };
