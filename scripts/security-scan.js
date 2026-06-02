'use strict';
// =====================================================
// scripts/security-scan.js — Security Phase 2
//
// 目的:
//   過去 commit / logs / reviews / reports /
//   workspace / data ディレクトリの秘密情報残留を検査する。
//
// 使い方:
//   node scripts/security-scan.js [options]
//
//   --dirs <list>   スキャン対象ディレクトリをカンマ区切りで指定
//                   例: --dirs logs,reviews,data
//                   デフォルト: logs,reviews,reports,workspace,data
//   --git           git 履歴コミットも走査（時間がかかる）
//   --no-git        git 履歴をスキップ（デフォルト）
//   --output <path> レポート出力先を指定
//                   デフォルト: logs/security-scan-YYYY-MM-DD.json
//   --quiet         サマリーのみ表示（詳細ログを抑制）
//   --help          ヘルプを表示
//
// 保証:
//   - 検出値は絶対に表示しない（ファイル名・行番号・種類のみ）
//   - 自動削除・変更は行わない（読み取り専用）
//   - 履歴改変・force push は行わない
// =====================================================

const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const ROOT_DIR   = path.join(__dirname, '..');
const LOG_DIR    = path.join(ROOT_DIR, 'logs');

// secret-guardian の検出ロジックを再利用
const { scanContent, SAFE_FILE_PATTERNS } = require('../bot/utils/secret-guardian');

// ─── CLI 引数パース ──────────────────────────────────
function parseArgs(argv) {
  const args = { dirs: null, git: false, output: null, quiet: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dirs':   args.dirs   = argv[++i]?.split(',').map(s => s.trim()); break;
      case '--git':    args.git    = true; break;
      case '--no-git': args.git    = false; break;
      case '--output': args.output = argv[++i]; break;
      case '--quiet':  args.quiet  = true; break;
      case '--help':   args.help   = true; break;
    }
  }
  return args;
}

// ─── ディレクトリを再帰的にスキャン ─────────────────
const TEXT_EXTS = new Set([
  '.js', '.ts', '.json', '.md', '.txt', '.log', '.env', '.yaml', '.yml',
  '.sh', '.ps1', '.bat', '.csv', '.jsonl', '.conf', '.ini', '.toml',
]);

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTS.has(ext) || ext === '';
}

function scanDirectory(dirPath, quiet = false) {
  const findings = [];
  if (!fs.existsSync(dirPath)) return findings;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath  = path.relative(ROOT_DIR, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // node_modules / .git は除外
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      findings.push(...scanDirectory(fullPath, quiet));
    } else if (entry.isFile() && isTextFile(fullPath)) {
      try {
        const content  = fs.readFileSync(fullPath, 'utf8');
        const fileFnds = scanContent(relPath, content);
        if (fileFnds.length > 0) {
          if (!quiet) {
            fileFnds.forEach(f =>
              console.warn(`  ⚠️  ${relPath} L${f.line} — ${f.name} [${f.severity}]`)
            );
          }
          findings.push(...fileFnds.map(f => ({ ...f, file: relPath, source: 'filesystem' })));
        }
      } catch { /* バイナリ・読取不可はスキップ */ }
    }
  }
  return findings;
}

// ─── git 履歴をスキャン ──────────────────────────────
// 各コミットのファイル内容を検査する（大量コミット時は時間がかかる）
function scanGitHistory(repoPath, quiet = false) {
  const findings = [];
  try {
    const commits = execSync('git log --format="%H" --max-count=200', {
      cwd: repoPath, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean);

    if (!quiet) console.log(`  git 履歴: ${commits.length} コミットをスキャン中...`);

    for (const commitHash of commits) {
      try {
        // このコミットで変更されたファイル一覧
        const files = execSync(
          `git diff-tree --no-commit-id -r --name-only ${commitHash}`,
          { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim().split('\n').filter(Boolean);

        for (const file of files) {
          if (!isTextFile(file)) continue;
          // SAFE_FILE_PATTERNS に合致するものはスキップ
          if (SAFE_FILE_PATTERNS.some(p => p.test(file))) continue;

          try {
            const content = execSync(`git show ${commitHash}:${file}`, {
              cwd: repoPath, encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
              maxBuffer: 512 * 1024,
            });
            const fileFnds = scanContent(file, content);
            if (fileFnds.length > 0) {
              const shortHash = commitHash.slice(0, 8);
              if (!quiet) {
                fileFnds.forEach(f =>
                  console.warn(`  ⚠️  [git:${shortHash}] ${file} L${f.line} — ${f.name} [${f.severity}]`)
                );
              }
              findings.push(...fileFnds.map(f => ({
                ...f,
                file,
                commit:  shortHash,
                source: 'git_history',
              })));
            }
          } catch { /* 取得失敗はスキップ */ }
        }
      } catch { /* コミット処理失敗はスキップ */ }
    }
  } catch (e) {
    if (!quiet) console.warn(`  git 履歴スキャンスキップ: ${e.message.slice(0, 60)}`);
  }
  return findings;
}

// ─── Security Scan レポートを保存 ────────────────────
function writeScanReport(findings, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const report = {
    scanAt:     new Date().toISOString(),
    totalFound: findings.length,
    bySeverity: {
      CRITICAL: findings.filter(f => f.severity === 'CRITICAL').length,
      HIGH:     findings.filter(f => f.severity === 'HIGH').length,
      LOW:      findings.filter(f => f.severity === 'LOW').length,
    },
    bySource: {
      filesystem:   findings.filter(f => f.source === 'filesystem').length,
      git_history:  findings.filter(f => f.source === 'git_history').length,
    },
    // 値は保存しない — ファイル名・行番号・パターン名・コミットハッシュのみ
    findings: findings.map(f => ({
      file:     f.file,
      line:     f.line,
      name:     f.name,
      severity: f.severity,
      source:   f.source,
      ...(f.commit ? { commit: f.commit } : {}),
    })),
  };

  const tmp = outputPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
    fs.renameSync(tmp, outputPath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  return report;
}

// ─── デフォルト出力パス ─────────────────────────────
function defaultOutputPath() {
  const now = new Date();
  const d   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return path.join(LOG_DIR, `security-scan-${d}.json`);
}

// ─── メイン ─────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
Security Phase 2 スキャナー

使い方:
  node scripts/security-scan.js [options]

オプション:
  --dirs <list>    スキャン対象ディレクトリ（カンマ区切り）
                   デフォルト: logs,reviews,reports,workspace,data
  --git            git 履歴もスキャン（max 200 コミット）
  --no-git         git 履歴をスキップ（デフォルト）
  --output <path>  レポート出力先
  --quiet          サマリーのみ表示
  --help           ヘルプ

注意:
  - 検出値は表示・保存しません（ファイル名・行番号・種類のみ）
  - 自動削除・変更は行いません（読み取り専用）
`);
    return;
  }

  const targetDirs = args.dirs || ['logs', 'reviews', 'reports', 'workspace', 'data'];
  const outputPath = args.output || defaultOutputPath();
  const quiet      = args.quiet;

  console.log('🔍 Security Scan Phase 2 開始');
  console.log(`対象: ${targetDirs.join(', ')}${args.git ? ' + git 履歴' : ''}`);
  console.log('');

  const allFindings = [];

  // ─ ファイルシステムスキャン ─
  for (const dirName of targetDirs) {
    const dirPath = path.join(ROOT_DIR, dirName);
    if (!fs.existsSync(dirPath)) {
      if (!quiet) console.log(`  スキップ (存在しない): ${dirName}/`);
      continue;
    }
    if (!quiet) console.log(`  スキャン中: ${dirName}/`);
    const found = scanDirectory(dirPath, quiet);
    allFindings.push(...found);
    if (!quiet) console.log(`    → ${found.length}件検出`);
  }

  // ─ git 履歴スキャン ─
  if (args.git) {
    console.log('  git 履歴スキャン中...');
    const gitFound = scanGitHistory(ROOT_DIR, quiet);
    allFindings.push(...gitFound);
    if (!quiet) console.log(`    → ${gitFound.length}件検出`);
  }

  // ─ 重複除去（同ファイル・同行・同パターン）─
  const seen = new Set();
  const deduped = allFindings.filter(f => {
    const key = `${f.source}:${f.file}:${f.line}:${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ─ レポート保存 ─
  const report = writeScanReport(deduped, outputPath);

  console.log('');
  console.log('─────────────────────────────────');
  console.log('📊 スキャン結果サマリー');
  console.log(`  総検出数:    ${report.totalFound}件`);
  console.log(`  CRITICAL:    ${report.bySeverity.CRITICAL}件`);
  console.log(`  HIGH:        ${report.bySeverity.HIGH}件`);
  console.log(`  LOW:         ${report.bySeverity.LOW}件`);
  console.log(`  ファイル系:  ${report.bySource.filesystem}件`);
  console.log(`  git 履歴:    ${report.bySource.git_history}件`);
  console.log(`  レポート:    ${path.relative(ROOT_DIR, outputPath)}`);
  console.log('─────────────────────────────────');

  if (report.totalFound > 0) {
    console.log('');
    console.log('⚠️  秘密情報の残留が検出されました。');
    console.log('   値は表示・保存していません。ファイル名のみレポートに記録。');
    console.log('   手動で確認・削除してください。');
    process.exit(1); // CI 連携のため非ゼロで終了
  } else {
    console.log('✅ 秘密情報の残留は検出されませんでした。');
  }
}

// ─── スクリプトとして直接実行された場合のみ main を呼ぶ ─
if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { scanDirectory, scanGitHistory, writeScanReport, defaultOutputPath };
