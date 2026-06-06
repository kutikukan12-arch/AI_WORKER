'use strict';
// =====================================================
// inbox-bridge.js — Desktop Inbox Bridge (黒川 Phase2+3)
//
// Phase2: GPT Inbox Bridge
//   data/inbox/gpt/incoming.md → 分類 → report.md
//
// Phase3: Desktop Worker Loop
//   AI_WORKER → data/outbox/<worker>/outgoing.md (sendToWorker)
//   Desktop  → data/inbox/<worker>/incoming.md   (checkWorkerInbox)
//   !inbox status → 全社員の inbox/outbox 状態一覧
//
// 禁止事項:
//   ❌ 自動 createTask / decision-log / incident-manager 呼び出し
//   ❌ incoming.md の内容をコマンドとして実行
//   ❌ eval / execSync
//   ❌ Git 操作 / 外部通信
//   ❌ 黒川が判断を代理する
//
// セーフガード:
//   ✅ redact() を全出力に適用
//   ✅ data/inbox/ data/outbox/ は gitignore
//   ✅ worker 名はホワイトリストで検証（パストラバーサル防止）
//   ✅ 提案のみ。実行は CEO が確認してから手動で行う
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
// Phase3: 社員別ディレクトリ
// ─────────────────────────────────────────────────────
// ホワイトリスト: パストラバーサル防止。ここ以外の worker 名は拒否する。
// Phase2: ceo を追加 (KUROKAWA_SUMMARY → CEO の outbox 配送に必要)
const VALID_WORKERS = ['miyagi', 'moriya', 'shiraishi', 'aizawa', 'ichikawa', 'kanemori', 'kurokawa', 'ikuno', 'kanzaki', 'ceo'];

const WORKER_DISPLAY = {
  miyagi:    '宮城 Lead Engineer',
  moriya:    '守谷 CTO',
  shiraishi: '白石 COO',
  aizawa:    '相沢 AI Engineer',
  ichikawa:  '市川 PM',
  kanemori:  '金森 CFO',
  kurokawa:  '黒川 Chief of Staff',
  ikuno:     '育野',
  kanzaki:   '神崎 VP',
};

function _workerInboxPath(worker)   { return path.join(DATA_DIR, 'inbox',  worker, 'incoming.md'); }
function _workerOutboxPath(worker)  { return path.join(DATA_DIR, 'outbox', worker, 'outgoing.md'); }
function _workerReportPath(worker)  { return path.join(DATA_DIR, 'outbox', worker, 'report.md');   }

// worker 名を正規化（エイリアス解決 + ホワイトリスト確認）
// 日本語名 / アルファベット / 上記 valid のみ許可
const WORKER_ALIAS = {
  '宮城': 'miyagi', '守谷': 'moriya', '白石': 'shiraishi', '相沢': 'aizawa',
  '市川': 'ichikawa', '金森': 'kanemori', '黒川': 'kurokawa', '育野': 'ikuno', '神崎': 'kanzaki',
  a: 'miyagi', b: 'moriya', c: 'shiraishi', d: 'aizawa',
  e: 'ichikawa', f: 'kanemori', g: 'kurokawa', h: 'ikuno', i: 'kanzaki',
};

function resolveWorker(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const fromAlias = WORKER_ALIAS[input.trim()] || WORKER_ALIAS[s];
  if (fromAlias) return fromAlias;
  return VALID_WORKERS.includes(s) ? s : null;
}

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
  // Phase3 追加カテゴリ
  review: {
    label: 'Review候補',
    emoji: '🔍',
    keywords: [
      'NEED_FIX', 'need_fix', 'レビュー', 'コードレビュー', '修正指示',
      '指摘', 'フィードバック', 'review', '再確認', '見直し', 'チェック',
    ],
    cmdTemplate: (title) => `# レビュー: ${title.slice(0, 60)}`,
  },
  lesson: {
    label: 'Lesson候補',
    emoji: '📖',
    keywords: [
      '教訓', '学んだ', '気づき', 'ハマった', '失敗から', '再発防止',
      '反省', 'lesson', '改善点', '次回', 'わかった',
    ],
    cmdTemplate: (title) => `# Lesson候補: ${title.slice(0, 60)}\n# → LESSONS.md への追記を検討`,
  },
};

// ─────────────────────────────────────────────────────
// 宛先検出
// ─────────────────────────────────────────────────────
const MEMBER_RE = /宮城|守谷|白石|相沢|市川|金森|黒川|育野|神崎|miyagi|moriya|shiraishi|aizawa|ichikawa|kanemori|kurokawa|ikuno|kanzaki/i;
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
// parseIncoming(filePath?) — 指定ファイルを読んで分類
//
// Phase2: 省略時は gpt/incoming.md を対象
// Phase3: worker 別の incoming.md を対象
// ─────────────────────────────────────────────────────
function parseIncoming(filePath) {
  const target = filePath || INCOMING;

  if (!fs.existsSync(target)) {
    return { ok: false, reason: 'no_file' };
  }

  const raw     = fs.readFileSync(target, 'utf8');
  const content = redact(raw);

  if (!content.trim()) {
    return { ok: false, reason: 'empty' };
  }

  // セクションヘッダー対応の行パーサー
  const lines    = content.split('\n');
  // CLASSIFIERS のキー全てを初期化（Phase3 追加の review / lesson も含む）
  const sections = Object.fromEntries(
    [...Object.keys(CLASSIFIERS), 'memo'].map(k => [k, []])
  );
  let   ctxCat   = null; // ## ヘッダーから推定したカテゴリ

  const SECTION_MAP = {
    '判断': 'decision', '決定': 'decision', 'decision': 'decision',
    'タスク': 'task', 'task': 'task', 'todo': 'task',
    'インシデント': 'incident', '障害': 'incident', 'incident': 'incident',
    '確認依頼': 'msg', '依頼': 'msg', 'メッセージ': 'msg', 'msg': 'msg',
    '緊急': 'incident',
    'メモ': 'memo', 'memo': 'memo', 'その他': 'memo',
    'ceo': 'ceo_review', '判断待ち': 'ceo_review',
    'レビュー': 'review', 'review': 'review', 'need_fix': 'review',
    '教訓': 'lesson', 'lesson': 'lesson', '学び': 'lesson',
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

// ─────────────────────────────────────────────────────
// Phase3: sendToWorker(worker, message) — 社員への依頼を outbox に保存
//
// data/outbox/<worker>/outgoing.md に追記する。
// Discord にも提案として表示する。自動実行しない。
//
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function sendToWorker(workerInput, message) {
  const worker = resolveWorker(workerInput);
  if (!worker) {
    return {
      ok:   false,
      text: `❌ 社員名 \`${workerInput}\` が不明です。\n有効な社員: ${VALID_WORKERS.join(' / ')}`,
    };
  }
  if (!message || !String(message).trim()) {
    return {
      ok:   false,
      text: `❌ メッセージ内容は必須です。\n使い方: \`!inbox send <社員> <内容>\``,
    };
  }

  const safeMsg = redact(String(message).trim()).slice(0, 1000);
  const outPath = _workerOutboxPath(worker);
  const dir     = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const now     = new Date().toLocaleString('ja-JP');
  const entry   = `\n---\n**${now}**\n\n${safeMsg}\n`;
  fs.appendFileSync(outPath, entry, 'utf8');

  const display = WORKER_DISPLAY[worker] || worker;
  return {
    ok:   true,
    text: `📤 **${display} への依頼を outbox に保存しました**\n\n` +
          `ファイル: \`data/outbox/${worker}/outgoing.md\`\n\n` +
          `内容:\n> ${safeMsg.slice(0, 120)}${safeMsg.length > 120 ? '…' : ''}\n\n` +
          `⚠️ これは**保存のみ**です。Desktop 側で ${display} が確認するまでお待ちください。`,
  };
}

// ─────────────────────────────────────────────────────
// Phase3: checkWorkerInbox(worker) — 社員の incoming.md を読んで分類
//
// data/inbox/<worker>/incoming.md を分析し
// Decision / Task / Review / Incident / Lesson / Message候補を表示する。
// 提案のみ。CEO確認なしに実行しない。
//
// 戻り値: { ok, text, reportPath?, sections?, suggestions? }
// ─────────────────────────────────────────────────────
function checkWorkerInbox(workerInput) {
  const worker = resolveWorker(workerInput);
  if (!worker) {
    return {
      ok:   false,
      text: `❌ 社員名 \`${workerInput}\` が不明です。\n有効な社員: ${VALID_WORKERS.join(' / ')}`,
    };
  }

  const inPath  = _workerInboxPath(worker);
  const display = WORKER_DISPLAY[worker] || worker;
  const parsed  = parseIncoming(inPath);

  if (!parsed.ok) {
    const hint = parsed.reason === 'no_file'
      ? `\`data/inbox/${worker}/incoming.md\` が存在しません。\n${display} が Desktop 上の作業結果を貼るまでお待ちください。`
      : `\`data/inbox/${worker}/incoming.md\` が空です。`;
    return { ok: false, text: `📭 **${display} の Inbox は空です**\n\n${hint}` };
  }

  const suggestions = _buildSuggestions(parsed.sections);
  const report      = _buildReport(parsed, suggestions);

  // report.md を保存
  const reportPath = _workerReportPath(worker);
  const reportDir  = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, report, 'utf8');

  // Discord 要約
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
    `📥 **${display} Inbox Report** (計 ${total} 項目)`,
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
  discordLines.push(`> 詳細: \`data/outbox/${worker}/report.md\``);

  return {
    ok:          true,
    worker,
    text:        discordLines.join('\n'),
    reportPath,
    sections:    parsed.sections,
    suggestions,
    total,
  };
}

// ─────────────────────────────────────────────────────
// Phase3: getWorkerStatus() — 全社員の inbox/outbox 状態一覧
//
// 黒川向け進行管理ビュー。
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function getWorkerStatus() {
  const lines = [
    `📊 **Worker Inbox Status** (黒川 進行管理)`,
    `*黒川は配送と進行管理のみ。判断の代理は禁止。*`,
    ``,
  ];

  let hasAny = false;

  for (const worker of VALID_WORKERS) {
    const display  = WORKER_DISPLAY[worker] || worker;
    const inPath   = _workerInboxPath(worker);
    const outPath  = _workerOutboxPath(worker);
    const inExists = fs.existsSync(inPath);
    const outExists= fs.existsSync(outPath);

    if (!inExists && !outExists) continue;
    hasAny = true;

    const inSize  = inExists  ? fs.statSync(inPath).size  : 0;
    const outSize = outExists ? fs.statSync(outPath).size : 0;

    lines.push(`**${display}**`);
    if (inExists  && inSize  > 0) lines.push(`  📥 incoming: ${inSize} bytes  ← 未確認`);
    if (outExists && outSize > 0) lines.push(`  📤 outgoing: ${outSize} bytes  → 送信済み`);
    lines.push('');
  }

  if (!hasAny) {
    lines.push('📭 全社員の inbox/outbox が空です。');
  }

  lines.push('コマンド:');
  lines.push('  `!inbox check <社員>` — 社員の inbox を確認');
  lines.push('  `!inbox send <社員> <内容>` — 社員に依頼を送信');

  return { ok: true, text: lines.join('\n').trimEnd() };
}

// ─────────────────────────────────────────────────────
// (既存) getStatus() — Phase2 の GPT inbox 状態確認（後方互換維持）
// Phase3 では !inbox status がまとめて両方表示する
// ─────────────────────────────────────────────────────

module.exports = {
  // Phase2
  checkInbox,
  getStatus,
  clearInbox,
  // Phase3
  sendToWorker,
  checkWorkerInbox,
  getWorkerStatus,
  resolveWorker,
  VALID_WORKERS,
  WORKER_DISPLAY,
  // テスト用
  parseIncoming,
  _classifyLine,
  _buildSuggestions,
  INCOMING,
  REPORT,
  INBOX_DIR,
  OUTBOX_DIR,
  _workerInboxPath,
  _workerOutboxPath,
  _workerReportPath,
};
