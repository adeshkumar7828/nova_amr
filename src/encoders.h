#pragma once
/*
  encoders - counts the two wheel encoders (Hall, A/B quadrature).

  Every change on A or B triggers a tiny interrupt that reads both wires and adds
  +1 or -1 ("x4" counting: 4 counts per encoder pulse). The direction comes from
  which wire changed first, so forward and backward are told apart.
  Knows nothing about Wi-Fi; comms puts the numbers into the telemetry.
*/
#include <Arduino.h>
#include <ArduinoJson.h>

void encodersBegin();                          // pins + interrupts, counts = 0
void encodersUpdate();                         // speed every ENC_RATE_MS + Serial print; call every loop()
void encodersReset();                          // counts back to 0
void encodersApplyConfig(JsonVariantConst cfg);   // {"encInvertLeft":bool,"encInvertRight":bool}
void encodersTelemetry(JsonDocument& t);       // t["enc"] = {l, r, lps, rps [, dl, dr, vl, vr]}
