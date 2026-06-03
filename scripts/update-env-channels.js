'use strict';
/**
 * update-env-channels.js
 * Discord Company Infrastructure のチャンネルIDを .env に自動反映する。
 * トークン類は一切読み書きしない。CHANNEL_ID 系変数のみ更新する。
 *
 * 実行: node scripts/update-env-channels.js
 *        node scripts/update-env-channels.js --dry-run
 */

const fs   = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const DRY_RUN  = process.argv.includes('--dry-run');

// ── 今回作成したチャンネルID ──────────────────────────
const NEW_CHANNEL_IDS = {
  社長室:              '1511771154413519061',
  副社長室:            '1511771155621609592',
  '黒川-進行管理':     '1511771156783562813',
  作業指示:            '1511771158297448600',
  '宮城-lead-engineer':'1511771161099239455',
  '守谷-cto-review':   '1511771162382962718',
  '白石-coo':          '1511771164245098627',
  '市川-pm':           '1511771165620703282',
  '相沢-cs':           '1511771166749102160',
  '金森-cfo':          '1511771167848141032',
  '育野-learning':     '1511771169655619676',
  'decision-log':      '1511771171904028802',
  'incident-log':      '1511771173141090394',
  'lesson-log':        '1511771174668079144',
  'release-log':       '1511771176261779607',
  'security-log':      '1511771177608286348',
};

// ── .env 変数 → チャンネル名 マッピング ────────────────
const ENV_MAPPING = {
  CEO_REPORT_CHANNEL_ID:    '社長室',
  HUMAN_CHECK_CHANNEL_ID:   '社長室',
  AI_REVIEW_CHANNEL_ID:     '守谷-cto-review',
  CODEX_REVIEW_CHANNEL_ID:  '守谷-cto-review',
  AI_BOARD_CHANNEL_ID:      '守谷-cto-review',
  ERROR_CHANNEL_ID:          'security-log',
  BATCH_CHANNEL_ID:          '作業指示',
  MORNING_BATCH_CHANNEL_ID:  '作業指示',
  PR_CHANNEL_ID:             '宮城-lead-engineer',
  GITHUB_LOG_CHANNEL_ID:     '宮城-lead-engineer',
  MEETING_CHANNEL_ID:        '副社長室',
};

// ── ALLOWED_CHANNEL_IDS に追記するID群 ─────────────────
const NEW_IDS_LIST = Object.values(NEW_CHANNEL_IDS).join(',');

if (!fs.existsSync(ENV_PATH)) {
  console.error('❌ .env が見つかりません');
  process.exit(1);
}

// .env をトークン値を一切出力せず行単位で処理する
const lines   = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
const updated = [];
const changes = [];

for (const line of lines) {
  // コメント行・空行はそのまま
  if (/^\s*#/.test(line) || !line.trim()) { updated.push(line); continue; }

  const match = line.match(/^([A-Z_]+)\s*=\s*(.*)/);
  if (!match) { updated.push(line); continue; }

  const [, key, currentVal] = match;

  // ALLOWED_CHANNEL_IDS: 新チャンネルIDを末尾に追記（重複スキップ）
  if (key === 'ALLOWED_CHANNEL_IDS') {
    const existing = currentVal.split(',').map(s => s.trim()).filter(Boolean);
    const toAdd    = Object.values(NEW_CHANNEL_IDS).filter(id => !existing.includes(id));
    if (toAdd.length > 0) {
      const newVal = [...existing, ...toAdd].join(',');
      updated.push(`${key}=${newVal}`);
      changes.push({ key, action: `${toAdd.length}件のチャンネルIDを追記` });
    } else {
      updated.push(line);
    }
    continue;
  }

  // 個別 CHANNEL_ID 変数
  if (ENV_MAPPING[key]) {
    const newId = NEW_CHANNEL_IDS[ENV_MAPPING[key]];
    if (newId && currentVal !== newId) {
      updated.push(`${key}=${newId}`);
      changes.push({ key, action: `→ #${ENV_MAPPING[key]} (${newId})` });
    } else {
      updated.push(line);
    }
    continue;
  }

  updated.push(line);
}

// ── 結果表示 ────────────────────────────────────────────
if (changes.length === 0) {
  console.log('✅ 変更なし（既に最新です）');
  process.exit(0);
}

console.log(`\n${DRY_RUN ? '[DRY-RUN] ' : ''}📝 変更予定:`);
changes.forEach(c => console.log(`  ${c.key}: ${c.action}`));

if (DRY_RUN) {
  console.log('\n⚠️  DRY-RUN: .env を変更していません。--dry-run を外して再実行してください。');
  process.exit(0);
}

// atomic write（トークン値は一切出力しない）
const tmp = ENV_PATH + '.update.tmp';
fs.writeFileSync(tmp, updated.join('\n'), 'utf8');
fs.renameSync(tmp, ENV_PATH);

console.log(`\n✅ .env を更新しました（${changes.length}件）`);
console.log('次のステップ: npm start で Bot を再起動してください。');
