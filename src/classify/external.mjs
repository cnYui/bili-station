/**
 * external 引擎：分类由调用方（Claude / Codex / 人）给出，CLI 只负责校验和落地。
 *
 * 设计前提：调用方本身就是个 LLM 的场景下，再去外挂一个 DeepSeek 既多一把 key 又多一份钱，
 * 而且调用方能结合上下文处理边角。所以这是默认路径。
 *
 * 校验原则：**宁可丢弃也不要放错**。不在候选集里的分类一律拒收并计数，
 * 绝不静默塞进「待分类」或就近匹配 —— 收藏夹放错了用户很难发现。
 */

/** 生成给调用方的待分类清单 */
export function buildTasks(items, candidates, { introLen = 80 } = {}) {
  return {
    candidates,
    instruction: '给每条视频从 candidates 里选恰好一个分类名，输出 {"<id>":"<分类名>"}。不要创造 candidates 之外的分类。',
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      up: it.upper,
      intro: String(it.intro ?? '').slice(0, introLen),
    })),
  };
}

/**
 * 校验并采纳调用方给的分配。
 * @param {Array} items
 * @param {Array<string>} candidates
 * @param {object|Array} raw  {"<id>":"<分类名>"} 或 [{id, category}]
 * @returns {{assignment: Map, detail: Map, accepted: number, rejected: Array, missing: number}}
 */
export function applyExternalAssignment(items, candidates, raw) {
  const map = Array.isArray(raw)
    ? Object.fromEntries(raw.map((r) => [String(r.id), r.category]))
    : Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [String(k), v]));

  // 候选名按「忽略大小写与首尾空格」建索引，但最终写回的是候选集里的原始拼写
  const byLoose = new Map(candidates.map((c) => [c.trim().toLowerCase(), c]));

  const assignment = new Map();
  const detail = new Map();
  const rejected = [];
  let missing = 0;

  for (const it of items) {
    const want = map[String(it.id)];
    if (want == null || want === '') { missing++; continue; }
    const hit = byLoose.get(String(want).trim().toLowerCase());
    if (!hit) {
      rejected.push({ id: it.id, title: it.title, given: String(want) });
      continue;
    }
    assignment.set(it.id, hit);
    detail.set(it.id, { category: hit, source: 'external', ambiguous: false });
  }

  return { assignment, detail, accepted: assignment.size, rejected, missing };
}
