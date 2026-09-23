/**
 * AquaSense AI - Real-Time Water Quality Station Dashboard
 * High-Performance Telemetry, Chart.js Visualization, and MQTT WebSocket Engine
 */

(function () {
    'use strict';

    // ---------------- CONFIGURATION & STATE ----------------
    const STORAGE_KEY = 'aquasense_config_v1';
    const MAX_CHART_SAMPLES = 30; // Rolling window for real-time chart
    const STATION_TIMEOUT_MS = 6000; // Time without telemetry before marking station offline

    const defaultConfig = {
        brokerHost: 'broker.emqx.io',
        brokerPort: 8084,
        brokerPath: '/mqtt',
        stationId: 'station1',
        topicPrefix: 'waterquality',
        autoSimulate: false
    };

    let config = loadConfig();
    let mqttClient = null;
    let stationHeartbeatTimer = null;
    let simulationInterval = null;

    // Telemetry History Log for Session Analytics & CSV Export
    const telemetryHistory = [];

    // Current Active Graph Tab: 'ph' | 'wqi' | 'turbt_tds'
    let currentChartTab = 'ph';
    let chartInstance = null;

    // DOM Elements
    const elements = {
        // Status Bar
        brokerDot: document.getElementById('brokerDot'),
        brokerStatusText: document.getElementById('brokerStatusText'),
        stationDot: document.getElementById('stationDot'),
        stationStatusText: document.getElementById('stationStatusText'),
        footerBrokerLabel: document.getElementById('footerBrokerLabel'),

        // AI Diagnostic Banner
        potabilityBadge: document.getElementById('potabilityBadge'),
        aiTimeTag: document.getElementById('aiTimeTag'),
        aiSummaryText: document.getElementById('aiSummaryText'),

        // Sensor Metrics
        valPh: document.getElementById('valPh'),
        valVoltage: document.getElementById('valVoltage'),
        phNeedle: document.getElementById('phNeedle'),
        phStateBadge: document.getElementById('phStateBadge'),

        valWqi: document.getElementById('valWqi'),
        wqiRatingBadge: document.getElementById('wqiRatingBadge'),
        wqiBarFill: document.getElementById('wqiBarFill'),

        valTurbidity: document.getElementById('valTurbidity'),
        turbStateBadge: document.getElementById('turbStateBadge'),
        turbLevel1: document.getElementById('turbLevel1'),
        turbLevel2: document.getElementById('turbLevel2'),
        turbLevel3: document.getElementById('turbLevel3'),

        valTds: document.getElementById('valTds'),
        tdsStateBadge: document.getElementById('tdsStateBadge'),
        tdsLevel1: document.getElementById('tdsLevel1'),
        tdsLevel2: document.getElementById('tdsLevel2'),
        tdsLevel3: document.getElementById('tdsLevel3'),

        // Chart & Tabs
        chartCanvas: document.getElementById('liveChart'),
        tabChartPh: document.getElementById('tabChartPh'),
        tabChartWqi: document.getElementById('tabChartWqi'),
        tabChartTurbTds: document.getElementById('tabChartTurbTds'),
        chartLegendRow: document.getElementById('chartLegendRow'),

        // Session Analytics
        statPhMinMax: document.getElementById('statPhMinMax'),
        statPhAvg: document.getElementById('statPhAvg'),
        statWqiAvg: document.getElementById('statWqiAvg'),
        statSamples: document.getElementById('statSamples'),
        exportCsvBtn: document.getElementById('exportCsvBtn'),

        // Settings Modal
        settingsModal: document.getElementById('settingsModal'),
        openSettingsBtn: document.getElementById('openSettingsBtn'),
        closeSettingsBtn: document.getElementById('closeSettingsBtn'),
        cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
        saveSettingsBtn: document.getElementById('saveSettingsBtn'),
        cfgBrokerHost: document.getElementById('cfgBrokerHost'),
        cfgBrokerPort: document.getElementById('cfgBrokerPort'),
        cfgBrokerPath: document.getElementById('cfgBrokerPath'),
        cfgStationId: document.getElementById('cfgStationId'),
        cfgTopicPrefix: document.getElementById('cfgTopicPrefix')
    };

    // ---------------- LOCAL CONFIG PERSISTENCE ----------------
    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return { ...defaultConfig, ...JSON.parse(raw) };
        } catch (e) {
            console.warn('Failed to load local config:', e);
        }
        return { ...defaultConfig };
    }

    function saveConfig(newCfg) {
        config = { ...config, ...newCfg };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch (e) {
            console.error('Failed to save config:', e);
        }
    }

    // ---------------- MQTT WEBSOCKET CONNECTION ----------------
    function initMqtt() {
        if (mqttClient) {
            try {
                mqttClient.end(true);
            } catch (e) {}
            mqttClient = null;
        }

        const clientId = 'AquaSenseWeb_' + Math.random().toString(16).substring(2, 10);
        const brokerUrl = `wss://${config.brokerHost}:${config.brokerPort}${config.brokerPath}`;

        elements.brokerDot.className = 'status-dot';
        elements.brokerStatusText.textContent = 'Connecting...';
        elements.footerBrokerLabel.textContent = config.brokerHost;

        console.log(`[AquaSense] Connecting to MQTT Broker at ${brokerUrl} as ${clientId}...`);

        try {
            mqttClient = mqtt.connect(brokerUrl, {
                clientId: clientId,
                clean: true,
                connectTimeout: 8000,
                reconnectPeriod: 4000,
                keepalive: 30
            });

            mqttClient.on('connect', () => {
                console.log('[AquaSense] Connected to MQTT broker successfully.');
                elements.brokerDot.className = 'status-dot connected';
                elements.brokerStatusText.textContent = 'Connected';

                // Subscribe to telemetry & station status
                const telemetryTopic = `${config.topicPrefix}/${config.stationId}/telemetry`;
                const statusTopic = `${config.topicPrefix}/${config.stationId}/status`;

                mqttClient.subscribe([telemetryTopic, statusTopic], (err, granted) => {
                    if (err) {
                        console.error('[AquaSense] Subscription error:', err);
                    } else {
                        console.log(`[AquaSense] Subscribed to ${telemetryTopic} and ${statusTopic}`);
                    }
                });
            });

            mqttClient.on('message', (topic, message) => {
                handleIncomingMessage(topic, message.toString());
            });

            mqttClient.on('error', (err) => {
                console.warn('[AquaSense] MQTT error:', err);
                elements.brokerDot.className = 'status-dot disconnected';
                elements.brokerStatusText.textContent = 'Error';
            });

            mqttClient.on('close', () => {
                elements.brokerDot.className = 'status-dot disconnected';
                elements.brokerStatusText.textContent = 'Disconnected';
            });

            mqttClient.on('offline', () => {
                elements.brokerDot.className = 'status-dot disconnected';
                elements.brokerStatusText.textContent = 'Offline';
            });

        } catch (e) {
            console.error('[AquaSense] MQTT Initialization exception:', e);
            elements.brokerDot.className = 'status-dot disconnected';
            elements.brokerStatusText.textContent = 'Failed';
        }
    }

    // ---------------- MESSAGE DISPATCHER ----------------
    function handleIncomingMessage(topic, msgStr) {
        try {
            const payload = JSON.parse(msgStr);
            const telemetryTopic = `${config.topicPrefix}/${config.stationId}/telemetry`;
            const statusTopic = `${config.topicPrefix}/${config.stationId}/status`;

            if (topic === statusTopic) {
                if (payload.status === 'online') {
                    markStationOnline();
                } else {
                    markStationOffline();
                }
            } else if (topic === telemetryTopic || payload.ph !== undefined) {
                if (simulationInterval) {
                    clearInterval(simulationInterval);
                    simulationInterval = null;
                    console.log('[AquaSense] Real ESP32 telemetry detected! Disabling simulation.');
                }
                markStationOnline();
                processTelemetry(payload);
            }
        } catch (e) {
            console.warn('[AquaSense] Error parsing incoming MQTT JSON:', e, msgStr);
        }
    }

    function markStationOnline() {
        elements.stationDot.className = 'status-dot online';
        elements.stationStatusText.textContent = 'Online';

        // Reset inactivity watchdog
        if (stationHeartbeatTimer) clearTimeout(stationHeartbeatTimer);
        stationHeartbeatTimer = setTimeout(() => {
            markStationOffline();
        }, STATION_TIMEOUT_MS);
    }

    function markStationOffline() {
        elements.stationDot.className = 'status-dot offline';
        elements.stationStatusText.textContent = 'Offline';
    }

    // ---------------- TELEMETRY PROCESSING & UI UPDATE ----------------
    function processTelemetry(data) {
        const timestamp = new Date();
        const timeLabel = timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const ph = typeof data.ph === 'number' ? data.ph : parseFloat(data.ph) || 7.0;
        const voltage = typeof data.voltage === 'number' ? data.voltage : parseFloat(data.voltage) || 2.5;
        const turbidity = typeof data.turbidity_ntu === 'number' ? data.turbidity_ntu : parseFloat(data.turbidity_ntu) || 0.0;
        const tds = typeof data.tds_ppm === 'number' ? data.tds_ppm : parseFloat(data.tds_ppm) || 0.0;
        const wqi = typeof data.wqi === 'number' ? Math.round(data.wqi) : parseInt(data.wqi) || 100;
        const rating = data.wqi_rating || data.rating || evaluateWqiRating(wqi);
        const diagnostic = data.ai_summary || data.diagnostic || "Sensors reading nominal. Continuous stream active.";
        const potable = data.potable !== undefined ? data.potable : (ph >= 6.5 && ph <= 8.5 && turbidity <= 5.0 && tds <= 1000 && wqi >= 70);

        // Store sample in session history
        const record = {
            timestamp: timestamp.toISOString(),
            timeLabel: timeLabel,
            ph: ph,
            voltage: voltage,
            turbidity: turbidity,
            tds: tds,
            wqi: wqi,
            rating: rating,
            potable: potable,
            diagnostic: diagnostic
        };
        telemetryHistory.push(record);

        // 1. Update Hero AI Diagnostic Banner
        elements.aiSummaryText.textContent = diagnostic;
        elements.aiTimeTag.textContent = `Updated ${timeLabel}`;
        updatePotabilityBadge(potable, wqi, ph, turbidity);

        // 2. Update pH Card & Needle
        elements.valPh.textContent = ph.toFixed(2);
        elements.valVoltage.textContent = `${voltage.toFixed(3)} V`;
        updatePhGauge(ph);

        // 3. Update WQI Card & Progress Bar
        elements.valWqi.textContent = wqi;
        elements.wqiRatingBadge.textContent = rating.toUpperCase();
        updateWqiBadgeClass(elements.wqiRatingBadge, wqi);
        elements.wqiBarFill.style.width = `${Math.max(0, Math.min(100, wqi))}%`;

        // 4. Update Turbidity Card & Indicators
        elements.valTurbidity.textContent = turbidity.toFixed(1);
        updateTurbidityIndicators(turbidity);

        // 5. Update TDS Card & Indicators
        elements.valTds.textContent = Math.round(tds);
        updateTdsIndicators(tds);

        // 6. Update Real-Time Chart
        appendChartData(timeLabel, ph, wqi, turbidity, tds);

        // 7. Update Session Analytics
        updateSessionStats();
    }

    // --- Sub-updater: Potability Badge ---
    function updatePotabilityBadge(potable, wqi, ph, turbidity) {
        elements.potabilityBadge.className = 'potability-badge';
        if (potable && wqi >= 70 && ph >= 6.5 && ph <= 8.5 && turbidity <= 5.0) {
            elements.potabilityBadge.classList.add('badge-safe');
            elements.potabilityBadge.textContent = 'SAFE DRINKING';
        } else if (wqi >= 50 && (turbidity <= 10.0 || (ph >= 6.0 && ph <= 9.0))) {
            elements.potabilityBadge.classList.add('badge-warning');
            elements.potabilityBadge.textContent = 'BOIL / FILTER FIRST';
        } else {
            elements.potabilityBadge.classList.add('badge-danger');
            elements.potabilityBadge.textContent = 'UNFIT FOR CONSUMPTION';
        }
    }

    // --- Sub-updater: pH Gauge & State Badge ---
    function updatePhGauge(ph) {
        // Clamped needle position (0 - 14 scale)
        const clampedPh = Math.max(0, Math.min(14, ph));
        const pct = (clampedPh / 14.0) * 100;
        elements.phNeedle.style.left = `${pct}%`;

        elements.phStateBadge.className = 'status-badge';
        if (ph < 6.5) {
            elements.phStateBadge.classList.add('badge-warning');
            elements.phStateBadge.textContent = ph < 5.0 ? 'STRONG ACID' : 'MILD ACIDIC';
        } else if (ph > 8.5) {
            elements.phStateBadge.classList.add('badge-warning');
            elements.phStateBadge.textContent = ph > 9.5 ? 'STRONG ALKALI' : 'MILD ALKALINE';
        } else {
            elements.phStateBadge.classList.add('badge-good');
            elements.phStateBadge.textContent = 'OPTIMAL NEUTRAL';
        }
    }

    // --- Sub-updater: WQI Rating & Badge Colors ---
    function evaluateWqiRating(wqi) {
        if (wqi >= 90) return 'Excellent';
        if (wqi >= 70) return 'Good';
        if (wqi >= 50) return 'Fair';
        if (wqi >= 25) return 'Poor';
        return 'Unfit';
    }

    function updateWqiBadgeClass(badgeElem, wqi) {
        badgeElem.className = 'status-badge';
        if (wqi >= 90) {
            badgeElem.classList.add('badge-excellent');
        } else if (wqi >= 70) {
            badgeElem.classList.add('badge-good');
        } else if (wqi >= 50) {
            badgeElem.classList.add('badge-neutral');
        } else if (wqi >= 25) {
            badgeElem.classList.add('badge-warning');
        } else {
            badgeElem.classList.add('badge-danger');
        }
    }

    // --- Sub-updater: Turbidity Indicators ---
    function updateTurbidityIndicators(turbidity) {
        elements.turbLevel1.className = 'level-box';
        elements.turbLevel2.className = 'level-box';
        elements.turbLevel3.className = 'level-box';

        elements.turbStateBadge.className = 'status-badge';

        if (turbidity < 1.0) {
            elements.turbLevel1.classList.add('active', 'level-safe');
            elements.turbStateBadge.classList.add('badge-good');
            elements.turbStateBadge.textContent = 'CRYSTAL CLEAR';
        } else if (turbidity <= 5.0) {
            elements.turbLevel2.classList.add('active', 'level-safe');
            elements.turbStateBadge.classList.add('badge-neutral');
            elements.turbStateBadge.textContent = 'ACCEPTABLE';
        } else {
            elements.turbLevel3.classList.add('active', 'level-danger');
            elements.turbStateBadge.classList.add('badge-danger');
            elements.turbStateBadge.textContent = 'HIGH TURBIDITY';
        }
    }

    // --- Sub-updater: TDS Indicators ---
    function updateTdsIndicators(tds) {
        elements.tdsLevel1.className = 'level-box';
        elements.tdsLevel2.className = 'level-box';
        elements.tdsLevel3.className = 'level-box';

        elements.tdsStateBadge.className = 'status-badge';

        if (tds <= 300) {
            elements.tdsLevel1.classList.add('active', 'level-safe');
            elements.tdsStateBadge.classList.add('badge-good');
            elements.tdsStateBadge.textContent = 'IDEAL MINERALS';
        } else if (tds <= 600) {
            elements.tdsLevel2.classList.add('active', 'level-safe');
            elements.tdsStateBadge.classList.add('badge-neutral');
            elements.tdsStateBadge.textContent = 'GOOD WATER';
        } else if (tds <= 1000) {
            elements.tdsLevel3.classList.add('active', 'level-warning');
            elements.tdsStateBadge.classList.add('badge-warning');
            elements.tdsStateBadge.textContent = 'FAIR / HARD';
        } else {
            elements.tdsLevel3.classList.add('active', 'level-danger');
            elements.tdsStateBadge.classList.add('badge-danger');
            elements.tdsStateBadge.textContent = 'UNACCEPTABLE';
        }
    }

    // --- Sub-updater: Session Statistics ---
    function updateSessionStats() {
        const count = telemetryHistory.length;
        if (count === 0) return;

        let minPh = 14, maxPh = 0, sumPh = 0, sumWqi = 0;
        telemetryHistory.forEach(rec => {
            if (rec.ph < minPh) minPh = rec.ph;
            if (rec.ph > maxPh) maxPh = rec.ph;
            sumPh += rec.ph;
            sumWqi += rec.wqi;
        });

        const avgPh = sumPh / count;
        const avgWqi = sumWqi / count;

        elements.statPhMinMax.textContent = `${minPh.toFixed(2)} / ${maxPh.toFixed(2)}`;
        elements.statPhAvg.textContent = avgPh.toFixed(2);
        elements.statWqiAvg.textContent = avgWqi.toFixed(0);
        elements.statSamples.textContent = count;
    }

    // ---------------- CHART.JS ENGINE & STREAMING ----------------
    // Custom Chart Plugin for Safe Band Annotation (pH 6.5 - 8.5)
    const safeZonePlugin = {
        id: 'safeZonePlugin',
        beforeDraw: (chart) => {
            if (currentChartTab !== 'ph') return;
            const { ctx, chartArea, scales } = chart;
            if (!scales.y || !chartArea) return;

            const yTop = scales.y.getPixelForValue(8.5);
            const yBottom = scales.y.getPixelForValue(6.5);

            ctx.save();
            ctx.fillStyle = 'rgba(0, 230, 118, 0.08)';
            ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBottom - yTop);

            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = 'rgba(0, 230, 118, 0.4)';

            // Top safe line (8.5)
            ctx.beginPath();
            ctx.moveTo(chartArea.left, yTop);
            ctx.lineTo(chartArea.right, yTop);
            ctx.stroke();

            // Bottom safe line (6.5)
            ctx.beginPath();
            ctx.moveTo(chartArea.left, yBottom);
            ctx.lineTo(chartArea.right, yBottom);
            ctx.stroke();

            ctx.restore();
        }
    };

    function initChart() {
        const ctx = elements.chartCanvas.getContext('2d');

        // Initial setup for pH Tab
        chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'pH Level',
                        data: [],
                        borderColor: '#00d2ff',
                        backgroundColor: 'rgba(0, 210, 255, 0.1)',
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#00d2ff'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 300,
                    easing: 'easeOutQuad'
                },
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(6, 12, 18, 0.95)',
                        titleColor: '#00d2ff',
                        bodyColor: '#f0f7ff',
                        borderColor: 'rgba(0, 210, 255, 0.3)',
                        borderWidth: 1,
                        padding: 10,
                        bodyFont: { family: "'JetBrains Mono', monospace" }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#8faac4',
                            font: { family: "'JetBrains Mono', monospace", size: 11 },
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 7
                        }
                    },
                    y: {
                        min: 4,
                        max: 10,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#8faac4',
                            font: { family: "'JetBrains Mono', monospace", size: 11 }
                        }
                    }
                }
            },
            plugins: [safeZonePlugin]
        });
    }

    function switchChartTab(tab) {
        if (currentChartTab === tab || !chartInstance) return;
        currentChartTab = tab;

        // Update button states
        elements.tabChartPh.classList.toggle('active', tab === 'ph');
        elements.tabChartWqi.classList.toggle('active', tab === 'wqi');
        elements.tabChartTurbTds.classList.toggle('active', tab === 'turbt_tds');

        // Extract last MAX_CHART_SAMPLES from history
        const slice = telemetryHistory.slice(-MAX_CHART_SAMPLES);
        const labels = slice.map(r => r.timeLabel);

        if (tab === 'ph') {
            chartInstance.data.labels = labels;
            chartInstance.data.datasets = [
                {
                    label: 'pH Level',
                    data: slice.map(r => r.ph),
                    borderColor: '#00d2ff',
                    backgroundColor: 'rgba(0, 210, 255, 0.1)',
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 3,
                    pointBackgroundColor: '#00d2ff',
                    yAxisID: 'y'
                }
            ];
            chartInstance.options.scales = {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#8faac4', font: { family: "'JetBrains Mono', monospace", size: 11 }, maxTicksLimit: 7 }
                },
                y: {
                    min: 4,
                    max: 10,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#8faac4', font: { family: "'JetBrains Mono', monospace", size: 11 } }
                }
            };
            elements.chartLegendRow.innerHTML = `
                <span class="legend-chip"><span class="legend-color-dot ph-dot"></span> pH Value</span>
                <span class="legend-chip"><span class="legend-color-band safe-band"></span> Safe Drinking Water Range (6.5 - 8.5)</span>
            `;

        } else if (tab === 'wqi') {
            chartInstance.data.labels = labels;
            chartInstance.data.datasets = [
                {
                    label: 'WQI Score',
                    data: slice.map(r => r.wqi),
                    borderColor: '#00e676',
                    backgroundColor: 'rgba(0, 230, 118, 0.1)',
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 3,
                    pointBackgroundColor: '#00e676',
                    yAxisID: 'y'
                }
            ];
            chartInstance.options.scales = {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#8faac4', font: { family: "'JetBrains Mono', monospace", size: 11 }, maxTicksLimit: 7 }
                },
                y: {
                    min: 0,
                    max: 100,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#8faac4', font: { family: "'JetBrains Mono', monospace", size: 11 } }
                }
            };
            elements.chartLegendRow.innerHTML = `
                <span class="legend-chip"><span class="legend-color-dot wqi-dot"></span> Overall Water Quality Index (0 - 100)</span>
            `;

        } else if (tab === 'turbt_tds') {
            chartInstance.data.labels = labels;
            chartInstance.data.datasets = [
                {
                    label: 'Turbidity (NTU)',
                    data: slice.map(r => r.turbidity),
                    borderColor: '#ffb300',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 3,
                    yAxisID: 'yTurb'
                },
                {
                    label: 'TDS (PPM)',
                    data: slice.map(r => r.tds),
                    borderColor: '#ab47bc',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 3,
                    yAxisID: 'yTds'
                }
            ];
            chartInstance.options.scales = {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#8faac4', font: { family: "'JetBrains Mono', monospace", size: 11 }, maxTicksLimit: 7 }
                },
                yTurb: {
                    type: 'linear',
                    position: 'left',
                    min: 0,
                    max: 15,
                    title: { display: true, text: 'Turbidity (NTU)', color: '#ffb300' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#ffb300' }
                },
                yTds: {
                    type: 'linear',
                    position: 'right',
                    min: 0,
                    max: 800,
                    title: { display: true, text: 'TDS (PPM)', color: '#ab47bc' },
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#ab47bc' }
                }
            };
            elements.chartLegendRow.innerHTML = `
                <span class="legend-chip"><span class="legend-color-dot turb-dot"></span> Turbidity (NTU, Left)</span>
                <span class="legend-chip"><span class="legend-color-dot tds-dot"></span> TDS (PPM, Right)</span>
            `;
        }

        chartInstance.update('none');
    }

    function appendChartData(timeLabel, ph, wqi, turbidity, tds) {
        if (!chartInstance) return;

        const labels = chartInstance.data.labels;
        labels.push(timeLabel);
        if (labels.length > MAX_CHART_SAMPLES) {
            labels.shift();
        }

        if (currentChartTab === 'ph') {
            const ds = chartInstance.data.datasets[0];
            ds.data.push(ph);
            if (ds.data.length > MAX_CHART_SAMPLES) ds.data.shift();
        } else if (currentChartTab === 'wqi') {
            const ds = chartInstance.data.datasets[0];
            ds.data.push(wqi);
            if (ds.data.length > MAX_CHART_SAMPLES) ds.data.shift();
        } else if (currentChartTab === 'turbt_tds') {
            const ds0 = chartInstance.data.datasets[0]; // Turbidity
            const ds1 = chartInstance.data.datasets[1]; // TDS
            ds0.data.push(turbidity);
            ds1.data.push(tds);
            if (ds0.data.length > MAX_CHART_SAMPLES) ds0.data.shift();
            if (ds1.data.length > MAX_CHART_SAMPLES) ds1.data.shift();
        }

        chartInstance.update('none');
    }

    // ---------------- CSV EXPORT ----------------
    function exportHistoryCsv() {
        if (telemetryHistory.length === 0) {
            alert('No telemetry data available yet to export.');
            return;
        }

        const headers = ['Timestamp', 'Time', 'pH', 'Voltage (V)', 'Turbidity (NTU)', 'TDS (PPM)', 'WQI', 'Rating', 'Potable', 'Diagnostic'];
        const rows = telemetryHistory.map(r => [
            `"${r.timestamp}"`,
            `"${r.timeLabel}"`,
            r.ph.toFixed(2),
            r.voltage.toFixed(3),
            r.turbidity.toFixed(2),
            r.tds.toFixed(1),
            r.wqi,
            `"${r.rating}"`,
            r.potable ? 'YES' : 'NO',
            `"${r.diagnostic.replace(/"/g, '""')}"`
        ]);

        const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `aquasense_telemetry_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // ---------------- SETTINGS MODAL ----------------
    function populateSettingsForm() {
        elements.cfgBrokerHost.value = config.brokerHost;
        elements.cfgBrokerPort.value = config.brokerPort;
        elements.cfgBrokerPath.value = config.brokerPath;
        elements.cfgStationId.value = config.stationId;
        elements.cfgTopicPrefix.value = config.topicPrefix;
    }

    function openSettings() {
        populateSettingsForm();
        elements.settingsModal.classList.add('active');
    }

    function closeSettings() {
        elements.settingsModal.classList.remove('active');
    }

    function saveAndReconnect() {
        const newHost = elements.cfgBrokerHost.value.trim() || defaultConfig.brokerHost;
        const newPort = parseInt(elements.cfgBrokerPort.value) || defaultConfig.brokerPort;
        const newPath = elements.cfgBrokerPath.value.trim() || defaultConfig.brokerPath;
        const newStation = elements.cfgStationId.value.trim() || defaultConfig.stationId;

        saveConfig({
            brokerHost: newHost,
            brokerPort: newPort,
            brokerPath: newPath,
            stationId: newStation
        });

        closeSettings();
        initMqtt();
    }

    // ---------------- TELEMETRY DEMO / MOCK GENERATOR ----------------
    // If testing without active ESP32 hardware, users can experience full UI functionality
    function startDemoSimulation() {
        if (simulationInterval) clearInterval(simulationInterval);
        console.log('[AquaSense] Starting built-in realistic mock telemetry feed (every 2s)...');

        let simPh = 7.15;
        let simTurb = 0.4;
        let simTds = 110.0;

        simulationInterval = setInterval(() => {
            // Realistic small random walk
            simPh += (Math.random() - 0.5) * 0.08;
            simPh = Math.max(6.2, Math.min(8.6, simPh));

            simTurb += (Math.random() - 0.5) * 0.15;
            simTurb = Math.max(0.1, Math.min(3.5, simTurb));

            simTds += (Math.random() - 0.5) * 3.0;
            simTds = Math.max(80.0, Math.min(220.0, simTds));

            // Calibration math to match firmware
            const vPh7 = 2.50;
            const slope = (2.50 - 1.95) / 3.0; // 0.1833 V/pH
            const voltage = vPh7 - ((7.0 - simPh) * slope);

            // Compute standard WQI
            let qPh = 100;
            if (simPh < 6.5) qPh = Math.max(0, 100 - (6.5 - simPh) * 35);
            else if (simPh > 8.5) qPh = Math.max(0, 100 - (simPh - 8.5) * 35);

            let qTurb = simTurb <= 1.0 ? 100 : (simTurb <= 5.0 ? 80 : 40);
            let qTds = simTds <= 300 ? 100 : (simTds <= 600 ? 80 : 50);

            const wqi = Math.round((qPh * 0.40) + (qTurb * 0.35) + (qTds * 0.25));
            const rating = evaluateWqiRating(wqi);
            const potable = wqi >= 70 && simPh >= 6.5 && simPh <= 8.5 && simTurb <= 5.0;

            const diagnostic = potable 
                ? "Water meets WHO & EPA potability parameters. pH and minerals ideal for consumption." 
                : "Water parameters slightly deviate from optimal baseline. Micro-filtration recommended.";

            processTelemetry({
                station: config.stationId,
                ph: parseFloat(simPh.toFixed(2)),
                voltage: parseFloat(voltage.toFixed(3)),
                turbidity_ntu: parseFloat(simTurb.toFixed(2)),
                tds_ppm: parseFloat(simTds.toFixed(1)),
                wqi: wqi,
                rating: rating,
                potable: potable,
                diagnostic: diagnostic,
                uptime_s: Math.floor(performance.now() / 1000)
            });
        }, 2000);
    }

    // ---------------- INITIALIZATION ----------------
    function init() {
        initChart();
        initMqtt();

        // Chart Tab Event Listeners
        elements.tabChartPh.addEventListener('click', () => switchChartTab('ph'));
        elements.tabChartWqi.addEventListener('click', () => switchChartTab('wqi'));
        elements.tabChartTurbTds.addEventListener('click', () => switchChartTab('turbt_tds'));

        // Settings Modal Event Listeners
        elements.openSettingsBtn.addEventListener('click', openSettings);
        elements.closeSettingsBtn.addEventListener('click', closeSettings);
        elements.cancelSettingsBtn.addEventListener('click', closeSettings);
        elements.saveSettingsBtn.addEventListener('click', saveAndReconnect);

        // Export CSV Listener
        elements.exportCsvBtn.addEventListener('click', exportHistoryCsv);

        // Close modal on click outside
        elements.settingsModal.addEventListener('click', (e) => {
            if (e.target === elements.settingsModal) closeSettings();
        });

        // Auto-start demonstration simulation if station is offline after 4s (allows immediate UI interactivity)
        setTimeout(() => {
            if (telemetryHistory.length === 0) {
                console.log('[AquaSense] No physical ESP32 broadcasting yet. Launching demo stream preview...');
                startDemoSimulation();
            }
        }, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
