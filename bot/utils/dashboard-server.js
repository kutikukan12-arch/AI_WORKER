'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..', '..');
const DATA_DIR  = path.join(ROOT, 'data');
const LOG_DIR   = path.join(ROOT, 'logs');
const HTML_FILE = path.join(ROOT, 'public', 'dashboard.html');

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
};

function startDashboard(logger) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (ROUTES[url]) {
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
