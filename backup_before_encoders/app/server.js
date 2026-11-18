/*
  Nova server - sits between the control page (React) and Nova's ESP32.

    Browser  --ws /ui-->    server  --ws /robot-->  ESP32 (Nova)
             <-telemetry--          <-telemetry--

  - Serves the built React page (web/dist) on http://<this-pc>:8090
  - Every second it shouts "Nova server here" on UDP 4211, so the ESP32
    finds it without typing IP addresses (Scout uses 8080 / 4210, so both
    servers can run at the same time without mixing up).
  - Safety: if the page stops sending drive commands (tab closed, Wi-Fi
    drop, finger lifted) the server sends "stop" right away. The ESP32
    also stops by itself after 0.5 s without commands.

  LiDAR (two ways, chosen with the setting lidarSource):
    'laptop' (default, no Jetson): LiDAR -> Nova's ESP32 (lidar_bridge, TCP 8899) -> Wi-Fi ->
             lidar.js here reads and decodes it -> safedrive.cjs (Safe drive gate + Auto forward)
    'jetson' (like Scout): ... -> Jetson rplidar_ros -> scan_to_front.py -> POST /api/lidar here
             (the Jetson finds Nova's IP with GET /api/robot)

  Page  -> server : {type:"drive", linear, angular}   while a button/key is held (10x per second)
                    {type:"drive", ..., safe:true}    from the Safe drive page: checked against the LiDAR first
                    {type:"safe", action:"autoStart"|"autoStop"|"settings", settings}
                    {type:"stop"}
                    {type:"wheel", left, right}       one-wheel test
                    {type:"settings", ...}            maxPower, minDuty, invertLeft, ...
  Robot -> server : {type:"hello"|"telemetry", ...}
  Server -> page  : {type:"status", robot:{connected, ip, since}, settings, addresses}
                    {type:"telemetry", ...}, {type:"safe", ...} (LiDAR view + Auto forward state)
*/
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSafeDrive } = require('./safedrive.cjs');
import { createLidarReader } from './lidar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NOVA_PORT) || 8090;
const DISCOVERY_PORT = 4211;
const DRIVE_TIMEOUT_MS = 300;          // no drive message for this long -> stop

// ---------- settings (saved to data/settings.json) ----------
const DATA_DIR = path.join(HERE, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  maxPower: 0.6,       // speed cap (0..1); 60% while on the small converters
  minDuty: 40,         // smallest PWM (0..255) that turns the wheel
  invertLeft: false,
  invertRight: true,
  trimLeft: 1.0,       // 0.5..1, slow down the faster wheel so Nova drives straight
  trimRight: 1.0,
  lidarSource: 'laptop',   // 'laptop' = this server reads the LiDAR itself, 'jetson' = scans come from ROS
  lidarArrowDeg: 0,        // where the LiDAR's arrow points on Nova: 0 front, 90 left, 180 back, 270 right
  lidarMirror: false,      // true if objects show up on the wrong side (left/right swapped)
};
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }

function saveSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function cleanSettings(s) {
  const out = {};
  const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  if (num(s.maxPower, 0, 1) !== undefined) out.maxPower = num(s.maxPower, 0, 1);
  if (num(s.minDuty, 0, 200) !== undefined) out.minDuty = Math.round(num(s.minDuty, 0, 200));
  if (num(s.trimLeft, 0.5, 1) !== undefined) out.trimLeft = num(s.trimLeft, 0.5, 1);
  if (num(s.trimRight, 0.5, 1) !== undefined) out.trimRight = num(s.trimRight, 0.5, 1);
  if (typeof s.invertLeft === 'boolean') out.invertLeft = s.invertLeft;
  if (typeof s.invertRight === 'boolean') out.invertRight = s.invertRight;
  if (s.lidarSource === 'laptop' || s.lidarSource === 'jetson') out.lidarSource = s.lidarSource;
  if ([0, 90, 180, 270].includes(s.lidarArrowDeg)) out.lidarArrowDeg = s.lidarArrowDeg;
  if (typeof s.lidarMirror === 'boolean') out.lidarMirror = s.lidarMirror;
  return out;
}

// ---------- web page ----------
const app = express();
const DIST = path.join(HERE, '..', 'web', 'dist');
app.use(express.static(DIST));
app.get('/api/status', (_req, res) => res.json(statusMsg()));

// ---- used by the Jetson's ROS side (same API as Scout's robot-server) ----
//   GET  /api/robot -> {connected, ip, lidarPort}   lidar_wifi_link.sh needs Nova's IP
//   POST /api/lidar -> {bins:[360 cm values], ageMs} from scan_to_front.py
app.get('/api/robot', (_req, res) => res.json({ connected: robotUp(), ip: robotInfo.ip, lidarPort: robotInfo.lidarPort }));
app.post('/api/lidar', express.json({ limit: '16kb' }), (req, res) => {
  if (settings.lidarSource !== 'jetson') { res.status(409).send('Nova server reads the LiDAR itself (lidarSource = laptop)'); return; }
  try {
    safe.onScan(req.body);
    if (!lidarFrom) console.log(`[lidar] scans arriving from ${req.socket.remoteAddress?.replace('::ffff:', '')}`);
    lidarFrom = req.socket.remoteAddress?.replace('::ffff:', '') || '?';
    lidarAt = Date.now();
    res.status(204).end();
  } catch (e) { res.status(400).send(String(e.message)); }
});
app.post('/api/sensor', express.json({ limit: '4kb' }), (_req, res) => res.status(204).end());   // accepted, not used yet
app.get('*', (_req, res) => {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).send('Page not built yet. In the app folder run:  npm start');
});
const server = http.createServer(app);

// ---------- addresses (page header + discovery) ----------
function ipv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || name.startsWith('docker') || name.startsWith('vEthernet')) continue;
      out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}
function broadcastAddr({ address, netmask }) {
  const a = address.split('.').map(Number), m = netmask.split('.').map(Number);
  return a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.');
}

// ---------- WebSockets ----------
const robotWss = new WebSocketServer({ noServer: true });
const uiWss = new WebSocketServer({ noServer: true });
let robot = null;                 // the ESP32's socket
let robotInfo = { ip: null, since: null, lidarPort: null };
let lastTelemetryAt = 0;
let lidarFrom = null, lidarAt = 0;           // who sends LiDAR scans (the Jetson), and when
const robotUp = () => !!robot && robot.readyState === WebSocket.OPEN;

server.on('upgrade', (req, socket, head) => {
  const url = req.url.split('?')[0];
  if (url === '/robot') robotWss.handleUpgrade(req, socket, head, (ws) => robotWss.emit('connection', ws, req));
  else if (url === '/ui') uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit('connection', ws, req));
  else socket.destroy();
});

function sendRobot(msg) {
  if (robot && robot.readyState === WebSocket.OPEN) robot.send(JSON.stringify(msg));
}
function toUis(msg) {
  const s = JSON.stringify(msg);
  for (const c of uiWss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}
function statusMsg() {
  return {
    type: 'status',
    robot: {
      connected: !!robot && robot.readyState === WebSocket.OPEN,
      ip: robotInfo.ip,
      since: robotInfo.since,
      telemetryAgeMs: lastTelemetryAt ? Date.now() - lastTelemetryAt : null,
    },
    settings,
    addresses: ipv4s().map((i) => `http://${i.address}:${PORT}`),
    driver: driver ? true : false,
    lidar: {
      source: settings.lidarSource,
      bridgePort: robotInfo.lidarPort,                         // ESP32 firmware has the LiDAR bridge
      scansFrom: lidarAt && Date.now() - lidarAt < 3000 ? lidarFrom : null,
      lastScanAgoMs: lidarAt ? Date.now() - lidarAt : null,
      reader: lidar ? lidar.status() : null,                   // laptop reader: state, msg, scansPerSec, ...
    },
  };
}

// ---------- Safe drive + Auto forward (LiDAR) ----------
const safe = createSafeDrive({
  dataDir: DATA_DIR,
  sendRobot,
  broadcast: toUis,
  setFrontSensor: () => {},                 // Scout's Sensor tab used this; Nova doesn't need it yet
  onAutoStart: () => { moving = false; driver = null; },   // the dead-man must not fight Auto forward
});

// ---------- LiDAR read directly by this server (lidarSource = 'laptop') ----------
const lidar = createLidarReader({
  onScan: (scan) => { safe.onScan(scan); lidarFrom = 'laptop (direct)'; lidarAt = Date.now(); },
  getTarget: () => (robotUp() && robotInfo.ip && robotInfo.lidarPort ? { ip: robotInfo.ip, port: robotInfo.lidarPort } : null),
  wanted: () => settings.lidarSource === 'laptop' && uiWss.clients.size > 0,
  settings: () => settings,
});

// ---- robot side ----
robotWss.on('connection', (ws, req) => {
  if (robot && robot !== ws) { try { robot.terminate(); } catch { /* ignore */ } }   // newest connection wins
  robot = ws;
  robotInfo = { ip: req.socket.remoteAddress?.replace('::ffff:', ''), since: Date.now(), lidarPort: null };
  console.log(`[robot] Nova connected from ${robotInfo.ip}`);
  sendRobot({ type: 'stop' });
  sendRobot({ type: 'config', ...settings });
  toUis(statusMsg());
  safe.onRobotConnected(true);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'telemetry') { lastTelemetryAt = Date.now(); safe.onTelemetry(); toUis(msg); }
    else if (msg.type === 'hello') {
      robotInfo.ip = msg.ip || robotInfo.ip;
      robotInfo.lidarPort = msg.lidarPort || null;
      console.log(`[robot] hello: Nova IP ${robotInfo.ip}${robotInfo.lidarPort ? `, LiDAR bridge on port ${robotInfo.lidarPort}` : ' (no LiDAR bridge in this firmware)'}`);
      toUis(msg); toUis(statusMsg());
    }
  });
  ws.on('close', () => {
    if (robot === ws) {
      robot = null;
      console.log('[robot] Nova disconnected');
      safe.onRobotConnected(false);
      toUis(statusMsg());
    }
  });
  ws.on('error', () => {});
});

// ---- page side ----
// Only ONE page drives at a time (the last one that pressed a button).
let driver = null;
let lastDriveAt = 0;
let moving = false;

function stopAll(reason) {
  sendRobot({ type: 'stop' });
  if (moving) console.log(`[drive] stop (${reason})`);
  moving = false;
  driver = null;
}

uiWss.on('connection', (ws, req) => {
  console.log(`[ui] page connected from ${req.socket.remoteAddress?.replace('::ffff:', '')}`);
  ws.send(JSON.stringify(statusMsg()));
  ws.send(JSON.stringify(safe.snapshot()));
  safe.onUiCount(uiWss.clients.size);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'drive' || msg.type === 'wheel') {
      safe.onManualDrive();                    // any drive button ends Auto forward
      driver = ws;
      lastDriveAt = Date.now();
      if (msg.type === 'drive') {
        let linear = clamp(msg.linear), angular = clamp(msg.angular);
        moving = linear !== 0 || angular !== 0;
        if (msg.safe && moving) ({ lin: linear, ang: angular } = safe.gate(linear, angular));   // LiDAR check
        sendRobot(linear || angular ? { type: 'velocity', linear, angular } : { type: 'stop' });
      } else {
        const left = clamp(msg.left), right = clamp(msg.right);
        moving = left !== 0 || right !== 0;
        sendRobot(moving ? { type: 'wheels', left, right } : { type: 'stop' });
      }
    } else if (msg.type === 'stop') {
      safe.cancel('Stopped.');
      stopAll('stop button');
    } else if (msg.type === 'safe') {
      safe.onIntent(msg);
    } else if (msg.type === 'lidar' && msg.action === 'restart') {
      lidar.restart();
    } else if (msg.type === 'settings') {
      const before = settings.lidarSource;
      settings = { ...settings, ...cleanSettings(msg) };
      if (settings.lidarSource !== before && settings.lidarSource === 'jetson') lidar.stop('LiDAR source = Jetson: laptop reader off.');
      if (msg.reset) settings = { ...DEFAULT_SETTINGS };
      saveSettings();
      sendRobot({ type: 'config', ...settings });
      console.log('[settings]', JSON.stringify(settings));
      toUis(statusMsg());
    }
  });
  ws.on('close', () => {
    if (driver === ws) stopAll('page closed');
    safe.onUiCount([...uiWss.clients].filter((c) => c !== ws && c.readyState === WebSocket.OPEN).length);
  });
  ws.on('error', () => {});
});

function clamp(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(Math.max(-1, Math.min(1, n)) * 100) / 100;
}

// Dead-man: the page repeats drive messages every 100 ms while a button is held.
setInterval(() => {
  if (moving && Date.now() - lastDriveAt > DRIVE_TIMEOUT_MS) stopAll('no drive message - finger lifted or page lost');
}, 50);

setInterval(() => toUis(statusMsg()), 1000);

// ---------- "Nova server here" beacon ----------
const beacon = dgram.createSocket('udp4');
beacon.bind(() => {
  beacon.setBroadcast(true);
  setInterval(() => {
    const msg = Buffer.from(JSON.stringify({ novaServer: 1, port: PORT }));
    for (const i of ipv4s()) beacon.send(msg, DISCOVERY_PORT, broadcastAddr(i), () => {});
  }, 1000);
});
beacon.on('error', (e) => console.log('[discovery] ' + e.message));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`\nPort ${PORT} is busy - is the Nova server already running in another window?\n`);
  else console.log(e);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n=== Nova server running ===');
  console.log(`Open the control page:  http://localhost:${PORT}`);
  for (const a of statusMsg().addresses) console.log(`  (from a phone on the same Wi-Fi: ${a})`);
  console.log('Waiting for Nova (ESP32) to connect...\n');
});
