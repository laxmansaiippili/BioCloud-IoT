/* =============================================================================
   BioCloud IoT — ESP32 + DS18B20 Patient Temperature Firmware
   Compatible with: ESP32 DevKit V1 / NodeMCU-32S / ESP32-WROOM-32
   Sensor: DS18B20 Waterproof Probe or TO-92 Digital Thermometer
   Libraries Needed: 
     - OneWire by Paul Stoffregen
     - DallasTemperature by Miles Burton
   ============================================================================= */

#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// =============================================================================
//  1. CONFIGURATION (ENTER YOUR WI-FI CREDENTIALS HERE)
// =============================================================================
const char* WIFI_SSID     = "AUS CAMPUS";       // <-- Enter your Wi-Fi SSID
const char* WIFI_PASSWORD = "adityacampus";   // <-- Enter your Wi-Fi Password

// BioCloud Server IP: This is your computer's local Wi-Fi IP address!
// If your computer's IP changes, update it here.
const char* SERVER_URL    = "http://192.168.56.1:3000/api/telemetry";

// Patient & Device Identification
const char* DEVICE_ID     = "ESP32-DS18B20-WARD1";
const char* PATIENT_ID    = "p1";                  // "p1" is John Doe (ICU Ward A, Bed 01)
const int   READ_INTERVAL = 3000;                  // Send reading every 3000ms (3 seconds)

// =============================================================================
//  2. HARDWARE PIN DEFINITIONS
// =============================================================================
// DS18B20 Data Line connected to GPIO 4 (Pin D4 on most ESP32 boards)
// Remember: 4.7k ohm resistor required between GPIO 4 (Data) and 3.3V (VCC)
const int ONE_WIRE_BUS = 4;

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// On-board LED for visual feedback (GPIO 2 on most ESP32 boards)
const int LED_PIN = 2;

// =============================================================================
//  SETUP
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("\n========================================================");
  Serial.println("🏥 BioCloud IoT — ESP32 Patient Temperature Monitor");
  Serial.println("========================================================");

  // Initialize DS18B20 Sensor
  Serial.print("[DS18B20] Initializing sensor on GPIO ");
  Serial.println(ONE_WIRE_BUS);
  sensors.begin();

  int deviceCount = sensors.getDeviceCount();
  Serial.print("[DS18B20] Detected sensors: ");
  Serial.println(deviceCount);

  if (deviceCount == 0) {
    Serial.println("⚠️ WARNING: No DS18B20 detected! Please check your wiring:");
    Serial.println("   - RED wire    -> ESP32 3.3V");
    Serial.println("   - BLACK wire  -> ESP32 GND");
    Serial.println("   - YELLOW wire -> ESP32 GPIO 4");
    Serial.println("   - 4.7k Resistor across 3.3V and GPIO 4");
  } else {
    Serial.println("✅ DS18B20 sensor online and ready!");
  }

  // Connect to Wi-Fi
  connectWiFi();
}

// =============================================================================
//  MAIN LOOP
// =============================================================================
void loop() {
  // Ensure Wi-Fi remains connected
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ Wi-Fi disconnected! Reconnecting...");
    connectWiFi();
    return;
  }

  // Blink LED to indicate reading
  digitalWrite(LED_PIN, HIGH);

  // 1. Request temperature reading from DS18B20
  sensors.requestTemperatures();
  float tempC = sensors.getTempCByIndex(0);

  digitalWrite(LED_PIN, LOW);

  // 2. Validate sensor readings
  String sensorStatus = "OK";
  if (tempC == DEVICE_DISCONNECTED_C || tempC <= -100.0) {
    sensorStatus = "DISCONNECTED";
    Serial.println("❌ ERROR: DS18B20 disconnected or wire loose (-127°C)!");
  } else if (tempC == 85.0) {
    sensorStatus = "INVALID";
    Serial.println("⚠️ WARNING: DS18B20 power-on reset value (85°C)! Reading again...");
    delay(500);
    sensors.requestTemperatures();
    tempC = sensors.getTempCByIndex(0);
    if (tempC == 85.0) sensorStatus = "INVALID";
    else sensorStatus = "OK";
  }

  // 3. Print reading to Serial Monitor
  Serial.print("🌡️ Patient [");
  Serial.print(PATIENT_ID);
  Serial.print("] Temperature: ");
  Serial.print(tempC, 2);
  Serial.print(" °C | Status: ");
  Serial.println(sensorStatus);

  // 4. Send Telemetry to BioCloud Server via HTTP POST
  sendTelemetry(tempC, sensorStatus);

  // 5. Wait for next reading interval
  delay(READ_INTERVAL);
}

// =============================================================================
//  HELPER: Connect to Wi-Fi
// =============================================================================
void connectWiFi() {
  Serial.print("📡 Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Wi-Fi Connected!");
    Serial.print("   ESP32 Local IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("   Target Server:  ");
    Serial.println(SERVER_URL);
  } else {
    Serial.println("\n❌ Failed to connect to Wi-Fi! Please check SSID & Password.");
  }
}

// =============================================================================
//  HELPER: Send JSON Telemetry to BioCloud Cloud Server
// =============================================================================
void sendTelemetry(float temperature, String status) {
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");

  // Construct JSON payload matching BioCloud IoT Schema
  String jsonPayload = "{";
  jsonPayload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  jsonPayload += "\"patientId\":\"" + String(PATIENT_ID) + "\",";
  jsonPayload += "\"temperature\":" + String(temperature, 2) + ",";
  jsonPayload += "\"unit\":\"C\",";
  jsonPayload += "\"sensorStatus\":\"" + status + "\",";
  jsonPayload += "\"timestamp\":\"" + getIsoTimestamp() + "\"";
  jsonPayload += "}";

  int httpCode = http.POST(jsonPayload);

  if (httpCode > 0) {
    Serial.print("   ➡️ Telemetry sent to BioCloud (HTTP ");
    Serial.print(httpCode);
    Serial.println(")");
    if (httpCode == 200) {
      String response = http.getString();
      // If critical fever was triggered, announce it
      if (response.indexOf("\"status\":\"CRITICAL\"") > 0) {
        Serial.println("   🚨 CRITICAL FEVER TRIGGERED ON SERVER! Relative mobile alarm activated.");
      }
    }
  } else {
    Serial.print("   ❌ HTTP POST failed! Error: ");
    Serial.println(http.errorToString(httpCode).c_str());
    Serial.println("      Make sure your BioCloud node server is running on the computer!");
  }

  http.end();
}

// Generate simple ISO timestamp string
String getIsoTimestamp() {
  return String(millis());
}
