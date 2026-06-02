'use strict';

// =====================================================
// github.js - GitHub 自動連携ユーティリティ
//
// 役割: Claude Code 完了後に以下を自動実行
//   1. git status で変更内容を確認
//   2. git add で変更をステージング
//   3. git commit でコミット（メッセージ自動生成）
//   4. git push で GitHub へ送信
//
// セキュリティ対策:
//   - GITHUB_TOKEN は .env のみで管理（コードに書かない）
//   - .env ファイルは .gitignore で除外済み
//   - 機密ファイルの誤コミット防止チェック付き
//   - Push は ENABLE_GITHUB=true の場合のみ実行
//
// 必要な .env 設定:
//   ENABLE_GITHUB=true
//   GITHUB_TOKEN=ghp_xxxxxxxxxx   （GitHub Personal Access Token）
//   GITHUB_REPO=username/repo     （例: tanaka/ai-worker-output）
//   GITHUB_BRANCH=main            （デフォルト: main）
//   GIT_REPO_PATH=D:\path\to\repo （省略時: AI_WORKERルート）
// =====================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

// ─── 設定（環境変数から取得）───
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;   // 例: username/repo-name
// GITHUB_BRANCH は push 先のデフォルト branch（未指定なら現在branch を使う）
const GITHUB_BRANCH_DEFAULT = process.env.GITHUB_BRANCH || null;

// git リポジトリのパス（デフォルト: AI_WORKER ルート）
const GIT_REPO_PATH = process.env.GIT_REPO_PATH
  || path.join(__dirname, '..', '..');

// ─────────────────────────────────────────────────────
// maskSecret(str) — ログ・エラーメッセージからトークン類をマスク
//
// 後方互換のため関数名・シグネチャは維持しつつ、実体は単一サニタイズ層
// redact.js #redact へ委譲する（マスク対象は redact.js のコメント参照）。
// 既存の呼び出し元（setTaskError / error.md / Discord / 各種ログ）は
// 変更不要で、JWT / 秘密鍵 / *_TOKEN 等の追加マスクも自動で効く。
// ─────────────────────────────────────────────────────
function maskSecret(str) {
  return require('./redact').redact(str);
}

// ─────────────────────────────────────────────────────
// sleepSyncMs(ms) — execSync 系の同期処理内で使えるブロッキング待機
// ─────────────────────────────────────────────────────
function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─────────────────────────────────────────────────────
// runGit(command, options, opts) — git コマンドの堅牢化ラッパ
//
// 背景: タスク実行用の Claude Code 子プロセスと push 処理が同一リポジトリの
//   git を同時に触ると、一時的に .git/index.lock 競合や rev-parse/status/add の
//   "Command failed" が発生する（手動では成功するが自動実行で散発）。
//   これにより isGitRepo() が誤って false を返し、不要な git init が走るなど
//   連鎖障害を起こしていた。
//
// 対策:
//   1. 実行前に index.lock が残っていれば短時間待つ（他プロセスの git 完了待ち）
//   2. 一時的失敗パターンに限り指数バックオフでリトライ
// ─────────────────────────────────────────────────────
function runGit(command, options = {}, { retries = 3, waitMs = 400 } = {}) {
  const repoPath = options.cwd;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    // index.lock が残っていれば最大 waitMs*3 まで待機
    if (repoPath) {
      const lock = path.join(repoPath, '.git', 'index.lock');
      let waited = 0;
      while (fs.existsSync(lock) && waited < waitMs * 3) {
        sleepSyncMs(150);
        waited += 150;
      }
    }
    try {
      return execSync(command, options);
    } catch (err) {
      lastErr = err;
      const transient =
        /index\.lock|another git process|cannot lock ref|unable to create|Command failed/i
          .test(err.message || '');
      if (attempt < retries && transient) {
        logger.warn(
          `git 一時失敗 (${attempt}/${retries}) 再試行: ${command.split(' ').slice(0, 3).join(' ')}`
        );
        sleepSyncMs(waitMs * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────
// 現在の git branch 名を取得（main/master 固定しない）
// ─────────────────────────────────────────────────────
function getCurrentBranch(repoPath) {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath, stdio: 'pipe', encoding: 'utf8',
    }).trim() || 'master';
  } catch {
    return 'master';
  }
}

// ─────────────────────────────────────────────────────
// git がインストールされているか確認
// ─────────────────────────────────────────────────────
function checkGitAvailable() {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────
// 指定フォルダが git リポジトリか確認
// ─────────────────────────────────────────────────────
function isGitRepo(dir) {
  try {
    // rev-parse の一時失敗で false を返すと不要な git init が走るためリトライする
    runGit('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────
// git のユーザー名・メールが設定されていなければデフォルト値を設定
// （未設定だと git commit が失敗する）
// ─────────────────────────────────────────────────────
function ensureGitConfig(repoPath) {
  const checks = [
    { key: 'user.name',  fallback: 'AI-Worker-Bot' },
    { key: 'user.email', fallback: 'ai-worker@bot.local' },
  ];
  for (const { key, fallback } of checks) {
    try {
      execSync(`git config ${key}`, { cwd: repoPath, stdio: 'pipe' });
    } catch {
      execSync(`git config user.name "${fallback}"`.replace('user.name', key), {
        cwd: repoPath, stdio: 'pipe'
      });
      // ↑ 上記は少しわかりにくいので正確に書く
    }
  }
  // 上記ループの書き方が不正確なので正確に修正
  const checkAndSet = (key, value) => {
    try {
      execSync(`git config ${key}`, { cwd: repoPath, stdio: 'pipe' });
    } catch {
      execSync(`git config ${key} "${value}"`, { cwd: repoPath, stdio: 'pipe' });
      logger.info(`git config ${key} を "${value}" に設定しました`);
    }
  };
  checkAndSet('user.name',  'AI-Worker-Bot');
  checkAndSet('user.email', 'ai-worker@bot.local');
}

// ─────────────────────────────────────────────────────
// 変更されたファイルの一覧を取得
// 戻り値例: ['M  bot/index.js', 'A  workspace/task_xxx/result.md']
// ─────────────────────────────────────────────────────
function getChangedFiles(repoPath) {
  try {
    const raw = runGit('git status --porcelain', {
      cwd: repoPath,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (!raw.trim()) return [];
    return raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
  } catch (err) {
    throw new Error(`git status の実行に失敗しました: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────
// コミットメッセージを自動生成
// 日本語対応のため一時ファイル経由で渡す
// ─────────────────────────────────────────────────────
function generateCommitMessage(prompt, taskId, changedFiles) {
  const timestamp = new Date().toLocaleString('ja-JP');

  // 変更内容のサマリ（最大8件まで表示）
  const fileSummary = changedFiles
    .slice(0, 8)
    .map(line => {
      const status = line.slice(0, 2).trim();
      const file   = line.slice(2).trim();
      const label  = { A: '追加', M: '変更', D: '削除', '??': '追加' }[status] || '変更';
      return `  - [${label}] ${file}`;
    })
    .join('\n');

  const hasNew = changedFiles.some(f => f.startsWith('A') || f.startsWith('??'));
  const type   = hasNew ? 'feat' : 'fix';
  const summary = prompt.slice(0, 55).replace(/[\r\n]+/g, ' ');

  const subject = `${type}: [AI] ${summary}`;
  const body = [
    `AI_WORKER 自動コミット`,
    `タスクID : ${taskId}`,
    `実行日時 : ${timestamp}`,
    ``,
    `変更ファイル (${changedFiles.length}件):`,
    fileSummary,
    changedFiles.length > 8 ? `  ... 他 ${changedFiles.length - 8}件` : '',
    ``,
    `依頼内容:`,
    prompt.slice(0, 200),
  ].filter(l => l !== undefined).join('\n');

  return { subject, body };
}

// ─────────────────────────────────────────────────────
// GitHub Push 用のリモート URL を設定（トークンを URL に埋め込まない）
//
// セキュリティ設計:
//   GITHUB_TOKEN は .git/config の remote URL に入れない。
//   push 時に HTTP Authorization ヘッダーで渡すことで
//   git remote -v にトークンが表示されないようにする。
// ─────────────────────────────────────────────────────
function configureGitHubRemote(repoPath) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    logger.info('GITHUB_TOKEN または GITHUB_REPO が未設定。Push をスキップします。');
    return false;
  }

  // トークンなしのクリーンな URL を remote に設定する
  const remoteUrl = `https://github.com/${GITHUB_REPO}.git`;

  try {
    const remotes = execSync('git remote', {
      cwd: repoPath, stdio: 'pipe', encoding: 'utf8'
    }).trim();

    if (remotes.includes('origin')) {
      // 既存 remote がトークン埋め込みになっていたら修正する
      const currentUrl = execSync('git remote get-url origin', {
        cwd: repoPath, stdio: 'pipe', encoding: 'utf8'
      }).trim();
      if (currentUrl !== remoteUrl) {
        execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: repoPath, stdio: 'pipe' });
        logger.info(`GitHub remote を修正: ${remoteUrl}`);
      }
    } else {
      execSync(`git remote add origin "${remoteUrl}"`, { cwd: repoPath, stdio: 'pipe' });
    }
    logger.info(`GitHub リモート確認済み: ${GITHUB_REPO}`);
    return true;
  } catch (err) {
    logger.warn(`GitHub リモート設定失敗: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────
// メイン関数: git add → commit → push を実行
//
// 戻り値:
//   { skipped: true, reason }               変更がない場合
//   { skipped: false, subject, changedFiles,
//     changedCount, pushed, pushError,
//     repoPath, branch, repo }              実行した場合
// ─────────────────────────────────────────────────────
async function commitAndPush(prompt, taskId) {
  // git が使えるか確認
  if (!checkGitAvailable()) {
    throw new Error(
      'git がインストールされていません。\n' +
      'https://git-scm.com からインストールしてください。'
    );
  }

  const repoPath = GIT_REPO_PATH;

  // git リポジトリが初期化されていなければ初期化
  if (!isGitRepo(repoPath)) {
    logger.info(`git init: ${repoPath}`);
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    try {
      execSync(`git checkout -b ${GITHUB_BRANCH}`, { cwd: repoPath, stdio: 'pipe' });
    } catch { /* すでにブランチがある場合は無視 */ }
  }

  // git ユーザー設定を確保
  ensureGitConfig(repoPath);

  // 変更ファイルを確認
  const changedFiles = getChangedFiles(repoPath);
  if (changedFiles.length === 0) {
    logger.info('git: 変更なし。コミットをスキップ。');
    return { skipped: true, reason: '変更されたファイルがありませんでした' };
  }

  // 機密ファイルの誤コミット防止チェック
  const sensitivePatterns = [/^[MA?].*\.env$/, /^[MA?].*credentials/, /^[MA?].*secret/i];
  const sensitiveFiles = changedFiles.filter(f =>
    sensitivePatterns.some(p => p.test(f.slice(2).trim()))
  );
  if (sensitiveFiles.length > 0) {
    logger.warn(`機密ファイルを検出: ${sensitiveFiles.join(', ')} → コミット対象から除外します`);
    for (const f of sensitiveFiles) {
      const filePath = f.slice(2).trim();
      try { execSync(`git reset -- "${filePath}"`, { cwd: repoPath, stdio: 'pipe' }); } catch { /* ignore */ }
    }
  }

  // git add
  logger.info(`git add: ${changedFiles.length}件の変更をステージング`);
  runGit('git add .', { cwd: repoPath, stdio: 'pipe' });

  // ─── Secret Guardian: commit 前秘密情報スキャン ────
  try {
    const secretGuardian = require('./secret-guardian');
    const guard = secretGuardian.guardCommit(repoPath);
    if (!guard.allowed) {
      logger.error(`[SecretGuardian] 秘密情報検出: ${guard.violations.length}件 → commit 停止`);
      // ステージングを全部解除してから throw
      try { runGit('git reset HEAD', { cwd: repoPath, stdio: 'pipe' }); } catch { /* ignore */ }
      const err = new Error(`[SecretGuardian] 秘密情報を検出しました。commit を停止しました。\n${guard.summary}`);
      err.secretViolations = guard.violations;
      err.secretReport     = guard.report;
      err.secretReportFile = guard.reportFile;
      throw err;
    }
    logger.info(`[SecretGuardian] ${guard.summary}`);
  } catch (sgErr) {
    if (sgErr.secretViolations) throw sgErr; // 検出エラーはそのまま上位へ
    // F-2 修正: guardCommit 自体の予期外例外 → fail-closed: commit を止める
    // （旧: logger.warn して commit 続行 = fail-open）
    logger.error(`[SecretGuardian] guardCommit 予期外例外 → fail-closed: ${sgErr.message?.slice(0, 80)}`);
    const fcErr = new Error(`[SecretGuardian] スキャンエラーのため commit を停止しました（安全のため）。\n${sgErr.message?.slice(0, 100)}`);
    fcErr.secretViolations = [];
    fcErr.secretReport     = `🚨 **Secret Guardian スキャンエラー — commit 停止**\nエラー: ${sgErr.message?.slice(0, 80)}\n詳細はログを確認してください。`;
    fcErr.secretReportFile = null;
    throw fcErr;
  }

  // コミットメッセージを一時ファイル経由で渡す（日本語文字化け防止）
  const { subject, body } = generateCommitMessage(prompt, taskId, changedFiles);
  const tmpFile = path.join(os.tmpdir(), `aiworker_commit_${taskId}.txt`);

  try {
    fs.writeFileSync(tmpFile, `${subject}\n\n${body}`, 'utf8');
    logger.info(`git commit: ${subject}`);
    execSync(`git commit -F "${tmpFile}"`, {
      cwd: repoPath,
      stdio: 'pipe',
      env: { ...process.env, LANG: 'UTF-8' },
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* 一時ファイル削除失敗は無視 */ }
  }

  // git push（リモートが設定されている場合のみ）
  let pushed    = false;
  let pushError = null;
  const remoteReady = configureGitHubRemote(repoPath);

  if (remoteReady) {
    // 現在の branch を動的に取得し push 先を決定する。
    //
    // 優先順位:
    //   1. getCurrentBranch() — 実在する現在ブランチ（最優先）
    //   2. GITHUB_BRANCH_DEFAULT — 現在ブランチが取得できなかった場合のフォールバック
    //   3. 'master' — どちらも得られなかった場合の最終フォールバック
    //
    // GITHUB_BRANCH_DEFAULT を先にするとブランチが実在しない場合に
    // "src refspec main does not match any" で失敗するため順序を逆転。
    const currentBranch = getCurrentBranch(repoPath) || GITHUB_BRANCH_DEFAULT || 'master';

    // トークンを HTTP Authorization ヘッダーで渡す（remote URL には埋め込まない）
    const authHeader = Buffer.from(`x-oauth-basic:${GITHUB_TOKEN}`).toString('base64');
    const gitAuthConfig = `-c http.extraheader="Authorization: Basic ${authHeader}"`;

    try {
      logger.info(`git push origin ${currentBranch}`);
      execSync(`git ${gitAuthConfig} push origin ${currentBranch}`, {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 30000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      pushed = true;
      logger.info(`git push 完了 (branch: ${currentBranch})`);
    } catch (err) {
      // トークン類をマスクしてからログ・pushError に格納
      pushError = maskSecret(err.message).slice(0, 300);
      logger.error(`git push 失敗: ${pushError}`);
    }
  }

  return {
    skipped: false,
    subject,
    changedFiles,
    changedCount: changedFiles.length,
    pushed,
    pushError,
    repoPath,
    branch: getCurrentBranch(repoPath) || GITHUB_BRANCH_DEFAULT || 'master',
    repo: GITHUB_REPO || '（未設定）',
  };
}

module.exports = { commitAndPush, getChangedFiles, generateCommitMessage, maskSecret };
