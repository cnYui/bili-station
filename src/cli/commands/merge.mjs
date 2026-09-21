import { defineCommand } from '../registry.mjs';
import { scanMany } from '../favcache.mjs';
import { planMerge } from '../../plan.mjs';
import { buildMergeOps } from '../../executor.mjs';

export default defineCommand({
  name: 'merge',
  summary: '把若干收藏夹的内容全部并入一个夹（来源夹会被清空但不删除）',
  needsChrome: true,
  mutating: true,
  ordered: true,
  flags: {
    into: { type: 'folderRef', required: true, desc: '目标收藏夹（id 或名称）' },
    from: { type: 'idList', desc: '来源夹；默认「除目标外的全部」' },
    exclude: { type: 'idList', desc: '从来源里排除某几个' },
    'skip-dead': { type: 'boolean', desc: '不搬失效视频' },
    refresh: { type: 'boolean', desc: '忽略本地缓存重新拉取来源内容' },
    'page-delay': { type: 'int', min: 0, desc: '翻页间隔 ms，覆盖自动降速' },
  },
  examples: [
    'merge --into 默认收藏夹',
    'merge --into 106154023 --skip-dead --yes',
  ],

  async plan(ctx) {
    const { flags, bili, cfg } = ctx;
    const folders = await bili.favFolders();
    const titleOf = (id) => folders.find((f) => Number(f.id) === Number(id))?.title ?? String(id);

    // 目标夹：优先 id 精确匹配，其次名称（忽略大小写与首尾空格）
    const byId = folders.find((f) => String(f.id) === String(flags.into));
    const nameHits = folders.filter((f) => f.title.trim().toLowerCase() === String(flags.into).trim().toLowerCase());
    if (!byId && nameHits.length > 1) {
      return ctx.usageError(`名称「${flags.into}」对应 ${nameHits.length} 个收藏夹（id ${nameHits.map((f) => f.id).join(', ')}），请改用 id 指定。`);
    }
    const target = byId ?? nameHits[0];
    if (!target) return ctx.usageError(`找不到收藏夹「${flags.into}」。用 bili-station folders 看现有的。`);

    const exclude = new Set((flags.exclude ?? []).map(Number));
    const fromIds = flags.from ?? folders.map((f) => f.id).filter((id) => Number(id) !== Number(target.id));
    const sources = fromIds.filter((id) => !exclude.has(Number(id)) && Number(id) !== Number(target.id));
    if (!sources.length) return { data: { target }, nothing: true, nothingReason: '没有来源收藏夹' };

    ctx.say(`目标：「${target.title}」(id ${target.id}，现有 ${target.count} 条)`);
    ctx.say(`来源：${sources.length} 个收藏夹`);

    const { itemsById, incomplete } = await scanMany(bili, sources, folders, ctx, {
      refresh: !!flags.refresh, pageDelayMs: flags['page-delay'],
    });

    const plan = planMerge(itemsById, target, {
      perFolderCap: cfg.perFolderCap,
      includeDead: !flags['skip-dead'],
      titleOf,
    });

    const warnings = plan.warnings.map((w) => ({ code: w.kind, message: w.message }));
    if (incomplete) {
      warnings.push({ code: 'INCOMPLETE_SCAN', message: `有 ${incomplete} 个来源夹没扫完，本次不会搬全。等限流过去后重跑会续扫。` });
    }

    return {
      data: {
        target: { id: target.id, title: target.title, countBefore: target.count },
        order: flags.order,
        sources: plan.groups.length,
        totalItems: plan.total,
        deadItems: plan.deadTotal,
        duplicateInSources: plan.duplicateInSources,
        countAfter: (target.count ?? 0) + plan.total,
        groups: plan.groups.map((g) => ({ srcId: g.srcId, srcTitle: g.srcTitle, count: g.count, dead: g.dead.length })),
      },
      warnings,
      ops: buildMergeOps(bili, plan, { chunkSize: flags['chunk-size'], order: flags.order }),
      // 备份的是「每条视频原本在哪个夹」，这是回滚所需的全部信息
      backup: {
        kind: 'merge',
        payload: {
          target: { id: target.id, title: target.title },
          origin: plan.groups.map((g) => ({
            srcId: g.srcId, srcTitle: g.srcTitle,
            items: [...g.live, ...g.dead].map((it) => ({ id: it.id, bvid: it.bvid, type: it.type, title: it.title })),
          })),
        },
      },
      jobKind: 'merge', resumeKey: 'merge',
      nothingReason: plan.total ? null : '来源夹里没有可搬运的条目',
    };
  },

  render(r, ctx) {
    const d = r.data;
    ctx.say('');
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);
    ctx.say('将搬运：');
    for (const g of d.groups) ctx.say(`  ${String(g.count).padStart(4)}  ${g.srcTitle}${g.dead ? `（含 ${g.dead} 条失效）` : ''}`);
    ctx.say('  ────');
    ctx.say(`  ${String(d.totalItems).padStart(4)}  合计 → 「${d.target.title}」将从 ${d.target.countBefore} 变为 ${d.countAfter} 条`);
    ctx.say('');
    ctx.say('注意：这是 move，来源夹会被清空（但夹本身仍在，不会被删除）。');
  },
});
