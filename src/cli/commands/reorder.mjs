/**
 * reorder —— 夹内重排。
 *
 * ## 为什么要来回搬一趟
 *
 * B 站没有「夹内排序」接口。条目次序完全由 `fav_time` 降序决定，而 `fav_time`
 * 只有在 move/copy 进一个**不同的**夹时才会被重写。实测 `src_media_id == tar_media_id`
 * 的 copy 和 move 都返回 `code:0 OK` 却什么都不做 —— 是静默空操作，不是报错。
 * （这正是最危险的一类结果：不探一下就会白跑几百次写操作还以为成功了。）
 *
 * 所以唯一可行的路径是：
 *
 *     原夹 ──全部搬出──▶ 中转夹 ──按目标次序搬回──▶ 原夹
 *
 * 代价是写操作翻倍：n 条要 2×⌈n/20⌉ 次调用。没有更省的办法。
 *
 * ## 次序怎么定
 *
 * 见 order.mjs：**提交顺序的逆序 = 最终显示顺序**，想排最前的必须最后提交。
 * 这条规律在批内、批间一致（受控实验结论），所以 20 条一批也能排到逐条精确，
 * 不必为了精度去调小 chunk-size。搬出那趟不影响最终次序，所以不排序。
 *
 * ## 为什么要 --true-fav-from
 *
 * 一旦搬运过，夹里读到的 `fav_time` 就全是搬运当时的时间戳，「什么时候收藏的」
 * 这个信息已经不在账号上了 —— 此时按当前 fav_time 排序，排的是搬运顺序而不是收藏顺序。
 * 真实收藏时间只存在于搬运前的备份快照里，所以支持从快照回灌。
 *
 * 不给这个参数也能跑，那就是单纯按当前次序反转；区别只在少数条目（从没被搬过的
 * 存量条目、搬运之后新收藏的）会落在错误的一端。
 *
 * ## 中断怎么办
 *
 * 搬出与搬回之间断掉，条目会滞留在中转夹里。所以执行前先把**计划本身**落盘到
 * `reorder-state.json`：续跑时不重新规划，而是用这份状态重建同一套 op，
 * 靠断点跳过已完成的。中转夹里有东西却没有状态文件时**直接拒绝**，
 * 不去猜那些条目该回哪个夹。
 */
import { readFileSync } from 'node:fs';
import { defineCommand } from '../registry.mjs';
import { store } from '../context.mjs';
import { scanMany, loadCache, saveCache } from '../favcache.mjs';
import { buildReorderOps } from '../../executor.mjs';
import { orderItems, chunkBySource } from '../../order.mjs';

const TEMP_TITLE = '_reorder_中转';
const STATE_FILE = 'reorder-state.json';
const RESUME_KEY = 'reorder';
const RESUME_FILE = 'resume-' + RESUME_KEY + '.json';

/**
 * 默认收藏夹的识别。
 *
 * 依据是本账号实测到的 attr 取值：默认夹 0/1，普通夹 22/23/54/55 —— bit1(=2)
 * 在所有普通夹上都置位、在默认夹上清零。这是从样本推的，不是文档保证的，
 * 所以再叠一层标题兜底，并且干跑时会把判定结果打出来让人过目。
 */
const isDefaultFolder = (f) =>
  ((Number(f.attr) || 0) & 2) === 0 || String(f.title).trim() === '默认收藏夹';

/**
 * 从搬运前的备份快照里恢复每条的真实收藏时间。
 *
 * 非默认夹的记录优先于默认夹的记录：合并那一步先把各夹并进了默认夹，所以默认夹
 * 快照里那批条目的时间已经被改成「合并时间」了；而同一份快照里还留着合并前
 * 各夹的旧缓存，那里面的时间才没被污染。
 */
function loadTrueFavTimes(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const payload = raw?.payload ?? raw;
  const snapFolders = payload?.folders ?? [];
  const defaultIds = new Set(snapFolders.filter(isDefaultFolder).map((f) => String(f.id)));

  const fromDefault = new Map();
  const fromFolders = new Map();
  for (const [fid, v] of (payload?.items ?? [])) {
    const list = Array.isArray(v) ? v : (v?.items ?? []);
    const into = defaultIds.has(String(fid)) ? fromDefault : fromFolders;
    for (const it of list) {
      if (it?.id == null || !it.favTime) continue;
      into.set(String(it.id), Number(it.favTime));
    }
  }
  return {
    get: (id) => fromFolders.get(String(id)) ?? fromDefault.get(String(id)) ?? null,
    counts: { fromFolders: fromFolders.size, fromDefault: fromDefault.size },
  };
}

/** 状态文件里只留搬运必需的字段：id + type 就够拼 resource 串了 */
const slim = (it) => ({ id: it.id, type: it.type ?? 2 });

export default defineCommand({
  name: 'reorder',
  summary: '重排收藏夹内的条目次序（经中转夹来回搬一趟）',
  usage: '[夹id或名称...]',
  needsChrome: true,
  mutating: true,
  flags: {
    order: {
      type: 'enum',
      values: ['original', 'reverse', 'pubdate'],
      default: 'original',
      desc: 'original=最近收藏的排最上面（B 站本来的样子）/ reverse=最早收藏的排最上面 / pubdate=最新投稿的排最上面',
    },
    'true-fav-from': {
      type: 'path',
      desc: '从搬运前的备份快照回灌真实收藏时间。搬运过的夹必须给它，否则排的是搬运顺序不是收藏顺序',
    },
    'chunk-size': {
      type: 'int', min: 1, max: 20, default: 20,
      desc: '每批多少条。20 已经能排到逐条精确（同批内部也遵循「先提交的排后面」），调小只会成倍增加调用次数',
    },
    'include-default': { type: 'boolean', desc: '默认收藏夹也一起重排（默认跳过）' },
    refresh: { type: 'boolean', desc: '强制重扫，不用本地缓存（搬运过之后缓存必然是陈的）' },
    restart: { type: 'boolean', desc: '丢弃上次的重排状态重新规划。中转夹非空时会拒绝' },
  },
  examples: [
    'reorder',
    'reorder --true-fav-from ~/.bili-station/backups/favorites-xxx.json --refresh',
    'reorder 游戏攻略 --order pubdate --yes',
  ],

  async plan(ctx) {
    const folders = await ctx.bili.favFolders();
    const temp = folders.find((f) => f.title.trim() === TEMP_TITLE) ?? null;
    const chunkSize = ctx.flags['chunk-size'];

    // 中转夹里是不是还有上次没搬完的？这一步必须在规划之前 ——
    // 夹被掏空的状态下去「重新规划」会得到一份完全错误的计划。
    const tempItems = temp
      ? (await ctx.bili.favItems(temp.id, null, { pageDelayMs: 500 })).list
      : [];

    const tempHandle = { id: temp?.id ?? null };

    if (tempItems.length) {
      const saved = store.read(STATE_FILE, null);
      if (!saved?.jobs?.length) {
        return ctx.usageError(
          `中转夹「${TEMP_TITLE}」里还有 ${tempItems.length} 条，但 ${STATE_FILE} 里没有对应的状态记录 ——`
          + '不去猜它们该回哪个夹。请先手动把它们归位（或删掉中转夹）再重跑。'
        );
      }
      if (ctx.flags.restart) {
        return ctx.usageError(`中转夹里还有 ${tempItems.length} 条没搬回，此时 --restart 会把它们丢在那儿。先把这一轮跑完。`);
      }

      // 续跑：用状态文件重建同一套 op，断点会跳过已完成的那些
      const known = new Set(saved.jobs.flatMap((j) => j.items.map((x) => String(x.id))));
      const orphans = tempItems.filter((x) => !known.has(String(x.id)));
      const jobs = saved.jobs.map((j) => ({ ...j, out: j.items, ordered: j.items }));

      return {
        data: {
          resumed: true, tempId: temp.id, stranded: tempItems.length, orphans: orphans.length,
          order: saved.order, folders: saved.jobs.map((j) => ({ id: j.id, title: j.title, count: j.items.length })),
        },
        warnings: orphans.length
          ? [`中转夹里有 ${orphans.length} 条不在状态记录里，本次不会动它们：` + orphans.slice(0, 5).map((x) => x.title).join('、')]
          : [],
        // planId 必须沿用状态文件里的那个，否则续跑会认不出自己上一轮做过的 op
        ops: buildReorderOps(ctx.bili, jobs, tempHandle, { chunkSize: saved.chunkSize ?? chunkSize, planId: saved.at }),
        backup: { kind: 'reorder-resume', payload: saved },
        jobKind: 'reorder', resumeKey: RESUME_KEY,
        _afterRun: (c) => cleanup(c, tempHandle, saved.jobs.map((j) => j.id)),
      };
    }

    // ---------- 全新规划 ----------
    if (ctx.flags.restart) store.write(STATE_FILE, null);

    const picks = ctx.positionals.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    const candidates = folders.filter((f) => f.title.trim() !== TEMP_TITLE);
    let targets;
    if (picks.length) {
      const miss = [];
      targets = picks.map((p) => {
        const hit = candidates.find((f) => String(f.id) === p || f.title.trim().toLowerCase() === p.toLowerCase());
        if (!hit) miss.push(p);
        return hit;
      }).filter(Boolean);
      if (miss.length) return ctx.usageError(`找不到这些收藏夹：${miss.join('、')}`);
    } else {
      targets = candidates.filter((f) => ctx.flags['include-default'] || !isDefaultFolder(f));
    }
    targets = targets.filter((f) => f.count > 1); // 0 或 1 条的夹，重排没有意义

    if (!targets.length) {
      return { data: { nothing: true }, ops: [], nothingReason: '没有需要重排的收藏夹（空夹和只有 1 条的夹会跳过）' };
    }

    const skippedDefault = candidates.filter((f) => isDefaultFolder(f) && !targets.includes(f));

    let trueFav = null;
    if (ctx.flags['true-fav-from']) {
      try { trueFav = loadTrueFavTimes(ctx.flags['true-fav-from']); }
      catch (e) { return ctx.usageError(`读不了 --true-fav-from 快照：${e.message}`); }
    }

    ctx.say(`扫描 ${targets.length} 个收藏夹的当前内容…`);
    const { itemsById, incomplete } = await scanMany(
      ctx.bili, targets.map((f) => f.id), folders, ctx, { refresh: !!ctx.flags.refresh }
    );
    if (incomplete) {
      // 扫不全就重排 = 把没扫到的那些留在原地、次序全乱。宁可不做。
      return ctx.usageError(`有 ${incomplete} 个收藏夹没扫完（多半是被限流了）。重排必须基于完整清单，请稍后重跑。`);
    }

    const jobs = [];
    const perFolder = [];
    let recovered = 0;
    let kept = 0;
    for (const f of targets) {
      const items = itemsById.get(Number(f.id)) ?? [];
      if (items.length < 2) continue;
      // 回灌真实收藏时间。取不到的就保留当前值 —— 对「从没被搬过」和
      // 「搬完之后才收藏」的条目来说，当前值本来就是真的。
      const withTrue = items.map((it) => {
        const t = trueFav?.get(it.id) ?? null;
        if (t) { recovered++; return { ...it, favTime: t }; }
        kept++;
        return it;
      });
      const ordered = orderItems(withTrue, ctx.flags.order);
      jobs.push({ id: Number(f.id), title: f.title, items: ordered.map(slim) });
      // 搬回那趟按类型断批，碎块数不等于 ⌈条数/20⌉ —— 必须按真实切批算，
      // 否则干跑打印的次数会和实际执行的对不上。
      const inBatches = chunkBySource(ordered, { chunkSize, scope: 'global', srcOf: (it) => it.type ?? 2 }).length;
      perFolder.push({
        id: Number(f.id), title: f.title, count: items.length,
        calls: Math.ceil(items.length / chunkSize) + inBatches,
        top: ordered[ordered.length - 1]?.title ?? null, // 最后提交的 = 显示在最上面的
      });
    }

    const state = {
      at: new Date().toISOString(),
      order: ctx.flags.order,
      chunkSize,
      trueFavFrom: ctx.flags['true-fav-from'] ?? null,
      jobs,
    };

    const ops = [];
    if (!temp) {
      ops.push({
        // 不带 key：建夹的幂等靠「这个夹是不是真的存在」判断，不靠断点记录。
        // 它同时负责把 id 回填给下面所有搬运 op，所以每次都必须跑。
        label: `新建中转夹「${TEMP_TITLE}」（私密）`,
        op: 'folderAdd',
        run: async () => {
          const fresh = await ctx.bili.favFolders();
          const hit = fresh.find((f) => f.title.trim() === TEMP_TITLE);
          if (hit) { tempHandle.id = hit.id; return { code: 0, data: { id: hit.id }, _reused: true }; }
          const body = await ctx.bili.createFolder(TEMP_TITLE, { privacy: 1 });
          if (body?.code === 0 && body.data?.id) tempHandle.id = body.data.id;
          return body;
        },
      });
    }
    ops.push(...buildReorderOps(
      ctx.bili,
      jobs.map((j) => ({ ...j, out: j.items, ordered: j.items })),
      tempHandle,
      { chunkSize, planId: state.at }
    ));

    // 计划本身要在动手之前落盘：中途断掉时，它是「这些条目该回哪个夹」的唯一依据。
    if (ctx.yes) store.write(STATE_FILE, state);

    return {
      data: {
        order: ctx.flags.order,
        chunkSize,
        totalItems: jobs.reduce((n, j) => n + j.items.length, 0),
        folders: perFolder,
        skippedDefault: skippedDefault.map((f) => ({ id: f.id, title: f.title })),
        trueFav: trueFav ? { ...trueFav.counts, recovered, kept } : null,
        tempFolder: temp ? { id: temp.id, existing: true } : { id: null, existing: false },
      },
      ops,
      backup: { kind: 'reorder', payload: state },
      jobKind: 'reorder', resumeKey: RESUME_KEY,
      _afterRun: (c) => cleanup(c, tempHandle, jobs.map((j) => j.id)),
    };
  },

  render(r, ctx) {
    const d = r.data;
    if (d.nothing) return;

    if (d.resumed) {
      ctx.say(`续跑：中转夹（id ${d.tempId}）里滞留 ${d.stranded} 条，按上次的计划搬回 ${d.folders.length} 个夹`);
      for (const f of d.folders) ctx.say(`  「${f.title}」${f.count} 条`);
      return;
    }

    const word = { original: '最近收藏的排最上面', reverse: '最早收藏的排最上面', pubdate: '最新投稿的排最上面' }[d.order];
    ctx.say(`排序目标：${word}（--order ${d.order}）`);
    if (d.trueFav) {
      ctx.say(`真实收藏时间：${d.trueFav.recovered} 条从快照恢复，${d.trueFav.kept} 条沿用账号上的当前值`);
    } else {
      ctx.say('⚠ 没给 --true-fav-from：按账号上的当前 fav_time 排。搬运过的夹，那是搬运顺序不是收藏顺序。');
    }
    for (const f of d.skippedDefault) ctx.say(`  · 跳过默认收藏夹「${f.title}」（要一起排就加 --include-default）`);
    ctx.say('');
    for (const f of d.folders) {
      ctx.say(`  「${f.title}」${String(f.count).padStart(4)} 条 → ${String(f.calls).padStart(3)} 次搬运   排最上面的将是：${String(f.top ?? '').slice(0, 24)}`);
    }
    ctx.say('');
    ctx.say(`共 ${d.folders.length} 个夹 / ${d.totalItems} 条，每条要搬出再搬回，合计 ${d.folders.reduce((n, f) => n + f.calls, 0)} 次搬运`
      + (d.tempFolder.existing ? '' : ' + 1 次建中转夹'));
  },
});

/**
 * 收尾：中转夹空了就删掉，清状态文件**和断点文件**，并把动过的夹从缓存里剔出去。
 *
 * 清断点文件这一步曾经漏掉，代价很具体：下一次 reorder 会把上一轮已完成的 key
 * 原样撞上，搬出批次被当成「已做过」跳过，条目没进中转夹，搬回全部搬空。
 * 跑完就是跑完了，这份断点对下一份计划没有任何意义，必须清掉。
 * （planId 是第二道保险；两道都留着。）
 *
 * 清缓存也不能省 —— 搬完之后 favorites.json 里那些夹的快照已经全是旧次序了，
 * 留着会让下一条命令基于陈数据做决策。
 */
async function cleanup(ctx, tempHandle, touchedIds) {
  if (tempHandle.id) {
    const left = (await ctx.bili.favItems(tempHandle.id, null, { pageDelayMs: 500 })).list;
    if (left.length) {
      ctx.say(`⚠ 中转夹里还剩 ${left.length} 条，先不删它。重跑本命令会继续把它们搬回去。`);
    } else {
      const r = await ctx.bili.deleteFolders([tempHandle.id]);
      ctx.say(r?.code === 0 ? '中转夹已清空并删除' : `中转夹删除失败（code=${r?.code}），它是空的，可以手动删`);
      store.write(STATE_FILE, null);
      store.write(RESUME_FILE, { done: {}, failed: {} });
    }
  }
  const cache = loadCache();
  for (const id of touchedIds) cache.delete(Number(id));
  saveCache(await ctx.bili.favFolders(), cache);
  ctx.say(`已清掉 ${touchedIds.length} 个夹的本地缓存（次序已变，旧快照不能再用）`);
}
