'use strict';
// =====================================================
// daily-changes.js — 当日更新ログ管理
//
// 目的:
//   !close / 自然文トリガーの終業報告に
//   「今日更新されたもの」セクションを追加する。
//
// コマンド:
//   !change <type> <内容>   — 更新を記録（重複検出あり）
//   !change list            — 今日の更新一覧
//   !change pending         — 保留中ルール一覧
//   !change promote <id>    — 保留ルールを正式登録
//   !change clear           — 今日の記録をクリア（Owner のみ）
//
// type:
//   command / rule / ops / category / channel
//
// 安全:
//   ・保存前に redact() でマスク
//   ・data/daily-changes.json は .gitignore 対象
//   ・顧客情報・秘密情報は表示しない
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR      = path.join(__dirname, '..', '..', 'data');
const CHANGES_FILE  = path.join(DATA_DIR, 'daily-changes.json');
const PENDING_FILE  = path.join(DATA_DIR, 'pending-rules.json');

const CHANGE_TYPES = {
  command:  { label: 'コマンド',     emoji: '📘' },
  rule:     { label: 'ルール',       emoji: '📐' },
  ops:      { label: '運用',         emoji: '🏢' },
  category: { label: 'カテゴリ',     emoji: '📂' },
  channel:  { label: 'チャンネル',   emoji: '💬' },
};
const VALID_TYPES = Object.keys(CHANGE_TYPES);
const MAX_PER_TYPE = 5;
const SIMILARITY_THRESHOLD = 0.7; // Jaccard bigram 類似度の警告閾値（0.6 は末尾1文字違いが誤検知するため0.7）

// ─────────────────────────────────────────────────────
// 類似度計算（文字 bigram Jaccard）
// ─────────────────────────────────────────────────────
function _bigrams(str) {
  const s = str.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function _similarity(a, b) {
  const ba = _bigrams(a);
  const bb = _bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return inter / (ba.size + bb.size - inter);
}

// ─────────────────────────────────────────────────────
// pending-rules ファイル操作
// ─────────────────────────────────────────────────────
function _loadPending() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return { nextId: 1, rules: {} };
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch { return { nextId: 1, rules: {} }; }
}

function _savePending(data) {
  const dir = path.dirname(PENDING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = PENDING_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, PENDING_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function _loadAll() {
  try {
    if (!fs.existsSync(CHANGES_FILE)) return {};
    return JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8'));
  } catch { return {}; }
}

function _saveAll(data) {
  const dir = path.dirname(CHANGES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = CHANGES_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, CHANGES_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 今日のエントリを返す（なければ空の構造を返す） */
function _todayEntry(all, date = _today()) {
  if (!all[date]) {
    all[date] = { command: [], rule: [], ops: [], category: [], channel: [] };
  }
  return all[date];
}

// ─────────────────────────────────────────────────────
// addChange(type, content) — 更新を記録する
// ─────────────────────────────────────────────────────
function addChange(type, content) {
  const t = (type || '').toLowerCase().trim();
  if (!VALID_TYPES.includes(t))
    return { ok: false, text: `無効な type です。有効: ${VALID_TYPES.join(' / ')}` };
  if (!content || !content.trim())
    return { ok: false, text: '内容を入力してください。' };

  // 保存前に redact を適用（秘密情報・PII をマスク）
  const sanitized = redact(content.trim()).slice(0, 120);
  const all       = _loadAll();
  const today     = _todayEntry(all);

  if (!Array.isArray(today[t])) today[t] = [];

  // 重複検出: 同カテゴリ内の類似エントリを確認
  for (const entry of today[t]) {
    const sim = _similarity(sanitized, entry.text);
    if (sim >= SIMILARITY_THRESHOLD) {
      return {
        ok: false,
        duplicate: true,
        text: `⚠️ **重複の可能性があります**\n\n` +
              `登録済み: ${entry.text}\n` +
              `新規入力: ${sanitized}\n` +
              `類似度: ${Math.round(sim * 100)}%\n\n` +
              `登録するには \`!change ${t} force: ${sanitized}\` のように \`force: \` を先頭につけてください。`,
      };
    }
  }

  // force: プレフィックスを除去（重複警告回避フラグ）
  const finalText = sanitized.replace(/^force:\s*/i, '').trim();

  // 最大5件に制限（全 type 共通でエラーにする）
  // rule 上限超過時の pending 自動登録は廃止（!change promote で明示的に登録する）
  if (today[t].length >= MAX_PER_TYPE) {
    return {
      ok: false,
      text: `${CHANGE_TYPES[t].emoji} **${CHANGE_TYPES[t].label}** は今日すでに ${MAX_PER_TYPE} 件登録されています。\n` +
            `\`!change clear\` でリセットするか、\`!change promote <id>\` で保留ルールを昇格させてください。`,
    };
  }

  today[t].push({ at: new Date().toISOString(), text: finalText });
  _saveAll(all);

  const total = Object.values(today).flat().length;
  return {
    ok: true,
    type: t,
    text:
      `${CHANGE_TYPES[t].emoji} **${CHANGE_TYPES[t].label}** を記録しました\n\n` +
      `内容: ${finalText}\n` +
      `本日の更新数: ${total} 件\n\n` +
      `> \`!change list\` で今日の更新一覧を確認できます。`,
  };
}

// ─────────────────────────────────────────────────────
// _addPendingRule(text) — rule 上限超過時に pending へ保存
// ─────────────────────────────────────────────────────
function _addPendingRule(text) {
  const data = _loadPending();
  const id   = data.nextId;
  data.rules[id] = { id, at: new Date().toISOString(), date: _today(), text };
  data.nextId    = id + 1;
  _savePending(data);
  return {
    ok: true,
    pending: true,
    text: `📋 **ルールは上限 (${MAX_PER_TYPE}件) に達しているため保留リストに保存しました**\n\n` +
          `ID: \`${id}\`\n内容: ${text}\n\n` +
          `> \`!change pending\` で保留一覧を確認\n` +
          `> \`!change promote ${id}\` で正式登録`,
  };
}

// ─────────────────────────────────────────────────────
// listChanges(date?) — 指定日（省略時: 今日）の更新一覧テキストを返す
// ─────────────────────────────────────────────────────
function listChanges(date) {
  const d   = date || _today();
  const all = _loadAll();
  const day = all[d];

  const lines = [`🆕 **更新ログ — ${d}**`, ''];
  let hasAny = false;

  for (const [t, info] of Object.entries(CHANGE_TYPES)) {
    const entries = (day && Array.isArray(day[t]) ? day[t] : []).slice(0, MAX_PER_TYPE);
    lines.push(`${info.emoji} **${info.label}:**`);
    if (entries.length === 0) {
      lines.push('  更新なし');
    } else {
      entries.forEach(e => lines.push(`  ・${e.text}`));
      hasAny = true;
    }
    lines.push('');
  }

  if (!hasAny) lines.push('> 今日の更新はまだ登録されていません。`!change <type> <内容>` で追加してください。');

  return { ok: true, text: lines.join('\n').trim(), hasAny };
}

// ─────────────────────────────────────────────────────
// clearChanges(date?) — 指定日のエントリをクリア
// ─────────────────────────────────────────────────────
function clearChanges(date) {
  const d   = date || _today();
  const all = _loadAll();
  delete all[d];
  _saveAll(all);
  return { ok: true, text: `🗑️ **${d}** の更新ログをクリアしました。` };
}

// ─────────────────────────────────────────────────────
// buildChangesSection(date?) — !close 用のセクションテキスト
// ─────────────────────────────────────────────────────
function buildChangesSection(date) {
  const result = listChanges(date);
  return result.text;
}

// ─────────────────────────────────────────────────────
// listPending() — 保留中ルール一覧
// ─────────────────────────────────────────────────────
function listPending() {
  const data  = _loadPending();
  const rules = Object.values(data.rules);

  if (rules.length === 0) {
    return { ok: true, text: '📋 **保留中ルール — なし**\n\n保留ルールはありません。', hasAny: false };
  }

  const lines = [`📋 **保留中ルール (${rules.length}件)**`, ''];
  for (const r of rules.sort((a, b) => a.id - b.id)) {
    lines.push(`**[${r.id}]** ${r.text}`);
    lines.push(`  登録日: ${r.date}`);
    lines.push('');
  }
  lines.push(`> \`!change promote <id>\` で正式登録`);

  return { ok: true, text: lines.join('\n').trim(), hasAny: true };
}

// ─────────────────────────────────────────────────────
// promoteRule(id) — 保留ルールを正式登録
// ─────────────────────────────────────────────────────
function promoteRule(id) {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return { ok: false, text: `無効な ID です: ${id}` };

  const data = _loadPending();
  const rule = data.rules[numId];
  if (!rule) return { ok: false, text: `ID ${numId} の保留ルールは存在しません。\`!change pending\` で一覧を確認してください。` };

  const all   = _loadAll();
  const today = _todayEntry(all);
  if (!Array.isArray(today.rule)) today.rule = [];

  if (today.rule.length >= MAX_PER_TYPE) {
    return {
      ok: false,
      text: `📐 **ルール** は今日すでに ${MAX_PER_TYPE} 件登録されています。先に古いルールを確認してください。`,
    };
  }

  // 重複チェック
  for (const entry of today.rule) {
    const sim = _similarity(rule.text, entry.text);
    if (sim >= SIMILARITY_THRESHOLD) {
      return {
        ok: false,
        text: `⚠️ 登録済みの類似ルールがあります (類似度 ${Math.round(sim * 100)}%):\n${entry.text}\n\n` +
              `保留ルール: ${rule.text}`,
      };
    }
  }

  today.rule.push({ at: new Date().toISOString(), text: rule.text });
  _saveAll(all);

  // pending から削除
  delete data.rules[numId];
  _savePending(data);

  return {
    ok: true,
    text: `📐 **保留ルール [${numId}] を正式登録しました**\n\n内容: ${rule.text}`,
  };
}

module.exports = {
  CHANGE_TYPES,
  VALID_TYPES,
  addChange,
  listChanges,
  clearChanges,
  buildChangesSection,
  listPending,
  promoteRule,
  // テスト用
  _loadAll,
  _saveAll,
  _today,
  _similarity,
};
