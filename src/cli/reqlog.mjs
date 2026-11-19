/**
 * 请求级埋点：每次请求一行 JSONL。
 *
 * 为什么要有：之前只知道「4980 次里失败 4595」，但答不出最关键的问题 ——
 * 失败是在第几次、什么速率下开始的？墙砸下来之后漏过率是多少？
 * 聚合数字丢掉了时间维度，而限流的一切都在时间维度上。
 *
 * 一行一个请求，写完即 flush（append 模式），中断也不丢已写的部分。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../store.mjs';

export function openLog(name) {
  const path = join(store.DATA_DIR, name);
  const t0 = Date.now();
  let seq = 0;
  return {
    path,
    t0,
    /** @param {{code, ok, delayMs, note?}} row */
    record(row) {
      seq++;
      const t = Date.now();
      const line = JSON.stringify({
        seq,
        t,
        sinceStartMs: t - t0,
        ...row,
      });
      try { appendFileSync(path, line + '\n', 'utf8'); } catch { /* 埋点失败不该中断任务 */ }
      return seq;
    },
    get seq() { return seq; },
  };
}

export function readLog(name) {
  const path = join(store.DATA_DIR, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * 从原始日志推出限流曲线。
 *
 * 要回答三个问题：
 *   · 第一次失败在第几次请求、当时的瞬时速率是多少
 *   · 墙砸下来之后的漏过率
 *   · 每个速率档位撑了多少次请求
 */
export function analyze(rows, { windowSize = 25 } = {}) {
  if (!rows.length) return null;
  const ok = (r) => r.ok === true;
  const firstFail = rows.find((r) => !ok(r));

  // 瞬时速率：用前后 windowSize 个请求的时间跨度算
  const rateAt = (i) => {
    const lo = Math.max(0, i - windowSize);
    const span = (rows[i].sinceStartMs - rows[lo].sinceStartMs) / 1000;
    return span > 0 ? ((i - lo) / span) * 60 : null;
  };

  // 按 windowSize 分段统计成功率
  const buckets = [];
  for (let i = 0; i < rows.length; i += windowSize) {
    const seg = rows.slice(i, i + windowSize);
    const okN = seg.filter(ok).length;
    buckets.push({
      from: seg[0].seq,
      to: seg[seg.length - 1].seq,
      n: seg.length,
      ok: okN,
      rate: (okN / seg.length),
      reqPerMin: rateAt(Math.min(i + windowSize - 1, rows.length - 1)),
      delayMs: seg[0].delayMs ?? null,
    });
  }

  // 墙之后的漏过率
  const afterWall = firstFail ? rows.slice(rows.indexOf(firstFail)) : [];
  const leak = afterWall.length ? afterWall.filter(ok).length / afterWall.length : null;

  // 每个 delay 档位撑了多少次、失败了多少
  const byDelay = new Map();
  for (const r of rows) {
    const d = r.delayMs ?? 0;
    if (!byDelay.has(d)) byDelay.set(d, { delayMs: d, n: 0, ok: 0 });
    const b = byDelay.get(d);
    b.n++; if (ok(r)) b.ok++;
  }

  return {
    total: rows.length,
    okTotal: rows.filter(ok).length,
    firstFailAt: firstFail?.seq ?? null,
    firstFailCode: firstFail?.code ?? null,
    firstFailAfterMs: firstFail?.sinceStartMs ?? null,
    rateAtFirstFail: firstFail ? rateAt(rows.indexOf(firstFail)) : null,
    leakRateAfterWall: leak,
    buckets,
    byDelay: [...byDelay.values()].sort((a, b) => b.delayMs - a.delayMs),
  };
}
