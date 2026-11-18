#pragma once
/*
  motors - drives Nova's 2 wheel motors through 2x IBT-4.
  Knows nothing about Wi-Fi. Other modules only call these functions.
*/
#include <Arduino.h>
#include <ArduinoJson.h>

void motorsBegin();                                   // pins + PWM, motors stopped
void motorsUpdate();                                  // soft-start ramp; call every loop()
void motorsStop();                                    // immediate stop (no ramp)
void motorsSetVelocity(float linear, float angular);  // -1..1 each; + linear = forward, + angular = turn left
void motorsSetWheels(float left, float right);        // per-wheel -1..1 (testing one wheel)
bool motorsMoving();
void motorsApplyConfig(JsonVariantConst cfg);         // live tuning from {"type":"config",...}
void motorsTelemetry(JsonDocument& t);
