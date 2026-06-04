'use strict';
// =====================================================
// workflow-audit.js — Workflow Audit Log (Phase4)
//
// 全 autoHandoff の試みを記録する。
// safe:false の停止理由も含めて保存。
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', '..', 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'workflow-audit.json');

function _load() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  } catch { return []; }
}

function _save(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = AUDIT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-500), null, 2), 'utf8');
    fs.renameSync(tmp, AUDIT_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function appendAudit(entry) {
  const list = _load();
  list.push({ ...entry, at: new Date().toISOString() });
  _save(list);
}

function getRecentAudit(limit = 20) {
  return _load().slice(-limit).reverse();
}

module.exports = { appendAudit, getRecentAudit, AUDIT_FILE, _load };
