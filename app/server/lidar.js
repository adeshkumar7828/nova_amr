/*
  lidar.js - reads Nova's Slamtec C1 LiDAR directly from the laptop (no Jetson, no ROS).

    LiDAR --serial--> Nova ESP32 (lidar_bridge, TCP 8899) --Wi-Fi--> THIS FILE --> safedrive.cjs

  The ESP32 only relays bytes. This file speaks the RPLIDAR serial protocol itself:
    1. connect to <nova-ip>:8899
    2. send STOP, then "motor default speed", then SCAN (the C1 spins up on SCAN)
    3. read the reply header (A5 5A 05 00 00 40 81) and then 5-byte measurement packets:
         byte0  bit0 = S (first point of a new turn), bit1 = !S, bits2-7 = quality
         byte1  bit0 = check bit (always 1), bits1-7 = angle low bits
         byte2  angle high bits            -> angle = ((b2<<7)|(b1>>1)) / 64  degrees
         byte3-4 distance (little endian)  -> distance = value / 4           mm
       A packet that fails the S / !S / check-bit test means we lost step: skip 1 byte and resync.
    4. every full turn -> 360 one-degree bins in Nova's frame -> onScan({bins, ageMs})
       (exactly what scan_to_front.py sends on Scout, so safedrive.cjs is unchanged)

  Angles: the LiDAR measures CLOCKWISE from its printed arrow. Nova's frame is
  0 = straight ahead, 90 = left (counter-clockwise), like Scout. With the arrow facing
  Nova's front:  robotDeg = 360 - lidarDeg.  'arrowDeg' rotates that if the LiDAR is mounted
  another way, 'mirror' flips left/right if objects show up on the wrong side.

  Runs only while it's needed: Nova connected + its firmware has the bridge + a page is open
  (+ source = laptop). Closing the link makes the ESP32 stop/reset the LiDAR, so it stops spinning.
*/
import net from 'node:net';

const CMD = {
  STOP: Buffer.from([0xa5, 0x25]),
  SCAN: Buffer.from([0xa5, 0x20]),
  MOTOR_DEFAULT: Buffer.from([0xa5, 0xa8, 0x02, 0xff, 0xff, 0x0f]),  // speed 0xFFFF = "default" (what the Slamtec driver sends)
};
const SCAN_HEADER = Buffer.from([0xa5, 0x5a, 0x05, 0x00, 0x00, 0x40, 0x81]);
const NO_DATA_MS = 3000;           // connected but no points for this long -> reconnect
const RETRY_MS = 2000;
const IDLE_CLOSE_MS = 10000;       // no page open this long -> stop the LiDAR
const MAX_SCAN_HZ = 15;
const MAX_CM = 1200;

export function createLidarReader({ onScan, getTarget, wanted, settings, log = console.log }) {
  let sock = null, state = 'off', msg = 'Waiting for Nova.', retryTimer = null, startTimer = null;
  let buf = Buffer.alloc(0), headerSeen = false;
  let lastPointAt = 0, lastScanSentAt = 0, connectedAt = 0, idleSince = 0;
  let turn = new Array(360).fill(0), turnPoints = 0;
  let stats = { scansPerSec: 0, pointsPerScan: 0, resyncs: 0, bytes: 0 };
  let scanCount = 0, rateStart = Date.now();
  let target = null;

  const logged = new Map();                        // message -> last time logged (no spam while retrying)
  function setState(s, m) {
    if (s === state && m === msg) return;
    state = s; msg = m;
    const now = Date.now();
    if (s !== 'scanning' && now - (logged.get(m) || 0) > 30000) { logged.set(m, now); log(`[lidar] ${m}`); }
  }

  function close(reason, next = 'off') {
    clearTimeout(startTimer); startTimer = null;
    if (sock) { sock.removeAllListeners(); sock.destroy(); sock = null; }
    buf = Buffer.alloc(0); headerSeen = false;
    setState(next, reason);
  }

  function connect(t) {
    target = t;
    setState('connecting', `Connecting to Nova's LiDAR at ${t.ip}:${t.port}…`);
    buf = Buffer.alloc(0); headerSeen = false; turnPoints = 0; turn.fill(0);
    const s = net.createConnection({ host: t.ip, port: t.port });
    sock = s;
    s.setNoDelay(true);
    s.setTimeout(5000, () => { if (state === 'connecting') { close('Could not reach the LiDAR bridge (timeout).', 'error'); retryLater(); } });
    s.on('connect', () => {
      s.setTimeout(0);
      connectedAt = Date.now(); lastPointAt = Date.now();
      setState('starting', 'Connected. Starting the LiDAR…');
      // ESP32 already sent STOP on connect; do it again, then motor default, then SCAN
      s.write(CMD.STOP);
      startTimer = setTimeout(() => {
        if (sock !== s) return;
        buf = Buffer.alloc(0);
        s.write(CMD.MOTOR_DEFAULT);
        startTimer = setTimeout(() => { if (sock === s) s.write(CMD.SCAN); }, 100);
      }, 60);
    });
    s.on('data', onData);
    s.on('error', (e) => { close(`LiDAR link error: ${e.message}`, 'error'); retryLater(); });
    s.on('close', () => { if (sock === s) { close('LiDAR link closed.', 'error'); retryLater(); } });
  }

  function retryLater() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; check(); }, RETRY_MS);
  }

  function onData(chunk) {
    stats.bytes += chunk.length;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!headerSeen) {
      const i = buf.indexOf(SCAN_HEADER);
      if (i < 0) { if (buf.length > 4096) buf = buf.subarray(buf.length - 16); return; }
      buf = buf.subarray(i + SCAN_HEADER.length);
      headerSeen = true;
      setState('scanning', 'LiDAR scanning.');
      log('[lidar] scanning: LiDAR data from Nova is arriving');
    }
    let off = 0;
    while (buf.length - off >= 5) {
      const b0 = buf[off], b1 = buf[off + 1];
      const s = b0 & 1, ns = (b0 >> 1) & 1, c = b1 & 1;
      if (s === ns || c !== 1) { off += 1; stats.resyncs++; continue; }        // lost step: shift one byte
      const quality = b0 >> 2;
      const angle = ((buf[off + 2] << 7) | (b1 >> 1)) / 64;                    // degrees, clockwise
      const distMm = (buf[off + 3] | (buf[off + 4] << 8)) / 4;
      off += 5;
      if (angle >= 360.5) { stats.resyncs++; continue; }
      if (s === 1 && turnPoints > 0) finishTurn();
      lastPointAt = Date.now();
      turnPoints++;
      if (quality === 0 || distMm <= 0) continue;
      const cm = Math.min(MAX_CM, Math.round(distMm / 10));
      if (cm < 3) continue;
      const st = settings();
      let deg = 360 - angle;                       // clockwise -> counter-clockwise (Nova frame)
      if (st.lidarMirror) deg = -deg;
      deg += st.lidarArrowDeg || 0;                // where the arrow points: 0 front, 90 left, 180 back, 270 right
      const b = ((Math.round(deg) % 360) + 360) % 360;
      if (!turn[b] || cm < turn[b]) turn[b] = cm;
    }
    buf = buf.subarray(off);
  }

  function finishTurn() {
    const now = Date.now();
    scanCount++;
    stats.pointsPerScan = turnPoints;
    if (turnPoints >= 100 && now - lastScanSentAt >= 1000 / MAX_SCAN_HZ) {
      lastScanSentAt = now;
      try { onScan({ bins: turn.slice(), ageMs: 0, source: 'laptop' }); } catch (e) { log('[lidar] ' + e.message); }
    }
    turn.fill(0); turnPoints = 0;
  }

  // called every 500 ms by the server: open / close the link as needed
  function check() {
    const now = Date.now();
    if (now - rateStart >= 2000) { stats.scansPerSec = +(scanCount * 1000 / (now - rateStart)).toFixed(1); scanCount = 0; rateStart = now; }
    const t = getTarget();                           // {ip, port} or null
    const want = !!t && wanted();
    if (!want) {
      if (!t) { if (sock) close('Nova disconnected: LiDAR link closed.', 'off'); else setState('off', 'Waiting for Nova (with the LiDAR firmware).'); return; }
      if (!idleSince) idleSince = now;
      if (sock && now - idleSince > IDLE_CLOSE_MS) close('No page open: LiDAR stopped.', 'off');
      else if (!sock) setState('off', 'LiDAR is off (opens when a page is open).');
      return;
    }
    idleSince = 0;
    if (sock && target && (t.ip !== target.ip || t.port !== target.port)) close('Nova moved to a new IP.', 'off');
    if (!sock) { if (!retryTimer) connect(t); return; }
    if ((state === 'starting' || state === 'scanning') && now - lastPointAt > NO_DATA_MS) {
      close(state === 'starting'
        ? 'No answer from the LiDAR. Check its wires (yellow→G34, green→G18) and 5 V power. Retrying…'
        : 'LiDAR data stopped. Restarting the LiDAR…', 'error');
      retryLater();
    }
  }
  setInterval(check, 500);

  return {
    status: () => ({ state, msg, ...stats, target }),
    restart() { close('Restarting the LiDAR…', 'off'); clearTimeout(retryTimer); retryTimer = null; check(); },
    stop(reason = 'LiDAR stopped.') { close(reason, 'off'); },
  };
}
