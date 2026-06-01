'use strict';
// =====================================================
// pending-plans.js — !project refine の保留計画管理
//
// data/pending-plans.json に planId 単位で保存する。
//
// Status machine:
//   pending → approved → consumed
//   pending → discarded
//   approved は使用時 consumed に遷移
//
// セーフガード:
//   - atomic write（tmp ファイル経由）
//   - TTL 24h（PLAN_TTL_MS）
//   - projectId スコープ
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'pending-plans.json');
const PLAN_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

// ── ステータス定数 ────────────────────────────────────
const PLAN_STATUS = {
  PENDING:   'pending',
  APPROVED:  'approved',
  CONSUMED:  'consumed',
  DISCARDED: 'discarded',
};

// ── ロード / セーブ ─────────────────────────────────
function loadPlans() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw).plans || [];
  } catch {
    return [];
  }
}

/** atomic write: tmp（同ドライブ）→ rename */
function savePlans(plans) {
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // os.tmpdir() は別ドライブの場合 EXDEV になるため、同ディレクトリに tmp を置く
  const tmp = path.join(dataDir, `.pending-plans-${Date.now()}.tmp.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ plans }, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** TTL 切れ（consumed/discarded 含む）を除去 */
function pruneExpired(plans) {
  const now = Date.now();
  return plans.filter(p => {
    const alive = p.status === PLAN_STATUS.PENDING || p.status === PLAN_STATUS.APPROVED;
    const fresh  = new Date(p.expiresAt).getTime() > now;
    return alive && fresh;
  });
}

// ── 作成 ────────────────────────────────────────────
/**
 * @param {string} projectId
 * @param {string} requestedBy  Discord userId
 * @param {Array}  tasks        提案タスク配列（最大 MAX_TASKS 件）
 * @param {Array}  overflow     上限超分
 * @returns {object} 作成された plan
 */
function createPlan(projectId, requestedBy, tasks, overflow = []) {
  const plans = pruneExpired(loadPlans());

  // 同一 projectId の古い pending/approved を discarded にする（上書き）
  plans.forEach(p => {
    if (p.projectId === projectId &&
        (p.status === PLAN_STATUS.PENDING || p.status === PLAN_STATUS.APPROVED)) {
      p.status = PLAN_STATUS.DISCARDED;
    }
  });

  const now = new Date();
  const plan = {
    id:          `plan_${now.getTime()}`,
    projectId,
    createdAt:   now.toISOString(),
    expiresAt:   new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    status:      PLAN_STATUS.PENDING,
    requestedBy,
    tasks,
    overflow,
  };
  plans.push(plan);
  savePlans(plans);
  return plan;
}

// ── 取得 ────────────────────────────────────────────
/** projectId の最新 pending/approved plan を返す */
function getLatestPlan(projectId) {
  const plans = pruneExpired(loadPlans());
  const active = plans
    .filter(p => p.projectId === projectId &&
                 (p.status === PLAN_STATUS.PENDING || p.status === PLAN_STATUS.APPROVED))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return active[0] || null;
}

/** planId で直接取得 */
function getPlanById(planId) {
  const plans = loadPlans();
  return plans.find(p => p.id === planId) || null;
}

// ── 状態遷移 ─────────────────────────────────────────
/** pending/approved → consumed */
function consumePlan(planId) {
  const plans = loadPlans();
  const plan  = plans.find(p => p.id === planId);
  if (!plan) return null;
  if (plan.status === PLAN_STATUS.CONSUMED) return plan; // 冪等
  plan.status = PLAN_STATUS.CONSUMED;
  plan.consumedAt = new Date().toISOString();
  savePlans(plans);
  return plan;
}

/** pending/approved → discarded */
function discardPlan(planId) {
  const plans = loadPlans();
  const plan  = plans.find(p => p.id === planId);
  if (!plan) return null;
  plan.status = PLAN_STATUS.DISCARDED;
  plan.discardedAt = new Date().toISOString();
  savePlans(plans);
  return plan;
}

/** projectId の全 pending/approved を discarded に */
function discardByProject(projectId) {
  const plans = loadPlans();
  let count = 0;
  plans.forEach(p => {
    if (p.projectId === projectId &&
        (p.status === PLAN_STATUS.PENDING || p.status === PLAN_STATUS.APPROVED)) {
      p.status = PLAN_STATUS.DISCARDED;
      p.discardedAt = new Date().toISOString();
      count++;
    }
  });
  savePlans(plans);
  return count;
}

module.exports = {
  PLAN_STATUS,
  MAX_TASKS: 20,
  createPlan,
  getLatestPlan,
  getPlanById,
  consumePlan,
  discardPlan,
  discardByProject,
  // テスト用
  _loadPlans: loadPlans,
  _savePlans: savePlans,
};
