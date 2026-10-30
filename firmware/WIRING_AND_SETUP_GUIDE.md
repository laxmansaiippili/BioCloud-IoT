# 🏥 BioCloud IoT — ESP32 & DS18B20 Hardware Wiring & Setup Guide

This guide is designed for beginners. Follow it step-by-step to connect your **DS18B20 temperature sensor** to your **ESP32** and stream live patient body temperature to your BioCloud system.

---

## 1. What You Need

1. **ESP32 DevKit Board** (30-pin or 38-pin version with micro-USB or USB-C)
2. **DS18B20 Temperature Sensor** (either the waterproof metal tube with 3 wires, or the 3-legged black transistor style, or the 3-pin breakout board)
3. **4.7kΩ (4,700 ohm) Resistor** (Color bands: **Yellow - Violet - Red - Gold**)
   *(Note: If you have the DS18B20 breakout module with a built-in resistor, you don't need this)*
4. **Breadboard & 3 Jumper Wires** (Male-to-Male or Male-to-Female)
5. **USB Cable** to plug ESP32 into your computer

---

## 2. Pin Connections & Wiring Diagrams

### Option A: Waterproof DS18B20 (Metal Probe with 3 Wires)

Most waterproof probes have 3 colored wires:
- **RED wire:** Power / VCC (Connect to ESP32 **3V3**)
- **BLACK (or Blue) wire:** Ground / GND (Connect to ESP32 **GND**)
- **YELLOW (or White) wire:** Data (Connect to ESP32 **GPIO 4 / D4**)

#### Crucial: The 4.7kΩ Pull-Up Resistor
The 1-Wire protocol requires a pull-up resistor between the **DATA** wire and the **3.3V** power wire.

```
       +--------------------------------------------+
       |           DS18B20 WIRING SCHEMATIC         |
       +--------------------------------------------+

       ESP32 Board                             DS18B20 Sensor
      +------------+                          +--------------+
      |            |                          |              |
      |   3V3 (3.3V) -------------------+---->| RED (VCC)    |
      |            |                    |     |              |
      |            |             [4.7kΩ]|     |              |
      |            |          [Resistor]|     |              |
      |            |                    |     |              |
      |   GPIO 4   |--------------------+---->| YELLOW (Data)|
      |   (Pin D4) |                          |              |
      |            |                          |              |
      |     GND    |------------------------->| BLACK (GND)  |
      |            |                          |              |
      +------------+                          +--------------+
```

---

### Option B: TO-92 Transistor-Style Sensor (3 Metal Legs)

If you have the small black plastic component with 3 metal legs:
Hold the sensor so the **flat printed face** is pointing towards you, and the pins are pointing downwards:

```
        DS18B20 (Front Flat Face)
          +---------------+
          |   DS18B20     |
          |               |
          +---------------+
             |    |    |
             |    |    |
           Pin1 Pin2 Pin3
           (GND)(Data)(3.3V)
```

1. **Pin 1 (Left):** Connect to ESP32 **GND**
2. **Pin 2 (Center):** Connect to ESP32 **GPIO 4 (D4)**
3. **Pin 3 (Right):** Connect to ESP32 **3V3 (3.3V)**
4. Put the **4.7kΩ resistor** between **Pin 2 (Center/Data)** and **Pin 3 (Right/3.3V)**.

---

### Option C: 3-Pin DS18B20 Breakout Module (Small PCB)

If your sensor is already soldered onto a small green/blue/red circuit board:
It already has the resistor built-in! You only need to plug 3 wires:
1. **`+` or `VCC`:** Connect to ESP32 **3V3**
2. **`-` or `GND`:** Connect to ESP32 **GND**
3. **`S` or `OUT` or `DAT`:** Connect to ESP32 **GPIO 4 (D4)**

---

## 3. How to Set Up Arduino IDE (5-Minute Setup)

### Step 1: Install Arduino IDE
If you don't already have it, download and install [Arduino IDE (v2.x)](https://www.arduino.cc/en/software).

### Step 2: Add ESP32 Support in Arduino IDE
1. Open Arduino IDE.
2. Go to **File** → **Preferences**.
3. In **Additional boards manager URLs**, paste this link:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Click **OK**.
5. Go to **Tools** → **Board** → **Boards Manager...**
6. Search for `ESP32` and click **Install** on **"esp32 by Espressif Systems"**.

### Step 3: Install Required Sensor Libraries
In Arduino IDE, go to **Sketch** → **Include Library** → **Manage Libraries...**
Search and install these two libraries:
1. Search **`OneWire`** (by Paul Stoffregen) → Click **Install**.
2. Search **`DallasTemperature`** (by Miles Burton) → Click **Install**.

---

## 4. Flashing the Code to Your ESP32

1. Plug your ESP32 into your computer using the USB cable.
2. Open the file `firmware/biocloud_temp_esp32.ino` in Arduino IDE.
3. Near lines 19-25, update your Wi-Fi details:
   ```cpp
   const char* WIFI_SSID     = "AUS-ROBOTICS";                            // Your connected Wi-Fi name
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";                      // Your AUS-ROBOTICS password
   const char* SERVER_URL    = "http://192.168.205.219:3000/api/telemetry"; // Your laptop's IP
   ```
   *(Note: `192.168.205.219` is your computer's current Wi-Fi address on AUS-ROBOTICS!)*

4. In Arduino IDE:
   - Go to **Tools** → **Board** → **ESP32 Arduino** → select **ESP32 Dev Module** (or your specific board).
   - Go to **Tools** → **Port** → select the COM port of your ESP32 (e.g. `COM3`, `COM4`, or `COM5`).
5. Click the **Upload** button (the right-arrow icon in top-left).
   *(Tip: If you see `Connecting........____`, hold down the **BOOT** button on your ESP32 for 2 seconds until it starts uploading).*

---

## 5. Verifying in the Serial Monitor

1. In Arduino IDE, click **Tools** → **Serial Monitor** (or Ctrl+Shift+M).
2. Set the baud rate in the bottom-right corner to **`115200`**.
3. Press the **EN (Reset)** button on your ESP32.
4. You will see:
   ```text
   ========================================================
   🏥 BioCloud IoT — ESP32 Patient Temperature Monitor
   ========================================================
   [DS18B20] Initializing sensor on GPIO 4
   [DS18B20] Detected sensors: 1
   ✅ DS18B20 sensor online and ready!
   📡 Connecting to Wi-Fi: MyHomeWiFi
   .....
   ✅ Wi-Fi Connected!
      ESP32 Local IP: 192.168.1.85
      Target Server:  http://192.168.1.46:3000/api/telemetry
   🌡️ Patient [p1] Temperature: 36.85 °C | Status: OK
      ➡️ Telemetry sent to BioCloud (HTTP 200)
   ```

---

## 6. Testing the High-Temperature Relative Mobile Alarm

1. Start the BioCloud server on your computer:
   ```powershell
   node server.js
   ```
2. Open your mobile phone's browser (connected to the same Wi-Fi).
3. In the mobile browser, type:
   ```
   http://192.168.1.46:3000
   ```
4. Log in as a relative (or click the "Relative" quick-fill on the sign-in screen).
5. Now test a fever reading:
   - **Method A (Real Sensor):** Hold the DS18B20 probe tightly between your fingers or warm it gently to raise the temperature.
   - **Method B (Virtual Simulator):** On your computer's Admin Dashboard or with the test simulator, click **"High Fever (38.6 °C)"**.
6. **Result:**
   - Within 1 second, your mobile phone will display a **pulsing red emergency warning**!
   - A **loud continuous audio alarm siren** will ring from the mobile speaker!
   - Tap **"Acknowledge"** on your mobile screen to silence the alarm.
