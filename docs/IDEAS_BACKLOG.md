# IDEAS BACKLOG（一時保管・育野 Learning Manager 管理）

> 方針: 今すぐ実装しない改善Idea を軽量に保管する。記憶量を増やすためではなく、**回収トリガが来た時に拾えるようにする**ため。
> 各Ideaには「回収トリガ（いつ拾うか）」を必ず付ける。不要になったら削除ではなく `DROPPED` に印を付けて履歴保持。

---

## 黒川 Desktop Bridge

**回収トリガ: Bridge の次回拡張・修正時にまとめて回収**

### Idea-1 bridge-status.js の文言と実装の不一致整理
- 現状: コメント/commit文言に「kurokawa-report再利用」とあるが、実装は直接読み取り。
- 影響: **安全影響なし**（動作は正しい）。文言と実装の乖離のみ。
- 検討: 次回Bridge修正時に ①文言修正 または ②共有ヘルパー整理（実際に再利用構造へ）を検討。
- 参照: `bot/utils/bridge-status.js`

### Idea-2 !bridge status の固定表示順テスト追加
- 現状: 表示順は固定だが、順序を保証するテストが無い。
- 目的: 将来の並べ替え混入（リグレッション）を防ぐ。
- 検討: `tests/bridge_status_test.js` に表示順固定のテストを追加。
- 参照: `bot/utils/bridge-status.js` / `tests/bridge_status_test.js`
