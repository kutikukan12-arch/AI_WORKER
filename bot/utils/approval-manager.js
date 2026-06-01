'use strict';

// =====================================================
// approval-manager.js - Approval（承認管理）システム
//
// 役割:
//   AIが危険操作の確認を要求したとき、承認されるまで
//   実行を保留する。自然文ではなく正式コマンドで制御。
//
// Approval 状態:
//   pending  → 承認待ち（!approve か !deny を待っている）
//   approved → 承認済み（実行してよい）
//   denied   → 却下（実行しない）
//   paused   → 一時停止（!resume で pending に戻る）
//
// コマンド:
//   !approve <taskId>  承認 → 実行開始
//   !deny <taskId>     却下 → 実行キャンセル
//   !pause <taskId>    一時停止（後で !resume できる）
//   !resume <taskId>   一時停止 → pending に戻す
//
// Approval 種別 (type):
//   'pre'  → 実行前承認（高危険度 !claude が対象）
//            !approve すると Claude Code が実行される
//   'post' → 実行後確認（AIレビュー却下推奨などが対象）
//            !approve は「確認済み」の記録のみ
//
// 禁止:
//   ・自然文での承認（必ず !approve / !deny を使う）
//   ・一般ユーザーからの実行（index.js 側でガード）
//
// 保存先: data/approvals.json
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT_DIR       = path.join(__dirname, '..', '..');
const DATA_DIR       = path.join(ROOT_DIR, 'data');
const APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');

// ─── Approval 状態定数 ───
const STATES = {
  PENDING:  'pending',
  APPROVED: 'approved',
  DENIED:   'denied',
  PAUSED:   'paused',
};

// ─── 状態絵文字 ───
const STATE_EMOJI = {
  pending:  '⏳',
  approved: '✅',
  denied:   '❌',
  paused:   '⏸️',
};

// ─────────────────────────────────────────────────────
// データ読み込み
// ─────────────────────────────────────────────────────
function load() {
  if (!fs.existsSync(APPROVALS_FILE)) return { approvals: [] };
  try {
    return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
  } catch {
    return { approvals: [] };
  }
}

// ─────────────────────────────────────────────────────
// データ保存
// ─────────────────────────────────────────────────────
function save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// Approval 作成
//
// 同じ taskId の Approval が既にある場合は作成しない（重複防止）。
//
// 引数:
//   taskId  - タスクID
//   options - { reason, danger, prompt, channelId, authorTag, type }
// ─────────────────────────────────────────────────────
function createApproval(taskId, options = {}) {
  const data = load();

  // 重複チェック
  if (data.approvals.some(a => a.taskId === taskId)) {
    logger.warn(`Approval 重複スキップ: ${taskId}`);
    return getApproval(taskId);
  }

  const {
    reason    = '承認が必要な操作です',
    danger    = '中',
    prompt    = '',
    projectId = 'default', // 元チャンネルの projectId（Bot再起動後の再実行時に使用）
    channelId = '',
    authorTag = '',
    type      = 'pre', // 'pre' | 'post'
  } = options;

  const now = new Date().toISOString();
  const approval = {
    taskId,
    state:      STATES.PENDING,
    type,
    reason:     reason.slice(0, 200),
    danger,
    prompt:     prompt.slice(0, 1000), // 再実行時に使えるよう長めに保存
    projectId,                          // 元プロジェクトID（継承用）
    channelId,
    authorTag,
    createdAt:  now,
    updatedAt:  now,
    resolvedBy: null,
    resolvedAt: null,
  };

  data.approvals.push(approval);
  save(data);
  logger.info(`Approval 作成: ${taskId} | 種別: ${type} | 危険度: ${danger}`);
  return approval;
}

// ─────────────────────────────────────────────────────
// HUMAN_CHECK 用: 必ず PENDING な Approval を保証する
//
// createApproval は重複時に既存（APPROVED/DENIED 等）をそのまま返すため、
// 過去に承認/却下済みの taskId では再 HUMAN_CHECK が承認不能になる（M-2）。
// この関数は:
//   - record が無ければ新規 PENDING で作成（createApproval）
//   - record があり PENDING 以外なら PENDING に戻し、理由等を最新化
//   - 既に PENDING ならそのまま返す
//
// 戻り値: 必ず state=PENDING の approval オブジェクト | null（失敗時）
// ─────────────────────────────────────────────────────
function ensurePending(taskId, options = {}) {
  const existing = getApproval(taskId);
  if (!existing) {
    return createApproval(taskId, options);
  }

  if (existing.state === STATES.PENDING) {
    return existing;
  }

  // PENDING 以外（APPROVED/DENIED/PAUSED）→ PENDING に再オープンし内容を最新化
  const data = load();
  const idx  = data.approvals.findIndex(a => a.taskId === taskId);
  if (idx === -1) return createApproval(taskId, options);

  const now = new Date().toISOString();
  const a   = data.approvals[idx];
  a.state      = STATES.PENDING;
  a.updatedAt  = now;
  a.resolvedBy = null;
  a.resolvedAt = null;
  // 新しい HUMAN_CHECK の文脈で上書き（指定があるもののみ）
  if (options.type      !== undefined) a.type      = options.type;
  if (options.reason    !== undefined) a.reason     = String(options.reason).slice(0, 200);
  if (options.danger    !== undefined) a.danger     = options.danger;
  if (options.prompt    !== undefined) a.prompt     = String(options.prompt).slice(0, 1000);
  if (options.projectId !== undefined) a.projectId  = options.projectId;
  if (options.channelId !== undefined) a.channelId  = options.channelId;

  save(data);
  logger.info(`Approval 再オープン（HUMAN_CHECK）: ${taskId} | ${existing.state} → PENDING`);
  return a;
}

// ─────────────────────────────────────────────────────
// 状態更新（内部共通処理）
// ─────────────────────────────────────────────────────
function updateState(taskId, newState, resolvedBy) {
  const data = load();
  const idx  = data.approvals.findIndex(a => a.taskId === taskId);

  if (idx === -1) {
    logger.warn(`Approval 未発見: ${taskId}`);
    return null;
  }

  const now = new Date().toISOString();
  data.approvals[idx].state     = newState;
  data.approvals[idx].updatedAt = now;

  if (resolvedBy) {
    data.approvals[idx].resolvedBy = resolvedBy;
    data.approvals[idx].resolvedAt = now;
  }

  save(data);
  logger.info(`Approval ${taskId} → ${newState}${resolvedBy ? ` (by: ${resolvedBy})` : ''}`);
  return data.approvals[idx];
}

// ─────────────────────────────────────────────────────
// 承認: pending → approved
// ─────────────────────────────────────────────────────
function approve(taskId, resolvedBy) {
  return updateState(taskId, STATES.APPROVED, resolvedBy);
}

// ─────────────────────────────────────────────────────
// 却下: * → denied
// ─────────────────────────────────────────────────────
function deny(taskId, resolvedBy) {
  return updateState(taskId, STATES.DENIED, resolvedBy);
}

// ─────────────────────────────────────────────────────
// 一時停止: pending → paused
// ─────────────────────────────────────────────────────
function pause(taskId, resolvedBy) {
  const approval = getApproval(taskId);
  if (!approval || approval.state !== STATES.PENDING) return null;
  return updateState(taskId, STATES.PAUSED, resolvedBy);
}

// ─────────────────────────────────────────────────────
// 再開: paused → pending
// ─────────────────────────────────────────────────────
function resume(taskId) {
  const approval = getApproval(taskId);
  if (!approval || approval.state !== STATES.PAUSED) return null;
  return updateState(taskId, STATES.PENDING);
}

// ─────────────────────────────────────────────────────
// 単一 Approval 取得
// ─────────────────────────────────────────────────────
function getApproval(taskId) {
  const { approvals } = load();
  return approvals.find(a => a.taskId === taskId) || null;
}

// ─────────────────────────────────────────────────────
// pending 一覧
// ─────────────────────────────────────────────────────
function listPending() {
  const { approvals } = load();
  return approvals.filter(a => a.state === STATES.PENDING);
}

// ─────────────────────────────────────────────────────
// paused 一覧
// ─────────────────────────────────────────────────────
function listPaused() {
  const { approvals } = load();
  return approvals.filter(a => a.state === STATES.PAUSED);
}

// ─────────────────────────────────────────────────────
// Discord 表示用フォーマット（1件）
// ─────────────────────────────────────────────────────
function formatApproval(approval) {
  if (!approval) return '（Approval が見つかりません）';

  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[approval.danger] || '⬜';
  const stateEmoji  = STATE_EMOJI[approval.state] || '❓';
  const createdAt   = new Date(approval.createdAt).toLocaleString('ja-JP');

  const lines = [
    `【確認待ち】 \`${approval.taskId}\``,
    `危険度: ${dangerEmoji} ${approval.danger} | 状態: ${stateEmoji} ${approval.state}`,
    `内容: ${approval.reason}`,
    `依頼者: ${approval.authorTag} | ${createdAt}`,
  ];

  if (approval.prompt) {
    const preview = approval.prompt.slice(0, 80);
    lines.push(`指示: ${preview}${approval.prompt.length > 80 ? '…' : ''}`);
  }

  // 状態ごとに操作コマンドを表示
  if (approval.state === STATES.PENDING) {
    lines.push('');
    lines.push(`✅ 承認: \`!approve ${approval.taskId}\``);
    lines.push(`❌ 却下: \`!deny ${approval.taskId}\``);
    lines.push(`⏸️ 一時停止: \`!pause ${approval.taskId}\``);
  } else if (approval.state === STATES.PAUSED) {
    lines.push('');
    lines.push(`▶️ 再開: \`!resume ${approval.taskId}\``);
    lines.push(`❌ 却下: \`!deny ${approval.taskId}\``);
  } else if (approval.state === STATES.APPROVED) {
    lines.push(`✅ 承認者: ${approval.resolvedBy} | ${new Date(approval.resolvedAt).toLocaleString('ja-JP')}`);
  } else if (approval.state === STATES.DENIED) {
    lines.push(`❌ 却下者: ${approval.resolvedBy} | ${new Date(approval.resolvedAt).toLocaleString('ja-JP')}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// pending 一覧を Discord 用テキストに整形
// ─────────────────────────────────────────────────────
function formatPendingList() {
  const pending = listPending();
  const paused  = listPaused();

  if (pending.length === 0 && paused.length === 0) {
    return '✅ 承認待ち / 一時停止中のタスクはありません。';
  }

  const lines = [];

  if (pending.length > 0) {
    lines.push(`📋 **承認待ち: ${pending.length}件**`);
    for (const a of pending.slice(0, 5)) {
      const d = { '高': '🔴', '中': '🟡', '低': '🟢' }[a.danger] || '⬜';
      lines.push(`${d} \`${a.taskId}\` — ${a.reason.slice(0, 50)}`);
      lines.push(`　→ \`!approve ${a.taskId}\` / \`!deny ${a.taskId}\``);
    }
    if (pending.length > 5) lines.push(`　…ほか ${pending.length - 5} 件`);
  }

  if (paused.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`⏸️ **一時停止中: ${paused.length}件**`);
    for (const a of paused.slice(0, 3)) {
      lines.push(`\`${a.taskId}\` — ${a.reason.slice(0, 50)}`);
      lines.push(`　→ \`!resume ${a.taskId}\` / \`!deny ${a.taskId}\``);
    }
  }

  return lines.join('\n');
}

module.exports = {
  STATES,
  STATE_EMOJI,
  createApproval,
  ensurePending,
  approve,
  deny,
  pause,
  resume,
  getApproval,
  listPending,
  listPaused,
  formatApproval,
  formatPendingList,
};
