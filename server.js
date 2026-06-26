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
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

const VALID_GROUPS = ['stations', 'visual', 'starlink', 'weather', 'gps', 'oneweb', 'iridium'];

// ── Multi-source TLE fetcher ───────────────────────────────
// Each group has multiple sources tried in order until one succeeds.
// Sources chosen for reliability from cloud/VPS IPs.

function getSources(group) {
  // Celestrak uses different group name for gps
  const celestrakGroup = group === 'gps' ? 'gps-ops' : group === 'iridium' ? 'iridium-NEXT' : group;

  return [
    // Source 1: Celestrak .org GP endpoint
    {
      name: 'celestrak.org',
      url: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${celestrakGroup}&FORMAT=TLE`,
      timeout: 15000,
    },
    // Source 2: Celestrak .com (different server)
    {
      name: 'celestrak.com',
      url: `https://celestrak.com/NORAD/elements/gp.php?GROUP=${celestrakGroup}&FORMAT=TLE`,
      timeout: 15000,
    },
    // Source 3: lulu.ac.nz public TLE mirror
    {
      name: 'tle.lulu.ac.nz',
      url: `https://tle.lulu.ac.nz/?c=${celestrakGroup}&f=tle`,
      timeout: 10000,
    },
  ];
}

async function fetchWithTimeout(url, options = {}) {
  const { timeout = 10000, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...rest, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTLEs(group) {
  const sources = getSources(group);
  const errors = [];

  for (const src of sources) {
    try {
      console.log(`[${new Date().toISOString()}] [${group}] Trying ${src.name}...`);
      const resp = await fetchWithTimeout(src.url, {
        timeout: src.timeout,
        headers: {
          'User-Agent': 'OrbitalTracker/1.0 (github.com/wjheinle/Orbital)',
          'Accept': 'text/plain',
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (!text || text.trim().length < 50) throw new Error('Response too short');
      if (!text.includes('1 ') && !text.includes('2 ')) throw new Error('Not valid TLE data');

      const tles = parseTLEText(text);
      if (tles.length === 0) throw new Error('No TLEs parsed');

      console.log(`[${new Date().toISOString()}] [${group}] ${src.name} OK: ${tles.length} TLEs`);
      return tles;
    } catch (e) {
      const msg = `${src.name}: ${e.message}`;
      console.warn(`[${new Date().toISOString()}] [${group}] FAIL ${msg}`);
      errors.push(msg);
    }
  }

  throw new Error(`All sources failed for "${group}": ${errors.join(' | ')}`);
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
    return cache[group].data;
  }
  const tles = await fetchTLEs(group);
  cache[group] = { ts: now, data: tles, source: 'fetched' };
  return tles;
}

// ── ISS live position ──────────────────────────────────────
async function fetchISSPosition() {
  // Try two sources for ISS live position
  const sources = [
    'https://api.wheretheiss.at/v1/satellites/25544',
    'https://api.open-notify.org/iss-now.json',
  ];
  for (const url of sources) {
    try {
      const resp = await fetchWithTimeout(url, { timeout: 6000 });
      if (!resp.ok) continue;
      const data = await resp.json();
      // Normalize open-notify format
      if (data.iss_position) {
        return {
          latitude: parseFloat(data.iss_position.latitude),
          longitude: parseFloat(data.iss_position.longitude),
          altitude: 420,
          velocity: 27600,
        };
      }
      return data;
    } catch (e) {
      console.warn(`ISS source ${url} failed: ${e.message}`);
    }
  }
  throw new Error('All ISS sources failed');
}

// ── Routes ─────────────────────────────────────────────────

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

app.get('/tle/multi', async (req, res) => {
  const requested = (req.query.groups || 'stations,visual')
    .split(',').map(g => g.trim()).filter(g => VALID_GROUPS.includes(g)).slice(0, 6);
  if (requested.length === 0) {
    return res.status(400).json({ error: 'No valid groups', valid: VALID_GROUPS });
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

app.get('/iss', async (req, res) => {
  try {
    res.json(await fetchISSPosition());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

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

app.get('/api', (req, res) => {
  res.json({
    name: 'Orbital TLE Proxy',
    repo: 'github.com/wjheinle/Orbital',
    sources: ['celestrak.org', 'celestrak.com', 'tle.lulu.ac.nz'],
    endpoints: {
      'GET /':                  'Orbital PWA',
      'GET /tle/:group':        `Groups: ${VALID_GROUPS.join(' | ')}`,
      'GET /tle/multi?groups=': 'Batch fetch (max 6)',
      'GET /iss':               'Live ISS position',
      'GET /health':            'Cache status',
    },
  });
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Orbital proxy on port ${PORT}`);
  ['stations', 'visual'].forEach(g => {
    getCached(g).catch(e => console.warn(`Pre-warm "${g}":`, e.message));
  });
});
