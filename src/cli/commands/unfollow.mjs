import { defineCommand } from '../registry.mjs';
import { loadFollowData, tagsOf } from '../followdata.mjs';
import { resolveTag } from '../followdata.mjs';
import { planUnfollow } from '../../plan.mjs';
import { buildRelationOps } from '../../executor.mjs';
import { RELATION_ACT } from '../../bili.mjs';

export default defineCommand({
  name: 'unfollow',
  summary: '按规则批量取关（特别关注无条件保留）',
  needsChrome: true,
  mutating: true,
  flags: {
    keep: { type: 'int', min: 0, desc: '保留最近关注的前 N 个' },
    'inactive-days': { type: 'int', min: 1, desc: '超过 N 天没投稿算停更。需要先跑 scan uploads' },
    'only-inactive': { type: 'boolean', desc: '只取关停更号' },
    'protect-tag': { type: 'csv', desc: '这些分组里的 UP 无条件保留（分组名或 tagid）' },
    refresh: { type: 'boolean', desc: '强制重新拉取关注列表' },
  },
  examples: [
    'unfollow --keep 200',
    'unfollow --only-inactive --inactive-days 365 --protect-tag "长期追更" --yes',
  ],

  async plan(ctx) {
    const { flags } = ctx;
    const needUploads = flags['inactive-days'] != null || flags['only-inactive'];
    const d = await loadFollowData(ctx, { refresh: !!flags.refresh, needUploads });
    const warnings = [...d.warnings];

    // 分组保护：planUnfollow 一直支持 protectTags，只是重构前 CLI 从没暴露过
    const protectTags = new Set();
    if (flags['protect-tag']) {
      for (const ref of flags['protect-tag']) {
        const t = resolveTag(ref, d.tags);
        if (!t) return ctx.usageError(`找不到分组「${ref}」。用 bili-station follow list 看现有分组。`);
        for (const u of d.list) {
          if (tagsOf(u, d.special).includes(Number(t.tagid))) protectTags.add(String(u.mid));
        }
      }
    }

    const p = planUnfollow(d.list, {
      keep: flags.keep ?? null,
      special: d.special,
      protectTags,
      inactiveDays: flags['inactive-days'] ?? null,
      inactive: d.uploads,
      onlyInactive: !!flags['only-inactive'],
    });

    if (!p.targets.length) {
      return {
        data: { total: p.total, willUnfollow: 0, kept: p.keptCount },
        warnings, nothing: true,
        nothingReason: needUploads && !d.uploads.size
          ? '没有投稿时间数据，无法判断停更。先跑 bili-station scan uploads'
          : '按当前规则没有要取关的对象',
      };
    }

    return {
      data: {
        total: p.total, willUnfollow: p.targets.length, kept: p.keptCount,
        protectedByTag: protectTags.size, specialKept: d.special.size,
        byReason: p.summary.byReason, truncated: d.truncated,
        targets: p.targets.slice(0, 50).map((u) => ({ mid: u.mid, uname: u.uname, reason: p.reasons.get(String(u.mid)) })),
      },
      warnings,
      ops: buildRelationOps(ctx.bili, p.targets, RELATION_ACT.unfollow, {
        opName: 'unfollow', verb: '取关', reasons: p.reasons,
      }),
      backup: {
        kind: 'unfollow',
        payload: {
          targets: p.targets.map((u) => ({ mid: u.mid, uname: u.uname, reason: p.reasons.get(String(u.mid)), tags: tagsOf(u, d.special) })),
          snapshot: { total: d.list.length, truncated: d.truncated },
        },
      },
      jobKind: 'unfollow', resumeKey: 'unfollow',
    };
  },

  render(r, ctx) {
    const d = r.data;
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);
    ctx.say(`关注 ${d.total} 个 → 将取关 ${d.willUnfollow}，保留 ${d.kept}`
      + `（特别关注 ${d.specialKept ?? 0} 个无条件保留${d.protectedByTag ? `，分组保护 ${d.protectedByTag} 个` : ''}）`);
    for (const u of (d.targets ?? [])) ctx.say(`  ${u.uname}（${u.mid}）— ${u.reason}`);
    if (d.willUnfollow > (d.targets ?? []).length) ctx.say(`  … 其余 ${d.willUnfollow - d.targets.length} 个`);
  },
});
