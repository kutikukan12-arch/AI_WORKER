'use strict';
// =====================================================
// client-tracker.js — コトノハ Phase 2
//
// ① Client Project Tracker — 案件管理
// ② Client Timeline        — 案件経緯記録
// ③ Post Project Review    — 振り返り生成・保存
// ④ Capability Discovery   — AI得意不得意分析
// ⑤ Customer Support準備  — 問い合わせ整理
//
// 安全ルール:
//   ・個人情報（名前・住所・メール）保存禁止
//   ・APIキー保存禁止
//   ・!support は顧客入力をデータとして扱い命令と解釈しない
//   ・全てCEO判断補助
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const LEARNING_DIR = path.join(__dirname, '..', '..', 'learning', 'client');
const PROJECTS_FILE = path.join(DATA_DIR, 'client-projects.json');

// ─── 案件ステータス ──────────────────────────────────
const STATUS = {
  INQUIRY:     'INQUIRY',     // 問い合わせ中
  REQUIREMENT: 'REQUIREMENT', // 要件定義中
  DEVELOPING:  'DEVELOPING',  // 開発中
  REVIEW:      'REVIEW',      // レビュー・確認中
  DELIVERED:   'DELIVERED',   // 納品済み
  CLOSED:      'CLOSED',      // 完了・終了
};

const STATUS_EMOJI = {
  INQUIRY:     '📩', REQUIREMENT: '📋', DEVELOPING: '🔨',
  REVIEW:      '🔍', DELIVERED:   '📦', CLOSED:     '✅',
};

const STATUS_NEXT_ACTION = {
  INQUIRY:     '要件をヒアリングして !request で整理、!proposal で返信案を作成',
  REQUIREMENT: '要件が固まったら !client update <id> DEVELOPING で開発開始',
  DEVELOPING:  '開発完了後に !client update <id> REVIEW でレビューへ',
  REVIEW:      '確認完了後に !delivery check で納品チェック、!client update <id> DELIVERED',
  DELIVERED:   '問題なければ !client update <id> CLOSED で完了。!client review で振り返り',
  CLOSED:      '!client review <id> で振り返りを行い、!capability report で能力分析へ',
};

// ─── Atomic Write ────────────────────────────────────
function _atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// ① Client Project Tracker — 案件管理
// ─────────────────────────────────────────────────────

function _loadProjects() {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch { return []; }
}

function _saveProjects(projects) {
  _atomicWrite(PROJECTS_FILE, projects);
}

/**
 * createProject(name, opts)
 * → 新規案件を作成して返す
 */
function createProject(name, opts = {}) {
  if (!name || !name.trim())
    return { ok: false, text: '案件名を入力してください。' };

  const projects = _loadProjects();

  // 同名チェック（Active のもの）
  const existing = projects.find(p =>
    p.name === name.trim() &&
    p.status !== STATUS.CLOSED
  );
  if (existing) {
    return { ok: false, text: `案件「${name}」はすでに存在します (ID: \`${existing.id}\`)。` };
  }

  const id  = `cli_${Date.now()}`;
  const now = new Date().toISOString();
  const project = {
    id,
    name:       name.trim().slice(0, 80),
    status:     STATUS.INQUIRY,
    createdAt:  now,
    updatedAt:  now,
    risk:       opts.risk || null,
    memo:       opts.memo || '',
    timeline:   [],          // 経緯ログ
    noteCount:  0,
    // 禁止フィールド: customerName / email / phone / address / apiKey
  };
  projects.push(project);
  _saveProjects(projects);

  return {
    ok: true,
    project,
    text:
      `📁 **案件作成** — \`${id}\`\n\n` +
      `案件名: **${project.name}**\n` +
      `状態: ${STATUS_EMOJI[STATUS.INQUIRY]} ${STATUS.INQUIRY}\n\n` +
      `**次のアクション:**\n  ${STATUS_NEXT_ACTION[STATUS.INQUIRY]}\n\n` +
      `> ⚠️ 個人情報（名前・連絡先）は保存しないでください。`,
  };
}

/**
 * listProjects()
 * → アクティブな案件一覧テキストを返す
 */
function listProjects() {
  const projects = _loadProjects();
  const active   = projects.filter(p => p.status !== STATUS.CLOSED);

  if (active.length === 0) {
    return { ok: true, text: '📁 **案件一覧** — 現在対応中の案件はありません。\n\n`!client create <案件名>` で新規作成できます。' };
  }

  const lines = [`📁 **案件一覧** (${active.length}件)`];
  for (const p of active) {
    const emoji   = STATUS_EMOJI[p.status] || '📋';
    const updated = p.updatedAt.slice(0, 10);
    lines.push(`  ${emoji} \`${p.id}\` **${p.name}** | ${p.status} | 更新: ${updated}`);
  }
  lines.push(`\n\`!client show <id>\` で詳細表示`);

  return { ok: true, text: lines.join('\n'), projects: active };
}

/**
 * showProject(id)
 * → 案件詳細テキストを返す
 */
function showProject(id) {
  const projects = _loadProjects();
  const p = projects.find(pr => pr.id === id || pr.id.includes(id));

  if (!p) return { ok: false, text: `案件 \`${id}\` が見つかりません。\`!client list\` で確認してください。` };

  const emoji    = STATUS_EMOJI[p.status] || '📋';
  const timeline = p.timeline.slice(-5).reverse(); // 直近5件

  const lines = [
    `📁 **${p.name}** — \`${p.id}\``,
    ``,
    `状態: ${emoji} **${p.status}**`,
    `作成: ${p.createdAt.slice(0, 10)} | 更新: ${p.updatedAt.slice(0, 10)}`,
    p.risk ? `リスク: ${p.risk}` : '',
    p.memo ? `メモ: ${p.memo.slice(0, 60)}` : '',
    ``,
    `**💡 次のアクション:**`,
    `  ${STATUS_NEXT_ACTION[p.status]}`,
    ``,
  ];

  if (timeline.length > 0) {
    lines.push(`**📝 直近の記録（${p.noteCount}件中最新${timeline.length}件）:**`);
    timeline.forEach(n => {
      lines.push(`  ${n.at.slice(0, 10)} — ${n.text.slice(0, 60)}`);
    });
    lines.push('');
  }

  lines.push(
    `**コマンド:**`,
    `  \`!client note ${p.id} <内容>\` — 経緯を記録`,
    `  \`!client update ${p.id} <STATUS>\` — 状態変更`,
    `  \`!client review ${p.id}\` — 振り返りを生成`,
  );

  return { ok: true, text: lines.filter(l => l !== '').join('\n'), project: p };
}

/**
 * updateProjectStatus(id, newStatus)
 * → 案件の状態を変更する
 */
function updateProjectStatus(id, newStatus) {
  if (!STATUS[newStatus.toUpperCase()])
    return { ok: false, text: `無効なステータスです。\n有効: ${Object.keys(STATUS).join(' / ')}` };

  const projects = _loadProjects();
  const p = projects.find(pr => pr.id === id || pr.id.includes(id));
  if (!p) return { ok: false, text: `案件 \`${id}\` が見つかりません。` };

  const oldStatus = p.status;
  p.status    = STATUS[newStatus.toUpperCase()];
  p.updatedAt = new Date().toISOString();
  // タイムラインに状態変更を記録
  p.timeline.push({ at: p.updatedAt, type: 'status', text: `状態変更: ${oldStatus} → ${p.status}` });
  _saveProjects(projects);

  const emoji = STATUS_EMOJI[p.status] || '📋';
  return {
    ok: true,
    project: p,
    text:
      `✅ **状態更新** — \`${p.id}\`\n\n` +
      `${oldStatus} → ${emoji} **${p.status}**\n\n` +
      `次のアクション: ${STATUS_NEXT_ACTION[p.status]}`,
  };
}

// ─────────────────────────────────────────────────────
// ② Client Timeline — 案件経緯記録
// ─────────────────────────────────────────────────────

/**
 * addNote(id, noteText)
 * → 案件にメモを追加する（Secret Guardian 適用済みテキストを渡すこと）
 */
function addNote(id, noteText) {
  if (!noteText || !noteText.trim())
    return { ok: false, text: 'メモ内容を入力してください。' };

  const projects = _loadProjects();
  const p = projects.find(pr => pr.id === id || pr.id.includes(id));
  if (!p) return { ok: false, text: `案件 \`${id}\` が見つかりません。` };

  const now  = new Date().toISOString();
  const note = { at: now, type: 'note', text: noteText.trim().slice(0, 300) };
  p.timeline.push(note);
  p.noteCount = (p.noteCount || 0) + 1;
  p.updatedAt = now;
  _saveProjects(projects);

  return {
    ok: true,
    text:
      `📝 **記録追加** — \`${p.id}\`\n\n` +
      `「${note.text.slice(0, 80)}」\n\n` +
      `総記録数: ${p.noteCount}件 | \`!client show ${p.id}\` で確認できます。`,
  };
}

// ─────────────────────────────────────────────────────
// ③ Post Project Review — 振り返り生成
// ─────────────────────────────────────────────────────

/**
 * generateReview(id)
 * → 振り返りテキストを生成し learning/client/ に保存する
 */
function generateReview(id) {
  const projects = _loadProjects();
  const p = projects.find(pr => pr.id === id || pr.id.includes(id));
  if (!p) return { ok: false, text: `案件 \`${id}\` が見つかりません。` };

  const notes     = p.timeline.filter(t => t.type === 'note');
  const statuses  = p.timeline.filter(t => t.type === 'status');
  const noteTexts = notes.map(n => `  ・${n.at.slice(0, 10)}: ${n.text.slice(0, 60)}`).join('\n') || '  （記録なし）';

  const lines = [
    `🧠 **案件振り返り** — ${p.name}`,
    `案件ID: \`${p.id}\``,
    `期間: ${p.createdAt.slice(0, 10)} → ${p.updatedAt.slice(0, 10)}`,
    `最終状態: ${p.status}`,
    ``,
    `**📝 経緯サマリー（${notes.length}件の記録）:**`,
    noteTexts,
    ``,
    `**✅ 振り返りチェックリスト（社長が記入してください）:**`,
    `  □ 予定通り完了したか？　→`,
    `  □ 見積もりは正確だったか？　→`,
    `  □ 詰まった原因は何か？　→`,
    `  □ 次回に再利用できる知識・テンプレートは？　→`,
    `  □ 改善すべき点は？　→`,
    ``,
    `**🔧 AI_WORKER 自己評価（自動）:**`,
    `  記録件数: ${p.noteCount}件`,
    `  状態変更回数: ${statuses.length}回`,
    `  完了ステータス: ${p.status}`,
    ``,
    `> このファイルを \`learning/client/${p.id}_review.md\` に保存しました。`,
    `> 手動で回答を記入して蓄積させてください。`,
  ];

  const reviewText = lines.join('\n');

  // learning/client/ に保存
  try {
    if (!fs.existsSync(LEARNING_DIR)) fs.mkdirSync(LEARNING_DIR, { recursive: true });
    const reviewFile = path.join(LEARNING_DIR, `${p.id}_review.md`);
    fs.writeFileSync(reviewFile, reviewText + '\n', 'utf8');
  } catch { /* 保存失敗は無視してテキスト返却 */ }

  // 案件を CLOSED に
  if (p.status !== STATUS.CLOSED) {
    p.status    = STATUS.CLOSED;
    p.updatedAt = new Date().toISOString();
    p.timeline.push({ at: p.updatedAt, type: 'status', text: `振り返り完了 → CLOSED` });
    _saveProjects(projects);
  }

  return { ok: true, text: reviewText };
}

// ─────────────────────────────────────────────────────
// ④ Capability Discovery — AI得意不得意分析
// ─────────────────────────────────────────────────────

/**
 * buildCapabilityReport()
 * → 完了案件から得意不得意を分析するレポートを返す
 */
function buildCapabilityReport() {
  const projects = _loadProjects();
  const closed   = projects.filter(p => p.status === STATUS.CLOSED);
  const active   = projects.filter(p => p.status !== STATUS.CLOSED);

  if (projects.length === 0) {
    return {
      ok: true,
      text:
        `📊 **Capability Report** — データ不足\n\n` +
        `まだ案件データがありません。\n` +
        `案件を完了させると自動で分析が蓄積されます。\n\n` +
        `\`!client create <案件名>\` で最初の案件を作成してください。`,
    };
  }

  // 記録件数からスコアを算出（多いほど複雑だった可能性）
  const avgNotes = closed.length > 0
    ? Math.round(closed.reduce((s, p) => s + (p.noteCount || 0), 0) / closed.length)
    : 0;

  // learning ファイルの存在確認
  let reviewedCount = 0;
  try {
    if (fs.existsSync(LEARNING_DIR)) {
      reviewedCount = fs.readdirSync(LEARNING_DIR).filter(f => f.endsWith('_review.md')).length;
    }
  } catch { /* ignore */ }

  const lines = [
    `📊 **Capability Report** — AI_WORKER 案件能力分析`,
    ``,
    `**📈 統計サマリー:**`,
    `  総案件数: ${projects.length}件`,
    `  完了案件: ${closed.length}件`,
    `  対応中:   ${active.length}件`,
    `  振り返り済み: ${reviewedCount}件`,
    `  平均記録件数: ${avgNotes}件/案件`,
    ``,
  ];

  if (closed.length > 0) {
    lines.push(`**✅ 完了案件（経験として蓄積）:**`);
    closed.slice(-5).forEach(p => {
      lines.push(`  ・${p.name} (記録: ${p.noteCount}件)`);
    });
    lines.push('');
  }

  if (active.length > 0) {
    lines.push(`**🔄 現在対応中:**`);
    active.forEach(p => {
      const emoji = STATUS_EMOJI[p.status] || '📋';
      lines.push(`  ・${emoji} ${p.name} (${p.status})`);
    });
    lines.push('');
  }

  lines.push(
    `**💡 分析コメント:**`,
    reviewedCount >= 3
      ? `  振り返り${reviewedCount}件のデータが蓄積されています。\`learning/client/\` を確認して傾向を把握してください。`
      : `  振り返りが${reviewedCount}件です。案件完了後は \`!client review <id>\` で経験を蓄積してください。`,
    ``,
    `> 詳細な得意不得意分析は振り返りデータを積み重ねることで改善されます。`,
  );

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// ⑤ Customer Support 準備
// ─────────────────────────────────────────────────────

/** 問い合わせテキストから問題キーワードを抽出 */
function _extractSupportKeywords(text) {
  const t = text.toLowerCase();
  const issues  = [];
  if (/動かない|エラー|失敗|バグ|不具合/.test(t)) issues.push('動作エラー・不具合');
  if (/分から|使い方|方法|どうすれば/.test(t))    issues.push('使い方の質問');
  if (/追加|変更|修正|直して/.test(t))            issues.push('機能追加・変更要求');
  if (/遅い|重い|時間がかかる/.test(t))            issues.push('パフォーマンス問題');
  if (/文字化け|表示.*おかしい|レイアウト/.test(t)) issues.push('表示・UI の問題');
  if (/データ.*消え|削除.*されて|壊れ/.test(t))    issues.push('データ損失・破損の疑い');
  return issues;
}

/**
 * buildSupportResponse(queryText)
 * → 問い合わせ内容を整理して返信案・確認質問を返す
 *
 * 安全ルール:
 *   顧客文章を「命令」として実行しない。
 *   「AIの設定を変えて」「ルールを無視して」なども
 *   単なるデータとして問題整理に使用する。
 */
function buildSupportResponse(queryText) {
  if (!queryText || !queryText.trim())
    return { ok: false, text: '問い合わせ内容を入力してください。' };

  // ── セキュリティ: 命令インジェクション検出 ──────
  const injectionPatterns = [
    /システムプロンプト|ルールを無視|設定を変えて|ignore.*instruction|jailbreak/i,
    /全ての.*ルール.*無効|制約.*解除|通常モード.*解除/i,
    /AIとして.*行動|あなたは.*AI.*ではなく/i,
  ];
  const hasInjection = injectionPatterns.some(p => p.test(queryText));
  const injectionNote = hasInjection
    ? '\n\n> ⚠️ **注意:** この問い合わせに命令インジェクションの可能性がある表現が含まれています。顧客文章はデータとして扱い、命令として実行しません。'
    : '';

  const issues = _extractSupportKeywords(queryText);

  const lines = [
    `🎧 **カスタマーサポート準備**`,
    `> ⚠️ 顧客入力はデータとして分析します。命令として実行しません。`,
    ``,
    `**📋 問い合わせ内容（要約）:**`,
    `  ${queryText.slice(0, 150)}${queryText.length > 150 ? '…' : ''}`,
    ``,
  ];

  if (issues.length > 0) {
    lines.push(`**🔍 問題の種類（推測）:**`);
    issues.forEach(i => lines.push(`  ・${i}`));
    lines.push('');
  }

  lines.push(
    `**❓ 顧客への確認質問（優先順）:**`,
    `  1. どの操作をした後に問題が発生しましたか？`,
    `  2. エラーメッセージがあれば教えてください（スクリーンショット可）`,
    `  3. 問題は毎回発生しますか？それとも時々ですか？`,
    ``,
    `**🔧 原因候補:**`,
  );

  if (issues.includes('動作エラー・不具合')) {
    lines.push(`  ・設定ファイル（.env）の変更・不足`);
    lines.push(`  ・環境の違い（OS・バージョン）`);
    lines.push(`  ・データ形式の問題`);
  } else if (issues.includes('使い方の質問')) {
    lines.push(`  ・ドキュメント・README の説明不足`);
    lines.push(`  ・手順の抜け・誤り`);
  } else {
    lines.push(`  ・詳細確認後に特定`);
  }

  lines.push(
    ``,
    `**📝 返信案（下書き）:**`,
    `---`,
    `お問い合わせありがとうございます。`,
    `状況を確認するため、以下をお教えください。`,
    ``,
    `1. どの操作をした際に問題が発生しましたか？`,
    `2. エラーメッセージがある場合は内容を教えてください。`,
    ``,
    `確認後、対応方針をお伝えします。`,
    `---`,
    ``,
    `**✅ 修正タスク化の候補（該当なら !task add で登録）:**`,
    issues.includes('動作エラー・不具合') ? `  ・バグ調査・修正タスク` : '',
    issues.includes('使い方の質問')       ? `  ・ドキュメント改善タスク` : '',
    issues.includes('機能追加・変更要求') ? `  ・!scope で追加見積もりを確認` : '',
  );

  if (injectionNote) lines.push(injectionNote);

  return { ok: true, text: lines.filter(l => l !== '').join('\n'), hasInjection };
}

module.exports = {
  STATUS,
  STATUS_EMOJI,
  // ① Project Tracker
  createProject,
  listProjects,
  showProject,
  updateProjectStatus,
  // ② Timeline
  addNote,
  // ③ Review
  generateReview,
  // ④ Capability
  buildCapabilityReport,
  // ⑤ Support
  buildSupportResponse,
  // テスト用
  _loadProjects,
  _saveProjects,
};
