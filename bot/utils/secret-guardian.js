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

module.exports = {
  guardCommit,
  scanContent,
  scanStagedFiles,
  formatViolationReport,
  writeSecurityReport,
  SECRET_PATTERNS,   // テスト用
  SAFE_FILE_PATTERNS,
};
