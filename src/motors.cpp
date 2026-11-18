#include "motors.h"
#include "config.h"

/*
  BTS7960 control (one per wheel; IN1 = RPWM or LPWM, see config.h):
      IN1 = PWM, IN2 = LOW   -> forward, speed = duty
      IN1 = LOW, IN2 = PWM   -> reverse
      IN1 = LOW, IN2 = LOW   -> stop
  Never both HIGH.
*/
namespace {

struct Motor {
  const char* name;
  int   in1, in2;
  float current;    // power applied now, -1..1
  float target;     // power requested, -1..1
};

enum { LEFT = 0, RIGHT = 1, NUM = 2 };

Motor motors[NUM] = {
  {"left",  Pins::LEFT_IN1,  Pins::LEFT_IN2,  0, 0},
  {"right", Pins::RIGHT_IN1, Pins::RIGHT_IN2, 0, 0},
};

// live-tunable settings
float maxPower  = DEFAULT_MAX_POWER;
int   minDuty   = DEFAULT_MIN_DUTY;
bool  invert[NUM] = {INVERT_LEFT, INVERT_RIGHT};
float trim[NUM]   = {1.0f, 1.0f};

uint32_t lastRampMs = 0;

// PWM on ESP32 Arduino core 2.x and 3.x (channel = motor*2 + pin)
void pwmWrite(int m, int which, int duty) {
  duty = constrain(duty, 0, PWM_MAX);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(which == 0 ? motors[m].in1 : motors[m].in2, duty);
#else
  ledcWrite(m * 2 + which, duty);
#endif
}

void applyMotor(int m, float power) {
  motors[m].current = power;
  if (invert[m]) power = -power;
  float mag = fabsf(power) * trim[m] * maxPower;

  if (mag < 0.02f) {                       // stop
    pwmWrite(m, 0, 0);
    pwmWrite(m, 1, 0);
    return;
  }
  int duty = minDuty + (int)(min(mag, 1.0f) * (PWM_MAX - minDuty));
  if (power > 0) { pwmWrite(m, 1, 0);  pwmWrite(m, 0, duty); }   // the LOW side first
  else           { pwmWrite(m, 0, 0);  pwmWrite(m, 1, duty); }
}

// Speeding up is rate-limited (soft start = small current spikes).
// Slowing down is immediate; reversing goes through 0 first.
float rampToward(float cur, float tgt, float maxStep) {
  if (cur * tgt < 0) return 0;
  if (fabsf(tgt) <= fabsf(cur)) return tgt;
  float diff = tgt - cur;
  if (fabsf(diff) <= maxStep) return tgt;
  return cur + (diff > 0 ? maxStep : -maxStep);
}

}  // namespace

void motorsBegin() {
  for (int m = 0; m < NUM; m++) {
    int pins[2] = {motors[m].in1, motors[m].in2};
    for (int k = 0; k < 2; k++) {
      digitalWrite(pins[k], LOW);
      pinMode(pins[k], OUTPUT);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
      ledcAttach(pins[k], PWM_FREQ, PWM_RES);
#else
      ledcSetup(m * 2 + k, PWM_FREQ, PWM_RES);
      ledcAttachPin(pins[k], m * 2 + k);
#endif
    }
  }
  motorsStop();
  Serial.printf("[MOTORS] ready: left IN1/IN2=%d/%d  right IN1/IN2=%d/%d  max=%.0f%%\n",
                Pins::LEFT_IN1, Pins::LEFT_IN2, Pins::RIGHT_IN1, Pins::RIGHT_IN2, maxPower * 100);
}

void motorsUpdate() {
  uint32_t now = millis();
  float dt = (now - lastRampMs) / 1000.0f;
  if (dt < 0.01f) return;                  // every 10 ms
  lastRampMs = now;
  float step = RAMP_PER_SEC * dt;
  for (int m = 0; m < NUM; m++) {
    float next = rampToward(motors[m].current, motors[m].target, step);
    if (next != motors[m].current) applyMotor(m, next);
  }
}

void motorsStop() {
  for (int m = 0; m < NUM; m++) {
    motors[m].target = 0;
    applyMotor(m, 0);
  }
}

void motorsSetWheels(float left, float right) {
  motors[LEFT].target  = constrain(left,  -1.0f, 1.0f);
  motors[RIGHT].target = constrain(right, -1.0f, 1.0f);
}

void motorsSetVelocity(float linear, float angular) {
  linear  = constrain(linear,  -1.0f, 1.0f);
  angular = constrain(angular, -1.0f, 1.0f);
  float left  = linear - angular;          // turn left = left wheel slower/backward
  float right = linear + angular;
  float m = max(1.0f, max(fabsf(left), fabsf(right)));
  motorsSetWheels(left / m, right / m);
}

bool motorsMoving() {
  for (int m = 0; m < NUM; m++)
    if (fabsf(motors[m].current) > 0.02f || fabsf(motors[m].target) > 0.02f) return true;
  return false;
}

void motorsApplyConfig(JsonVariantConst doc) {
  if (doc["maxPower"].is<float>())    maxPower     = constrain((float)doc["maxPower"], 0.0f, 1.0f);
  if (doc["minDuty"].is<int>())       minDuty      = constrain((int)doc["minDuty"], 0, 200);
  if (doc["invertLeft"].is<bool>())   invert[LEFT]  = doc["invertLeft"];
  if (doc["invertRight"].is<bool>())  invert[RIGHT] = doc["invertRight"];
  if (doc["trimLeft"].is<float>())    trim[LEFT]    = constrain((float)doc["trimLeft"], 0.5f, 1.0f);
  if (doc["trimRight"].is<float>())   trim[RIGHT]   = constrain((float)doc["trimRight"], 0.5f, 1.0f);
  Serial.printf("[CFG] max=%.2f minDuty=%d invL=%d invR=%d trimL=%.2f trimR=%.2f\n",
                maxPower, minDuty, invert[LEFT], invert[RIGHT], trim[LEFT], trim[RIGHT]);
}

void motorsTelemetry(JsonDocument& t) {
  t["left"]     = motors[LEFT].current;
  t["right"]    = motors[RIGHT].current;
  t["maxPower"] = maxPower;
}
