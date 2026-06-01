'use strict';
// =====================================================
// project-insights.js — プロジェクト洞察の永続管理
//
// Human feedback・Product Audit・PM Audit・Requirements を
// data/project-insights.json に保存し、
// !project refine の gap 分析で参照できるようにする。
//
// Insight タイプ:
//   human_feedback  — CEO/Owner からの直接指摘（最高優先）
//   product_audit   — Product 視点の問題（P1相当）
//   pm_audit        — PM 視点の問題（P1相当）
//   requirement     — 受け入れ条件・完成基準（P3相当）
//
// Severity:
//   critical   → P1 コア価値未達
//   blocker    → P2 致命的不具合
//   major      → P3 受け入れ条件不足
//   minor      → P4 UX
//   trivial    → P5 Docs
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'project-insights.json');

const INSIGHT_TYPES = {
  HUMAN_FEEDBACK: 'human_feedback',
  PRODUCT_AUDIT:  'product_audit',
  PM_AUDIT:       'pm_audit',
  REQUIREMENT:    'requirement',
};

// type → デフォルト severity
const TYPE_DEFAULT_SEVERITY = {
  human_feedback: 'critical',
  product_audit:  'critical',
  pm_audit:       'critical',
  requirement:    'major',
};

// severity → P カテゴリ
const SEVERITY_TO_CATEGORY = {
  critical: 'P1',
  blocker:  'P2',
  major:    'P3',
  minor:    'P4',
  trivial:  'P5',
};

// ── ロード / セーブ ─────────────────────────────────
function loadAll() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAll(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // atomic write（同ドライブ tmp → rename）
  const tmp = path.join(dir, `.project-insights-${Date.now()}.tmp.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Insight CRUD ────────────────────────────────────

/**
 * Insight を追加する
 * @param {string} projectId
 * @param {string} type        INSIGHT_TYPES のいずれか
 * @param {string} text        指摘内容（自由テキスト）
 * @param {object} opts        { severity?, addedBy?, source? }
 * @returns {object} 追加した insight
 */
function addInsight(projectId, type, text, opts = {}) {
  const data  = loadAll();
  if (!data[projectId]) data[projectId] = { insights: [] };
  const list  = data[projectId].insights || [];

  const severity = opts.severity || TYPE_DEFAULT_SEVERITY[type] || 'major';
  const insight  = {
    id:        `ins_${Date.now()}`,
    type,
    text:      String(text).slice(0, 500),
    severity,
    category:  SEVERITY_TO_CATEGORY[severity] || 'P3',
    addedAt:   new Date().toISOString(),
    addedBy:   opts.addedBy  || 'system',
    source:    opts.source   || type,
    resolved:  false,
  };
  list.push(insight);
  data[projectId].insights = list;
  saveAll(data);
  return insight;
}

/**
 * プロジェクトの全 insight を返す（resolved 除く）
 */
function getInsights(projectId, opts = {}) {
  const data = loadAll();
  const list = (data[projectId]?.insights || []);
  if (opts.includeResolved) return list;
  return list.filter(i => !i.resolved);
}

/**
 * insight を resolved にする
 */
function resolveInsight(projectId, insightId) {
  const data = loadAll();
  const list = data[projectId]?.insights || [];
  const ins  = list.find(i => i.id === insightId);
  if (!ins) return null;
  ins.resolved   = true;
  ins.resolvedAt = new Date().toISOString();
  data[projectId].insights = list;
  saveAll(data);
  return ins;
}

/**
 * プロジェクトの全 insight を削除（resolved 含む）
 */
function clearInsights(projectId) {
  const data = loadAll();
  const count = (data[projectId]?.insights || []).length;
  if (data[projectId]) data[projectId].insights = [];
  saveAll(data);
  return count;
}

/**
 * severity → P カテゴリに変換
 */
function severityToCategory(severity) {
  return SEVERITY_TO_CATEGORY[severity] || 'P3';
}

/**
 * type の表示名
 */
function typeLabel(type) {
  return {
    human_feedback: 'Human Feedback',
    product_audit:  'Product Audit',
    pm_audit:       'PM Audit',
    requirement:    'Requirement',
  }[type] || type;
}

module.exports = {
  INSIGHT_TYPES,
  SEVERITY_TO_CATEGORY,
  TYPE_DEFAULT_SEVERITY,
  addInsight,
  getInsights,
  resolveInsight,
  clearInsights,
  severityToCategory,
  typeLabel,
  // テスト用
  _loadAll:  loadAll,
  _saveAll:  saveAll,
};
