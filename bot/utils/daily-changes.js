'use strict';
// =====================================================
// daily-changes.js — 当日更新ログ管理
//
// 目的:
//   !close / 自然文トリガーの終業報告に
//   「今日更新されたもの」セクションを追加する。
//
// コマンド:
//   !change <type> <内容> — 更新を記録
//   !change list          — 今日の更新一覧
//   !change clear         — 今日の記録をクリア（Owner のみ）
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

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const CHANGES_FILE = path.join(DATA_DIR, 'daily-changes.json');

const CHANGE_TYPES = {
  command:  { label: 'コマンド',     emoji: '📘' },
  rule:     { label: 'ルール',       emoji: '📐' },
  ops:      { label: '運用',         emoji: '🏢' },
  category: { label: 'カテゴリ',     emoji: '📂' },
  channel:  { label: 'チャンネル',   emoji: '💬' },
};
const VALID_TYPES = Object.keys(CHANGE_TYPES);
const MAX_PER_TYPE = 5;

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

  // 最大5件に制限
  if (today[t].length >= MAX_PER_TYPE) {
    return {
      ok: false,
      text: `${CHANGE_TYPES[t].emoji} **${CHANGE_TYPES[t].label}** は今日すでに ${MAX_PER_TYPE} 件登録されています。\n` +
            `\`!change clear\` でリセットするか、古い項目を削除してください。`,
    };
  }

  today[t].push({ at: new Date().toISOString(), text: sanitized });
  _saveAll(all);

  const total = Object.values(today).flat().length;
  return {
    ok: true,
    type: t,
    text:
      `${CHANGE_TYPES[t].emoji} **${CHANGE_TYPES[t].label}** を記録しました\n\n` +
      `内容: ${sanitized}\n` +
      `本日の更新数: ${total} 件\n\n` +
      `> \`!change list\` で今日の更新一覧を確認できます。`,
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

module.exports = {
  CHANGE_TYPES,
  VALID_TYPES,
  addChange,
  listChanges,
  clearChanges,
  buildChangesSection,
  // テスト用
  _loadAll,
  _saveAll,
  _today,
};
