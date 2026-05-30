'use strict';

// =====================================================
// claude-runner.js - Claude Code 実行ユーティリティ
// 役割: Claude Code CLI をプログラムから起動し
//       結果を受け取ってテキストで返す
//
// セキュリティ対策:
//   - タイムアウトで無限実行を防止
//   - ANSI エスケープ文字を除去して出力を整形
//
// cwd 設定:
//   projectRoot を渡すと AI_WORKER ルートで起動（推奨）。
//   省略時は workspacePath で起動（後方互換・workspace外編集不可）。
//   projectRoot を渡すことで bot/index.js 等のプロジェクト本体を
//   Claude Code が Read/Write/Edit できるようになる。
//
// 環境変数 CLAUDE_WORKSPACE:
//   workspacePath を Claude Code に伝える。
//   Claude Code が中間ファイルを workspace/ に保存したい場合に使用。
// =====================================================

const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

// タイムアウト設定（環境変数から取得、デフォルト5分）
const TIMEOUT_MS = (parseInt(process.env.TASK_TIMEOUT_SECONDS) || 300) * 1000;

// ─────────────────────────────────────────────────────
// Claude Code の実行コマンド解決
//
// shell:false（改行保持に必要）では Windows の PATHEXT 補完が働かず、
// .cmd ファイルを直接 spawn すると EINVAL になる。
// claude.cmd の実体は claude.exe を呼ぶだけのラッパーなので、
// Windows では where.exe で claude.cmd の場所を探し、
// 隣の node_modules から claude.exe の絶対パスを解決する。
//
// 優先順位:
//   1. CLAUDE_COMMAND が .exe / 絶対パスなら → そのまま使用
//   2. Windows → where.exe で claude.cmd を探し → claude.exe を解決
//   3. Linux/Mac → 'claude' をそのまま使用
// ─────────────────────────────────────────────────────
function resolveClaudeCommand() {
  const envCmd = process.env.CLAUDE_COMMAND || '';

  // 絶対パスまたは .exe が明示されていればそのまま使う
  if (envCmd && (path.isAbsolute(envCmd) || envCmd.endsWith('.exe'))) {
    return envCmd;
  }

  // Windows: claude.cmd → claude.exe を自動解決
  if (process.platform === 'win32') {
    const searchName = (envCmd && envCmd.endsWith('.cmd')) ? envCmd : 'claude.cmd';
    try {
      const found = execFileSync('where.exe', [searchName], {
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'pipe'],
        timeout:  3000,
      }).trim().split(/\r?\n/)[0].trim();

      const exePath = path.join(
        path.dirname(found),
        'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
      );
      if (fs.existsSync(exePath)) {
        logger.info(`Claude CLI 解決: ${exePath}`);
        return exePath;
      }
    } catch { /* fallback */ }

    // 解決できなかった場合は元のコマンドに戻す
    return envCmd || 'claude.cmd';
  }

  // Linux / Mac
  return envCmd || 'claude';
}

const CLAUDE_COMMAND = resolveClaudeCommand();

// ─────────────────────────────────────────────────────
// ANSI エスケープシーケンス除去
// Discord はターミナルの色コードを表示できないため除去する
// ─────────────────────────────────────────────────────
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
            .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '');
}

// ─────────────────────────────────────────────────────
// Claude Code を実行する関数
//
// 引数:
//   prompt        - Claude Code への指示文
//   workspacePath - タスク専用フォルダ（prompt.md / result.md 保存先）
//   projectRoot   - Claude Code の cwd（省略時は workspacePath）
//                   AI_WORKER ルートを渡すと本体ファイルを編集可能になる
//
// 戻り値: Promise<{ output: string, duration: number, exitCode: number }>
// ─────────────────────────────────────────────────────
async function run(prompt, workspacePath, projectRoot = null) {
  const startTime = Date.now();

  // projectRoot が指定されていれば AI_WORKER ルートを cwd にする
  // 未指定なら従来どおり workspacePath（後方互換）
  const cwdPath = projectRoot || workspacePath;

  return new Promise((resolve, reject) => {
    logger.info(
      `Claude Code 起動 | cwd: ${path.basename(cwdPath)} | workspace: ${path.basename(workspacePath)}`
    );

    // ─── Claude Code CLI の引数 ───
    // -p / --print  : 非インタラクティブモード（結果を出力して終了）
    // --dangerously-skip-permissions : 自動実行に必要な権限スキップ
    // --allowedTools : 使用を許可するツールを限定
    const args = [
      '-p',                             // 非インタラクティブモード（必須）
      prompt,                           // Claude への指示
      '--dangerously-skip-permissions', // 自動実行用（Bot運用では必要）
      '--allowedTools', 'Read,Write,Edit,Bash', // 許可するツール
    ];

    // ─── プロセス起動設定 ───
    const proc = spawn(CLAUDE_COMMAND, args, {
      cwd:   cwdPath, // AI_WORKER ルート（projectRoot指定時）または workspace
      shell: false,   // shell:false でNode.jsが引数を直接渡す（改行・長文プロンプト保持）
      env: {
        ...process.env,
        NO_COLOR:        '1',
        FORCE_COLOR:     '0',
        CLAUDE_WORKSPACE: workspacePath, // workspace パスを環境変数で渡す
      },
      // stdio の設定: stdout/stderrをキャプチャ、stdinはnull（入力なし）
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // 標準出力を収集
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    // エラー出力を収集（デバッグ用）
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      logger.debug(`Claude stderr: ${chunk.toString('utf8').trim()}`);
    });

    // タイムアウト処理（指定時間内に完了しない場合は強制終了）
    const timeoutTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      const minutes = Math.floor(TIMEOUT_MS / 60000);
      reject(new Error(
        `⏱️ タイムアウト: ${minutes}分以内に完了しませんでした\n` +
        `タスクが複雑すぎる可能性があります。指示を分割してお試しください。`
      ));
    }, TIMEOUT_MS);

    // プロセス終了時の処理
    proc.on('close', (exitCode) => {
      clearTimeout(timeoutTimer);

      const duration = Math.floor((Date.now() - startTime) / 1000);
      const output = stripAnsi(stdout).trim();
      const errorText = stripAnsi(stderr).trim();

      logger.info(`Claude Code 終了 | 終了コード: ${exitCode} | 実行時間: ${duration}秒`);

      if (exitCode === 0 || (exitCode !== 0 && output)) {
        // 正常終了、または出力がある場合は成功として扱う
        resolve({
          output: output || '（出力なし）',
          duration,
          exitCode,
        });
      } else {
        // 出力がなくエラーの場合
        reject(new Error(
          `Claude Code がエラーで終了しました（終了コード: ${exitCode}）\n` +
          (errorText ? `エラー詳細:\n${errorText.slice(0, 500)}` : 'エラー詳細なし')
        ));
      }
    });

    // プロセス起動自体が失敗した場合（claude コマンドが見つからない等）
    proc.on('error', (err) => {
      clearTimeout(timeoutTimer);

      if (err.code === 'ENOENT') {
        reject(new Error(
          `Claude Code が見つかりません\n` +
          `インストールされていることを確認してください:\n` +
          `  npm install -g @anthropic-ai/claude-code`
        ));
      } else {
        reject(new Error(`Claude Code 起動エラー: ${err.message}`));
      }
    });
  });
}

module.exports = { run };
