'use strict';
// =====================================================
// vp-export.js — External VP Export Bridge (Phase12)
//
// 目的:
//   AI_WORKER の現状を ChatGPT 外部相談役に共有するための
//   コンテキストファイルを生成する。
//   社長のコピペ負担を削減する。
//
// 担当分業:
//   黒川: 情報収集・ファイル生成
//   神崎: 論点整理セクション
//   育野: 重要 Decision の要約
//
// 禁止:
//   ❌ ChatGPT への自動送信
//   ❌ 外部 API 呼び出し
//   ❌ 判断の生成（提案のみ）
//   ❌ eval / exec
//
// セーフガード:
//   ✅ redact() を全テキストに適用
//   ✅ secret / token を除外
//   ✅ 内部ログ全文禁止（要約のみ）
//   ✅ 1セクション最大400文字・全体最大4000文字
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const OUTBOX_DIR   = path.join(DATA_DIR, 'outbox', 'external-vp');
const EXPORT_FILE  = path.join(OUTBOX_DIR, 'context.md');

// 1セクション最大文字数（内部ログ全文防止）
const MAX_SECTION   = 400;
// 全体最大文字数
const MAX_TOTAL     = 4000;
// Decision の表示件数上限
const MAX_DECISIONS = 5;
// Incident の表示件数上限
const MAX_INCIDENTS = 3;

// ─── セーフトランケート ───────────────────────────────
function _safe(text, maxLen = MAX_SECTION) {
  const s = redact(String(text || '')).trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…（省略）' : s;
}

// ─────────────────────────────────────────────────────
// 各セクションの収集
// ─────────────────────────────────────────────────────

// 1. 会社概要（COMPANY_CONTEXT から要約）
function _collectOverview() {
  try {
    const ctxMgr = require('./context-manager');
    const r      = ctxMgr.getContextSummary();
    return _safe(
      r.summary
        .replace(/\*\*/g, '')      // markdown bold を除去
        .replace(/`[^`]+`/g, ''), // inline code を除去
      300
    );
  } catch { return '（取得失敗）'; }
}

// 2. 最新 Decision（active のみ・最大5件・タイトルと重要度のみ）
function _collectDecisions() {
  try {
    const dl   = require('./decision-log');
    const list = dl.listActiveDecisions(MAX_DECISIONS);
    if (!list.length) return '（登録なし）';
    return list.slice(-MAX_DECISIONS).reverse()
      .map(d => `• [${d.severity}] ${_safe(d.title, 80)}`)
      .join('\n');
  } catch { return '（取得失敗）'; }
}

// 3. Worker Status（状態のみ・taskId なし）
function _collectWorkerStatus() {
  try {
    const wsm  = require('./worker-status');
    const data = wsm._load();
    const lines = [];
    for (const worker of wsm.VALID_WORKERS) {
      const ws      = data[worker] || {};
      const display = wsm.WORKER_DISPLAY[worker] || worker;
      const st      = ws.status || 'idle';
      lines.push(`• ${display}: ${st}`);
    }
    return lines.join('\n');
  } catch { return '（取得失敗）'; }
}

// 4. Workflow 状態（ハンドオフ件数・長待ち有無のみ）
function _collectWorkflowStatus() {
  try {
    const wstate = require('./workflow-state');
    const state  = wstate._load();
    const total  = state.handoffs.length;
    const waiting = wstate.detectWaiting();
    const autoN  = state.handoffs.filter(h => h.autoExecuted).length;
    return [
      `ハンドオフ総数: ${total}件`,
      `自動配送: ${autoN}件`,
      `長待ち: ${waiting.length}件${waiting.length > 0 ? ' ← 要確認' : ''}`,
    ].join('\n');
  } catch { return '（取得失敗）'; }
}

// 5. アクティブタスク（状態・件数のみ）
function _collectTaskStatus() {
  try {
    const tm    = require('./task-manager');
    const tasks = tm.listTasks();
    const counts = {};
    tasks.forEach(t => { counts[t.state] = (counts[t.state] || 0) + 1; });
    if (!tasks.length) return '（タスクなし）';
    return Object.entries(counts)
      .map(([s, n]) => `• ${s}: ${n}件`)
      .join('\n');
  } catch { return '（取得失敗）'; }
}

// 6. 最近の Incident（open のみ・要約）
function _collectIncidents() {
  try {
    const im      = require('./incident-manager');
    const list    = im._load();
    const openList = list
      .filter(i => im.STATUS.OPEN === i.status || im.STATUS.INVESTIGATING === i.status)
      .slice(-MAX_INCIDENTS);
    if (!openList.length) return '（未解決インシデントなし）';
    return openList.map(i =>
      `• [${i.severity}] ${_safe(i.title, 60)}`
    ).join('\n');
  } catch { return '（取得失敗）'; }
}

// 7. 神崎 VP 論点整理テンプレート（空欄をCEOが埋める）
function _buildKanzakiSection(topic) {
  return [
    `相談テーマ: ${_safe(topic || '（テーマ未設定）', 120)}`,
    ``,
    `【論点整理 — 神崎VP】`,
    `▸ 背景: `,
    `▸ 各AI社員の立場:`,
    `  - 宮城(技術): `,
    `  - 市川(PM): `,
    `  - 白石(COO): `,
    `  - 金森(CFO): `,
    `▸ メリット: `,
    `▸ リスク: `,
    `▸ 長期ロードマップへの影響: `,
    `▸ 社長への推奨判断軸: `,
    `（※ CEOが確認・修正してから ChatGPT へ共有してください）`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// buildExport(opts) — エクスポートファイルを生成
//
// opts: { topic? } — 相談テーマ（任意）
// 戻り値: { ok, filePath, text, charCount }
// ─────────────────────────────────────────────────────
function buildExport(opts = {}) {
  const now   = new Date().toLocaleString('ja-JP');
  const topic = _safe(opts.topic || '', 120);

  const sections = [
    `# AI_WORKER 外部相談コンテキスト`,
    `生成: ${now}`,
    `（このファイルは ChatGPT 外部相談役への共有用です）`,
    `（機密情報はマスク済み。社長が確認してから共有してください）`,
    ``,
    `---`,
    ``,
    `## 1. 会社概要`,
    _collectOverview(),
    ``,
    `## 2. 最新の意思決定（active Top${MAX_DECISIONS}）`,
    _collectDecisions(),
    ``,
    `## 3. AI社員 状態`,
    _collectWorkerStatus(),
    ``,
    `## 4. Workflow 状態`,
    _collectWorkflowStatus(),
    ``,
    `## 5. タスク状況`,
    _collectTaskStatus(),
    ``,
    `## 6. 未解決インシデント`,
    _collectIncidents(),
    ``,
    `## 7. 神崎VP 論点整理（CEOが加筆して使用）`,
    _buildKanzakiSection(topic),
    ``,
    `---`,
    `⚠️ 注意:`,
    `・このファイルは黒川が生成した情報収集のみです`,
    `・ChatGPT への送信は社長が確認後に手動で行ってください`,
    `・自動送信・API連携は禁止です`,
    `・内部システム詳細・ログ全文は含みません`,
  ];

  const fullText = sections.join('\n');

  // 全体サイズ制限
  const trimmed = fullText.length > MAX_TOTAL
    ? fullText.slice(0, MAX_TOTAL) + '\n\n…（全体サイズ制限により省略）'
    : fullText;

  // ファイル書き込み（atomic）
  if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const tmp = EXPORT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, trimmed, 'utf8');
    fs.renameSync(tmp, EXPORT_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  return {
    ok:        true,
    filePath:  EXPORT_FILE,
    text:      trimmed,
    charCount: trimmed.length,
  };
}

// ─────────────────────────────────────────────────────
// getExportStatus() — 現在の export ファイル状態
// ─────────────────────────────────────────────────────
function getExportStatus() {
  const exists = fs.existsSync(EXPORT_FILE);
  if (!exists) return { ok: true, exists: false, text: '（未生成）' };
  const stat  = fs.statSync(EXPORT_FILE);
  const mtime = stat.mtime.toLocaleString('ja-JP');
  return {
    ok:     true,
    exists: true,
    size:   stat.size,
    mtime,
    text:   `✅ あり (${stat.size} bytes / 最終更新: ${mtime})`,
  };
}

module.exports = {
  buildExport,
  getExportStatus,
  EXPORT_FILE,
  OUTBOX_DIR,
  MAX_SECTION,
  MAX_TOTAL,
  // テスト用
  _safe,
  _collectOverview,
  _collectDecisions,
  _collectWorkerStatus,
  _collectWorkflowStatus,
  _collectTaskStatus,
  _collectIncidents,
};
