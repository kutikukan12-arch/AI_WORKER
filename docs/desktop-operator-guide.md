# 黒川 Desktop Operator ガイド

**作成:** 2026-06-04  
**担当:** 🅶 黒川 Chief of Staff  
**目的:** outbox のメッセージを Claude Desktop へ安全に投入する

---

## 概要

```
AI_WORKER (!workflow handoff)
    ↓ autoHandoff → outbox/<worker>/outgoing.md
Desktop Operator
    ↓ allowlist + risk scan
    ↓ prompt wrapper 付与
クリップボードへコピー（or Claude Desktop へ直接投入）
    ↓ 社長が確認・送信
```

---

## 権限境界

### 許可
- 固定ルート（FIXED_ROUTES allowlist）由来のメッセージを clipboard へコピー
- リスクスキャン（secret/injection/危険コマンド を検出してブロック）
- Audit log 記録
- Prompt wrapper 付与（社員ペルソナ・ルール・結果フォーマット）

### 禁止
- 判断代理（READY/NEED_FIX判断・承認・優先順位変更）
- OSコマンドとして本文を実行
- eval / exec による本文実行
- CEO_CONFIRM_REQUIRED / BLOCKED / HUMAN_APPROVAL_REQUIRED の自動通過

---

## 推奨起動方法

### ✅ 推奨: PowerShell 版（日本語パス対応）

```powershell
# 直接実行（推奨）
powershell -ExecutionPolicy Bypass -File start-operator.ps1

# または右クリック → PowerShellで実行
```

### BAT 経由（PS1 ラッパー）

```bat
REM ダブルクリック → PS1 を呼ぶだけ（英数字のみ・文字化けなし）
start-operator.bat
```

> BAT は PowerShell へのラッパーのみ。日本語メッセージなし。  
> D:\璃蘭\AI_WORKER のような日本語パスでも start-operator.ps1 は正常動作します。

### npm から

```bash
npm run operator
```

### CLI 直接

```bash
node scripts/desktop-operator.js watch   # 常駐監視（推奨）
node scripts/desktop-operator.js once    # 1回チェック
node scripts/desktop-operator.js dry-run # 確認のみ
node scripts/desktop-operator.js status  # 状態表示
```

---

## 処理フロー

```
1. outbox/<worker>/outgoing.md を読む
2. ハッシュ比較（既読スキップ）
3. workflow-state.json で handoff record を確認
   → autoExecuted:true かつ reason:fixed_route のもののみ
4. Auto Send Allowlist チェック
   → ALLOWED_EVENTS に含まれるか
5. Risk Scanner
   → secret / token / injection / dangerous commands をスキャン
6. Prompt Wrapper 付与
   → 社員ペルソナ・ルール・結果フォーマットを先頭に追加
7. クリップボードへコピー
8. Audit Log (data/desktop-operator/history.json) に記録
```

---

## Auto Send Allowlist

| イベント | 概要 |
|---------|------|
| IMPLEMENT_DONE | 実装完了 → 守谷へレビュー依頼 |
| NEED_FIX | NEED_FIX → 宮城へ修正依頼 |
| REVIEW_READY | READY → 市川へ商品確認 |
| LESSON_CANDIDATE | Lesson候補 → 育野 |
| INCIDENT_CANDIDATE | Incident候補 → 育野 |
| VP_BRIEF_REQUEST | 判断材料整理 → 神崎 |

---

## Risk Scanner ブロック条件

- API key / token (ghp_, sk-proj-, Discord Token 等)
- .env 全文（DISCORD_TOKEN= 等）
- Private Key ブロック
- rm -rf / format disk / curl | sh
- git push --force / npm publish
- Prompt Injection 文言
- 承認偽装 / CEO判断不要指示

---

## データファイル

| ファイル | 内容 |
|---------|------|
| `data/desktop-operator/state.json` | 監視状態・lastHash |
| `data/desktop-operator/history.json` | 監査ログ（直近500件）|
| `data/desktop-operator/locks/` | 多重起動防止ロック |

すべて `.gitignore` 済み。

---

## E2E テスト手順 (L-20)

### 前提条件
- `npm run operator` 起動済み
- `!operator mode autosend-limited` 設定済み

### 推奨テストコマンド

```
!workflow handoff VP_BRIEF_REQUEST ceo e2e_test 神崎さん、E2Eテストです。## 結論 を含めて返してください。
```

### よくある停止理由と対処

| reason | 意味 | 対処 |
|--------|------|------|
| `handoff_record_not_found` | !inbox send 経由（!workflow handoff 未使用）| `!workflow handoff` を使う |
| `risk_blocked` | secret / token 検出 | 内容を確認してクリーン化 |
| `event_not_allowed` | FIXED_ROUTES 外のイベント | `!operator reliability` で確認 |
| `blocked_keyword` | NG キーワード（支払い等）| 内容から除去 |

### 確認コマンド

```
!operator reliability   → blockedReason の分類を表示
!inbox check kanzaki    → 神崎の inbox に回答が保存されているか確認
```

---

## 注意

1. クリップボードへコピー後、社長が内容を確認してから Claude Desktop へ貼り付けてください
2. auto-send モードは将来対応予定（robotjs 等が必要）
3. ブロックされたメッセージは `!operator status` または `status` コマンドで確認できます
