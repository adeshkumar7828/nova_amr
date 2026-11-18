/*
  Nova AMR - ESP32 firmware (step 1: manual drive)

    src/motors   2 wheel motors on 2x IBT-4 (PWM, soft start, speed cap, live tuning)
    src/safety   watchdog: no command for 0.5 s -> stop
    src/comms    Wi-Fi + WebSocket to the Nova server, commands + telemetry
    src/lidar_bridge  LiDAR serial <-> Wi-Fi relay to the Jetson (own task, core 0)
    include/config.h    pins and fixed settings
    include/secrets.h   Wi-Fi name/password (copy from secrets.example.h)

  Messages (JSON over ws://<server>:8090/robot):
    {"type":"velocity","linear":0.5,"angular":0}   -1..1; + linear = forward, + angular = turn left
    {"type":"wheels","left":0.3,"right":0}         one wheel at a time (testing)
    {"type":"stop"}
    {"type":"config","maxPower":0.6,"minDuty":40,"invertLeft":false,"invertRight":true}
*/
#include <Arduino.h>
#include "config.h"
#include "motors.h"
#include "safety.h"
#include "comms.h"
#include "lidar_bridge.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Nova AMR: 2-wheel drive (2x IBT-4), Wi-Fi control + LiDAR bridge ===");
  motorsBegin();   // first: motors safely stopped
  commsBegin();    // Wi-Fi + find the server
  lidarBridgeBegin();  // LiDAR relay (runs by itself on core 0)
}

void loop() {
  commsUpdate();   // commands in, telemetry out
  motorsUpdate();  // soft-start ramp
  safetyUpdate();  // watchdog
}
