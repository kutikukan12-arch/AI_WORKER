'use strict';
// =====================================================
// operator-reliability.js — Desktop Operator 信頼度管理
//
// 目的:
//   worker 別の配送成功/失敗を追跡し、
//   3回連続成功した worker だけ auto-send を許可する。
//   失敗時は consecutiveSuccess をリセット。
//
// Auto-send Allowlist:
//   ['moriya', 'miyagi', 'kanzaki'] のみが auto-send 候補。
//   他の worker は常に clipboard モード。
//
// Mode:
//   clipboard         — クリップボードのみ（デフォルト）
//   autosend-limited  — allowlist かつ 3回連続成功した worker のみ auto-send
//   paused            — 全停止（緊急停止と同義）
//
// 解禁条件 (autosend-limited):
//   clipboard配送 OR auto-send送信 を 3回連続成功 かつ 失敗0
//   → autoSendEnabled = true
//   → !operator mode autosend-limited 設定後に有効
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
// _defaultRel() — 信頼度データの初期値
// clipboard配送 / auto-send送信 / 返信取得 を独立カウンタで管理
// ─────────────────────────────────────────────────────
function _defaultRel() {
  return {
    // ── 解禁カウンタ ────────────────────────────────
    consecutiveSuccess: 0,       // 連続成功数 (clipboard + auto-send 両方でカウント)
    autoSendEnabled:    false,   // true = auto-send 解禁済み
    unlockReason:       null,    // 'clipboard_delivery' | 'auto_send'
    // ── 配送段階別カウンタ ─────────────────────────
    clipboardCount:     0,       // clipboard コピー成功件数
    autoSendCount:      0,       // Claude Desktop 自動送信成功件数
    replyCapturedCount: 0,       // 返信自動取得成功件数
    failureCount:       0,       // 全失敗件数
    // ── タイムスタンプ ──────────────────────────────
    lastClipboard:      null,
    lastAutoSend:       null,
    lastReplyCapture:   null,
    lastFailure:        null,
    lastFailureReason:  null,
  };
}

// ─────────────────────────────────────────────────────
// getWorkerReliability(opState, worker) — worker の信頼度取得
// ─────────────────────────────────────────────────────
function getWorkerReliability(opState, worker) {
  const state = opState.loadState();
  const raw   = state.reliability?.[worker] || {};
  const rel   = Object.assign(_defaultRel(), raw);
  // migration: 旧 successCount → autoSendCount
  if (raw.successCount !== undefined && rel.autoSendCount === 0) {
    rel.autoSendCount = raw.successCount;
  }
  return rel;
}

// ─────────────────────────────────────────────────────
// recordClipboardDelivery(opState, worker) — clipboard コピー成功を記録
//
// clipboard モードでの配送完了。
// consecutiveSuccess を増やし、3回で auto-send 解禁条件を満たす。
// ─────────────────────────────────────────────────────
function recordClipboardDelivery(opState, worker) {
  const state = opState.loadState();
  if (!state.reliability) state.reliability = {};
  const rel = Object.assign(_defaultRel(), state.reliability[worker] || {});

  rel.clipboardCount++;
  rel.consecutiveSuccess++;
  rel.lastClipboard = new Date().toISOString();

  // clipboard 3回連続成功 → auto-send 解禁
  const wasEnabled = rel.autoSendEnabled;
  if (AUTOSEND_ALLOWLIST.has(worker) && rel.consecutiveSuccess >= REQUIRED_CONSECUTIVE) {
    rel.autoSendEnabled = true;
    rel.unlockReason    = 'clipboard_delivery';
  }
  const justUnlocked = !wasEnabled && rel.autoSendEnabled;

  state.reliability[worker] = rel;
  opState.saveState(state);
  return { rel, justUnlocked };
}

// ─────────────────────────────────────────────────────
// recordSuccess(opState, worker) — auto-send 成功を記録
// consecutiveSuccess を増やし、3回で auto-send 解禁
// ─────────────────────────────────────────────────────
function recordSuccess(opState, worker) {
  const state = opState.loadState();
  if (!state.reliability) state.reliability = {};
  const rel = Object.assign(_defaultRel(), state.reliability[worker] || {});

  rel.autoSendCount++;
  rel.consecutiveSuccess++;
  rel.lastAutoSend = new Date().toISOString();

  // 3回連続成功 → auto-send 解禁
  const wasEnabled = rel.autoSendEnabled;
  if (AUTOSEND_ALLOWLIST.has(worker) && rel.consecutiveSuccess >= REQUIRED_CONSECUTIVE) {
    rel.autoSendEnabled = true;
    rel.unlockReason    = 'auto_send';
  }
  const justUnlocked = !wasEnabled && rel.autoSendEnabled;

  state.reliability[worker] = rel;
  opState.saveState(state);
  return { rel, justUnlocked };
}

// ─────────────────────────────────────────────────────
// recordReplyCapture(opState, worker) — 返信自動取得成功を記録
// ─────────────────────────────────────────────────────
function recordReplyCapture(opState, worker) {
  const state = opState.loadState();
  if (!state.reliability) state.reliability = {};
  const rel = Object.assign(_defaultRel(), state.reliability[worker] || {});

  rel.replyCapturedCount++;
  rel.lastReplyCapture = new Date().toISOString();

  state.reliability[worker] = rel;
  opState.saveState(state);
  return { rel };
}

// ─────────────────────────────────────────────────────
// recordFailure(opState, worker, reason) — 失敗を記録
// clipboard モードへ自動降格（consecutiveSuccess リセット）
// ─────────────────────────────────────────────────────
function recordFailure(opState, worker, reason = '') {
  const state = opState.loadState();
  if (!state.reliability) state.reliability = {};
  const rel = Object.assign(_defaultRel(), state.reliability[worker] || {});

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
    `解禁条件: clipboard配送 OR auto-send 送信 を **${REQUIRED_CONSECUTIVE}回連続成功** (失敗で連続リセット)`,
    `有効化: 解禁後に \`!operator mode autosend-limited\` を実行`,
    ``,
  ];

  const { WORKER_DISPLAY } = require('./inbox-bridge');

  for (const worker of [...AUTOSEND_ALLOWLIST]) {
    const rel  = Object.assign(_defaultRel(), state.reliability?.[worker] || {});
    const disp = WORKER_DISPLAY?.[worker] || worker;
    const consecutive = rel.consecutiveSuccess || 0;
    const autoEnabled = !!rel.autoSendEnabled;

    // auto-send 解禁状態バッジ
    const totalDelivery = rel.clipboardCount + rel.autoSendCount;
    let statusBadge;
    if (autoEnabled) {
      const by = rel.unlockReason === 'clipboard_delivery' ? 'clipboard配送で' : 'auto-sendで';
      statusBadge = `✅ auto-send 解禁済 (${by}解禁)`;
    } else if (consecutive > 0) {
      statusBadge = `📈 解禁まで残り ${REQUIRED_CONSECUTIVE - consecutive} 回 (連続${consecutive}/${REQUIRED_CONSECUTIVE})`;
    } else if (totalDelivery > 0) {
      statusBadge = `📋 配送実績あり (失敗でリセット済)`;
    } else {
      statusBadge = `📋 clipboard 待機中 (配送実績なし)`;
    }

    lines.push(`**${disp}**  ${statusBadge}`);

    // 3段階配送ステータス
    lines.push(`  📋 clipboard配送: ${rel.clipboardCount}件` +
      (rel.lastClipboard ? `  (最終: ${new Date(rel.lastClipboard).toLocaleTimeString('ja-JP')})` : ''));
    lines.push(`  🤖 auto-send送信:  ${rel.autoSendCount}件` +
      (rel.lastAutoSend  ? `  (最終: ${new Date(rel.lastAutoSend).toLocaleTimeString('ja-JP')})` : ''));
    lines.push(`  📥 返信自動取得:  ${rel.replyCapturedCount}件` +
      (rel.lastReplyCapture ? `  (最終: ${new Date(rel.lastReplyCapture).toLocaleTimeString('ja-JP')})` : ''));
    lines.push(`  ❌ 失敗:          ${rel.failureCount}件` +
      (rel.lastFailureReason ? `  (${rel.lastFailureReason.slice(0, 50)})` : ''));

    // clipboard モード時の次アクション案内
    if (mode === MODES.CLIPBOARD && rel.clipboardCount > 0 && rel.autoSendCount === 0) {
      lines.push(`  ▶ 次の手順: Claude Desktop で **Ctrl+V → Enter** → 返信後 Ctrl+C`);
    }

    lines.push('');
  }

  // allowlist 外の worker のサマリー
  const others = Object.entries(state.reliability || {})
    .filter(([w]) => !AUTOSEND_ALLOWLIST.has(w));
  if (others.length > 0) {
    lines.push(`**その他 (clipboard のみ):**`);
    others.forEach(([w, r]) => {
      const cb = r.clipboardCount || r.successCount || 0; // migration対応
      lines.push(`  ${WORKER_DISPLAY?.[w] || w}: clipboard${cb} / 失敗${r.failureCount||0}`);
    });
    lines.push('');
  }

  // 直近の blocked 分類を表示（診断用）
  const hist = opState.loadHistory ? opState.loadHistory() : [];
  const recentBlocked = hist.filter(h => h.blockedReason).slice(-5);
  if (recentBlocked.length > 0) {
    lines.push(`**直近ブロック (${recentBlocked.length}件):**`);
    const reasonGroups = {};
    recentBlocked.forEach(h => {
      const cat = h.blockedReason.startsWith('handoff_record_not_found') ? '⚠️ 未承認配送'
                : h.blockedReason.startsWith('risk_blocked')             ? '🚫 リスク検知'
                : h.blockedReason.startsWith('event_not_allowed')        ? '❌ allowlist外'
                : h.blockedReason.startsWith('blocked_keyword')          ? '🔴 NG キーワード'
                : h.blockedReason.startsWith('send_failed')              ? '⚡ 送信失敗'
                : '❓ その他';
      const key = `[${h.worker || '?'}] ${cat}`;
      reasonGroups[key] = (reasonGroups[key] || 0) + 1;
    });
    Object.entries(reasonGroups).forEach(([k, n]) => lines.push(`  ${k}: ${n}件`));
    lines.push(`  → !workflow handoff 経由で送信してください`);
    lines.push('');
  }

  lines.push(`> モード変更: \`!operator mode <clipboard|autosend-limited|paused>\``);
  lines.push(`> 緊急停止: \`!operator pause\` (最優先)`);
  lines.push(`> E2Eテスト: \`!workflow handoff VP_BRIEF_REQUEST ceo e2e_test 神崎さんへ\``);

  return { ok: true, text: lines.join('\n').trimEnd() };
}

module.exports = {
  AUTOSEND_ALLOWLIST,
  REQUIRED_CONSECUTIVE,
  MODES,
  getMode,
  setMode,
  getWorkerReliability,
  recordClipboardDelivery,
  recordSuccess,
  recordReplyCapture,
  recordFailure,
  shouldAutoSend,
  formatReliabilityReport,
};
