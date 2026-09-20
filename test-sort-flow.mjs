/**
 * 端到端链路测试：假的 B 站后端 + 模拟 agent 给出的分类。
 * 验证「先定候选夹 → 只在候选里选 → 建夹 → 回填 id → 移动」这条链路真的对。
 *
 * 完全确定性：不需要 Chrome、不需要登录、不需要任何 API key、不花钱。
 * 跑法：node test-sort-flow.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离数据目录：测试绝不能碰用户真实的 ~/.bili-station。
// 必须在导入 store 之前设好，所以下面用动态 import。
process.env.BILI_STATION_DIR = mkdtempSync(join(tmpdir(), 'bili-station-test-'));

const { planFavClassify, planMerge } = await import('./src/plan.mjs');
const { Job, buildFavOps, buildMergeOps } = await import('./src/executor.mjs');
const { buildTasks, applyExternalAssignment } = await import('./src/classify/external.mjs');
const { write, DATA_DIR } = await import('./src/store.mjs');

console.log('测试数据目录（隔离）:', DATA_DIR);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n); };
const eq = (n, g, w) => {
  const good = JSON.stringify(g) === JSON.stringify(w);
  ok(n + (good ? '' : ` [期望 ${JSON.stringify(w)} 实得 ${JSON.stringify(g)}]`), good);
};
const section = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 50 - s.length)));

// ---------- 假的 B 站后端 ----------
class FakeBili {
  constructor(folders) {
    this.mid = '999';
    this.nextId = 900;
    this.folders = folders ?? [
      { id: 101, title: '默认收藏夹', count: 0 },
      { id: 102, title: '编程开发', count: 12 },   // 已存在 → 应复用而不是新建
    ];
    this.calls = [];
    this.moved = [];
  }
  async favFolders() { return this.folders.map((f) => ({ ...f })); }
  async createFolder(title, { privacy } = {}) {
    this.calls.push({ op: 'createFolder', title, privacy });
    const id = ++this.nextId;
    this.folders.push({ id, title, count: 0 });
    return { code: 0, data: { id } };
  }
  async copyResources(src, tar, res) {
    this.calls.push({ op: 'copy', src, tar, n: res.length });
    this.moved.push({ src, tar, res });
    return { code: 0, data: {} };
  }
  async moveResources(src, tar, res) {
    this.calls.push({ op: 'move', src, tar, n: res.length });
    this.moved.push({ src, tar, res });
    return { code: 0, data: {} };
  }
}

const ITEMS = [
  { id: 1, type: 2, title: 'Rust 所有权与借用彻底讲清楚', upper: '系统编程笔记', intro: '生命周期标注', srcMediaId: 101 },
  { id: 2, type: 2, title: '一个人露营装备全清单', upper: '野外老张', intro: '帐篷睡袋炉具', srcMediaId: 101 },
  { id: 3, type: 2, title: '空气炸锅做鸡翅 十分钟', upper: '懒人厨房', intro: '免油炸', srcMediaId: 101 },
  { id: 4, type: 2, title: 'React 18 并发渲染原理', upper: '前端小册', intro: 'Fiber 调度', srcMediaId: 102 },
  { id: 5, type: 2, title: '为什么天空是蓝的', upper: '科学声音', intro: '瑞利散射', srcMediaId: 102 },
  { id: 6, type: 2, title: '徒步穿越贡嘎全记录', upper: '野外老张', intro: '高原五日', srcMediaId: 101 },
];
const CANDIDATES = ['编程开发', '户外露营', '美食烹饪', '科普知识'];

// 模拟 agent 读完 tasks.json 后给出的分配
const AGENT_ANSWER = { 1: '编程开发', 2: '户外露营', 3: '美食烹饪', 4: '编程开发', 5: '科普知识', 6: '户外露营' };

const resetResume = () => {
  write('resume-selftest-fav.json', { done: {}, failed: {} });
  write('risk-history.json', { events: [] });   // 假操作不该计入风控热度
};

// ---------- 1. 待分类清单 ----------
section('给 agent 的待分类清单');
{
  const t = buildTasks(ITEMS, CANDIDATES);
  eq('清单条数与输入一致', t.items.length, ITEMS.length);
  eq('候选集原样带上', t.candidates, CANDIDATES);
  ok('每条都带 id / 标题 / UP', t.items.every((i) => i.id != null && i.title && i.up));
  ok('带了给模型的指令', typeof t.instruction === 'string' && t.instruction.length > 10);
  const long = buildTasks([{ id: 1, title: 't', upper: 'u', intro: 'x'.repeat(500) }], CANDIDATES);
  eq('简介被截断', long.items[0].intro.length, 80);
}

// ---------- 2. 回填校验 ----------
section('外部分配的校验');
{
  const r = applyExternalAssignment(ITEMS, CANDIDATES, AGENT_ANSWER);
  eq('全部采纳', r.accepted, 6);
  eq('无拒收', r.rejected.length, 0);
  eq('无遗漏', r.missing, 0);
}
{
  // 关键：不在候选集里的分类必须被拒收，而不是静默塞进「待分类」或就近匹配
  const r = applyExternalAssignment(ITEMS, CANDIDATES, { ...AGENT_ANSWER, 3: '深夜放毒' });
  eq('候选集外的分类被拒收', r.rejected.length, 1);
  eq('拒收项记录了原始值', r.rejected[0].given, '深夜放毒');
  ok('被拒收的条目不出现在分配里', !r.assignment.has(3));
  eq('其余照常采纳', r.accepted, 5);
}
{
  const r = applyExternalAssignment(ITEMS, CANDIDATES, { ...AGENT_ANSWER, 2: '  户外露营  ', 5: '科普知识' });
  eq('首尾空格不影响匹配', r.accepted, 6);
  eq('写回的是候选集里的原始拼写', r.assignment.get(2), '户外露营');
}
{
  const r = applyExternalAssignment(ITEMS, ['Gaming', '编程开发'], { 1: '编程开发', 2: 'gaming' });
  eq('英文大小写不敏感', r.assignment.get(2), 'Gaming');
}
{
  const r = applyExternalAssignment(ITEMS, CANDIDATES, { 1: '编程开发' });
  eq('没给分配的条目算 missing', r.missing, 5);
  eq('只采纳给了的那条', r.accepted, 1);
}
{
  const r = applyExternalAssignment(ITEMS, CANDIDATES, [{ id: 1, category: '编程开发' }, { id: 2, category: '户外露营' }]);
  eq('数组形式的回填也支持', r.accepted, 2);
}
{
  const r = applyExternalAssignment(ITEMS, CANDIDATES, {});
  eq('空回填不炸', r.accepted, 0);
  const r2 = applyExternalAssignment(ITEMS, CANDIDATES, null);
  eq('null 回填不炸', r2.accepted, 0);
}

// ---------- 3. 计划 ----------
section('计划');
const bili = new FakeBili();
const folders = await bili.favFolders();
const { assignment } = applyExternalAssignment(ITEMS, CANDIDATES, AGENT_ANSWER);
const fav = planFavClassify(ITEMS, assignment, folders, { folderQuota: 20, perFolderCap: 1000, mode: 'copy' });
console.log(`  ${fav.totalItems} 条 → ${fav.categories} 类，新建 ${fav.newFolders}，复用 ${fav.reusedFolders}`);
for (const p of fav.plan) console.log(`    ${String(p.count).padStart(3)}  ${p.category}${p.isNew ? '（新建）' : '（复用 id ' + p.targetId + '）'}`);

const prog = fav.plan.find((p) => p.category === '编程开发');
ok('已存在的「编程开发」被复用而非新建', prog ? !prog.isNew && prog.targetId === 102 : false);
eq('新建 3 个', fav.newFolders, 3);
eq('无配额 / 容量警告', fav.warnings.length, 0);

// ---------- 4. 执行 ----------
section('执行（假后端，真执行器）');
resetResume();
const folderIds = new Map();
const ops = buildFavOps(bili, fav, folderIds, { mode: 'copy', privacy: 1 });
ok('建夹操作全部排在移动操作之前',
  ops.findIndex((o) => o.op === 'favMove') > ops.findLastIndex((o) => o.op === 'folderAdd'));
eq('建夹次数 = 计划里的新建数', ops.filter((o) => o.op === 'folderAdd').length, fav.newFolders);

const fastRisk = { minDelayMs: 1, maxDelayMs: 2, batchSize: 999, batchPauseMs: 1, hardCapPerRound: 999 };
const snap = await new Job('t1', 'fav', { dryRun: false, riskOpts: fastRisk, resumeKey: 'selftest-fav' }).run(ops);

eq('无失败', snap.counters.failed, 0);
eq('状态为 done', snap.status, 'done');
ok('建夹都带 privacy=1（私密）', bili.calls.filter((c) => c.op === 'createFolder').every((c) => c.privacy === 1));
ok('没有目标 id 为空的移动', bili.moved.every((m) => Number.isFinite(Number(m.tar))));

const newCats = fav.plan.filter((p) => p.isNew).map((p) => p.category);
const newIds = new Set(newCats.map((c) => folderIds.get(c)));
ok('新建夹的 id 已回填', newCats.every((c) => folderIds.get(c) != null));
ok('有内容进了新建的夹', bili.moved.some((m) => newIds.has(m.tar)));

const delivered = bili.moved.flatMap((m) => m.res.map((x) => x.split(':')[0]));
eq('投递条数 = 待分类条数', delivered.length, ITEMS.length);
eq('没有重复投递', new Set(delivered).size, delivered.length);
ok('每批移动的 src 与条目原属收藏夹一致',
  bili.moved.every((m) => ITEMS.filter((it) => m.res.includes(it.id + ':2')).every((it) => it.srcMediaId === m.src)));

// ---------- 5. 建夹幂等 ----------
section('建夹幂等（夹已存在时不重复建）');
{
  // 沿用上一轮之后的 bili（三个新夹此时已真实存在），清空断点重跑同一批 ops
  resetResume();
  const before = bili.calls.filter((c) => c.op === 'createFolder').length;
  const ids2 = new Map();
  const ops2 = buildFavOps(bili, fav, ids2, { mode: 'copy', privacy: 1 });
  await new Job('t2', 'fav', { dryRun: false, riskOpts: fastRisk, resumeKey: 'selftest-fav' }).run(ops2);
  const after = bili.calls.filter((c) => c.op === 'createFolder').length;

  eq('第二轮没有重复建夹', after - before, 0);
  ok('第二轮仍然拿到了这些夹的 id', newCats.every((c) => ids2.get(c) != null));
  eq('拿到的是第一轮建出来的同一批 id',
    newCats.map((c) => ids2.get(c)), newCats.map((c) => folderIds.get(c)));
  eq('收藏夹没有被建重复', new Set(bili.folders.map((f) => f.title)).size, bili.folders.length);
}

// ---------- 6. 干跑不落任何写 ----------
section('干跑');
{
  const b = new FakeBili();
  const f2 = planFavClassify(ITEMS, assignment, await b.favFolders(), { mode: 'copy' });
  const o2 = buildFavOps(b, f2, new Map(), { mode: 'copy', privacy: 1 });
  const s2 = await new Job('t3', 'fav', { dryRun: true, riskOpts: fastRisk, resumeKey: 'selftest-fav' }).run(o2);
  eq('干跑状态为 done', s2.status, 'done');
  eq('干跑没有发生任何后端调用', b.calls.length, 0);
}


// ---------- 7. 合并（把其他夹并入一个夹）----------
section('合并计划');
{
  const TARGET = { id: 101, title: '默认收藏夹', count: 4085 };
  const src = new Map([
    [101, [{ id: 90, type: 2, title: '目标夹自己的' }]],
    [201, [{ id: 1, type: 2, title: 'a' }, { id: 2, type: 2, title: 'b' }]],
    [202, [{ id: 3, type: 2, title: 'c', dead: true }, { id: 4, type: 2, title: 'd' }]],
    [203, [{ id: 2, type: 2, title: 'b 重复' }]],
    [204, []],
  ]);
  const p = planMerge(src, TARGET, { perFolderCap: 5000, titleOf: (id) => 'F' + id });

  eq('目标夹自己不作为来源', p.groups.some((g) => g.srcId === 101), false);
  eq('空夹不进计划', p.groups.some((g) => g.srcId === 204), false);
  eq('跨夹重复只算一次', p.duplicateInSources, 1);
  eq('搬运总数', p.total, 4);
  eq('失效条目计数', p.deadTotal, 1);
  eq('失效条目单独归在 dead 里', p.groups.find((g) => g.srcId === 202).dead.length, 1);
  ok('给出了失效条目的提示', p.warnings.some((w) => w.kind === 'dead-items'));
  ok('给出了跨夹重复的提示', p.warnings.some((w) => w.kind === 'duplicate'));
  eq('未超容量时无 folder-cap 警告', p.warnings.some((w) => w.kind === 'folder-cap'), false);
}
{
  const TARGET = { id: 101, title: '默认收藏夹', count: 4990 };
  const src = new Map([[201, Array.from({ length: 20 }, (_, i) => ({ id: i + 1, type: 2, title: 't' }))]]);
  const p = planMerge(src, TARGET, { perFolderCap: 5000 });
  ok('会超容量时给出 folder-cap 警告', p.warnings.some((w) => w.kind === 'folder-cap'));
}
{
  const TARGET = { id: 101, title: 'T', count: 0 };
  const src = new Map([[201, [{ id: 1, type: 2, dead: true }, { id: 2, type: 2 }]]]);
  const p = planMerge(src, TARGET, { includeDead: false });
  eq('skip-dead 时失效条目不搬', p.total, 1);
  eq('但仍然报告有多少失效', p.deadTotal, 1);
}

section('合并执行');
{
  const TARGET = { id: 101, title: '默认收藏夹', count: 100 };
  const b = new FakeBili([{ id: 101, title: '默认收藏夹', count: 100 }]);
  const src = new Map([
    [201, Array.from({ length: 25 }, (_, i) => ({ id: 1000 + i, type: 2, title: 'x' + i }))],
    [202, [{ id: 2001, type: 2, title: 'dead1', dead: true }, { id: 2002, type: 2, title: 'live1' }]],
  ]);
  const p = planMerge(src, TARGET, { titleOf: (id) => 'F' + id });
  const ops = buildMergeOps(b, p, { chunkSize: 20 });

  resetResume();
  const snap = await new Job('m1', 'merge', {
    dryRun: false, riskOpts: fastRisk, resumeKey: 'selftest-fav',
  }).run(ops);

  eq('无失败', snap.counters.failed, 0);
  eq('25 条按 20 一批切成 2 批', ops.filter((o) => o.key.startsWith('merge:201')).length, 2);
  ok('失效条目单独成批，不与正常条目混在一起',
    b.moved.every((m) => {
      const ids = m.res.map((x) => Number(x.split(':')[0]));
      return !ids.includes(2001) || ids.length === 1;
    }));
  ok('所有搬运的目标都是 101', b.moved.every((m) => m.tar === 101));
  ok('来源 id 正确', b.moved.every((m) => [201, 202].includes(m.src)));

  const delivered = b.moved.flatMap((m) => m.res.map((x) => x.split(':')[0]));
  eq('投递条数 = 计划总数', delivered.length, p.total);
  eq('没有重复投递', new Set(delivered).size, delivered.length);
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
