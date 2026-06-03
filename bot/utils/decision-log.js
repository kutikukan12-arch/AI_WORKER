'use strict';
// =====================================================
// decision-log.js — Decision Log Manager
//
// 共通エンベロープ仕様 (docs/envelope-spec.md) に基づく
// 意思決定の記録・参照。
//
// type: DECISION
// ID prefix: dec_<timestamp>
//
// 設計原則:
//   - 既存 task/review/commit をコピー保存しない
//   - refs 参照方式（task_xxx / commit:hash 等）
//   - 保存前に redact でマスク
//
// コマンド:
//   !decision log <title>               — 意思決定を記録
//   !decision log <title> | <summary>   — タイトル+サマリーで記録
//   !decision log ... refs:id1,id2      — refs 付きで記録
//   !decision log ... tags:tag1,tag2    — tags 付きで記録
//   !decision list                      — 最近10件を一覧
//   !decision show <id>                 — 詳細表示
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR       = path.join(__dirname, '..', '..', 'data');
const DECISIONS_FILE = path.join(DATA_DIR, 'decisions.json');

const SEVERITY_EMOJI = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };
const VALID_SEVERITY = Object.keys(SEVERITY_EMOJI);

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(DECISIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf8'));
  } catch { return []; }
}

function _save(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DECISIONS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, DECISIONS_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// 共通エンベロープ生成
// ─────────────────────────────────────────────────────
function _buildEnvelope({ title, summary, projectId, severity, refs, tags, data }) {
  return {
    id:        `dec_${Date.now()}`,
    type:      'DECISION',
    createdAt: new Date().toISOString(),
    projectId: String(projectId || 'default'),
    severity:  VALID_SEVERITY.includes(severity) ? severity : 'MEDIUM',
    title:     String(title).slice(0, 200),
    summary:   String(summary || '').slice(0, 500),
    refs:      Array.isArray(refs) ? refs.filter(Boolean) : [],
    tags:      Array.isArray(tags) ? tags.filter(Boolean) : [],
    status:    'DECIDED',
    data:      data && typeof data === 'object' ? data : {},
  };
}

// ─────────────────────────────────────────────────────
// コマンドライン解析ヘルパー
//
// 入力例:
//   "Secret Guardian の修正方針"
//   "Secret Guardian の修正方針 | process.env を精密除外"
//   "修正方針 | サマリー refs:task_xxx,commit:abc tags:security,bug"
//
// 戻り値: { title, summary, refs, tags }
// ─────────────────────────────────────────────────────
function _parseLogArgs(raw) {
  let rest = raw.trim();

  // refs: / tags: を末尾から抽出（存在しなくても OK）
  const refsMatch = rest.match(/\brefs:([\w_:.,\-]+)/i);
  const tagsMatch = rest.match(/\btags:([\w_.,\-]+)/i);

  const refs = refsMatch ? refsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  const tags = tagsMatch ? tagsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];

  // refs: / tags: を本文から除去
  rest = rest.replace(/\brefs:[\w_:.,\-]+/i, '').replace(/\btags:[\w_.,\-]+/i, '').trim();

  // | でタイトルとサマリーを分割
  const sepIdx = rest.indexOf(' | ');
  let title   = '';
  let summary = '';
  if (sepIdx >= 0) {
    title   = rest.slice(0, sepIdx).trim();
    summary = rest.slice(sepIdx + 3).trim();
  } else {
    title = rest;
  }

  return { title, summary, refs, tags };
}

// ─────────────────────────────────────────────────────
// logDecision(opts) — 意思決定を記録
//
// opts: { title, summary, projectId, severity, refs, tags, data }
// 戻り値: { ok, id?, text }
// ─────────────────────────────────────────────────────
function logDecision(opts) {
  if (!opts || !String(opts.title || '').trim()) {
    return {
      ok:   false,
      text: '❌ タイトルは必須です。\n\n' +
            '**使い方**\n```\n' +
            '!decision log <タイトル>\n' +
            '!decision log <タイトル> | <サマリー>\n' +
            '!decision log <タイトル> | <サマリー> refs:task_xxx tags:security\n' +
            '```',
    };
  }

  // タイトル・サマリーに redact 適用（秘密情報・PII を保存しない）
  const safeTitle   = redact(String(opts.title).trim()).slice(0, 200);
  const safeSummary = redact(String(opts.summary || '').trim()).slice(0, 500);

  const rec  = _buildEnvelope({ ...opts, title: safeTitle, summary: safeSummary });
  const list = _load();
  list.push(rec);
  _save(list);

  const sev  = SEVERITY_EMOJI[rec.severity] || '⚪';
  const lines = [
    `📋 **意思決定を記録しました**`,
    ``,
    `ID: \`${rec.id}\``,
    `タイトル: ${rec.title}`,
  ];
  if (rec.summary)       lines.push(`サマリー: ${rec.summary}`);
  lines.push(`重要度: ${sev} ${rec.severity} | 状態: ${rec.status}`);
  if (rec.refs.length)   lines.push(`refs: ${rec.refs.join(', ')}`);
  if (rec.tags.length)   lines.push(`tags: ${rec.tags.join(', ')}`);
  lines.push(``, `> \`!decision show ${rec.id}\` で詳細確認できます。`);

  return { ok: true, id: rec.id, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// listDecisions(limit) — 最近の意思決定一覧
//
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function listDecisions(limit = 10) {
  const list = _load();
  if (list.length === 0) {
    return {
      ok:   true,
      text: '📋 記録された意思決定はありません。\n`!decision log <タイトル>` で記録できます。',
    };
  }

  const recent = [...list].reverse().slice(0, limit);
  const lines  = [`📋 **意思決定ログ** (直近 ${recent.length} 件 / 合計 ${list.length} 件)`, ``];

  for (const d of recent) {
    const date = new Date(d.createdAt).toLocaleDateString('ja-JP');
    const sev  = SEVERITY_EMOJI[d.severity] || '⚪';
    lines.push(`${sev} \`${d.id}\``);
    lines.push(`   ${d.title}`);
    const meta = [date, d.status];
    if (d.tags.length) meta.push(d.tags.join(','));
    lines.push(`   ${meta.join(' | ')}`);
    if (d.refs.length) lines.push(`   refs: ${d.refs.join(', ')}`);
    lines.push('');
  }

  return { ok: true, text: lines.join('\n').trimEnd() };
}

// ─────────────────────────────────────────────────────
// showDecision(id) — 意思決定の詳細表示
//
// ID は完全一致または末尾部分一致（短縮形対応）
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function showDecision(id) {
  if (!id || !String(id).trim()) {
    return {
      ok:   false,
      text: '使い方: `!decision show <ID>`\n\nIDは `!decision list` で確認できます。',
    };
  }
  const target = String(id).trim();
  const list   = _load();
  const rec    = list.find(d => d.id === target || d.id.endsWith(target));

  if (!rec) {
    return {
      ok:   false,
      text: `❌ \`${target}\` が見つかりません。\n\`!decision list\` で確認してください。`,
    };
  }

  const sev   = SEVERITY_EMOJI[rec.severity] || '⚪';
  const date  = new Date(rec.createdAt).toLocaleString('ja-JP');
  const lines = [
    `📋 **意思決定 詳細**`,
    ``,
    `**ID:** \`${rec.id}\``,
    `**Type:** ${rec.type}`,
    `**Created:** ${date}`,
    `**Project:** ${rec.projectId}`,
    `**Severity:** ${sev} ${rec.severity}`,
    `**Status:** ${rec.status}`,
    ``,
    `**Title:** ${rec.title}`,
  ];
  if (rec.summary)     lines.push(`**Summary:** ${rec.summary}`);
  if (rec.refs.length) lines.push(`**Refs:** ${rec.refs.join(', ')}`);
  if (rec.tags.length) lines.push(`**Tags:** ${rec.tags.join(', ')}`);

  // data フィールドが空でない場合のみ表示
  const dataKeys = Object.keys(rec.data || {});
  if (dataKeys.length > 0) {
    lines.push(``, `**Data:**`);
    for (const k of dataKeys) {
      const v = rec.data[k];
      if (Array.isArray(v) && v.length > 0) {
        lines.push(`  ${k}: ${v.join(', ')}`);
      } else if (v) {
        lines.push(`  ${k}: ${v}`);
      }
    }
  }

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// module.exports
// ─────────────────────────────────────────────────────
module.exports = {
  logDecision,
  listDecisions,
  showDecision,
  parseLogArgs: _parseLogArgs,
  // テスト用内部 API
  _load,
  _save,
  _buildEnvelope,
};
