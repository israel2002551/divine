/**
 * ============================================================================
 * HelioClean Solar Robot Firmware
 * ============================================================================
 * Target: ESP32 Dev Module / ESP-WROOM-32
 * Communication: MQTT over Wi-Fi via broker.emqx.io
 * 
 * Features:
 *  - Independent manual wheel / track speed control (-255 to +255 PWM)
 *  - Directional control presets (Forward, Reverse, Spin, Pivot, Stop)
 *  - Dynamic braking on H-bridge for slope stability on solar panels
 *  - Safety Watchdog: auto-stops motors if connection drops (>600ms)
 *  - Sensor integrations:
 *      * Left & Right optical/IR edge drop-off sensors (fall protection)
 *      * Water reservoir float switch (dry-run pump protection)
 *      * Battery voltage ADC monitor with low-voltage alert
 *  - Safe pin mapping: Relays moved away from strapping pins (GPIO 12)
 *  - Configurable Active-LOW / Active-HIGH relay logic
 *  - Non-blocking Wi-Fi and MQTT reconnection with LWT and periodic telemetry
 *  - Compatible with both ESP32 Arduino Core v2.x and v3.x
 * ============================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>

// ==========================================
// CONFIGURATION: WI-FI & MQTT
// ==========================================
// Replace with your local Wi-Fi router / mobile hotspot credentials
const char* WIFI_SSID     = "Your_WiFi_SSID";
const char* WIFI_PASSWORD = "Your_WiFi_Password";

// MQTT Broker Settings (EMQX Public Broker)
const char* MQTT_BROKER   = "broker.emqx.io";
const int   MQTT_PORT     = 1883;
const char* BOT_ID        = "bot1"; // Unique identifier for this robot

// MQTT Topics
String TOPIC_STATUS;      // helioclean/<BOT_ID>/status (LWT: online/offline)
String TOPIC_TELEMETRY;   // helioclean/<BOT_ID>/telemetry
String TOPIC_CMD_DRIVE;   // helioclean/<BOT_ID>/cmd/drive
String TOPIC_CMD_ACTUATOR;// helioclean/<BOT_ID>/cmd/actuator
String TOPIC_CMD_EMERGENCY;// helioclean/<BOT_ID>/cmd/emergency
String TOPIC_CMD_SPEED;   // helioclean/<BOT_ID>/cmd/speed

// ==========================================
// PIN DEFINITIONS (ESP32)
// ==========================================
// Motor Driver H-Bridge Pins (L298N / TB6612 / DRV8833)
#define PIN_MOTOR_IN1     25 // Left Motors Forward
#define PIN_MOTOR_IN2     26 // Left Motors Reverse
#define PIN_MOTOR_IN3     27 // Right Motors Forward
#define PIN_MOTOR_IN4     14 // Right Motors Reverse

// Actuator Relays (Moved off Strapping Pin 12 to prevent bootloops)
#define PIN_BRUSH_RELAY   18 // Cleaning Brush Motor Relay
#define PIN_PUMP_RELAY    19 // Water Pump Relay
#define PIN_STATUS_LED     2 // Onboard Indicator LED (Blue LED)

// Sensors (Configurable / Optional)
#define PIN_EDGE_LEFT     32 // Left Drop-off / Edge IR sensor (Digital)
#define PIN_EDGE_RIGHT    33 // Right Drop-off / Edge IR sensor (Digital)
#define PIN_WATER_LEVEL   35 // Water Tank Float Switch (Digital input, input-only pin)
#define PIN_BATTERY_ADC   34 // Battery Voltage Monitor (ADC1, input-only pin)

// MPU6050 6-Axis IMU (I2C)
#define PIN_I2C_SDA       21 // ESP32 Default I2C Data Pin
#define PIN_I2C_SCL       22 // ESP32 Default I2C Clock Pin
#define MPU6050_I2C_ADDR  0x68 // Default I2C address (AD0 low)
#define MPU6050_PWR_MGMT1 0x6B
#define MPU6050_ACCEL_X   0x3B

// ==========================================
// HARDWARE BEHAVIOR CONFIGURATION
// ==========================================
// Relay Polarity: true if relay turns ON when pin is LOW (common on hobby modules)
#define RELAY_ACTIVE_LOW  true
#define RELAY_STATE_ON    (RELAY_ACTIVE_LOW ? LOW : HIGH)
#define RELAY_STATE_OFF   (RELAY_ACTIVE_LOW ? HIGH : LOW)

// Edge Sensor Polarity: true if sensor outputs LOW when drop-off / edge is detected
#define EDGE_TRIGGER_LOW  true

// Water Float Polarity: true if sensor is LOW when water is EMPTY
#define WATER_EMPTY_LOW   true

// Motor PWM Parameters
const int PWM_FREQ        = 5000;
const int PWM_RESOLUTION  = 8; // 8-bit (0 - 255)
const int PWM_DEADBAND    = 25; // Motor speeds below this are cut to 0 to prevent humming

// Dynamic Braking: true to brake by shorting terminals (HIGH/HIGH) on stop
const bool ENABLE_DYNAMIC_BRAKE = true;

// Safety Watchdog
const unsigned long SAFETY_TIMEOUT_MS = 650; // Auto-stop motors if no drive packet in 650ms
const unsigned long TELEMETRY_INTERVAL_MS = 1000; // Publish telemetry every 1s

// Battery Voltage Calibration
// R1 = 100k, R2 = 22k -> Divider factor = (100+22)/22 = 5.545
const float BATTERY_DIVIDER_RATIO = 5.545f;
const float BATTERY_V_MAX = 12.6f; // 3S LiPo Full (4.2V * 3)
const float BATTERY_V_MIN = 10.2f; // 3S LiPo Empty (3.4V * 3)

// MPU6050 Tilt Safety Threshold
const float TILT_SAFETY_MAX_DEG   = 45.0f; // Excessive angle on solar panel

// ==========================================
// GLOBAL STATE VARIABLES
// ==========================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Motor State
int currentLeftSpeed  = 0;  // -255 to +255
int currentRightSpeed = 0;  // -255 to +255
int baseDriveSpeed    = 160; // Default speed preset (0 - 255)
bool isMoving         = false;
unsigned long lastDriveCommandTime = 0;

// Actuator States
bool brushState = false;
bool pumpState  = false;

// Sensor States
bool edgeLeftDetected  = false;
bool edgeRightDetected = false;
bool edgeWarning       = false;
bool waterEmpty        = false;
float batteryVoltage   = 12.4f;
int batteryPercentage  = 90;

// MPU6050 IMU State
bool mpuConnected = false;
float imuPitch    = 0.0f; // degrees (incline forward/backward)
float imuRoll     = 0.0f; // degrees (tilt left/right)
float imuYawRate  = 0.0f; // deg/sec (Z-axis rotation)
float imuTemp     = 0.0f; // chip temperature deg C
bool tiltWarning  = false;

// System Timers
unsigned long lastTelemetryTime = 0;
unsigned long lastMqttRetryTime = 0;
unsigned long lastLedBlinkTime  = 0;

// ==========================================
// PWM / LEDC COMPATIBILITY WRAPPERS
// (Supports both ESP32 Core v2.x and v3.x)
// ==========================================
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  // Core v3.0+ API
  void initPwmPin(uint8_t pin) {
    ledcAttach(pin, PWM_FREQ, PWM_RESOLUTION);
  }
  void writePwmPin(uint8_t pin, uint32_t duty) {
    ledcWrite(pin, duty);
  }
#else
  // Core v2.x API (Maps pins to LEDC channels 0-3)
  uint8_t pinToChannel(uint8_t pin) {
    switch (pin) {
      case PIN_MOTOR_IN1: return 0;
      case PIN_MOTOR_IN2: return 1;
      case PIN_MOTOR_IN3: return 2;
      case PIN_MOTOR_IN4: return 3;
      default: return 0;
    }
  }
  void initPwmPin(uint8_t pin) {
    uint8_t ch = pinToChannel(pin);
    ledcSetup(ch, PWM_FREQ, PWM_RESOLUTION);
    ledcAttachPin(pin, ch);
  }
  void writePwmPin(uint8_t pin, uint32_t duty) {
    ledcWrite(pinToChannel(pin), duty);
  }
#endif

// ==========================================
// MOTOR CONTROL FUNCTIONS
// ==========================================
void stopMotors(bool brake = ENABLE_DYNAMIC_BRAKE) {
  if (brake) {
    // Dynamic Braking: Write HIGH to both terminals to resist motor rotation
    writePwmPin(PIN_MOTOR_IN1, 255);
    writePwmPin(PIN_MOTOR_IN2, 255);
    writePwmPin(PIN_MOTOR_IN3, 255);
    writePwmPin(PIN_MOTOR_IN4, 255);
  } else {
    // Coasting: Cut PWM to 0
    writePwmPin(PIN_MOTOR_IN1, 0);
    writePwmPin(PIN_MOTOR_IN2, 0);
    writePwmPin(PIN_MOTOR_IN3, 0);
    writePwmPin(PIN_MOTOR_IN4, 0);
  }
  currentLeftSpeed  = 0;
  currentRightSpeed = 0;
  isMoving = false;
}

/**
 * Set independent left and right wheel speeds.
 * @param left  Speed for left motor (-255 to +255). Positive = Forward, Negative = Reverse.
 * @param right Speed for right motor (-255 to +255). Positive = Forward, Negative = Reverse.
 */
void setMotorSpeeds(int left, int right) {
  // Edge detection safety: If driving forward towards a drop-off, block forward motion!
  if (edgeWarning && (left > 0 || right > 0)) {
    Serial.println("[SAFETY] Forward drive blocked by Edge Sensor!");
    stopMotors(true);
    return;
  }

  // Constrain speeds
  left  = constrain(left, -255, 255);
  right = constrain(right, -255, 255);

  // Apply deadband
  if (abs(left) < PWM_DEADBAND)  left = 0;
  if (abs(right) < PWM_DEADBAND) right = 0;

  // Left Motor Control
  if (left > 0) {
    writePwmPin(PIN_MOTOR_IN1, left);
    writePwmPin(PIN_MOTOR_IN2, 0);
  } else if (left < 0) {
    writePwmPin(PIN_MOTOR_IN1, 0);
    writePwmPin(PIN_MOTOR_IN2, abs(left));
  } else {
    writePwmPin(PIN_MOTOR_IN1, 0);
    writePwmPin(PIN_MOTOR_IN2, 0);
  }

  // Right Motor Control
  if (right > 0) {
    writePwmPin(PIN_MOTOR_IN3, right);
    writePwmPin(PIN_MOTOR_IN4, 0);
  } else if (right < 0) {
    writePwmPin(PIN_MOTOR_IN3, 0);
    writePwmPin(PIN_MOTOR_IN4, abs(right));
  } else {
    writePwmPin(PIN_MOTOR_IN3, 0);
    writePwmPin(PIN_MOTOR_IN4, 0);
  }

  currentLeftSpeed  = left;
  currentRightSpeed = right;
  isMoving = (left != 0 || right != 0);
  lastDriveCommandTime = millis();
}

/**
 * Standard directional drive commands using baseDriveSpeed
 */
void executeDirectionCommand(const String& cmd, int speed = 0) {
  if (speed <= 0) speed = baseDriveSpeed;
  speed = constrain(speed, 50, 255);

  if (cmd == "forward") {
    setMotorSpeeds(speed, speed);
  } else if (cmd == "reverse") {
    setMotorSpeeds(-speed, -speed);
  } else if (cmd == "spin_left" || cmd == "left") {
    setMotorSpeeds(-speed, speed);
  } else if (cmd == "spin_right" || cmd == "right") {
    setMotorSpeeds(speed, -speed);
  } else if (cmd == "pivot_fwd_left") {
    setMotorSpeeds(speed / 3, speed);
  } else if (cmd == "pivot_fwd_right") {
    setMotorSpeeds(speed, speed / 3);
  } else if (cmd == "pivot_rev_left") {
    setMotorSpeeds(-speed / 3, -speed);
  } else if (cmd == "pivot_rev_right") {
    setMotorSpeeds(-speed, -speed / 3);
  } else if (cmd == "stop") {
    stopMotors(true);
  } else {
    Serial.printf("[WARN] Unknown command: %s\n", cmd.c_str());
  }
}

// ==========================================
// ACTUATOR CONTROL FUNCTIONS
// ==========================================
void setBrush(bool state) {
  brushState = state;
  digitalWrite(PIN_BRUSH_RELAY, brushState ? RELAY_STATE_ON : RELAY_STATE_OFF);
  Serial.printf("[ACTUATOR] Brush set to %s\n", brushState ? "ON" : "OFF");
}

void setPump(bool state) {
  // Dry-run protection: cannot enable pump if water tank is empty
  if (state && waterEmpty) {
    Serial.println("[SAFETY] Cannot activate pump: Water tank is empty!");
    pumpState = false;
    digitalWrite(PIN_PUMP_RELAY, RELAY_STATE_OFF);
    return;
  }
  pumpState = state;
  digitalWrite(PIN_PUMP_RELAY, pumpState ? RELAY_STATE_ON : RELAY_STATE_OFF);
  Serial.printf("[ACTUATOR] Water Pump set to %s\n", pumpState ? "ON" : "OFF");
}

void emergencyStop() {
  Serial.println("[EMERGENCY] Full Emergency Stop Triggered!");
  stopMotors(true);
  setBrush(false);
  setPump(false);
}

// ==========================================
// MPU6050 6-AXIS IMU DRIVER
// ==========================================
bool initMPU6050() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(400000); // 400kHz fast I2C mode

  // Wake up MPU6050 by writing 0 to PWR_MGMT_1 register
  Wire.beginTransmission(MPU6050_I2C_ADDR);
  Wire.write(MPU6050_PWR_MGMT1);
  Wire.write(0x00); // Clear sleep bit (bit 6)
  byte err = Wire.endTransmission();

  if (err == 0) {
    Serial.println("[IMU] MPU6050 6-Axis Motion Sensor initialized at 0x68!");
    return true;
  } else {
    Serial.printf("[IMU] MPU6050 not detected at 0x68 (error code: %d). Operating without IMU.\n", err);
    return false;
  }
}

void readMPU6050() {
  if (!mpuConnected) return;

  Wire.beginTransmission(MPU6050_I2C_ADDR);
  Wire.write(MPU6050_ACCEL_X);
  if (Wire.endTransmission(false) != 0) {
    return; // I2C bus busy or disconnected
  }

  // Request 14 consecutive bytes:
  // Accel X, Y, Z (6 bytes) + Temp (2 bytes) + Gyro X, Y, Z (6 bytes)
  if (Wire.requestFrom(MPU6050_I2C_ADDR, 14, true) == 14) {
    int16_t rawAccX = (Wire.read() << 8) | Wire.read();
    int16_t rawAccY = (Wire.read() << 8) | Wire.read();
    int16_t rawAccZ = (Wire.read() << 8) | Wire.read();
    int16_t rawTemp = (Wire.read() << 8) | Wire.read();
    int16_t rawGyrX = (Wire.read() << 8) | Wire.read();
    int16_t rawGyrY = (Wire.read() << 8) | Wire.read();
    int16_t rawGyrZ = (Wire.read() << 8) | Wire.read();

    // Scale Accelerometer (Default +/- 2g range = 16384 LSB/g)
    float ax = rawAccX / 16384.0f;
    float ay = rawAccY / 16384.0f;
    float az = rawAccZ / 16384.0f;

    // Calculate Chip Temperature in Celsius (MPU6050 datasheet formula)
    imuTemp = (rawTemp / 340.0f) + 36.53f;

    // Scale Gyroscope Z (Default +/- 250 deg/s = 131 LSB/(deg/s))
    imuYawRate = rawGyrZ / 131.0f;

    // Calculate Pitch and Roll angles in degrees
    // Pitch: forward / backward tilt
    // Roll:  left / right tilt
    float rawPitch = atan2(ay, sqrt(ax * ax + az * az)) * (180.0f / PI);
    float rawRoll  = atan2(-ax, az) * (180.0f / PI);

    // Apply exponential smoothing filter (prevents motor vibration jitter)
    imuPitch = (0.75f * imuPitch) + (0.25f * rawPitch);
    imuRoll  = (0.75f * imuRoll)  + (0.25f * rawRoll);

    // Check for excessive incline/tilt hazard on solar panels
    tiltWarning = (abs(imuPitch) > TILT_SAFETY_MAX_DEG || abs(imuRoll) > TILT_SAFETY_MAX_DEG);

    // Safety: If robot tilts dangerously while driving, auto-stop to prevent rollover/fall!
    if (tiltWarning && isMoving) {
      Serial.println("[SAFETY] TILT WARNING! Robot inclination exceeds safe threshold! Stopping drive!");
      stopMotors(true);
    }
  }
}

// ==========================================
// SENSOR READING & LOGIC
// ==========================================
void updateSensors() {
  // 1. Read Edge / Drop-off Sensors
  int rawEdgeL = digitalRead(PIN_EDGE_LEFT);
  int rawEdgeR = digitalRead(PIN_EDGE_RIGHT);
  
  edgeLeftDetected  = (rawEdgeL == (EDGE_TRIGGER_LOW ? LOW : HIGH));
  edgeRightDetected = (rawEdgeR == (EDGE_TRIGGER_LOW ? LOW : HIGH));
  edgeWarning       = (edgeLeftDetected || edgeRightDetected);

  // If edge detected while moving forward, immediately halt!
  if (edgeWarning && (currentLeftSpeed > 0 || currentRightSpeed > 0)) {
    Serial.println("[ALERT] Edge drop-off detected! Auto-stopping forward drive!");
    stopMotors(true);
  }

  // 2. Read Water Level Sensor
  int rawWater = digitalRead(PIN_WATER_LEVEL);
  waterEmpty   = (rawWater == (WATER_EMPTY_LOW ? LOW : HIGH));

  // If water becomes empty while pump is active, shut off pump to prevent burn-out
  if (waterEmpty && pumpState) {
    Serial.println("[ALERT] Water depleted! Auto-shutting off water pump!");
    setPump(false);
  }

  // 3. Read Battery Voltage
  int rawAdc = analogRead(PIN_BATTERY_ADC);
  // ESP32 ADC: 0-4095 corresponds to ~0 - 3.3V (with 11dB attenuation)
  float pinVoltage = (rawAdc / 4095.0f) * 3.3f;
  batteryVoltage   = pinVoltage * BATTERY_DIVIDER_RATIO;

  // Approximate remaining percentage (clamped 0 - 100%)
  if (batteryVoltage >= BATTERY_V_MAX) {
    batteryPercentage = 100;
  } else if (batteryVoltage <= BATTERY_V_MIN) {
    batteryPercentage = 0;
  } else {
    batteryPercentage = (int)(((batteryVoltage - BATTERY_V_MIN) / (BATTERY_V_MAX - BATTERY_V_MIN)) * 100.0f);
  }

  // 4. Read MPU6050 Inclinometer & Motion Data
  readMPU6050();
}

// ==========================================
// TELEMETRY PUBLISHER
// ==========================================
void publishTelemetry() {
  if (!mqttClient.connected()) return;

  // Build JSON telemetry string manually (no external dependency needed)
  String payload = "{";
  payload += "\"bot_id\":\"" + String(BOT_ID) + "\",";
  payload += "\"uptime\":" + String(millis() / 1000) + ",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"motors\":{\"left\":" + String(currentLeftSpeed) + ",\"right\":" + String(currentRightSpeed) + ",\"moving\":" + (isMoving ? "true" : "false") + "},";
  payload += "\"actuators\":{\"brush\":" + String(brushState ? "true" : "false") + ",\"pump\":" + String(pumpState ? "true" : "false") + "},";
  payload += "\"sensors\":{";
  payload += "\"edge_left\":" + String(edgeLeftDetected ? "true" : "false") + ",";
  payload += "\"edge_right\":" + String(edgeRightDetected ? "true" : "false") + ",";
  payload += "\"edge_warning\":" + String(edgeWarning ? "true" : "false") + ",";
  payload += "\"water_empty\":" + String(waterEmpty ? "true" : "false") + ",";
  payload += "\"battery_v\":" + String(batteryVoltage, 2) + ",";
  payload += "\"battery_pct\":" + String(batteryPercentage);
  payload += "},";
  payload += "\"imu\":{";
  payload += "\"connected\":" + String(mpuConnected ? "true" : "false") + ",";
  payload += "\"pitch\":" + String(imuPitch, 1) + ",";
  payload += "\"roll\":" + String(imuRoll, 1) + ",";
  payload += "\"yaw_rate\":" + String(imuYawRate, 1) + ",";
  payload += "\"temp\":" + String(imuTemp, 1) + ",";
  payload += "\"tilt_warning\":" + String(tiltWarning ? "true" : "false");
  payload += "},";
  payload += "\"failsafe\":{\"timeout_active\":" + String((isMoving && millis() - lastDriveCommandTime > SAFETY_TIMEOUT_MS) ? "true" : "false") + "}";
  payload += "}";

  mqttClient.publish(TOPIC_TELEMETRY.c_str(), payload.c_str());
}

// ==========================================
// MQTT MESSAGE HANDLER
// ==========================================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  message.trim();
  String topicStr = String(topic);

  // 1. DRIVE COMMAND
  if (topicStr == TOPIC_CMD_DRIVE) {
    // Check if JSON format with "left" and "right" speeds: {"left": 150, "right": 150}
    int leftIdx = message.indexOf("\"left\":");
    int rightIdx = message.indexOf("\"right\":");
    if (leftIdx >= 0 && rightIdx >= 0) {
      int leftVal = message.substring(leftIdx + 7).toInt();
      int rightVal = message.substring(rightIdx + 8).toInt();
      setMotorSpeeds(leftVal, rightVal);
      return;
    }

    // Check if JSON format with "cmd": {"cmd":"forward", "speed":180}
    int cmdIdx = message.indexOf("\"cmd\":");
    if (cmdIdx >= 0) {
      int q1 = message.indexOf('"', cmdIdx + 6);
      int q2 = message.indexOf('"', q1 + 1);
      String cmd = message.substring(q1 + 1, q2);
      int spdIdx = message.indexOf("\"speed\":");
      int spd = 0;
      if (spdIdx >= 0) {
        spd = message.substring(spdIdx + 8).toInt();
      }
      executeDirectionCommand(cmd, spd);
      return;
    }

    // Plain text command: e.g. "forward", "reverse", "left", "right", "stop"
    executeDirectionCommand(message);
    return;
  }

  // 2. ACTUATOR COMMAND
  if (topicStr == TOPIC_CMD_ACTUATOR) {
    // Example payloads:
    // {"brush": true} | {"pump": false} | {"brush": true, "pump": true}
    // or plain text "brush:1", "pump:0", "brush:toggle"
    if (message.indexOf("\"brush\":true") >= 0 || message == "brush:1")  setBrush(true);
    if (message.indexOf("\"brush\":false") >= 0 || message == "brush:0") setBrush(false);
    if (message == "brush:toggle") setBrush(!brushState);

    if (message.indexOf("\"pump\":true") >= 0 || message == "pump:1")  setPump(true);
    if (message.indexOf("\"pump\":false") >= 0 || message == "pump:0") setPump(false);
    if (message == "pump:toggle") setPump(!pumpState);

    // Immediate state feedback
    publishTelemetry();
    return;
  }

  // 3. EMERGENCY STOP COMMAND
  if (topicStr == TOPIC_CMD_EMERGENCY) {
    emergencyStop();
    publishTelemetry();
    return;
  }

  // 4. SPEED CONFIGURATION COMMAND
  if (topicStr == TOPIC_CMD_SPEED) {
    int spd = message.toInt();
    if (spd >= 50 && spd <= 255) {
      baseDriveSpeed = spd;
      Serial.printf("[CONFIG] Base drive speed updated to: %d\n", baseDriveSpeed);
    }
    return;
  }
}

// ==========================================
// MQTT & WI-FI CONNECTION MANAGERS
// ==========================================
void setupTopics() {
  String root = "helioclean/" + String(BOT_ID) + "/";
  TOPIC_STATUS        = root + "status";
  TOPIC_TELEMETRY     = root + "telemetry";
  TOPIC_CMD_DRIVE     = root + "cmd/drive";
  TOPIC_CMD_ACTUATOR  = root + "cmd/actuator";
  TOPIC_CMD_EMERGENCY = root + "cmd/emergency";
  TOPIC_CMD_SPEED     = root + "cmd/speed";
}

void connectMqtt() {
  if (mqttClient.connected()) return;

  Serial.print("[MQTT] Connecting to broker: ");
  Serial.print(MQTT_BROKER);
  Serial.print(" as ");
  String clientId = "HelioClean-" + String(BOT_ID) + "-" + String(random(1000, 9999));
  Serial.println(clientId);

  // Last Will and Testament (LWT) message: if bot unexpectedly disconnects, broker marks it offline
  const char* willTopic   = TOPIC_STATUS.c_str();
  const char* willMessage = "offline";
  int willQoS             = 1;
  bool willRetain         = true;

  if (mqttClient.connect(clientId.c_str(), willTopic, willQoS, willRetain, willMessage)) {
    Serial.println("[MQTT] Connected successfully!");

    // Publish online status (retained)
    mqttClient.publish(TOPIC_STATUS.c_str(), "online", true);

    // Subscribe to all command topics for this bot
    String subTopic = "helioclean/" + String(BOT_ID) + "/cmd/#";
    mqttClient.subscribe(subTopic.c_str(), 1);
    Serial.print("[MQTT] Subscribed to: ");
    Serial.println(subTopic);

    // Solid blue light on status LED indicates healthy MQTT connection
    digitalWrite(PIN_STATUS_LED, HIGH);

    // Publish immediate telemetry on connection
    publishTelemetry();
  } else {
    Serial.print("[MQTT] Failed, rc=");
    Serial.println(mqttClient.state());
    digitalWrite(PIN_STATUS_LED, LOW);
  }
}

// ==========================================
// ARDUINO SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n\n==========================================");
  Serial.println("  HelioClean Solar Robot Initializing...   ");
  Serial.println("==========================================");

  // Configure Topics
  setupTopics();

  // 1. Configure Actuator Relays & Indicator LED
  pinMode(PIN_BRUSH_RELAY, OUTPUT);
  pinMode(PIN_PUMP_RELAY, OUTPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);

  // Ensure relays start DE-ENERGIZED at power-on!
  digitalWrite(PIN_BRUSH_RELAY, RELAY_STATE_OFF);
  digitalWrite(PIN_PUMP_RELAY, RELAY_STATE_OFF);
  digitalWrite(PIN_STATUS_LED, LOW);

  // 2. Configure Sensor Pins
  pinMode(PIN_EDGE_LEFT, INPUT_PULLUP);
  pinMode(PIN_EDGE_RIGHT, INPUT_PULLUP);
  pinMode(PIN_WATER_LEVEL, INPUT); // GPIO 35 is input-only without internal pullup
  pinMode(PIN_BATTERY_ADC, INPUT); // GPIO 34 is input-only ADC

  // 3. Initialize MPU6050 6-Axis Motion Sensor
  mpuConnected = initMPU6050();

  // 4. Initialize Motor PWM Outputs
  initPwmPin(PIN_MOTOR_IN1);
  initPwmPin(PIN_MOTOR_IN2);
  initPwmPin(PIN_MOTOR_IN3);
  initPwmPin(PIN_MOTOR_IN4);

  stopMotors(false);

  // 5. Initial sensor read
  updateSensors();

  // 5. Connect to Wi-Fi in Station Mode
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // Disable Wi-Fi sleep for lowest latency response
  Serial.print("[WIFI] Connecting to SSID: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // 6. Setup MQTT Client
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(512); // Ensure buffer can receive drive JSONs
}

// ==========================================
// MAIN LOOP
// ==========================================
void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi Connection
  if (WiFi.status() != WL_CONNECTED) {
    // Blink LED while searching for Wi-Fi
    if (now - lastLedBlinkTime > 300) {
      lastLedBlinkTime = now;
      digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    }
    // If driving while Wi-Fi drops, stop immediately!
    if (isMoving) stopMotors(true);
    return;
  }

  // 2. Maintain MQTT Connection
  if (!mqttClient.connected()) {
    if (now - lastMqttRetryTime > 3000) {
      lastMqttRetryTime = now;
      connectMqtt();
    }
  } else {
    mqttClient.loop();
  }

  // 3. Periodic Sensor Polling (every 50ms for snappy edge detection)
  static unsigned long lastSensorPoll = 0;
  if (now - lastSensorPoll >= 50) {
    lastSensorPoll = now;
    updateSensors();
  }

  // 4. SAFETY WATCHDOG (Dead-Man's Switch)
  // If robot is moving and no new drive packet has arrived within timeout, emergency stop!
  if (isMoving && (now - lastDriveCommandTime > SAFETY_TIMEOUT_MS)) {
    Serial.println("[SAFETY WATCHDOG] Drive timeout reached without keep-alive packet. Halting motors!");
    stopMotors(true);
  }

  // 5. Periodic Telemetry Transmission
  if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = now;
    publishTelemetry();
  }
}
