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
const LOCK_FILE     = path.join(DATA_DIR, 'bot.lock');      // 起動ロック
const RESTART_LOCK  = path.join(DATA_DIR, 'restart.lock'); // 再起動ロック
const RESTART_STATE = path.join(DATA_DIR, 'restart-state.json');

// ─────────────────────────────────────────────────────
// 起動時: 現在のPIDをファイルに記録
// 後方互換用。新コードは acquireStartupLock() を使う。
// ─────────────────────────────────────────────────────
function writePid() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  logger.info(`PID記録: ${process.pid} → data/bot.pid`);
}

// ─────────────────────────────────────────────────────
// 起動ロック取得（多重起動防止）
//
// !restart 経由の起動（restart-state.json が存在する）は
// 正当な再起動なのでチェックをスキップする。
//
// それ以外（手動起動等）の場合:
//   ・bot.pid の PID が生きていれば起動を中止する
//   ・PID が死んでいれば（古い残骸）上書きして起動続行
//
// 戻り値:
//   { ok: true }                     — 起動を続けてよい
//   { ok: false, existingPid: pid }  — 既存プロセスが生きている → abort
// ─────────────────────────────────────────────────────
function acquireStartupLock() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // ─── restart-state.json がある場合: 正当な !restart 経由 ───
  // ただし「別の」プロセスが lock を持っていれば拒否する。
  // 旧実装はチェックを完全スキップしていた → 他プロセスが存在しても通過できた。
  let prevPid = null;
  if (fs.existsSync(RESTART_STATE)) {
    try {
      const state = JSON.parse(fs.readFileSync(RESTART_STATE, 'utf8'));
      prevPid = state.prevPid || null;
      logger.info(`[LOCK] restart経由の起動 (prevPid: ${prevPid})`);
    } catch {
      logger.warn(`[LOCK] restart-state.json の読み取り失敗 → 通常チェックへ`);
    }
  }

  // ─── 主判定: bot.lock を唯一の真実ソースとして使う ───
  // bot.lock は Bot 起動時に書き、終了時に削除する。
  // restart経由でも同じルールを適用する（prevPid は許可）。
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const isAllowed = lockData.pid === process.pid || lockData.pid === prevPid;
      if (!isAllowed) {
        try {
          process.kill(lockData.pid, 0); // 存在確認のみ
          logger.error(`[LOCK] 既存Botプロセスが稼働中 (PID: ${lockData.pid}). 起動を中止します。`);
          return { ok: false, existingPid: lockData.pid };
        } catch {
          // PID が存在しない → bot.lock は古い残骸
          logger.warn(`[LOCK] 古い bot.lock (PID: ${lockData.pid}) を上書きします`);
        }
      } else {
        logger.info(`[LOCK] bot.lock PID=${lockData.pid} は許可対象 (prevPid or self)`);
      }
    } catch {
      logger.warn(`[LOCK] bot.lock が破損しています。上書きします。`);
    }
  }

  _writeLockFilesAtomic();
  return { ok: true };
}

// ─────────────────────────────────────────────────────
// 内部: bot.pid と bot.lock をアトミックに書き込む
//
// wx フラグ (O_CREAT|O_EXCL) で既存ファイルがあれば失敗する。
// 失敗した場合は上書きする（acquireStartupLock でチェック済み）。
// ─────────────────────────────────────────────────────
function _writeLockFilesAtomic() {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  const lockData = JSON.stringify({
    pid:       process.pid,
    startedAt: new Date().toISOString(),
    entry:     BOT_ENTRY,
  }, null, 2);

  try {
    // O_CREAT|O_EXCL: ファイルが存在しない場合のみ作成（アトミック）
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, lockData);
    fs.closeSync(fd);
  } catch (e) {
    if (e.code === 'EEXIST') {
      // チェック後に別プロセスが作成した可能性 → 上書き（チェックは済んでいる）
      logger.warn(`[LOCK] bot.lock が競合作成されました。上書きします。`);
      fs.writeFileSync(LOCK_FILE, lockData, 'utf8');
    } else {
      throw e;
    }
  }

  logger.info(`[LOCK] 起動ロック取得: PID=${process.pid}`);
}

// 旧名称との互換性エイリアス
const _writeLockFiles = _writeLockFilesAtomic;

// ─────────────────────────────────────────────────────
// 起動ロック解放（プロセス終了時に呼ぶ）
//
// 重要: bot.lock が自分のものである場合のみ削除する。
// 多重起動で弾かれたプロセスが exit 時に他プロセスの
// bot.lock を削除しないようにする。
// ─────────────────────────────────────────────────────
function releaseStartupLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (lockData.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        logger.info(`[LOCK] 起動ロック解放: PID=${process.pid}`);
      } else {
        // 他プロセスの lock は削除しない
        logger.info(`[LOCK] 起動ロック解放スキップ: 所有者=PID=${lockData.pid} (自分=PID=${process.pid})`);
      }
    }
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// 再起動ロック取得（多重 !restart 防止）
//
// restart.lock が存在してそのPIDが生きている場合 → 多重再起動拒否
// restart.lock が存在してもPIDが死んでいる場合 → stale → 上書きして続行
//
// 戻り値:
//   { ok: true }                  — ロック取得成功
//   { ok: false, lockData: {...} } — 既に再起動中
// ─────────────────────────────────────────────────────
function acquireRestartLock(channelId) {
  if (fs.existsSync(RESTART_LOCK)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(RESTART_LOCK, 'utf8'));
      try {
        process.kill(lockData.pid, 0);
        // そのPIDがまだ生きている → 正当なロック
        logger.warn(`[RESTART_LOCK] 再起動処理中 (PID: ${lockData.pid})`);
        return { ok: false, lockData };
      } catch {
        // PIDが死んでいる → stale lock → 上書き
        logger.warn(`[RESTART_LOCK] 古いロック (PID: ${lockData.pid}) を上書きします`);
      }
    } catch { /* 破損ファイル → 無視して上書き */ }
  }

  fs.writeFileSync(RESTART_LOCK, JSON.stringify({
    pid:       process.pid,
    startedAt: new Date().toISOString(),
    channelId: channelId || '',
  }, null, 2), 'utf8');
  logger.info(`[RESTART_LOCK] 再起動ロック取得: PID=${process.pid}`);
  return { ok: true };
}

// ─────────────────────────────────────────────────────
// 再起動ロック解放
// ─────────────────────────────────────────────────────
function releaseRestartLock() {
  try { if (fs.existsSync(RESTART_LOCK)) fs.unlinkSync(RESTART_LOCK); } catch { /* ignore */ }
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
  // 新Bot起動が確認されたので restart.lock を解放する
  releaseRestartLock();

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
  acquireStartupLock,
  releaseStartupLock,
  acquireRestartLock,
  releaseRestartLock,
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
