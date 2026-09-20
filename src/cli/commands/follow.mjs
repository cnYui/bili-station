import { readFileSync } from 'node:fs';
import { defineCommand } from '../registry.mjs';
import { loadFollowData, stateOf, resolveTag, tagsOf } from '../followdata.mjs';
import { buildSelection, writeSelection, applySelection } from '../selector.mjs';
import { loadProbes } from '../context.mjs';
import { RELATION_ACT, SPECIAL_TAG_ID, DEFAULT_TAG_ID } from '../../bili.mjs';
import { buildRelationOps, buildUserTagOps, buildTagAdminOps } from '../../executor.mjs';

const STATE_ACT = {
  normal: RELATION_ACT.follow,
  quiet: RELATION_ACT.quietFollow,
};

export default defineCommand({
  name: 'follow',
  summary: '关注管理：关注 / 取关 / 改关注类型 / 分组增删改',
  usage: '[list|add|remove|set|tag] [uid...]',
  needsChrome: true,
  mutating: true,
  selectable: true,
  subs: {
    'list': '列出关注（默认），可按分组 / 状态 / 停更天数筛',
    'add <uid...>': '关注，可同时指定 --state 和 --tag',
    'remove <uid...>': '取关（也可用选择器批量挑）',
    'set <uid...>': '改关注类型：--state normal|special|quiet',
    'tag create|rename|delete <名称>': '分组本身的增删改',
    'tag add|remove <分组> <uid...>': '把 UP 加入 / 移出某个分组',
  },
  flags: {
    state: { type: 'enum', values: ['normal', 'special', 'quiet'], desc: '关注类型。特别关注内部就是 tagid -10 的分组' },
    tag: { type: 'tagRef', desc: '分组名或 tagid' },
    to: { type: 'tagRef', desc: 'tag rename 的新名字' },
    'inactive-days': { type: 'int', min: 1, desc: '超过 N 天没投稿算停更（需要先 scan uploads）' },
    refresh: { type: 'boolean', desc: '强制重新拉取关注列表' },
    limit: { type: 'int', min: 1, desc: 'list：只显示前 N 个' },
  },
  examples: [
    'follow list --tag 编程',
    'follow list --state special',
    'follow set 12345,67890 --state special --yes',
    'follow tag create "长期追更" --yes',
    'follow remove --emit-candidates cand.json',
    'follow remove --apply picked.json --yes',
  ],

  async plan(ctx) {
    const sub = ctx.positionals[0] ?? 'list';
    const rest = ctx.positionals.slice(1);
    const { flags } = ctx;

    if (sub === 'tag') return planTag(ctx, rest);

    const needUploads = flags['inactive-days'] != null;
    const d = await loadFollowData(ctx, { refresh: !!flags.refresh, needUploads });
    const warnings = [...d.warnings];
    const byMid = new Map(d.list.map((u) => [String(u.mid), u]));

    // ---- list ----
    if (sub === 'list') {
      const filtered = filterUsers(d, flags);
      const rows = (flags.limit ? filtered.slice(0, flags.limit) : filtered).map((u) => ({
        mid: u.mid, uname: u.uname,
        state: stateOf(u, d.special),
        tags: tagsOf(u, d.special).map((t) => d.tagById.get(t)?.name ?? String(t)),
        lastPub: d.uploads.get(String(u.mid))?.lastPubTs ?? null,
      }));
      return {
        readonly: true,
        data: { total: d.list.length, matched: filtered.length, shown: rows.length, tags: d.tags, users: rows },
        warnings,
      };
    }

    // ---- 目标集合：显式 uid，或选择器 ----
    const explicit = rest.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);

    if (sub === 'remove') {
      const protectedIds = new Set([...d.special]);   // 特别关注默认永不动
      const pool = filterUsers(d, flags);

      if (!explicit.length && !flags.apply) {
        // 吐候选清单，交给调用方（你 / agent / 自然语言）裁决
        const sel = buildSelection({
          kind: 'unfollow',
          candidates: pool.map((u) => ({
            id: String(u.mid), uname: u.uname,
            state: stateOf(u, d.special),
            tags: tagsOf(u, d.special).map((t) => d.tagById.get(t)?.name ?? String(t)),
            followedAt: u.mtime ?? null,
            lastPubTs: d.uploads.get(String(u.mid))?.lastPubTs ?? null,
            uploadCount: d.uploads.get(String(u.mid))?.count ?? null,
            sign: (u.sign ?? '').slice(0, 60),
          })),
          protectedIds,
          maxSelect: flags['max-select'] ?? null,
          note: '特别关注已标 protected，选中会被整份拒收。',
        });
        if (flags['emit-candidates']) {
          writeSelection(flags['emit-candidates'], sel);
          ctx.say(`候选清单（${sel.candidates.length} 个）已写入 ${flags['emit-candidates']}`);
        }
        process.stdout.write(JSON.stringify(sel, null, 2) + '\n');
        ctx.say('挑出要取关的，存成 {"selected":{"<uid>":"<理由>"}} 后用 --apply <文件> 回填。理由必填。');
        return { handled: true };
      }

      let targets, reasons = new Map();
      if (flags.apply) {
        let raw;
        try { raw = JSON.parse(readFileSync(flags.apply, 'utf8')); }
        catch (e) { return ctx.usageError(`读不了 --apply 文件：${e.message}`); }
        const res = applySelection(pool, raw, {
          idOf: (u) => u.mid, protectedIds,
          maxSelect: flags['max-select'] ?? null,
          allowProtected: !!flags['allow-protected'],
        });
        if (res.fatal) return ctx.usageError(res.fatal);
        targets = res.selected;
        reasons = res.reasons;
        ctx.say(`回填：采纳 ${targets.length} 个` + (res.rejected.length ? `，拒收 ${res.rejected.length} 个` : ''));
        for (const r of res.rejected.slice(0, 5)) ctx.say(`    拒收 ${r.id}：${r.message}`);
        if (res.rejected.length > 5) ctx.say(`    … 另有 ${res.rejected.length - 5} 个`);
        if (res.rejected.length) warnings.push({ code: 'REJECTED', message: `${res.rejected.length} 个被拒收（不在候选清单 / 受保护 / 没给理由）` });
      } else {
        targets = explicit.map((m) => byMid.get(m) ?? { mid: m, uname: m });
        const hitProtected = targets.filter((u) => protectedIds.has(String(u.mid)));
        if (hitProtected.length && !flags['allow-protected']) {
          return ctx.usageError(`这些是特别关注，默认不动：${hitProtected.map((u) => u.uname ?? u.mid).join(', ')}。确实要取关请加 --allow-protected。`);
        }
      }

      if (!targets.length) return { data: { targets: 0 }, warnings, nothing: true, nothingReason: '没有要取关的对象' };

      return {
        data: {
          action: 'remove', count: targets.length,
          targets: targets.slice(0, 50).map((u) => ({ mid: u.mid, uname: u.uname, reason: reasons.get(String(u.mid)) ?? null })),
        },
        warnings,
        ops: buildRelationOps(ctx.bili, targets, RELATION_ACT.unfollow, { opName: 'unfollow', verb: '取关', reasons }),
        backup: {
          kind: 'unfollow',
          payload: {
            // 理由一起备份 —— 自然语言的判断依据无法从结果反推
            targets: targets.map((u) => ({ mid: u.mid, uname: u.uname, reason: reasons.get(String(u.mid)) ?? null, tags: tagsOf(u, d.special) })),
            snapshot: { total: d.list.length, truncated: d.truncated },
          },
        },
        jobKind: 'unfollow', resumeKey: 'unfollow',
      };
    }

    // ---- add / set ----
    if (sub === 'add' || sub === 'set') {
      if (!explicit.length) return ctx.usageError(`follow ${sub} 需要至少一个 UID。例：follow ${sub} 12345,67890 --state special`);
      const state = flags.state ?? (sub === 'add' ? 'normal' : null);
      if (!state && !flags.tag) return ctx.usageError('follow set 需要 --state 或 --tag');

      const gate = checkSupport(state, { specialCount: d.special.size });
      if (gate.block) return ctx.usageError(gate.message);
      if (gate.warn) warnings.push({ code: 'QUOTA_OR_UNVERIFIED', message: gate.message });

      const ops = [];
      const targets = explicit.map((m) => byMid.get(m) ?? { mid: m, uname: m });

      // 1. 关注动作（add 才需要；set 假定已关注）
      if (sub === 'add') {
        const act = STATE_ACT[state === 'special' ? 'normal' : state];
        ops.push(...buildRelationOps(ctx.bili, targets, act, {
          opName: state === 'quiet' ? 'quietFollow' : 'follow',
          verb: state === 'quiet' ? '悄悄关注' : '关注',
        }));
      } else if (state && state !== 'special') {
        const act = STATE_ACT[state];
        ops.push(...buildRelationOps(ctx.bili, targets, act, {
          opName: state === 'quiet' ? 'quietFollow' : 'follow',
          verb: state === 'quiet' ? '改为悄悄关注' : '改为普通关注',
        }));
      }

      // 2. 分组归属。setUserTags 是覆盖语义，所以必须算出完整目标集合，
      //    不能只传「要加的那个」—— 那会把用户原有的分组和特别关注一起抹掉。
      const desired = new Map();
      const tagRef = flags.tag ? resolveTag(flags.tag, d.tags) : null;
      if (flags.tag && !tagRef) return ctx.usageError(`找不到分组「${flags.tag}」。用 follow list 看现有分组。`);

      for (const u of targets) {
        const cur = new Set(tagsOf(u, d.special));
        if (state === 'special') cur.add(SPECIAL_TAG_ID);
        if (state === 'normal' && sub === 'set') cur.delete(SPECIAL_TAG_ID);
        if (tagRef) cur.add(Number(tagRef.tagid));
        desired.set(String(u.mid), [...cur]);
      }
      const changed = new Map([...desired].filter(([mid, want]) => {
        const u = byMid.get(mid);
        const before = u ? tagsOf(u, d.special) : [];
        return JSON.stringify([...before].sort()) !== JSON.stringify([...want].sort());
      }));
      const badIds = validateTagIds(changed, d.tagById);
      if (badIds.length) {
        return ctx.usageError(`目标分组里有不存在的 tagid：${badIds.join(', ')}。`
          + 'B 站对不存在的 tagid 返回 code 0（静默接受），而分组设置是覆盖语义 —— '
          + '发出去会把这些人的分组清空。已拦下。');
      }
      if (changed.size) {
        ops.push(...buildUserTagOps(ctx.bili, changed, { labelOf: (t) => d.tagById.get(t)?.name ?? String(t) }));
      }

      return {
        data: {
          action: sub, state, tag: tagRef?.name ?? null,
          count: targets.length, tagChanges: changed.size,
          targets: targets.map((u) => ({ mid: u.mid, uname: u.uname ?? null })),
        },
        warnings,
        ops,
        backup: {
          kind: 'follow-' + sub,
          payload: { targets: targets.map((u) => ({ mid: u.mid, uname: u.uname, beforeTags: tagsOf(u, d.special), beforeState: stateOf(u, d.special) })) },
        },
        jobKind: 'follow', resumeKey: 'follow',
      };
    }

    return ctx.usageError(`未知子命令：follow ${sub}（可用：list / add / remove / set / tag）`);
  },

  render(r, ctx) {
    const d = r.data;
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);

    if (d.users) {
      ctx.say(`关注 ${d.total} 个，匹配 ${d.matched} 个，分组 ${d.tags.length} 个`);
      for (const u of d.users) {
        const t = u.tags.length ? '  [' + u.tags.join('/') + ']' : '';
        ctx.say(`  ${String(u.mid).padEnd(12)} ${u.state.padEnd(8)} ${u.uname}${t}`);
      }
      if (d.matched > d.shown) ctx.say(`  … 其余 ${d.matched - d.shown} 个（--limit 调整）`);
      return;
    }
    if (d.tagPlan) {
      for (const line of d.tagPlan) ctx.say('  ' + line);
      return;
    }
    if (d.action === 'remove') {
      ctx.say(`将取关 ${d.count} 个：`);
      for (const u of d.targets) ctx.say(`  ${String(u.mid).padEnd(12)} ${u.uname ?? ''}${u.reason ? ' — ' + u.reason : ''}`);
      if (d.count > d.targets.length) ctx.say(`  … 其余 ${d.count - d.targets.length} 个`);
      return;
    }
    ctx.say(`${d.action === 'add' ? '关注' : '修改'} ${d.count} 个${d.state ? `，状态 → ${d.state}` : ''}${d.tag ? `，加入分组「${d.tag}」` : ''}`);
    if (d.tagChanges) ctx.say(`  其中 ${d.tagChanges} 个的分组归属会变`);
  },
});

/**
 * 按 probe relation-act 的实测结果决定某个 state 能不能用。
 *
 * 不靠猜：probes.json 里没有记录就只警告不拦（让用户自己去跑探针），
 * 有记录且明确不可用就直接拦下并说明原因 —— 静默失败比报错难查得多。
 */
function checkSupport(state, { specialCount = null } = {}) {
  const p = loadProbes()['relation-act'];
  const codeOf = (k) => p?.raw?.[k]?.code ?? p?.raw?.[k + 'Code'] ?? '?';
  const msgOf = (k) => p?.raw?.[k]?.message ?? '';

  if (!p) {
    return (state === 'quiet' || state === 'special')
      ? { warn: true, message: `「${state}」还没在本账号上实测过。先跑 bili-station probe relation-act --yes，否则可能静默失败。` }
      : {};
  }

  if (state === 'quiet' && p.verified?.quietFollow === false) {
    return {
      block: true,
      message: `悄悄关注实测不可用：/x/relation/modify act=3 返回 code=${codeOf('quietFollow')}「${msgOf('quietFollow')}」。`
        + 'B 站可能已下线这个动作，或它需要额外参数。'
        + `实测时间 ${p.at}，重测：bili-station probe relation-act --yes`,
    };
  }

  if (state === 'special') {
    // 22117 的 message 是「特殊关注达到上限」——这是**配额**，不是接口不可写。
    // 所以不拦，只做预检提醒：名额腾出来之后同一条命令就能跑通。
    if (p.verified?.specialWritableViaTags === false) {
      return {
        block: true,
        message: `特别关注写不进去：setUserTags(tagid=-10) 返回 code=${codeOf('setSpecial')}「${msgOf('setSpecial')}」，原因待查。实测时间 ${p.at}`,
      };
    }
    if (p.specialQuotaFull && specialCount != null) {
      return {
        warn: true,
        message: `特别关注上次实测已达上限（${p.specialCount} 个，B 站返回「${msgOf('setSpecial') || '特殊关注达到上限'}」）。`
          + `当前 ${specialCount} 个。如果仍然满着，这次写入会失败 —— 先在网页端移除几个再来。`,
      };
    }
  }
  return {};
}

/**
 * 校验目标分组 id 全部存在。
 *
 * 必须做，因为**B 站对不存在的 tagid 返回 code 0「OK」**（实测 tagids=999999999）。
 * 而 setUserTags 是覆盖语义 —— 传一个错 id 进去不会报错，只会把这个人
 * 原有的分组静默清空。这是最难查的一类失败。
 */
function validateTagIds(desired, tagById) {
  const bad = new Set();
  for (const ids of desired.values()) {
    for (const id of ids) {
      if (Number(id) === DEFAULT_TAG_ID || Number(id) === SPECIAL_TAG_ID) continue;
      if (!tagById.has(Number(id))) bad.add(Number(id));
    }
  }
  return [...bad];
}

function filterUsers(d, flags) {
  let list = d.list;
  if (flags.tag) {
    const t = resolveTag(flags.tag, d.tags);
    if (t) list = list.filter((u) => tagsOf(u, d.special).includes(Number(t.tagid)));
    else list = [];
  }
  if (flags.state) list = list.filter((u) => stateOf(u, d.special) === flags.state);
  if (flags['inactive-days'] != null) {
    const nowSec = Math.floor(Date.now() / 1000);
    list = list.filter((u) => {
      const info = d.uploads.get(String(u.mid));
      if (!info) return false;
      if (info.count === 0) return true;
      if (!info.lastPubTs) return false;
      return (nowSec - info.lastPubTs) / 86400 > flags['inactive-days'];
    });
  }
  return list;
}

async function planTag(ctx, rest) {
  const { flags } = ctx;
  const op = rest[0];
  const tags = await ctx.bili.tags();
  const tagIds = new Map(tags.map((t) => [String(t.name).trim(), t.tagid]));

  if (op === 'create') {
    const names = rest.slice(1).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return ctx.usageError('用法：follow tag create "长期追更,待整理" --yes');
    const creates = names.filter((n) => !tagIds.has(n));
    return {
      data: { action: 'tag-create', creates, skipped: names.filter((n) => tagIds.has(n)), tagPlan: creates.map((n) => '建分组：' + n) },
      ops: buildTagAdminOps(ctx.bili, { creates }, tagIds),
      backup: { kind: 'tags', payload: tags },
      jobKind: 'tag', resumeKey: 'tag',
      nothingReason: creates.length ? null : '这些分组都已存在',
    };
  }

  if (op === 'rename') {
    const from = rest[1];
    const to = flags.to ?? rest[2];
    if (!from || !to) return ctx.usageError('用法：follow tag rename 旧名 新名 --yes');
    const t = resolveTag(from, tags);
    if (!t) return ctx.usageError(`找不到分组「${from}」`);
    return {
      data: { action: 'tag-rename', from: t.name, to, tagPlan: [`改名：${t.name} → ${to}`] },
      ops: buildTagAdminOps(ctx.bili, { renames: [{ tagid: t.tagid, from: t.name, to: String(to) }] }),
      backup: { kind: 'tags', payload: tags },
      jobKind: 'tag', resumeKey: 'tag',
    };
  }

  if (op === 'delete') {
    const names = rest.slice(1).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return ctx.usageError('用法：follow tag delete "分组名" --yes');
    const hits = names.map((n) => resolveTag(n, tags)).filter(Boolean);
    const miss = names.filter((n) => !resolveTag(n, tags));
    if (hits.some((t) => Number(t.tagid) === SPECIAL_TAG_ID)) {
      return ctx.usageError('「特别关注」是 B 站内建分组，不能删除。要清空它请用 follow set <uid...> --state normal。');
    }
    return {
      data: {
        action: 'tag-delete', deletes: hits.map((t) => t.name), missing: miss,
        tagPlan: hits.map((t) => `删分组：${t.name}（组内 UP 不会被取关，只是回到默认分组）`),
      },
      ops: buildTagAdminOps(ctx.bili, { deletes: hits.map((t) => ({ tagid: t.tagid, name: t.name })) }),
      backup: { kind: 'tags', payload: tags },
      jobKind: 'tag', resumeKey: 'tag',
      nothingReason: hits.length ? null : '这些分组都不存在',
    };
  }

  if (op === 'add' || op === 'remove') {
    const tagRef = resolveTag(rest[1] ?? flags.tag, tags);
    if (!tagRef) return ctx.usageError(`用法：follow tag ${op} <分组> <uid...> --yes`);
    const mids = rest.slice(2).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    if (!mids.length) return ctx.usageError('至少给一个 UID');

    const d = await loadFollowData(ctx, {});
    const byMid = new Map(d.list.map((u) => [String(u.mid), u]));
    const desired = new Map();
    for (const m of mids) {
      const u = byMid.get(m);
      const cur = new Set(u ? tagsOf(u, d.special) : []);
      if (op === 'add') cur.add(Number(tagRef.tagid));
      else cur.delete(Number(tagRef.tagid));
      desired.set(m, [...cur]);
    }
    const badIds = validateTagIds(desired, d.tagById);
    if (badIds.length) return ctx.usageError(`目标分组里有不存在的 tagid：${badIds.join(', ')}，已拦下（B 站不会报错，会静默清空分组）。`);

    return {
      data: {
        action: 'tag-' + op, tag: tagRef.name, count: mids.length,
        tagPlan: [`${op === 'add' ? '加入' : '移出'}分组「${tagRef.name}」：${mids.length} 个 UP`],
      },
      ops: buildUserTagOps(ctx.bili, desired, { labelOf: (t) => d.tagById.get(t)?.name ?? String(t) }),
      backup: {
        kind: 'user-tags',
        payload: { tag: tagRef, before: mids.map((m) => ({ mid: m, tags: byMid.get(m) ? tagsOf(byMid.get(m), d.special) : [] })) },
      },
      jobKind: 'tag', resumeKey: 'tag',
    };
  }

  return ctx.usageError(`未知：follow tag ${op}（可用：create / rename / delete / add / remove）`);
}
