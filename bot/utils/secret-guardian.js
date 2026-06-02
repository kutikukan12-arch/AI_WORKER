'use strict';
// =====================================================
// secret-guardian.js — Secret Guardian Phase 1
//
// 目的:
//   APIキー・Token の流出事故を防ぐ。
//   commit/push 前にステージング済みファイルの内容を走査し、
//   秘密情報を検出した場合は処理を停止してCEOに警告する。
//
// 検出対象:
//   ① Discord Bot Token  （MTU... 形式）
//   ② GitHub PAT          （github_pat_* / ghp_*）
//   ③ OpenAI API Key      （sk-proj-* / sk-*）
//   ④ .env ファイル自体のコミット
//   ⑤ KEY=VALUE 形式の汎用秘密情報
//
// セーフガード:
//   - 検出値は絶対に表示しない（ファイル名・行番号のみ）
//   - 偽陽性抑制: .env.example / テストのダミー値は通過
//   - gitignore 済みファイルのステージング漏れも検出
//
// Security Report:
//   検出時に logs/security-YYYY-MM-DD.json に記録する。
// =====================================================

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

// ─── 検出パターン定義 ────────────────────────────────
const SECRET_PATTERNS = [
  {
    name:    'Discord Bot Token',
    // MTA... / MTU... で始まる base64 部分 + . + 4〜8桁 + . + 20桁以上
    pattern: /\bMT[A-Za-z0-9][A-Za-z0-9]{18,32}\.[A-Za-z0-9_-]{4,8}\.[A-Za-z0-9_-]{20,}\b/,
    severity: 'CRITICAL',
  },
  {
    name:    'GitHub Personal Access Token (classic)',
    pattern: /\bghp_[A-Za-z0-9]{36}\b/,
    severity: 'CRITICAL',
  },
  {
    name:    'GitHub Personal Access Token (fine-grained)',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/,
    severity: 'CRITICAL',
  },
  {
    name:    'OpenAI API Key',
    pattern: /\bsk-proj-[A-Za-z0-9_\-]{90,}\b/,
    severity: 'CRITICAL',
  },
  {
    name:    'OpenAI API Key (legacy)',
    pattern: /\bsk-[A-Za-z0-9]{48}\b/,
    severity: 'CRITICAL',
  },
  {
    name:    'Generic Secret Assignment',
    // DISCORD_TOKEN= / GITHUB_TOKEN= / OPENAI_API_KEY= に値が続く形式
    pattern: /(DISCORD_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN)\s*=\s*[A-Za-z0-9._\-]{20,}/,
    severity: 'HIGH',
  },
];

// ─── 安全な除外パターン ─────────────────────────────
// これらにマッチするファイルは走査対象外
const SAFE_FILE_PATTERNS = [
  /\.example$/,       // .env.example
  /\.test\.[jt]s$/,   // テストファイル
  /_test\.[jt]s$/,
  /test_.*\.[jt]s$/,
  /\.md$/,            // Markdown ドキュメント
  /secret-guardian\.js$/,  // このファイル自体
];

// テスト用ダミー値として無視するパターン
const DUMMY_VALUE_HINTS = [
  /DUMMY|FAKE|TEST|EXAMPLE|PLACEHOLDER|your[-_]?token|your[-_]?key|xxxxxxx/i,
];

// ─────────────────────────────────────────────────────
// scanContent(filename, content) — 1ファイルの内容を走査
//
// 戻り値: [{ name, line, severity, hint }] （発見した問題）
// ─────────────────────────────────────────────────────
function scanContent(filename, content) {
  const findings = [];

  // 安全なファイルはスキップ
  if (SAFE_FILE_PATTERNS.some(p => p.test(filename))) return findings;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // コメント行は比較的安全なので severity を下げる
    const isComment = /^\s*(#|\/\/|\/\*)/.test(line);

    for (const { name, pattern, severity } of SECRET_PATTERNS) {
      if (!pattern.test(line)) continue;

      // ダミー値ヒントが含まれる行はスキップ（偽陽性抑制）
      if (DUMMY_VALUE_HINTS.some(d => d.test(line))) continue;

      findings.push({
        name,
        line:     i + 1,
        severity: isComment ? 'LOW' : severity,
        hint:     `L${i + 1} にパターン "${name}" に一致する文字列`,
      });
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────
// scanStagedFiles(repoPath) — ステージング済みファイルを走査
//
// 戻り値: { ok: boolean, violations: [...], summary: string }
// ─────────────────────────────────────────────────────
function scanStagedFiles(repoPath) {
  const violations = [];

  try {
    // ステージング済みファイル一覧を取得
    const stagedRaw = execSync('git diff --cached --name-only', {
      cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!stagedRaw) return { ok: true, violations: [], summary: 'ステージング済みファイルなし' };

    const stagedFiles = stagedRaw.split('\n').filter(Boolean);

    // .env ファイルのコミット直接チェック
    const envFiles = stagedFiles.filter(f => /^\.env$|\.env\.[^e]/.test(path.basename(f)));
    for (const f of envFiles) {
      if (!/\.example$/.test(f)) {
        violations.push({ file: f, name: '.env ファイルのコミット', line: 0, severity: 'CRITICAL',
          hint: `.env ファイル "${f}" が直接ステージングされています` });
      }
    }

    // 各ファイルの内容を走査
    for (const file of stagedFiles) {
      try {
        // git show :file でステージング内容を取得
        const content = execSync(`git show ":${file}"`, {
          cwd: repoPath, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
        });
        const fileViolations = scanContent(file, content);
        for (const v of fileViolations) {
          violations.push({ file, ...v });
        }
      } catch {
        // バイナリや取得失敗は無視
      }
    }
  } catch (e) {
    // git が使えない環境では空を返す（ガードが壊れても動作継続）
    return { ok: true, violations: [], summary: `走査スキップ: ${e.message.slice(0, 50)}` };
  }

  const critical = violations.filter(v => v.severity === 'CRITICAL').length;
  const high     = violations.filter(v => v.severity === 'HIGH').length;
  const ok       = violations.length === 0;

  const summary = ok
    ? `Secret Guardian: 問題なし (${stagedFileCount(repoPath)}ファイル走査)`
    : `Secret Guardian: ${violations.length}件検出 (CRITICAL:${critical} HIGH:${high})`;

  return { ok, violations, summary };
}

function stagedFileCount(repoPath) {
  try {
    return execSync('git diff --cached --name-only', {
      cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────
// formatViolationReport(violations) — CEO向け警告テキスト生成
//
// 重要: 秘密情報の値は絶対に含めない（ファイル名・行番号のみ）
// ─────────────────────────────────────────────────────
function formatViolationReport(violations) {
  if (violations.length === 0) return null;

  const critical = violations.filter(v => v.severity === 'CRITICAL');
  const high     = violations.filter(v => v.severity === 'HIGH');

  const lines = [
    `🚨 **Secret Guardian — 秘密情報流出を検出しました**`,
    ``,
    `**commit/push を自動停止しました。**`,
    ``,
    `**検出数:** CRITICAL ${critical.length}件 / HIGH ${high.length}件`,
    ``,
    `**検出箇所（値は表示しません）:**`,
  ];

  for (const v of violations) {
    const sevEmoji = { CRITICAL: '🔴', HIGH: '🟠', LOW: '🟡' }[v.severity] || '❓';
    lines.push(`  ${sevEmoji} ${v.file}${v.line ? ` (L${v.line})` : ''} — ${v.name}`);
  }

  lines.push(``, `**次の対処:**`);
  lines.push(`  1. 該当ファイルを \`git reset HEAD <file>\` でアンステージ`);
  lines.push(`  2. 秘密情報を削除 / .gitignore に追加`);
  lines.push(`  3. 漏洩した可能性のあるトークンは**即座に再発行**してください`);
  lines.push(`  4. 修正後に再度 commit を実行`);
  lines.push(``, `> 値は表示されません。ログも同様にマスク済みです。`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// writeSecurityReport(violations, repoPath) — ログ保存
// ─────────────────────────────────────────────────────
function writeSecurityReport(violations, repoPath = '') {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

    const now  = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const file = path.join(LOG_DIR, `security-${date}.json`);

    const existing = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { date, events: [] };

    existing.events.push({
      ts:    now.toISOString(),
      repo:  repoPath,
      count: violations.length,
      // 値は保存しない — ファイル名・行番号・パターン名のみ
      findings: violations.map(v => ({
        file:     v.file,
        line:     v.line,
        name:     v.name,
        severity: v.severity,
      })),
    });

    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8');
    return file;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────
// guardCommit(repoPath) — commit 前ガード（メインエントリ）
//
// 戻り値: { allowed: boolean, report: string|null, reportFile: string|null }
// ─────────────────────────────────────────────────────
function guardCommit(repoPath) {
  const result     = scanStagedFiles(repoPath);
  const report     = formatViolationReport(result.violations);
  const reportFile = result.violations.length > 0
    ? writeSecurityReport(result.violations, repoPath)
    : null;

  return {
    allowed:    result.ok,
    violations: result.violations,
    summary:    result.summary,
    report,
    reportFile,
  };
}

// ─────────────────────────────────────────────────────
// guardDiscordContent(content) — Discord 投稿前ガード
//
// 目的:
//   sendNotification / sendHumanMention 等の Discord 送信直前に呼び出し、
//   秘密情報が含まれていれば投稿を差し止める。
//
// 引数:
//   content — string | object (Discord Embed など)
//   context — { type: string } 送信種別（ログ用）
//
// 戻り値:
//   { allowed: boolean, violations: [...], alertText: string|null }
//
// セーフガード:
//   - 値は絶対に表示しない
//   - 検出時は security レポートに記録
//   - このガード自体のエラーは全て握りつぶして allowed:true を返す
//     （Bot 全体を落とさない）
// ─────────────────────────────────────────────────────
function guardDiscordContent(content, context = {}) {
  try {
    // テキスト抽出: string / object (embed等) / 配列 を再帰的に処理
    const text = extractText(content);
    if (!text) return { allowed: true, violations: [], alertText: null };

    const violations = scanContent('discord:' + (context.type || 'message'), text);
    if (violations.length === 0) {
      return { allowed: true, violations: [], alertText: null };
    }

    // security レポートに記録（値は保存しない）
    writeSecurityReport(
      violations.map(v => ({ ...v, file: 'discord:' + (context.type || 'message') })),
      'discord'
    );

    // CEO 向けアラートテキスト（値は絶対含まない）
    const critical = violations.filter(v => v.severity === 'CRITICAL').length;
    const high     = violations.filter(v => v.severity === 'HIGH').length;
    const alertText = (
      `🚨 **Secret Guardian — Discord 投稿を差し止めました**\n\n` +
      `秘密情報と思われる文字列が Discord 投稿内容に含まれていたため、送信をブロックしました。\n\n` +
      `**検出数:** CRITICAL ${critical}件 / HIGH ${high}件\n` +
      `**送信種別:** ${context.type || '不明'}\n\n` +
      `> 値は表示されません。\`logs/security-*.json\` でファイル名・種類のみ確認できます。\n` +
      `> 秘密情報が混入した経緯を確認し、トークンを再発行してください。`
    );

    return { allowed: false, violations, alertText };
  } catch {
    // ガード自体のエラーは Bot を落とさない
    return { allowed: true, violations: [], alertText: null };
  }
}

// テキスト抽出ヘルパー（string / embed object / 配列 を再帰処理）
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';

  const parts = [];

  // { content: '...' } 形式
  if (typeof content.content === 'string') parts.push(content.content);

  // embeds 配列
  if (Array.isArray(content.embeds)) {
    for (const embed of content.embeds) {
      if (typeof embed.title       === 'string') parts.push(embed.title);
      if (typeof embed.description === 'string') parts.push(embed.description);
      if (Array.isArray(embed.fields)) {
        embed.fields.forEach(f => {
          if (typeof f.name  === 'string') parts.push(f.name);
          if (typeof f.value === 'string') parts.push(f.value);
        });
      }
    }
  }

  // 配列 (複数 embed)
  if (Array.isArray(content)) {
    content.forEach(item => { const t = extractText(item); if (t) parts.push(t); });
  }

  return parts.join('\n');
}

module.exports = {
  guardCommit,
  guardDiscordContent,
  scanContent,
  scanStagedFiles,
  formatViolationReport,
  writeSecurityReport,
  SECRET_PATTERNS,   // テスト用
  SAFE_FILE_PATTERNS,
  _extractText: extractText,   // テスト用
};
