/**
 * 本地关键词规则分类 —— 不联网、免费、可复现、可重跑。
 * 规则形如：{ name: '分类名', any: [...], all: [...], none: [...], upper: [...], tid: [...], weight: 1 }
 * 命中打分后取最高分的分类；都不中则归入兜底分类。
 */

export const DEFAULT_RULES = [
  { name: '编程开发', any: ['python', 'javascript', 'java', 'golang', 'rust', 'c++', '前端', '后端', '算法', '数据结构', '源码', 'api', 'docker', 'linux', '编程', '代码', 'bug', '框架', 'github'] },
  { name: 'AI 与机器学习', any: ['ai', '大模型', 'llm', 'gpt', 'claude', 'stable diffusion', '机器学习', '深度学习', '神经网络', 'transformer', 'agent', 'prompt', '提示词'] },
  { name: '数码硬件', any: ['开箱', '评测', '显卡', 'cpu', '主板', '装机', '手机', '笔记本', '耳机', '键盘', '相机', '硬盘', '路由器', '屏幕'] },
  { name: '学习考试', any: ['考研', '四六级', '公务员', '教程', '网课', '复习', '真题', '备考', '笔记', '课程', '讲解', '入门', '速成'] },
  { name: '游戏', any: ['攻略', '实况', '通关', 'boss', '联机', '开荒', '速通', 'mod', '游戏', '主机', 'steam', '手游', '电竞'] },
  { name: '美食烹饪', any: ['做法', 'food', '食谱', '菜谱', '下饭', '探店', '烘焙', '料理', '美食', '厨房', '空气炸锅'] },
  { name: '影视剪辑', any: ['混剪', '剪辑', '解说', '影评', '预告', '番剧', '动画', '电影', 'mad', 'pv'] },
  { name: '音乐', any: ['翻唱', '原创曲', '钢琴', '吉他', '纯音乐', 'cover', '编曲', '歌曲', 'live', '演奏'] },
  { name: '健身运动', any: ['健身', '减脂', '增肌', '跑步', '瑜伽', '拉伸', '训练', '体态', '腹肌', '徒手'] },
  { name: '生活技巧', any: ['收纳', '整理', '技巧', '省钱', '攻略', '避坑', '实用', '好物', '装修', '租房'] },
  { name: '户外旅行', any: ['露营', '徒步', '旅行', '自驾', 'vlog', '风景', '攻略', '骑行', '登山'] },
  { name: '科普知识', any: ['科普', '原理', '为什么', '历史', '纪录片', '地理', '物理', '化学', '生物', '宇宙', '冷知识'] },
  { name: '财经投资', any: ['基金', '股票', '理财', '经济', '房价', '保险', '副业', '创业', '税'] },
];

export const FALLBACK_CATEGORY = '待分类';

function normalize(s) {
  return String(s ?? '').toLowerCase();
}

/** 对单个条目打分，返回 [{name, score, hits}] 倒序 */
export function scoreItem(item, rules = DEFAULT_RULES) {
  const hay = normalize([item.title, item.intro, item.upper].filter(Boolean).join('  '));
  const upper = normalize(item.upper);
  const out = [];

  for (const rule of rules) {
    let score = 0;
    const hits = [];

    if (rule.none?.some((k) => hay.includes(normalize(k)))) continue; // 排除词命中直接出局

    if (rule.all?.length) {
      const allHit = rule.all.every((k) => hay.includes(normalize(k)));
      if (!allHit) continue;
      score += rule.all.length * 2;
      hits.push(...rule.all);
    }
    for (const k of rule.any ?? []) {
      if (hay.includes(normalize(k))) { score += 1; hits.push(k); }
    }
    for (const u of rule.upper ?? []) {
      if (upper.includes(normalize(u))) { score += 3; hits.push('UP:' + u); }
    }
    if (rule.tid?.length && item.tidV2 != null && rule.tid.includes(item.tidV2)) {
      score += 2; hits.push('tid_v2:' + item.tidV2);
    }
    if (score > 0) out.push({ name: rule.name, score: score * (rule.weight ?? 1), hits });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 批量分类。
 * @returns {{assignment: Map<itemId,string>, detail: Map<itemId,object>, unmatched: number}}
 */
export function classifyAll(items, rules = DEFAULT_RULES, o = {}) {
  const minScore = o.minScore ?? 1;
  const fallback = o.fallback ?? FALLBACK_CATEGORY;
  const keepUnmatched = o.keepUnmatched ?? false; // true = 不给兜底分类，跳过不动

  const assignment = new Map();
  const detail = new Map();
  let unmatched = 0;

  for (const it of items) {
    const scored = scoreItem(it, rules);
    const top = scored[0];
    if (top && top.score >= minScore) {
      assignment.set(it.id, top.name);
      const second = scored[1];
      detail.set(it.id, {
        category: top.name,
        score: top.score,
        hits: top.hits.slice(0, 6),
        // 和第二名拉不开差距的，标出来让人复核
        ambiguous: second ? top.score - second.score <= 1 : false,
        runnerUp: second?.name ?? null,
      });
    } else {
      unmatched += 1;
      if (!keepUnmatched) {
        assignment.set(it.id, fallback);
        detail.set(it.id, { category: fallback, score: 0, hits: [], ambiguous: true, runnerUp: null });
      }
    }
  }
  return { assignment, detail, unmatched };
}
