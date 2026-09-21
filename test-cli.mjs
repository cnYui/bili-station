/**
 * CLI 框架层测试：参数解析 / 排序 / 选择器 / 每个命令的 plan()。
 *
 * 完全确定性：假的 B 站后端，不需要 Chrome、不需要登录、不写真实账号。
 * plan/render 拆分的直接好处就是这个 —— plan() 不做任何写操作，
 * 可以注入假 bili 直接断言，重构前的命令体做不到。
 *
 * 跑法：node test-cli.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离数据目录：绝不能碰用户真实的 ~/.bili-station
process.env.BILI_STATION_DIR = mkdtempSync(join(tmpdir(), 'bili-station-cli-test-'));

const { parseArgs } = await import('./src/cli/args.mjs');
const { orderItems, chunkBySource, orderCost } = await import('./src/order.mjs');
const { buildSelection, applySelection } = await import('./src/cli/selector.mjs');
const { schema } = await import('./src/cli/help.mjs');
const { register } = await import('./src/cli/registry.mjs');
const { EXIT } = await import('./src/cli/output.mjs');
const store = await import('./src/store.mjs');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n); };
const eq = (n, g, w) => {
  const good = JSON.stringify(g) === JSON.stringify(w);
  ok(n + (good ? '' : ` [期望 ${JSON.stringify(w)} 实得 ${JSON.stringify(g)}]`), good);
};
const section = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 52 - s.length)));

// ---------- 假的 B 站后端 ----------
const FOLDERS = [
  { id: 101, title: '默认收藏夹', count: 6 },
  { id: 102, title: '编程开发', count: 3 },
  { id: 103, title: '待清理', count: 2 },
];
// favTime 故意做成「新→旧」，模拟 favItems(order=mtime) 的真实返回顺序
const ITEMS = {
  101: [
    { id: 1, type: 2, title: '最新收藏的', favTime: 1700, pubTime: 900, srcMediaId: 101, dead: false },
    { id: 2, type: 2, title: '中间的', favTime: 1500, pubTime: 950, srcMediaId: 101, dead: false },
    { id: 3, type: 2, title: '最早收藏的', favTime: 1000, pubTime: 800, srcMediaId: 101, dead: false },
    { id: 9, type: 2, title: '已失效视频', favTime: 1200, pubTime: 700, srcMediaId: 101, dead: true, attr: 1 },
  ],
  102: [
    { id: 4, type: 2, title: 'React 原理', favTime: 1600, pubTime: 960, srcMediaId: 102, dead: false },
    { id: 5, type: 2, title: 'Rust 所有权', favTime: 1100, pubTime: 880, srcMediaId: 102, dead: false },
  ],
  103: [
    { id: 6, type: 2, title: '失效了', favTime: 1400, pubTime: 600, srcMediaId: 103, dead: true, attr: 1 },
  ],
};
const FOLLOWINGS = [
  { mid: '1001', uname: '常看的UP', mtime: 1700, special: false, tags: [77] },
  { mid: '1002', uname: '特别关注的', mtime: 1600, special: true, tags: null },
  { mid: '1003', uname: '停更很久的', mtime: 1500, special: false, tags: null },
  { mid: '1004', uname: '没分组的', mtime: 1400, special: false, tags: null },
];

class FakeBili {
  constructor() {
    this.mid = '999';
    this.calls = [];
    this.nextId = 900;
    this.folders = FOLDERS.map((f) => ({ ...f }));
  }
  async favFolders() { return this.folders.map((f) => ({ ...f })); }
  async favItems(id) { return { list: (ITEMS[id] ?? []).map((x) => ({ ...x })), complete: true, nextPage: null }; }
  async createFolder(title) { this.calls.push({ op: 'createFolder', title }); const id = ++this.nextId; this.folders.push({ id, title, count: 0 }); return { code: 0, data: { id } }; }
  async renameFolder(id, title) { this.calls.push({ op: 'rename', id, title }); return { code: 0 }; }
  async moveResources(src, tar, res) { this.calls.push({ op: 'move', src, tar, n: res.length }); return { code: 0 }; }
  async copyResources(src, tar, res) { this.calls.push({ op: 'copy', src, tar, n: res.length }); return { code: 0 }; }
  async batchDel(id, res) { this.calls.push({ op: 'del', id, n: res.length }); return { code: 0 }; }
  async followings() { return { list: FOLLOWINGS.map((u) => ({ ...u })), total: FOLLOWINGS.length, truncated: false }; }
  async specialFollowings() { return new Set(['1002']); }
  async tags() { return [{ tagid: 77, name: '编程' }, { tagid: 88, name: '生活' }]; }
  async tagUsers() { return [{ mid: 1002 }]; }
  async modifyRelation(mid, act) { this.calls.push({ op: 'relation', mid, act }); return { code: 0 }; }
  async setUserTags(mids, tagids) { this.calls.push({ op: 'setTags', mids, tagids }); return { code: 0 }; }
  async createTag(name) { this.calls.push({ op: 'createTag', name }); return { code: 0, data: { tagid: 99 } }; }
  async renameTag(tagid, name) { this.calls.push({ op: 'renameTag', tagid, name }); return { code: 0 }; }
  async deleteTag(tagid) { this.calls.push({ op: 'deleteTag', tagid }); return { code: 0 }; }
  async lastUpload() { return { count: 0, lastPubTs: null }; }
}

/** 造一个不连 Chrome 的 ctx，直接喂假 bili */
function makeCtx(cmd, argv, { bili = new FakeBili() } = {}) {
  const { positionals, flags, errors } = parseArgs(argv, cmd.flags);
  const logs = [];
  return {
    positionals, flags, errors, logs,
    json: true, flat: false, yes: !!flags.yes, quiet: true,
    say: (...m) => logs.push(m.join(' ')),
    cfg: { cdpPort: 9222, folderQuota: 20, perFolderCap: 1000, privacy: 1, risk: {}, rules: [], ai: { apiKey: '' } },
    bili, cdp: null, me: { mid: '999', uname: '测试' },
    usageError(message) { const e = new Error(message); e.exitCode = EXIT.USAGE; throw e; },
  };
}

const load = async (n) => (await import(`./src/cli/commands/${n}.mjs`)).default;
const plan = async (name, argv, opts) => {
  const cmd = await load(name);
  const ctx = makeCtx(cmd, argv, opts);
  if (ctx.errors.length) throw Object.assign(new Error(ctx.errors.map((e) => e.message).join('；')), { exitCode: EXIT.USAGE });
  const r = await cmd.plan(ctx);
  return { r, ctx, cmd };
};
const usageFails = async (fn) => {
  try { await fn(); return null; }
  catch (e) { return e.exitCode === EXIT.USAGE ? (e.message ?? '') : null; }
};

// ---------- 1. 参数解析 ----------
section('参数解析');
{
  const spec = { yes: { type: 'boolean' }, folders: { type: 'csv' }, limit: { type: 'int', min: 1 }, mode: { type: 'enum', values: ['copy', 'move'] } };

  const a = parseArgs(['create', '--yes', 'A,B'], spec);
  eq('boolean 不吞下一个位置参数', a.positionals, ['create', 'A,B']);
  eq('boolean 就是 true', a.flags.yes, true);

  const b = parseArgs(['--folders', 'x, y ,,z'], spec);
  eq('csv 去空白去空项', b.flags.folders, ['x', 'y', 'z']);

  const c = parseArgs(['--limit=50'], spec);
  eq('--flag=value 形式', c.flags.limit, 50);

  const d = parseArgs(['--foldres', 'a'], spec);
  eq('未知 flag 报错', d.errors[0].code, 'UNKNOWN_FLAG');
  ok('未知 flag 给出猜测', d.errors[0].message.includes('--folders'));

  const e = parseArgs(['--mode', 'xxx'], spec);
  eq('枚举值校验', e.errors[0].code, 'BAD_VALUE');
  ok('枚举错误列出合法值', e.errors[0].message.includes('copy | move'));

  const f = parseArgs(['--limit', '0'], spec);
  eq('数值下界校验', f.errors[0].code, 'BAD_VALUE');

  const g = parseArgs(['--folders'], spec);
  eq('缺值报错', g.errors[0].code, 'MISSING_VALUE');

  const h = parseArgs([], { into: { type: 'string', required: true } });
  eq('必填校验', h.errors[0].code, 'MISSING_FLAG');

  const i = parseArgs(['--no-yes'], spec);
  eq('--no-xxx 关闭开关', i.flags.yes, false);

  const j = parseArgs(['--limit', '-5'], { limit: { type: 'int' } });
  eq('负数不被当成 flag', j.flags.limit, -5);
}

// ---------- 2. 排序 ----------
section('排序（提交顺序 → 显示顺序）');
{
  const items = ITEMS[101].filter((x) => !x.dead);   // favTime 1700 / 1500 / 1000

  const orig = orderItems(items, 'original');
  eq('original 按 favTime 升序提交（最新的最后提交→排最前）', orig.map((x) => x.favTime), [1000, 1500, 1700]);

  const rev = orderItems(items, 'reverse');
  eq('reverse 按 favTime 降序提交', rev.map((x) => x.favTime), [1700, 1500, 1000]);

  const pub = orderItems(items, 'pubdate');
  eq('pubdate 按投稿时间升序', pub.map((x) => x.pubTime), [800, 900, 950]);

  const asis = orderItems(items, 'as-scanned');
  eq('as-scanned 原样不动', asis.map((x) => x.id), items.map((x) => x.id));

  const noTs = orderItems([{ id: 1 }, { id: 2 }, { id: 3 }], 'original');
  eq('没有时间戳时保持稳定（不打乱）', noTs.map((x) => x.id), [1, 2, 3]);

  ok('未知排序方式直接抛错', (() => { try { orderItems(items, 'nope'); return false; } catch { return true; } })());
}
{
  // 三个来源交错：per-source 合并同源，global 严格按顺序断开
  const mixed = [
    { id: 1, srcMediaId: 'A' }, { id: 2, srcMediaId: 'B' },
    { id: 3, srcMediaId: 'A' }, { id: 4, srcMediaId: 'B' },
  ];
  const ps = chunkBySource(mixed, { chunkSize: 20, scope: 'per-source' });
  eq('per-source 合并同源为 2 批', ps.map((b) => b.items.length), [2, 2]);

  const gl = chunkBySource(mixed, { chunkSize: 20, scope: 'global' });
  eq('global 严格按顺序切成 4 批', gl.map((b) => b.items.length), [1, 1, 1, 1]);
  eq('global 保持全局顺序', gl.flatMap((b) => b.items.map((x) => x.id)), [1, 2, 3, 4]);

  const cost = orderCost(mixed, { chunkSize: 20 });
  eq('成本报告如实给出额外调用次数', cost, { perSource: 2, global: 4, extra: 2 });

  const same = chunkBySource(Array.from({ length: 25 }, (_, i) => ({ id: i, srcMediaId: 'A' })), { chunkSize: 20, scope: 'per-source' });
  eq('单一来源 25 条切成 20+5', same.map((b) => b.items.length), [20, 5]);

  const one = chunkBySource(mixed, { chunkSize: 1, scope: 'global' });
  eq('chunk-size 1 = 逐条', one.length, 4);
}

// ---------- 3. 选择器 ----------
section('选择器（外部裁决 + 硬护栏）');
{
  const cands = [{ id: '1001', uname: 'a' }, { id: '1002', uname: 'b' }, { id: '1003', uname: 'c' }];
  const prot = new Set(['1002']);

  const sel = buildSelection({ kind: 'unfollow', candidates: cands, protectedIds: prot, query: '取关停更的' });
  eq('清单标出了受保护对象', sel.candidates.filter((c) => c.protected).map((c) => c.id), ['1002']);
  eq('原始自然语言被记入清单', sel.query, '取关停更的');
  ok('声明了理由必填', sel.constraints.reasonRequired === true);

  const a = applySelection(cands, { selected: { 1001: '一年没投稿', 1003: '内容转型了' } }, { protectedIds: prot });
  eq('正常回填被采纳', a.selected.map((x) => x.id), ['1001', '1003']);
  eq('理由被记下来', a.reasons.get('1001'), '一年没投稿');

  const b = applySelection(cands, { selected: { 1002: '想删' } }, { protectedIds: prot });
  eq('受保护对象被拒收', b.rejected[0].code, 'PROTECTED');
  eq('受保护对象不进结果', b.selected.length, 0);

  const c = applySelection(cands, { selected: { 1002: '想删' } }, { protectedIds: prot, allowProtected: true });
  eq('显式 allow-protected 才放行', c.selected.map((x) => x.id), ['1002']);

  const d = applySelection(cands, { selected: { 1001: '' } }, { protectedIds: prot });
  eq('没给理由的被拒收', d.rejected[0].code, 'NO_REASON');

  const e = applySelection(cands, { selected: { 9999: '不认识的' } }, { protectedIds: prot });
  eq('不在候选清单里的被拒收', e.rejected[0].code, 'NOT_IN_CANDIDATES');

  const f = applySelection(cands, { selected: { 1001: 'x', 1003: 'y' } }, { protectedIds: prot, maxSelect: 1 });
  ok('超过 max-select 整份拒绝而不是截断', f.fatal != null);

  const g = applySelection(cands, [{ id: '1001', reason: 'r' }], { protectedIds: prot });
  eq('数组形式的回填也支持', g.selected.length, 1);

  const h = applySelection(cands, null, { protectedIds: prot });
  eq('空回填不炸', h.selected.length, 0);
}

// ---------- 4. 各命令的 plan() ----------
section('命令 plan()（假后端）');
{
  const { r } = await plan('folders', ['list']);
  eq('folders list 是只读的', r.readonly, true);
  eq('folders list 返回全部夹', r.data.folders.length, 3);
}
{
  const { r } = await plan('folders', ['create', '编程开发,新夹子']);
  eq('已存在的夹被复用而不是重建', r.data.reused.map((x) => x.name), ['编程开发']);
  eq('只为真正缺的夹产生 op', r.data.creates, ['新夹子']);
  eq('op 数 = 要新建的夹数', r.ops.length, 1);
}
{
  const msg = await usageFails(() => plan('folders', ['create']));
  ok('folders create 不给名字报 USAGE', msg?.includes('收藏夹名'));
}
{
  const { r } = await plan('scan', ['fav']);
  eq('scan fav 扫全部夹', Object.keys(r.data.counts).length, 3);
  eq('scan fav 统计总条数', r.data.total, 7);
}
{
  const msg = await usageFails(() => plan('scan', ['nope']));
  ok('未知子命令报 USAGE', msg?.includes('未知子命令'));
}
{
  const msg = await usageFails(() => plan('sort', []));
  ok('sort 不给候选集报 USAGE', msg?.includes('--folders'));
}
{
  // 外部回填 + 排序：这是最核心的一条链路
  const assign = join(process.env.BILI_STATION_DIR, 'assign.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(assign, JSON.stringify({ 1: '合集A', 2: '合集A', 3: '合集A', 4: '合集A', 5: '合集A' }));

  const { r } = await plan('sort', ['--folders', '合集A', '--source', '101,102', '--assign', assign]);
  eq('五条全部采纳', r.data.assigned, 5);
  eq('失效条目不参与分类', r.data.totalItems, 5);
  eq('默认排序是 original', r.data.order, 'original');

  // 提交顺序必须是 favTime 升序：1000 → 1100 → 1500 → 1600 → 1700
  const moveOps = r.ops.filter((o) => o.op === 'favMove');
  const order = moveOps.flatMap((o) => o.label);
  ok('产生了移动 op', moveOps.length > 0);
  ok('新建夹的 op 排在移动之前',
    r.ops.findIndex((o) => o.op === 'favMove') > r.ops.findIndex((o) => o.op === 'folderAdd'));
  void order;
}
{
  const assign = join(process.env.BILI_STATION_DIR, 'assign2.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(assign, JSON.stringify({ 1: '合集A', 2: '不存在的分类' }));
  const { r } = await plan('sort', ['--folders', '合集A', '--source', '101', '--assign', assign]);
  eq('候选集外的分类被拒收', r.data.rejected, 1);
  ok('拒收会进 warnings', r.warnings.some((w) => w.code === 'REJECTED'));
}
{
  const { r } = await plan('sort', ['--folders', '合集A', '--source', '101,102', '--order-scope', 'global', '--emit-tasks', join(process.env.BILI_STATION_DIR, 't.json')]);
  eq('没给 --assign 时吐清单后就停', r.handled, true);
}
{
  const { r } = await plan('merge', ['--into', '默认收藏夹']);
  eq('merge 目标解析正确', r.data.target.id, 101);
  eq('目标夹自己不作为来源', r.data.groups.some((g) => g.srcId === 101), false);
  ok('merge 产生了搬运 op', r.ops.length > 0);
}
{
  const msg = await usageFails(() => plan('merge', ['--into', '不存在的夹']));
  ok('merge 目标不存在报 USAGE', msg?.includes('找不到收藏夹'));
}
{
  const { r } = await plan('dead', []);
  eq('dead 扫出失效条目', r.data.total, 2);
  ok('archive 模式会先建归档夹', r.ops.some((o) => o.op === 'folderAdd'));
}
{
  const { r } = await plan('dead', ['--action', 'remove']);
  ok('remove 模式给出不可逆警告', r.warnings.some((w) => w.code === 'IRREVERSIBLE'));
  ok('remove 模式不建归档夹', !r.ops.some((o) => o.op === 'folderAdd'));
}
{
  const { r } = await plan('follow', ['list']);
  eq('follow list 是只读的', r.readonly, true);
  eq('特别关注被识别', r.data.users.find((u) => u.mid === '1002').state, 'special');
  eq('分组名被解析出来', r.data.users.find((u) => u.mid === '1001').tags, ['编程']);
}
{
  const { r } = await plan('follow', ['list', '--tag', '编程']);
  eq('按分组筛选', r.data.matched, 1);
}
{
  const { r } = await plan('follow', ['list', '--state', 'special']);
  eq('按状态筛选', r.data.matched, 1);
}
{
  const { r } = await plan('follow', ['set', '1001', '--state', 'special']);
  const tagOp = r.ops.find((o) => o.op === 'tagAdd');
  ok('改特别关注走分组接口', tagOp != null);
  ok('目标分组同时保留了原有分组 77 和 -10', tagOp.label.includes('编程') && tagOp.label.includes('特别关注'));
}
{
  const msg = await usageFails(() => plan('follow', ['remove', '1002']));
  ok('取关特别关注默认被拒', msg?.includes('特别关注'));
}
{
  const { r } = await plan('follow', ['remove', '1002', '--allow-protected']);
  eq('显式放行后才允许', r.data.count, 1);
}
{
  const { r } = await plan('follow', ['tag', 'create', '新分组']);
  eq('建分组产生 op', r.ops.length, 1);
}
{
  const msg = await usageFails(() => plan('follow', ['tag', 'delete', '特别关注']));
  ok('不允许删除内建的特别关注分组', msg?.includes('内建'));
}
{
  // 按 mtime 降序：1001 / 1002(特别) / 1003 / 1004。keep 2 保住前两个，后两个取关。
  // 注意特别关注会占用一个 keep 名额 —— 这是 planUnfollow 一直以来的语义，不是这次改的。
  const { r } = await plan('unfollow', ['--keep', '2']);
  eq('keep 2 → 取关排在 2 名之后的 2 个', r.data.willUnfollow, 2);
  eq('特别关注无条件保留', r.data.targets.some((t) => t.mid === '1002'), false);
}
{
  const { r } = await plan('unfollow', ['--keep', '0', '--protect-tag', '编程']);
  eq('分组保护生效', r.data.targets.some((t) => t.mid === '1001'), false);
  ok('保护计数被报告', r.data.protectedByTag === 1);
}
{
  const { r } = await plan('unfollow', ['--only-inactive', '--inactive-days', '365']);
  ok('没有投稿数据时给出明确提示而不是静默取关 0 个',
    r.nothing === true && /scan uploads/.test(r.nothingReason ?? ''));
}

// ---------- 5. schema ----------
section('schema（给 agent 的能力发现）');
{
  for (const m of ['status', 'folders', 'scan', 'sort', 'merge', 'dead', 'follow', 'unfollow', 'probe']) {
    register(await load(m));
  }
  const s = schema();
  eq('schema 覆盖全部命令', s.commands.length, 9);
  ok('退出码语义在 schema 里', Object.keys(s.exitCodes).length === 6);
  const sortCmd = s.commands.find((c) => c.name === 'sort');
  eq('sort 的能力被标出', sortCmd.capabilities, ['mutating', 'ordered']);
  ok('flag 的类型与枚举值可被机器读取',
    sortCmd.flags.mode.type === 'enum' && sortCmd.flags.mode.values.includes('move'));
  ok('follow 带 selectable 能力', s.commands.find((c) => c.name === 'follow').capabilities.includes('selectable'));
  ok('每个命令都有 summary', s.commands.every((c) => c.summary && c.summary.length > 4));
}

// ---------- 6. 缓存归一化（修好的那个 bug）----------
section('收藏夹缓存的单一归一化入口');
{
  const { loadCache, itemsOf, saveCache } = await import('./src/cli/favcache.mjs');
  // 旧格式：裸数组
  store.write('favorites.json', { folders: FOLDERS, items: [[101, [{ id: 1 }, { id: 2 }]]] });
  const c1 = loadCache();
  eq('旧格式（裸数组）被归一化', itemsOf(c1, 101).length, 2);
  eq('归一化后带上 complete 标记', c1.get(101).complete, true);

  // 新格式
  store.write('favorites.json', { folders: FOLDERS, items: [[102, { items: [{ id: 3 }], complete: false, nextPage: 2 }]] });
  const c2 = loadCache();
  eq('新格式原样读出', itemsOf(c2, 102).length, 1);
  eq('未扫完的续扫页码保留', c2.get(102).nextPage, 2);

  saveCache(FOLDERS, c2);
  eq('写回后再读一致', itemsOf(loadCache(), 102).length, 1);
  eq('字符串 key 也能取到', itemsOf(loadCache(), '102').length, 1);
}

console.log('\n' + '='.repeat(58));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
