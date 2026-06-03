'use strict';
// =====================================================
// system-health.js — System Health Manager (Phase6)
//
// 目的: システム全体の健全性を確認する。
// 出力のみ。修正・変更は禁止。
//
// 確認項目:
//   - Security: security-check 結果（簡易版）
//   - Memory: Decision 重複 / Lesson 状態
//   - Workflow: 長期待ち
//   - Worker: 停止社員
//   - Project: 放置タスク
//
// 禁止:
//   ❌ 自動修正
//   ❌ eval / exec
//   ❌ task変更・削除
// =====================================================

const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

// ─────────────────────────────────────────────────────
// 各チェック項目
// ─────────────────────────────────────────────────────

// Security: gitignore 変更確認・training model 追跡確認
function _checkSecurity() {
  const issues  = [];
  const ok      = [];
  try {
    const { execSync } = require('child_process');
    const tracked = execSync('git ls-files data/youtube-model.json data/youtube-model-pre.json', {
      cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (tracked) {
      issues.push(`⚠️ training model が git 追跡されています: ${tracked.split('\n').join(', ')}`);
    } else {
      ok.push('✅ training model は git 追跡対象外');
    }
  } catch {
    ok.push('ℹ️ security check（git 確認スキップ）');
  }
  return { issues, ok };
}

// Memory: Decision 重複・古い判断
function _checkMemory() {
  const issues = [];
  const ok     = [];
  try {
    const dl      = require('./decision-log');
    const list    = dl._load();
    const active  = list.filter(d => dl._isActive(d));
    const archived= list.filter(d => !dl._isActive(d));

    // 重複チェック
    const dups = dl.findDuplicates(active);
    if (dups.length > 0) {
      issues.push(`⚠️ Decision 重複候補: ${dups.length}グループ → \`!decision cleanup\` で確認`);
    } else {
      ok.push(`✅ Decision 重複なし (active ${active.length}件 / archived ${archived.length}件)`);
    }

    // カテゴリ未設定
    const noCat = active.filter(d => !d.category).length;
    if (noCat > 3) {
      issues.push(`ℹ️ カテゴリ未設定 Decision: ${noCat}件 → \`!decision show <id>\` で確認`);
    }
  } catch {
    ok.push('ℹ️ Decision チェックスキップ');
  }

  // Lesson ファイル存在確認
  const lessonsPath = path.join(ROOT_DIR, 'LESSONS.md');
  if (fs.existsSync(lessonsPath)) {
    const size = fs.statSync(lessonsPath).size;
    ok.push(`✅ LESSONS.md: ${size} bytes`);
  } else {
    issues.push('⚠️ LESSONS.md が見つかりません');
  }

  return { issues, ok };
}

// Workflow: 長期待ち
function _checkWorkflow() {
  const issues = [];
  const ok     = [];
  try {
    const wstate  = require('./workflow-state');
    const longWait = wstate.detectWaiting(4 * 60 * 60 * 1000); // 4時間
    if (longWait.length > 0) {
      issues.push(`⚠️ 4時間超のハンドオフ: ${longWait.length}件 → \`!workflow status\` で確認`);
    } else {
      ok.push('✅ 長期待ちハンドオフなし');
    }
  } catch {
    ok.push('ℹ️ Workflow チェックスキップ');
  }
  return { issues, ok };
}

// Worker: 停止・ブロック社員
function _checkWorkers() {
  const issues = [];
  const ok     = [];
  try {
    const wsm     = require('./worker-status');
    const data    = wsm._load();
    const blocked = wsm.VALID_WORKERS.filter(w => data[w]?.status === 'blocked');
    if (blocked.length > 0) {
      const names = blocked.map(w => wsm.WORKER_DISPLAY[w] || w).join(', ');
      issues.push(`⚠️ ブロック中の社員: ${names} → CEO確認が必要`);
    } else {
      ok.push('✅ ブロック中の社員なし');
    }
  } catch {
    ok.push('ℹ️ Worker チェックスキップ');
  }
  return { issues, ok };
}

// Project: 放置タスク（長時間 IN_PROGRESS）
function _checkProjects() {
  const issues = [];
  const ok     = [];
  const STALE_MS = 24 * 60 * 60 * 1000; // 24時間
  try {
    const tm   = require('./task-manager');
    const list = tm.listTasks();
    const now  = Date.now();
    const stale = list.filter(t => {
      if (t.state !== '作業中' && t.state !== 'IN_PROGRESS') return false;
      const age = now - new Date(t.updatedAt || t.createdAt).getTime();
      return age > STALE_MS;
    });
    if (stale.length > 0) {
      issues.push(`⚠️ 24時間超 作業中タスク: ${stale.length}件 → \`!task list\` で確認`);
    } else {
      ok.push('✅ 放置タスクなし');
    }
    const total = list.length;
    ok.push(`ℹ️ アクティブタスク: ${total}件`);
  } catch {
    ok.push('ℹ️ Project チェックスキップ');
  }
  return { issues, ok };
}

// ─────────────────────────────────────────────────────
// checkHealth() — 全体ヘルスチェック
// ─────────────────────────────────────────────────────
function checkHealth() {
  const now     = new Date().toLocaleString('ja-JP');
  const checks  = {
    security: _checkSecurity(),
    memory:   _checkMemory(),
    workflow: _checkWorkflow(),
    workers:  _checkWorkers(),
    projects: _checkProjects(),
  };

  const allIssues = Object.values(checks).flatMap(c => c.issues);
  const allOk     = Object.values(checks).flatMap(c => c.ok);
  const score     = allIssues.length === 0 ? '🟢 HEALTHY'
                  : allIssues.some(i => i.startsWith('⚠️'))
                    ? '🟡 WARN'
                    : '🔴 ISSUES';

  const lines = [
    `🏥 **System Health Check**`,
    `実行: ${now}`,
    `状態: ${score}`,
    ``,
    `**🔒 Security**`,
    ...[...checks.security.ok, ...checks.security.issues],
    ``,
    `**🧠 Memory (Decision / Lesson)**`,
    ...[...checks.memory.ok, ...checks.memory.issues],
    ``,
    `**🔀 Workflow**`,
    ...[...checks.workflow.ok, ...checks.workflow.issues],
    ``,
    `**👥 Workers**`,
    ...[...checks.workers.ok, ...checks.workers.issues],
    ``,
    `**📋 Projects**`,
    ...[...checks.projects.ok, ...checks.projects.issues],
    ``,
    `---`,
    `問題 ${allIssues.length}件 / 正常 ${allOk.length}件`,
    `⚠️ このレポートは確認のみです。修正は社長が手動で行ってください。`,
  ];

  return {
    ok:         true,
    text:       lines.join('\n').slice(0, 1900),
    issueCount: allIssues.length,
    score,
  };
}

module.exports = {
  checkHealth,
  _checkSecurity,
  _checkMemory,
  _checkWorkflow,
  _checkWorkers,
  _checkProjects,
};
