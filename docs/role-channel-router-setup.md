# Role Channel Router — セットアップガイド (Phase2)

> 対象: AI_WORKER Bot 管理者 (CEO / CTO)
> 目的: 社員別 Discord チャンネル配送を有効にし、#ai-worker チャンネルへの集中を解消する

---

## 概要

Phase2 で実装した Role Channel Router により、
`!workflow handoff` 実行時に送信先社員の Discord チャンネルへ直接メッセージを配送できる。

| 設定前 (fallback) | 設定後 |
|---|---|
| コマンドチャンネルに返信 | 宛先社員の専用チャンネルへ直接送信 |
| CEO が毎回コピペ中継 | Bot が自動配送 |
| #ai-worker に集中 | 社員別チャンネルへ分散 |

---

## ステップ1: Discord チャンネル ID を取得する

1. Discord アプリを開く
2. **設定 → 詳細設定 → 開発者モード を ON** にする
3. 対象チャンネルを **右クリック → 「IDをコピー」**
4. コピーした数字列 (`123456789012345678` のような形式) をメモする

---

## ステップ2: .env に CHANNEL_ID を設定する

`.env` ファイルを開き、末尾の Phase2 セクションに ID を入力する。

### 【最低限設定】主要ルートのみ有効化

```env
# 守谷 CTO チャンネル (IMPLEMENT_DONE / TECH_REVIEW_DONE の配送先)
MORIYA_CHANNEL_ID=123456789012345678

# 相沢 CS チャンネル (PM_READY の配送先)
AIZAWA_CHANNEL_ID=123456789012345679

# 黒川 CoS チャンネル (CS_READY / TECH_REVIEW_DONE の配送先)
KUROKAWA_CHANNEL_ID=123456789012345680

# CEO チャンネル (KUROKAWA_SUMMARY の配送先 / CEO判断必要案件のみ)
CEO_CHANNEL_ID=123456789012345681
```

### 【任意設定】全社員チャンネルを分離する場合

```env
MIYAGI_CHANNEL_ID=      # 宮城 Lead — NEED_FIX / SPEC_READY
SHIRAISHI_CHANNEL_ID=   # 白石 COO
ICHIKAWA_CHANNEL_ID=    # 市川 PM  — REVIEW_READY
KANEMORI_CHANNEL_ID=    # 金森 CFO — (現在は手動)
IKUNO_CHANNEL_ID=       # 育野     — LESSON / INCIDENT
KANZAKI_CHANNEL_ID=     # 神崎 VP  — VP_BRIEF_REQUEST
```

> 未設定の社員は引き続きコマンドチャンネルへの返信 (fallback) になる。
> 必要な社員分だけ設定すれば良い。

---

## ステップ3: Bot を再起動する

設定変更は `.env` の再読み込みが必要。Bot を再起動する。

```bash
# pm2 を使っている場合
pm2 restart ai-worker

# node 直接起動の場合
Ctrl+C → node bot/index.js

# Windows タスクマネージャの場合
index.js プロセスを終了 → 再度起動
```

---

## ステップ4: !router status で確認する

Discord でコマンドを送信:

```
!router status
```

出力例:
```
📡 Role Channel Router — チャンネル設定状況 (Phase2)

設定済み: 4 / 10
未設定の社員は従来チャンネルへ fallback します。

  ✅ 守谷 CTO: `123456789012345678` (MORIYA_CHANNEL_ID)
  ✅ 相沢 CS: `123456789012345679` (AIZAWA_CHANNEL_ID)
  ✅ 黒川 Chief of Staff: `123456789012345680` (KUROKAWA_CHANNEL_ID)
  ✅ CEO: `123456789012345681` (CEO_CHANNEL_ID)
  ⬜ 宮城 Lead Engineer: 未設定 (MIYAGI_CHANNEL_ID)
  ⬜ 白石 COO: 未設定 (SHIRAISHI_CHANNEL_ID)
  ...
```

---

## ルートと配送先の対応表

| ハンドオフイベント | from | to (配送先) | 対応 env 変数 |
|---|---|---|---|
| `IMPLEMENT_DONE` | 宮城 | 守谷 CTO | `MORIYA_CHANNEL_ID` |
| `NEED_FIX` | 守谷 | 宮城 Lead | `MIYAGI_CHANNEL_ID` |
| `REVIEW_READY` | 守谷 | 市川 PM | `ICHIKAWA_CHANNEL_ID` |
| `TECH_REVIEW_DONE` | 守谷 | 黒川 CoS | `KUROKAWA_CHANNEL_ID` |
| `SPEC_READY` | 市川 | 宮城 Lead | `MIYAGI_CHANNEL_ID` |
| `PM_READY` | 市川 | 相沢 CS | `AIZAWA_CHANNEL_ID` |
| `CS_READY` | 相沢 | 黒川 CoS | `KUROKAWA_CHANNEL_ID` |
| `KUROKAWA_SUMMARY` | 黒川 | CEO | `CEO_CHANNEL_ID` |
| `LESSON_CANDIDATE` | 任意 | 育野 | `IKUNO_CHANNEL_ID` |
| `INCIDENT_CANDIDATE` | 任意 | 育野 | `IKUNO_CHANNEL_ID` |
| `VP_BRIEF_REQUEST` | CEO | 神崎 VP | `KANZAKI_CHANNEL_ID` |

---

## 動作確認: !workflow handoff のテスト

設定後に以下のコマンドで実際の配送をテスト:

```
!workflow handoff IMPLEMENT_DONE miyagi TEST-001 テスト配送
```

- 守谷チャンネルにメッセージが届けば設定成功
- コマンドチャンネルには「守谷 CTOチャンネルへ配送しました」と返信される

---

## 禁止事項

- `.env` ファイルをリポジトリにコミットしない (`.gitignore` 対象)
- `CHANNEL_ID` の値を Discord / チャット / ドキュメントに直接書かない
- `CEO_CHANNEL_ID` を Bot テスト中に使用しない (実際の社長宛てに届く)

---

## トラブルシューティング

| 症状 | 確認ポイント |
|---|---|
| 設定後も fallback になる | Bot を再起動したか確認 |
| `!router status` が ⬜ になる | env 変数名のスペルミスを確認 |
| メッセージが届かない | Bot がそのチャンネルに参加しているか確認 |
| CEO チャンネルに届かない | `KUROKAWA_SUMMARY` イベントのみ CEO 宛て。他は届かない設計 |

---

*作成: 2026-06-07 / AI_WORKER Phase2 Internal Router*
