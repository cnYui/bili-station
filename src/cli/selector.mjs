/**
 * 选择器：任何批量操作 = **选择器 + 动作**。
 *
 * 这不是新机制，是把 `sort --engine external` 那套（4260 条实战验证过的）
 * 从「分类」抬成通用能力：CLI 吐候选清单 → 调用方（你 / agent / 自然语言）
 * 裁决 → CLI 校验后落地。
 *
 * 删除比分类狠，所以比 applyExternalAssignment 多两条护栏：
 *
 *   1. **回填必须带理由**。自然语言的判断依据无法从结果反推 —— 不记下来，
 *      一个月后看备份文件只剩一堆 id，完全不知道当初为什么删。理由会写进备份。
 *   2. **protected 是数据结构层的硬护栏，不是提示词**。受保护对象在候选清单里
 *      就标出来，回填若选中它们一律拒收并计数。靠结构挡，不靠模型自觉。
 *
 * 另外：选择器**永远不直接执行**。它只产出候选集，仍然要过 --yes 闸门、
 * 干跑预览和备份。「AI 已经判断过了」恰恰是更该留闸门的理由，不是放宽的理由。
 */
import { writeFileSync } from 'node:fs';

export const SELECTION_VERSION = 1;

/**
 * 生成候选清单。
 * @param {object} o
 *   kind        动作类型，如 'unfollow' / 'fav-remove'
 *   candidates  [{id, ...证据字段}]
 *   idOf        取 id 的函数
 *   protectedIds Set<string> 受保护对象
 *   query       原始自然语言（若有），作为审计链起点
 *   maxSelect   单次最多选中多少
 */
export function buildSelection({ kind, candidates, idOf = (x) => x.id, protectedIds = new Set(), query = null, maxSelect = null, note = '' }) {
  return {
    v: SELECTION_VERSION,
    kind,
    createdAt: new Date().toISOString(),
    query,
    instruction: `从 candidates 里挑出要「${kind}」的对象，输出 {"selected": {"<id>": "<理由>"}}。`
      + '理由必填且会被记入备份，用于事后审计。'
      + '标了 protected:true 的对象一律不要选 —— 选了会被整份拒收。'
      + (note ? ' ' + note : ''),
    constraints: {
      maxSelect,
      protectedCount: protectedIds.size,
      reasonRequired: true,
    },
    candidates: candidates.map((c) => ({
      ...c,
      id: String(idOf(c)),
      protected: protectedIds.has(String(idOf(c))),
    })),
  };
}

export function writeSelection(path, selection) {
  writeFileSync(path, JSON.stringify(selection, null, 2));
  return path;
}

/**
 * 校验并采纳回填。
 * @returns {{selected: Array, reasons: Map, rejected: Array, missing: number, fatal: string|null}}
 */
export function applySelection(candidates, raw, { idOf = (x) => x.id, protectedIds = new Set(), maxSelect = null, allowProtected = false } = {}) {
  const map = normalize(raw);
  const byId = new Map(candidates.map((c) => [String(idOf(c)), c]));

  const selected = [];
  const reasons = new Map();
  const rejected = [];

  for (const [id, reason] of map) {
    const hit = byId.get(id);
    if (!hit) {
      rejected.push({ id, code: 'NOT_IN_CANDIDATES', message: '不在候选清单里' });
      continue;
    }
    if (protectedIds.has(id) && !allowProtected) {
      rejected.push({ id, code: 'PROTECTED', message: '受保护对象（如特别关注），需要 --allow-protected 才能动' });
      continue;
    }
    const r = String(reason ?? '').trim();
    if (!r) {
      rejected.push({ id, code: 'NO_REASON', message: '没给理由。删除类操作的理由必填，会写进备份' });
      continue;
    }
    selected.push(hit);
    reasons.set(id, r);
  }

  // 超上限就整份拒绝，不截断 —— 截断会让调用方以为全做了
  const fatal = (maxSelect != null && selected.length > maxSelect)
    ? `选中了 ${selected.length} 个，超过 --max-select ${maxSelect}。整份回填已拒绝，请收窄选择或调高上限。`
    : null;

  return { selected, reasons, rejected, missing: candidates.length - selected.length, fatal };
}

function normalize(raw) {
  const out = new Map();
  if (!raw) return out;
  const src = raw.selected ?? raw;
  if (Array.isArray(src)) {
    for (const r of src) {
      if (r && r.id != null) out.set(String(r.id), r.reason ?? r.why ?? '');
    }
    return out;
  }
  if (typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) out.set(String(k), typeof v === 'string' ? v : (v?.reason ?? ''));
  }
  return out;
}
