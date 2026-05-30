'use strict';

// =====================================================
// restart-manager.js - Bot 安全再起動マネージャー
//
// 役割:
//   !restart コマンドで安全にBotを再起動する。
//
// 安全チェック（この順序で全て実行）:
//   1. node --check で構文エラー検知
//   2. DISCORD_TOKEN 確認（値は表示しない）
//   3. タスクキュー状態確認
//   4. 古いプロセス検知（PIDファイル）
//
// 再起動フロー:
//   旧プロセス:
//     チェック → 保存 → 「再起動します」通知 → 新プロセス起動 → exit(0)
//   新プロセス:
//     起動後 → restart-state.json を読む → 完了通知 → ファイル削除
//
// 禁止:
//   ・構文エラー状態での再起動（絶対禁止）
//   ・DISCORD_TOKEN 未設定での再起動
//   ・一般ユーザーからの実行（index.js 側でガード）
//
// 必要な .env 設定:
//   DISCORD_OWNER_ID=  （再起動権限の所有者）
// =====================================================

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT_DIR      = path.join(__dirname, '..', '..');
const BOT_ENTRY     = path.join(__dirname, '..', 'index.js');
const DATA_DIR      = path.join(ROOT_DIR, 'data');
const PID_FILE      = path.join(DATA_DIR, 'bot.pid');
const RESTART_STATE = path.join(DATA_DIR, 'restart-state.json');

// ─────────────────────────────────────────────────────
// 起動時: 現在のPIDをファイルに記録
// 古いプロセス検知に使う
// ─────────────────────────────────────────────────────
function writePid() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  logger.info(`PID記録: ${process.pid} → data/bot.pid`);
}

// ─────────────────────────────────────────────────────
// チェック1: 構文エラー検知（node --check）
//
// 構文エラーがあれば再起動は絶対に行わない。
// エラー内容のみ返す（コード内容は返さない）。
// ─────────────────────────────────────────────────────
function checkSyntax() {
  try {
    execSync(`node --check "${BOT_ENTRY}"`, {
      stdio:   'pipe',
      timeout: 10000,
      shell:   true,
    });
    return { ok: true };
  } catch (e) {
    const stderr = (e.stderr?.toString() || e.message || '不明なエラー').slice(0, 400);
    return { ok: false, error: stderr };
  }
}

// ─────────────────────────────────────────────────────
// チェック2: DISCORD_TOKEN 確認
//
// 値は絶対に返さない。「設定済み / 未設定」のみ。
// ─────────────────────────────────────────────────────
function checkToken() {
  const token = process.env.DISCORD_TOKEN;
  if (!token || token.includes('ここに') || token.length < 20) {
    return { ok: false, error: 'DISCORD_TOKEN が未設定または無効です' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────
// チェック3: 古いBotプロセスを検知
//
// PIDファイルに記録されたPIDが今も生きていれば警告。
// ─────────────────────────────────────────────────────
function checkOldProcess() {
  if (!fs.existsSync(PID_FILE)) return { found: false };

  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (isNaN(oldPid) || oldPid === process.pid) return { found: false };

  try {
    process.kill(oldPid, 0); // signal 0 = 存在確認のみ（シグナル未送信）
    return { found: true, pid: oldPid };
  } catch {
    return { found: false }; // プロセスは既に存在しない
  }
}

// ─────────────────────────────────────────────────────
// 全チェックをまとめて実行
//
// 返り値:
//   isOK         - 構文・Token が全て OK
//   needsConfirm - 警告あり（キューに待機あり / 古いプロセスあり）
// ─────────────────────────────────────────────────────
function runPreRestartChecks(taskQueue) {
  const syntax  = checkSyntax();
  const token   = checkToken();
  const queue   = taskQueue.getStatus();
  const oldProc = checkOldProcess();

  const isOK = syntax.ok && token.ok;

  // 警告項目: 実行中タスク / 待機タスク / 古いプロセス
  const warnings = [];
  if (queue.active > 0)  warnings.push(`実行中タスク ${queue.active}件（強制終了されます）`);
  if (queue.queued > 0)  warnings.push(`待機タスク ${queue.queued}件（キャンセルされます）`);
  if (oldProc.found)     warnings.push(`古いBotプロセス（PID: ${oldProc.pid}）が残っています`);

  const needsConfirm = warnings.length > 0;

  return { syntax, token, queue, oldProc, isOK, needsConfirm, warnings };
}

// ─────────────────────────────────────────────────────
// 再起動状態をファイルに保存
//
// 新プロセスが起動後にこのファイルを読み、完了通知を送る。
// ─────────────────────────────────────────────────────
function saveRestartState(taskQueue, channelId) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const queueStatus = taskQueue.getStatus();
  const state = {
    restartedAt:     new Date().toISOString(),
    notifyChannelId: channelId || '',
    prevPid:         process.pid,
    nodeVersion:     process.versions.node,
    savedQueue: {
      active:     queueStatus.active,
      queued:     queueStatus.queued,
      pendingIds: queueStatus.pendingIds || [],
    },
  };

  fs.writeFileSync(RESTART_STATE, JSON.stringify(state, null, 2), 'utf8');
  logger.info(`再起動状態保存 | CH: ${channelId} | active=${queueStatus.active} queued=${queueStatus.queued}`);
  return { ok: true, state };
}

// ─────────────────────────────────────────────────────
// 起動時: 再起動状態ファイルを読む
//
// ファイルがあれば再起動後の起動。読んだら即削除。
// ─────────────────────────────────────────────────────
function readRestartState() {
  if (!fs.existsSync(RESTART_STATE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(RESTART_STATE, 'utf8'));
    fs.unlinkSync(RESTART_STATE); // 一度読んだら削除
    return state;
  } catch {
    try { fs.unlinkSync(RESTART_STATE); } catch { /* ignore */ }
    return null;
  }
}

// ─────────────────────────────────────────────────────
// 再起動完了通知メッセージを生成
// ─────────────────────────────────────────────────────
function buildRestartCompleteMessage(restartState, startupMs) {
  const elapsed  = ((Date.now() - new Date(restartState.restartedAt).getTime()) / 1000).toFixed(1);
  const savedQ   = restartState.savedQueue || {};
  const queueMsg = savedQ.queued > 0
    ? `> ⚠️ 前回の待機タスク: ${savedQ.queued}件（再実行するには \`!claude\` で依頼してください）`
    : `> 📋 前回のタスクキュー: クリア済み`;

  return [
    `✅ **Bot 再起動完了**`,
    `> 🟢 Node.js v${process.versions.node}`,
    `> ⏱️ 起動時間: ${startupMs}ms（再起動開始からの合計: ${elapsed}秒）`,
    queueMsg,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// 実際に再起動を実行する
//
// 1. 新プロセスをデタッチして起動
// 2. 1.5秒待つ（Discordへのメッセージ送信を完了させる）
// 3. 現プロセスを終了
// ─────────────────────────────────────────────────────
async function performRestart() {
  logger.info(`Bot 再起動実行 | PID: ${process.pid} → 新プロセス起動`);

  try {
    // 新プロセスを起動（デタッチ = 親が終了しても動き続ける）
    const child = spawn(process.execPath, [BOT_ENTRY], {
      detached: true,
      stdio:    'ignore',     // 入出力を切り離す
      cwd:      ROOT_DIR,     // プロジェクトルートで起動
      env:      process.env,  // 現在の環境変数を引き継ぐ
    });
    child.unref(); // 親プロセス終了を子プロセスに伝えない

    logger.info(`新プロセス起動済み。1.5秒後に旧プロセス終了。`);
  } catch (e) {
    logger.error(`新プロセス起動失敗: ${e.message}`);
    throw e;
  }

  // Discordへのメッセージが届くまで待つ
  await new Promise(resolve => setTimeout(resolve, 1500));

  process.exit(0);
}

// ─────────────────────────────────────────────────────
// チェック結果を Discord 向けテキストに整形
// ─────────────────────────────────────────────────────
function formatChecksForDiscord(checks) {
  const lines = [
    `${checks.syntax.ok ? '🟢' : '🔴'} 構文チェック: ${checks.syntax.ok ? 'OK' : '**エラーあり**'}`,
    `${checks.token.ok  ? '🟢' : '🔴'} Token: ${checks.token.ok  ? '設定済み' : '**未設定または無効**'}`,
    `${checks.queue.active === 0 && checks.queue.queued === 0 ? '🟢' : '🟡'} タスクキュー: 実行中 ${checks.queue.active}件 / 待機 ${checks.queue.queued}件`,
    `${checks.oldProc.found ? '🟡' : '🟢'} 旧プロセス: ${checks.oldProc.found ? `PID ${checks.oldProc.pid} が残存` : 'なし'}`,
  ];
  return lines.join('\n');
}

module.exports = {
  writePid,
  checkSyntax,
  checkToken,
  checkOldProcess,
  runPreRestartChecks,
  saveRestartState,
  readRestartState,
  buildRestartCompleteMessage,
  formatChecksForDiscord,
  performRestart,
};
