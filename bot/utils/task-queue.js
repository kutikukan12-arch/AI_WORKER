'use strict';

// =====================================================
// task-queue.js - タスクキュー（Phase5）
//
// 役割:
//   !claude コマンドを順番に実行するキュー。
//   同時実行数（MAX_CONCURRENT_TASKS）を超えた場合、
//   タスクをキューに積んで順番に処理する。
//
// 設定（.env）:
//   MAX_CONCURRENT_TASKS=1  同時実行数（デフォルト: 1）
//
// コマンド:
//   !queue          キュー状況を表示
//   !queue clear    キューを空にする（オーナーのみ）
// =====================================================

const logger = require('./logger');

class TaskQueue {
  constructor(maxConcurrent) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.running = 0;
    this.queue   = []; // { id, execute }
  }

  // ── アクセサ ──────────────────────────────────────

  get pendingCount() { return this.queue.length; }
  get activeCount()  { return this.running; }
  get isAtCapacity() { return this.running >= this.maxConcurrent; }
  get totalCount()   { return this.running + this.queue.length; }

  // ─────────────────────────────────────────────────────
  // enqueue - タスクをキューに追加する
  //
  // 戻り値:
  //   0   → すぐに実行開始
  //   N>0 → キューの N 番目に追加
  // ─────────────────────────────────────────────────────
  enqueue(id, execute) {
    if (!this.isAtCapacity) {
      this.running++;
      setImmediate(() => this._run(id, execute));
      logger.debug(`キュー: タスク ${id} 即時実行（実行中: ${this.running}）`);
      return 0;
    }
    this.queue.push({ id, execute });
    const pos = this.queue.length;
    logger.info(`キュー: タスク ${id} を ${pos} 番目に追加（実行中: ${this.running}）`);
    return pos;
  }

  // ─────────────────────────────────────────────────────
  // _run - タスクを実行し、完了後に次のタスクを開始する
  // ─────────────────────────────────────────────────────
  async _run(id, execute) {
    try {
      await execute();
    } catch (e) {
      logger.error(`キュー: タスク ${id} で予期しないエラー: ${e.message}`);
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.running++;
        logger.info(`キュー: タスク ${next.id} の実行を開始（残り待機: ${this.queue.length}）`);
        setImmediate(() => this._run(next.id, next.execute));
      }
    }
  }

  // ─────────────────────────────────────────────────────
  // getStatus - キュー状況を返す
  // ─────────────────────────────────────────────────────
  getStatus() {
    return {
      active:     this.running,
      queued:     this.queue.length,
      max:        this.maxConcurrent,
      pendingIds: this.queue.map(t => t.id),
    };
  }

  // ─────────────────────────────────────────────────────
  // clear - 待機中のタスクを全削除（実行中は止めない）
  // ─────────────────────────────────────────────────────
  clear() {
    const count = this.queue.length;
    this.queue  = [];
    logger.info(`キュー: 待機中タスクを ${count} 件削除`);
    return count;
  }

  // ─────────────────────────────────────────────────────
  // formatStatus - Discord 表示用の文字列を返す
  // ─────────────────────────────────────────────────────
  formatStatus() {
    const { active, queued, max, pendingIds } = this.getStatus();
    const lines = [
      `**タスクキュー状況**`,
      `> 実行中: ${active} / ${max}`,
      `> 待機中: ${queued} 件`,
    ];

    if (pendingIds.length > 0) {
      // 最大5件表示、残りは「ほかN件」
      const SHOW_MAX = 5;
      const shown    = pendingIds.slice(0, SHOW_MAX);
      const rest     = pendingIds.length - shown.length;
      const idText   = shown.map(id => `\`${id}\``).join(', ');
      lines.push(`> 待機タスク: ${idText}${rest > 0 ? ` ほか${rest}件` : ''}`);
    }

    return lines.join('\n');
  }
}

module.exports = new TaskQueue(
  parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10)
);
