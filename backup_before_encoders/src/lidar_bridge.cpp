#include "lidar_bridge.h"
#include "config.h"

#if FEATURE_LIDAR_BRIDGE
#include <WiFi.h>

namespace {

HardwareSerial LidarSerial(1);              // UART1, pins remapped from config.h
WiFiServer     server(LIDAR_TCP_PORT);
WiFiClient     client;                      // only touched inside the task

volatile bool     haveClient = false;
volatile uint32_t upBytes = 0, downBytes = 0;   // up = LiDAR -> Jetson
volatile uint32_t upBps = 0, downBps = 0;

// Quiet the LiDAR (RPLIDAR protocol), so it never keeps spinning and streaming after
// the driver has gone, and every new driver session starts from a clean LiDAR.
//   reset = false (Jetson connects):    STOP scan only. The driver then starts it itself.
//   reset = true  (Jetson disconnects): STOP, then RESET -> the LiDAR reboots into its
//                                       power-on state with the motor stopped.
void lidarQuiet(bool reset) {
  static const uint8_t STOP[]  = {0xA5, 0x25};
  static const uint8_t RESET[] = {0xA5, 0x40};
  LidarSerial.write(STOP, sizeof(STOP));
  LidarSerial.flush();
  vTaskDelay(pdMS_TO_TICKS(5));
  if (reset) { LidarSerial.write(RESET, sizeof(RESET)); LidarSerial.flush(); }
  uint32_t until = millis() + 30;                 // throw away what was still in flight
  while ((int32_t)(until - millis()) > 0) { while (LidarSerial.available()) LidarSerial.read(); vTaskDelay(1); }
}

void bridgeTask(void*) {
  uint8_t  buf[512];
  bool     serverStarted = false;
  uint32_t rateStart = millis(), upAtStart = 0, downAtStart = 0;

  for (;;) {
    // once a second: bytes/second for the telemetry
    uint32_t now = millis();
    if (now - rateStart >= 1000) {
      upBps   = upBytes - upAtStart;     upAtStart   = upBytes;
      downBps = downBytes - downAtStart; downAtStart = downBytes;
      rateStart = now;
    }

    if (WiFi.status() != WL_CONNECTED) {
      if (haveClient) { client.stop(); haveClient = false; }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }
    if (!serverStarted) {
      server.begin();
      server.setNoDelay(true);
      serverStarted = true;
      Serial.printf("[LIDAR] bridge ready on %s:%u\n",
                    WiFi.localIP().toString().c_str(), LIDAR_TCP_PORT);
    }

    // A new connection always wins: if the Jetson's old link died without closing
    // properly, it must not lock the LiDAR out (only one link at a time).
    if (haveClient && server.hasClient()) {
      Serial.println("[LIDAR] new Jetson connection replaces the old one");
      client.stop(); haveClient = false;
    }
    if (!haveClient || !client.connected()) {
      if (haveClient) {
        Serial.println("[LIDAR] Jetson disconnected -> LiDAR stopped (reset)");
        client.stop(); haveClient = false;
        lidarQuiet(true);
      }
      WiFiClient c = server.available();
      if (c) {
        client = c;
        client.setNoDelay(true);
        lidarQuiet(false);                                     // start clean
        haveClient = true;
        Serial.printf("[LIDAR] Jetson connected from %s\n", client.remoteIP().toString().c_str());
      } else {
        while (LidarSerial.available()) LidarSerial.read();   // nobody listening: drop data
        vTaskDelay(pdMS_TO_TICKS(50));
        continue;
      }
    }

    // LiDAR -> Jetson
    int n = LidarSerial.available();
    if (n > 0) {
      n = LidarSerial.readBytes(buf, n > (int)sizeof(buf) ? (int)sizeof(buf) : n);
      if (n > 0) { client.write(buf, n); upBytes += n; }
    }
    // Jetson -> LiDAR (start/stop/info commands from the driver)
    int m = client.available();
    if (m > 0) {
      m = client.read(buf, m > (int)sizeof(buf) ? (int)sizeof(buf) : m);
      if (m > 0) { LidarSerial.write(buf, m); downBytes += m; }
    }
    vTaskDelay(1);   // always yield 1 ms: keeps Wi-Fi + the core-0 watchdog happy
  }
}

}  // namespace

void lidarBridgeBegin() {
  LidarSerial.setRxBufferSize(4096);        // must be before begin()
  LidarSerial.begin(LIDAR_BAUD, SERIAL_8N1, Pins::LIDAR_RX, Pins::LIDAR_TX);
  xTaskCreatePinnedToCore(bridgeTask, "lidar_bridge", 4096, nullptr, 1, nullptr, 0);
  Serial.printf("[LIDAR] serial on RX=%d TX=%d @ %lu baud\n",
                Pins::LIDAR_RX, Pins::LIDAR_TX, (unsigned long)LIDAR_BAUD);
}

void lidarBridgeTelemetry(JsonObject out) {
  out["enabled"] = true;
  out["client"]  = (bool)haveClient;
  out["upBps"]   = (uint32_t)upBps;
  out["downBps"] = (uint32_t)downBps;
  out["port"]    = LIDAR_TCP_PORT;
}

#else   // FEATURE_LIDAR_BRIDGE == 0

void lidarBridgeBegin() {}
void lidarBridgeTelemetry(JsonObject out) { out["enabled"] = false; }

#endif
