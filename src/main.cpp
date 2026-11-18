/*
  Nova AMR - ESP32 firmware (step 2: manual drive + wheel encoders)

    src/motors   2 wheel motors on 2x BTS7960 (PWM, soft start, speed cap, live tuning)
    src/encoders 2 wheel encoders: counts + speed (interrupts)
    src/safety   watchdog: no command for 0.5 s -> stop
    src/comms    Wi-Fi + WebSocket to the Nova server, commands + telemetry
    (LiDAR relay is switched off for now: code kept in extras/lidar_bridge)
    include/config.h    pins and fixed settings
    include/secrets.h   Wi-Fi name/password (copy from secrets.example.h)

  Messages (JSON over ws://<server>:8090/robot):
    {"type":"velocity","linear":0.5,"angular":0}   -1..1; + linear = forward, + angular = turn left
    {"type":"wheels","left":0.3,"right":0}         one wheel at a time (testing)
    {"type":"stop"}
    {"type":"config","maxPower":0.6,"minDuty":40,"invertLeft":false,"invertRight":true,
     "encInvertLeft":false,"encInvertRight":true}
    {"type":"encReset"}                            encoder counts back to 0
  Telemetry adds "enc": {l, r, lps, rps, err}  (counts, counts per second, glitches)
*/
#include <Arduino.h>
#include "config.h"
#include "motors.h"
#include "safety.h"
#include "comms.h"
#include "encoders.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Nova AMR: 2-wheel drive (2x BTS7960) + encoders, Wi-Fi control ===");
  motorsBegin();   // first: motors safely stopped
  encodersBegin(); // counting starts now
  commsBegin();    // Wi-Fi + find the server
}

void loop() {
  commsUpdate();   // commands in, telemetry out
  motorsUpdate();  // soft-start ramp
  encodersUpdate();// wheel speed + Serial print
  safetyUpdate();  // watchdog
}
