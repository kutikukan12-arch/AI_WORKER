'use strict';
// =====================================================
// inbox-bridge.js — Desktop Inbox Bridge (黒川 Phase2)
//
// 目的:
//   ChatGPT Desktop / 副社長相談内容を AI_WORKER へ橋渡し。
//   CEOが毎回Discordへ手動コピペする負担を減らす。
//
// 処理フロー:
//   data/inbox/gpt/incoming.md
//     ↓ read + redact
//   分類 (decision/incident/task/msg/ceo_review/memo)
//     ↓
//   data/outbox/gpt/report.md に保存
//     ↓
//   Discord に要約表示 + 実行候補コマンドを提案
//
// 禁止事項:
//   ❌ 自動 !task add / !decision log / !incident open / !msg send
//   ❌ Git 操作
//   ❌ 外部通信
//   ❌ ChatGPTメモの外部公開
//
// セーフガード:
//   ✅ redact() 適用
//   ✅ data/inbox/gpt/*.md は gitignore
//   ✅ data/outbox/gpt/*.md は gitignore
//   ✅ 提案まで。実行は CEO が手動で行う
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const INBOX_DIR   = path.join(DATA_DIR, 'inbox', 'gpt');
const OUTBOX_DIR  = path.join(DATA_DIR, 'outbox', 'gpt');
const INCOMING    = path.join(INBOX_DIR,  'incoming.md');
const REPORT      = path.join(OUTBOX_DIR, 'report.md');

// ─────────────────────────────────────────────────────
// 分類キーワード
// ─────────────────────────────────────────────────────
const CLASSIFIERS = {
  decision: {
    label: 'Decision候補',
    emoji: '📋',
    keywords: [
      '方針', '決定', '採用', '却下', '変更決定', '方向性', '確定', '承認',
      '選択', '選んだ', '決めた', '決断', '合意', '合意した', '廃止',
      'decision', 'decided', 'approved', 'rejected',
    ],
    cmdTemplate: (title) => `!decision log ${title}`,
  },
  incident: {
    label: 'Incident候補',
    emoji: '🚨',
    keywords: [
      '障害', '問題', 'エラー', '失敗', 'バグ', '緊急', '不具合', '停止',
      'クラッシュ', '警告', 'アラート', 'リーク', '漏洩', '遅延', '対応',
      'incident', 'error', 'bug', 'crash', 'urgent', 'critical',
    ],
    cmdTemplate: (title) => `!incident open ${title}`,
  },
  task: {
    label: 'Task候補',
    emoji: '⚙️',
    keywords: [
      '実装', '修正', '追加', '開発', '作成', '改善', '対応', 'TODO',
      'やること', 'やる', '必要', '作る', '整備', 'リファクタ', 'テスト',
      '対処', '調査', '確認作業', 'implement', 'fix', 'add', 'create',
    ],
    cmdTemplate: (title) => `!task add ${title}`,
  },
  msg: {
    label: 'Msg候補',
    emoji: '📨',
    keywords: [
      '確認お願い', '相談', '依頼', '聞いて', '聞きたい', '連絡', '伝えて',
      '通知', '報告', 'へ確認', 'に確認', 'に依頼', 'に伝え',
      '宮城', '守谷', '白石', '相沢', '市川', '金森', '黒川', '育野',
    ],
    cmdTemplate: (title, to = '') => `!msg send ${to || '<宛先>'} ${title}`,
  },
  ceo_review: {
    label: 'CEO判断待ち',
    emoji: '👑',
    keywords: [
      'CEO判断', '要判断', '確認が必要', 'CEOへ', '判断お願い', '承認お願い',
      'どうしますか', 'どう思いますか', 'ご確認', 'ご判断', '検討してください',
    ],
    cmdTemplate: () => `# CEO確認後に手動実行してください`,
  },
};

// ─────────────────────────────────────────────────────
// 宛先検出
// ─────────────────────────────────────────────────────
const MEMBER_RE = /宮城|守谷|白石|相沢|市川|金森|黒川|育野|miyagi|moriya|shiraishi|aizawa|ichikawa|kanemori|kurokawa|ikuno/i;
const MEMBER_MAP = {
  '宮城': 'miyagi', 'miyagi': 'miyagi',
  '守谷': 'moriya', 'moriya': 'moriya',
  '白石': 'shiraishi', 'shiraishi': 'shiraishi',
  '相沢': 'aizawa',  'aizawa':  'aizawa',
  '市川': 'ichikawa','ichikawa':'ichikawa',
  '金森': 'kanemori','kanemori':'kanemori',
  '黒川': 'kurokawa','kurokawa':'kurokawa',
  '育野': 'ikuno',   'ikuno':   'ikuno',
};

function _detectMember(text) {
  const m = text.match(MEMBER_RE);
  if (!m) return null;
  const key = Object.keys(MEMBER_MAP).find(k => k.toLowerCase() === m[0].toLowerCase());
  return key ? MEMBER_MAP[key] : null;
}

// ─────────────────────────────────────────────────────
// テキスト行を分類
// ─────────────────────────────────────────────────────
function _classifyLine(line) {
  const lower = line.toLowerCase();
  const scores = {};
  for (const [cat, { keywords }] of Object.entries(CLASSIFIERS)) {
    scores[cat] = keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return (best[1] > 0) ? best[0] : 'memo';
}

// ─────────────────────────────────────────────────────
// incoming.md を読んで分類
// ─────────────────────────────────────────────────────
function parseIncoming() {
  if (!fs.existsSync(INCOMING)) {
    return { ok: false, reason: 'no_file' };
  }

  const raw     = fs.readFileSync(INCOMING, 'utf8');
  const content = redact(raw);

  if (!content.trim()) {
    return { ok: false, reason: 'empty' };
  }

  // セクションヘッダー対応の行パーサー
  const lines    = content.split('\n');
  const sections = { decision: [], incident: [], task: [], msg: [], ceo_review: [], memo: [] };
  let   ctxCat   = null; // ## ヘッダーから推定したカテゴリ

  const SECTION_MAP = {
    '判断': 'decision', '決定': 'decision', 'decision': 'decision',
    'タスク': 'task', 'task': 'task', 'todo': 'task',
    'インシデント': 'incident', '障害': 'incident', 'incident': 'incident',
    '確認依頼': 'msg', '依頼': 'msg', 'メッセージ': 'msg', 'msg': 'msg',
    '緊急': 'incident',
    'メモ': 'memo', 'memo': 'memo', 'その他': 'memo',
    'ceo': 'ceo_review', '判断待ち': 'ceo_review',
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // セクションヘッダー (## or #)
    if (/^#{1,3}\s/.test(trimmed)) {
      const heading = trimmed.replace(/^#+\s*/, '').toLowerCase();
      ctxCat = null;
      for (const [key, cat] of Object.entries(SECTION_MAP)) {
        if (heading.includes(key)) { ctxCat = cat; break; }
      }
      continue;
    }

    // 箇条書きのマーカーを除去
    const text = trimmed.replace(/^[-・*]\s*/, '').replace(/^!\w+\s+/, '').trim();
    if (!text) continue;

    const cat = ctxCat || _classifyLine(text);
    sections[cat].push(text);
  }

  return { ok: true, content, sections, rawLength: raw.length };
}

// ─────────────────────────────────────────────────────
// 実行候補コマンドを生成（提案のみ・自動実行しない）
// ─────────────────────────────────────────────────────
function _buildSuggestions(sections) {
  const suggestions = [];

  for (const item of sections.decision.slice(0, 3)) {
    const title = item.slice(0, 60);
    suggestions.push({
      cat: 'decision',
      label: '決定を記録',
      cmd: CLASSIFIERS.decision.cmdTemplate(title),
    });
  }

  for (const item of sections.incident.slice(0, 2)) {
    const title = item.slice(0, 60);
    suggestions.push({
      cat: 'incident',
      label: 'インシデント起票',
      cmd: CLASSIFIERS.incident.cmdTemplate(title),
    });
  }

  for (const item of sections.task.slice(0, 3)) {
    const title = item.slice(0, 60);
    suggestions.push({
      cat: 'task',
      label: 'タスク追加',
      cmd: CLASSIFIERS.task.cmdTemplate(title),
    });
  }

  for (const item of sections.msg.slice(0, 2)) {
    const title   = item.slice(0, 60);
    const to      = _detectMember(item) || '<宛先>';
    suggestions.push({
      cat: 'msg',
      label: 'メッセージ送信',
      cmd: CLASSIFIERS.msg.cmdTemplate(title, to),
    });
  }

  for (const item of sections.ceo_review.slice(0, 2)) {
    suggestions.push({
      cat: 'ceo_review',
      label: 'CEO確認',
      cmd: `# CEO判断待ち: ${item.slice(0, 60)}`,
    });
  }

  return suggestions;
}

// ─────────────────────────────────────────────────────
// report.md を生成
// ─────────────────────────────────────────────────────
function _buildReport(parsed, suggestions) {
  const now   = new Date().toLocaleString('ja-JP');
  const lines = [
    `# 📥 Inbox Report`,
    `生成: ${now}`,
    ``,
    `## 分類サマリー`,
    `| 種別 | 件数 |`,
    `|------|------|`,
  ];

  for (const [cat, { label, emoji }] of Object.entries(CLASSIFIERS)) {
    const count = (parsed.sections[cat] || []).length;
    if (count > 0) lines.push(`| ${emoji} ${label} | ${count} 件 |`);
  }
  const memoCount = (parsed.sections.memo || []).length;
  if (memoCount > 0) lines.push(`| 📝 メモ | ${memoCount} 件 |`);
  lines.push('');

  // 各カテゴリの内容
  for (const [cat, { label, emoji }] of Object.entries(CLASSIFIERS)) {
    const items = parsed.sections[cat] || [];
    if (items.length === 0) continue;
    lines.push(`## ${emoji} ${label}`);
    items.forEach(item => lines.push(`- ${item}`));
    lines.push('');
  }

  if (parsed.sections.memo.length > 0) {
    lines.push(`## 📝 メモ`);
    parsed.sections.memo.forEach(item => lines.push(`- ${item}`));
    lines.push('');
  }

  // 実行候補コマンド（提案のみ）
  if (suggestions.length > 0) {
    lines.push(`## 🔧 実行候補コマンド（提案のみ・自動実行しない）`);
    lines.push(`> ⚠️ 以下は提案です。CEOが内容を確認してから手動で実行してください。`);
    lines.push('');
    suggestions.forEach((s, i) => {
      lines.push(`### ${i + 1}. ${s.label}`);
      lines.push('```');
      lines.push(s.cmd);
      lines.push('```');
      lines.push('');
    });
  }

  lines.push(`---`);
  lines.push(`*黒川 Desktop Bridge — 提案のみ。実行禁止。*`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// checkInbox() — メイン処理
//
// 戻り値: { ok, text (Discord用要約), reportPath?, sections?, suggestions? }
// ─────────────────────────────────────────────────────
function checkInbox() {
  const parsed = parseIncoming();

  if (!parsed.ok) {
    const hint = parsed.reason === 'no_file'
      ? `\`data/inbox/gpt/incoming.md\` が存在しません。\nChatGPT Desktop のメモをこのファイルにペーストしてから再実行してください。`
      : `\`data/inbox/gpt/incoming.md\` が空です。\nChatGPT Desktop のメモをペーストしてください。`;
    return { ok: false, text: `📭 **Inbox は空です**\n\n${hint}` };
  }

  const suggestions = _buildSuggestions(parsed.sections);
  const report      = _buildReport(parsed, suggestions);

  // report.md を書き出す
  [INBOX_DIR, OUTBOX_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  fs.writeFileSync(REPORT, report, 'utf8');

  // Discord 要約テキスト生成
  const counts = Object.entries(CLASSIFIERS)
    .map(([cat, { label, emoji }]) => {
      const n = (parsed.sections[cat] || []).length;
      return n > 0 ? `${emoji} ${label}: ${n}件` : null;
    })
    .filter(Boolean);
  const memoN = parsed.sections.memo.length;
  if (memoN > 0) counts.push(`📝 メモ: ${memoN}件`);

  const total = Object.values(parsed.sections).reduce((a, b) => a + b.length, 0);

  const discordLines = [
    `📥 **Inbox Report** (計 ${total} 項目)`,
    ``,
    `**分類:**`,
    ...counts.map(c => `・${c}`),
    ``,
  ];

  if (suggestions.length > 0) {
    discordLines.push(`**推奨アクション (${suggestions.length}件):**`);
    suggestions.forEach((s, i) => {
      discordLines.push(`${i + 1}. **[${s.label}]**`);
      discordLines.push(`\`\`\`\n${s.cmd}\n\`\`\``);
    });
    discordLines.push('');
  }

  discordLines.push(`> ⚠️ 上記は**提案のみ**です。CEOが確認してから手動実行してください。`);
  discordLines.push(`> 詳細: \`data/outbox/gpt/report.md\``);

  return {
    ok:          true,
    text:        discordLines.join('\n'),
    reportPath:  REPORT,
    sections:    parsed.sections,
    suggestions,
    total,
  };
}

// ─────────────────────────────────────────────────────
// getStatus() — Inbox 状態確認
// ─────────────────────────────────────────────────────
function getStatus() {
  const incomingExists = fs.existsSync(INCOMING);
  const reportExists   = fs.existsSync(REPORT);
  let   incomingSize   = 0;
  let   reportMtime    = null;

  if (incomingExists) {
    incomingSize = fs.statSync(INCOMING).size;
  }
  if (reportExists) {
    reportMtime = fs.statSync(REPORT).mtime.toLocaleString('ja-JP');
  }

  const lines = [
    `📊 **Inbox Bridge 状態**`,
    ``,
    `📥 incoming.md: ${incomingExists ? `✅ あり (${incomingSize} bytes)` : '❌ なし'}`,
    `📄 report.md:   ${reportExists ? `✅ あり (最終更新: ${reportMtime})` : '⭕ 未生成'}`,
    ``,
    `パス:`,
    `  inbox:  \`data/inbox/gpt/incoming.md\``,
    `  outbox: \`data/outbox/gpt/report.md\``,
    ``,
    incomingExists
      ? '`!inbox check` で分析を実行できます。'
      : '`data/inbox/gpt/incoming.md` にメモをペーストしてください。',
  ];
  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// clearInbox() — incoming.md をクリア（outbox は残す）
// ─────────────────────────────────────────────────────
function clearInbox() {
  if (!fs.existsSync(INCOMING)) {
    return { ok: true, text: '📭 incoming.md は既に空です。' };
  }
  fs.writeFileSync(INCOMING, '', 'utf8');
  return { ok: true, text: '🗑️ **incoming.md をクリアしました**\n\n次のメモをペーストする準備ができました。' };
}

module.exports = {
  checkInbox,
  getStatus,
  clearInbox,
  // テスト用
  parseIncoming,
  _classifyLine,
  _buildSuggestions,
  INCOMING,
  REPORT,
  INBOX_DIR,
  OUTBOX_DIR,
};
