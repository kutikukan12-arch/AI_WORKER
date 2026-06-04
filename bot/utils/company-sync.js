'use strict';
// =====================================================
// company-sync.js — Company Memory Sync
//
// 目的:
//   会社ルール・Decision・Context変更後、AI社員が
//   古い認識のまま動く問題を防止する。
//
// 動作:
//   1. COMPANY_CONTEXT / active Decision / company-rules / LESSONS を収集
//   2. コンテンツハッシュでバージョンを生成
//   3. 全社員の inbox へ「会社情報更新通知」を配送
//   4. sync-history.json に記録
//
// 禁止:
//   ❌ 自動判断・自動承認・task変更
//   ❌ eval / exec
//   ❌ secret / token の露出
// =====================================================

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const DOCS_DIR    = path.join(__dirname, '..', '..', 'docs');
const HISTORY_FILE= path.join(DATA_DIR, 'sync-history.json');

// 社員とその役割キーワード（差分通知のフィルタ用）
const WORKER_ROLES = {
  miyagi:    { display: '🅰️ 宮城 Lead Engineer',    keywords: ['実装', '修正', '技術', 'security', 'L-16', 'Guardian'] },
  moriya:    { display: '🅱️ 守谷 CTO',              keywords: ['READY', 'NEED_FIX', 'security', '品質', '技術', 'Guardian'] },
  shiraishi: { display: '🅲 白石 COO',              keywords: ['優先順位', '運用', 'リソース', 'workflow'] },
  aizawa:    { display: '🅳 相沢 CS',               keywords: ['ユーザー', 'feedback', 'β'] },
  ichikawa:  { display: '🅴 市川 PM',               keywords: ['MVP', '商品', '要件', 'product'] },
  kanemori:  { display: '🅵 金森 CFO',              keywords: ['コスト', 'ROI', '課金', 'finance'] },
  kurokawa:  { display: '🅶 黒川 Chief of Staff',   keywords: ['workflow', '配送', '黒川', 'handoff', 'inbox'] },
  ikuno:     { display: '🅷 育野 Learning Manager', keywords: ['Decision', 'Lesson', 'Incident', '学習', 'learning'] },
  kanzaki:   { display: '🅸 神崎 VP',               keywords: ['方針', 'ロードマップ', '判断', 'VP', 'strategy'] },
};

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return { syncs: [] };
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { return { syncs: [] }; }
}

function _saveHistory(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = HISTORY_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// コンテンツ収集（redact 済み）
// ─────────────────────────────────────────────────────
function _collectSources() {
  const sources = {};

  // COMPANY_CONTEXT
  try {
    const ctxPath = path.join(DOCS_DIR, 'COMPANY_CONTEXT.md');
    if (fs.existsSync(ctxPath)) {
      const raw = fs.readFileSync(ctxPath, 'utf8');
      sources.context = redact(raw).slice(0, 2000);
    }
  } catch { sources.context = '（取得失敗）'; }

  // company-rules
  try {
    const rulesPath = path.join(DOCS_DIR, 'company-rules.md');
    if (fs.existsSync(rulesPath)) {
      const raw = fs.readFileSync(rulesPath, 'utf8');
      sources.rules = redact(raw).slice(0, 1500);
    }
  } catch { sources.rules = '（取得失敗）'; }

  // active Decisions（タイトル + severity のみ）
  try {
    const dl   = require('./decision-log');
    const list = dl.listActiveDecisions(10);
    sources.decisions = list.map(d =>
      `• [${d.severity}] ${redact(d.title).slice(0, 80)}`
    ).join('\n') || '（Decision なし）';
    sources.decisionCount = list.length;
  } catch {
    sources.decisions     = '（取得失敗）';
    sources.decisionCount = 0;
  }

  // LESSONS（先頭2000文字）
  try {
    const lessonsPath = path.join(__dirname, '..', '..', 'LESSONS.md');
    if (fs.existsSync(lessonsPath)) {
      const raw = fs.readFileSync(lessonsPath, 'utf8');
      sources.lessons = redact(raw).slice(0, 1000);
    } else {
      sources.lessons = '（LESSONS.md なし）';
    }
  } catch { sources.lessons = '（取得失敗）'; }

  return sources;
}

// ─────────────────────────────────────────────────────
// バージョンハッシュ生成
// ─────────────────────────────────────────────────────
function _generateVersion(sources) {
  const combined = [
    sources.context || '',
    sources.rules   || '',
    sources.decisions || '',
  ].join('\n---\n');
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 12);
}

// ─────────────────────────────────────────────────────
// 社員別の関連セクション抽出
// ─────────────────────────────────────────────────────
function _extractRelevantSections(sources, worker) {
  const role    = WORKER_ROLES[worker] || { keywords: [] };
  const text    = `${sources.context || ''}\n${sources.rules || ''}`;
  const lines   = text.split('\n');
  const relevant= [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (role.keywords.some(kw => line.includes(kw))) {
      // 前後1行も含める
      const start = Math.max(0, i - 1);
      const end   = Math.min(lines.length - 1, i + 2);
      relevant.push(lines.slice(start, end).join('\n'));
      i = end; // 重複追加防止
    }
  }

  return relevant.slice(0, 3).join('\n---\n').slice(0, 400) || '（変更なし）';
}

// ─────────────────────────────────────────────────────
// 社員別通知文生成
// ─────────────────────────────────────────────────────
function _buildWorkerMessage(worker, sources, version, relevantSections) {
  const role     = WORKER_ROLES[worker] || { display: worker, keywords: [] };
  const now      = new Date().toLocaleString('ja-JP');

  return [
    `【会社情報更新通知】`,
    `送信: 黒川 Chief of Staff (Company Memory Sync)`,
    `日時: ${now}`,
    `バージョン: v${version}`,
    ``,
    `━━━━━ 更新内容 ━━━━━`,
    ``,
    `■ 有効 Decision 数: ${sources.decisionCount}件`,
    `最新 Decision:`,
    sources.decisions.split('\n').slice(0, 3).join('\n'),
    ``,
    `■ あなた(${role.display.replace(/🅰️|🅱️|🅲|🅳|🅴|🅵|🅶|🅷|🅸/g, '').trim()})に関連する変更:`,
    relevantSections,
    ``,
    `━━━━━ 注意事項 ━━━━━`,
    `・このメッセージは情報共有のみです。承認・判断は不要です。`,
    `・詳細: !company context / !decision list で確認できます。`,
    `・不明点は社長または神崎 VP へ確認してください。`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// runSync(opts?) — 全社員への同期を実行
//
// 戻り値: { ok, version, notifiedWorkers, skippedWorkers, text }
// ─────────────────────────────────────────────────────
function runSync(opts = {}) {
  const sources   = _collectSources();
  const version   = _generateVersion(sources);
  const history   = _loadHistory();
  const ib        = require('./inbox-bridge');

  // 前回バージョンと比較
  const lastSync  = history.syncs.slice(-1)[0];
  const isNew     = !lastSync || lastSync.version !== version;
  const forceSync = !!opts.force;

  if (!isNew && !forceSync) {
    return {
      ok:       true,
      version,
      upToDate: true,
      text:     `✅ 全社員は最新バージョン (v${version}) を既に受信済みです。\n\`!company sync --force\` で強制再送できます。`,
    };
  }

  // 全社員に送信
  const notified = [];
  const failed   = [];

  for (const worker of ib.VALID_WORKERS) {
    const relevant = _extractRelevantSections(sources, worker);
    const msg      = _buildWorkerMessage(worker, sources, version, relevant);
    const result   = ib.sendToWorker(worker, msg);
    if (result.ok) {
      notified.push(worker);
    } else {
      failed.push(worker);
    }
  }

  // sync-history.json に記録
  const syncRecord = {
    id:          `sync_${Date.now()}${Math.floor(Math.random()*0x100).toString(16).padStart(2,'0')}`,
    at:          new Date().toISOString(),
    version,
    notified,
    failed,
    decisionCount: sources.decisionCount,
    forced:      forceSync,
  };
  history.syncs = [...history.syncs, syncRecord].slice(-50);
  _saveHistory(history);

  const lines = [
    `🔄 **Company Memory Sync 完了**`,
    ``,
    `バージョン: \`v${version}\``,
    `通知済み: ${notified.length}名 (${notified.join(', ')})`,
    failed.length > 0 ? `失敗: ${failed.length}名 (${failed.join(', ')})` : '',
    ``,
    `通知内容:`,
    `• 有効 Decision: ${sources.decisionCount}件`,
    `• COMPANY_CONTEXT / company-rules / LESSONS の要約`,
    `• 社員別に関連セクションを抽出`,
    ``,
    `> 各社員の inbox を確認: \`!inbox check <社員名>\``,
    `> 履歴: sync-history.json に記録済み`,
    `⚠️ 自動判断・承認・タスク変更は行っていません。`,
  ].filter(l => l !== '');

  return {
    ok:             true,
    version,
    upToDate:       false,
    notifiedWorkers: notified,
    failedWorkers:   failed,
    syncId:         syncRecord.id,
    text:           lines.join('\n'),
  };
}

// ─────────────────────────────────────────────────────
// getSyncStatus() — sync 履歴確認
// ─────────────────────────────────────────────────────
function getSyncStatus() {
  const history = _loadHistory();
  const last    = history.syncs.slice(-1)[0];
  if (!last) {
    return { ok: true, text: '⚠️ まだ sync が実行されていません。\n`!company sync` で全社員に最新情報を配信してください。' };
  }
  return {
    ok:  true,
    last,
    text: [
      `📊 **Company Memory Sync 状況**`,
      ``,
      `最終 sync: ${new Date(last.at).toLocaleString('ja-JP')}`,
      `バージョン: \`v${last.version}\``,
      `通知済み: ${last.notified.length}名`,
      `Decision数: ${last.decisionCount}件`,
      `強制実行: ${last.forced ? 'はい' : 'いいえ'}`,
      ``,
      `合計 sync 回数: ${history.syncs.length}回`,
    ].join('\n'),
  };
}

module.exports = {
  runSync,
  getSyncStatus,
  HISTORY_FILE,
  WORKER_ROLES,
  // テスト用
  _loadHistory,
  _saveHistory,
  _collectSources,
  _generateVersion,
  _buildWorkerMessage,
  _extractRelevantSections,
};
