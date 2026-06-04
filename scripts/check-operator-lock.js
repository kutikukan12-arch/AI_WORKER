'use strict';
/**
 * check-operator-lock.js
 * bat から呼び出す専用ヘルパー。
 * operator.lock の状態を確認し、
 * exit code で結果を返す:
 *   0 = 起動可能（lock なし or stale）
 *   1 = 起動中（有効な lock が存在）
 */
const fs   = require('fs');
const path = require('path');

const LOCK = path.join(__dirname, '..', 'data', 'desktop-operator', 'operator.lock');

if (!fs.existsSync(LOCK)) {
  process.exit(0); // lock なし → 起動可能
}

try {
  const l   = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const age = Date.now() - new Date(l.startedAt).getTime();

  // PID 生存確認
  let alive = false;
  try { process.kill(Number(l.pid), 0); alive = true; } catch {}

  if (alive && age < 300000) {
    // 有効な lock → 起動中
    console.log('[INFO] 黒川は勤務中です (pid=' + l.pid + ', ' + Math.floor(age / 1000) + '秒前に起動)');
    process.exit(1);
  }

  // stale lock → 解除して起動可能
  fs.unlinkSync(LOCK);
  console.log('[OK] stale lock を解除しました (pid=' + l.pid + ')');
  process.exit(0);
} catch (e) {
  // 読み取り失敗 → 起動可能と見なす
  process.exit(0);
}
