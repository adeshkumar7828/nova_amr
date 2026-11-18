#include "safety.h"
#include "config.h"
#include "motors.h"

namespace {
uint32_t lastCmdMs     = 0;
uint32_t watchdogTrips = 0;
}

void safetyCommandReceived() { lastCmdMs = millis(); }
uint32_t safetyWatchdogTrips() { return watchdogTrips; }

void safetyUpdate() {
  uint32_t gap = millis() - lastCmdMs;
  if (motorsMoving() && gap > WATCHDOG_MS) {
    Serial.printf("[SAFETY] watchdog stop: no command for %lu ms\n", (unsigned long)gap);
    motorsStop();
    watchdogTrips++;
  }
}
