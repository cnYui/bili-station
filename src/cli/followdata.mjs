/**
 * 关注数据的统一装载与状态判定。
 *
 * B 站的关系模型是**三个正交维度**，命令设计必须照着它来：
 *   1. 关注状态   未关注 / 普通关注 / 悄悄关注 / 拉黑
 *   2. 特别关注   是 / 否  —— 内部就是 tagid = -10 的分组
 *   3. 普通分组   tagid 0..N
 *
 * 维度 2 和 3 共用同一套 API，所以绝不能做成两套命令：那样会出现
 * 「改了分组把特别关注弄掉了」这种事（setUserTags 是覆盖语义）。
 */
import * as store from '../store.mjs';
import { SPECIAL_TAG_ID } from '../bili.mjs';

/**
 * 装载关注全景。优先用本地缓存，refresh 时重拉。
 * @returns {{list, total, truncated, special: Set, tags: Array, tagById: Map, uploads: Map}}
 */
export async function loadFollowData(ctx, { refresh = false, needUploads = false } = {}) {
  let data = store.read('followings.json', null);
  if (!data || refresh) {
    ctx.say('拉取关注列表…');
    data = await ctx.bili.followings((n, t) => { if (n % 200 === 0) ctx.say(`  ${n}${t ? '/' + t : ''}`); });
    store.write('followings.json', data);
  }

  const special = await ctx.bili.specialFollowings();
  const tags = await ctx.bili.tags();
  store.write('special.json', [...special]);
  store.write('tags.json', tags);

  const uploads = new Map(store.read('uploads.json', []));
  const warnings = [];
  if (data.truncated) {
    warnings.push({ code: 'TRUNCATED', message: `关注列表未拉全：只读到 ${data.list.length}/${data.total ?? '?'}，这是 B 站分页深度限制` });
  }
  if (needUploads && !uploads.size) {
    warnings.push({
      code: 'NO_UPLOADS',
      message: '没有投稿时间数据，--inactive-days / --only-inactive 会命中 0 个目标。先跑 bili-station scan uploads。',
    });
  }

  const tagById = new Map(tags.map((t) => [Number(t.tagid), t]));
  tagById.set(SPECIAL_TAG_ID, { tagid: SPECIAL_TAG_ID, name: '特别关注' });

  return { ...data, special, tags, tagById, uploads, warnings };
}

/** 单个用户的当前状态 */
export function stateOf(u, special) {
  if (special.has(String(u.mid)) || u.special) return 'special';
  // 悄悄关注在关注列表里的表现形式尚未实测确认，见 probe relation-act。
  // 在确认之前一律报 normal，绝不猜。
  return 'normal';
}

/** 解析 --tag 传进来的分组名或 id */
export function resolveTag(ref, tags) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (/^-?\d+$/.test(s)) {
    const byId = tags.find((t) => Number(t.tagid) === Number(s));
    if (byId) return byId;
    if (Number(s) === SPECIAL_TAG_ID) return { tagid: SPECIAL_TAG_ID, name: '特别关注' };
    return null;
  }
  if (s === '特别关注') return { tagid: SPECIAL_TAG_ID, name: '特别关注' };
  return tags.find((t) => String(t.name).trim().toLowerCase() === s.toLowerCase()) ?? null;
}

/** 用户当前所属的分组 id 列表（followings 接口的 tag 字段） */
export function tagsOf(u, special) {
  const base = Array.isArray(u.tags) ? u.tags.map(Number) : [];
  const set = new Set(base.filter((x) => Number.isFinite(x)));
  if (special.has(String(u.mid))) set.add(SPECIAL_TAG_ID);
  return [...set];
}
