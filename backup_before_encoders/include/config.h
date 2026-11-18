#pragma once
/*
  config.h - ONE place for Nova's pins and fixed settings.
  Modules read from here; they never hard-code pins themselves.

  Nova: 2-wheel differential drive (left + right wheel in the middle,
  2 free casters). Each wheel = 12 V encoder gear motor on its own IBT-4.
*/
#include <Arduino.h>

// ============ Feature switches (0 = off, 1 = on) ============
#define FEATURE_LIDAR_BRIDGE 1   // Slamtec C1 on the ESP32: its serial data is relayed to the
                                 // Jetson over Wi-Fi (TCP port LIDAR_TCP_PORT), same as Scout

// ============ Pins ============
namespace Pins {
  // IBT-4 #1 = LEFT wheel             IBT-4 #2 = RIGHT wheel
  constexpr int LEFT_IN1  = 25;        constexpr int RIGHT_IN1 = 16;
  constexpr int LEFT_IN2  = 26;        constexpr int RIGHT_IN2 = 17;
  // Each IBT-4's GND control pin -> an ESP32 GND pin (shared ground is required)

  constexpr int LED = 2;               // on-board blue LED: blinking = looking for server, solid = connected

  // LiDAR (Slamtec C1, 3.3 V serial)
  constexpr int LIDAR_RX = 34;   // ESP32 receives here  <- LiDAR TX wire (yellow)   (input-only pin)
  constexpr int LIDAR_TX = 18;   // ESP32 sends here     -> LiDAR RX wire (green)
                                 // LiDAR red/black -> buck OUT 5.0 V + / -  (not the ESP32 pins)

  // Reserved for later steps (not used yet):
  //   Left encoder  A/B = 32 / 33     Right encoder A/B = 13 / 14   (encoder VCC = 3V3)
}

// ============ Motor direction ============
// If a wheel turns the wrong way on "Forward", flip it here
// (or live from the control page: Settings -> Invert left / right).
constexpr bool INVERT_LEFT  = false;
constexpr bool INVERT_RIGHT = true;    // right motor is mounted mirror-image, so usually inverted

// ============ Motor PWM ============
constexpr uint32_t PWM_FREQ  = 8000;   // 8 kHz; if the IBT-4 gets hot or misbehaves, try 1000
constexpr uint8_t  PWM_RES   = 8;      // duty 0..255
constexpr int      PWM_MAX   = 255;
constexpr float    RAMP_PER_SEC = 1.5f;      // 0 -> full power in ~0.7 s (gentle on the converters)

// Defaults - all live-tunable from the control page (Settings)
constexpr float DEFAULT_MAX_POWER = 0.60f;   // speed cap 60% while running on the small converters
constexpr int   DEFAULT_MIN_DUTY  = 40;      // smallest duty that actually turns the wheel

// ============ Safety / timing ============
constexpr uint32_t WATCHDOG_MS  = 500;   // no command for this long -> stop
constexpr uint32_t TELEMETRY_MS = 200;   // telemetry 5x per second

// ============ LiDAR bridge ============
constexpr uint32_t LIDAR_BAUD     = 460800;  // Slamtec C1 serial speed
constexpr uint16_t LIDAR_TCP_PORT = 8899;    // the Jetson connects here

// ============ Network ============
// Nova uses its OWN ports so it never mixes with Scout's robot-server (8080 / 4210).
constexpr uint16_t DISCOVERY_PORT = 4211;   // server shouts "I'm here" on this UDP port
