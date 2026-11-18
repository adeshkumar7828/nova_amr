#pragma once
/*
  safety - the watchdog. If commands stop arriving (Wi-Fi drop, browser
  closed, server crashed) Nova stops by itself within WATCHDOG_MS.
*/
#include <Arduino.h>

void     safetyCommandReceived();   // call on every motion command
void     safetyUpdate();            // call every loop()
uint32_t safetyWatchdogTrips();
