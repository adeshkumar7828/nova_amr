#pragma once
/*
  comms - Wi-Fi + WebSocket link to the Nova server (laptop or Jetson).
  Finds the server by itself (UDP beacon), receives commands, sends telemetry.
*/
#include <Arduino.h>

void commsBegin();     // connect Wi-Fi and start looking for the server
void commsUpdate();    // call every loop()
