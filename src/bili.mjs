/**
 * B 站 API 层 —— 所有请求都经 CdpSession 在已登录页面内发出。
 * WBI 签名在 Node 侧用 node:crypto 算好后把签好的完整 URL 交给页面，
 * 省掉在页面上下文里再塞一份 md5 实现。
 */
import { createHash } from 'node:crypto';
import { PAGE_FETCH } from './cdp.mjs';

const API = 'https://api.bilibili.com';

/** 特别关注在 B 站内部就是一个分组；默认分组是 0 */
export const SPECIAL_TAG_ID = -10;
export const DEFAULT_TAG_ID = 0;

/**
 * /x/relation/modify 的 act 取值。
 *
 * 只有 unfollow(2) 是本项目实测跑过的（4260 条那次实战之外还跑过取关）。
 * 其余取值来自公开文档，**必须实测确认后再依赖** ——
 * `bili-station probe relation-act --yes` 会逐个试并把结果写进 probes.json，
 * 上层命令读它来决定哪些 state 可用。把猜测硬写进代码是这个项目一直避免的事。
 */
export const RELATION_ACT = {
  follow: 1,
  unfollow: 2,
  quietFollow: 3,
  unquietFollow: 4,
  block: 5,
  unblock: 6,
};

/** 关注状态的三个取值，对应用户口中的「普通关注 / 特别关注 / 悄悄关注」 */
export const FOLLOW_STATES = ['normal', 'special', 'quiet'];

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

export class Bili {
  constructor(cdp) {
    this.cdp = cdp;
    this.csrf = null;
    this.mid = null;
    this.uname = null;
    this.wbi = null; // { imgKey, subKey, at }
  }

  async get(url) {
    const { body } = await this.cdp.evaluate(PAGE_FETCH, { url, method: 'GET' });
    return body;
  }

  async post(url, form) {
    if (!this.csrf) throw new Error('csrf 未就绪，请先 init()');
    const { body } = await this.cdp.evaluate(PAGE_FETCH, {
      url, method: 'POST', form: { ...form, csrf: this.csrf },
    });
    return body;
  }

  /** 读登录态 + 从页面 cookie 取 bili_jct 作为 csrf + 抓 wbi 密钥 */
  async init() {
    this.csrf = await this.cdp.evaluate(
      'const m = document.cookie.match(/(?:^|;\\s*)bili_jct=([^;]+)/); return m ? m[1] : null;'
    );
    const nav = await this.get(API + '/x/web-interface/nav');
    if (!nav?.data?.isLogin) {
      throw new Error('当前 Chrome 里的 B 站未登录（或 Cookie 已过期），请先在该浏览器登录 B 站');
    }
    this.mid = String(nav.data.mid);
    this.uname = nav.data.uname;
    const imgUrl = nav.data.wbi_img?.img_url ?? '';
    const subUrl = nav.data.wbi_img?.sub_url ?? '';
    const pick = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0];
    if (imgUrl && subUrl) this.wbi = { imgKey: pick(imgUrl), subKey: pick(subUrl), at: Date.now() };
    if (!this.csrf) throw new Error('未能从页面读到 bili_jct，请确认该标签页确实在 bilibili.com 域下且已登录');
    return { mid: this.mid, uname: this.uname, face: nav.data.face, vipStatus: nav.data.vipStatus };
  }

  /** 给需要 wbi 的接口签名 */
  signed(path, params) {
    if (!this.wbi) throw new Error('wbi 密钥未就绪');
    const mk = mixinKey(this.wbi.imgKey, this.wbi.subKey);
    const wts = Math.floor(Date.now() / 1000);
    const all = { ...params, wts };
    const query = Object.keys(all).sort()
      .map((k) => {
        const v = String(all[k]).replace(/[!'()*]/g, '');
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
      })
      .join('&');
    return API + path + '?' + query + '&w_rid=' + md5(query + mk);
  }

  // ---------- 关注 ----------

  /** 翻页拉全部关注。onProgress(已拉条数, total) */
  async followings(onProgress) {
    const all = [];
    const seen = new Set();
    let total = null;
    for (let pn = 1; pn <= 200; pn++) {
      const r = await this.get(
        API + '/x/relation/followings?vmid=' + this.mid + '&pn=' + pn + '&ps=50&order=desc'
      );
      if (r?.code !== 0) {
        // 关注列表接口对分页深度有限制，越界时直接返回非 0 而不是空列表。
        // 这是 12 个同类项目集体没处理的坑：它们会把「读不到了」当成「读完了」。
        return { list: all, total, truncated: true, stopCode: r?.code, stopMsg: r?.message };
      }
      total = r.data?.total ?? total;
      const list = r.data?.list ?? [];
      if (list.length === 0) break;
      for (const u of list) {
        if (seen.has(String(u.mid))) continue; // 翻页竞态去重
        seen.add(String(u.mid));
        all.push({
          mid: String(u.mid), uname: u.uname, face: u.face, sign: u.sign,
          mtime: u.mtime, special: u.special === 1, tags: u.tag ?? null,
        });
      }
      onProgress?.(all.length, total);
      if (list.length < 50) break;
      await new Promise((res) => setTimeout(res, 300 + Math.random() * 400));
    }
    const truncated = total != null && all.length < total;
    return { list: all, total, truncated };
  }

  /**
   * 特别关注就是 tagid = -10 的分组 —— 这是「特别关注」和「分组」共用同一套
   * API 的直接证据，所以上层绝不能把它们做成两套命令。默认分组是 tagid = 0。
   */
  async specialFollowings() {
    return new Set((await this.tagUsers(SPECIAL_TAG_ID)).map((u) => String(u.mid)));
  }

  /** 读一个分组里的成员。tagid=-10 特别关注 / 0 默认分组 */
  async tagUsers(tagid, { ps = 50, maxPages = 40 } = {}) {
    const out = [];
    for (let pn = 1; pn <= maxPages; pn++) {
      const r = await this.get(API + `/x/relation/tag?tagid=${tagid}&pn=${pn}&ps=${ps}`);
      if (r?.code !== 0) break;
      const list = r.data ?? [];
      out.push(...list);
      if (list.length < ps) break;
      await new Promise((res) => setTimeout(res, 250 + Math.random() * 300));
    }
    return out;
  }

  async tags() {
    const r = await this.get(API + '/x/relation/tags');
    return r?.code === 0 ? (r.data ?? []) : [];
  }

  /**
   * 关系修改的唯一入口。act 取值见 RELATION_ACT。
   * 注意：除了 2（取关）以外的取值都需要实测确认 —— 跑
   * `bili-station probe relation-act` 会把真实可用的值写进 probes.json。
   */
  modifyRelation(mid, act) {
    return this.post(API + '/x/relation/modify', { fid: String(mid), act: String(act), re_src: '11' });
  }

  follow(mid) { return this.modifyRelation(mid, RELATION_ACT.follow); }
  unfollow(mid) { return this.modifyRelation(mid, RELATION_ACT.unfollow); }
  quietFollow(mid) { return this.modifyRelation(mid, RELATION_ACT.quietFollow); }
  unquietFollow(mid) { return this.modifyRelation(mid, RELATION_ACT.unquietFollow); }

  /**
   * 设置一批用户的分组归属。
   *
   * 这个接口是**覆盖**语义：传进去的 tagids 就是该用户之后的全部分组。
   * 所以「移出某个分组」= 传「除它以外的其余分组」，而不是有个 removeUsers 接口。
   * 特别关注的加/取消同样走这里（tagid -10 在不在列表里）。
   * 覆盖语义也需要实测确认，见 probe relation-act。
   */
  setUserTags(mids, tagids) {
    return this.post(API + '/x/relation/tags/addUsers', {
      fids: mids.join(','),
      tagids: (tagids.length ? tagids : [0]).join(','),
    });
  }

  /** 保留旧名字，语义等同 setUserTags */
  addUsersToTag(mids, tagids) { return this.setUserTags(mids, tagids); }

  /**
   * 新建关注分组。
   *
   * 端点是 /x/relation/tag/create —— 重构前写的是 /x/relation/tag/add，**那是 404**
   * （实测：`{"code":-1,"message":"non-JSON response (HTTP 404)"}`）。
   * 这条路径此前在 CLI 和 Web UI 都没有入口，所以一直没被发现。
   *
   * 分组名不允许包含特殊字符（下划线会被 22101 拒绝），只有中文/字母/数字是安全的。
   */
  createTag(name) {
    return this.post(API + '/x/relation/tag/create', { tag: name });
  }

  renameTag(tagid, name) {
    return this.post(API + '/x/relation/tag/update', { tagid: String(tagid), name });
  }

  deleteTag(tagid) {
    return this.post(API + '/x/relation/tag/del', { tagid: String(tagid) });
  }

  /** UP 主最近投稿时间，用于判断停更 / 僵尸号。需 wbi 签名。 */
  async lastUpload(mid) {
    const url = this.signed('/x/space/wbi/arc/search', { mid, ps: 1, pn: 1, order: 'pubdate' });
    const r = await this.get(url);
    if (r?.code !== 0) return { ok: false, code: r?.code, message: r?.message };
    const v = r.data?.list?.vlist?.[0];
    return {
      ok: true,
      lastPubTs: v?.created ?? null,
      count: r.data?.page?.count ?? 0,
      title: v?.title ?? null,
    };
  }

  // ---------- 收藏夹 ----------

  async favFolders() {
    const r = await this.get(API + '/x/v3/fav/folder/created/list-all?up_mid=' + this.mid);
    if (r?.code !== 0) return [];
    return (r.data?.list ?? []).map((f) => ({
      id: f.id, fid: f.fid, title: f.title, count: f.media_count, attr: f.attr,
    }));
  }

  /**
   * 拉一个收藏夹的全部条目。
   * 读操作同样会被限流（412 会返回 HTML，表现为非 JSON），所以这里带退避重试：
   * 撞一次就放弃会把「读不全」伪装成「读完了」，这是很危险的沉默失败。
   */
  async favItems(mediaId, onProgress, opts = {}) {
    const {
      maxRetry = 4,
      backoffMs = 15_000,
      startPage = 1,
      seed = [],          // 上次已读到的条目，用于断点续扫
      pageDelayMs = 450,
      pageJitterMs = 500,
    } = opts;
    const out = [...seed];
    for (let pn = startPage; pn <= 500; pn++) {
      const url = API + '/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=' + pn + '&ps=20&platform=web&order=mtime';
      let r = await this.get(url);
      for (let attempt = 1; attempt <= maxRetry && r?.code !== 0; attempt++) {
        const wait = backoffMs * attempt;
        onProgress?.(out.length, { throttled: true, code: r?.code, waitMs: wait, attempt });
        await new Promise((res) => setTimeout(res, wait));
        r = await this.get(url);
      }
      if (r?.code !== 0) {
        // 关键：把 nextPage 带出去。之前失败即丢弃全部进度，重跑从第 1 页开始，
        // 等于用更多请求去撞同一堵墙，自己加重限流。
        return { list: out, complete: false, nextPage: pn, error: { code: r?.code, message: r?.message, atPage: pn } };
      }
      const medias = r.data?.medias ?? [];
      for (const m of medias) {
        out.push({
          id: m.id, bvid: m.bvid, type: m.type, title: m.title,
          cover: m.cover, intro: m.intro,
          upper: m.upper?.name ?? '', upperMid: m.upper?.mid ?? null,
          tid: m.tid ?? null, tidV2: m.tid_v2 ?? m.tidv2 ?? null,
          duration: m.duration, favTime: m.fav_time, pubTime: m.pubtime,
          attr: m.attr ?? 0,
          // attr 非 0 即失效（被删 / 仅自己可见 / 审核下架），标题会变成「已失效视频」
          dead: (m.attr ?? 0) !== 0 || m.title === '已失效视频',
          srcMediaId: mediaId,
        });
      }
      onProgress?.(out.length);
      if (!r.data?.has_more) return { list: out, complete: true, nextPage: null };
      await new Promise((res) => setTimeout(res, pageDelayMs + Math.random() * pageJitterMs));
    }
    return { list: out, complete: true, nextPage: null };
  }

  /**
   * 抽样读取一个收藏夹：每隔 step 页取一页。
   * 收藏夹按 mtime 排序，等间隔跳页 = 覆盖整个收藏时间跨度的均匀样本，
   * 比只读前 N 页（全是最近收藏的）有代表性得多。
   */
  async favSample(mediaId, { totalCount, step = 4, pageDelayMs = 2000, pageJitterMs = 1500, maxRetry = 5, backoffMs = 30_000, onProgress } = {}) {
    const totalPages = Math.ceil(totalCount / 20);
    const pages = [];
    for (let pn = 1; pn <= totalPages; pn += step) pages.push(pn);

    const out = [];
    const failed = [];
    for (let i = 0; i < pages.length; i++) {
      const pn = pages[i];
      const url = API + '/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=' + pn + '&ps=20&platform=web&order=mtime';
      let r = await this.get(url);
      for (let attempt = 1; attempt <= maxRetry && r?.code !== 0; attempt++) {
        const wait = backoffMs * attempt;
        onProgress?.({ throttled: true, code: r?.code, waitMs: wait, attempt, page: pn });
        await new Promise((res) => setTimeout(res, wait));
        r = await this.get(url);
      }
      if (r?.code !== 0) { failed.push({ page: pn, code: r?.code }); continue; }
      for (const m of (r.data?.medias ?? [])) {
        out.push({
          id: m.id, bvid: m.bvid, type: m.type, title: m.title,
          intro: m.intro, upper: m.upper?.name ?? '', upperMid: m.upper?.mid ?? null,
          tid: m.tid ?? null, tidV2: m.tid_v2 ?? m.tidv2 ?? null,
          duration: m.duration, favTime: m.fav_time, pubTime: m.pubtime,
          attr: m.attr ?? 0, dead: (m.attr ?? 0) !== 0 || m.title === '已失效视频',
          page: pn, srcMediaId: mediaId,
        });
      }
      onProgress?.({ done: i + 1, totalPages: pages.length, items: out.length, page: pn });
      if (i < pages.length - 1) await new Promise((res) => setTimeout(res, pageDelayMs + Math.random() * pageJitterMs));
    }
    return { list: out, sampledPages: pages.length, totalPages, failed, step };
  }

  createFolder(title, { privacy = 1 } = {}) {
    // privacy=1 私密。分出来的几十个夹默认不挂在主页上。
    return this.post(API + '/x/v3/fav/folder/add', { title, privacy: String(privacy) });
  }

  /** 收藏夹改名。B 站 folder/edit 要求把 title/intro/privacy 一起回传，缺字段会被清空。 */
  renameFolder(mediaId, title, { intro = '', privacy = 1 } = {}) {
    return this.post(API + '/x/v3/fav/folder/edit', {
      media_id: String(mediaId),
      title,
      intro,
      privacy: String(privacy),
    });
  }

  /** 删除收藏夹（夹里的条目会一起没）。不可逆，上层必须先备份。 */
  deleteFolders(mediaIds) {
    return this.post(API + '/x/v3/fav/folder/del', { media_ids: mediaIds.join(',') });
  }

  /** resources 形如 "aid:type"，type=2 是视频 */
  moveResources(srcMediaId, tarMediaId, resources) {
    return this.post(API + '/x/v3/fav/resource/move', {
      src_media_id: String(srcMediaId),
      tar_media_id: String(tarMediaId),
      mid: this.mid,
      resources: resources.join(','),
      platform: 'web',
    });
  }

  copyResources(srcMediaId, tarMediaId, resources) {
    return this.post(API + '/x/v3/fav/resource/copy', {
      src_media_id: String(srcMediaId),
      tar_media_id: String(tarMediaId),
      mid: this.mid,
      resources: resources.join(','),
      platform: 'web',
    });
  }

  batchDel(mediaId, resources) {
    return this.post(API + '/x/v3/fav/resource/batch-del', {
      media_id: String(mediaId),
      resources: resources.join(','),
      platform: 'web',
    });
  }
}
