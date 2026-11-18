// Copy this file to secrets.h (same folder) and fill in your values.
// secrets.h is git-ignored so your Wi-Fi password never gets committed.
#pragma once

#define WIFI_SSID   "YourWifiName"      // must be a 2.4 GHz network (ESP32 can't use 5 GHz)
#define WIFI_PASS   "YourWifiPassword"
#define SERVER_HOST "auto"              // "auto" = find the Nova server by itself (or put the laptop's IP here)
#define SERVER_PORT 8090                // Nova server port (Scout uses 8080)
