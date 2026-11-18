#pragma once
/*
  lidar_bridge - relays the LiDAR's serial port to the Jetson over Wi-Fi (same as Scout).

    LiDAR TX  -> ESP32 Pins::LIDAR_RX ┐
                                       ├─ TCP server on LIDAR_TCP_PORT  <──Wi-Fi──>  Jetson
    LiDAR RX <- ESP32 Pins::LIDAR_TX ┘     (socat turns it into /tmp/ttyLIDAR there)

  The ESP32 does not decode anything: bytes go both ways untouched, so the
  normal Slamtec driver on the Jetson works as if the LiDAR were plugged in by USB.
  Runs in its own FreeRTOS task on core 0, so motors/safety in loop() (core 1)
  are never slowed down.
*/
#include <Arduino.h>
#include <ArduinoJson.h>

void lidarBridgeBegin();                     // call once, after Wi-Fi is up
void lidarBridgeTelemetry(JsonObject out);   // {enabled, client, upBps, downBps, port}
