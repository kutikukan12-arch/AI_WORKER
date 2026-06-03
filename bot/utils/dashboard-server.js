'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..', '..');
const DATA_DIR  = path.join(ROOT, 'data');
const LOG_DIR   = path.join(ROOT, 'logs');
const HTML_FILE = path.join(ROOT, 'public', 'dashboard.html');

let _youtubePredictor = null;
function _getPredictor() {
  if (!_youtubePredictor) {
    try { _youtubePredictor = require('./youtube-predictor'); } catch { /* optional */ }
  }
  return _youtubePredictor;
}

const DASHBOARD_PORT = process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT) : 3000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return null;
  }
}

function apiTasks(_req, res) {
  const data = readJson('tasks.json');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data?.tasks ?? []));
}

function apiRunner(_req, res) {
  const data = readJson('runner-state.json');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data ?? {}));
}

function apiProjects(_req, res) {
  const data = readJson('projects.json');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data?.projects ?? []));
}

function apiApprovals(_req, res) {
  const data = readJson('approvals.json');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  const list = Array.isArray(data) ? data : (data?.approvals ?? Object.values(data ?? {}));
  res.end(JSON.stringify(list));
}

function apiApprovalAction(req, res) {
  const parts = req.url.split('?')[0].split('/');
  // /api/approvals/:taskId/:action
  const taskId = decodeURIComponent(parts[3] || '');
  const action = parts[4];
  const VALID = { approve: 'approved', deny: 'denied', pause: 'paused', resume: 'pending' };
  if (!taskId || !VALID[action]) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid' }));
    return;
  }
  try {
    const raw  = fs.readFileSync(path.join(DATA_DIR, 'approvals.json'), 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data?.approvals ?? []);
    const idx  = list.findIndex(a => a.taskId === taskId);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    const now = new Date().toISOString();
    list[idx].state      = VALID[action];
    list[idx].updatedAt  = now;
    list[idx].resolvedBy = 'dashboard';
    list[idx].resolvedAt = now;
    const save = Array.isArray(data) ? list : { ...data, approvals: list };
    fs.writeFileSync(path.join(DATA_DIR, 'approvals.json'), JSON.stringify(save, null, 2), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, taskId, action }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function readCostToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, `cost-${y}-${m}-${d}.jsonl`);
  try {
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return {
      totalUsd:  Math.round(rows.reduce((s, r) => s + (Number(r.costUsd) || 0), 0) * 10000) / 10000,
      taskCount: rows.length,
      totalSec:  rows.reduce((s, r) => s + (Number(r.durationSec) || 0), 0),
    };
  } catch { return { totalUsd: 0, taskCount: 0, totalSec: 0 }; }
}

function readCostMonthly() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const file = path.join(LOG_DIR, `cost-${y}-${m}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { totalUsd: 0, bySource: {}, byProject: {}, taskCount: 0 }; }
}

function apiCost(_req, res) {
  const today   = readCostToday();
  const monthly = readCostMonthly();
  const warnDaily  = parseFloat(process.env.COST_WARN_DAILY_USD  || '5.00');
  const alertDaily = parseFloat(process.env.COST_ALERT_DAILY_USD || '10.00');
  let status = 'GREEN';
  if (today.totalUsd >= alertDaily)      status = 'RED';
  else if (today.totalUsd >= warnDaily)  status = 'YELLOW';
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ today, monthly, status, thresholds: { warnDaily, alertDaily } }));
}

function apiModelStatus(_req, res) {
  const p = _getPredictor();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  if (!p) { res.end(JSON.stringify({ trained: false, sampleCount: 0, error: 'module unavailable' })); return; }
  try { res.end(JSON.stringify(p.getModelStatus())); }
  catch (e) { res.end(JSON.stringify({ trained: false, sampleCount: 0, error: e.message })); }
}

function apiPredict(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const p = _getPredictor();
    if (!p) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'youtube-predictor module unavailable' }));
      return;
    }
    try {
      const video = JSON.parse(body || '{}');
      if (!video.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }
      const result  = p.predict(video);
      const summary = p.buildSummary(video, result);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ result, summary }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function apiDiagnose(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const p = _getPredictor();
    if (!p) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'youtube-predictor module unavailable' }));
      return;
    }
    try {
      const video = JSON.parse(body || '{}');
      if (!video.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }
      const diagResult  = p.diagnose(video);
      const diagSummary = p.buildDiagnosisSummary(video, diagResult);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ diagResult, diagSummary }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function serveHtml(_req, res) {
  try {
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('dashboard.html not found');
  }
}

const ROUTES = {
  '/api/tasks':     apiTasks,
  '/api/runner':    apiRunner,
  '/api/projects':  apiProjects,
  '/api/approvals': apiApprovals,
  '/api/cost':      apiCost,
  '/api/model':     apiModelStatus,
};

const APPROVAL_ACTION_RE = /^\/api\/approvals\/[^/]+\/(approve|deny|pause|resume)$/;

function startDashboard(logger) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'POST' && url === '/api/predict') {
      apiPredict(req, res);
    } else if (req.method === 'POST' && url === '/api/diagnose') {
      apiDiagnose(req, res);
    } else if (req.method === 'POST' && APPROVAL_ACTION_RE.test(url)) {
      apiApprovalAction(req, res);
    } else if (ROUTES[url]) {
      ROUTES[url](req, res);
    } else {
      serveHtml(req, res);
    }
  });

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    if (logger) logger.info(`[Dashboard] http://localhost:${DASHBOARD_PORT}`);
    else console.log(`[Dashboard] http://localhost:${DASHBOARD_PORT}`);
  });

  server.on('error', err => {
    if (logger) logger.warn(`[Dashboard] 起動失敗: ${err.message}`);
    else console.warn(`[Dashboard] 起動失敗: ${err.message}`);
  });

  return server;
}

module.exports = { startDashboard };
