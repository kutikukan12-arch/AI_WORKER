'use strict';
// =====================================================
// role-channel-router.js — Role Channel Router (Phase2)
//
// 目的:
//   社員ごとの Discord 送信先チャンネル ID を環境変数から
//   解決し、index.js の sendToChannel() に渡す。
//   Discord client の保持・操作はこのモジュール内では行わない。
//
// 設定方法:
//   .env に以下を追加して Bot 再起動:
//     MORIYA_CHANNEL_ID=<Discord チャンネル ID>
//     MIYAGI_CHANNEL_ID=<Discord チャンネル ID>
//     ...（必要な社員分だけ）
//
// 未設定の社員は従来チャンネルへ fallback。
//
// 禁止:
//   ❌ Discord client をこのモジュール内に保持しない
//   ❌ 自動実行・自動承認・CEO判断代理
//   ❌ eval / exec / child_process
// =====================================================

// ─── 社員 → 環境変数キー マッピング ──────────────────
const WORKER_CHANNEL_ENV = {
  miyagi:    'MIYAGI_CHANNEL_ID',
  moriya:    'MORIYA_CHANNEL_ID',
  shiraishi: 'SHIRAISHI_CHANNEL_ID',
  ichikawa:  'ICHIKAWA_CHANNEL_ID',
  kanemori:  'KANEMORI_CHANNEL_ID',
  kurokawa:  'KUROKAWA_CHANNEL_ID',
  ikuno:     'IKUNO_CHANNEL_ID',
  kanzaki:   'KANZAKI_CHANNEL_ID',
  aizawa:    'AIZAWA_CHANNEL_ID',
  ceo:       'CEO_CHANNEL_ID',
};

// ─── 表示名 ───────────────────────────────────────────
const WORKER_DISPLAY_RCR = {
  miyagi:    '宮城 Lead Engineer',
  moriya:    '守谷 CTO',
  shiraishi: '白石 COO',
  ichikawa:  '市川 PM',
  kanemori:  '金森 CFO',
  kurokawa:  '黒川 Chief of Staff',
  ikuno:     '育野 Learning',
  kanzaki:   '神崎 VP',
  aizawa:    '相沢 CS',
  ceo:       'CEO',
};

// ─────────────────────────────────────────────────────
// getWorkerChannelId(worker) → チャンネル ID or null
//
// worker: canonical 名 (例: 'moriya', 'miyagi', 'ceo')
// 戻り値: .env に設定されたチャンネル ID 文字列 / 未設定なら null
// ─────────────────────────────────────────────────────
function getWorkerChannelId(worker) {
  if (!worker) return null;
  const key = String(worker).toLowerCase().trim();
  const envKey = WORKER_CHANNEL_ENV[key];
  if (!envKey) return null;
  const val = (process.env[envKey] || '').trim();
  return val || null;
}

// ─────────────────────────────────────────────────────
// isChannelConfigured(worker) → 設定済みか
// ─────────────────────────────────────────────────────
function isChannelConfigured(worker) {
  return Boolean(getWorkerChannelId(worker));
}

// ─────────────────────────────────────────────────────
// listConfiguredChannels() → 全社員の設定状況リスト
//
// 戻り値: [{ worker, display, channelId, envKey }, ...]
// ─────────────────────────────────────────────────────
function listConfiguredChannels() {
  return Object.keys(WORKER_CHANNEL_ENV).map(w => ({
    worker:    w,
    display:   WORKER_DISPLAY_RCR[w] || w,
    channelId: getWorkerChannelId(w),
    envKey:    WORKER_CHANNEL_ENV[w],
  }));
}

// ─────────────────────────────────────────────────────
// buildChannelStatusText() → !router status 表示テキスト
// ─────────────────────────────────────────────────────
function buildChannelStatusText() {
  const rows       = listConfiguredChannels();
  const configured = rows.filter(r => r.channelId).length;
  const lines = rows.map(r =>
    r.channelId
      ? `  ✅ ${r.display}: \`${r.channelId}\` (${r.envKey})`
      : `  ⬜ ${r.display}: 未設定 (${r.envKey})`
  );
  return [
    `📡 **Role Channel Router — チャンネル設定状況 (Phase2)**`,
    ``,
    `設定済み: ${configured} / ${rows.length}`,
    `未設定の社員は従来チャンネルへ fallback します。`,
    ``,
    ...lines,
    ``,
    `設定方法: \`.env\` に \`MORIYA_CHANNEL_ID=<ID>\` 等を追加して再起動。`,
    `コマンド: \`!router status\` — この一覧を再表示`,
  ].join('\n');
}

module.exports = {
  getWorkerChannelId,
  isChannelConfigured,
  listConfiguredChannels,
  buildChannelStatusText,
  WORKER_CHANNEL_ENV,
  WORKER_DISPLAY_RCR,
};
