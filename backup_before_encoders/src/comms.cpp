#include "comms.h"
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "config.h"
#include "secrets.h"      // WIFI_SSID, WIFI_PASS, SERVER_HOST, SERVER_PORT
#include "motors.h"
#include "safety.h"
#include "lidar_bridge.h"

namespace {

WebSocketsClient ws;
WiFiUDP  udp;
bool     wsConnected = false;
bool     wsStarted   = false;
bool     autoHost    = false;
String   hostNow;
uint16_t portNow     = SERVER_PORT;
uint32_t lastTelemetry = 0;
uint32_t lastWaitMsg   = 0;

void sendJson(JsonDocument& doc) {
  if (!wsConnected) return;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void handleMessage(uint8_t* payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  const char* type = doc["type"] | "";

  if (strcmp(type, "velocity") == 0) {
    motorsSetVelocity(doc["linear"] | 0.0f, doc["angular"] | 0.0f);
    safetyCommandReceived();
  } else if (strcmp(type, "wheels") == 0) {
    motorsSetWheels(doc["left"] | 0.0f, doc["right"] | 0.0f);
    safetyCommandReceived();
  } else if (strcmp(type, "stop") == 0) {
    motorsStop();
    safetyCommandReceived();
    Serial.println("[CMD] stop");
  } else if (strcmp(type, "config") == 0) {
    motorsApplyConfig(doc.as<JsonVariantConst>());
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      wsConnected = true;
      Serial.printf("[WS] connected to ws://%s:%u/robot\n", hostNow.c_str(), portNow);
      JsonDocument hello;
      hello["type"]  = "hello";
      hello["robot"] = "nova";
      hello["ip"]    = WiFi.localIP().toString();
#if FEATURE_LIDAR_BRIDGE
      hello["lidarPort"] = LIDAR_TCP_PORT;    // the Jetson's lidar link connects here
#endif
      sendJson(hello);
      break;
    }
    case WStype_DISCONNECTED:
      if (wsConnected) Serial.println("[WS] disconnected -> motors stopped");
      wsConnected = false;
      motorsStop();
      break;
    case WStype_TEXT:
      handleMessage(payload, length);
      break;
    default:
      break;
  }
}

void sendTelemetry() {
  JsonDocument t;
  t["type"] = "telemetry";
  motorsTelemetry(t);
  t["rssi"]     = WiFi.RSSI();
  t["uptimeMs"] = millis();
  t["watchdog"] = safetyWatchdogTrips();
  t["heap"]     = ESP.getFreeHeap();
  lidarBridgeTelemetry(t["lidar"].to<JsonObject>());
  sendJson(t);
}

void startWs(const String& host, uint16_t port) {
  if (wsStarted) ws.disconnect();
  hostNow = host;
  portNow = port;
  ws.begin(hostNow.c_str(), portNow, "/robot");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(3000, 2000, 2);     // dead connection detected within ~7 s
  wsStarted = true;
  Serial.printf("[WS] using server ws://%s:%u/robot\n", hostNow.c_str(), portNow);
}

// The server shouts {"novaServer":1,"port":8090} every second on UDP DISCOVERY_PORT.
void checkBeacon() {
  int size = udp.parsePacket();
  if (size <= 0) return;
  char buf[128];
  int len = udp.read(buf, sizeof(buf) - 1);
  buf[len > 0 ? len : 0] = 0;
  JsonDocument doc;
  if (deserializeJson(doc, buf) || !(doc["novaServer"] | 0)) return;
  String ip = udp.remoteIP().toString();
  uint16_t port = doc["port"] | (int)SERVER_PORT;
  if (!wsStarted) {
    Serial.printf("[WS] found the Nova server at %s:%u\n", ip.c_str(), port);
    startWs(ip, port);
  } else if (!wsConnected && (ip != hostNow || port != portNow)) {
    Serial.printf("[WS] server moved -> %s:%u\n", ip.c_str(), port);
    startWs(ip, port);
  }
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // steadier latency
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] connecting to \"%s\"", WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(Pins::LED, !digitalRead(Pins::LED));
    delay(250);
    Serial.print(".");
    if (millis() - start > 20000) {
      Serial.println("\n[WiFi] still not connected - check name/password (2.4 GHz only). Retrying...");
      start = millis();
    }
  }
  Serial.printf("\n[WiFi] connected, Nova IP = %s, signal %d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

}  // namespace

void commsBegin() {
  pinMode(Pins::LED, OUTPUT);
  connectWifi();
  autoHost = strcmp(SERVER_HOST, "auto") == 0 || strlen(SERVER_HOST) == 0;
  if (autoHost) {
    udp.begin(DISCOVERY_PORT);
    Serial.printf("[WS] looking for the Nova server on the network (UDP %u)...\n", DISCOVERY_PORT);
  } else {
    startWs(SERVER_HOST, SERVER_PORT);
  }
}

void commsUpdate() {
  if (autoHost) checkBeacon();
  if (wsStarted) ws.loop();
  uint32_t now = millis();

  if (now - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = now;
    sendTelemetry();
  }
  if (!wsConnected && now - lastWaitMsg > 5000) {
    lastWaitMsg = now;
    if (WiFi.status() != WL_CONNECTED)
      Serial.println("[WiFi] connection lost, reconnecting...");
    else if (!wsStarted)
      Serial.println("[WS] still looking for the Nova server... (is it running? same Wi-Fi?)");
    else
      Serial.printf("[WS] waiting for ws://%s:%u/robot ...\n", hostNow.c_str(), portNow);
  }
  digitalWrite(Pins::LED, wsConnected ? HIGH : ((now / 300) % 2));
}
