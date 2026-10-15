/* ═══════════════════════════════════════════════════════════════════════════
   Urban Air Quality Monitor — app.js
   Connects to the Express/MongoDB backend and drives the entire dashboard.
   No hardcoded sensor values – all readings come from the API.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Backend URL ──────────────────────────────────────────────────────────────
// Change this to your deployed backend URL in production.
const API_BASE = 'http://localhost:3000';

// ── Refresh interval ─────────────────────────────────────────────────────────
const REFRESH_MS = 5000;

// ── AQI colour map (US EPA) ──────────────────────────────────────────────────
const AQI_LEVELS = [
  { max: 50,  label: 'Good',                          color: '#3fb950' },
  { max: 100, label: 'Moderate',                      color: '#d29922' },
  { max: 150, label: 'Unhealthy for Sensitive Groups', color: '#e3702c' },
  { max: 200, label: 'Unhealthy',                     color: '#da3633' },
  { max: 300, label: 'Very Unhealthy',                color: '#9a49d7' },
  { max: 500, label: 'Hazardous',                     color: '#8b0000' },
];

function aqiColor(aqi) {
  if (aqi == null) return '#8b949e';
  const l = AQI_LEVELS.find((x) => aqi <= x.max);
  return l ? l.color : '#8b0000';
}

function aqiLabel(aqi) {
  if (aqi == null) return '—';
  const l = AQI_LEVELS.find((x) => aqi <= x.max);
  return l ? l.label : 'Hazardous';
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const fmt = (v, dp = 1) => (v == null ? '—' : Number(v).toFixed(dp));
const $ = (id) => document.getElementById(id);

function showToast(msg, duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
async function fetchJSON(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const json = await res.json();
    return { ok: res.ok, status: res.status, data: json };
  } finally {
    clearTimeout(id);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let latestReading = null;
let prevReading   = null;
let historyData   = [];
let currentRange  = '1h';
let tableRange    = '1h';
let tablePage     = 1;
let tableTotalPages = 1;
let connectionLost = false;
let pmChart  = null;
let envChart = null;
let leafletMap = null;
let leafletMarker = null;
let alerts = {};

// ── Alert thresholds ──────────────────────────────────────────────────────────
function loadAlerts() {
  try {
    const saved = localStorage.getItem('aqm_alerts');
    alerts = saved ? JSON.parse(saved) : {};
  } catch { alerts = {}; }
}

function saveAlerts() {
  localStorage.setItem('aqm_alerts', JSON.stringify(alerts));
}

function checkAlerts(reading) {
  const issues = [];
  if (alerts.pm25 && reading.pm25 != null && reading.pm25 > alerts.pm25)
    issues.push({ field: 'PM2.5', value: reading.pm25.toFixed(1), threshold: alerts.pm25, unit: 'µg/m³', cardId: 'card-pm25' });
  if (alerts.pm10 && reading.pm10 != null && reading.pm10 > alerts.pm10)
    issues.push({ field: 'PM10', value: reading.pm10.toFixed(1), threshold: alerts.pm10, unit: 'µg/m³', cardId: 'card-pm10' });
  if (alerts.temp && reading.temperature != null && reading.temperature > alerts.temp)
    issues.push({ field: 'Temperature', value: reading.temperature.toFixed(1), threshold: alerts.temp, unit: '°C', cardId: 'card-temp' });
  if (alerts.rh && reading.humidity != null && reading.humidity > alerts.rh)
    issues.push({ field: 'Humidity', value: reading.humidity.toFixed(1), threshold: alerts.rh, unit: '%', cardId: 'card-rh' });

  // Clear old alert glow
  document.querySelectorAll('.card--alert').forEach((el) => el.classList.remove('card--alert'));

  const container = $('activeAlerts');
  container.innerHTML = '';

  issues.forEach((issue) => {
    document.getElementById(issue.cardId)?.classList.add('card--alert');
    const div = document.createElement('div');
    div.className = 'alert-item';
    div.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>${issue.field} is ${issue.value} ${issue.unit} — exceeds threshold of ${issue.threshold} ${issue.unit}</span>
    `;
    container.appendChild(div);
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  $(`section-${name}`)?.classList.add('active');
  $(`nav-${name}`)?.classList.add('active');

  if (name === 'map') initMap();
}

// ── Device status ─────────────────────────────────────────────────────────────
async function refreshDeviceStatus() {
  try {
    const { ok, data } = await fetchJSON(`${API_BASE}/api/device/status`);
    if (!ok || !data.success) return;
    const { online, lastSeen } = data.data;
    const dot   = $('statusDot');
    const label = $('statusLabel');
    dot.className   = 'status-dot ' + (online ? 'online' : 'offline');
    label.textContent = online ? 'Device Online' : 'Device Offline';
    $('lastUpdated').textContent = lastSeen ? formatTimestamp(lastSeen) : '—';
  } catch { /* silently ignore */ }
}

// ── AQI gauge (canvas arc) ────────────────────────────────────────────────────
function drawAQIGauge(aqi) {
  const canvas = $('aqiGauge');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2 + 10;
  const r  = 65;

  ctx.clearRect(0, 0, w, h);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();

  if (aqi != null) {
    const clampedAqi = Math.min(aqi, 500);
    const angle = (clampedAqi / 500) * Math.PI;
    const color = aqiColor(aqi);

    // Gradient arc
    const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
    grad.addColorStop(0,   '#3fb950');
    grad.addColorStop(0.5, '#d29922');
    grad.addColorStop(1,   '#da3633');

    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, Math.PI + angle);
    ctx.lineWidth  = 14;
    ctx.strokeStyle = grad;
    ctx.lineCap    = 'round';
    ctx.stroke();

    // AQI text inside
    ctx.fillStyle  = color;
    ctx.font       = 'bold 28px Inter';
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(aqi, cx, cy - 10);

    ctx.fillStyle  = '#8b949e';
    ctx.font       = '11px Inter';
    ctx.fillText('AQI', cx, cy + 14);
  }
}

// ── Update sensor cards ───────────────────────────────────────────────────────
function trend(curr, prev) {
  if (curr == null || prev == null) return '';
  const diff = curr - prev;
  if (Math.abs(diff) < 0.1) return '';
  return diff > 0 ? `↑ +${diff.toFixed(1)}` : `↓ ${diff.toFixed(1)}`;
}

function updateCards(r) {
  // PM
  $('pm1Value').textContent  = fmt(r.pm1);
  $('pm25Value').textContent = fmt(r.pm25);
  $('pm10Value').textContent = fmt(r.pm10);

  if (prevReading) {
    $('pm1Trend').textContent  = trend(r.pm1,  prevReading.pm1);
    $('pm25Trend').textContent = trend(r.pm25, prevReading.pm25);
    $('pm10Trend').textContent = trend(r.pm10, prevReading.pm10);
  }

  // Temp/Humidity
  $('tempValue').textContent = fmt(r.temperature, 1);
  $('rhValue').textContent   = fmt(r.humidity,    1);

  // GPS
  const hasFix = r.gpsFix && r.latitude != null && r.longitude != null;
  $('gpsValue').textContent = hasFix
    ? `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}`
    : 'No GPS fix';
  $('satCount').textContent  = r.satellites ?? 0;
  const fixBadge = $('gpsFix');
  fixBadge.textContent = hasFix ? 'FIX OK' : 'NO FIX';
  fixBadge.className   = 'gps-fix-badge' + (hasFix ? ' fixed' : '');

  // AQI
  const aqi = r.aqi ?? null;
  $('aqiValue').textContent    = aqi != null ? aqi : '—';
  $('aqiCategory').textContent = aqi != null ? aqiLabel(aqi) : 'Insufficient data';
  $('aqiValue').style.color    = aqiColor(aqi);
  $('aqiCategory').style.color = aqiColor(aqi);
  drawAQIGauge(aqi);

  // Alerts
  checkAlerts(r);
}

// ── Charts ────────────────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 400 },
  plugins: {
    legend: {
      labels: { color: '#8b949e', font: { family: 'Inter', size: 11 }, boxWidth: 10, padding: 16 },
    },
    tooltip: {
      backgroundColor: '#1c2128',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      titleColor: '#e6edf3',
      bodyColor:  '#8b949e',
      padding: 10,
    },
  },
  scales: {
    x: {
      ticks: { color: '#484f58', font: { size: 10 }, maxTicksLimit: 10 },
      grid:  { color: 'rgba(255,255,255,0.04)' },
    },
    y: {
      ticks: { color: '#484f58', font: { size: 10 } },
      grid:  { color: 'rgba(255,255,255,0.04)' },
      beginAtZero: true,
    },
  },
};

function buildCharts() {
  // PM chart
  pmChart = new Chart($('pmChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'PM1.0',  data: [], borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2 },
        { label: 'PM2.5',  data: [], borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,0.10)',  tension: 0.4, pointRadius: 2, borderWidth: 2 },
        { label: 'PM10',   data: [], borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2 },
      ],
    },
    options: { ...CHART_DEFAULTS },
  });

  // Env chart
  envChart = new Chart($('envChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Temp (°C)', data: [], borderColor: '#e3702c', backgroundColor: 'rgba(227,112,44,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2, yAxisID: 'yTemp' },
        { label: 'Humidity (%)', data: [], borderColor: '#388bfd', backgroundColor: 'rgba(56,139,253,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2, yAxisID: 'yRh' },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        ...CHART_DEFAULTS.scales,
        yTemp: { type: 'linear', position: 'left',  ticks: { color: '#e3702c', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        yRh:   { type: 'linear', position: 'right', ticks: { color: '#388bfd', font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function updateCharts(data) {
  const sorted = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const labels = sorted.map((r) => {
    const d = new Date(r.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  pmChart.data.labels            = labels;
  pmChart.data.datasets[0].data  = sorted.map((r) => r.pm1);
  pmChart.data.datasets[1].data  = sorted.map((r) => r.pm25);
  pmChart.data.datasets[2].data  = sorted.map((r) => r.pm10);
  pmChart.update('none');

  envChart.data.labels            = labels;
  envChart.data.datasets[0].data  = sorted.map((r) => r.temperature);
  envChart.data.datasets[1].data  = sorted.map((r) => r.humidity);
  envChart.update('none');
}

// ── History table ─────────────────────────────────────────────────────────────
function renderTable(data, pagination) {
  const tbody = $('readingsBody');
  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr class="table-empty"><td colspan="10">No readings in this time range.</td></tr>';
    $('tableCount').textContent = '0 readings';
    return;
  }

  $('tableCount').textContent = `${pagination?.total ?? data.length} readings`;

  data.forEach((r) => {
    const aqi = r.aqi ?? null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatTimestamp(r.timestamp)}</td>
      <td>${fmt(r.pm1)}</td>
      <td>${fmt(r.pm25)}</td>
      <td>${fmt(r.pm10)}</td>
      <td style="color:${aqiColor(aqi)}">${aqi ?? '—'}</td>
      <td>${fmt(r.temperature)}</td>
      <td>${fmt(r.humidity)}</td>
      <td>${r.latitude  != null ? r.latitude.toFixed(5)  : '—'}</td>
      <td>${r.longitude != null ? r.longitude.toFixed(5) : '—'}</td>
      <td>${r.satellites ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  // Pagination buttons
  if (pagination) {
    tableTotalPages = pagination.pages;
    $('pageInfo').textContent = `Page ${pagination.page} of ${pagination.pages}`;
    $('prevPage').disabled = pagination.page <= 1;
    $('nextPage').disabled = pagination.page >= pagination.pages;
  }
}

// ── Leaflet map ───────────────────────────────────────────────────────────────
function initMap() {
  if (leafletMap) return;

  leafletMap = L.map('leafletMap').setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(leafletMap);

  // Try to place marker from latest reading
  if (latestReading?.latitude != null && latestReading?.longitude != null) {
    placeMapMarker(latestReading);
  }
}

function placeMapMarker(r) {
  if (!leafletMap || r.latitude == null || r.longitude == null) return;

  const pm25 = r.pm25 ?? null;
  const aqi  = r.aqi  ?? null;
  const popupHtml = `
    <div style="font-family:Inter,sans-serif;font-size:13px;line-height:1.6">
      <strong>AQI: ${aqi ?? '—'}</strong> — ${aqiLabel(aqi)}<br/>
      PM2.5: ${fmt(pm25)} µg/m³<br/>
      PM10:  ${fmt(r.pm10)} µg/m³<br/>
      Temp:  ${fmt(r.temperature)}°C | RH: ${fmt(r.humidity)}%<br/>
      Sats:  ${r.satellites ?? 0}<br/>
      <small>${formatTimestamp(r.timestamp)}</small>
    </div>`;

  if (leafletMarker) {
    leafletMarker.setLatLng([r.latitude, r.longitude])
                 .setPopupContent(popupHtml);
  } else {
    leafletMarker = L.marker([r.latitude, r.longitude])
      .addTo(leafletMap)
      .bindPopup(popupHtml);
  }

  leafletMap.setView([r.latitude, r.longitude], 15);
  $('mapInfo').innerHTML =
    `📍 ${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)} &nbsp;|&nbsp; ${r.satellites ?? 0} sats`;
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function fetchLatest() {
  const { ok, data } = await fetchJSON(`${API_BASE}/api/readings/latest`);
  if (!ok || !data.success) return null;
  return data.data;
}

async function fetchHistory(range = '24h', page = 1, limit = 100) {
  const url = `${API_BASE}/api/readings/history?range=${range}&page=${page}&limit=${limit}`;
  const { ok, data } = await fetchJSON(url);
  if (!ok || !data.success) return { data: [], pagination: null };
  return data;
}

// ── Main refresh cycle ────────────────────────────────────────────────────────
async function refresh() {
  const btn = $('refreshBtn');
  btn.classList.add('spinning');

  try {
    // Latest reading
    const reading = await fetchLatest();
    if (reading) {
      if (connectionLost) {
        connectionLost = false;
        $('connectionBanner').style.display = 'none';
        showToast('✅ Backend reconnected');
      }
      prevReading   = latestReading;
      latestReading = reading;
      updateCards(reading);
      if (reading.latitude != null) placeMapMarker(reading);
    } else if (!connectionLost) {
      // No reading yet – device may have never sent data
    }

    // History for charts
    const histRes = await fetchHistory(currentRange, 1, 200);
    historyData = histRes.data;
    if (historyData.length) updateCharts(historyData);

    // Table (separate range)
    const tableRes = await fetchHistory(tableRange, tablePage, 50);
    renderTable(tableRes.data, tableRes.pagination);

    // Device status
    await refreshDeviceStatus();

  } catch (err) {
    console.error('[Refresh]', err);
    if (!connectionLost) {
      connectionLost = true;
      $('connectionBanner').style.display = 'flex';
      showToast('⚠️ Cannot reach backend');
    }
  } finally {
    btn.classList.remove('spinning');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  loadAlerts();

  // Populate alert inputs from storage
  if (alerts.pm25) $('alertPm25').value = alerts.pm25;
  if (alerts.pm10) $('alertPm10').value = alerts.pm10;
  if (alerts.temp) $('alertTemp').value = alerts.temp;
  if (alerts.rh)   $('alertRh').value   = alerts.rh;

  // Build charts
  buildCharts();

  // ── Navigation listeners ──
  ['overview', 'history', 'map', 'alerts'].forEach((name) => {
    $(`nav-${name}`)?.addEventListener('click', (e) => {
      e.preventDefault();
      showSection(name);
      // Close sidebar on mobile
      document.querySelector('.sidebar')?.classList.remove('open');
      document.querySelector('.sidebar-backdrop')?.classList.remove('show');
    });
  });

  // ── Hamburger / sidebar ──
  const sidebar  = document.querySelector('.sidebar');
  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  document.body.appendChild(backdrop);

  $('hamburger').addEventListener('click', () => {
    sidebar.classList.add('open');
    backdrop.classList.add('show');
  });

  $('sidebarClose').addEventListener('click', () => {
    sidebar.classList.remove('open');
    backdrop.classList.remove('show');
  });

  backdrop.addEventListener('click', () => {
    sidebar.classList.remove('open');
    backdrop.classList.remove('show');
  });

  // ── Chart range filters ──
  document.querySelectorAll('.btn-filter:not([data-table])').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter:not([data-table])').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      refresh();
    });
  });

  // ── Table range filters ──
  document.querySelectorAll('.btn-filter[data-table]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter[data-table]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      tableRange = btn.dataset.range;
      tablePage  = 1;
      refresh();
    });
  });

  // ── Pagination ──
  $('prevPage').addEventListener('click', () => { if (tablePage > 1) { tablePage--; refresh(); } });
  $('nextPage').addEventListener('click', () => { if (tablePage < tableTotalPages) { tablePage++; refresh(); } });

  // ── Manual refresh ──
  $('refreshBtn').addEventListener('click', refresh);

  // ── Alerts form ──
  $('saveAlerts').addEventListener('click', () => {
    alerts.pm25 = parseFloat($('alertPm25').value) || null;
    alerts.pm10 = parseFloat($('alertPm10').value) || null;
    alerts.temp = parseFloat($('alertTemp').value) || null;
    alerts.rh   = parseFloat($('alertRh').value)   || null;
    // Remove null keys
    Object.keys(alerts).forEach((k) => { if (!alerts[k]) delete alerts[k]; });
    saveAlerts();
    showToast('✅ Alert thresholds saved');
    if (latestReading) checkAlerts(latestReading);
  });

  // ── First load ──
  try {
    await refresh();
  } catch (e) {
    console.error('Init refresh failed', e);
  } finally {
    $('loadingOverlay').classList.add('hidden');
    setTimeout(() => { $('loadingOverlay').style.display = 'none'; }, 400);
  }

  // ── Auto-refresh ──
  setInterval(refresh, REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);
