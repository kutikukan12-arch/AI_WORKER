'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..', '..');
const DATA_DIR  = path.join(ROOT, 'data');
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
