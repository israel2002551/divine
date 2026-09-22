#include <WiFi.h>
#include <WebServer.h>

// ==========================================
// WI-FI ACCESS POINT CONFIGURATION
// ==========================================
const char* ssid     = "HelioClean-Bot";
const char* password = "password123";

WebServer server(80);

// ==========================================
// PIN DEFINITIONS (ESP32)
// ==========================================
#define PIN_MOTOR_IN1 25 // Left Motors Forward
#define PIN_MOTOR_IN2 26 // Left Motors Reverse
#define PIN_MOTOR_IN3 27 // Right Motors Forward
#define PIN_MOTOR_IN4 14 // Right Motors Reverse

#define PIN_BRUSH_RELAY 12 // 5th Cleaning Brush Motor Relay
#define PIN_PUMP_RELAY  13 // Water Pump Relay
#define PIN_STATUS_LED   2 // Onboard Indicator LED (Blue LED)

// ==========================================
// PWM CONFIGURATION (ESP32 Core v3.x API)
// ==========================================
const int PWM_FREQ       = 5000;
const int PWM_RESOLUTION = 8;
const int DRIVE_SPEED    = 130; // Manual drive speed (0 - 255)

// Actuator States
bool brushState = false;
bool pumpState  = false;

// ==========================================
// WEB INTERFACE HTML & CSS
// ==========================================
const char HTML_PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>HelioClean Remote Control</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; background: #121212; color: #fff; margin: 0; padding: 20px; }
        h1 { color: #00e676; font-size: 24px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(3, 80px); grid-gap: 10px; justify-content: center; margin: 20px auto; }
        .btn { width: 80px; height: 80px; background: #333; color: #fff; border: none; border-radius: 12px; font-size: 20px; font-weight: bold; cursor: pointer; -webkit-tap-highlight-color: transparent; }
        .btn:active { background: #00e676; color: #000; }
        .btn-stop { background: #ff1744; grid-column: 2; }
        .control-panel { display: flex; justify-content: center; gap: 15px; margin-top: 25px; }
        .toggle-btn { padding: 15px 25px; background: #29b6f6; border: none; border-radius: 8px; color: #fff; font-size: 16px; font-weight: bold; cursor: pointer; }
        .toggle-btn.active { background: #00e676; color: #000; }
    </style>
</head>
<body>
    <h1>HelioClean Control</h1>
    
    <div class="grid">
        <div></div>
        <button class="btn" onclick="sendCommand('forward')">&#9650;</button>
        <div></div>
        <button class="btn" onclick="sendCommand('left')">&#9664;</button>
        <button class="btn btn-stop" onclick="sendCommand('stop')">STOP</button>
        <button class="btn" onclick="sendCommand('right')">&#9654;</button>
        <div></div>
        <button class="btn" onclick="sendCommand('reverse')">&#9660;</button>
        <div></div>
    </div>

    <div class="control-panel">
        <button id="brushBtn" class="toggle-btn" onclick="toggleActuator('brush')">Brush: OFF</button>
        <button id="pumpBtn" class="toggle-btn" onclick="toggleActuator('pump')">Pump: OFF</button>
    </div>

    <script>
        function sendCommand(cmd) {
            fetch('/drive?cmd=' + cmd);
        }
        function toggleActuator(type) {
            fetch('/actuator?type=' + type)
            .then(res => res.text())
            .then(state => {
                let btn = document.getElementById(type + 'Btn');
                if (state === "1") {
                    btn.classList.add('active');
                    btn.innerText = type.toUpperCase() + ": ON";
                } else {
                    btn.classList.remove('active');
                    btn.innerText = type.toUpperCase() + ": OFF";
                }
            });
        }
    </script>
</body>
</html>
)rawliteral";

// ==========================================
// MOTOR CONTROL HELPERS
// ==========================================
void setDriveMotors(int leftSpeed, int rightSpeed) {
  if (leftSpeed >= 0) {
    ledcWrite(PIN_MOTOR_IN1, abs(leftSpeed));
    ledcWrite(PIN_MOTOR_IN2, 0);
  } else {
    ledcWrite(PIN_MOTOR_IN1, 0);
    ledcWrite(PIN_MOTOR_IN2, abs(leftSpeed));
  }

  if (rightSpeed >= 0) {
    ledcWrite(PIN_MOTOR_IN3, abs(rightSpeed));
    ledcWrite(PIN_MOTOR_IN4, 0);
  } else {
    ledcWrite(PIN_MOTOR_IN3, 0);
    ledcWrite(PIN_MOTOR_IN4, abs(rightSpeed));
  }
}

void stopDriveMotors() {
  ledcWrite(PIN_MOTOR_IN1, 0);
  ledcWrite(PIN_MOTOR_IN2, 0);
  ledcWrite(PIN_MOTOR_IN3, 0);
  ledcWrite(PIN_MOTOR_IN4, 0);
}

// ==========================================
// WEB ROUTE HANDLERS
// ==========================================
void handleRoot() {
  server.send(200, "text/html", HTML_PAGE);
}

void handleDrive() {
  if (server.hasArg("cmd")) {
    String cmd = server.arg("cmd");
    if (cmd == "forward")      setDriveMotors(DRIVE_SPEED, DRIVE_SPEED);
    else if (cmd == "reverse") setDriveMotors(-DRIVE_SPEED, -DRIVE_SPEED);
    else if (cmd == "left")    setDriveMotors(-DRIVE_SPEED, DRIVE_SPEED);
    else if (cmd == "right")   setDriveMotors(DRIVE_SPEED, -DRIVE_SPEED);
    else if (cmd == "stop")    stopDriveMotors();
  }
  server.send(200, "text/plain", "OK");
}

void handleActuator() {
  if (server.hasArg("type")) {
    String type = server.arg("type");
    if (type == "brush") {
      brushState = !brushState;
      digitalWrite(PIN_BRUSH_RELAY, brushState ? HIGH : LOW);
      server.send(200, "text/plain", String(brushState));
      return;
    } 
    else if (type == "pump") {
      pumpState = !pumpState;
      digitalWrite(PIN_PUMP_RELAY, pumpState ? HIGH : LOW);
      server.send(200, "text/plain", String(pumpState));
      return;
    }
  }
  server.send(400, "text/plain", "Error");
}

// ==========================================
// SETUP
// ==========================================
void setup() {
  Serial.begin(115200);

  // Pin Modes
  pinMode(PIN_BRUSH_RELAY, OUTPUT);
  pinMode(PIN_PUMP_RELAY, OUTPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);

  digitalWrite(PIN_BRUSH_RELAY, LOW);
  digitalWrite(PIN_PUMP_RELAY, LOW);
  digitalWrite(PIN_STATUS_LED, LOW);

  // LEDC PWM Initialization (ESP32 Core v3.x API)
  ledcAttach(PIN_MOTOR_IN1, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(PIN_MOTOR_IN2, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(PIN_MOTOR_IN3, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(PIN_MOTOR_IN4, PWM_FREQ, PWM_RESOLUTION);

  stopDriveMotors();

  // STABILITY FIXES: Reduce peak current draw & disable Wi-Fi sleep
  WiFi.mode(WIFI_AP);
  WiFi.setTxPower(WIFI_POWER_15dBm); // Slightly reduce RF output power to prevent brownout reboots
  WiFi.setSleep(false);              // Prevent Wi-Fi radio from turning off during idle

  // Start Access Point
  WiFi.softAP(ssid, password);
  IPAddress myIP = WiFi.softAPIP();
  Serial.print("Access Point Started. IP address: ");
  Serial.println(myIP);

  // Configure Web Server Routes
  server.on("/", handleRoot);
  server.on("/drive", handleDrive);
  server.on("/actuator", handleActuator);

  server.begin();
  digitalWrite(PIN_STATUS_LED, HIGH); // Solid blue light indicates web server is active
}

// ==========================================
// MAIN LOOP
// ==========================================
void loop() {
  server.handleClient();
}
