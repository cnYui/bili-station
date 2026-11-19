import { defineCommand } from '../registry.mjs';
import { scanMany } from '../favcache.mjs';
import { planDeadCleanup } from '../../plan.mjs';
import { buildDeadOps, buildLayoutOps } from '../../executor.mjs';

export default defineCommand({
  name: 'dead',
  summary: '处理失效视频：归档到一个夹（可逆）或直接移除（不可逆）',
  needsChrome: true,
  mutating: true,
  ordered: true,
  flags: {
    action: { type: 'enum', values: ['archive', 'remove'], default: 'archive', desc: 'archive 可逆 / remove 不可逆' },
    folder: { type: 'idList', desc: '只处理这几个夹；默认全部' },
    'archive-name': { type: 'string', default: '已失效视频归档', desc: '归档夹名称' },
    refresh: { type: 'boolean', desc: '忽略缓存重新拉取' },
    'page-delay': { type: 'int', min: 0, desc: '翻页间隔 ms，覆盖自动降速（大夹默认 2.2s）' },
  },
  examples: [
    'dead --folder 106154023',
    'dead --action remove --yes',
  ],

  async plan(ctx) {
    const { flags, bili, cfg } = ctx;
    const folders = await bili.favFolders();
    const titleOf = (id) => folders.find((f) => Number(f.id) === Number(id))?.title ?? String(id);
    const wanted = (flags.folder ?? folders.map((f) => f.id)).map(Number);

    const { itemsById, incomplete } = await scanMany(bili, wanted, folders, ctx, {
      refresh: !!flags.refresh, pageDelayMs: flags['page-delay'],
    });

    const plan = planDeadCleanup(itemsById, {
      action: flags.action,
      archiveName: flags['archive-name'],
    });

    const warnings = [];
    if (incomplete) {
      warnings.push({ code: 'INCOMPLETE_SCAN', message: `有 ${incomplete} 个收藏夹没扫完，下面的统计是不完整的。等限流过去后重跑会自动续扫。` });
    }
    if (flags.action === 'remove' && plan.total) {
      warnings.push({ code: 'IRREVERSIBLE', message: '--action remove 会把它们从收藏夹里删掉。失效视频无法重新收藏，此操作不可逆。' });
    }

    if (!plan.total) {
      return { data: { action: flags.action, total: 0, groups: [] }, warnings, nothing: true, nothingReason: '没有发现失效视频' };
    }

    // 归档夹按存在性判断是否要建，不靠断点记录 —— 断点说建过了而夹其实不在时，
    // 后续移动会全部落空。buildLayoutOps 的建夹 op 内部就是查了再建。
    const folderIds = new Map();
    let archiveOps = [];
    let archiveId = null;
    if (flags.action === 'archive') {
      const hit = folders.find((f) => f.title.trim() === plan.archiveName.trim());
      if (hit) { archiveId = hit.id; folderIds.set(plan.archiveName, hit.id); }
      else archiveOps = buildLayoutOps(bili, [], [plan.archiveName], folderIds, { privacy: Number(cfg.privacy) });
    }

    // 归档夹可能要等前面的建夹 op 跑完才有 id，所以传惰性取值函数
    const deadOps = buildDeadOps(
      bili, plan,
      flags.action === 'archive' ? () => folderIds.get(plan.archiveName) ?? archiveId : null,
      { chunkSize: flags['chunk-size'], order: flags.order },
    );

    return {
      data: {
        action: flags.action, archiveName: plan.archiveName, order: flags.order,
        total: plan.total,
        groups: plan.groups.map((g) => ({ mediaId: g.mediaId, folder: titleOf(g.mediaId), count: g.count })),
      },
      warnings,
      ops: [...archiveOps, ...deadOps],
      // 备份完整清单：删掉之后这就是唯一的记录
      backup: {
        kind: 'dead-' + flags.action,
        payload: {
          action: flags.action,
          items: plan.groups.flatMap((g) => g.items.map((it) => ({
            folderId: g.mediaId, folder: titleOf(g.mediaId),
            aid: it.id, bvid: it.bvid, title: it.title, upper: it.upper, attr: it.attr, favTime: it.favTime,
          }))),
        },
      },
      jobKind: 'dead', resumeKey: 'dead',
    };
  },

  render(r, ctx) {
    const d = r.data;
    ctx.say('');
    if (!d.total) { ctx.say('没有发现失效视频。'); return; }
    ctx.say(`失效视频共 ${d.total} 条，分布在 ${d.groups.length} 个收藏夹：`);
    for (const g of d.groups) ctx.say(`  ${String(g.count).padStart(4)}  ${g.folder}`);
    ctx.say('');
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);
    if (d.action === 'archive') ctx.say(`将归档到「${d.archiveName}」，原夹清空但条目仍在，可随时翻回。`);
  },
});
