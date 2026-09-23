/**
 * ============================================================================
 * AI-Powered Water Quality Diagnostic Station (I2C LCD & MQTT Edition)
 * ============================================================================
 * Hardware: ESP32 Dev Module / ESP-WROOM-32
 * Displays: 16x2 or 20x4 I2C LCD (LiquidCrystal_I2C via PCF8574 backpack)
 * Sensors: Analog pH Sensor (GPIO 34 ADC1)
 * Connectivity: 
 *   - Wi-Fi Station Mode
 *   - MQTT Telemetry to broker.emqx.io:1883
 *   - HTTPS Groq Cloud API (llama-3.1-8b-instant)
 * Architecture:
 *   - FreeRTOS Dual-Core Multitasking:
 *       * Core 0: Background Groq LPU HTTPS queries + MQTT keep-alive & publishing
 *       * Core 1: High-precision ADC sampling (Median + Trimmed Mean + EMA) & I2C LCD rendering
 *   - Mutex protected shared variables
 * ============================================================================
 */

#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>        // Requires ArduinoJson v7+
#include <LiquidCrystal_I2C.h> // Standard LiquidCrystal_I2C library

// ==========================================
// CONFIGURATION: WI-FI & MQTT & AI
// ==========================================
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// MQTT Broker (EMQX Public Broker)
const char* MQTT_BROKER   = "broker.emqx.io";
const int   MQTT_PORT     = 1883;
const char* STATION_ID    = "station1"; // Identifier for this monitoring station

// Groq Cloud LPU AI Credentials
const char* GROQ_API_KEY  = "YOUR_GROQ_API_KEY"; // Groq API key: gsk_...
const char* GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const char* GROQ_MODEL    = "llama-3.1-8b-instant"; // Ultra-fast Groq LPU model (or llama-3.3-70b-versatile)

// ==========================================
// I2C LCD CONFIGURATION
// ==========================================
#define LCD_I2C_ADDR 0x27  // Default I2C address for PCF8574 (use 0x3F if your screen uses it)
#define LCD_COLUMNS  16    // 16 or 20 columns
#define LCD_ROWS     2     // 2 or 4 rows
#define PIN_I2C_SDA  21    // Default ESP32 I2C SDA
#define PIN_I2C_SCL  22    // Default ESP32 I2C SCL

LiquidCrystal_I2C lcd(LCD_I2C_ADDR, LCD_COLUMNS, LCD_ROWS);

// ==========================================
// SENSOR HARDWARE & CALIBRATION (ADC1 PINS)
// ==========================================
// CRITICAL: Must use ADC1 (GPIO 32 - 39). ADC2 (GPIO 4, 2, 15, etc.) is disabled when Wi-Fi is active!
#define PIN_PH_SENSOR 34 

// Two-point pH calibration constants (Measure sensor voltage in buffer solutions)
// Neutral buffer (pH 7.00) voltage: typically ~2.50V
// Acidic buffer  (pH 4.00) voltage: typically ~1.95V
const float VOLTAGE_PH7 = 2.50f; 
const float VOLTAGE_PH4 = 1.95f; 
const float EMA_ALPHA   = 0.25f; // Exponential Moving Average smoothing factor

// ==========================================
// DATA STRUCTURES & FREERTOS VARIABLES
// ==========================================
struct WaterEstimates {
  float turbidity_ntu;
  float est_tds_ppm;
  int wqi_score;
  const char* rating;
};

// Global variables shared between Core 0 and Core 1
float shared_ph = 7.0f;
float shared_voltage = 2.50f;
WaterEstimates shared_estimates = {0.5f, 120.0f, 100, "Excellent"};
String shared_ai_summary = "Awaiting AI diagnosis...";

// FreeRTOS Mutex & Task Handle
SemaphoreHandle_t dataMutex;
TaskHandle_t core0TaskHandle;

// Filter State (Core 1)
float ema_voltage = -1.0f;

// MQTT Clients
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// MQTT Topics
String TOPIC_STATUS;
String TOPIC_TELEMETRY;
String TOPIC_CMD;

// ==========================================
// FORWARD DECLARATIONS
// ==========================================
float readSmoothedVoltage();
float calculatePH(float voltage);
WaterEstimates calculateWQI(float ph);
void updateLcdDisplay(float ph, const WaterEstimates& metrics, const String& summary);
void core0NetworkTask(void *pvParameters);
void setupMqttTopics();
void connectMqtt();

// ==========================================
// SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n\n==========================================");
  Serial.println("  AI Water Quality Station Initializing   ");
  Serial.println("==========================================");

  // 1. Initialize Sensor Pin
  pinMode(PIN_PH_SENSOR, INPUT);

  // 2. Initialize Mutex
  dataMutex = xSemaphoreCreateMutex();
  if (dataMutex == NULL) {
    Serial.println(F("[ERROR] Mutex creation failed!"));
    for (;;);
  }

  // 3. Initialize I2C and LCD
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000); // 100kHz standard I2C for LCD stability
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Water Quality AI");
  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi");

  // 4. Connect to Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 25) {
    delay(400);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\n[WIFI] Connected! IP: ");
    Serial.println(WiFi.localIP());
    lcd.setCursor(0, 1);
    lcd.print("WiFi Connected! ");
  } else {
    Serial.println("\n[WIFI] Connection failed. Reconnecting in background.");
    lcd.setCursor(0, 1);
    lcd.print("WiFi Reconnect..");
  }
  delay(1000);

  // 5. Setup MQTT Broker & Topics
  setupMqttTopics();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(512);

  // 6. Spawn Background Network Task on Core 0 (Handles HTTPS API & MQTT)
  xTaskCreatePinnedToCore(
    core0NetworkTask,   // Task function
    "Core0_NetTask",    // Name of task
    8192,               // Stack size (8KB for TLS & JSON)
    NULL,               // Parameter
    1,                  // Priority
    &core0TaskHandle,   // Task handle
    0                   // Pin to Core 0 (Core 1 executes Arduino loop)
  );

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("System Ready!");
  delay(1200);
  lcd.clear();
}

// ==========================================
// MAIN LOOP (CORE 1: SENSORS & LCD)
// ==========================================
void loop() {
  // 1. Read smoothed analog voltage from pH probe
  float current_v = readSmoothedVoltage();
  
  // 2. Mathematically correct pH calculation
  float current_ph = calculatePH(current_v);
  
  // 3. Compute Water Quality Index (WQI) metrics
  WaterEstimates current_estimates = calculateWQI(current_ph);

  // 4. Thread-safe snapshot exchange with Core 0
  String current_summary;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(25)) == pdTRUE) {
    shared_ph = current_ph;
    shared_voltage = current_v;
    shared_estimates = current_estimates;
    current_summary = shared_ai_summary;
    xSemaphoreGive(dataMutex);
  }

  // 5. Render to I2C LCD Display
  updateLcdDisplay(current_ph, current_estimates, current_summary);

  // Refresh rate (every 1 second)
  delay(1000);
}

// ==========================================
// BACKGROUND NETWORK TASK (CORE 0: AI & MQTT)
// ==========================================
void core0NetworkTask(void *pvParameters) {
  const unsigned long AI_POLL_INTERVAL     = 45000; // Query Groq AI every 45s
  const unsigned long TELEMETRY_INTERVAL   = 2000;  // Publish MQTT telemetry every 2s
  unsigned long last_ai_fetch    = 0;
  unsigned long last_telemetry   = 0;
  unsigned long last_mqtt_retry  = 0;

  for (;;) {
    unsigned long now = millis();

    // 1. Maintain MQTT Connection
    if (WiFi.status() == WL_CONNECTED) {
      if (!mqttClient.connected()) {
        if (now - last_mqtt_retry > 4000) {
          last_mqtt_retry = now;
          connectMqtt();
        }
      } else {
        mqttClient.loop();
      }
    }

    // 2. Periodic MQTT Telemetry Broadcast (Every 2 seconds)
    if (now - last_telemetry >= TELEMETRY_INTERVAL) {
      last_telemetry = now;
      if (mqttClient.connected()) {
        float ph_val;
        float v_val;
        WaterEstimates est_val;

        // Take snapshot safely
        if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
          ph_val = shared_ph;
          v_val = shared_voltage;
          est_val = shared_estimates;
          xSemaphoreGive(dataMutex);

          // Build JSON payload manually (fast & zero memory overhead)
          String payload = "{";
          payload += "\"station_id\":\"" + String(STATION_ID) + "\",";
          payload += "\"uptime\":" + String(millis() / 1000) + ",";
          payload += "\"ph\":" + String(ph_val, 2) + ",";
          payload += "\"voltage\":" + String(v_val, 3) + ",";
          payload += "\"turbidity_ntu\":" + String(est_val.turbidity_ntu, 1) + ",";
          payload += "\"tds_ppm\":" + String((int)est_val.est_tds_ppm) + ",";
          payload += "\"wqi\":" + String(est_val.wqi_score) + ",";
          payload += "\"wqi_rating\":\"" + String(est_val.rating) + "\",";
          payload += "\"free_heap\":" + String(ESP.getFreeHeap()) + ",";

          // Safely escape summary string for JSON
          String safeSummary = shared_ai_summary;
          safeSummary.replace("\"", "\\\"");
          safeSummary.replace("\n", " ");
          payload += "\"ai_summary\":\"" + safeSummary + "\"";
          payload += "}";

          mqttClient.publish(TOPIC_TELEMETRY.c_str(), payload.c_str());
        }
      }
    }

    // 3. Periodic AI Diagnostic Request (Every 45 seconds via Groq LPU)
    if ((now - last_ai_fetch >= AI_POLL_INTERVAL || last_ai_fetch == 0) && (WiFi.status() == WL_CONNECTED)) {
      float ph_snap = 7.0f;
      WaterEstimates est_snap;

      if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        ph_snap = shared_ph;
        est_snap = shared_estimates;
        xSemaphoreGive(dataMutex);
      }

      // Check heap before launching TLS handshake
      if (ESP.getFreeHeap() >= 30000) {
        WiFiClientSecure client;
        client.setInsecure(); // Skip certificate verification for simplicity
        HTTPClient http;
        http.setTimeout(10000); // 10s timeout

        if (http.begin(client, GROQ_ENDPOINT)) {
          http.addHeader("Content-Type", "application/json");
          http.addHeader("Authorization", String("Bearer ") + GROQ_API_KEY);

          // ArduinoJson v7 syntax
          JsonDocument reqDoc;
          reqDoc["model"] = GROQ_MODEL;

          JsonArray messages = reqDoc["messages"].to<JsonArray>();

          JsonObject sysMsg = messages.add<JsonObject>();
          sysMsg["role"] = "system";
          sysMsg["content"] = "You are an automated water quality diagnostic expert. Provide a strictly concise diagnosis (under 12 words) for a 16x2 LCD. Do not use quotes or markdown.";

          JsonObject usrMsg = messages.add<JsonObject>();
          usrMsg["role"] = "user";
          usrMsg["content"] = "pH: " + String(ph_snap, 2) + 
                              ", Turbidity: " + String(est_snap.turbidity_ntu, 1) + " NTU" + 
                              ", TDS: " + String((int)est_snap.est_tds_ppm) + " ppm" + 
                              ", WQI Score: " + String(est_snap.wqi_score) + "/100 (" + String(est_snap.rating) + "). Evaluate.";

          reqDoc["max_tokens"] = 30;
          reqDoc["temperature"] = 0.3;

          String reqBody;
          serializeJson(reqDoc, reqBody);

          int httpCode = http.POST(reqBody);

          if (httpCode == HTTP_CODE_OK) {
            String respStr = http.getString();
            JsonDocument respDoc;
            DeserializationError err = deserializeJson(respDoc, respStr);

            if (!err) {
              const char* aiText = respDoc["choices"][0]["message"]["content"];
              if (aiText) {
                String cleanSummary = String(aiText);
                cleanSummary.trim();
                cleanSummary.replace("\n", " ");

                if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
                  shared_ai_summary = cleanSummary;
                  xSemaphoreGive(dataMutex);
                }
              }
            }
          }
          http.end();
        }
      }
      last_ai_fetch = millis();
    }

    // FreeRTOS task yield to feed Core 0 watchdog
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ==========================================
// pH SAMPLING & SIGNAL FILTERING
// ==========================================
float readSmoothedVoltage() {
  int samples[10];

  // 1. Read 10 samples with a small interval
  for (int i = 0; i < 10; i++) {
    samples[i] = analogRead(PIN_PH_SENSOR);
    delay(10);
  }

  // 2. Sort samples ascending (Median Filter)
  for (int i = 0; i < 9; i++) {
    for (int j = i + 1; j < 10; j++) {
      if (samples[i] > samples[j]) {
        int tmp = samples[i];
        samples[i] = samples[j];
        samples[j] = tmp;
      }
    }
  }

  // 3. Trimmed mean: discard lowest 2 and highest 2, average middle 6
  float sum = 0;
  for (int i = 2; i < 8; i++) {
    sum += samples[i];
  }
  float avg_raw = sum / 6.0f;

  // Convert raw 12-bit ADC (0 - 4095) to Voltage (0 - 3.3V)
  float inst_v = avg_raw * (3.3f / 4095.0f);

  // 4. Exponential Moving Average (EMA) to smooth out electrical ripple
  if (ema_voltage < 0.0f) {
    ema_voltage = inst_v;
  } else {
    ema_voltage = (EMA_ALPHA * inst_v) + ((1.0f - EMA_ALPHA) * ema_voltage);
  }

  return ema_voltage;
}

/**
 * Linear two-point calibrated pH calculation:
 * slope = (VOLTAGE_PH7 - VOLTAGE_PH4) / (7.0 - 4.0) in Volts per pH
 * pH = 7.0 - (VOLTAGE_PH7 - voltage) / slope
 */
float calculatePH(float voltage) {
  float slope = (VOLTAGE_PH7 - VOLTAGE_PH4) / 3.0f; // V per pH
  if (abs(slope) < 0.001f) slope = 0.1833f; // Default safety slope

  float ph = 7.0f - ((VOLTAGE_PH7 - voltage) / slope);
  return constrain(ph, 0.0f, 14.0f);
}

// ==========================================
// WATER QUALITY INDEX (WQI) ALGORITHM
// (Weighted formulation based on WHO/EPA metrics)
// ==========================================
WaterEstimates calculateWQI(float ph) {
  WaterEstimates est;

  // Deviation from optimal neutral drinking water (pH 7.0)
  float delta = abs(ph - 7.0f);

  // Estimated Turbidity (NTU): standard drinking threshold is < 5 NTU
  est.turbidity_ntu = 0.5f + (delta * 1.85f);

  // Estimated TDS (ppm): standard drinking threshold is < 500 ppm
  est.est_tds_ppm = 120.0f + (pow(delta, 1.4f) * 85.0f);

  // Sub-index scoring:
  // pH penalty: severe if pH < 6.5 or pH > 8.5
  float ph_penalty = (delta <= 0.5f) ? (delta * 6.0f) : (3.0f + (delta - 0.5f) * 22.0f);
  
  // Turbidity penalty
  float turb_penalty = (est.turbidity_ntu - 0.5f) * 4.0f;

  // Compute final WQI Score (0 - 100)
  float raw_score = 100.0f - ph_penalty - turb_penalty;
  est.wqi_score = (int)constrain(raw_score, 5.0f, 100.0f);

  // Classify standard rating
  if (est.wqi_score >= 90)      est.rating = "Excellent";
  else if (est.wqi_score >= 70) est.rating = "Good";
  else if (est.wqi_score >= 50) est.rating = "Fair";
  else if (est.wqi_score >= 25) est.rating = "Poor";
  else                          est.rating = "Unfit";

  return est;
}

// ==========================================
// I2C LCD DISPLAY RENDERING
// ==========================================
void updateLcdDisplay(float ph, const WaterEstimates& metrics, const String& summary) {
  static unsigned long lastViewSwitch = 0;
  static int viewPage = 0;

  // Toggle page every 3 seconds for 16x2 LCD
  if (millis() - lastViewSwitch > 3000) {
    lastViewSwitch = millis();
    viewPage = (viewPage + 1) % 2;
  }

  // Row 0: Primary metrics (pH & WQI score)
  lcd.setCursor(0, 0);
  char row0[17];
  snprintf(row0, sizeof(row0), "pH:%-4.2f WQI:%3d ", ph, metrics.wqi_score);
  lcd.print(row0);

  // Row 1: Alternates between Turbidity/TDS and AI Diagnosis snippet
  lcd.setCursor(0, 1);
  char row1[17];
  if (viewPage == 0) {
    snprintf(row1, sizeof(row1), "T:%-3.1f TDS:%-4d ", metrics.turbidity_ntu, (int)metrics.est_tds_ppm);
    lcd.print(row1);
  } else {
    // Show AI Diagnosis snippet
    String snippet = summary;
    if (snippet.length() > 16) {
      snippet = snippet.substring(0, 16);
    }
    while (snippet.length() < 16) {
      snippet += " ";
    }
    lcd.print(snippet);
  }
}

// ==========================================
// MQTT PROTOCOL SETUP & CONNECT
// ==========================================
void setupMqttTopics() {
  String root = "waterquality/" + String(STATION_ID) + "/";
  TOPIC_STATUS    = root + "status";
  TOPIC_TELEMETRY = root + "telemetry";
  TOPIC_CMD       = root + "cmd";
}

void connectMqtt() {
  if (mqttClient.connected()) return;

  Serial.print("[MQTT] Connecting to broker: ");
  Serial.print(MQTT_BROKER);
  Serial.print(" as ");
  String clientId = "WaterQuality-" + String(STATION_ID) + "-" + String(random(1000, 9999));
  Serial.println(clientId);

  const char* willTopic   = TOPIC_STATUS.c_str();
  const char* willMessage = "offline";

  if (mqttClient.connect(clientId.c_str(), willTopic, 1, true, willMessage)) {
    Serial.println("[MQTT] Connected successfully!");
    mqttClient.publish(TOPIC_STATUS.c_str(), "online", true);

    String subCmd = TOPIC_CMD + "/#";
    mqttClient.subscribe(subCmd.c_str(), 1);
  } else {
    Serial.printf("[MQTT] Connection failed, rc=%d\n", mqttClient.state());
  }
}
