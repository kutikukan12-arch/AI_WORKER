'use strict';

// =====================================================
// project-detector.js - Discord チャンネルから projectId を判定
//
// ルール:
//   親カテゴリが "AIのデスク" の場合のみ project 判定を有効化。
//   channel 名 (ハイフン→アンダースコア) を projectId として使用。
//   AIのデスク配下でない場合は "default" を返す。
//
// 例:
//   #yt-predict  (カテゴリ: AIのデスク) → "yt_predict"
//   #ai-worker   (カテゴリ: AIのデスク) → "ai_worker"
//   #general     (カテゴリ: なし)       → "default"
// =====================================================

const AI_DESK_CATEGORY = 'AIのデスク';

// システム管理用チャンネル名（プロジェクトIDとして使わない）
// #approval チャンネルから !claude を送っても workspace/approval/ に入らないようにする
const RESERVED_PROJECT_IDS = new Set(['approval', 'default', 'data', 'logs', 'reviews', 'workspace']);

function channelNameToProjectId(channelName) {
  return channelName.replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

function detectProjectId(channel) {
  if (!channel) return 'default';
  const parent = channel.parent;
  if (!parent || parent.name !== AI_DESK_CATEGORY) return 'default';
  const pid = channelNameToProjectId(channel.name) || 'default';
  // 予約名の場合は 'default' にフォールバック
  if (RESERVED_PROJECT_IDS.has(pid)) return 'default';
  return pid;
}

module.exports = { detectProjectId, channelNameToProjectId };
