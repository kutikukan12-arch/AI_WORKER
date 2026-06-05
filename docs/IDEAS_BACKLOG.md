# IDEAS BACKLOG（一時保管・育野 Learning Manager 管理）

> 目的: 今すぐ実装しない改善Idea を軽量に保管する。記憶量を増やすためではなく、**回収トリガが来た時に拾えるようにする**ため。

## 運用ルール（必読）

このバックログが「**第二の無限タスクリスト**」になることを防ぐためのルール。

1. **Idea登録 = 実装予定ではない。** ここに書いても「やる約束」にはならない。
2. **必ず回収条件を書く。** いつ拾うかが無いIdeaは登録しない。
   - 例: 「次回Bridge変更時」「βユーザーから同じ不満が3件以上」「売上発生後」
3. **回収条件を満たさないIdeaは触らない。** 条件未達のものを先回りで着手しない。
4. **定期的な全Idea消化は禁止。** 「溜まったから一気に片付ける」をやらない（消化を目的化しない）。
5. **古いIdeaも削除しない。** 状態印で履歴保持する：
   - `ADOPTED`（採用→実装/Decision化した） / `DROPPED`（不要と判断） / `MERGED`（他Ideaへ統合）

---

## 黒川 Desktop Bridge  〔CLOSED〕

**状態: Bridge最小版 READY / Bridge追加改善は停止（2026-06）。次フェーズは YouTube診断β。**
回収トリガ（旧: Bridge次回拡張時）は、下記Idea解消により消化済み。

### Idea-1 bridge-status.js の文言と実装の不一致整理 ⟶ `ADOPTED`（commit 6ca8db7）
- 現状（当時）: コメント/commit文言に「kurokawa-report再利用」とあるが、実装は直接読み取り。安全影響なし。
- 解消: 6ca8db7 で虚偽コメント削除＋正確な記述（task-manager/workflow-state 等を直接読み取り）に修正。
- 参照: `bot/utils/bridge-status.js`

### Idea-2 !bridge status の固定表示順テスト追加 ⟶ `ADOPTED`（commit 6ca8db7）
- 現状（当時）: 表示順は固定だが、順序を保証するテストが無い。
- 解消: 6ca8db7 で固定順テスト（3h: 表示位置検証 / 3i: .sort()不在検証）を追加。23/23 pass。
- 参照: `bot/utils/bridge-status.js` / `tests/bridge_status_test.js`
