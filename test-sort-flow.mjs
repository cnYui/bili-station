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
const { Job, buildFavOps, buildMergeOps, buildReorderOps, buildPrivacyOps } = await import('./src/executor.mjs');
const { orderItems } = await import('./src/order.mjs');
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

// ---------- 夹内重排 ----------
section('夹内重排');

/**
 * 比上面那个 FakeBili 严格的假后端：它真的模拟 B 站三条实测行为 ——
 *   1. move 进另一个夹会把 fav_time 重写成操作时间，**同一批共用一个时间戳**
 *   2. 列表按 fav_time 降序返回
 *   3. 时间戳相同时，**批内显示次序 = 提交次序的逆序**（受控实验结论，见 order.mjs）
 * 第 3 条最容易漏掉。漏了就会以为精度只到批粒度，从而写出过度保守的实现。
 */
class FakeFavStore {
  constructor() { this.clock = 10_000; this.f = new Map(); this.calls = []; }
  seed(id, items) { this.f.set(id, items.map((x, i) => ({ ...x, seq: i }))); }
  display(id) { return [...(this.f.get(id) ?? [])].sort((a, b) => b.favTime - a.favTime || a.seq - b.seq); }
  async favFolders() {
    return [...this.f.keys()].map((id) => ({ id, title: 'f' + id, count: this.f.get(id).length, attr: 23 }));
  }
  async moveResources(src, tar, res) {
    this.calls.push({ src, tar, n: res.length });
    const ids = new Set(res.map((r) => String(r).split(':')[0]));
    const from = this.f.get(src) ?? [];
    this.f.set(src, from.filter((x) => !ids.has(String(x.id))));
    const t = ++this.clock;   // 同批一个时间戳
    const go = from.filter((x) => ids.has(String(x.id)));
    const to = this.f.get(tar) ?? [];
    // 批内也是「先提交的排后面」，所以 seq 按提交次序递减
    this.f.set(tar, [...to, ...go.map((x, i) => ({ ...x, favTime: t, seq: go.length - i }))]);
    return { code: 0, data: {} };
  }
}

/** 造一个「被搬运过」的夹：真实收藏时间递增，但账号上的当前 fav_time 是反的 */
const strandedItems = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, type: 2, title: 't' + (i + 1),
  trueFav: 1000 + i,   // 真实收藏时间，越大越新
  favTime: 9000 - i,   // 账号上的当前值：被搬运重写过，次序是反的
}));

{
  const N = 45;
  const items = strandedItems(N);
  const fake = new FakeFavStore();
  fake.seed(201, items);
  fake.seed(202, []);   // 中转夹

  eq('重排前最上面的是收藏时间最旧的那条（就是用户遇到的状态）', fake.display(201)[0].id, 1);

  // 回灌真实收藏时间后再算提交顺序
  const ordered = orderItems(items.map((x) => ({ ...x, favTime: x.trueFav })), 'original');
  const ops = buildReorderOps(fake, [{ id: 201, title: 'f201', out: ordered, ordered }], { id: 202 }, { chunkSize: 20 });

  eq('45 条 → 搬出 3 批 + 搬回 3 批', ops.length, 6);
  ok('前一半是搬出', ops.slice(0, 3).every((o) => o.key.startsWith('ro-out:')));
  ok('后一半是搬回', ops.slice(3).every((o) => o.key.startsWith('ro-in:')));
  ok('全部按 favMove 计权', ops.every((o) => o.op === 'favMove'));

  resetResume();
  const snap = await new Job('r1', 'reorder', { dryRun: false, riskOpts: fastRisk, resumeKey: 'selftest-reorder' }).run(ops);

  eq('无失败', snap.counters.failed, 0);
  const after = fake.display(201);
  eq('条目一条不少', after.length, N);
  eq('中转夹已清空', fake.f.get(202).length, 0);
  eq('重排后最上面的是收藏时间最新的那条', after[0].id, N);
  eq('重排后最下面的是收藏时间最旧的那条', after[after.length - 1].id, 1);
  // 批内也遵循同一条规律，所以精度到逐条：整份次序必须严格等于收藏时间降序
  eq('整份次序严格等于真实收藏时间降序', after.map((x) => x.id),
    Array.from({ length: N }, (_, i) => N - i));

  const blocks = [];
  for (const it of after) {
    const last = blocks[blocks.length - 1];
    if (last && last.t === it.favTime) last.ids.push(it.id); else blocks.push({ t: it.favTime, ids: [it.id] });
  }
  eq('仍然是 3 个时间戳块（同批共用时间戳这点没变）', blocks.length, 3);
  ok('块与块之间严格递减', blocks.every((b, i) => i === 0 || Math.max(...b.ids) < Math.min(...blocks[i - 1].ids)));

  eq('搬运调用数 = 3 出 + 3 回', fake.calls.length, 6);
  ok('搬出都是 201→202', fake.calls.slice(0, 3).every((c) => c.src === 201 && c.tar === 202));
  ok('搬回都是 202→201', fake.calls.slice(3).every((c) => c.src === 202 && c.tar === 201));
}

{
  // chunk-size 1：每条独占一个时间戳，次序精确到条（代价是 20 倍调用次数）
  const N = 8;
  const items = strandedItems(N);
  const fake = new FakeFavStore();
  fake.seed(301, items);
  fake.seed(302, []);
  const ordered = orderItems(items.map((x) => ({ ...x, favTime: x.trueFav })), 'original');
  const ops = buildReorderOps(fake, [{ id: 301, title: 'f301', out: ordered, ordered }], { id: 302 }, { chunkSize: 1 });

  resetResume();
  await new Job('r2', 'reorder', { dryRun: false, riskOpts: fastRisk, resumeKey: 'selftest-reorder' }).run(ops);

  eq('chunkSize=1 时调用数是 2n', ops.length, N * 2);
  eq('次序精确到每一条', fake.display(301).map((x) => x.id), [8, 7, 6, 5, 4, 3, 2, 1]);
}

{
  // 混类型：番剧（type=24）和普通视频（type=2）绝不能落在同一批 ——
  // fav_time 并列时 B 站会把番剧排到普通视频前面，同批混装就会错位。
  const items = [
    ...strandedItems(25),
    { id: 900, type: 24, title: '番剧A', trueFav: 1012, favTime: 8000 },
    { id: 901, type: 24, title: '番剧B', trueFav: 1018, favTime: 8001 },
  ];
  const ordered = orderItems(items.map((x) => ({ ...x, favTime: x.trueFav })), 'original');
  const ops = buildReorderOps({}, [{ id: 501, title: 'f501', out: ordered, ordered }], { id: 502 }, { chunkSize: 20 });
  const back = ops.filter((o) => o.key.startsWith('ro-in:'));

  const idsOf = (o) => o.key.split(':').pop().split('_');
  const typeOf = new Map(items.map((x) => [String(x.id), x.type]));
  ok('每个搬回批次只含一种类型', back.every((o) => new Set(idsOf(o).map((id) => typeOf.get(id))).size === 1));
  ok('类型交错处断开，所以批数多于 ⌈27/20⌉', back.length > Math.ceil(27 / 20));
  eq('搬回覆盖的条目数仍是全部', back.reduce((n, o) => n + idsOf(o).length, 0), 27);
  // 搬出不影响次序，不必按类型切
  eq('搬出仍按 20 整批切', ops.filter((o) => o.key.startsWith('ro-out:')).length, 2);
}

{
  // 断点 key 必须区分「同一计划的续跑」和「另起的新计划」。
  // 少了这一层，上一轮跑完的 key 会被新计划原样撞上，搬出被当成做过而跳过 ——
  // 条目没进中转夹，搬回全部搬空。这是实际踩过的坑。
  const items = strandedItems(25);
  const mk = (planId) => buildReorderOps({}, [{ id: 601, title: 'f601', out: items, ordered: items }],
    { id: 602 }, { chunkSize: 20, planId });

  const a = mk('2026-09-21T14:05:36Z');
  const b2 = mk('2026-09-21T23:22:41Z');
  eq('两份计划的 op 数量相同', a.length, b2.length);
  ok('但没有任何一个 key 相同 —— 新计划不会被旧断点误跳',
    a.every((o) => !b2.some((x) => x.key === o.key)));
  ok('同一个 planId 重建出的 key 完全一致 —— 续跑仍能正确跳过',
    mk('2026-09-21T14:05:36Z').every((o, i) => o.key === a[i].key));
  ok('不给 planId 时 key 仍然可用（向后兼容）', mk('').every((o) => o.key.includes('601')));
}

{
  // 多个夹：每个夹必须自己搬出、自己搬回，绝不能把内容串到别的夹里
  const fake = new FakeFavStore();
  fake.seed(401, strandedItems(5));
  fake.seed(402, strandedItems(3).map((x) => ({ ...x, id: x.id + 100 })));
  fake.seed(403, []);
  const jobs = [401, 402].map((id) => {
    const src = fake.display(id);
    const ordered = orderItems(src.map((x) => ({ ...x, favTime: x.trueFav })), 'original');
    return { id, title: 'f' + id, out: ordered, ordered };
  });
  const ops = buildReorderOps(fake, jobs, { id: 403 }, { chunkSize: 20 });

  resetResume();
  await new Job('r3', 'reorder', { dryRun: false, riskOpts: fastRisk, resumeKey: 'selftest-reorder' }).run(ops);

  eq('401 条数不变', fake.display(401).length, 5);
  eq('402 条数不变', fake.display(402).length, 3);
  eq('中转夹清空', fake.f.get(403).length, 0);
  ok('401 里没有混进 402 的条目', fake.display(401).every((x) => x.id <= 100));
  ok('402 里没有混进 401 的条目', fake.display(402).every((x) => x.id > 100));
  eq('401 顶部是它自己收藏时间最新的', fake.display(401)[0].id, 5);
  eq('402 顶部是它自己收藏时间最新的', fake.display(402)[0].id, 103);
}

// ---------- 收藏夹隐私 ----------
section('收藏夹隐私');
{
  class FakePrivacyBili {
    constructor() { this.infos = new Map(); this.infoCalls = []; this.edits = []; }
    async folderInfo(id) { this.infoCalls.push(id); return this.infos.get(id) ?? null; }
    async editFolder(id, body) { this.edits.push({ id, ...body }); return { code: 0 }; }
  }
  const b = new FakePrivacyBili();
  b.infos.set(1, { id: 1, title: '已公开的夹', intro: '简介A', attr: 22 });
  b.infos.set(2, { id: 2, title: '私密夹', intro: '简介B', attr: 23 });
  b.infos.set(3, { id: 3, title: '带额外位的私密夹', intro: '简介C', attr: 55 });
  // 4 号故意读不到详情

  const targets = [1, 2, 3, 4].map((id) => ({ id, title: 'f' + id }));
  const ops = buildPrivacyOps(b, targets, 0);
  ok('隐私修改按 folderAdd 计权（夹级写操作最敏感的那档）', ops.every((o) => o.op === 'folderAdd'));

  const r1 = await ops[0].run();
  ok('已经是公开的夹直接跳过', r1?._already === true);
  eq('跳过时不发编辑请求', b.edits.length, 0);

  await ops[1].run();
  eq('需要改的夹发了编辑请求', b.edits.length, 1);
  eq('title 原样回传', b.edits[0].title, '私密夹');
  eq('intro 原样回传（缺它 B 站会把简介清空）', b.edits[0].intro, '简介B');
  eq('privacy 设为 0', b.edits[0].privacy, 0);

  await ops[2].run();
  eq('attr=55 带额外位的也认得出要改', b.edits.length, 2);
  eq('改的是 3 号', b.edits[1].id, 3);

  const r4 = await ops[3].run();
  ok('读不到详情时返回非 0', r4?.code !== 0);
  eq('读不到详情时绝不发编辑请求 —— 宁可不改，也不拿空 intro 覆盖简介', b.edits.length, 2);

  const back = buildPrivacyOps(b, [{ id: 2, title: 'f2' }], 1);
  ok('改回私密时 key 与改公开的不同，断点不会互相误跳', back[0].key !== ops[1].key);
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
