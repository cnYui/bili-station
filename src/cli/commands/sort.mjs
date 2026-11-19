import { readFileSync, writeFileSync } from 'node:fs';
import { defineCommand } from '../registry.mjs';
import { loadCache, saveCache, itemsOf, scanFolder } from '../favcache.mjs';
import { planFavClassify } from '../../plan.mjs';
import { orderCost } from '../../order.mjs';
import { classifyAll } from '../../classify/keyword.mjs';
import { classifyWithAI } from '../../classify/ai.mjs';
import { buildTasks, applyExternalAssignment } from '../../classify/external.mjs';
import { buildFavOps, buildLayoutOps } from '../../executor.mjs';
import { EXIT } from '../output.mjs';

export default defineCommand({
  name: 'sort',
  summary: '按候选收藏夹给收藏视频分类（核心命令）',
  needsChrome: true,
  mutating: true,
  ordered: true,
  flags: {
    folders: { type: 'csv', desc: '候选收藏夹。模型只能从这里面选唯一一个，不允许发明新分类' },
    'include-existing': { type: 'boolean', desc: '把现有全部收藏夹也纳入候选' },
    source: { type: 'string', default: 'all', desc: '来源收藏夹：all 或 id,id（自动排除候选夹本身）' },
    engine: {
      type: 'enum', values: ['external', 'keyword', 'deepseek'], default: 'external',
      desc: 'external=调用方自己分类（无需 key，默认）/ keyword=关键词规则 / deepseek=外挂 LLM',
    },
    mode: { type: 'enum', values: ['copy', 'move'], default: 'copy', desc: 'copy 可逆，move 会清空来源' },
    'lazy-create': { type: 'boolean', desc: '只建真正分到视频的夹，不预先全建' },
    limit: { type: 'int', min: 1, desc: '只处理前 N 条，试水用' },
    'emit-tasks': { type: 'path', desc: 'engine=external：把待分类清单写到文件' },
    assign: { type: 'path', desc: 'engine=external：回填 {"<id>":"<分类名>"}' },
  },
  examples: [
    'sort --folders "编程,游戏,美食" --limit 50',
    'sort --folders "编程,游戏,美食" --assign out.json --yes',
    'sort --folders "编程,游戏" --order reverse --order-scope global --yes',
  ],

  async plan(ctx) {
    const { flags, bili, cfg } = ctx;
    const named = flags.folders ?? [];
    if (!named.length && !flags['include-existing']) {
      return ctx.usageError('必须用 --folders "A,B,C" 指定候选收藏夹，或加 --include-existing 把现有收藏夹全部作为候选。');
    }

    // 1. 候选集 = 指定的名字 ∪（可选）现有全部收藏夹
    const folders = await bili.favFolders();
    const candidates = [...new Set([...named, ...(flags['include-existing'] ? folders.map((f) => f.title) : [])])];
    if (!candidates.length) return ctx.usageError('候选收藏夹为空');
    ctx.say(`候选收藏夹 ${candidates.length} 个：${candidates.join(' / ')}`);

    const warnings = [];
    const have = new Map(folders.map((f) => [f.title.trim().toLowerCase(), f]));
    const missing = candidates.filter((n) => !have.has(n.trim().toLowerCase()));
    if (missing.length && folders.length + missing.length > cfg.folderQuota) {
      // 收藏夹个数上限 B 站没有公开权威数字，所以只警告、不硬拦。
      warnings.push({
        code: 'FOLDER_QUOTA',
        message: `将新建 ${missing.length} 个夹，加上已有 ${folders.length} 个会超过配置上限 ${cfg.folderQuota}。`
          + '如果建夹真的失败，多半是收藏夹个数配额满了（不是风控）—— B 站这两种报错很像。'
          + '确认办法：去网页端手动新建一个夹，建得出来就是限流，建不出来就是配额。',
      });
    }

    // 2. 来源条目（统一走 favcache，不再自己读写 favorites.json）
    const candLower = new Set(candidates.map((s) => s.trim().toLowerCase()));
    const srcIds = flags.source === 'all'
      ? folders.filter((f) => !candLower.has(f.title.trim().toLowerCase())).map((f) => f.id)
      : String(flags.source).split(',').map((x) => Number(x.trim())).filter(Boolean);

    const cache = loadCache();
    let items = [];
    for (const id of srcIds) {
      let list = itemsOf(cache, id);
      if (!list.length) {
        const f = folders.find((x) => Number(x.id) === Number(id));
        ctx.say(`  拉取「${f?.title ?? id}」…`);
        const r = await scanFolder(bili, id, cache, { onSay: ctx.say, folderCount: f?.count ?? 0 });
        list = r.items;
      }
      items.push(...list);
    }
    saveCache(folders, cache);

    items = items.filter((it) => !it.dead);
    if (flags.limit) items = items.slice(0, flags.limit);
    if (!items.length) return { data: { candidates }, nothing: true, nothingReason: '没有可分类的条目' };
    ctx.say(`待分类 ${items.length} 条`);

    // 3. 分类：候选集就是唯一允许的输出集合
    let assignment, detail, engineMeta = {};

    if (flags.engine === 'external') {
      if (!flags.assign) {
        // 吐清单给调用方（Claude / Codex / 你自己），不需要第二把 key
        const tasks = buildTasks(items, candidates);
        if (flags['emit-tasks']) {
          writeFileSync(flags['emit-tasks'], JSON.stringify(tasks, null, 2));
          ctx.say(`待分类清单已写入 ${flags['emit-tasks']}`);
        }
        process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
        ctx.say('把每条归到 candidates 里的唯一一个，存成 {"<id>":"<分类名>"} 后用 --assign <文件> 回填。');
        return { handled: true, exit: EXIT.OK };
      }
      let raw;
      try { raw = JSON.parse(readFileSync(flags.assign, 'utf8')); }
      catch (e) { return ctx.usageError(`读不了 --assign 文件：${e.message}`); }

      const res = applyExternalAssignment(items, candidates, raw);
      assignment = res.assignment;
      detail = res.detail;
      engineMeta = { assigned: res.accepted, rejected: res.rejected.length, missing: res.missing };
      ctx.say(`外部分配：采纳 ${res.accepted} 条`
        + (res.rejected.length ? `，拒收 ${res.rejected.length} 条（分类名不在候选集内）` : '')
        + (res.missing ? `，未分配 ${res.missing} 条` : ''));
      for (const r of res.rejected.slice(0, 5)) ctx.say(`    拒收：「${r.given}」 <- ${r.title.slice(0, 24)}`);
      if (res.rejected.length > 5) ctx.say(`    … 另有 ${res.rejected.length - 5} 条`);
      if (res.rejected.length) {
        warnings.push({ code: 'REJECTED', message: `${res.rejected.length} 条的分类名不在候选集内，已丢弃（宁可丢弃也不要放错）` });
      }
    } else if (flags.engine === 'keyword') {
      const rules = candidates.map((n) => ({ name: n, any: [n] }));
      const r = classifyAll(items, (cfg.rules ?? []).filter((x) => candidates.includes(x.name)).concat(rules), { keepUnmatched: true });
      assignment = r.assignment; detail = r.detail;
      engineMeta = { unmatched: r.unmatched };
    } else {
      if (!cfg.ai.apiKey) {
        return ctx.usageError('--engine deepseek 需要 API key：设 DEEPSEEK_API_KEY 环境变量即可。'
          + '（默认的 --engine external 不需要任何 key，由调用方自己分类）');
      }
      ctx.say(`调用 ${cfg.ai.provider} / ${cfg.ai.model} 分类…`);
      const r = await classifyWithAI(items, candidates, cfg.ai, (p) => ctx.say(`  ${p.done}/${p.total}${p.failedChunks ? `（失败分片 ${p.failedChunks}）` : ''}`));
      assignment = r.assignment; detail = r.detail;
      engineMeta = { failedChunks: r.failedChunks.length, provider: cfg.ai.provider, model: cfg.ai.model };
      // 候选集之外的一律剔除，绝不就近匹配
      for (const [id, d] of detail) if (!candidates.includes(d.category)) assignment.delete(id);
    }

    // 4. 计划
    const fav = planFavClassify(items, assignment, folders, {
      folderQuota: cfg.folderQuota, perFolderCap: cfg.perFolderCap, mode: flags.mode,
    });
    warnings.push(...fav.warnings.map((w) => ({ code: w.kind, message: w.message })));

    // 5. 排序成本：两种 scope 各要多少次调用，让用户自己权衡
    const assigned = fav.plan.flatMap((p) => p.items);
    const cost = orderCost(assigned, { chunkSize: flags['chunk-size'] });
    if (flags['order-scope'] === 'global' && cost.extra > 0) {
      warnings.push({
        code: 'ORDER_COST',
        message: `--order-scope global 会把调用次数从 ${cost.perSource} 提到 ${cost.global}（+${cost.extra}），因为来源夹交错处要断开批次。`,
      });
    }

    const folderIds = new Map();
    const favOps = buildFavOps(ctx.bili, fav, folderIds, {
      mode: flags.mode, privacy: Number(cfg.privacy),
      order: flags.order, orderScope: flags['order-scope'], chunkSize: flags['chunk-size'],
    });

    // 非 lazy：把一条视频都没分到的候选夹也建出来（保持「先铺骨架」的语义）
    let emptyOps = [];
    if (!flags['lazy-create']) {
      const planned = new Set(fav.plan.map((p) => p.category.trim().toLowerCase()));
      const emptyMissing = missing.filter((n) => !planned.has(n.trim().toLowerCase()));
      emptyOps = buildLayoutOps(ctx.bili, [], emptyMissing, folderIds, { privacy: Number(cfg.privacy) });
    }

    const lowConf = [...detail.values()].filter((d) => d.ambiguous).length;

    return {
      data: {
        mode: flags.mode, engine: flags.engine, ...engineMeta,
        order: flags.order, orderScope: flags['order-scope'], chunkSize: flags['chunk-size'],
        orderCost: cost,
        totalItems: fav.totalItems, categories: fav.categories,
        newFolders: fav.newFolders, reusedFolders: fav.reusedFolders,
        needReview: lowConf,
        groups: fav.plan.map((p) => ({ category: p.category, count: p.count, isNew: p.isNew, existingCount: p.existingCount, overflow: p.overflow })),
      },
      warnings,
      ops: [...favOps, ...emptyOps],
      backup: { kind: 'favorites', payload: { folders, items: [...cache] } },
      jobKind: 'fav', resumeKey: 'fav',
      nothingReason: fav.totalItems ? null : '没有条目被分配到任何候选夹',
      _lowConf: lowConf,
    };
  },

  render(r, ctx) {
    const d = r.data;
    ctx.say('');
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);
    ctx.say(`分类结果（${d.mode === 'move' ? '移动' : '复制'}模式，排序 ${d.order}）：`);
    for (const g of d.groups) ctx.say(`  ${String(g.count).padStart(5)}  ${g.category}${g.isNew ? '（新建）' : ''}`);
    if (d.needReview) ctx.say(`  其中 ${d.needReview} 条置信度偏低，建议人工复核`);
    if (d.order !== 'as-scanned') {
      ctx.say(`  排序：${{
        original: '新夹里最近收藏的排最上面（和原来一致）',
        reverse: '新夹里最早收藏的排最上面',
        pubdate: '按视频投稿时间排',
      }[d.order]}，精度到 ${d.chunkSize} 条一批`);
    }
  },
});
