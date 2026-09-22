/**
 * ============================================================================
 * HelioClean Command Center - Frontend Logic
 * ============================================================================
 * Handles:
 *  - MQTT over WebSockets connection to broker.emqx.io
 *  - Independent dual throttle sliders (Left/Right tracks) with spring-return
 *  - Interactive 2D Virtual Joystick for differential steering
 *  - Hold-to-run Directional D-Pad with keyboard shortcuts
 *  - Live sensor telemetry processing (Battery, Wi-Fi RSSI, Edge sensors, Water)
 *  - Actuator toggles with dry-run safety lockouts
 *  - Spacebar Emergency Stop
 * ============================================================================
 */

// ==========================================
// CONFIGURATION & PERSISTENCE
// ==========================================
const CONFIG_KEY = 'helioclean_config_v1';
const defaultConfig = {
    brokerHost: 'broker.emqx.io',
    brokerPort: 8084,
    brokerPath: '/mqtt',
    useSSL: true,
    botId: 'bot1',
    topicPrefix: 'helioclean'
};

function loadConfig() {
    try {
        const saved = localStorage.getItem(CONFIG_KEY);
        return saved ? { ...defaultConfig, ...JSON.parse(saved) } : { ...defaultConfig };
    } catch (e) {
        return { ...defaultConfig };
    }
}

function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

let appConfig = loadConfig();

// ==========================================
// APPLICATION STATE
// ==========================================
let mqttClient = null;
let isMqttConnected = false;
let isBotOnline = false;
let lastTelemetryTimestamp = 0;

// Motors & Drive State
let leftSpeed = 0;   // -255 to 255
let rightSpeed = 0;  // -255 to 255
let speedLimit = 160; // Base speed limit
let isDriveActive = false;
let driveIntervalTimer = null;
let currentDpadCommand = null;

// Actuator States
let brushActive = false;
let pumpActive = false;

// Sensor States
let waterDepleted = false;
let edgeAlertActive = false;

// ==========================================
// DOM ELEMENT REFERENCES
// ==========================================
const brokerDot = document.getElementById('brokerDot');
const brokerStatusText = document.getElementById('brokerStatusText');
const botDot = document.getElementById('botDot');
const botStatusText = document.getElementById('botStatusText');
const safetyAlertBanner = document.getElementById('safetyAlertBanner');
const liveHeartbeat = document.getElementById('liveHeartbeat');

// Telemetry Elements
const batteryPercent = document.getElementById('batteryPercent');
const batteryBar = document.getElementById('batteryBar');
const batteryVoltage = document.getElementById('batteryVoltage');
const wifiRssi = document.getElementById('wifiRssi');
const wifiQuality = document.getElementById('wifiQuality');
const signalBars = document.getElementById('signalBars');
const waterBadge = document.getElementById('waterBadge');
const waterIcon = document.getElementById('waterIcon');
const waterText = document.getElementById('waterText');
const edgeBadge = document.getElementById('edgeBadge');
const edgeLeftBox = document.getElementById('edgeLeftBox');
const edgeRightBox = document.getElementById('edgeRightBox');
const edgeLeftStatus = document.getElementById('edgeLeftStatus');
const edgeRightStatus = document.getElementById('edgeRightStatus');
const telemetryLeftMotor = document.getElementById('telemetryLeftMotor');
const telemetryRightMotor = document.getElementById('telemetryRightMotor');
const telemetryUptime = document.getElementById('telemetryUptime');

// MPU6050 IMU Elements
const imuTelemetry = document.getElementById('imuTelemetry');
const imuBadge = document.getElementById('imuBadge');
const imuPitchVal = document.getElementById('imuPitchVal');
const imuRollVal = document.getElementById('imuRollVal');
const imuTempVal = document.getElementById('imuTempVal');
const imuStatusSub = document.getElementById('imuStatusSub');
const inclinometerHorizon = document.getElementById('inclinometerHorizon');
const inclinometerBubble = document.getElementById('inclinometerBubble');

// Wheel Controls
const leftThrottleSlider = document.getElementById('leftThrottleSlider');
const rightThrottleSlider = document.getElementById('rightThrottleSlider');
const leftSliderVal = document.getElementById('leftSliderVal');
const rightSliderVal = document.getElementById('rightSliderVal');
const springReturnToggle = document.getElementById('springReturnToggle');
const zeroLeftBtn = document.getElementById('zeroLeftBtn');
const zeroRightBtn = document.getElementById('zeroRightBtn');
const speedLimitSlider = document.getElementById('speedLimitSlider');
const speedLimitText = document.getElementById('speedLimitText');

// D-Pad & Joystick
const tabDpadBtn = document.getElementById('tabDpadBtn');
const tabJoyBtn = document.getElementById('tabJoyBtn');
const paneDpad = document.getElementById('paneDpad');
const paneJoy = document.getElementById('paneJoy');
const joystickPad = document.getElementById('joystickPad');
const joystickKnob = document.getElementById('joystickKnob');

// Actuators
const brushTile = document.getElementById('brushTile');
const brushStatusText = document.getElementById('brushStatusText');
const brushToggleBtn = document.getElementById('brushToggleBtn');
const pumpTile = document.getElementById('pumpTile');
const pumpStatusText = document.getElementById('pumpStatusText');
const pumpToggleBtn = document.getElementById('pumpToggleBtn');
const emergencyStopBtn = document.getElementById('emergencyStopBtn');

// Settings Modal
const settingsModal = document.getElementById('settingsModal');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const cfgBrokerHost = document.getElementById('cfgBrokerHost');
const cfgBrokerPort = document.getElementById('cfgBrokerPort');
const cfgBrokerPath = document.getElementById('cfgBrokerPath');
const cfgBotId = document.getElementById('cfgBotId');
const footerBrokerLabel = document.getElementById('footerBrokerLabel');

// ==========================================
// MQTT CLIENT INITIALIZATION & TOPICS
// ==========================================
function getTopics() {
    const root = `${appConfig.topicPrefix}/${appConfig.botId}`;
    return {
        status: `${root}/status`,
        telemetry: `${root}/telemetry`,
        drive: `${root}/cmd/drive`,
        actuator: `${root}/cmd/actuator`,
        emergency: `${root}/cmd/emergency`,
        speed: `${root}/cmd/speed`
    };
}

function initMqtt() {
    if (mqttClient) {
        try { mqttClient.end(true); } catch (e) {}
    }

    footerBrokerLabel.innerText = `${appConfig.brokerHost}:${appConfig.brokerPort}`;
    updateBrokerStatus('connecting', 'Connecting...');

    const protocol = appConfig.useSSL ? 'wss' : 'ws';
    const brokerUrl = `${protocol}://${appConfig.brokerHost}:${appConfig.brokerPort}${appConfig.brokerPath}`;
    const clientId = `HelioWeb_${Math.random().toString(16).substring(2, 10)}`;

    console.log(`[MQTT] Connecting to ${brokerUrl} as ${clientId}`);

    const options = {
        clientId: clientId,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000
    };

    try {
        mqttClient = mqtt.connect(brokerUrl, options);

        mqttClient.on('connect', () => {
            console.log('[MQTT] Connected to broker successfully');
            isMqttConnected = true;
            updateBrokerStatus('connected', 'Connected');

            const topics = getTopics();
            // Subscribe to Robot status and Telemetry
            mqttClient.subscribe([topics.status, topics.telemetry], (err) => {
                if (err) console.error('[MQTT] Subscription error:', err);
                else console.log(`[MQTT] Subscribed to ${topics.status} and ${topics.telemetry}`);
            });
        });

        mqttClient.on('message', (topic, payload) => {
            handleIncomingMqttMessage(topic, payload.toString());
        });

        mqttClient.on('error', (err) => {
            console.error('[MQTT] Error:', err);
            updateBrokerStatus('disconnected', 'Error');
        });

        mqttClient.on('offline', () => {
            isMqttConnected = false;
            updateBrokerStatus('disconnected', 'Offline');
            setBotOnlineState(false);
        });

        mqttClient.on('reconnect', () => {
            updateBrokerStatus('connecting', 'Reconnecting...');
        });

    } catch (err) {
        console.error('[MQTT] Setup exception:', err);
        updateBrokerStatus('disconnected', 'Failed');
    }
}

function updateBrokerStatus(state, text) {
    brokerDot.className = `status-dot ${state}`;
    brokerStatusText.innerText = text;
}

function setBotOnlineState(online) {
    isBotOnline = online;
    if (online) {
        botDot.className = 'status-dot connected';
        botStatusText.innerText = 'Online';
        botStatusText.style.color = 'var(--accent-green)';
    } else {
        botDot.className = 'status-dot disconnected';
        botStatusText.innerText = 'Offline';
        botStatusText.style.color = 'var(--text-muted)';
    }
}

// ==========================================
// MQTT INCOMING MESSAGE HANDLER
// ==========================================
function handleIncomingMqttMessage(topic, message) {
    const topics = getTopics();

    // 1. Robot Online / Offline Status
    if (topic === topics.status) {
        const isOnline = (message.trim() === 'online');
        setBotOnlineState(isOnline);
        return;
    }

    // 2. Telemetry Payload
    if (topic === topics.telemetry) {
        try {
            const data = JSON.parse(message);
            updateTelemetryDisplay(data);
            setBotOnlineState(true);
        } catch (e) {
            console.warn('[MQTT] Non-JSON telemetry received:', message);
        }
    }
}

// ==========================================
// TELEMETRY DISPLAY SYNC
// ==========================================
function updateTelemetryDisplay(data) {
    lastTelemetryTimestamp = Date.now();
    
    // Heartbeat indicator animation
    liveHeartbeat.style.boxShadow = '0 0 10px var(--accent-green)';
    setTimeout(() => { liveHeartbeat.style.boxShadow = 'none'; }, 250);

    // 1. Battery Gauge
    if (data.sensors) {
        const pct = Math.max(0, Math.min(100, data.sensors.battery_pct ?? 0));
        const v = (data.sensors.battery_v ?? 0).toFixed(2);
        batteryPercent.innerText = `${pct}%`;
        batteryVoltage.innerText = `${v} V (3S LiPo)`;
        batteryBar.style.width = `${pct}%`;

        if (pct > 40) {
            batteryBar.style.backgroundColor = 'var(--accent-green)';
        } else if (pct > 20) {
            batteryBar.style.backgroundColor = 'var(--accent-amber)';
        } else {
            batteryBar.style.backgroundColor = 'var(--accent-red)';
        }

        // 2. Edge / Drop-off Sensors
        const edgeL = !!data.sensors.edge_left;
        const edgeR = !!data.sensors.edge_right;
        const edgeWarn = !!data.sensors.edge_warning;

        edgeLeftDetectedUI(edgeL);
        edgeRightDetectedUI(edgeR);

        if (edgeWarn) {
            edgeAlertActive = true;
            edgeBadge.className = 'status-badge badge-warn';
            edgeBadge.innerText = 'HAZARD!';
            safetyAlertBanner.classList.add('active');
        } else {
            edgeAlertActive = false;
            edgeBadge.className = 'status-badge badge-ok';
            edgeBadge.innerText = 'CLEAR';
            safetyAlertBanner.classList.remove('active');
        }

        // 3. Water Level
        waterDepleted = !!data.sensors.water_empty;
        if (waterDepleted) {
            waterBadge.className = 'status-badge badge-warn';
            waterBadge.innerText = 'DEPLETED';
            waterIcon.innerText = '⚠️';
            waterText.innerText = 'Refill Required';
            waterText.style.color = 'var(--accent-red)';
        } else {
            waterBadge.className = 'status-badge badge-ok';
            waterBadge.innerText = 'NORMAL';
            waterIcon.innerText = '💧';
            waterText.innerText = 'Adequate Level';
            waterText.style.color = 'var(--text-primary)';
        }
    }

    // 4. Wi-Fi RSSI
    if (data.rssi !== undefined) {
        const rssi = data.rssi;
        wifiRssi.innerText = `${rssi} dBm`;
        signalBars.className = 'signal-bars';
        if (rssi >= -60) {
            signalBars.classList.add('good');
            wifiQuality.innerText = 'Excellent Signal';
        } else if (rssi >= -75) {
            signalBars.classList.add('medium');
            wifiQuality.innerText = 'Good Signal';
        } else {
            signalBars.classList.add('weak');
            wifiQuality.innerText = 'Weak Signal';
        }
    }

    // 5. Motor Outputs Feedback
    if (data.motors) {
        telemetryLeftMotor.innerText = `${data.motors.left} PWM`;
        telemetryRightMotor.innerText = `${data.motors.right} PWM`;
    }

    // 6. Uptime
    if (data.uptime !== undefined) {
        const mins = Math.floor(data.uptime / 60);
        const secs = data.uptime % 60;
        telemetryUptime.innerText = `${mins}m ${secs}s`;
    }

    // 7. Sync Actuator States from Bot
    if (data.actuators) {
        syncActuatorUI('brush', data.actuators.brush);
        syncActuatorUI('pump', data.actuators.pump);
    }

    // 8. MPU6050 6-Axis IMU & Inclinometer
    if (data.imu) {
        const isImuConnected = !!data.imu.connected;
        const pitch = data.imu.pitch ?? 0;
        const roll = data.imu.roll ?? 0;
        const temp = data.imu.temp ?? 0;
        const tiltWarn = !!data.imu.tilt_warning;

        if (isImuConnected) {
            imuPitchVal.innerText = `${pitch >= 0 ? '+' : ''}${pitch.toFixed(1)}°`;
            imuRollVal.innerText = `${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°`;
            imuTempVal.innerText = `${temp.toFixed(1)}°C`;
            imuStatusSub.innerText = 'MPU6050 Active';

            // Animate Artificial Horizon & Level Bubble
            // Clamp shift within the dial boundaries
            const shiftY = Math.max(-20, Math.min(20, pitch * 0.7));
            const shiftX = Math.max(-20, Math.min(20, roll * 0.7));
            if (inclinometerHorizon) {
                inclinometerHorizon.style.transform = `translateY(${shiftY}px) rotate(${-roll}deg)`;
            }
            if (inclinometerBubble) {
                inclinometerBubble.style.transform = `translate(calc(-50% + ${shiftX}px), calc(-50% + ${shiftY}px))`;
            }

            if (tiltWarn) {
                imuBadge.className = 'status-badge badge-warn';
                imuBadge.innerText = 'STEEP TILT!';
                safetyAlertBanner.classList.add('active');
                const titleElem = document.getElementById('alertTitle');
                const descElem = document.getElementById('alertDesc');
                if (titleElem && descElem) {
                    titleElem.innerText = 'EXCESSIVE ROBOT TILT HAZARD!';
                    descElem.innerText = `Robot incline (Pitch: ${pitch.toFixed(1)}°, Roll: ${roll.toFixed(1)}°) exceeds 45° limit. Danger of tipping/slipping!`;
                }
            } else if (!edgeAlertActive) {
                imuBadge.className = 'status-badge badge-ok';
                imuBadge.innerText = (Math.abs(pitch) < 3 && Math.abs(roll) < 3) ? 'LEVEL' : 'NORMAL';
            }
        } else {
            imuBadge.className = 'status-badge';
            imuBadge.innerText = 'NO IMU';
            imuStatusSub.innerText = 'I2C sensor not detected';
        }
    }
}

function edgeLeftDetectedUI(triggered) {
    if (triggered) {
        edgeLeftBox.classList.add('triggered');
        edgeLeftStatus.innerText = 'DROP-OFF';
    } else {
        edgeLeftBox.classList.remove('triggered');
        edgeLeftStatus.innerText = 'CLEAR';
    }
}

function edgeRightDetectedUI(triggered) {
    if (triggered) {
        edgeRightBox.classList.add('triggered');
        edgeRightStatus.innerText = 'DROP-OFF';
    } else {
        edgeRightBox.classList.remove('triggered');
        edgeRightStatus.innerText = 'CLEAR';
    }
}

// ==========================================
// DRIVE COMMAND DISPATCHER (MQTT)
// ==========================================
function sendDriveCommand(left, right) {
    if (!mqttClient || !isMqttConnected) return;

    // Constrain
    left = Math.max(-255, Math.min(255, Math.round(left)));
    right = Math.max(-255, Math.min(255, Math.round(right)));

    const topics = getTopics();
    const payload = JSON.stringify({ left: left, right: right });
    mqttClient.publish(topics.drive, payload, { qos: 0 });
}

function sendStopCommand() {
    leftSpeed = 0;
    rightSpeed = 0;
    leftThrottleSlider.value = 0;
    rightThrottleSlider.value = 0;
    leftSliderVal.innerText = '0';
    rightSliderVal.innerText = '0';

    if (mqttClient && isMqttConnected) {
        const topics = getTopics();
        mqttClient.publish(topics.drive, JSON.stringify({ left: 0, right: 0 }), { qos: 1 });
    }
}

function startDriveLoop() {
    if (driveIntervalTimer) return;
    // Transmit drive packet every 100ms to keep firmware watchdog alive
    driveIntervalTimer = setInterval(() => {
        sendDriveCommand(leftSpeed, rightSpeed);
    }, 100);
}

function stopDriveLoop() {
    if (driveIntervalTimer) {
        clearInterval(driveIntervalTimer);
        driveIntervalTimer = null;
    }
    sendStopCommand();
}

// ==========================================
// DUAL THROTTLE SLIDER CONTROLS
// ==========================================
function setupThrottleSliders() {
    // Left Throttle
    leftThrottleSlider.addEventListener('input', (e) => {
        leftSpeed = parseInt(e.target.value, 10);
        leftSliderVal.innerText = (leftSpeed > 0 ? `+${leftSpeed}` : `${leftSpeed}`);
        isDriveActive = (leftSpeed !== 0 || rightSpeed !== 0);
        if (isDriveActive) startDriveLoop();
        else stopDriveLoop();
    });

    // Right Throttle
    rightThrottleSlider.addEventListener('input', (e) => {
        rightSpeed = parseInt(e.target.value, 10);
        rightSliderVal.innerText = (rightSpeed > 0 ? `+${rightSpeed}` : `${rightSpeed}`);
        isDriveActive = (leftSpeed !== 0 || rightSpeed !== 0);
        if (isDriveActive) startDriveLoop();
        else stopDriveLoop();
    });

    // Auto-Center / Spring-to-center on release
    const handleSliderRelease = (slider, isLeft) => {
        if (springReturnToggle.checked) {
            slider.value = 0;
            if (isLeft) {
                leftSpeed = 0;
                leftSliderVal.innerText = '0';
            } else {
                rightSpeed = 0;
                rightSliderVal.innerText = '0';
            }
            if (leftSpeed === 0 && rightSpeed === 0) {
                stopDriveLoop();
            }
        }
    };

    leftThrottleSlider.addEventListener('mouseup', () => handleSliderRelease(leftThrottleSlider, true));
    leftThrottleSlider.addEventListener('touchend', () => handleSliderRelease(leftThrottleSlider, true));
    leftThrottleSlider.addEventListener('pointerup', () => handleSliderRelease(leftThrottleSlider, true));

    rightThrottleSlider.addEventListener('mouseup', () => handleSliderRelease(rightThrottleSlider, false));
    rightThrottleSlider.addEventListener('touchend', () => handleSliderRelease(rightThrottleSlider, false));
    rightThrottleSlider.addEventListener('pointerup', () => handleSliderRelease(rightThrottleSlider, false));

    // Zero Buttons
    zeroLeftBtn.addEventListener('click', () => {
        leftThrottleSlider.value = 0;
        leftSpeed = 0;
        leftSliderVal.innerText = '0';
        if (rightSpeed === 0) stopDriveLoop();
        else sendDriveCommand(leftSpeed, rightSpeed);
    });

    zeroRightBtn.addEventListener('click', () => {
        rightThrottleSlider.value = 0;
        rightSpeed = 0;
        rightSliderVal.innerText = '0';
        if (leftSpeed === 0) stopDriveLoop();
        else sendDriveCommand(leftSpeed, rightSpeed);
    });

    // Speed Limiter Slider
    speedLimitSlider.addEventListener('input', (e) => {
        speedLimit = parseInt(e.target.value, 10);
        const pct = Math.round((speedLimit / 255) * 100);
        speedLimitText.innerText = `${speedLimit} (${pct}%)`;

        if (mqttClient && isMqttConnected) {
            const topics = getTopics();
            mqttClient.publish(topics.speed, String(speedLimit));
        }
    });
}

// ==========================================
// DIRECTIONAL D-PAD BUTTONS (HOLD-TO-RUN)
// ==========================================
const dpadActions = {
    btnForward:      () => ({ left: speedLimit, right: speedLimit }),
    btnReverse:      () => ({ left: -speedLimit, right: -speedLimit }),
    btnSpinLeft:     () => ({ left: -speedLimit, right: speedLimit }),
    btnSpinRight:    () => ({ left: speedLimit, right: -speedLimit }),
    btnPivotFwdLeft: () => ({ left: Math.round(speedLimit * 0.35), right: speedLimit }),
    btnPivotFwdRight:() => ({ left: speedLimit, right: Math.round(speedLimit * 0.35) }),
    btnPivotRevLeft: () => ({ left: -Math.round(speedLimit * 0.35), right: -speedLimit }),
    btnPivotRevRight:() => ({ left: -speedLimit, right: -Math.round(speedLimit * 0.35) }),
    btnCenterStop:   () => ({ left: 0, right: 0 })
};

function setupDpadButtons() {
    Object.keys(dpadActions).forEach(btnId => {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        const startAction = (e) => {
            e.preventDefault();
            btn.classList.add('pressed');
            currentDpadCommand = btnId;
            const target = dpadActions[btnId]();
            leftSpeed = target.left;
            rightSpeed = target.right;
            leftThrottleSlider.value = leftSpeed;
            rightThrottleSlider.value = rightSpeed;
            leftSliderVal.innerText = (leftSpeed > 0 ? `+${leftSpeed}` : `${leftSpeed}`);
            rightSliderVal.innerText = (rightSpeed > 0 ? `+${rightSpeed}` : `${rightSpeed}`);
            startDriveLoop();
        };

        const stopAction = (e) => {
            e.preventDefault();
            btn.classList.remove('pressed');
            if (currentDpadCommand === btnId) {
                currentDpadCommand = null;
                stopDriveLoop();
            }
        };

        btn.addEventListener('pointerdown', startAction);
        btn.addEventListener('pointerup', stopAction);
        btn.addEventListener('pointerleave', stopAction);
        btn.addEventListener('pointercancel', stopAction);
    });
}

// ==========================================
// 2D VIRTUAL JOYSTICK FOR DIFFERENTIAL DRIVE
// ==========================================
function setupJoystick() {
    let isDragging = false;
    const padRect = () => joystickPad.getBoundingClientRect();
    const maxRadius = 60; // Max distance knob can travel from center

    function processJoystick(clientX, clientY) {
        const rect = padRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let deltaX = clientX - centerX;
        let deltaY = centerY - clientY; // Up is positive

        const distance = Math.hypot(deltaX, deltaY);
        if (distance > maxRadius) {
            deltaX = (deltaX / distance) * maxRadius;
            deltaY = (deltaY / distance) * maxRadius;
        }

        // Move knob visually
        joystickKnob.style.transform = `translate(${deltaX}px, ${-deltaY}px)`;

        // Normalized values (-1 to 1)
        const normX = deltaX / maxRadius; // Turning: -1 (full left) to 1 (full right)
        const normY = deltaY / maxRadius; // Throttle: -1 (full reverse) to 1 (full forward)

        // Differential Steering Calculation
        const throttle = normY * speedLimit;
        const turn = normX * speedLimit;

        leftSpeed = Math.round(Math.max(-255, Math.min(255, throttle + turn)));
        rightSpeed = Math.round(Math.max(-255, Math.min(255, throttle - turn)));

        leftThrottleSlider.value = leftSpeed;
        rightThrottleSlider.value = rightSpeed;
        leftSliderVal.innerText = (leftSpeed > 0 ? `+${leftSpeed}` : `${leftSpeed}`);
        rightSliderVal.innerText = (rightSpeed > 0 ? `+${rightSpeed}` : `${rightSpeed}`);

        startDriveLoop();
    }

    function resetJoystick() {
        isDragging = false;
        joystickKnob.style.transform = `translate(0px, 0px)`;
        stopDriveLoop();
    }

    joystickPad.addEventListener('pointerdown', (e) => {
        isDragging = true;
        joystickPad.setPointerCapture(e.pointerId);
        processJoystick(e.clientX, e.clientY);
    });

    joystickPad.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        processJoystick(e.clientX, e.clientY);
    });

    joystickPad.addEventListener('pointerup', resetJoystick);
    joystickPad.addEventListener('pointercancel', resetJoystick);

    // Tab switching (D-Pad vs Joystick)
    tabDpadBtn.addEventListener('click', () => {
        tabDpadBtn.classList.add('active');
        tabJoyBtn.classList.remove('active');
        paneDpad.classList.add('active');
        paneJoy.classList.remove('active');
    });

    tabJoyBtn.addEventListener('click', () => {
        tabJoyBtn.classList.add('active');
        tabDpadBtn.classList.remove('active');
        paneJoy.classList.add('active');
        paneDpad.classList.remove('active');
    });
}

// ==========================================
// KEYBOARD NAVIGATION SHORTCUTS
// ==========================================
function setupKeyboardControls() {
    const keyMap = {
        'KeyW': 'btnForward',
        'KeyS': 'btnReverse',
        'KeyA': 'btnSpinLeft',
        'KeyD': 'btnSpinRight',
        'KeyQ': 'btnPivotFwdLeft',
        'KeyE': 'btnPivotFwdRight'
    };

    const activeKeys = new Set();

    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return; // Ignore if typing in text inputs

        // Spacebar = EMERGENCY STOP
        if (e.code === 'Space') {
            e.preventDefault();
            triggerEmergencyStop();
            return;
        }

        if (keyMap[e.code] && !activeKeys.has(e.code)) {
            e.preventDefault();
            activeKeys.add(e.code);
            const btnId = keyMap[e.code];
            const btn = document.getElementById(btnId);
            if (btn) btn.dispatchEvent(new PointerEvent('pointerdown'));
        }
    });

    window.addEventListener('keyup', (e) => {
        if (keyMap[e.code] && activeKeys.has(e.code)) {
            e.preventDefault();
            activeKeys.delete(e.code);
            const btnId = keyMap[e.code];
            const btn = document.getElementById(btnId);
            if (btn) btn.dispatchEvent(new PointerEvent('pointerup'));
        }
    });
}

// ==========================================
// ACTUATOR CONTROLS (BRUSH & PUMP)
// ==========================================
function syncActuatorUI(type, active) {
    if (type === 'brush') {
        brushActive = active;
        if (active) {
            brushTile.classList.add('active');
            brushStatusText.innerText = 'ON';
            brushToggleBtn.innerText = 'TURN OFF';
        } else {
            brushTile.classList.remove('active');
            brushStatusText.innerText = 'OFF';
            brushToggleBtn.innerText = 'TURN ON';
        }
    } else if (type === 'pump') {
        pumpActive = active;
        if (active) {
            pumpTile.classList.add('active');
            pumpStatusText.innerText = 'ON';
            pumpToggleBtn.innerText = 'TURN OFF';
        } else {
            pumpTile.classList.remove('active');
            pumpStatusText.innerText = 'OFF';
            pumpToggleBtn.innerText = 'TURN ON';
        }
    }
}

function setupActuatorButtons() {
    // Brush Toggle
    brushToggleBtn.addEventListener('click', () => {
        const nextState = !brushActive;
        syncActuatorUI('brush', nextState);
        if (mqttClient && isMqttConnected) {
            const topics = getTopics();
            mqttClient.publish(topics.actuator, JSON.stringify({ brush: nextState }), { qos: 1 });
        }
    });

    // Pump Toggle (with dry-run lockout)
    pumpToggleBtn.addEventListener('click', () => {
        if (!pumpActive && waterDepleted) {
            alert('⚠️ CANNOT ACTIVATE PUMP:\nWater reservoir is empty! Refill tank before turning on spray pump.');
            return;
        }
        const nextState = !pumpActive;
        syncActuatorUI('pump', nextState);
        if (mqttClient && isMqttConnected) {
            const topics = getTopics();
            mqttClient.publish(topics.actuator, JSON.stringify({ pump: nextState }), { qos: 1 });
        }
    });

    // Emergency Stop
    emergencyStopBtn.addEventListener('click', triggerEmergencyStop);
}

function triggerEmergencyStop() {
    console.warn('[EMERGENCY] Full Emergency Stop Triggered!');
    stopDriveLoop();
    syncActuatorUI('brush', false);
    syncActuatorUI('pump', false);

    if (mqttClient && isMqttConnected) {
        const topics = getTopics();
        mqttClient.publish(topics.emergency, JSON.stringify({ emergency: true }), { qos: 2 });
    }
}

// ==========================================
// SETTINGS MODAL
// ==========================================
function setupSettingsModal() {
    const populateInputs = () => {
        cfgBrokerHost.value = appConfig.brokerHost;
        cfgBrokerPort.value = appConfig.brokerPort;
        cfgBrokerPath.value = appConfig.brokerPath;
        cfgBotId.value = appConfig.botId;
    };

    openSettingsBtn.addEventListener('click', () => {
        populateInputs();
        settingsModal.classList.add('open');
    });

    const closeModal = () => settingsModal.classList.remove('open');
    closeSettingsBtn.addEventListener('click', closeModal);
    cancelSettingsBtn.addEventListener('click', closeModal);

    saveSettingsBtn.addEventListener('click', () => {
        appConfig.brokerHost = cfgBrokerHost.value.trim() || defaultConfig.brokerHost;
        appConfig.brokerPort = parseInt(cfgBrokerPort.value, 10) || defaultConfig.brokerPort;
        appConfig.brokerPath = cfgBrokerPath.value.trim() || defaultConfig.brokerPath;
        appConfig.botId = cfgBotId.value.trim() || defaultConfig.botId;

        saveConfig(appConfig);
        closeModal();

        // Reconnect with new settings
        initMqtt();
    });
}

// ==========================================
// APPLICATION ENTRY POINT
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    console.log('[APP] HelioClean Command Center starting...');
    setupThrottleSliders();
    setupDpadButtons();
    setupJoystick();
    setupKeyboardControls();
    setupActuatorButtons();
    setupSettingsModal();

    // Connect to MQTT Broker
    initMqtt();
});
