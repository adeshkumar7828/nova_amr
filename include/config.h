#pragma once
/*
  config.h - ONE place for Nova's pins and fixed settings.
  Modules read from here; they never hard-code pins themselves.

  Nova: 2-wheel differential drive (left + right wheel in the middle,
  2 free casters). Each wheel = 12 V encoder gear motor on its own BTS7960 (IBT-2).
  Brain board: ESP32 + 2x BTS7960 + MPU9250 IMU + 2 encoder headers (VCC A B GND).
  The LiDAR is NOT on the ESP32 for now (the old relay code is kept in extras/lidar_bridge).
*/
#include <Arduino.h>

// ============ Pins ============
namespace Pins {
  // BTS7960 = LEFT wheel              BTS7960 = RIGHT wheel
  // (IN1/IN2 = the driver's two PWM inputs; R_EN + L_EN are tied to 5 V on the board)
  constexpr int LEFT_IN1  = 25;        constexpr int RIGHT_IN1 = 16;
  constexpr int LEFT_IN2  = 26;        constexpr int RIGHT_IN2 = 17;
  // Each driver's GND pin -> ESP32 GND (shared ground is required)

  constexpr int LED = 2;               // on-board blue LED: blinking = looking for server, solid = connected

  // Wheel encoders (Hall, A/B), headers "ENC L" / "ENC R", VCC = 3V3 (never 5 V)
  constexpr int ENC_LEFT_A  = 32;      constexpr int ENC_RIGHT_A = 34;
  constexpr int ENC_LEFT_B  = 33;      constexpr int ENC_RIGHT_B = 35;
  // 34/35 are input-only and have NO internal pull-up. If the right counts stay at 0 or jump
  // around, add 10 kOhm from A to 3V3 and from B to 3V3.

  // IMU MPU9250 on I2C (wired, not read yet): SDA = 21, SCL = 22
}

// ============ Motor direction ============
// If a wheel turns the wrong way on "Forward", flip it here
// (or live from the control page: Settings -> Invert left / right).
constexpr bool INVERT_LEFT  = false;
constexpr bool INVERT_RIGHT = true;    // right motor is mounted mirror-image, so usually inverted

// ============ Motor PWM ============
constexpr uint32_t PWM_FREQ  = 8000;   // 8 kHz (BTS7960 is fine up to ~25 kHz; 20000 = no motor whine)
constexpr uint8_t  PWM_RES   = 8;      // duty 0..255
constexpr int      PWM_MAX   = 255;
constexpr float    RAMP_PER_SEC = 1.5f;      // 0 -> full power in ~0.7 s (gentle on the converters)

// Defaults - all live-tunable from the control page (Settings)
constexpr float DEFAULT_MAX_POWER = 0.60f;   // speed cap 60% while running on the small converters
constexpr int   DEFAULT_MIN_DUTY  = 40;      // smallest duty that actually turns the wheel

// ============ Safety / timing ============
constexpr uint32_t WATCHDOG_MS  = 500;   // no command for this long -> stop
constexpr uint32_t TELEMETRY_MS = 200;   // telemetry 5x per second

// ============ Encoders ============
// Counting direction: pushing Nova FORWARD by hand must make BOTH counts go UP.
// If one goes down, flip it here or live from the control page (Settings -> Invert encoder).
constexpr bool ENC_INVERT_LEFT  = false;
constexpr bool ENC_INVERT_RIGHT = true;    // right motor is mirror-image, like INVERT_RIGHT
// Counts for ONE full wheel turn. 0 = not measured yet (page shows counts only).
// Measure: Settings -> Reset counts, turn one wheel exactly 1 turn forward by hand, read the count.
constexpr float ENC_COUNTS_PER_WHEEL_REV = 0;
constexpr float WHEEL_DIAMETER_M = 0.100f;   // 100 mm wheels
constexpr uint32_t ENC_RATE_MS   = 100;      // speed is measured over 0.1 s
constexpr uint32_t ENC_PRINT_MS  = 500;      // Serial Monitor: print counts when they change

// ============ Network ============
// Nova uses its OWN ports so it never mixes with Scout's robot-server (8080 / 4210).
constexpr uint16_t DISCOVERY_PORT = 4211;   // server shouts "I'm here" on this UDP port
