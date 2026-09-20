/**
 * 提交顺序 —— 决定条目在新收藏夹里的排列。
 *
 * ## 规律（根因，四个环节串起来）
 *
 * 1. `bili.favItems` 用 `order=mtime` 读取 → 拿到的数组是**新→旧**
 * 2. `planFavClassify` 不排序，原样保留这个顺序
 * 3. `buildFavOps` 按数组序切 20 条一批提交 → **最新的最先提交**
 * 4. B 站收藏夹按 `fav_time` 降序显示，而 move/copy 会把 `fav_time`
 *    **重写成操作时间**
 *
 * 结果：最先提交的那批拿到最早的新时间戳，于是原本最新的收藏沉到了最底。
 *
 * 所以整条链路只需要记住一句话：
 *
 *     **提交顺序的逆序 = 最终显示顺序。想让某条排最前，就得最后提交它。**
 *
 * 第 4 环是实测结论，不是推测：跑 `bili-station probe fav-order --yes`
 * 会把 B 站的真实行为写进 ~/.bili-station/probes.json。
 *
 * ## 精度上限
 *
 * 一次 move 带 20 条，同批条目的 fav_time 很可能完全相同，所以**排序精度
 * 只能到批次粒度**。要逐条精确就得 `--chunk-size 1`，代价是 20 倍调用次数。
 */

export const ORDERS = ['original', 'reverse', 'pubdate', 'as-scanned'];

const tsFav = (it) => Number(it.favTime ?? it.fav_time ?? 0);
const tsPub = (it) => Number(it.pubTime ?? it.pubtime ?? 0);

/**
 * 按目标显示顺序决定提交顺序。
 *
 * 注意每个分支都是「想要的显示顺序」的**逆序**：
 *   original → 最近收藏的要排最上面 → 它必须最后提交 → 按 favTime 升序
 */
export function orderItems(items, order = 'original') {
  if (!ORDERS.includes(order)) throw new Error(`未知的排序方式：${order}`);
  if (order === 'as-scanned') return [...items];

  const key = order === 'pubdate' ? tsPub : tsFav;
  const desc = order === 'reverse';

  // 带上原始下标做稳定回退：没有时间戳的条目（假后端、旧缓存）保持原有相对次序
  return items
    .map((it, i) => ({ it, i, k: key(it) }))
    .sort((a, b) => (desc ? b.k - a.k : a.k - b.k) || a.i - b.i)
    .map((x) => x.it);
}

/**
 * 切批，并保证每批只含一个来源夹（move 接口要求单一 src_media_id）。
 *
 * scope:
 *   per-source  先按来源分组再切批。调用次数与不排序时完全相同，但**来源之间
 *               的先后由分组顺序决定**，跨来源的全局顺序会被打断。
 *   global      严格按传入顺序走，来源一变就换批。全局有序，代价是来源交错处
 *               会产生不满 chunkSize 的碎块，调用次数上升。
 *
 * @returns {Array<{src: any, items: Array}>}
 */
export function chunkBySource(items, { chunkSize = 20, scope = 'per-source', srcOf = (it) => it.srcMediaId } = {}) {
  const out = [];

  if (scope === 'per-source') {
    const bySrc = new Map();
    for (const it of items) {
      const s = srcOf(it);
      if (!bySrc.has(s)) bySrc.set(s, []);
      bySrc.get(s).push(it);
    }
    for (const [src, list] of bySrc) {
      for (let i = 0; i < list.length; i += chunkSize) {
        out.push({ src, items: list.slice(i, i + chunkSize) });
      }
    }
    return out;
  }

  if (scope !== 'global') throw new Error(`未知的 order-scope：${scope}`);

  let cur = null;
  for (const it of items) {
    const s = srcOf(it);
    if (!cur || cur.src !== s || cur.items.length >= chunkSize) {
      cur = { src: s, items: [] };
      out.push(cur);
    }
    cur.items.push(it);
  }
  return out;
}

/**
 * 干跑摘要用：两种 scope 各要多少次调用。
 * 让用户自己权衡「严格有序」值不值那几十次额外调用，而不是替他决定。
 */
export function orderCost(items, { chunkSize = 20, srcOf = (it) => it.srcMediaId } = {}) {
  const perSource = chunkBySource(items, { chunkSize, scope: 'per-source', srcOf }).length;
  const global = chunkBySource(items, { chunkSize, scope: 'global', srcOf }).length;
  return { perSource, global, extra: global - perSource };
}
