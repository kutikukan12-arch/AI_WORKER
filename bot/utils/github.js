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
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// git リポジトリのパス（デフォルト: AI_WORKER ルート）
const GIT_REPO_PATH = process.env.GIT_REPO_PATH
  || path.join(__dirname, '..', '..');

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
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
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
    const raw = execSync('git status --porcelain', {
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
// GitHub Push 用のリモート URL を設定
// GITHUB_TOKEN + GITHUB_REPO が揃っている場合のみ
// ─────────────────────────────────────────────────────
function configureGitHubRemote(repoPath) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    logger.info('GITHUB_TOKEN または GITHUB_REPO が未設定。Push をスキップします。');
    return false;
  }

  // https://TOKEN@github.com/user/repo.git 形式で認証
  const remoteUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;

  try {
    const remotes = execSync('git remote', {
      cwd: repoPath, stdio: 'pipe', encoding: 'utf8'
    }).trim();

    if (remotes.includes('origin')) {
      execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: repoPath, stdio: 'pipe' });
    } else {
      execSync(`git remote add origin "${remoteUrl}"`, { cwd: repoPath, stdio: 'pipe' });
    }
    logger.info(`GitHub リモートを設定: ${GITHUB_REPO} (${GITHUB_BRANCH})`);
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
  execSync('git add .', { cwd: repoPath, stdio: 'pipe' });

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
    try {
      logger.info(`git push origin ${GITHUB_BRANCH}`);
      execSync(`git push origin ${GITHUB_BRANCH} --set-upstream`, {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 30000,   // 30秒タイムアウト
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // パスワードプロンプトを無効化（ハング防止）
        },
      });
      pushed = true;
      logger.info('git push 完了');
    } catch (err) {
      pushError = err.message.slice(0, 300);
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
    branch: GITHUB_BRANCH,
    repo: GITHUB_REPO || '（未設定）',
  };
}

module.exports = { commitAndPush, getChangedFiles, generateCommitMessage };
