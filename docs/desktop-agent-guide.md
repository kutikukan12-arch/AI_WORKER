# Desktop Agent ガイド (Phase4)

**作成:** 2026-06-04  
**目的:** AI_WORKER の outbox/inbox を常駐監視し、社長が手動貼り付けなしで確認できるようにする

---

## 概要

```
AI_WORKER (Discord Bot)
    ↓ !inbox send <worker> <内容>
data/outbox/<worker>/outgoing.md

Desktop Agent (このスクリプト)
    ↓ 監視・通知（console のみ）
社長の PC

社員の Desktop
    ↓ 作業結果を手動でペースト
data/inbox/<worker>/incoming.md

Desktop Agent
    ↓ 返信あり検出・通知
社長の PC
```

---

## 使い方

```bash
# 常駐監視 (30秒ごと)
node scripts/desktop-agent.js watch

# 1回だけチェック
node scripts/desktop-agent.js once

# 状態表示
node scripts/desktop-agent.js status
```

---

## ディレクトリ構造

```
data/
  outbox/
    miyagi/outgoing.md    ← !inbox send miyagi で書き込まれる
    moriya/outgoing.md
    ...
  inbox/
    miyagi/incoming.md    ← 宮城がデスクトップで作業結果をペースト
    moriya/incoming.md
    ...
  desktop-agent/
    state.json            ← Agent の状態ファイル（gitignore）
```

---

## 状態ファイル (`data/desktop-agent/state.json`)

```json
{
  "version": "1",
  "updatedAt": "2026-06-04T...",
  "workers": {
    "miyagi": {
      "lastOutgoingHash": "a1b2c3d4e5f6...",
      "lastNotifiedAt": "2026-06-04T...",
      "hasIncoming": false,
      "lastIncomingHash": "f6e5d4c3..."
    }
  },
  "pendingWorkers": [],
  "incomingWorkers": [],
  "errorLog": []
}
```

**重複通知防止:** `lastOutgoingHash` と現在のファイルハッシュを比較し、  
同一内容は再通知しない。

---

## セキュリティ

| ルール | 実装 |
|-------|------|
| incoming.md をコマンドとして実行しない | ファイルを読むだけ |
| eval 禁止 | コードに eval なし |
| child_process による本文実行禁止 | 使用なし |
| createTask / decision-log 自動実行禁止 | require なし |
| 黒川は判断代理しない | 通知のみ、実行提案も自動実行しない |
| 全表示に redact() 適用 | console 表示前にマスク |
| data/desktop-agent/ は gitignore | ✅ |

---

## 将来拡張

- **Windows 通知**: `node-notifier` をオプション追加（重い場合は console のみ）
- **Discord 通知**: Bot 経由で黒川チャンネルに自動投稿（要: Bot との連携）
- **ポーリング間隔**: 環境変数 `AGENT_INTERVAL_MS` で変更可能にする
