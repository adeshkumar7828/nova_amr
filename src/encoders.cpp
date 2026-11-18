#include "encoders.h"
#include "config.h"
#include "soc/soc.h"
#include "soc/gpio_reg.h"

namespace {

struct Encoder {
  const char* name;
  int pinA, pinB;
  volatile int32_t raw;     // counts as wired (before invert)
  volatile uint8_t state;   // last (A,B) = 0..3
  volatile uint32_t errors; // impossible jumps (both wires changed at once) = noise / missed edge
  int32_t lastForRate;
  float   rate;             // counts per second (after invert)
};

enum { LEFT = 0, RIGHT = 1, NUM = 2 };

Encoder enc[NUM] = {
  {"left",  Pins::ENC_LEFT_A,  Pins::ENC_LEFT_B,  0, 0, 0, 0, 0},
  {"right", Pins::ENC_RIGHT_A, Pins::ENC_RIGHT_B, 0, 0, 0, 0, 0},
};
bool invert[NUM] = {ENC_INVERT_LEFT, ENC_INVERT_RIGHT};

uint32_t lastRateMs = 0, lastPrintMs = 0;
int32_t  lastPrinted[NUM] = {INT32_MIN, INT32_MIN};

// Read a pin straight from the GPIO register (fast and safe inside an interrupt).
inline uint32_t IRAM_ATTR readPin(int pin) {
  return pin < 32 ? (REG_READ(GPIO_IN_REG) >> pin) & 1 : (REG_READ(GPIO_IN1_REG) >> (pin - 32)) & 1;
}

// old state (2 bits) + new state (2 bits) -> step. 0 = no move, 2/-2 never happen (error).
DRAM_ATTR const int8_t STEP[16] = { 0, +1, -1,  2,
                         -1,  0,  2, +1,
                         +1,  2,  0, -1,
                          2, -1, +1,  0 };

void IRAM_ATTR onEdge(void* arg) {
  Encoder* e = (Encoder*)arg;
  uint8_t now = (readPin(e->pinA) << 1) | readPin(e->pinB);
  int8_t s = STEP[(e->state << 2) | now];
  if (s == 2) e->errors++;
  else        e->raw += s;
  e->state = now;
}

inline int32_t counts(int m) {
  int32_t r = enc[m].raw;              // 32-bit read is atomic on the ESP32
  return invert[m] ? -r : r;
}

float metersPerCount() {
  return ENC_COUNTS_PER_WHEEL_REV > 0 ? (PI * WHEEL_DIAMETER_M) / ENC_COUNTS_PER_WHEEL_REV : 0;
}

}  // namespace

void encodersBegin() {
  for (int m = 0; m < NUM; m++) {
    // 32/33 have internal pull-ups; 34/35 don't (input-only pins) - see config.h
    pinMode(enc[m].pinA, enc[m].pinA >= 34 ? INPUT : INPUT_PULLUP);
    pinMode(enc[m].pinB, enc[m].pinB >= 34 ? INPUT : INPUT_PULLUP);
    enc[m].state = (readPin(enc[m].pinA) << 1) | readPin(enc[m].pinB);
    attachInterruptArg(digitalPinToInterrupt(enc[m].pinA), onEdge, &enc[m], CHANGE);
    attachInterruptArg(digitalPinToInterrupt(enc[m].pinB), onEdge, &enc[m], CHANGE);
  }
  lastRateMs = millis();
  Serial.printf("[ENC] ready: left A/B=%d/%d  right A/B=%d/%d  (push Nova forward: both counts should go UP)\n",
                Pins::ENC_LEFT_A, Pins::ENC_LEFT_B, Pins::ENC_RIGHT_A, Pins::ENC_RIGHT_B);
}

void encodersUpdate() {
  uint32_t now = millis();
  if (now - lastRateMs >= ENC_RATE_MS) {
    float dt = (now - lastRateMs) / 1000.0f;
    lastRateMs = now;
    for (int m = 0; m < NUM; m++) {
      int32_t c = counts(m);
      enc[m].rate = (c - enc[m].lastForRate) / dt;
      enc[m].lastForRate = c;
    }
  }
  if (now - lastPrintMs >= ENC_PRINT_MS) {
    lastPrintMs = now;
    int32_t l = counts(LEFT), r = counts(RIGHT);
    if (l != lastPrinted[LEFT] || r != lastPrinted[RIGHT]) {
      Serial.printf("[ENC] left %ld (%.0f/s)   right %ld (%.0f/s)   errors %lu/%lu\n",
                    (long)l, enc[LEFT].rate, (long)r, enc[RIGHT].rate,
                    (unsigned long)enc[LEFT].errors, (unsigned long)enc[RIGHT].errors);
      lastPrinted[LEFT] = l; lastPrinted[RIGHT] = r;
    }
  }
}

void encodersReset() {
  for (int m = 0; m < NUM; m++) {
    noInterrupts();
    enc[m].raw = 0;
    enc[m].errors = 0;
    interrupts();
    enc[m].lastForRate = 0;
    enc[m].rate = 0;
  }
  Serial.println("[ENC] counts reset to 0");
}

void encodersApplyConfig(JsonVariantConst doc) {
  bool changed = false;
  if (doc["encInvertLeft"].is<bool>())  { invert[LEFT]  = doc["encInvertLeft"];  changed = true; }
  if (doc["encInvertRight"].is<bool>()) { invert[RIGHT] = doc["encInvertRight"]; changed = true; }
  if (changed) {
    for (int m = 0; m < NUM; m++) enc[m].lastForRate = counts(m);   // no fake speed spike
    Serial.printf("[CFG] encoder invert L=%d R=%d\n", invert[LEFT], invert[RIGHT]);
  }
}

void encodersTelemetry(JsonDocument& t) {
  JsonObject e = t["enc"].to<JsonObject>();
  e["l"]   = counts(LEFT);
  e["r"]   = counts(RIGHT);
  e["lps"] = (int32_t)enc[LEFT].rate;          // counts per second
  e["rps"] = (int32_t)enc[RIGHT].rate;
  e["err"] = enc[LEFT].errors + enc[RIGHT].errors;
  float mpc = metersPerCount();
  if (mpc > 0) {
    e["dl"] = counts(LEFT) * mpc;               // metres travelled since reset
    e["dr"] = counts(RIGHT) * mpc;
    e["vl"] = enc[LEFT].rate * mpc;             // metres per second
    e["vr"] = enc[RIGHT].rate * mpc;
  }
}
