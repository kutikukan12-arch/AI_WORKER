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

// Decision カテゴリ（Phase1: 要件定義に合わせた6分類）
const CATEGORIES    = ['core', 'workflow', 'security', 'product', 'finance', 'learning'];
const CATEGORY_EMOJI = { core:'🏢', workflow:'🔀', security:'🔒', product:'📦', finance:'💰', learning:'📚' };

// status
// active   — 有効な判断（新規作成時のデフォルト）
// archived — 上書き済みまたは廃止（履歴保持・削除禁止）
// DECIDED  — 後方互換（既存データ、active と同等に扱う）
const VALID_STATUS = ['active', 'archived', 'DECIDED'];

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
function _buildEnvelope({ title, summary, projectId, severity, refs, tags, data, category }) {
  return {
    id:           `dec_${Date.now()}${Math.floor(Math.random()*0x1000).toString(16).padStart(3,'0')}`,
    type:         'DECISION',
    createdAt:    new Date().toISOString(),
    projectId:    String(projectId || 'default'),
    severity:     VALID_SEVERITY.includes(severity) ? severity : 'MEDIUM',
    title:        String(title).slice(0, 200),
    summary:      String(summary || '').slice(0, 500),
    refs:         Array.isArray(refs) ? refs.filter(Boolean) : [],
    tags:         Array.isArray(tags) ? tags.filter(Boolean) : [],
    status:       'active',   // Phase1: DECIDED → active に変更
    category:     CATEGORIES.includes(category) ? category : null,
    supersededBy: null,       // Phase3: !decision archive で設定
    data:         data && typeof data === 'object' ? data : {},
  };
}

// active 判定（後方互換: DECIDED も active と同等）
function _isActive(d) {
  return d.status === 'active' || d.status === 'DECIDED';
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
// Phase4: 🟢 active / 📦 archived の絵文字でステータスを視覚化
function _statusLabel(d) {
  if (_isActive(d))        return '🟢';   // active (含む後方互換 DECIDED)
  if (d.status === 'archived') return '📦';  // archived
  return '❓';
}

function listDecisions(limit = 10, includeArchived = false) {
  const all         = _load();
  const activeList  = all.filter(d => _isActive(d));
  const archivedList= all.filter(d => !_isActive(d));
  const archivedCount = archivedList.length;

  const list = includeArchived ? all : activeList;
  if (list.length === 0) {
    return {
      ok:   true,
      text: '📋 記録された意思決定はありません。\n`!decision log <タイトル>` で記録できます。',
    };
  }

  const recent = [...list].reverse().slice(0, limit);
  const head   = `📋 **意思決定ログ** (直近 ${recent.length} 件 / 🟢 active ${activeList.length} 件` +
                 (archivedCount > 0 ? ` / 📦 archived ${archivedCount} 件` : '') +
                 (!includeArchived && archivedCount > 0 ? ' — `!decision list all` で全表示' : '') + `)`;
  const lines  = [head, ``];

  for (const d of recent) {
    const date    = new Date(d.createdAt).toLocaleDateString('ja-JP');
    const stLabel = _statusLabel(d);
    const catEmoji= d.category ? (CATEGORY_EMOJI[d.category] || '🏷️') : '';
    lines.push(`${stLabel}${catEmoji} \`${d.id}\``);
    lines.push(`   ${d.title}`);
    const meta = [date];
    if (d.category) meta.push(d.category);
    if (d.tags.length) meta.push(d.tags.join(','));
    lines.push(`   ${meta.join(' | ')}`);
    if (d.supersededBy) lines.push(`   → 置換: \`${d.supersededBy}\``);
    lines.push('');
  }

  return { ok: true, text: lines.join('\n').trimEnd() };
}

// Phase5: active Decision のみ取得（COMPANY_CONTEXT 連携用）
function listActiveDecisions(limit = 50) {
  return _load().filter(d => _isActive(d)).slice(-limit);
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
    `**Status:** ${_statusLabel(rec)} ${rec.status}`,
    rec.category ? `**Category:** ${CATEGORY_EMOJI[rec.category] || ''} ${rec.category}` : null,
    ``,
    `**Title:** ${rec.title}`,
  ].filter(l => l !== null);
  if (rec.summary)       lines.push(`**Summary:** ${rec.summary}`);
  if (rec.refs.length)   lines.push(`**Refs:** ${rec.refs.join(', ')}`);
  if (rec.tags.length)   lines.push(`**Tags:** ${rec.tags.join(', ')}`);
  if (rec.supersededBy)  lines.push(`**SupersededBy:** \`${rec.supersededBy}\``);
  if (rec.archivedAt)    lines.push(`**ArchivedAt:** ${new Date(rec.archivedAt).toLocaleString('ja-JP')}`);
  if (rec.archivedReason)lines.push(`**ArchivedReason:** ${rec.archivedReason}`);

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
// normalizeTitle — 重複判定用にタイトルを正規化
// 空白・記号を除去し小文字化（表記ゆれ吸収）
// ─────────────────────────────────────────────────────
function _normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s　,.。、・|/()（）「」【】:：\-_]/g, '')
    .trim();
}

// ─────────────────────────────────────────────────────
// findDuplicates(list) — 重複Decisionクラスタを検出
//
// 正規化タイトルが一致するものをグループ化し、2件以上のクラスタを返す。
// 各クラスタは createdAt 昇順。最新（末尾）を残す候補、それ以外を archive 候補とする。
//
// 戻り値: [{ key, decisions:[...], keep, archive:[...] }]
// ─────────────────────────────────────────────────────
function findDuplicates(list = _load()) {
  const groups = new Map();
  for (const d of list) {
    const key = _normalizeTitle(d.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const clusters = [];
  for (const [key, decs] of groups) {
    if (decs.length < 2) continue;
    const sorted = [...decs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const keep = sorted[sorted.length - 1];
    clusters.push({ key, decisions: sorted, keep, archive: sorted.slice(0, -1) });
  }
  return clusters;
}

// ─────────────────────────────────────────────────────
// categorizeDecision(dec) — タグ・本文から整理カテゴリを推定（best-effort）
//
// 将来 Decision 作成時の「カテゴリ候補」提示に使う補助。
// 既存データの正式分類は curated map（organize-decisions.js）で行う。
// 優先順: Security > Workflow > Knowledge > Core Principle(default)
// ─────────────────────────────────────────────────────
function categorizeDecision(dec) {
  const tags = (dec.tags || []).map(t => String(t).toLowerCase());
  const text = `${dec.title || ''} ${dec.summary || ''}`.toLowerCase();
  const has  = (...ks) => ks.some(k => tags.includes(k) || text.includes(k));

  // Phase1: カテゴリを仕様の6分類に合わせる
  // 優先順: security > learning > workflow > product > finance > core
  // (learning を workflow より先にチェックし context/onboarding を正しく分類)
  if (has('security', 'guardian', 'l-16', 'secret', 'gitignore', 'security-check', 'token', '公開禁止', 'export', '公開境界'))
    return 'security';
  if (has('context', 'onboarding', 'learning', 'incident', 'lesson', 'company_context', '引継', 'コンテキスト'))
    return 'learning';
  if (has('workflow', 'automation', 'kurokawa', '黒川', 'desktop-bridge', 'handoff', 'loop', '配送', 'auto', 'phase10'))
    return 'workflow';
  if (has('product', 'mvp', 'youtube', 'リリース', 'ユーザー', '商品', 'beta', '診断'))
    return 'product';
  if (has('cost', 'roi', 'finance', 'コスト', '課金', '予算', 'cfo'))
    return 'finance';
  return 'core';
}

// ─────────────────────────────────────────────────────
// setCategory(id, category) — Decision にカテゴリを設定
// 戻り値: { ok, rec? }
// ─────────────────────────────────────────────────────
function setCategory(id, category) {
  if (!CATEGORIES.includes(category)) return { ok: false, reason: `不正なカテゴリ: ${category}` };
  const list = _load();
  const rec  = list.find(d => d.id === id);
  if (!rec) return { ok: false, reason: `ID が見つかりません: ${id}` };
  rec.category = category;
  _save(list);
  return { ok: true, rec };
}

// ─────────────────────────────────────────────────────
// archiveDecision(id, supersededBy, reason) — 削除せずアーカイブ
//
// status を ARCHIVED にし、supersededBy に新Decision ID を記録する。
// 過去の判断理由（title/summary/refs/tags）はそのまま保持する（履歴を消さない）。
// 戻り値: { ok, rec? }
// ─────────────────────────────────────────────────────
function archiveDecision(id, supersededBy = null, reason = '') {
  const list = _load();
  const rec  = list.find(d => d.id === id || d.id.endsWith(id));
  if (!rec) return { ok: false, reason: `ID が見つかりません: ${id}` };
  if (!_isActive(rec)) return { ok: false, reason: `既に archived です: ${rec.id}` };
  rec.status         = 'archived';  // Phase1: ARCHIVED → archived に統一
  rec.supersededBy   = supersededBy || null;
  rec.archivedAt     = new Date().toISOString();
  rec.archivedReason = String(reason || '').slice(0, 300);
  _save(list);
  return { ok: true, rec };
}

// ─────────────────────────────────────────────────────
// module.exports
// ─────────────────────────────────────────────────────
// Phase2: クリーンアップ提案（自動削除・自動archive 禁止）
// 育野へ提案のみ。承認後に手動 archive する運用。
function buildCleanupReport() {
  const all      = _load();
  const active   = all.filter(d => _isActive(d));
  const dups     = findDuplicates(active);

  // category 別集計
  const byCat = {};
  for (const d of active) {
    const c = d.category || '(未分類)';
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(d);
  }

  const lines = [
    `🧹 **Decision Cleanup 提案** (育野へ — 提案のみ・自動実行禁止)`,
    ``,
    `📊 **現状:**`,
    `  全件: ${all.length} / 🟢 active: ${active.length} / 📦 archived: ${all.length - active.length}`,
    ``,
  ];

  if (dups.length === 0) {
    lines.push('✅ 重複なし');
  } else {
    lines.push(`⚠️ **重複候補 (${dups.length} グループ):**`);
    for (const { decisions, keep, archive } of dups.slice(0, 5)) {
      lines.push(`\n  残す: \`${keep.id}\` ${keep.title.slice(0, 50)}`);
      for (const d of archive) {
        lines.push(`  archive候補: \`${d.id}\` ${d.title.slice(0, 50)}`);
        lines.push(`  → \`!decision archive ${d.id} ${keep.id}\``);
      }
    }
  }

  lines.push('', '**カテゴリ別分布:**');
  for (const [cat, ds] of Object.entries(byCat)) {
    const emoji = CATEGORY_EMOJI[cat] || '🏷️';
    lines.push(`  ${emoji} ${cat}: ${ds.length}件`);
  }

  lines.push('', '> 育野が確認後、`!decision archive <id> <newId>` で手動アーカイブしてください。');
  return { ok: true, text: lines.join('\n'), duplicateCount: dups.length };
}

module.exports = {
  logDecision,
  listDecisions,
  listActiveDecisions,
  showDecision,
  parseLogArgs: _parseLogArgs,
  // Decision Lifecycle API (Phase1-5)
  CATEGORIES,
  CATEGORY_EMOJI,
  findDuplicates,
  categorizeDecision,
  setCategory,
  archiveDecision,
  buildCleanupReport,
  // テスト用内部 API
  _load,
  _save,
  _buildEnvelope,
  _normalizeTitle,
  _isActive,
};
