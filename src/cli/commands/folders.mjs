import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../registry.mjs';
import { store } from '../context.mjs';
import { buildLayoutOps, buildPrivacyOps } from '../../executor.mjs';
import { PRIVACY, isPrivateAttr } from '../../bili.mjs';
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
    'privacy <public|private>': '批量改隐私。不指定夹就是全部；已经是目标状态的自动跳过',
  },
  flags: {
    map: { type: 'path', desc: 'setup 用：{"renames":[{"id":123,"to":"新名"}],"creates":["名1","名2"]}' },
  },
  examples: [
    'folders',
    'folders create "游戏,科普" --yes',
    'folders setup --map plan.json --yes',
    'folders privacy public --yes',
    'folders privacy private 吉他,1539412323 --yes',
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

    if (sub === 'privacy') {
      const want = ctx.positionals[1];
      if (want !== 'public' && want !== 'private') {
        return ctx.usageError('用法：bili-station folders privacy <public|private> [夹id或名称...] --yes');
      }
      const target = want === 'public' ? PRIVACY.public : PRIVACY.private;
      const wantPrivate = target === PRIVACY.private;

      // 不指定就是全部夹；指定了就按 id 或名称挑，挑不到的立刻报错而不是静默跳过
      const picks = ctx.positionals.slice(2).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      let scope = folders;
      if (picks.length) {
        const miss = [];
        scope = picks.map((p) => {
          const hit = folders.find((f) => String(f.id) === p || f.title.trim().toLowerCase() === p.toLowerCase());
          if (!hit) miss.push(p);
          return hit;
        }).filter(Boolean);
        if (miss.length) return ctx.usageError(`找不到这些收藏夹：${miss.join('、')}`);
      }

      // 隐私位只看 attr 的最低位，不能和 22/23 这种具体值比（见 bili.mjs 的 isPrivateAttr）
      const need = scope.filter((f) => isPrivateAttr(f.attr) !== wantPrivate);
      const already = scope.filter((f) => isPrivateAttr(f.attr) === wantPrivate);
      const brief = (f) => ({ id: f.id, title: f.title, attr: f.attr, count: f.count });

      return {
        data: { want, scope: scope.length, need: need.map(brief), already: already.map(brief) },
        ops: buildPrivacyOps(ctx.bili, need, target),
        backup: { kind: 'folders', payload: folders },
        jobKind: 'privacy', resumeKey: 'privacy',
        nothingReason: need.length ? null : `这 ${scope.length} 个夹已经全是${want === 'public' ? '公开' : '私密'}的了`,
      };
    }

    return ctx.usageError(`未知子命令：folders ${sub}（可用：list / create / setup / privacy）`);
  },

  render(r, ctx) {
    const d = r.data;
    if (r.readonly) {
      for (const f of d.folders) {
        ctx.say(`  ${String(f.id).padEnd(12)} ${isPrivateAttr(f.attr) ? '私密' : '公开'}  ${f.title}  (${f.count} 条)`);
      }
      return;
    }
    if (d.want) {
      const word = d.want === 'public' ? '公开' : '私密';
      for (const f of d.already) ctx.say(`  · 已经是${word}：${f.title}（attr ${f.attr}）`);
      for (const f of d.need) ctx.say(`  改：${f.title}  (${f.count} 条, attr ${f.attr})  →  ${word}`);
      ctx.say(`范围内 ${d.scope} 个夹，需要改 ${d.need.length} 个，已是${word}的 ${d.already.length} 个`);
      return;
    }
    for (const s of (d.skipped ?? [])) ctx.say(`  · 跳过 ${s.name ?? s.id}：${s.reason}`);
    for (const x of (d.reused ?? [])) ctx.say(`  · 复用已有：${x.name}（id ${x.id}）`);
    for (const x of (d.renames ?? [])) ctx.say(`  改：${x.from}  →  ${x.to}`);
    for (const n of (d.creates ?? [])) ctx.say(`  建：${n}`);
    ctx.say(`改名 ${(d.renames ?? []).length} 个，新建 ${(d.creates ?? []).length} 个，操作后收藏夹总数 ${d.totalAfter}`);
  },
});
