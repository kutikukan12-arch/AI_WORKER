'use strict';
// =====================================================
// internal-messages.js — 社内メッセージ配送 (Chief of Staff: 黒川)
//
// 目的:
//   AI社員間の確認依頼をCEOが毎回手動中継しなくて済むようにする。
//   黒川がメッセージの配送・進行管理を担う。
//
// 権限ルール:
//   ✅ 黒川は配送・待ち状況の管理を担う
//   ❌ 黒川が READY/NEED_FIX を勝手に出す禁止
//   ❌ 黒川が COO/CTO/PM の代わりに判断する禁止
//   ❌ 社内メッセージの外部公開禁止
//
// 共通エンベロープ仕様準拠 (docs/envelope-spec.md 参照)
//   type: INTERNAL_MESSAGE
//   ID prefix: msg_<timestamp><3hex>
//
// コマンド:
//   !msg send <to> <内容>   — メッセージ送信 (WAITING_REPLY)
//   !msg list               — 未返信一覧
//   !msg list all           — 全件一覧
//   !msg show <id>          — 詳細表示
//   !msg reply <id> <返信>  — 返信 (→ REPLIED)
//   !msg close <id>         — クローズ (→ CLOSED)
//   !msg pending            — 誰が誰の返信待ちか（黒川レポート）
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR      = path.join(__dirname, '..', '..', 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'internal-messages.json');

// ─── ステータス ───────────────────────────────────────
const STATUS = {
  WAITING_REPLY: 'WAITING_REPLY',
  REPLIED:       'REPLIED',
  CLOSED:        'CLOSED',
};

const STATUS_EMOJI = {
  WAITING_REPLY: '⏳',
  REPLIED:       '✅',
  CLOSED:        '📦',
};

// ─── メンバー定義とエイリアス ─────────────────────────
// 表示名は日本語、canonical は英語小文字
const MEMBER_ALIASES = {
  miyagi:   ['miyagi', '宮城', 'a', 'A'],
  moriya:   ['moriya', '守谷', 'b', 'B'],
  shiraishi:['shiraishi', '白石', 'c', 'C'],
  aizawa:   ['aizawa', '相沢', 'd', 'D'],
  ichikawa: ['ichikawa', '市川', 'e', 'E'],
  kanemori: ['kanemori', '金森', 'f', 'F'],
  kurokawa: ['kurokawa', '黒川', 'g', 'G'],
  ikuno:    ['ikuno', '育野', 'h', 'H'],
  kanzaki:  ['kanzaki', '神崎', 'i', 'I'],
  ceo:      ['ceo', 'CEO'],
};

const MEMBER_DISPLAY = {
  miyagi:    '宮城 Lead Engineer',
  moriya:    '守谷 CTO',
  shiraishi: '白石 COO',
  aizawa:    '相沢 AI Engineer',
  ichikawa:  '市川 PM',
  kanemori:  '金森 CFO',
  kurokawa:  '黒川 Chief of Staff',
  ikuno:     '育野',
  kanzaki:   '神崎 VP',
  ceo:       'CEO',
};

// エイリアス → canonical 変換
function resolveAlias(input) {
  if (!input) return null;
  const lower = String(input).toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(MEMBER_ALIASES)) {
    if (aliases.some(a => a.toLowerCase() === lower)) return canonical;
  }
  return null;
}

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return [];
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch { return []; }
}

function _save(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = MESSAGES_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, MESSAGES_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// ID 生成
// ─────────────────────────────────────────────────────
function _generateId(list) {
  const existing = new Set(list.map(m => m.id));
  for (let i = 0; i < 100; i++) {
    const suffix = Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
    const id     = `msg_${Date.now()}${suffix}`;
    if (!existing.has(id)) return id;
  }
  return `msg_${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

// ─────────────────────────────────────────────────────
// 待機時間フォーマット
// ─────────────────────────────────────────────────────
function _formatAge(createdAt) {
  const ms   = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs  / 24);
  if (days > 0)  return `${days}日前`;
  if (hrs  > 0)  return `${hrs}時間前`;
  if (mins > 0)  return `${mins}分前`;
  return 'たった今';
}

// ─────────────────────────────────────────────────────
// sendMessage(opts) — メッセージ送信
//
// opts: { from, to, title, content, refs?, tags? }
// 戻り値: { ok, id?, text }
// ─────────────────────────────────────────────────────
function sendMessage(opts) {
  const fromCanon = resolveAlias(opts.from);
  const toCanon   = resolveAlias(opts.to);

  if (!fromCanon) {
    return {
      ok:   false,
      text: `❌ 送信者 \`${opts.from}\` が不明です。\n有効な宛先: ${Object.keys(MEMBER_ALIASES).join(' / ')}`,
    };
  }
  if (!toCanon) {
    return {
      ok:   false,
      text: `❌ 宛先 \`${opts.to}\` が不明です。\n有効な宛先: ${Object.keys(MEMBER_ALIASES).join(' / ')}`,
    };
  }
  if (!opts.content || !String(opts.content).trim()) {
    return {
      ok:   false,
      text: '❌ 内容は必須です。\n使い方: `!msg send <宛先> <内容>`',
    };
  }

  const safeTitle   = redact(String(opts.title   || '').trim()).slice(0, 200);
  const safeContent = redact(String(opts.content).trim()).slice(0, 1000);

  const list = _load();
  const now  = new Date().toISOString();
  const rec  = {
    id:        _generateId(list),
    type:      'INTERNAL_MESSAGE',
    createdAt: now,
    from:      fromCanon,
    to:        toCanon,
    status:    STATUS.WAITING_REPLY,
    title:     safeTitle || safeContent.slice(0, 50),
    content:   safeContent,
    refs:      Array.isArray(opts.refs) ? opts.refs.filter(Boolean) : [],
    tags:      Array.isArray(opts.tags) ? opts.tags.filter(Boolean) : [],
    reply:     null,
    repliedAt: null,
  };

  list.push(rec);
  _save(list);

  const fromLabel = MEMBER_DISPLAY[fromCanon] || fromCanon;
  const toLabel   = MEMBER_DISPLAY[toCanon]   || toCanon;

  return {
    ok: true,
    id: rec.id,
    text: `📨 **社内メッセージを送信しました**\n\n` +
          `ID: \`${rec.id}\`\n` +
          `送信者: ${fromLabel}\n` +
          `宛先: ${toLabel}\n` +
          `件名: ${rec.title}\n` +
          `状態: ⏳ ${STATUS.WAITING_REPLY}\n\n` +
          `> \`!msg reply ${rec.id} <返信内容>\` で返信できます。`,
  };
}

// ─────────────────────────────────────────────────────
// listMessages(opts) — メッセージ一覧
//
// opts: { all?, member?, limit? }
//   all=true: 全件表示 / false: WAITING_REPLY のみ
//   member: 特定のメンバー関連のみ
// ─────────────────────────────────────────────────────
function listMessages({ all = false, member = null, limit = 20 } = {}) {
  const list = _load();

  let filtered = [...list].reverse();

  // メンバーフィルタ
  if (member) {
    const canon = resolveAlias(member);
    if (canon) {
      filtered = filtered.filter(m => m.from === canon || m.to === canon);
    }
  }

  // 未返信のみ or 全件
  if (!all) {
    filtered = filtered.filter(m => m.status === STATUS.WAITING_REPLY);
  }

  filtered = filtered.slice(0, limit);

  if (filtered.length === 0) {
    const msg = all
      ? '📭 社内メッセージはありません。'
      : '✅ 未返信の社内メッセージはありません。\n`!msg list all` で全件確認できます。';
    return { ok: true, text: msg };
  }

  const waitingCount = list.filter(m => m.status === STATUS.WAITING_REPLY).length;
  const header = all
    ? `📨 **社内メッセージ一覧** (全 ${list.length} 件 / 返信待ち ${waitingCount} 件)`
    : `📨 **返信待ちメッセージ** (${filtered.length} 件)`;

  const lines = [header, ''];
  for (const m of filtered) {
    const st   = STATUS_EMOJI[m.status] || '❓';
    const from = MEMBER_DISPLAY[m.from] || m.from;
    const to   = MEMBER_DISPLAY[m.to]   || m.to;
    const age  = _formatAge(m.createdAt);
    lines.push(`${st} \`${m.id}\``);
    lines.push(`   ${from} → ${to}  (${age})`);
    lines.push(`   📌 ${m.title}`);
    if (m.reply) lines.push(`   💬 返信済み`);
    lines.push('');
  }

  return { ok: true, text: lines.join('\n').trimEnd() };
}

// ─────────────────────────────────────────────────────
// showMessage(id) — 詳細表示
// ─────────────────────────────────────────────────────
function showMessage(id) {
  if (!id || !String(id).trim()) {
    return { ok: false, text: '使い方: `!msg show <ID>`\n`!msg list` でIDを確認できます。' };
  }
  const target = String(id).trim();
  const list   = _load();
  const rec    = list.find(m => m.id === target || m.id.endsWith(target));

  if (!rec) {
    return { ok: false, text: `❌ \`${target}\` が見つかりません。\n\`!msg list all\` で確認してください。` };
  }

  const from = MEMBER_DISPLAY[rec.from] || rec.from;
  const to   = MEMBER_DISPLAY[rec.to]   || rec.to;
  const st   = STATUS_EMOJI[rec.status] || '❓';
  const age  = _formatAge(rec.createdAt);

  const lines = [
    `📨 **社内メッセージ 詳細**`,
    ``,
    `**ID:** \`${rec.id}\``,
    `**送信者:** ${from}`,
    `**宛先:** ${to}`,
    `**状態:** ${st} ${rec.status}  (${age})`,
    ``,
    `**件名:** ${rec.title}`,
    `**内容:** ${rec.content}`,
  ];
  if (rec.refs.length) lines.push(`**Refs:** ${rec.refs.join(', ')}`);
  if (rec.tags.length) lines.push(`**Tags:** ${rec.tags.join(', ')}`);
  if (rec.reply) {
    lines.push(``, `**返信:**`);
    lines.push(rec.reply);
    lines.push(`*(返信日時: ${new Date(rec.repliedAt).toLocaleString('ja-JP')})*`);
  }

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// replyMessage(id, replyContent) — 返信
// ─────────────────────────────────────────────────────
function replyMessage(id, replyContent) {
  if (!id || !String(id).trim()) {
    return { ok: false, text: '使い方: `!msg reply <ID> <返信内容>`' };
  }
  if (!replyContent || !String(replyContent).trim()) {
    return { ok: false, text: `❌ 返信内容は必須です。\n使い方: \`!msg reply ${id} <返信内容>\`` };
  }

  const target = String(id).trim();
  const list   = _load();
  const idx    = list.findIndex(m => m.id === target || m.id.endsWith(target));

  if (idx < 0) {
    return { ok: false, text: `❌ \`${target}\` が見つかりません。` };
  }

  const rec = list[idx];
  if (rec.status === STATUS.CLOSED) {
    return {
      ok:   false,
      text: `⚠️ \`${rec.id}\` はすでに CLOSED です。`,
    };
  }

  const safeReply  = redact(String(replyContent).trim()).slice(0, 1000);
  const now        = new Date().toISOString();
  rec.reply        = safeReply;
  rec.repliedAt    = now;
  rec.status       = STATUS.REPLIED;
  list[idx]        = rec;
  _save(list);

  const from = MEMBER_DISPLAY[rec.from] || rec.from;
  const to   = MEMBER_DISPLAY[rec.to]   || rec.to;

  return {
    ok:   true,
    text: `✅ **返信を記録しました**\n\n` +
          `ID: \`${rec.id}\`\n` +
          `${from} → ${to}\n` +
          `件名: ${rec.title}\n` +
          `状態: ⏳ WAITING_REPLY → ✅ REPLIED\n\n` +
          `> \`!msg close ${rec.id}\` でクローズできます。`,
  };
}

// ─────────────────────────────────────────────────────
// closeMessage(id) — クローズ
// ─────────────────────────────────────────────────────
function closeMessage(id) {
  if (!id || !String(id).trim()) {
    return { ok: false, text: '使い方: `!msg close <ID>`' };
  }

  const target = String(id).trim();
  const list   = _load();
  const idx    = list.findIndex(m => m.id === target || m.id.endsWith(target));

  if (idx < 0) {
    return { ok: false, text: `❌ \`${target}\` が見つかりません。` };
  }

  const rec = list[idx];
  if (rec.status === STATUS.CLOSED) {
    return { ok: false, text: `⚠️ \`${rec.id}\` はすでに CLOSED です。` };
  }

  const prev      = rec.status;
  rec.status      = STATUS.CLOSED;
  list[idx]       = rec;
  _save(list);

  return {
    ok:   true,
    text: `📦 **メッセージをクローズしました**\n\n` +
          `ID: \`${rec.id}\`\n` +
          `件名: ${rec.title}\n` +
          `状態: ${prev} → CLOSED`,
  };
}

// ─────────────────────────────────────────────────────
// pendingReport() — 黒川レポート: 誰が誰の返信待ちか
//
// 黒川は配送・進行管理のみ。判断の代理は禁止。
// ─────────────────────────────────────────────────────
function pendingReport() {
  const list    = _load();
  const waiting = list.filter(m => m.status === STATUS.WAITING_REPLY);

  if (waiting.length === 0) {
    return {
      ok:   true,
      text: '✅ **返信待ちメッセージなし**\n\n全メッセージが処理済みです。',
    };
  }

  // 宛先別にグループ化
  const byTo = {};
  for (const m of waiting) {
    if (!byTo[m.to]) byTo[m.to] = [];
    byTo[m.to].push(m);
  }

  const lines = [
    `📊 **社内メッセージ 返信待ちレポート** (計 ${waiting.length} 件)`,
    `*黒川 Chief of Staff — 配送・進行管理専用（判断の代理禁止）*`,
    ``,
  ];

  for (const [toCanon, msgs] of Object.entries(byTo)) {
    const toLabel = MEMBER_DISPLAY[toCanon] || toCanon;
    lines.push(`**📬 ${toLabel} への返信待ち (${msgs.length}件)**`);
    for (const m of msgs) {
      const from = MEMBER_DISPLAY[m.from] || m.from;
      const age  = _formatAge(m.createdAt);
      lines.push(`  ⏳ \`${m.id}\``);
      lines.push(`     ${from} → ${toLabel}  (${age})`);
      lines.push(`     📌 ${m.title}`);
    }
    lines.push('');
  }

  lines.push('> 次担当者: 各メッセージの宛先メンバーが返信してください。');
  lines.push('> `!msg reply <ID> <返信>` で返信、`!msg show <ID>` で内容確認。');

  return { ok: true, text: lines.join('\n').trimEnd() };
}

// ─────────────────────────────────────────────────────
// module.exports
// ─────────────────────────────────────────────────────
module.exports = {
  sendMessage,
  listMessages,
  showMessage,
  replyMessage,
  closeMessage,
  pendingReport,
  resolveAlias,
  MEMBER_ALIASES,
  MEMBER_DISPLAY,
  STATUS,
  STATUS_EMOJI,
  // テスト用
  _load,
  _save,
  _generateId,
};
