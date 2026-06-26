const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Serve the PWA at / ────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'satellite-tracker.html'));
});

// ── Cache ──────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours — matches Celestrak update cycle

// Correct Celestrak GP element set URLs
// https://celestrak.org/NORAD/documentation/gp-data-formats.php
const CELESTRAK_GROUPS = {
  stations: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=TLE',
  visual:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=TLE',
  starlink: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=TLE',
  weather:  'https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=TLE',
  gps:      'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=TLE',
  oneweb:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=oneweb&FORMAT=TLE',
  iridium:  'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-NEXT&FORMAT=TLE',
};

const VALID_GROUPS = Object.keys(CELESTRAK_GROUPS);

// ── TLE fetcher ────────────────────────────────────────────
async function fetchTLEsFromCelestrak(group) {
  const url = CELESTRAK_GROUPS[group];
  console.log(`[${new Date().toISOString()}] Fetching ${group} from Celestrak...`);

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Orbital-Tracker/1.0 (github.com/wjheinle/Orbital; one request per 2hr cache)',
    },
    timeout: 20000,
  });

  if (resp.status === 403) {
    throw new Error(`Celestrak rate limited (403) for group "${group}" — retry after 2hr cache expires`);
  }
  if (!resp.ok) {
    throw new Error(`Celestrak returned HTTP ${resp.status} for group "${group}"`);
  }

  const text = await resp.text();
  if (!text || text.trim().length < 20) {
    throw new Error(`Empty or invalid response for group "${group}"`);
  }
  return text;
}

function parseTLEText(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const tles = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    tles.push({
      name: name.replace(/^0 /, '').trim(),
      line1: l1.trim(),
      line2: l2.trim(),
    });
  }
  return tles;
}

async function getCached(group) {
  const now = Date.now();
  if (cache[group] && (now - cache[group].ts) < CACHE_TTL) {
    console.log(`[${new Date().toISOString()}] Cache hit for "${group}" (${cache[group].data.length} TLEs, age ${Math.round((now - cache[group].ts)/60000)}min)`);
    return cache[group].data;
  }
  const text = await fetchTLEsFromCelestrak(group);
  const tles = parseTLEText(text);
  cache[group] = { ts: now, data: tles };
  console.log(`[${new Date().toISOString()}] Cached "${group}": ${tles.length} TLEs`);
  return tles;
}

// ── ISS live position ──────────────────────────────────────
async function fetchISSPosition() {
  const resp = await fetch('https://api.wheretheiss.at/v1/satellites/25544', { timeout: 6000 });
  if (!resp.ok) throw new Error(`wheretheiss.at returned HTTP ${resp.status}`);
  return await resp.json();
}

// ── Routes ─────────────────────────────────────────────────

// GET /tle/:group
app.get('/tle/:group', async (req, res) => {
  const { group } = req.params;
  if (!VALID_GROUPS.includes(group)) {
    return res.status(400).json({ error: `Unknown group "${group}"`, valid: VALID_GROUPS });
  }
  try {
    const tles = await getCached(group);
    const age = cache[group] ? Math.round((Date.now() - cache[group].ts) / 60000) : 0;
    res.json({ group, count: tles.length, age_minutes: age, tles });
  } catch (e) {
    console.error(`[ERROR] /tle/${group}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /tle/multi?groups=starlink,stations,visual
app.get('/tle/multi', async (req, res) => {
  const requested = (req.query.groups || 'stations,visual')
    .split(',')
    .map(g => g.trim())
    .filter(g => VALID_GROUPS.includes(g))
    .slice(0, 6);

  if (requested.length === 0) {
    return res.status(400).json({ error: 'No valid groups requested', valid: VALID_GROUPS });
  }
  try {
    const results = {};
    await Promise.all(requested.map(async g => {
      try { results[g] = await getCached(g); }
      catch (e) { console.warn(`[WARN] "${g}":`, e.message); results[g] = []; }
    }));
    const total = Object.values(results).reduce((s, a) => s + a.length, 0);
    res.json({ total, groups: requested, results });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /iss
app.get('/iss', async (req, res) => {
  try {
    const data = await fetchISSPosition();
    res.json(data);
  } catch (e) {
    console.error('[ERROR] /iss:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /health
app.get('/health', (req, res) => {
  const cacheStatus = {};
  for (const [k, v] of Object.entries(cache)) {
    cacheStatus[k] = {
      count: v.data.length,
      age_min: Math.round((Date.now() - v.ts) / 60000),
      expires_min: Math.round((CACHE_TTL - (Date.now() - v.ts)) / 60000),
    };
  }
  res.json({ status: 'ok', uptime_s: Math.round(process.uptime()), cache: cacheStatus, groups: VALID_GROUPS });
});

// GET /api — info
app.get('/api', (req, res) => {
  res.json({
    name: 'Orbital TLE Proxy',
    repo: 'github.com/wjheinle/Orbital',
    source: 'celestrak.org/NORAD/elements/gp.php',
    endpoints: {
      'GET /':                  'Orbital PWA',
      'GET /tle/:group':        `Groups: ${VALID_GROUPS.join(' | ')}`,
      'GET /tle/multi?groups=': 'Comma-separated groups (max 6)',
      'GET /iss':               'Live ISS position',
      'GET /health':            'Cache status',
    },
    cache_ttl: '2 hours',
  });
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Orbital proxy listening on port ${PORT}`);
  // Pre-warm stations + visual on boot
  ['stations', 'visual'].forEach(g => {
    getCached(g).catch(e => console.warn(`Pre-warm "${g}" failed:`, e.message));
  });
});
