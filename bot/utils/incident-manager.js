'use strict';
// =====================================================
// incident-manager.js — Incident Manager MVP
//
// 共通エンベロープ仕様 (docs/envelope-spec.md) に基づく
// 障害・ヒヤリハットの起票→追跡→解決→教訓化。
//
// type: INCIDENT
// ID prefix: inc_<timestamp>
//
// 設計原則:
//   - error-alert / review-history との二重通知なし
//     （既存の sendNotification フローを変更しない）
//   - 既存 error 検知ロジックを新規実装しない
//   - refs 参照方式（task/review/commit/decision をコピー保存しない）
//   - 保存前に redact/maskSecret を適用
//   - resolve 時は lesson 化候補を提示（自動 LESSONS 追記はしない）
//
// コマンド:
//   !incident open <要約>                  — インシデントを起票
//   !incident open <要約> | <詳細>         — 要約+詳細で起票
//   !incident open ... refs:id1 tags:sec   — refs/tags 付き起票
//   !incident list                         — 未解決一覧（デフォルト）
//   !incident list all                     — 全件一覧
//   !incident show <id>                    — 詳細表示
//   !incident resolve <id> <対応内容>      — 解決・教訓化候補を表示
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR        = path.join(__dirname, '..', '..', 'data');
const INCIDENTS_FILE  = path.join(DATA_DIR, 'incidents.json');

// ─── Envelope 定数 ────────────────────────────────────
const SEVERITY_EMOJI  = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };
const VALID_SEVERITY  = Object.keys(SEVERITY_EMOJI);

const STATUS = {
  OPEN:          'OPEN',
  INVESTIGATING: 'INVESTIGATING',
  MITIGATED:     'MITIGATED',
  RESOLVED:      'RESOLVED',
  CLOSED:        'CLOSED',
};
const STATUS_EMOJI = {
  OPEN:          '🔴',
  INVESTIGATING: '🔍',
  MITIGATED:     '🟡',
  RESOLVED:      '✅',
  CLOSED:        '📦',
};
const OPEN_STATUSES = [STATUS.OPEN, STATUS.INVESTIGATING, STATUS.MITIGATED];

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(INCIDENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8'));
  } catch { return []; }
}

function _save(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = INCIDENTS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, INCIDENTS_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// 共通エンベロープ生成 (docs/envelope-spec.md 準拠)
// ─────────────────────────────────────────────────────
function _buildEnvelope({ title, summary, projectId, severity, refs, tags, data }) {
  const now = new Date().toISOString();
  return {
    id:        `inc_${Date.now()}`,
    type:      'INCIDENT',
    createdAt: now,
    projectId: String(projectId || 'default'),
    severity:  VALID_SEVERITY.includes(severity) ? severity : 'MEDIUM',
    title:     String(title).slice(0, 200),
    summary:   String(summary || '').slice(0, 500),
    refs:      Array.isArray(refs) ? refs.filter(Boolean) : [],
    tags:      Array.isArray(tags) ? tags.filter(Boolean) : [],
    status:    STATUS.OPEN,
    data: {
      detectedAt:   now,
      resolvedAt:   null,
      affectedArea: [],
      rootCause:    '',
      mitigation:   '',
      prevention:   '',
      ...(data && typeof data === 'object' ? data : {}),
    },
  };
}

// ─────────────────────────────────────────────────────
// コマンドライン解析ヘルパー（decision-log と共通形式）
//
// 入力例:
//   "Secret Guardian が commit を誤ブロック"
//   "GitHubトークン期限切れ | push 失敗 refs:task_xxx tags:github"
// ─────────────────────────────────────────────────────
function _parseArgs(raw) {
  let rest = raw.trim();

  const refsMatch = rest.match(/\brefs:([\w_:.,\-]+)/i);
  const tagsMatch = rest.match(/\btags:([\w_.,\-]+)/i);

  const refs = refsMatch ? refsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  const tags = tagsMatch ? tagsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];

  rest = rest.replace(/\brefs:[\w_:.,\-]+/i, '').replace(/\btags:[\w_.,\-]+/i, '').trim();

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
// lesson 化候補テキスト生成
//
// resolve 時に LESSONS.md への追記候補を提示するが、
// 自動追記はしない（MVP では提案まで）。
// ─────────────────────────────────────────────────────
function _buildLessonCandidate(inc) {
  const lines = [
    `### 📖 Lesson 化候補`,
    ``,
    `> この内容を \`LESSONS.md\` に追記することを検討してください。`,
    ``,
    `**現象:** ${inc.title}`,
  ];
  if (inc.data.rootCause)  lines.push(`**根本原因:** ${inc.data.rootCause}`);
  if (inc.data.mitigation) lines.push(`**対応:** ${inc.data.mitigation}`);
  if (inc.data.prevention) lines.push(`**再発防止:** ${inc.data.prevention}`);
  lines.push('');
  lines.push('*自動追記はしません。内容を確認して手動で追加してください。*');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// openIncident(opts) — インシデントを起票
//
// opts: { title, summary, projectId, severity, refs, tags }
// 戻り値: { ok, id?, text }
// ─────────────────────────────────────────────────────
function openIncident(opts) {
  if (!opts || !String(opts.title || '').trim()) {
    return {
      ok:   false,
      text: '❌ 要約（タイトル）は必須です。\n\n' +
            '**使い方**\n```\n' +
            '!incident open <要約>\n' +
            '!incident open <要約> | <詳細>\n' +
            '!incident open <要約> | <詳細> refs:task_xxx tags:security\n' +
            '```',
    };
  }

  // 保存前に redact 適用（秘密情報・PII をマスク）
  const safeTitle   = redact(String(opts.title).trim()).slice(0, 200);
  const safeSummary = redact(String(opts.summary || '').trim()).slice(0, 500);

  const rec  = _buildEnvelope({ ...opts, title: safeTitle, summary: safeSummary });
  const list = _load();
  list.push(rec);
  _save(list);

  const sev  = SEVERITY_EMOJI[rec.severity] || '⚪';
  const st   = STATUS_EMOJI[rec.status] || '❓';
  const lines = [
    `🚨 **インシデント起票**`,
    ``,
    `ID: \`${rec.id}\``,
    `要約: ${rec.title}`,
  ];
  if (rec.summary)     lines.push(`詳細: ${rec.summary}`);
  lines.push(`重要度: ${sev} ${rec.severity} | 状態: ${st} ${rec.status}`);
  if (rec.refs.length) lines.push(`refs: ${rec.refs.join(', ')}`);
  if (rec.tags.length) lines.push(`tags: ${rec.tags.join(', ')}`);
  lines.push(``, `> \`!incident resolve ${rec.id} <対応内容>\` で解決済みにできます。`);

  return { ok: true, id: rec.id, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// listIncidents(opts) — インシデント一覧
//
// opts: { all: bool, limit: number }
// デフォルトは未解決 (OPEN / INVESTIGATING / MITIGATED) のみ表示
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function listIncidents({ all = false, limit = 20 } = {}) {
  const list = _load();
  const filtered = all
    ? [...list].reverse().slice(0, limit)
    : [...list].reverse().filter(i => OPEN_STATUSES.includes(i.status)).slice(0, limit);

  if (filtered.length === 0) {
    const msg = all
      ? '📋 記録されたインシデントはありません。\n`!incident open <要約>` で起票できます。'
      : '✅ 未解決のインシデントはありません。\n`!incident list all` で全件確認できます。';
    return { ok: true, text: msg };
  }

  const totalOpen = list.filter(i => OPEN_STATUSES.includes(i.status)).length;
  const header    = all
    ? `🚨 **インシデント一覧** (全 ${list.length} 件 / 未解決 ${totalOpen} 件)`
    : `🚨 **未解決インシデント** (${filtered.length} 件)`;

  const lines = [header, ''];
  for (const i of filtered) {
    const sev  = SEVERITY_EMOJI[i.severity] || '⚪';
    const st   = STATUS_EMOJI[i.status]  || '❓';
    const date = new Date(i.createdAt).toLocaleDateString('ja-JP');
    lines.push(`${st}${sev} \`${i.id}\``);
    lines.push(`   ${i.title}`);
    const meta = [date, i.status];
    if (i.tags.length) meta.push(i.tags.join(','));
    lines.push(`   ${meta.join(' | ')}`);
    if (i.refs.length) lines.push(`   refs: ${i.refs.join(', ')}`);
    lines.push('');
  }

  return { ok: true, text: lines.join('\n').trimEnd() };
}

// ─────────────────────────────────────────────────────
// showIncident(id) — インシデント詳細表示
//
// ID は完全一致または末尾部分一致
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function showIncident(id) {
  if (!id || !String(id).trim()) {
    return {
      ok:   false,
      text: '使い方: `!incident show <ID>`\n\nIDは `!incident list` で確認できます。',
    };
  }
  const target = String(id).trim();
  const list   = _load();
  const rec    = list.find(i => i.id === target || i.id.endsWith(target));

  if (!rec) {
    return {
      ok:   false,
      text: `❌ \`${target}\` が見つかりません。\n\`!incident list all\` で確認してください。`,
    };
  }

  const sev  = SEVERITY_EMOJI[rec.severity] || '⚪';
  const st   = STATUS_EMOJI[rec.status]  || '❓';
  const lines = [
    `🚨 **インシデント詳細**`,
    ``,
    `**ID:** \`${rec.id}\``,
    `**Type:** ${rec.type}`,
    `**Created:** ${new Date(rec.createdAt).toLocaleString('ja-JP')}`,
    `**Project:** ${rec.projectId}`,
    `**Severity:** ${sev} ${rec.severity}`,
    `**Status:** ${st} ${rec.status}`,
    ``,
    `**Title:** ${rec.title}`,
  ];
  if (rec.summary)     lines.push(`**Summary:** ${rec.summary}`);
  if (rec.refs.length) lines.push(`**Refs:** ${rec.refs.join(', ')}`);
  if (rec.tags.length) lines.push(`**Tags:** ${rec.tags.join(', ')}`);

  // data フィールドを表示
  const d = rec.data || {};
  if (d.detectedAt)  lines.push(``, `**Detected:** ${new Date(d.detectedAt).toLocaleString('ja-JP')}`);
  if (d.resolvedAt)  lines.push(`**Resolved:** ${new Date(d.resolvedAt).toLocaleString('ja-JP')}`);
  if (d.rootCause)   lines.push(`**Root Cause:** ${d.rootCause}`);
  if (d.mitigation)  lines.push(`**Mitigation:** ${d.mitigation}`);
  if (d.prevention)  lines.push(`**Prevention:** ${d.prevention}`);
  if (d.affectedArea?.length) lines.push(`**Affected:** ${d.affectedArea.join(', ')}`);

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// resolveIncident(id, resolution) — 解決・教訓化候補を提示
//
// resolution: 対応内容（必須）
// 状態を RESOLVED に更新し、lesson 化候補テキストを返す
// 自動 LESSONS.md 追記はしない（MVP では提案まで）
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function resolveIncident(id, resolution) {
  if (!id || !String(id).trim()) {
    return {
      ok:   false,
      text: '使い方: `!incident resolve <ID> <対応内容>`',
    };
  }
  if (!resolution || !String(resolution).trim()) {
    return {
      ok:   false,
      text: `❌ 対応内容は必須です。\n\n使い方: \`!incident resolve ${id} <対応内容>\``,
    };
  }

  const target = String(id).trim();
  const list   = _load();
  const idx    = list.findIndex(i => i.id === target || i.id.endsWith(target));

  if (idx < 0) {
    return {
      ok:   false,
      text: `❌ \`${target}\` が見つかりません。\n\`!incident list all\` で確認してください。`,
    };
  }

  const rec = list[idx];

  // 既に解決済み / クローズ済みの場合は拒否
  if (rec.status === STATUS.RESOLVED || rec.status === STATUS.CLOSED) {
    return {
      ok:   false,
      text: `⚠️ \`${rec.id}\` はすでに ${rec.status} です。\n再起票が必要な場合は \`!incident open\` で新規作成してください。`,
    };
  }

  // 対応内容に redact 適用
  const safeResolution = redact(String(resolution).trim()).slice(0, 500);

  // レコード更新
  const now          = new Date().toISOString();
  rec.status         = STATUS.RESOLVED;
  rec.data           = rec.data || {};
  rec.data.resolvedAt  = now;
  rec.data.mitigation  = safeResolution;
  // prevention は mitigation と同テキストを初期値に（後で編集可能）
  if (!rec.data.prevention) rec.data.prevention = safeResolution;

  list[idx] = rec;
  _save(list);

  const lessonText = _buildLessonCandidate(rec);
  const lines = [
    `✅ **インシデント解決**`,
    ``,
    `ID: \`${rec.id}\``,
    `タイトル: ${rec.title}`,
    `状態: OPEN → **RESOLVED**`,
    `対応内容: ${safeResolution}`,
    ``,
    '━━━━━━━━━━━━━━━━',
    '',
    lessonText,
  ];

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// module.exports
// ─────────────────────────────────────────────────────
module.exports = {
  openIncident,
  listIncidents,
  showIncident,
  resolveIncident,
  parseArgs: _parseArgs,
  // テスト用内部 API
  _load,
  _save,
  _buildEnvelope,
  STATUS,
  STATUS_EMOJI,
  SEVERITY_EMOJI,
};
