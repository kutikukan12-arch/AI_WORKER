'use strict';
// =====================================================
// safe-restart.js — Safe Restart Manager (Phase3+5)
//
// 目的:
//   Bot / Desktop Operator を安全な条件下で再起動する。
//
// 条件（全て満たす必要あり）:
//   - 実行中タスクがない
//   - outbox 未処理なし（or 許容）
//   - 既存 restart-manager.js との整合性維持
//
// 役割:
//   宮城: 更新作業担当（!system restart を実行）
//   黒川: 状態監視担当（heartbeat / recovery 担当）
//   CEO:  プロセス管理しない
//
// Phase5: Recovery
//   - heartbeat 停止検出
//   - stale lock 自動解除
//   - 復旧ログ保存
// =====================================================

const fs   = require('fs');
const path = require('path');

const ROOT_DIR      = path.join(__dirname, '..', '..');
const DATA_DIR      = path.join(ROOT_DIR, 'data');
const RECOVERY_FILE = path.join(DATA_DIR, 'recovery-log.json');
const RESTART_STATE = path.join(DATA_DIR, 'restart-state.json');

// ─────────────────────────────────────────────────────
// Phase3: 安全条件チェック
// ─────────────────────────────────────────────────────
function checkSafeToRestart(target) {
  const issues = [];

  // 実行中タスクチェック
  try {
    const tm   = require('./task-manager');
    const list = tm.listTasks();
    const inProgress = list.filter(t =>
      t.state === '作業中' || t.state === 'IN_PROGRESS'
    );
    if (inProgress.length > 0) {
      issues.push(`実行中タスク: ${inProgress.length}件 (${inProgress.map(t => t.id).join(', ')})`);
    }
  } catch { /* ignore */ }

  // outbox 未処理チェック（Operator 再起動時のみ）
  if (target === 'operator' || target === 'all') {
    try {
      const ib = require('./inbox-bridge');
      const pending = ib.VALID_WORKERS.filter(w => {
        const p = ib._workerOutboxPath(w);
        return fs.existsSync(p) && fs.statSync(p).size > 0;
      });
      if (pending.length > 0) {
        issues.push(`未処理 outbox: ${pending.join(', ')}`);
      }
    } catch { /* ignore */ }
  }

  return { safe: issues.length === 0, issues };
}

// ─────────────────────────────────────────────────────
// Phase3: Bot 再起動フラグ設定
// restart-manager.js の既存フローと統合
// ─────────────────────────────────────────────────────
function requestBotRestart(reason = 'system restart') {
  // 既存 restart-state.json フォーマットと互換
  const state = {
    requestedAt: new Date().toISOString(),
    reason,
    source:      'system-restart-manager',
  };
  fs.writeFileSync(RESTART_STATE, JSON.stringify(state, null, 2), 'utf8');
  return { ok: true, message: `Bot 再起動フラグを設定しました。\`!restart confirm\` で再起動してください。` };
}

// ─────────────────────────────────────────────────────
// Phase3: Operator 再起動
// operator.lock を削除して新規起動を促す
// ─────────────────────────────────────────────────────
function requestOperatorRestart(reason = 'system restart') {
  const opLock = path.join(DATA_DIR, 'desktop-operator', 'operator.lock');
  const removed = fs.existsSync(opLock);
  if (removed) {
    try { fs.unlinkSync(opLock); } catch { /* ignore */ }
  }

  // Operator 停止状態を state.json に記録
  try {
    const opState = require('./desktop-operator-state');
    const state   = opState.loadState();
    if (state.operatorStatus) {
      state.operatorStatus.status        = 'restart_requested';
      state.operatorStatus.restartReason = reason;
      state.operatorStatus.restartAt     = new Date().toISOString();
      opState.saveState(state);
    }
  } catch { /* ignore */ }

  return {
    ok: true,
    lockRemoved: removed,
    message: `Operator 再起動フラグを設定しました。\`npm run operator\` または \`start-operator.bat\` で再起動してください。`,
  };
}

// ─────────────────────────────────────────────────────
// buildRestartReport(target, safeCheck, actionResult)
// Discord 表示用レポート生成
// ─────────────────────────────────────────────────────
function buildRestartReport(target, safeCheck, results) {
  const lines = [`🔄 **System Restart: ${target}**`, ``];

  if (!safeCheck.safe) {
    lines.push(`❌ **安全条件を満たしていません:**`);
    safeCheck.issues.forEach(i => lines.push(`  • ${i}`));
    lines.push(``, `実行中の処理が完了してから再試行してください。`);
    return { ok: false, text: lines.join('\n') };
  }

  if (results.bot) {
    lines.push(`🤖 **Bot:**`);
    lines.push(`  ${results.bot.ok ? '✅' : '❌'} ${results.bot.message}`);
    lines.push('');
  }
  if (results.operator) {
    lines.push(`🅶 **Desktop Operator:**`);
    lines.push(`  ${results.operator.ok ? '✅' : '❌'} ${results.operator.message}`);
    lines.push('');
  }

  lines.push(`> heartbeat 確認: \`!system status\` で再起動後の状態を確認してください。`);
  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// Phase5: Recovery Log
// ─────────────────────────────────────────────────────
function logRecovery(entry) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const list = fs.existsSync(RECOVERY_FILE)
      ? JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8'))
      : [];
    list.push({ ...entry, at: new Date().toISOString() });
    const trimmed = list.slice(-100);
    const tmp = RECOVERY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
    fs.renameSync(tmp, RECOVERY_FILE);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// Phase5: Heartbeat/stale lock 検出
// ─────────────────────────────────────────────────────
function checkComponentHealth() {
  const issues = [];
  const now    = Date.now();

  // Operator heartbeat 確認
  try {
    const opState = require('./desktop-operator-state');
    const state   = opState.loadState();
    const opSt    = state.operatorStatus;
    if (opSt?.status === 'running' && opSt.lastHeartbeat) {
      const age = now - new Date(opSt.lastHeartbeat).getTime();
      if (age > 60_000) {  // 1分以上ハートビートなし
        issues.push({
          component: 'operator',
          type:      'heartbeat_stale',
          ageMs:     age,
          detail:    `Operator heartbeat が ${Math.floor(age/1000)}秒前から更新なし`,
        });
      }
    }

    // stale lock 確認
    const opLock = path.join(DATA_DIR, 'desktop-operator', 'operator.lock');
    if (fs.existsSync(opLock)) {
      const lock = JSON.parse(fs.readFileSync(opLock, 'utf8'));
      const age  = now - new Date(lock.startedAt).getTime();
      let pidAlive = false;
      try { process.kill(lock.pid, 0); pidAlive = true; } catch {}
      if (!pidAlive && age > 60_000) {
        issues.push({
          component: 'operator',
          type:      'stale_lock',
          pid:       lock.pid,
          detail:    `stale operator.lock 検出 (pid=${lock.pid} 死亡)`,
        });
      }
    }
  } catch { /* ignore */ }

  return issues;
}

module.exports = {
  checkSafeToRestart,
  requestBotRestart,
  requestOperatorRestart,
  buildRestartReport,
  logRecovery,
  checkComponentHealth,
  RECOVERY_FILE,
};
