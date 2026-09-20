import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../registry.mjs';
import { store } from '../context.mjs';
import { buildLayoutOps } from '../../executor.mjs';
import { EXIT } from '../output.mjs';

export default defineCommand({
  name: 'folders',
  summary: '收藏夹的列出 / 新建 / 批量改名铺骨架',
  usage: '[list|create|setup] [名称...]',
  needsChrome: true,
  mutating: true,
  subs: {
    'list': '列出全部收藏夹（默认）',
    'create "A,B,C"': '新建收藏夹，已存在的同名夹自动复用',
    'setup --map <file>': '批量改名复用 + 新建，一次性铺好分类骨架',
  },
  flags: {
    map: { type: 'path', desc: 'setup 用：{"renames":[{"id":123,"to":"新名"}],"creates":["名1","名2"]}' },
  },
  examples: [
    'folders',
    'folders create "游戏,科普" --yes',
    'folders setup --map plan.json --yes',
  ],

  async plan(ctx) {
    const sub = ctx.positionals[0] ?? 'list';
    const folders = await ctx.bili.favFolders();

    if (sub === 'list') {
      return { readonly: true, data: { folders } };
    }

    if (sub === 'create') {
      const names = ctx.positionals.slice(1).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (!names.length) {
        return ctx.usageError('没给要新建的收藏夹名。用法：bili-station folders create "游戏,科普" --yes');
      }
      const have = new Map(folders.map((f) => [f.title.trim().toLowerCase(), f]));
      const reused = [];
      const creates = [];
      for (const n of names) {
        const hit = have.get(n.trim().toLowerCase());
        if (hit) reused.push({ name: n, id: hit.id });
        else creates.push(n);
      }
      const folderIds = new Map(reused.map((r) => [r.name, r.id]));
      return {
        data: { creates, reused, totalAfter: folders.length + creates.length },
        ops: buildLayoutOps(ctx.bili, [], creates, folderIds, { privacy: Number(ctx.cfg.privacy) }),
        backup: { kind: 'folders', payload: folders },
        jobKind: 'layout', resumeKey: 'layout',
        nothingReason: creates.length ? null : '要建的夹全都已存在，无需新建',
        _folderIds: folderIds,
      };
    }

    if (sub === 'setup') {
      if (!ctx.flags.map) {
        return ctx.usageError('setup 需要 --map <file>，内容形如 {"renames":[{"id":123,"to":"新名"}],"creates":["名1","名2"]}');
      }
      let spec;
      try { spec = JSON.parse(readFileSync(ctx.flags.map, 'utf8')); }
      catch (e) { return ctx.usageError(`读不了 --map 文件：${e.message}`); }

      const byId = new Map(folders.map((f) => [Number(f.id), f]));
      const byName = new Map(folders.map((f) => [f.title.trim().toLowerCase(), f]));
      const folderIds = new Map();
      const renames = [];
      const skipped = [];

      for (const r of (spec.renames ?? [])) {
        const f = byId.get(Number(r.id));
        if (!f) { skipped.push({ id: r.id, reason: '找不到这个收藏夹' }); continue; }
        if (f.title.trim() === String(r.to).trim()) { folderIds.set(r.to, f.id); skipped.push({ id: r.id, reason: `已经叫「${r.to}」` }); continue; }
        renames.push({ id: f.id, from: f.title, to: String(r.to) });
      }
      const creates = (spec.creates ?? []).filter((n) => {
        const hit = byName.get(String(n).trim().toLowerCase());
        if (hit) { folderIds.set(n, hit.id); skipped.push({ name: n, reason: `已存在（id ${hit.id}）` }); return false; }
        return true;
      });

      return {
        data: { renames, creates, skipped, totalAfter: folders.length + creates.length },
        ops: buildLayoutOps(ctx.bili, renames, creates, folderIds, { privacy: Number(ctx.cfg.privacy) }),
        backup: { kind: 'folders', payload: folders },
        jobKind: 'layout', resumeKey: 'layout',
        nothingReason: (renames.length || creates.length) ? null : '没有需要改名或新建的夹',
        _folderIds: folderIds,
        _afterRun: async (ctx2) => {
          store.write('folder-map.json', Object.fromEntries(folderIds));
          ctx2.say(`名称→id 映射已存到 ${join(store.DATA_DIR, 'folder-map.json')}`);
        },
      };
    }

    return ctx.usageError(`未知子命令：folders ${sub}（可用：list / create / setup）`);
  },

  render(r, ctx) {
    const d = r.data;
    if (r.readonly) {
      for (const f of d.folders) ctx.say(`  ${String(f.id).padEnd(12)} ${f.title}  (${f.count} 条)`);
      return;
    }
    for (const s of (d.skipped ?? [])) ctx.say(`  · 跳过 ${s.name ?? s.id}：${s.reason}`);
    for (const x of (d.reused ?? [])) ctx.say(`  · 复用已有：${x.name}（id ${x.id}）`);
    for (const x of (d.renames ?? [])) ctx.say(`  改：${x.from}  →  ${x.to}`);
    for (const n of (d.creates ?? [])) ctx.say(`  建：${n}`);
    ctx.say(`改名 ${(d.renames ?? []).length} 个，新建 ${(d.creates ?? []).length} 个，操作后收藏夹总数 ${d.totalAfter}`);
  },
});
