'use strict';
/**
 * install-startup.js — Windows ログイン時自動起動 設定
 *
 * 実行: npm run install-startup
 *
 * 動作:
 *   Windows タスクスケジューラに「AI_WORKER_Operator」タスクを登録する。
 *   ログイン時に start-ai-worker.bat が実行される。
 *
 * 初期は OFF (--disable で無効化、--status で確認)
 *
 * 使い方:
 *   npm run install-startup           → タスク登録（初回有効化）
 *   npm run install-startup -- --disable → タスク無効化
 *   npm run install-startup -- --remove  → タスク削除
 *   npm run install-startup -- --status  → 状態確認
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT    = path.join(__dirname, '..');
const BAT     = path.join(ROOT, 'start-ai-worker.bat');
const TASK    = 'AI_WORKER_Operator';
const CMD     = process.argv[2] || '--install';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function isWindows() {
  return process.platform === 'win32';
}

function checkTaskExists() {
  const result = run(`schtasks /Query /TN "${TASK}" /FO CSV 2>nul`);
  return !!result && result.includes(TASK);
}

switch (CMD) {
  case '--install': {
    if (!isWindows()) {
      console.log('⚠️  このスクリプトは Windows 専用です。');
      console.log('   Mac/Linux の場合は crontab や launchd を使用してください。');
      process.exit(0);
    }
    if (!fs.existsSync(BAT)) {
      console.error(`❌ ${BAT} が見つかりません。`);
      process.exit(1);
    }

    console.log(`\n📋 タスクスケジューラに登録します: ${TASK}`);
    console.log(`   実行ファイル: ${BAT}`);
    console.log(`   トリガー: ログオン時\n`);

    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>false</Enabled>
    </LogonTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>${BAT}</Command>
      <WorkingDirectory>${ROOT}</WorkingDirectory>
    </Exec>
  </Actions>
  <Settings>
    <Enabled>false</Enabled>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  </Settings>
  <RegistrationInfo>
    <Description>黒川 Desktop Operator 自動起動 (AI_WORKER)</Description>
  </RegistrationInfo>
</Task>`;

    const xmlPath = path.join(ROOT, 'data', 'desktop-operator', '_startup-task.xml');
    const opDir   = path.join(ROOT, 'data', 'desktop-operator');
    if (!fs.existsSync(opDir)) fs.mkdirSync(opDir, { recursive: true });
    fs.writeFileSync(xmlPath, xml, 'utf16le');

    const result = run(`schtasks /Create /TN "${TASK}" /XML "${xmlPath}" /F`);
    try { fs.unlinkSync(xmlPath); } catch { /* ignore */ }

    if (result !== null) {
      console.log(`✅ タスク登録完了: ${TASK}`);
      console.log(`   ⚠️  初期状態は【無効】です。`);
      console.log(`   有効化するには: schtasks /Change /TN "${TASK}" /Enable`);
    } else {
      console.error(`❌ タスク登録に失敗しました。管理者権限で実行してください。`);
    }
    break;
  }

  case '--disable': {
    if (!isWindows()) { console.log('Windows 専用'); process.exit(0); }
    run(`schtasks /Change /TN "${TASK}" /Disable`);
    console.log(`✅ タスクを無効化しました: ${TASK}`);
    break;
  }

  case '--remove': {
    if (!isWindows()) { console.log('Windows 専用'); process.exit(0); }
    run(`schtasks /Delete /TN "${TASK}" /F`);
    console.log(`✅ タスクを削除しました: ${TASK}`);
    break;
  }

  case '--status': {
    if (!isWindows()) {
      console.log('ℹ️  プラットフォーム: ' + process.platform);
      process.exit(0);
    }
    const exists = checkTaskExists();
    const detail = exists ? run(`schtasks /Query /TN "${TASK}" /FO LIST`) : null;
    console.log(`\n📊 タスク状態: ${TASK}`);
    if (!exists) {
      console.log('  ⭕ 未登録 (npm run install-startup で登録できます)');
    } else {
      const enabled = detail?.includes('有効') || detail?.includes('Enabled');
      console.log(`  ${enabled ? '✅ 有効' : '⏹️ 無効'}`);
      if (detail) console.log(detail.slice(0, 500));
    }
    break;
  }

  default:
    console.log(`
使い方:
  npm run install-startup              → タスク登録（初期は無効）
  npm run install-startup -- --disable → タスク無効化
  npm run install-startup -- --remove  → タスク削除
  npm run install-startup -- --status  → 状態確認
`);
}
