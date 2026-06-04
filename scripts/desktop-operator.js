#!/usr/bin/env node
'use strict';
// =====================================================
// desktop-operator.js — 黒川 Desktop Operator (Phase1-10)
//
// 目的:
//   outbox に届いた固定ルート由来のメッセージを
//   Claude Desktop へ安全に投入する。
//
// 黒川の役割:
//   ✅ 固定ルート・安全条件を満たすメッセージの配送
//   ✅ リスクスキャン（block）
//   ✅ Audit Log 記録
//   ❌ 判断代理禁止
//   ❌ OSコマンドで本文実行禁止
//   ❌ eval / exec で本文実行禁止
//
// モード:
//   clipboard  — クリップボードにコピー（デフォルト）
//   auto-send  — Claude Desktop へ直接投入（要 robotjs）
//
// CLI:
//   node scripts/desktop-operator.js once
//   node scripts/desktop-operator.js watch
//   node scripts/desktop-operator.js status
//   node scripts/desktop-operator.js dry-run
// =====================================================

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const opState   = require(path.join(ROOT, 'bot', 'utils', 'desktop-operator-state'));
const scanner   = require(path.join(ROOT, 'bot', 'utils', 'desktop-operator-scanner'));
const { redact }= require(path.join(ROOT, 'bot', 'utils', 'redact'));
const inboxBridge = require(path.join(ROOT, 'bot', 'utils', 'inbox-bridge'));

const WATCH_INTERVAL_MS = 30_000;
const DRY_RUN = process.argv.includes('--dry-run') || process.argv[2] === 'dry-run';

// ─── Phase4: Operator 本体プロセス用グローバルロック ──
const OPERATOR_LOCK = path.join(opState.OP_DIR, 'operator.lock');
const STARTED_AT    = new Date().toISOString();

function _isPidAlive(pid) {
  if (!pid) return false;
  try {
    // process.kill(pid, 0) はプロセス存在確認（シグナル送信なし）
    process.kill(Number(pid), 0);
    return true;
  } catch { return false; }
}

function acquireOperatorLock() {
  // data/desktop-operator/ ディレクトリ確保
  if (!fs.existsSync(opState.OP_DIR)) fs.mkdirSync(opState.OP_DIR, { recursive: true });
  if (fs.existsSync(OPERATOR_LOCK)) {
    try {
      const lock = JSON.parse(fs.readFileSync(OPERATOR_LOCK, 'utf8'));
      const age  = Date.now() - new Date(lock.startedAt).getTime();
      // PID が生きているか確認（stale lock 検出）
      const alive = _isPidAlive(lock.pid);
      if (alive && age < 300_000) return false; // 5分以内かつ PID 生存 → 有効
      // stale: ロック解除して続行
      console.log(`[LOCK] stale lock 検出 (pid=${lock.pid}, age=${Math.floor(age/1000)}s, alive=${alive}) — 解除します`);
      fs.unlinkSync(OPERATOR_LOCK);
    } catch { try { fs.unlinkSync(OPERATOR_LOCK); } catch { /* ignore */ } }
  }
  fs.writeFileSync(OPERATOR_LOCK, JSON.stringify({
    pid:       process.pid,
    startedAt: STARTED_AT,
    mode:      DRY_RUN ? 'dry-run' : 'live',
  }), 'utf8');
  return true;
}

function releaseOperatorLock() {
  try { if (fs.existsSync(OPERATOR_LOCK)) fs.unlinkSync(OPERATOR_LOCK); } catch { /* ignore */ }
}

function readOperatorLock() {
  try {
    if (!fs.existsSync(OPERATOR_LOCK)) return null;
    return JSON.parse(fs.readFileSync(OPERATOR_LOCK, 'utf8'));
  } catch { return null; }
}

// ─── Heartbeat / State 管理 ──────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000; // 15秒ごとに更新

// state.json に operator の稼働状態を保存
function saveOperatorRunningState(extra = {}) {
  const state = opState.loadState();
  state.operatorStatus = {
    status:        extra.status   || 'running',
    pid:           process.pid,
    startedAt:     STARTED_AT,
    lastHeartbeat: new Date().toISOString(),
    mode:          DRY_RUN ? 'dry-run' : 'live',
    cwd:           process.cwd(),
    lockFile:      OPERATOR_LOCK,
    stateFile:     opState.STATE_FILE,
    lastError:     extra.lastError || null,
    ...extra,
  };
  opState.saveState(state);
}

function saveOperatorStoppedState(reason = 'normal') {
  try {
    const state = opState.loadState();
    const prev  = state.operatorStatus || {};
    state.operatorStatus = {
      ...prev,
      status:        'stopped',
      stoppedAt:     new Date().toISOString(),
      stoppedReason: reason,
      lastHeartbeat: new Date().toISOString(),
    };
    opState.saveState(state);
  } catch { /* ignore during shutdown */ }
}

function readOperatorStatus() {
  const state = opState.loadState();
  return state.operatorStatus || null;
}

// ─── Auto Send Allowlist (Phase3) ───────────────────
// 固定ルート由来かつ autoExecuted:true のもののみ自動送信
const ALLOWED_EVENTS = new Set([
  'IMPLEMENT_DONE', 'NEED_FIX', 'REVIEW_READY',
  'LESSON_CANDIDATE', 'INCIDENT_CANDIDATE', 'VP_BRIEF_REQUEST',
]);

// ─── 送信NG パターン ──────────────────────────────
const BLOCKED_KEYWORDS = [
  '支払い', '外部公開', '削除', 'secret変更', '.env変更',
  'git push --force', 'npm publish', '契約', '課金',
  'HUMAN_APPROVAL_REQUIRED', 'BLOCKED', 'CEO判断待ち',
];

// ─────────────────────────────────────────────────────
// findHandoffRecord(worker) — handoff log から固定ルート確認
// ─────────────────────────────────────────────────────
function findHandoffRecord(worker) {
  try {
    const wstate = require(path.join(ROOT, 'bot', 'utils', 'workflow-state'));
    const state  = wstate._load();
    const recent = (state.handoffs || [])
      .filter(h =>
        h.to === worker &&
        h.autoExecuted === true &&
        h.reason === 'fixed_route' &&
        !h.resolvedAt
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return recent[0] || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────
// checkAllowedToSend(worker, content, handoffRecord)
// ─────────────────────────────────────────────────────
function checkAllowedToSend(worker, content, handoffRecord) {
  // 1. handoff record の確認
  if (!handoffRecord) {
    return { allowed: false, reason: 'handoff_record_not_found: 固定ルートのログが見つかりません' };
  }
  if (!ALLOWED_EVENTS.has(handoffRecord.event)) {
    return { allowed: false, reason: `event_not_allowed: ${handoffRecord.event} は allowlist にありません` };
  }

  // 2. NG キーワードチェック
  const lower = content.toLowerCase();
  for (const kw of BLOCKED_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      return { allowed: false, reason: `blocked_keyword: "${kw}" を含む` };
    }
  }

  return { allowed: true };
}

// ─────────────────────────────────────────────────────
// copyToClipboard(text) — Phase5: clipboard モード
//
// Windows: clip コマンドを使用
// Mac:     pbcopy を使用
// その他:  xclip / xsel を試みる
//
// 注意: この関数は text をクリップボードにコピーするだけ。
//       exec で text を実行することは絶対にしない。
// ─────────────────────────────────────────────────────
function copyToClipboard(text) {
  const { execSync } = require('child_process');
  const safeText = String(text);

  // プラットフォーム別 clipboard コマンド
  const commands = {
    win32:  ['clip'],
    darwin: ['pbcopy'],
    linux:  ['xclip -selection clipboard', 'xsel --clipboard --input'],
  };

  const platform = process.platform;
  const cmds     = commands[platform] || commands.linux;

  for (const cmd of cmds) {
    try {
      // stdin を通じてテキストを渡す（本文をコマンド引数として渡さない）
      const [prog, ...args] = cmd.split(' ');
      const { spawnSync } = require('child_process');
      const result = spawnSync(prog, args, {
        input:    safeText,
        encoding: 'utf8',
        timeout:  5000,
      });
      if (result.status === 0) return { ok: true, method: cmd };
    } catch { /* try next */ }
  }
  return { ok: false, method: null, error: 'clipboard command not available' };
}

// ─────────────────────────────────────────────────────
// processWorker(worker) — 1 社員の outbox を処理
// ─────────────────────────────────────────────────────
function processWorker(worker) {
  // Phase5: pause チェック
  const bridge = require(path.join(ROOT, 'bot', 'utils', 'operator-bridge'));
  if (bridge.isPaused(opState)) {
    if (process.argv[2] !== 'watch') return null; // watch 以外では警告なし
    return null;
  }

  const outPath = inboxBridge._workerOutboxPath(worker);
  if (!fs.existsSync(outPath)) return null;

  const rawContent = fs.readFileSync(outPath, 'utf8').trim();
  if (!rawContent) return null;

  const currentHash = opState.hashContent(rawContent);
  const state       = opState.loadState();
  const workerState = state.workers[worker] || {};

  // 既読チェック（同じ内容は再処理しない）
  if (workerState.lastHash === currentHash) return null;

  // redact
  const safeContent = redact(rawContent);

  // リスクスキャン
  const riskResult = scanner.scanContent(safeContent);

  // handoff record 確認
  const handoffRecord = findHandoffRecord(worker);

  // 送信許可チェック
  const allowCheck = checkAllowedToSend(worker, safeContent, handoffRecord);

  // History ID 生成
  const histId = `dop_${Date.now()}${Math.floor(Math.random()*0x100).toString(16).padStart(2,'0')}`;

  // 重複チェック
  if (opState.isAlreadyProcessed(histId)) return null;

  // Prompt wrapper
  const wrappedPrompt = scanner.buildPrompt(worker, safeContent);

  const now = new Date().toISOString();
  let clipResult = null;
  let autoSent   = false;
  let blockedReason = null;

  if (!riskResult.safe) {
    blockedReason = `risk_blocked: ${riskResult.blocked.map(b => b.name).join(', ')}`;
    console.log(`\n🚫 [${worker}] リスクブロック: ${blockedReason}`);
  } else if (!allowCheck.allowed) {
    blockedReason = allowCheck.reason;
    console.log(`\n⛔ [${worker}] 送信NG: ${blockedReason}`);
  } else if (!DRY_RUN) {
    // clipboard へコピー
    clipResult = copyToClipboard(wrappedPrompt);
    if (clipResult.ok) {
      autoSent = true;
      console.log(`\n📋 [${worker}] クリップボードへコピー完了 (${histId})`);
      console.log(`   イベント: ${handoffRecord?.event}`);
      console.log(`   ハンドオフ: ${handoffRecord?.id}`);
    } else {
      blockedReason = `clipboard_failed: ${clipResult.error}`;
      console.log(`\n⚠️ [${worker}] クリップボードコピー失敗: ${clipResult.error}`);
    }
  } else {
    console.log(`\n[DRY-RUN] [${worker}] 送信候補: イベント=${handoffRecord?.event}`);
    console.log(`   プレビュー: ${wrappedPrompt.slice(0, 100)}…`);
  }

  // Audit Log 記録 (Phase7)
  const histEntry = {
    id:            histId,
    timestamp:     now,
    worker,
    sourceOutbox:  outPath,
    promptHash:    opState.hashContent(wrappedPrompt),
    promptPreview: redact(safeContent).slice(0, 80),
    mode:          'clipboard',
    riskResult:    { safe: riskResult.safe, blocked: riskResult.blocked.map(b => b.name) },
    handoffId:     handoffRecord?.id || null,
    event:         handoffRecord?.event || null,
    autoSent,
    blockedReason,
    dryRun:        DRY_RUN,
    completedAt:   new Date().toISOString(),
  };
  opState.appendHistory(histEntry);
  opState.markProcessed(histId);

  // State 更新
  state.workers[worker] = {
    ...workerState,
    lastHash:     currentHash,
    lastSeenAt:   now,
    lastHistId:   histId,
  };
  opState.saveState(state);

  return histEntry;
}

// ─────────────────────────────────────────────────────
// checkOnce() — 全社員 outbox を一度チェック
// ─────────────────────────────────────────────────────
function checkOnce() {
  // Phase5: pause チェック
  const bridge = require(path.join(ROOT, 'bot', 'utils', 'operator-bridge'));
  if (bridge.isPaused(opState)) {
    const state = opState.loadState();
    if (process.argv[2] === 'watch') {
      console.log(`[${new Date().toLocaleString('ja-JP')}] ⏸️ 一時停止中: ${state.pausedReason || '理由なし'}`);
    }
    return { results: [], newCount: 0, blockedCnt: 0 };
  }

  const workers    = inboxBridge.VALID_WORKERS;
  const results    = [];
  const now        = new Date().toLocaleString('ja-JP');
  let   newCount   = 0;
  let   blockedCnt = 0;

  for (const worker of workers) {
    const lock = opState.acquireLock(worker);
    if (!lock) { console.log(`[${worker}] ロック中 — スキップ`); continue; }
    try {
      const r = processWorker(worker);
      if (r) {
        results.push(r);
        if (r.autoSent)       newCount++;
        if (r.blockedReason)  blockedCnt++;
      }
    } finally {
      opState.releaseLock(worker);
    }
  }

  if (newCount === 0 && blockedCnt === 0 && process.argv[2] !== 'watch') {
    console.log(`[${now}] ✅ 新しい処理なし`);
  }
  if (blockedCnt > 0) {
    console.log(`\n[${now}] ⛔ ブロック: ${blockedCnt}件 — 守谷/社長確認が必要`);
  }

  return { results, newCount, blockedCnt };
}

// ─────────────────────────────────────────────────────
// showStatus() — 状態表示
// ─────────────────────────────────────────────────────
function showStatus() {
  const state   = opState.loadState();
  const history = opState.loadHistory();
  const now     = new Date().toLocaleString('ja-JP');
  const lock    = readOperatorLock();
  const opSt    = readOperatorStatus();

  // heartbeat ベースで 30秒以内なら「勤務中」（lock + heartbeat の二重確認）
  const hbAge     = opSt?.lastHeartbeat
    ? Date.now() - new Date(opSt.lastHeartbeat).getTime()
    : Infinity;
  const lockAlive = lock && _isPidAlive(lock.pid);
  const isRunning = lockAlive && hbAge < 30_000;

  const statusLabel= isRunning ? '🟢 勤務中' : '🔴 停止中';
  const sentCount  = history.filter(h => h.autoSent).length;
  const blockedCnt = history.filter(h => h.blockedReason).length;
  const lastSent   = history.filter(h => h.autoSent).slice(-1)[0];
  const lastLabel  = lastSent
    ? `${inboxBridge.WORKER_DISPLAY[lastSent.worker] || lastSent.worker} → ${lastSent.event || '?'}`
    : '（なし）';

  console.log(`\n🅶 **黒川 Desktop Operator**`);
  console.log(`状態: ${statusLabel}`);
  console.log(`PID: ${opSt?.pid || lock?.pid || '—'}`);
  console.log(`起動: ${opSt?.startedAt ? new Date(opSt.startedAt).toLocaleString('ja-JP') : '—'}`);
  console.log(`最終 Heartbeat: ${opSt?.lastHeartbeat ? new Date(opSt.lastHeartbeat).toLocaleString('ja-JP') + ` (${Math.floor(hbAge/1000)}秒前)` : '—'}`);
  console.log(`モード: ${opSt?.mode || '—'}`);
  console.log(`処理数: ${history.length}件 (送信 ${sentCount} / ブロック ${blockedCnt})`);
  console.log(`最終配送: ${lastLabel}`);
  if (opSt?.lastError) console.log(`最終エラー: ${opSt.lastError}`);
  console.log(`Lock: ${OPERATOR_LOCK}`);
  console.log(`State: ${opState.STATE_FILE}`);
  console.log(`CWD: ${opSt?.cwd || process.cwd()}`);
  console.log('');

  const workers = inboxBridge.VALID_WORKERS;
  let   any     = false;
  for (const worker of workers) {
    const ws   = state.workers?.[worker];
    const disp = inboxBridge.WORKER_DISPLAY[worker] || worker;
    if (!ws?.lastHash) continue;
    any = true;
    console.log(`  ${disp}: ${ws.lastSeenAt ? new Date(ws.lastSeenAt).toLocaleString('ja-JP') : '—'}`);
  }
  if (!any) console.log('  （処理履歴なし）');

  const recentBlocked = history.filter(h => h.blockedReason).slice(-3);
  if (recentBlocked.length) {
    console.log(`\n🚫 直近ブロック:`);
    recentBlocked.forEach(h => console.log(`  [${h.worker}] ${h.blockedReason}`));
  }
  console.log('');
}

// ─────────────────────────────────────────────────────
// watch() — 常駐監視
// ─────────────────────────────────────────────────────
function watch() {
  // Phase4: 二重起動防止
  if (!acquireOperatorLock()) {
    const lock = readOperatorLock();
    console.log(`\n🅶 黒川は勤務中です。`);
    if (lock) {
      console.log(`   起動時刻: ${new Date(lock.startedAt).toLocaleString('ja-JP')}`);
      console.log(`   PID: ${lock.pid}`);
    }
    console.log(`   既存プロセスを停止してから再起動してください。`);
    process.exit(0);
  }

  console.log('🤖 黒川 Desktop Operator 出勤 (watch モード)');
  console.log(`   起動時刻: ${new Date(STARTED_AT).toLocaleString('ja-JP')}`);
  console.log(`   PID: ${process.pid}`);
  console.log(`   モード: ${DRY_RUN ? 'DRY-RUN' : 'LIVE (clipboard)'}`);
  console.log(`   間隔: ${WATCH_INTERVAL_MS / 1000}秒`);
  console.log(`   Lock: ${OPERATOR_LOCK}`);
  console.log(`   State: ${opState.STATE_FILE}`);
  console.log('   Ctrl+C で退勤\n');

  // state.json に running 状態を保存（起動直後）
  saveOperatorRunningState({ status: 'running' });

  checkOnce();
  const mainTimer      = setInterval(checkOnce, WATCH_INTERVAL_MS);
  // heartbeat: 15秒ごとに state.json を更新（Discord からの確認用）
  const heartbeatTimer = setInterval(() => saveOperatorRunningState(), HEARTBEAT_INTERVAL_MS);

  const shutdown = (reason = 'SIGINT') => {
    clearInterval(mainTimer);
    clearInterval(heartbeatTimer);
    saveOperatorStoppedState(reason);
    releaseOperatorLock();
    console.log(`\n🅶 黒川 退勤 (${reason})`);
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    saveOperatorStoppedState(`error: ${e.message}`);
    releaseOperatorLock();
    process.exit(1);
  });
}

// ─────────────────────────────────────────────────────
// CLI エントリポイント
// ─────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2] || 'once';
  switch (cmd) {
    case 'watch':
      watch();
      break;
    case 'once':
    case 'dry-run': {
      const r = checkOnce();
      process.exit(r.blockedCnt > 0 ? 1 : 0);
      break;
    }
    case 'status':
      showStatus();
      process.exit(0);
      break;
    default:
      console.log(`使い方:
  node scripts/desktop-operator.js once      — 1回チェック
  node scripts/desktop-operator.js watch     — 常駐監視
  node scripts/desktop-operator.js dry-run   — 確認のみ（実行なし）
  node scripts/desktop-operator.js status    — 状態表示
`);
      process.exit(0);
  }
}

module.exports = {
  checkOnce,
  showStatus,
  processWorker,
  checkAllowedToSend,
  ALLOWED_EVENTS,
  acquireOperatorLock,
  releaseOperatorLock,
  readOperatorLock,
  readOperatorStatus,
  saveOperatorRunningState,
  saveOperatorStoppedState,
  OPERATOR_LOCK,
  HEARTBEAT_INTERVAL_MS,
};
