import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../registry.mjs';
import { store } from '../context.mjs';
import { loadCache, saveCache, itemsOf, scanMany } from '../favcache.mjs';
import { sleep } from '../../risk.mjs';

export default defineCommand({
  name: 'scan',
  summary: '把 B 站的数据拉到本地缓存（只读，可反复跑，会断点续扫）',
  usage: '[fav|follow|uploads|sample]',
  needsChrome: true,
  subs: {
    fav: '收藏夹内容（默认）',
    follow: '关注列表 + 特别关注 + 分组',
    uploads: 'UP 主最近投稿时间 —— unfollow 的 --inactive-days 依赖它',
    sample: '抽样读取一个夹，用于设计分类体系',
  },
  flags: {
    folder: { type: 'idList', desc: 'fav/sample：只处理这几个夹；默认全部' },
    refresh: { type: 'boolean', desc: '忽略本地缓存重新拉取' },
    'page-delay': { type: 'int', min: 0, desc: '翻页间隔 ms，覆盖按规模自动降速' },
    ratio: { type: 'float', min: 0.01, max: 1, default: 0.25, desc: 'sample：抽样比例' },
    out: { type: 'path', desc: 'sample：样本输出路径' },
    limit: { type: 'int', min: 1, desc: 'uploads：只查前 N 个（按最近关注排序）' },
  },
  examples: [
    'scan fav --folder 106154023',
    'scan uploads --limit 300',
    'scan sample --folder 106154023 --ratio 0.3',
  ],

  async plan(ctx) {
    const what = ctx.positionals[0] ?? 'fav';
    const pageDelay = ctx.flags['page-delay'];

    if (what === 'fav') {
      const folders = await ctx.bili.favFolders();
      const only = ctx.flags.folder;
      const want = only ? folders.filter((f) => only.includes(Number(f.id))) : folders;
      if (only && !want.length) return ctx.usageError(`--folder 指定的夹一个都不存在：${only.join(', ')}`);

      const { cache, incomplete } = await scanMany(
        ctx.bili, want.map((f) => f.id), folders, ctx,
        { refresh: !!ctx.flags.refresh, pageDelayMs: pageDelay },
      );
      const counts = Object.fromEntries(want.map((f) => [f.id, itemsOf(cache, f.id).length]));
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return {
        data: { folders, counts, total, incomplete },
        warnings: incomplete ? [{ code: 'INCOMPLETE_SCAN', message: `${incomplete} 个夹未扫完，重跑会自动续扫` }] : [],
      };
    }

    if (what === 'follow') {
      const r = await ctx.bili.followings((n, t) => { if (n % 200 === 0) ctx.say(`  已拉取 ${n}${t ? '/' + t : ''}`); });
      const special = await ctx.bili.specialFollowings();
      const tags = await ctx.bili.tags();
      store.write('followings.json', r);
      store.write('special.json', [...special]);
      store.write('tags.json', tags);
      return {
        data: { count: r.list.length, total: r.total, truncated: r.truncated, special: special.size, tags },
        warnings: r.truncated
          ? [{ code: 'TRUNCATED', message: `只读到 ${r.list.length}/${r.total ?? '?'}，这是 B 站分页深度限制，不是 bug` }]
          : [],
      };
    }

    if (what === 'uploads') {
      // 重构前这个数据只有 Web UI 能生成，导致 CLI 的 --inactive-days / --only-inactive
      // 恒定命中 0 个目标（读的是一个永远为空的 uploads.json）。这里补上生产者。
      let data = store.read('followings.json', null);
      if (!data || ctx.flags.refresh) {
        ctx.say('先拉关注列表…');
        data = await ctx.bili.followings((n, t) => { if (n % 200 === 0) ctx.say(`  ${n}${t ? '/' + t : ''}`); });
        store.write('followings.json', data);
      }
      const known = new Map(store.read('uploads.json', []));
      let list = data.list;
      if (ctx.flags.limit) list = list.slice(0, ctx.flags.limit);
      const todo = ctx.flags.refresh ? list : list.filter((u) => !known.has(String(u.mid)));

      ctx.say(`关注 ${data.list.length} 个，本次需要查 ${todo.length} 个（已有 ${known.size} 条缓存）`);
      let done = 0, failed = 0;
      for (const u of todo) {
        try {
          const info = await ctx.bili.lastUpload(u.mid);
          known.set(String(u.mid), info);
        } catch { failed++; }
        done++;
        if (done % 25 === 0) {
          store.write('uploads.json', [...known]);   // 边查边存，中断也不白跑
          ctx.say(`  ${done}/${todo.length}${failed ? `（失败 ${failed}）` : ''}`);
        }
        // 投稿查询走 wbi 签名接口，权重低但仍是读操作，保持节奏
        if (done < todo.length) await sleep(700 + Math.random() * 600);
      }
      store.write('uploads.json', [...known]);
      return {
        data: { checked: done, failed, cached: known.size, followings: data.list.length },
        warnings: failed ? [{ code: 'PARTIAL', message: `${failed} 个 UP 的投稿信息没查到，重跑会补` }] : [],
      };
    }

    if (what === 'sample') {
      const folders = await ctx.bili.favFolders();
      const fid = Number(ctx.flags.folder?.[0] ?? folders[0]?.id);
      const f = folders.find((x) => Number(x.id) === fid);
      if (!f) return ctx.usageError(`找不到收藏夹 ${fid}。用 bili-station folders 看现有的。`);

      const step = Math.max(1, Math.round(1 / ctx.flags.ratio));
      const totalPages = Math.ceil(f.count / 20);
      const willRead = Math.ceil(totalPages / step);
      ctx.say(`「${f.title}」共 ${f.count} 条 / ${totalPages} 页`);
      ctx.say(`抽样：每 ${step} 页取 1 页 → 读 ${willRead} 页，约 ${willRead * 20} 条（${Math.round(100 / step)}%），预计 ${Math.ceil(willRead * 2.75 / 60)} 分钟`);

      const r = await ctx.bili.favSample(fid, {
        totalCount: f.count, step,
        ...(pageDelay != null ? { pageDelayMs: pageDelay } : {}),
        onProgress: (p) => {
          if (p.throttled) ctx.say(`  ⏸ 第 ${p.page} 页被限流（code=${p.code}），退避 ${Math.round(p.waitMs / 1000)}s（第 ${p.attempt} 次）`);
          else if (p.done % 10 === 0) ctx.say(`  ${p.done}/${p.totalPages} 页，已取 ${p.items} 条`);
        },
      });
      const out = ctx.flags.out ?? join(store.DATA_DIR, 'sample-' + fid + '.json');
      writeFileSync(out, JSON.stringify({ folder: f, ...r }, null, 2));
      return {
        data: { folder: f, sampled: r.list.length, sampledPages: r.sampledPages, totalPages: r.totalPages, failed: r.failed, out },
        warnings: r.failed.length ? [{ code: 'PARTIAL', message: `${r.failed.length} 页读取失败` }] : [],
      };
    }

    return ctx.usageError(`未知子命令：scan ${what}（可用：fav / follow / uploads / sample）`);
  },

  render(r, ctx) {
    const d = r.data;
    if (d.counts) {
      for (const [id, n] of Object.entries(d.counts)) {
        const f = d.folders.find((x) => String(x.id) === String(id));
        ctx.say(`  ${String(id).padEnd(12)} ${(f?.title ?? '').padEnd(14)} ${n} 条`);
      }
      ctx.say(`合计 ${d.total} 条`);
    } else if (d.checked != null) {
      ctx.say(`投稿信息：本次查了 ${d.checked} 个，累计缓存 ${d.cached} 条`);
      ctx.say('现在 unfollow --inactive-days / --only-inactive 可以正常工作了。');
    } else if (d.sampled != null) {
      ctx.say(`样本 ${d.sampled} 条（${d.sampledPages}/${d.totalPages} 页）已写入 ${d.out}`);
    } else if (d.count != null) {
      ctx.say(`关注 ${d.count} 个，特别关注 ${d.special} 个，分组 ${d.tags.length} 个`);
    }
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);
  },
});
