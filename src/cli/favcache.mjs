/**
 * 收藏夹缓存的**唯一**读写入口。
 *
 * 重构前 sort 绕过了归一化自己读写（cli.mjs:375/388），而 scan/merge/dead 走
 * loadCache()。同一份缓存两个读者、两套归一化，正是之前那个
 * 「Spread syntax requires ...iterable」崩溃的同一类问题的残留：
 * 旧格式（裸数组）的缓存在 sort 里会被当成空，静默触发一次全量重扫。
 *
 * 现在只有这一个入口。缓存结构统一为 { items, complete, nextPage }。
 */
import * as store from '../store.mjs';

const FILE = 'favorites.json';

/** 旧格式（裸数组）兼容：统一成 { items, complete, nextPage } */
export function loadCache() {
  const cached = store.read(FILE, null);
  const m = new Map();
  for (const [k, v] of (cached?.items ?? [])) {
    m.set(Number(k), Array.isArray(v) ? { items: v, complete: true, nextPage: null } : v);
  }
  return m;
}

export function saveCache(folders, cache) {
  return store.write(FILE, { folders, items: [...cache] });
}

export function itemsOf(cache, id) {
  return cache.get(Number(id))?.items ?? [];
}

export function cachedFolders() {
  return store.read(FILE, null)?.folders ?? [];
}

/**
 * 扫描一个收藏夹，带断点续扫与缓存保护。
 * 原则：**绝不用更差的结果覆盖已有缓存**。失败的扫描把好数据盖掉，
 * 会让下一次从零开始，用更多请求去撞同一堵墙。
 */
export async function scanFolder(bili, id, cache, { refresh = false, onSay = () => {}, pageDelayMs, folderCount = 0 } = {}) {
  const prev = cache.get(Number(id));
  if (!refresh && prev?.complete) return prev;

  const startPage = (!refresh && prev && !prev.complete && prev.nextPage) ? prev.nextPage : 1;
  const seed = startPage > 1 ? (prev.items ?? []) : [];
  if (startPage > 1) onSay(`    从第 ${startPage} 页续扫（已有 ${seed.length} 条）`);

  // 大收藏夹要翻几百页，用小夹那种节奏必然撞 412。按规模自动降速。
  const pages = Math.ceil((folderCount || 0) / 20);
  const auto = pages > 150 ? 2200 : pages > 50 ? 1400 : 450;
  const delay = pageDelayMs ?? auto;
  const jitter = Math.round(delay * 1.1);
  if (pages > 50) {
    onSay(`    约 ${pages} 页，翻页间隔 ${(delay / 1000).toFixed(1)}~${((delay + jitter) / 1000).toFixed(1)}s，预计 ${Math.ceil(pages * (delay + jitter / 2) / 60000)} 分钟`);
  }

  const r = await bili.favItems(id, (n, info) => {
    if (info?.throttled) onSay(`    ⏸ 读取被限流（code=${info.code}），退避 ${Math.round(info.waitMs / 1000)}s 后重试（第 ${info.attempt} 次）`);
    else if (n && n % 200 === 0) onSay(`    ${n} 条…`);
  }, { startPage, seed, pageDelayMs: delay, pageJitterMs: jitter, backoffMs: 30_000, maxRetry: 5 });

  const next = { items: r.list, complete: !!r.complete, nextPage: r.nextPage ?? null };

  // 只有「扫完了」或「拿到的更多」才写回缓存
  const better = next.complete || next.items.length > (prev?.items?.length ?? -1);
  if (better) cache.set(Number(id), next);
  else onSay(`    ⚠ 本次只拿到 ${next.items.length} 条，不如已缓存的 ${prev.items.length} 条，保留旧数据`);

  if (!next.complete) {
    onSay(`    ⚠ 未扫完（停在第 ${r.error?.atPage ?? '?'} 页，code=${r.error?.code}），已保存进度，下次自动续扫`);
  }
  return cache.get(Number(id)) ?? next;
}

/**
 * 批量扫描若干夹。scan / merge / dead 原本各抄了一遍这段（连 f.count 已在
 * 作用域内还要再 find 一次的冗余都一起抄了），现在统一到这里。
 */
export async function scanMany(bili, ids, folders, ctx, { refresh = false, pageDelayMs } = {}) {
  const cache = loadCache();
  const byId = new Map(folders.map((f) => [Number(f.id), f]));
  const itemsById = new Map();
  let incomplete = 0;

  for (const id of ids) {
    const f = byId.get(Number(id));
    const have = cache.get(Number(id));
    if (!have?.complete || refresh) ctx.say(`  拉取「${f?.title ?? id}」（${f?.count ?? '?'} 条）…`);
    const r = await scanFolder(bili, id, cache, {
      refresh, onSay: ctx.say, folderCount: f?.count ?? 0,
      ...(pageDelayMs != null ? { pageDelayMs } : {}),
    });
    if (!r.complete) incomplete++;
    itemsById.set(Number(id), r.items);
  }

  saveCache(folders, cache);
  return { cache, itemsById, incomplete };
}
