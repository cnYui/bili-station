/**
 * 规划层 —— 全是纯函数：输入数据，输出「打算做什么」，不碰网络不写数据。
 * 干跑预览和真正执行共用同一份 plan，保证「你看到的」就是「将会发生的」。
 */

/**
 * 关注清理计划。
 * @param {Array} all       全部关注 [{mid, uname, mtime, special}]
 * @param {object} o
 *   keep         保留最近关注的前 N 个（按 mtime 倒序）
 *   special      Set<mid> 特别关注，无条件保留
 *   protectTags  Set<mid> 处在受保护分组里的，无条件保留
 *   inactive     Map<mid, {lastPubTs, count}> 投稿信息，用于停更判定
 *   inactiveDays 超过多少天没投稿算停更；为 null 则不启用该规则
 *   onlyInactive true = 只取关停更的，keep 规则不再单独生效
 */
export function planUnfollow(all, o = {}) {
  const keep = o.keep ?? null;
  const special = o.special ?? new Set();
  const protectTags = o.protectTags ?? new Set();
  const inactive = o.inactive ?? new Map();
  const inactiveDays = o.inactiveDays ?? null;
  const onlyInactive = o.onlyInactive ?? false;
  // 「零投稿」默认不算停更。实测发现 /x/space/wbi/arc/search 会对确实在更新的
  // 大号返回 code 0 + count 0（空间隐私 / 账号迁移 / 限流期间的空响应都可能），
  // 把它当成「一个投稿都没有」会误取关。要动这批必须显式 opt-in。
  const zeroUploadIsStale = o.zeroUploadIsStale ?? false;

  const nowSec = Math.floor(Date.now() / 1000);
  const sorted = [...all].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));

  const protectedSet = new Set([...special, ...protectTags]);
  const reasons = new Map();

  const isStale = (u) => {
    if (inactiveDays == null) return false;
    const info = inactive.get(String(u.mid));
    if (!info) return false;
    if (info.count === 0) return zeroUploadIsStale; // 零投稿：含义不明确，默认不判停更
    if (!info.lastPubTs) return false;
    return (nowSec - info.lastPubTs) / 86400 > inactiveDays;
  };

  const targets = [];
  const kept = [];

  sorted.forEach((u, idx) => {
    const mid = String(u.mid);
    if (protectedSet.has(mid) || u.special) {
      kept.push(u);
      reasons.set(mid, special.has(mid) || u.special ? 'special' : 'protected-tag');
      return;
    }
    if (onlyInactive) {
      if (isStale(u)) { targets.push(u); reasons.set(mid, 'inactive'); }
      else { kept.push(u); reasons.set(mid, 'active'); }
      return;
    }
    const overKeep = keep != null && idx >= keep;
    const stale = isStale(u);
    if (overKeep || stale) {
      targets.push(u);
      reasons.set(mid, overKeep && stale ? 'over-keep+inactive' : overKeep ? 'over-keep' : 'inactive');
    } else {
      kept.push(u);
      reasons.set(mid, 'recent');
    }
  });

  return {
    total: all.length,
    targets,
    keptCount: kept.length,
    specialSaved: [...protectedSet].length,
    reasons,
    summary: {
      byReason: targets.reduce((acc, u) => {
        const r = reasons.get(String(u.mid));
        acc[r] = (acc[r] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}

/**
 * 收藏夹分类计划。
 * @param {Array} items        条目 [{id, title, srcMediaId, dead, ...}]
 * @param {Map}   assignment   Map<itemId, 分类名>
 * @param {Array} folders      已有收藏夹 [{id, title, count}]
 * @param {object} o
 *   folderQuota   收藏夹个数上限（用于预检；未知时传 null 跳过）
 *   perFolderCap  单夹容量上限，默认 1000
 *   mode          'copy' | 'move'
 */
export function planFavClassify(items, assignment, folders, o = {}) {
  const perFolderCap = o.perFolderCap ?? 1000;
  const folderQuota = o.folderQuota ?? null;
  const mode = o.mode ?? 'copy';

  // 同名复用：精确 → 忽略大小写与首尾空格。
  // （favlist-classifier 的默认路径漏了这步，重跑会建出「游戏_1」「游戏_2」）
  const byExact = new Map(folders.map((f) => [f.title, f]));
  const byLoose = new Map(folders.map((f) => [f.title.trim().toLowerCase(), f]));

  const groups = new Map(); // 分类名 -> items[]
  for (const it of items) {
    const cat = assignment.get(it.id);
    if (!cat) continue;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  }

  const plan = [];
  let newFolders = 0;
  for (const [name, list] of groups) {
    const hit = byExact.get(name) ?? byLoose.get(name.trim().toLowerCase()) ?? null;
    if (!hit) newFolders += 1;
    const existingCount = hit?.count ?? 0;
    const overflow = existingCount + list.length > perFolderCap;
    plan.push({
      category: name,
      targetId: hit?.id ?? null,
      targetTitle: hit?.title ?? name,
      isNew: !hit,
      reuseKind: hit ? (byExact.has(name) ? 'exact' : 'loose') : null,
      items: list,
      count: list.length,
      existingCount,
      overflow,
      overflowBy: overflow ? existingCount + list.length - perFolderCap : 0,
    });
  }
  plan.sort((a, b) => b.count - a.count);

  const warnings = [];
  if (folderQuota != null && folders.length + newFolders > folderQuota) {
    warnings.push({
      kind: 'folder-quota',
      message: '预计新建 ' + newFolders + ' 个收藏夹，加上已有 ' + folders.length
        + ' 个将超过上限 ' + folderQuota + '。'
        + '注意：配额满时 B 站返回的错误信息会像是限流，实际是配额问题，别误判为风控。'
        + '建议把分类数压到 ' + Math.max(0, folderQuota - folders.length) + ' 个以内。',
    });
  }
  for (const p of plan.filter((x) => x.overflow)) {
    warnings.push({
      kind: 'folder-cap',
      message: '收藏夹「' + p.targetTitle + '」将达到 ' + (p.existingCount + p.count)
        + ' 条，超过单夹上限 ' + perFolderCap + ' 共 ' + p.overflowBy + ' 条，超出部分会失败。',
    });
  }

  return {
    mode,
    plan,
    totalItems: [...groups.values()].reduce((a, b) => a + b.length, 0),
    categories: plan.length,
    newFolders,
    reusedFolders: plan.length - newFolders,
    warnings,
  };
}

/** 失效视频清理计划 */
export function planDeadCleanup(itemsByFolder, o = {}) {
  const action = o.action ?? 'archive'; // 'archive' 归档到一个夹 | 'remove' 直接移除
  const archiveName = o.archiveName ?? '已失效视频归档';
  const groups = [];
  let total = 0;
  for (const [mediaId, items] of itemsByFolder) {
    const dead = items.filter((i) => i.dead);
    if (dead.length === 0) continue;
    groups.push({ mediaId, count: dead.length, items: dead });
    total += dead.length;
  }
  return { action, archiveName, groups, total };
}

/** 把条目切成安全大小的批次 */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 条目 -> "aid:type" 资源串 */
export const toResource = (it) => it.id + ':' + (it.type ?? 2);

/**
 * 合并计划：把若干来源收藏夹的内容全部搬进一个目标夹。
 * 不需要分类，是纯粹的归拢。
 *
 * @param {Map<number, Array>} itemsBySource  来源夹 id -> 条目
 * @param {object} target  目标夹 {id, title, count}
 * @param {object} o
 *   perFolderCap  目标夹容量上限（用于预警）
 *   includeDead   是否连失效条目一起搬，默认 true
 */
export function planMerge(itemsBySource, target, o = {}) {
  const perFolderCap = o.perFolderCap ?? null;
  const includeDead = o.includeDead ?? true;

  const groups = [];
  let total = 0;
  let deadTotal = 0;
  const seen = new Set();
  let duplicateInSources = 0;

  for (const [srcId, items] of itemsBySource) {
    if (Number(srcId) === Number(target.id)) continue;   // 目标夹自己不作为来源
    const live = [];
    const dead = [];
    for (const it of items) {
      // 同一个视频可能同时在多个来源夹里；只搬一次，剩下的会随源夹清空而消失
      const key = String(it.id);
      if (seen.has(key)) { duplicateInSources++; continue; }
      seen.add(key);
      (it.dead ? dead : live).push(it);
    }
    if (dead.length) deadTotal += dead.length;
    const take = includeDead ? [...live, ...dead] : live;
    if (!take.length) continue;
    groups.push({
      srcId: Number(srcId),
      srcTitle: o.titleOf?.(srcId) ?? String(srcId),
      live,
      dead: includeDead ? dead : [],
      count: take.length,
    });
    total += take.length;
  }

  const warnings = [];
  if (perFolderCap != null && (target.count ?? 0) + total > perFolderCap) {
    warnings.push({
      kind: 'folder-cap',
      message: '目标夹「' + target.title + '」当前 ' + (target.count ?? 0) + ' 条，再并入 ' + total
        + ' 条将达到 ' + ((target.count ?? 0) + total) + ' 条，超过配置的单夹上限 ' + perFolderCap
        + '。这个上限是配置值不是 B 站的权威数字，真超了接口会直接报错。',
    });
  }
  if (deadTotal) {
    warnings.push({
      kind: 'dead-items',
      message: '其中有 ' + deadTotal + ' 条已失效视频。它们会被单独成批搬运，'
        + '万一接口拒绝失效条目，也不会连累同批的正常视频。',
    });
  }
  if (duplicateInSources) {
    warnings.push({
      kind: 'duplicate',
      message: '有 ' + duplicateInSources + ' 条视频同时存在于多个来源夹，只会搬运一次。',
    });
  }

  return { target, groups, total, deadTotal, duplicateInSources, warnings };
}
