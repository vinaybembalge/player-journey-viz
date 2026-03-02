const MINIMAP_SIZE = 1024;
const EVENT_STYLES = {
  Kill: { color: '#FF1744', marker: 'o', size: 60, edgeColor: 'black' },
  Killed: { color: '#000000', marker: 'o', size: 60, edgeColor: 'white' },
  BotKill: { color: '#FF6F00', marker: 'o', size: 50 },
  BotKilled: { color: '#8E24AA', marker: 'o', size: 50 },
  Loot: { color: '#FFD600', marker: 'x', size: 30 },
  KilledByStorm: { color: '#2979FF', marker: '*', size: 80 },
};
const HUMAN_PATH_STYLE = { color: 'rgba(0, 229, 255, 0.8)', lineWidth: 2.5 };
const BOT_PATH_STYLE = { color: 'rgba(255, 183, 77, 0.6)', lineWidth: 1.2 };
const HEATMAP_STYLES = {
  kills: { colormap: 'Reds', alpha: 0.82, minAlpha: 0.22 },
  deaths: { colormap: 'Purples', alpha: 0.82, minAlpha: 0.22 },
  traffic: { colormap: 'YlOrBr', alpha: 0.76, minAlpha: 0.18 },
};

function isHumanUserId(userId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(userId));
}

function getMarkerRadius(size) {
  return Math.max(2.5, Math.sqrt(size / Math.PI));
}

function drawEventMarker(ctx2d, event) {
  const style = EVENT_STYLES[event.event] || { color: '#aaaaaa', marker: 'o', size: 40 };
  const x = event.px;
  const y = event.py;
  const radius = getMarkerRadius(style.size);

  ctx2d.save();
  ctx2d.fillStyle = style.color;
  ctx2d.strokeStyle = style.edgeColor || style.color;
  ctx2d.lineWidth = 1.2;

  if (style.marker === 'x') {
    ctx2d.beginPath();
    ctx2d.moveTo(x - radius, y - radius);
    ctx2d.lineTo(x + radius, y + radius);
    ctx2d.moveTo(x + radius, y - radius);
    ctx2d.lineTo(x - radius, y + radius);
    ctx2d.stroke();
  } else if (style.marker === '*') {
    const inner = radius * 0.45;
    ctx2d.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? radius : inner;
      const a = (-Math.PI / 2) + (i * Math.PI / 5);
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx2d.moveTo(px, py);
      else ctx2d.lineTo(px, py);
    }
    ctx2d.closePath();
    ctx2d.fill();
  } else {
    ctx2d.beginPath();
    ctx2d.arc(x, y, radius, 0, Math.PI * 2);
    ctx2d.fill();
    if (style.edgeColor) {
      ctx2d.strokeStyle = style.edgeColor;
      ctx2d.stroke();
    }
  }

  ctx2d.restore();
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function sampleColormap(colormap, t) {
  const clamped = Math.max(0, Math.min(1, t));
  const maps = {
    Reds: [[35, 0, 0], [110, 0, 0], [200, 15, 20]],
    Purples: [[20, 8, 32], [60, 18, 95], [125, 45, 175]],
    YlOrBr: [[35, 20, 0], [95, 52, 0], [180, 95, 10]],
  };
  const colors = maps[colormap] || maps.Reds;
  if (clamped <= 0.5) return lerpColor(colors[0], colors[1], clamped * 2);
  return lerpColor(colors[1], colors[2], (clamped - 0.5) * 2);
}

let meta = null;
let matchData = null;
let currentTime = 0;
let timeMax = 0;
let playInterval = null;
let heatmapCache = {};

const canvas = document.getElementById('canvas');
const heatmapLayer = document.getElementById('heatmap-layer');
const ctx = canvas.getContext('2d');
const hmCtx = heatmapLayer.getContext('2d');

const filterMap = document.getElementById('filter-map');
const filterDate = document.getElementById('filter-date');
const filterMatch = document.getElementById('filter-match');
const timelineSlider = document.getElementById('timeline-slider');
const timeLabel = document.getElementById('time-label');
const btnPlay = document.getElementById('btn-play');
const heatKills = document.getElementById('heat-kills');
const heatDeaths = document.getElementById('heat-deaths');
const heatTraffic = document.getElementById('heat-traffic');

function getMinimapUrl(mapId) {
  const ext = mapId === 'Lockdown' ? 'jpg' : 'png';
  return `minimaps/${mapId}_Minimap.${ext}`;
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

async function loadMeta() {
  meta = await fetchJson('meta.json');
  const mapSelect = filterMap;
  meta.maps.forEach((id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id.replace(/([A-Z])/g, ' $1').trim();
    mapSelect.appendChild(opt);
  });
  const dateSelect = filterDate;
  meta.dates.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d.replace('_', ' ');
    dateSelect.appendChild(opt);
  });
}

function getFilteredMatches() {
  const mapId = filterMap.value;
  const date = filterDate.value;
  if (!mapId || !date) return [];
  return meta.matches.filter((m) => m.mapId === mapId && m.date === date);
}

function fillMatchSelect() {
  const matches = getFilteredMatches();
  filterMatch.innerHTML = '<option value="">— Select match —</option>';
  matches.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.matchId;
    opt.textContent = `${m.matchId.slice(0, 8)}… (${m.numPlayers} players)`;
    filterMatch.appendChild(opt);
  });
}

filterMap.addEventListener('change', () => {
  fillMatchSelect();
  matchData = null;
  draw();
});
filterDate.addEventListener('change', () => {
  fillMatchSelect();
  matchData = null;
  draw();
});

filterMatch.addEventListener('change', async () => {
  const matchId = filterMatch.value;
  if (!matchId) {
    matchData = null;
    draw();
    return;
  }
  try {
    matchData = await fetchJson(`matches/${matchId}.json`);
    const allTs = [];
    if (matchData.events) matchData.events.forEach((e) => allTs.push(e.ts));
    Object.values(matchData.paths || {}).forEach((points) => {
      points.forEach((p) => allTs.push(p.ts));
    });
    currentTime = allTs.length ? Math.min(...allTs) : 0;
    timeMax = allTs.length ? Math.max(...allTs) : 0;
    timelineSlider.min = 0;
    timelineSlider.max = timeMax - currentTime || 1;
    timelineSlider.value = timelineSlider.max;
    currentTime = timeMax;
    updateTimeLabel();
    draw();
    drawHeatmap();
  } catch (e) {
    console.error(e);
    matchData = null;
    draw();
  }
});

function updateTimeLabel() {
  const s = ((currentTime - (matchData ? getMatchMinTs() : 0)) / 1000).toFixed(1);
  const total = timeMax && matchData ? ((timeMax - getMatchMinTs()) / 1000).toFixed(1) : '0';
  timeLabel.textContent = `${s}s / ${total}s`;
}

function getMatchMinTs() {
  if (!matchData) return 0;
  let min = Infinity;
  if (matchData.events) matchData.events.forEach((e) => { if (e.ts < min) min = e.ts; });
  Object.values(matchData.paths || {}).forEach((points) => {
    points.forEach((p) => { if (p.ts < min) min = p.ts; });
  });
  return min === Infinity ? 0 : min;
}

timelineSlider.addEventListener('input', () => {
  if (!matchData) return;
  const minTs = getMatchMinTs();
  const range = timeMax - minTs || 1;
  currentTime = minTs + (range * timelineSlider.value / Number(timelineSlider.max));
  updateTimeLabel();
  draw();
});

btnPlay.addEventListener('click', () => {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
    btnPlay.textContent = 'Play';
    return;
  }
  if (!matchData) return;
  const minTs = getMatchMinTs();
  const step = 200;
  playInterval = setInterval(() => {
    currentTime += step;
    if (currentTime >= timeMax) {
      currentTime = timeMax;
      clearInterval(playInterval);
      playInterval = null;
      btnPlay.textContent = 'Play';
    }
    const range = timeMax - minTs || 1;
    timelineSlider.value = (currentTime - minTs) / range * Number(timelineSlider.max);
    updateTimeLabel();
    draw();
  }, 150);
  btnPlay.textContent = 'Pause';
});

function draw() {
  const w = MINIMAP_SIZE;
  const h = MINIMAP_SIZE;
  ctx.clearRect(0, 0, w, h);

  const mapId = matchData ? matchData.mapId : filterMap.value || meta?.maps?.[0];
  if (!mapId) return;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    ctx.drawImage(img, 0, 0, w, h);
    if (!matchData) return;
    const paths = matchData.paths || {};
    Object.entries(paths).forEach(([userId, points]) => {
      const visible = points.filter((p) => p.ts <= currentTime);
      if (visible.length < 2) return;
      const human = isHumanUserId(userId);
      const pathStyle = human ? HUMAN_PATH_STYLE : BOT_PATH_STYLE;
      ctx.strokeStyle = pathStyle.color;
      ctx.lineWidth = pathStyle.lineWidth;
      ctx.setLineDash(human ? [] : [4, 4]);
      ctx.beginPath();
      ctx.moveTo(visible[0].px, visible[0].py);
      for (let i = 1; i < visible.length; i++) {
        ctx.lineTo(visible[i].px, visible[i].py);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
    const events = (matchData.events || []).filter((e) => e.ts <= currentTime);
    events.forEach((e) => {
      drawEventMarker(ctx, e);
    });
  };
  img.onerror = () => {};
  img.src = getMinimapUrl(mapId);
}

function drawPathsAndEvents() {
  draw();
}

async function loadHeatmap(mapId, type) {
  const key = `${mapId}_${type}`;
  if (heatmapCache[key]) return heatmapCache[key];
  const grid = await fetchJson(`heatmaps/${mapId}_${type}.json`);
  heatmapCache[key] = grid;
  return grid;
}

function drawHeatmap() {
  const mapId = matchData ? matchData.mapId : filterMap.value;
  if (!mapId) {
    hmCtx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    return;
  }
  hmCtx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  const cell = MINIMAP_SIZE / 64;
  const types = [];
  if (heatKills.checked) types.push({ type: 'kills', ...HEATMAP_STYLES.kills });
  if (heatDeaths.checked) types.push({ type: 'deaths', ...HEATMAP_STYLES.deaths });
  if (heatTraffic.checked) types.push({ type: 'traffic', ...HEATMAP_STYLES.traffic });

  (async () => {
    for (const { type, colormap, alpha: maxAlpha, minAlpha = 0 } of types) {
      try {
        const grid = await loadHeatmap(mapId, type);
        let max = 0;
        for (let j = 0; j < 64; j++) {
          for (let i = 0; i < 64; i++) {
            const v = grid[j][i];
            if (v > max) max = v;
          }
        }
        if (max === 0) continue;
        for (let j = 0; j < 64; j++) {
          for (let i = 0; i < 64; i++) {
            const v = grid[j][i];
            if (v <= 0) continue;
            const intensity = v / max;
            const [r, g, b] = sampleColormap(colormap, intensity);
            const adjustedIntensity = Math.pow(intensity, 0.65);
            const alpha = minAlpha + adjustedIntensity * (maxAlpha - minAlpha);
            hmCtx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
            hmCtx.fillRect(i * cell, j * cell, cell + 1, cell + 1);
          }
        }
      } catch (_) {}
    }
  })();
}

heatKills.addEventListener('change', drawHeatmap);
heatDeaths.addEventListener('change', drawHeatmap);
heatTraffic.addEventListener('change', drawHeatmap);

async function init() {
  await loadMeta();
  fillMatchSelect();
  draw();
}

init();
