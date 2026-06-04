'use strict';
// =====================================================
// operator-reliability.js — Desktop Operator 信頼度管理
//
// 目的:
//   worker 別の送信成功/失敗を追跡し、
//   3回連続成功した worker だけ auto-send を許可する。
//   失敗時は clipboard モードへ自動降格。
//
// Auto-send Allowlist:
//   ['moriya', 'miyagi', 'kanzaki'] のみが auto-send 候補。
//   他の worker は常に clipboard モード。
//
// Mode:
//   clipboard         — クリップボードのみ（デフォルト）
//   autosend-limited  — allowlist かつ 3回連続成功した worker のみ auto-send
//   paused            — 全停止（緊急停止と同義）
// =====================================================

// Auto-send を許可する worker のホワイトリスト
const AUTOSEND_ALLOWLIST = new Set(['moriya', 'miyagi', 'kanzaki']);

// auto-send 解禁に必要な連続成功回数
const REQUIRED_CONSECUTIVE = 3;

// ─── モード定義 ─────────────────────────────────────
const MODES = {
  CLIPBOARD:        'clipboard',
  AUTOSEND_LIMITED: 'autosend-limited',
  PAUSED:           'paused',
};

// ─────────────────────────────────────────────────────
// getMode(opState) — 現在のモードを取得
// ─────────────────────────────────────────────────────
function getMode(opState) {
  const state = opState.loadState();
  // paused フラグが立っていれば優先
  if (state.paused) return MODES.PAUSED;
  return state.operatorMode || MODES.CLIPBOARD;
}

// setMode(opState, mode) — モードを変更
function setMode(opState, mode) {
  if (!Object.values(MODES).includes(mode)) {
    return { ok: false, error: `不明なモード: ${mode}. 有効: ${Object.values(MODES).join(' / ')}` };
  }
  const state = opState.loadState();
  state.operatorMode = mode;
  if (mode === MODES.PAUSED) {
    state.paused       = true;
    state.pausedReason = 'operatorMode=paused';
  } else if (state.paused && mode !== MODES.PAUSED) {
    // paused 解除
    state.paused       = false;
    state.pausedReason = null;
  }
  opState.saveState(state);
  return { ok: true, mode };
}

// ─────────────────────────────────────────────────────
// getWorkerReliability(opState, worker) — worker の信頼度取得
// ─────────────────────────────────────────────────────
function getWorkerReliability(opState, worker) {
  const state = opState.loadState();
  const rel   = state.reliability?.[worker] || {
    successCount:       0,
    failureCount:       0,
    consecutiveSuccess: 0,
    autoSendEnabled:    false,
    lastSuccess:        null,
    lastFailure:        null,
    lastAutoSendResult: null,
  };
  return rel;
}

// ─────────────────────────────────────────────────────
// recordSuccess(opState, worker) — 成功を記録
// 3回連続で allowlist worker なら auto-send 解禁
// ─────────────────────────────────────────────────────
function recordSuccess(opState, worker) {
  const state = opState.loadState();
  if (!state.reliability) state.reliability = {};
  const rel = state.reliability[worker] || {
    successCount: 0, failureCount: 0, consecutiveSuccess: 0,
    autoSendEnabled: false, lastSuccess: null, lastFailure: null,
  };

  rel.successCount++;
  rel.consecutiveSuccess++;
  rel.lastSuccess = new Date().toISOString();

  // allowlist + 3回連続成功 → auto-send 解禁
  const wasEnabled = rel.autoSendEnabled;
  if (AUTOSEND_ALLOWLIST.has(worker) && rel.consecutiveSuccess >= REQUIRED_CONSECUTIVE) {
    rel.autoSendEnabled = true;
  }
  const justUnlocked = !wasEnabled && rel.autoSendEnabled;

  state.reliability[worker] = rel;
  opState.saveState(state);
  return { rel, justUnlocked };
}

// ─────────────────────────────────────────────────────
// recordFailure(opState, worker, reason) — 失敗を記録
// clipboard モードへ自動降格（consecutiveSuccess リセット）
// ─────────────────────────────────────────────────────
function recordFailure(opState, worker, reason = '') {
  const state = opState.loadState();
  if (!state.reliability) state.reliability = {};
  const rel = state.reliability[worker] || {
    successCount: 0, failureCount: 0, consecutiveSuccess: 0,
    autoSendEnabled: false, lastSuccess: null, lastFailure: null,
  };

  const wasAutoSendEnabled = rel.autoSendEnabled;

  rel.failureCount++;
  rel.consecutiveSuccess = 0;       // 連続成功リセット
  rel.autoSendEnabled    = false;   // clipboard モードへ降格
  rel.lastFailure        = new Date().toISOString();
  rel.lastFailureReason  = String(reason).slice(0, 200);

  state.reliability[worker] = rel;
  opState.saveState(state);

  return {
    rel,
    wasAutoSendEnabled,
    downgraded: wasAutoSendEnabled, // true なら降格が発生した
  };
}

// ─────────────────────────────────────────────────────
// shouldAutoSend(opState, worker) — この worker を auto-send すべきか
// ─────────────────────────────────────────────────────
function shouldAutoSend(opState, worker) {
  const mode = getMode(opState);
  if (mode !== MODES.AUTOSEND_LIMITED) return false;
  if (!AUTOSEND_ALLOWLIST.has(worker)) return false;
  const rel = getWorkerReliability(opState, worker);
  return rel.autoSendEnabled === true;
}

// ─────────────────────────────────────────────────────
// formatReliabilityReport(opState) — !operator reliability 表示
// ─────────────────────────────────────────────────────
function formatReliabilityReport(opState) {
  const state = opState.loadState();
  const mode  = getMode(opState);
  const now   = new Date().toLocaleString('ja-JP');

  const modeEmoji = { clipboard: '📋', 'autosend-limited': '🤖', paused: '⏸️' };
  const lines = [
    `📊 **Desktop Operator Reliability**`,
    `現在モード: ${modeEmoji[mode] || '❓'} ${mode}`,
    `確認時刻: ${now}`,
    ``,
    `**auto-send allowlist: ${[...AUTOSEND_ALLOWLIST].join(' / ')}**`,
    `(${REQUIRED_CONSECUTIVE}回連続成功で auto-send 解禁)`,
    ``,
  ];

  const { WORKER_DISPLAY } = require('./inbox-bridge');

  for (const worker of [...AUTOSEND_ALLOWLIST]) {
    const rel  = state.reliability?.[worker] || {};
    const disp = WORKER_DISPLAY?.[worker] || worker;
    const consecutive = rel.consecutiveSuccess || 0;
    const autoEnabled = !!rel.autoSendEnabled;
    const progress    = `${consecutive}/${REQUIRED_CONSECUTIVE}`;
    const statusEmoji = autoEnabled ? '✅ auto-send OK' : (consecutive > 0 ? `📈 ${progress}` : '📋 clipboard');

    lines.push(`**${disp}**`);
    lines.push(`  送信許可: ${statusEmoji}`);
    lines.push(`  成功: ${rel.successCount || 0}件 / 失敗: ${rel.failureCount || 0}件 / 連続成功: ${consecutive}`);
    if (rel.lastSuccess)  lines.push(`  最終成功: ${new Date(rel.lastSuccess).toLocaleString('ja-JP')}`);
    if (rel.lastFailure)  lines.push(`  最終失敗: ${new Date(rel.lastFailure).toLocaleString('ja-JP')}`);
    if (rel.lastFailureReason) lines.push(`  失敗理由: ${rel.lastFailureReason.slice(0, 60)}`);
    lines.push('');
  }

  // allowlist 外の worker のサマリー
  const others = Object.entries(state.reliability || {})
    .filter(([w]) => !AUTOSEND_ALLOWLIST.has(w));
  if (others.length > 0) {
    lines.push(`**その他 (clipboard のみ):**`);
    others.forEach(([w, r]) => {
      lines.push(`  ${WORKER_DISPLAY?.[w] || w}: 成功${r.successCount||0} / 失敗${r.failureCount||0}`);
    });
    lines.push('');
  }

  lines.push(`> モード変更: \`!operator mode <clipboard|autosend-limited|paused>\``);
  lines.push(`> 緊急停止: \`!operator pause\` (最優先)`);

  return { ok: true, text: lines.join('\n').trimEnd() };
}

module.exports = {
  AUTOSEND_ALLOWLIST,
  REQUIRED_CONSECUTIVE,
  MODES,
  getMode,
  setMode,
  getWorkerReliability,
  recordSuccess,
  recordFailure,
  shouldAutoSend,
  formatReliabilityReport,
};
