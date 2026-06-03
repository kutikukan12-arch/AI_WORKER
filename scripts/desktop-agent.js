#!/usr/bin/env node
'use strict';
// =====================================================
// desktop-agent.js — Desktop Agent 常駐監視 (Phase4)
//
// AI_WORKER の outbox/inbox を監視し、
// 新しい依頼・返信の有無をコンソールに表示する。
//
// 使い方:
//   node scripts/desktop-agent.js watch    — 常駐監視 (30秒ごと)
//   node scripts/desktop-agent.js once     — 1回だけチェック
//   node scripts/desktop-agent.js status   — 状態ファイルを表示
//
// 安全ルール:
//   ✅ 全表示に redact() 適用
//   ✅ incoming.md をコマンドとして実行しない
//   ✅ eval / child_process による本文実行禁止
//   ✅ createTask / decision-log / incident-manager 自動実行禁止
//   ✅ 黒川は判断代理しない
// =====================================================

const fs   = require('fs');
const path = require('path');

// ─── 依存解決 ─────────────────────────────────────────
const ROOT       = path.join(__dirname, '..');
const redactMod  = require(path.join(ROOT, 'bot', 'utils', 'redact'));
const agentState = require(path.join(ROOT, 'bot', 'utils', 'desktop-agent-state'));
const inboxBridge = require(path.join(ROOT, 'bot', 'utils', 'inbox-bridge'));

const redact         = redactMod.redact;
const VALID_WORKERS  = inboxBridge.VALID_WORKERS;
const WORKER_DISPLAY = inboxBridge.WORKER_DISPLAY;

const WATCH_INTERVAL_MS = 30_000; // 30秒ごとに監視

// ─────────────────────────────────────────────────────
// ファイル存在確認＆コンテンツ取得（redact 済み）
// ─────────────────────────────────────────────────────
function _safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? raw : null; // 空ファイルは null 扱い
  } catch {
    return null;
  }
}

function _safeReadRedacted(filePath) {
  const raw = _safeRead(filePath);
  if (raw === null) return null;
  return redact(raw);
}

// ─────────────────────────────────────────────────────
// checkOnce() — 1回の監視チェック
//
// 各社員の outbox/inbox を走査し:
//   - outgoing.md が新規または更新 → 通知
//   - incoming.md が存在 → 返信あり表示
//   - ハッシュが同じ → 重複通知しない
//
// 戻り値: { newPending, newIncoming, errors }
// ─────────────────────────────────────────────────────
function checkOnce() {
  const newPending  = [];
  const newIncoming = [];
  const errors      = [];
  const now         = new Date().toLocaleString('ja-JP');

  for (const worker of VALID_WORKERS) {
    const display     = WORKER_DISPLAY[worker] || worker;
    const outgoingPath = inboxBridge._workerOutboxPath(worker);
    const incomingPath = inboxBridge._workerInboxPath(worker);
    const hashes       = agentState.getWorkerHashes(worker);

    try {
      // ── outgoing.md チェック ──
      const outContent = _safeRead(outgoingPath);
      if (outContent !== null) {
        const currentHash = agentState.hashContent(outContent);
        if (currentHash !== hashes.outgoingHash) {
          // 新規 or 更新
          const preview = redact(outContent).slice(0, 120).replace(/\n/g, ' ');
          newPending.push({ worker, display, preview, hash: currentHash });
        }
      }

      // ── incoming.md チェック ──
      const inContent = _safeRead(incomingPath);
      if (inContent !== null) {
        const currentHash = agentState.hashContent(inContent);
        if (currentHash !== hashes.incomingHash) {
          const preview = redact(inContent).slice(0, 80).replace(/\n/g, ' ');
          newIncoming.push({ worker, display, preview, hash: currentHash });
        }
      }
    } catch (e) {
      const errMsg = `[${worker}] ${e.message}`;
      errors.push(errMsg);
      agentState.logError(errMsg);
    }
  }

  // ─── 表示 ──────────────────────────────────────────
  if (newPending.length === 0 && newIncoming.length === 0) {
    if (process.argv[2] !== 'watch') {
      console.log(`[${now}] ✅ 新しい依頼・返信なし`);
    }
  } else {
    if (newPending.length > 0) {
      console.log(`\n[${now}] 📤 新しい outgoing (${newPending.length}件)`);
      for (const { display, preview, hash, worker } of newPending) {
        console.log(`  → ${display}`);
        console.log(`     ${preview}…`);
        agentState.markOutgoingSeen(worker, hash);
      }
    }
    if (newIncoming.length > 0) {
      console.log(`\n[${now}] 📥 返信あり (${newIncoming.length}件)`);
      for (const { display, preview, hash, worker } of newIncoming) {
        console.log(`  ← ${display}`);
        console.log(`     ${preview}…`);
        console.log(`     ↑ !inbox check ${worker} で確認してください`);
        agentState.markIncomingSeen(worker, hash);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`\n[${now}] ⚠️ エラー: ${errors.join(', ')}`);
  }

  // state に pending / incoming を記録
  agentState.updatePending(
    newPending.map(p => p.worker),
    newIncoming.map(p => p.worker)
  );

  return { newPending, newIncoming, errors };
}

// ─────────────────────────────────────────────────────
// showStatus() — state.json の現在状態を表示
// ─────────────────────────────────────────────────────
function showStatus() {
  const state = agentState.loadState();
  const now   = new Date().toLocaleString('ja-JP');

  console.log(`\n📊 Desktop Agent Status — ${now}`);
  console.log(`State file: ${agentState.STATE_FILE}`);
  console.log(`Last updated: ${state.updatedAt || '(未記録)'}`);
  console.log('');

  // 各社員の状態
  let anyWorker = false;
  for (const worker of VALID_WORKERS) {
    const display   = WORKER_DISPLAY[worker] || worker;
    const wState    = state.workers?.[worker] || {};
    const outPath   = inboxBridge._workerOutboxPath(worker);
    const inPath    = inboxBridge._workerInboxPath(worker);
    const hasOut    = fs.existsSync(outPath);
    const hasIn     = fs.existsSync(inPath) && (fs.statSync(inPath).size > 0);

    if (!hasOut && !hasIn && !wState.lastOutgoingHash) continue;
    anyWorker = true;

    const outStatus = hasOut
      ? (wState.lastOutgoingHash ? '✅ 既読' : '🔔 未確認')
      : '—';
    const inStatus  = hasIn  ? '📥 返信あり' : '—';
    const notified  = wState.lastNotifiedAt
      ? new Date(wState.lastNotifiedAt).toLocaleString('ja-JP')
      : '—';

    console.log(`  ${display}`);
    console.log(`    outgoing: ${outStatus}  incoming: ${inStatus}  最終通知: ${notified}`);
  }

  if (!anyWorker) {
    console.log('  (全社員の outbox/inbox が空です)');
  }

  if (state.pendingWorkers?.length > 0) {
    console.log(`\n📤 未確認 pending: ${state.pendingWorkers.join(', ')}`);
  }
  if (state.incomingWorkers?.length > 0) {
    console.log(`📥 返信待ち: ${state.incomingWorkers.join(', ')}`);
  }

  if (state.errorLog?.length > 0) {
    console.log(`\n⚠️ 直近エラー (${state.errorLog.length}件):`);
    state.errorLog.slice(-3).forEach(e => console.log(`  [${e.at}] ${e.msg}`));
  }
  console.log('');
}

// ─────────────────────────────────────────────────────
// watch() — 常駐監視モード
// ─────────────────────────────────────────────────────
function watch() {
  console.log('🤖 Desktop Agent 起動 (watch モード)');
  console.log(`   監視間隔: ${WATCH_INTERVAL_MS / 1000}秒`);
  console.log(`   監視対象: data/outbox/<worker>/outgoing.md`);
  console.log(`             data/inbox/<worker>/incoming.md`);
  console.log('   Ctrl+C で停止\n');

  // 起動直後に1回チェック
  checkOnce();

  const timer = setInterval(checkOnce, WATCH_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n🛑 Desktop Agent 停止');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────
// CLI エントリポイント — 直接実行時のみ動作
// require() 時は何もしない（テストから安全に import できる）
// ─────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2] || 'once';

  switch (cmd) {
    case 'watch':
      watch();
      break;

    case 'once': {
      const result = checkOnce();
      process.exit(result.errors.length > 0 ? 1 : 0);
      break;
    }

    case 'status':
      showStatus();
      process.exit(0);
      break;

    default:
      console.log(`使い方:
  node scripts/desktop-agent.js watch    — 常駐監視 (${WATCH_INTERVAL_MS / 1000}秒ごと)
  node scripts/desktop-agent.js once     — 1回だけチェック
  node scripts/desktop-agent.js status  — 状態表示
`);
      process.exit(0);
  }
}

module.exports = { checkOnce, showStatus, WATCH_INTERVAL_MS };
