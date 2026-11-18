# Nova AMR

2-wheel differential-drive robot: 2× 12 V encoder gear motors, each on its own IBT-4,
ESP32 brain, controlled over Wi-Fi from a React page served by a small Node server.

- **Step 1: manual drive** (Drive page): forward, back, left, right, curves.
- **Step 2: LiDAR** (Safe drive page), read directly by the laptop (no Jetson): Safe drive (forward slowed/refused
  near obstacles) and **Auto forward** (drives on its own, turns away from obstacles).

```
Nova AMR/
├─ platformio.ini        ESP32 build settings (+ WebSockets, ArduinoJson libraries)
├─ include/
│  ├─ config.h           pins, motor direction, speed cap, watchdog, ports
│  ├─ secrets.h          Wi-Fi name/password (NOT committed; copy of secrets.example.h)
│  └─ secrets.example.h
├─ src/                  ESP32 firmware
│  ├─ main.cpp           wires the modules together
│  ├─ motors.*           2 motors on 2× IBT-4: PWM, soft start, speed cap, trim, invert
│  ├─ safety.*           watchdog: no command for 0.5 s -> stop
│  ├─ comms.*            Wi-Fi + WebSocket to the server, finds the server by itself
│  └─ lidar_bridge.*     LiDAR serial (G34/G18) <-> Wi-Fi TCP 8899 relay to the Jetson (from Scout)
└─ app/                  control app (Node + React)
   ├─ package.json       npm start = build page + run server
   ├─ server/server.js   Node server: page <-> ESP32 relay, discovery beacon, settings, LiDAR API
   ├─ server/safedrive.cjs  Safe drive gate + Auto forward (copied from Scout's safedrive.js)
   ├─ server/lidar.js    reads the C1 LiDAR straight from Nova's ESP32 (RPLIDAR protocol), no Jetson
   ├─ web/src/           React page (App.jsx = Drive page + tabs, SafeDrive.jsx = Safe drive page,
   │                     useNova.js = the link to the server)
   └─ data/              settings.json (motors) + safe.json (Safe drive), created on first save
```

## Wiring (step 1)

| From | To |
|---|---|
| IBT-4 #1 (LEFT) IN1 / IN2 | ESP32 G25 / G26 |
| IBT-4 #2 (RIGHT) IN1 / IN2 | ESP32 G16 / G17 |
| Both IBT-4 GND (control pin) | ESP32 GND |
| Left motor red/black (thick) | IBT-4 #1 MOTOR terminals |
| Right motor red/black (thick) | IBT-4 #2 MOTOR terminals |
| IBT-4 PWR + / − | **12 V** (from the 24→12 V converter), never 24 V |
| LM2596 OUT 5.0 V + / − | ESP32 5V (VIN) / GND |

| LiDAR yellow (TX) / green (RX) | ESP32 G34 / G18 |
| LiDAR red / black | buck OUT 5.0 V + / − |

Reserved for later: encoders left A/B = G32/G33, right A/B = G13/G14 (VCC 3V3).

## Run it

1. **Firmware** – open the `Nova AMR` folder in VS Code (PlatformIO) → Upload → Serial Monitor (115200).
2. **App** – in a terminal:
   ```
   cd "D:\Mobilise\Nova AMR\app"
   npm install        (first time only)
   npm start
   ```
   Open **http://localhost:8090**. The ESP32 finds the server by itself (UDP 4211).
   Scout's server uses 8080/4210, so both can run at the same time.

## LiDAR (Safe drive page) – laptop only, no Jetson

`LiDAR → Nova ESP32 (lidar_bridge, TCP 8899) → Wi-Fi → laptop: app/server/lidar.js decodes it → safedrive.cjs`

- Nothing to start: open the Safe drive page and the server connects to Nova's LiDAR by itself.
  The LiDAR spins while a page is open and stops ~10 s after the last page closes.
- Check the direction once: hand in front of Nova → dots at the top of the radar; hand on the left → dots on the left.
  Fix with “LiDAR arrow points to” / “Mirror left/right” on the page.
- Set Nova's width and LiDAR-to-front distance in Safe drive settings before using Auto forward.
- Later, for mapping with ROS: switch “LiDAR link” to **Jetson (ROS)**; the page shows the two Jetson commands.

## Safety layers
1. Hold-to-drive: let go of the button/key → stop.
2. Server dead-man: no drive message for 0.3 s → stop. Page closed → stop.
3. ESP32 watchdog: no command for 0.5 s → stop. Wi-Fi/server lost → stop.
4. Speed cap (default 60%) and soft start – keep ≤ 60% until the 20 A converter is fitted.
5. Safe drive: forward refused when blocked or when LiDAR data is older than 0.5 s.
6. Auto forward stops by itself: STOP / any drive button / page closed / Nova or LiDAR lost /
   stuck 4 times / 10 s turning without space.
7. The red E-stop cuts all power.
