/** 纯逻辑自测：不需要 Chrome、不需要登录、不发任何网络请求。 */
import { planUnfollow, planFavClassify, planDeadCleanup, chunk, toResource } from './src/plan.mjs';
import { classifyAll, scoreItem, DEFAULT_RULES } from './src/classify/keyword.mjs';
import { extractJson } from './src/classify/ai.mjs';
import { RiskEngine, classifyResult, RISK_CODES, AUTH_CODES } from './src/risk.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : `\n         期望 ${JSON.stringify(want)}\n         实得 ${JSON.stringify(got)}`));
};
const ok = (name, cond) => eq(name, !!cond, true);
const section = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 52 - s.length)));

// ---------- plan.planUnfollow ----------
section('关注清理计划');
const mkUsers = (n, t0 = 1_700_000_000) =>
  Array.from({ length: n }, (_, i) => ({ mid: String(1000 + i), uname: 'u' + (1000 + i), mtime: t0 - i * 1000 }));

{
  const all = mkUsers(10);
  const p = planUnfollow(all, { keep: 3, special: new Set() });
  eq('keep=3 时取关 7 个', p.targets.length, 7);
  eq('保留 3 个', p.keptCount, 3);
  eq('保留的是 mtime 最新的', p.targets.map((u) => u.mid).includes('1000'), false);
}
{
  const all = mkUsers(10);
  // 把一个落在取关区间的设为特别关注
  const p = planUnfollow(all, { keep: 3, special: new Set(['1005']) });
  eq('特别关注被保护，取关数降为 6', p.targets.length, 6);
  ok('特别关注不在取关名单里', !p.targets.some((u) => u.mid === '1005'));
}
{
  const all = mkUsers(5).map((u, i) => (i === 2 ? { ...u, special: true } : u));
  const p = planUnfollow(all, { keep: 1 });
  ok('列表自带 special 标记也被保护', !p.targets.some((u) => u.special));
}
{
  const all = mkUsers(4);
  const nowSec = Math.floor(Date.now() / 1000);
  const inactive = new Map([
    ['1000', { lastPubTs: nowSec - 400 * 86400, count: 12 }], // 400 天没更
    ['1001', { lastPubTs: nowSec - 10 * 86400, count: 30 }],  // 活跃
    ['1002', { lastPubTs: null, count: 0 }],                   // 零投稿
  ]);
  const p = planUnfollow(all, { onlyInactive: true, inactiveDays: 180, inactive });
  eq('只取关停更号：命中 2 个', p.targets.length, 2);
  ok('活跃号被保留', !p.targets.some((u) => u.mid === '1001'));
  ok('零投稿号被判为停更', p.targets.some((u) => u.mid === '1002'));
}
{
  const all = mkUsers(6);
  const p = planUnfollow(all, { keep: 2, protectTags: new Set(['1004']) });
  ok('受保护分组里的不被取关', !p.targets.some((u) => u.mid === '1004'));
}
{
  const p = planUnfollow([], { keep: 10 });
  eq('空关注列表不炸', p.targets.length, 0);
}

// ---------- plan.planFavClassify ----------
section('收藏夹分类计划');
const mkItems = (defs) => defs.map((d, i) => ({ id: 100 + i, type: 2, title: d.t, upper: d.u ?? '', intro: d.i ?? '', srcMediaId: 1 }));
{
  const items = mkItems([{ t: 'a' }, { t: 'b' }, { t: 'c' }]);
  const asg = new Map([[100, '游戏'], [101, '游戏'], [102, '音乐']]);
  const folders = [{ id: 7, title: '游戏', count: 5 }];
  const r = planFavClassify(items, asg, folders, { folderQuota: 20, perFolderCap: 1000 });
  eq('两个分类', r.categories, 2);
  eq('复用已有「游戏」，只新建 1 个', r.newFolders, 1);
  const g = r.plan.find((p) => p.category === '游戏');
  eq('「游戏」命中精确复用', g.reuseKind, 'exact');
  eq('「游戏」目标 id 是已有的 7', g.targetId, 7);
}
{
  // 这是 favlist-classifier 默认路径的 bug：重跑会建出「游戏_1」。这里必须复用。
  const items = mkItems([{ t: 'a' }]);
  const asg = new Map([[100, '游戏']]);
  const folders = [{ id: 7, title: ' 游戏 ', count: 0 }];
  const r = planFavClassify(items, asg, folders, {});
  eq('带首尾空格的同名夹也复用，不新建', r.newFolders, 0);
  eq('复用方式是宽松匹配', r.plan[0].reuseKind, 'loose');
}
{
  const items = mkItems(Array.from({ length: 3 }, (_, i) => ({ t: 'x' + i })));
  const asg = new Map(items.map((it, i) => [it.id, '类' + i]));
  const folders = Array.from({ length: 19 }, (_, i) => ({ id: i, title: 'f' + i, count: 0 }));
  const r = planFavClassify(items, asg, folders, { folderQuota: 20 });
  ok('新建会超配额时给出 folder-quota 警告', r.warnings.some((w) => w.kind === 'folder-quota'));
}
{
  const items = mkItems(Array.from({ length: 5 }, (_, i) => ({ t: 'y' + i })));
  const asg = new Map(items.map((it) => [it.id, '游戏']));
  const folders = [{ id: 7, title: '游戏', count: 998 }];
  const r = planFavClassify(items, asg, folders, { perFolderCap: 1000 });
  ok('单夹将超 1000 时给出 folder-cap 警告', r.warnings.some((w) => w.kind === 'folder-cap'));
  eq('超出条数算对', r.plan[0].overflowBy, 3);
}
{
  const items = mkItems([{ t: 'a' }, { t: 'b' }]);
  const asg = new Map([[100, '游戏']]); // 只给一个分类
  const r = planFavClassify(items, asg, [], {});
  eq('没分配到分类的条目不会被计划动它', r.totalItems, 1);
}

// ---------- plan.planDeadCleanup ----------
section('失效视频清理计划');
{
  const byFolder = new Map([
    [1, [{ id: 1, dead: true }, { id: 2, dead: false }]],
    [2, [{ id: 3, dead: false }]],
    [3, [{ id: 4, dead: true }, { id: 5, dead: true }]],
  ]);
  const r = planDeadCleanup(byFolder);
  eq('共 3 个失效', r.total, 3);
  eq('只有 2 个夹需要处理', r.groups.length, 2);
}

// ---------- 分片 / 资源串 ----------
section('分片与资源串');
eq('chunk 切分正确', chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
eq('chunk 整除无空尾片', chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
eq('toResource 拼 aid:type', toResource({ id: 42, type: 2 }), '42:2');
eq('toResource 缺 type 默认 2', toResource({ id: 42 }), '42:2');

// ---------- 关键词分类 ----------
section('关键词规则分类');
{
  const items = mkItems([
    { t: 'Python 入门教程 第一讲', u: '某编程UP' },
    { t: '红烧肉的家常做法', u: '厨房日记' },
    { t: '显卡开箱评测 4090', u: '数码君' },
    { t: '随便拍点什么', u: '路人' },
  ]);
  const { assignment, detail, unmatched } = classifyAll(items, DEFAULT_RULES);
  eq('Python 归到编程开发', assignment.get(100), '编程开发');
  eq('红烧肉归到美食烹饪', assignment.get(101), '美食烹饪');
  eq('显卡开箱归到数码硬件', assignment.get(102), '数码硬件');
  eq('无特征的落到待分类', assignment.get(103), '待分类');
  eq('未命中计数为 1', unmatched, 1);
  ok('待分类条目被标为需复核', detail.get(103).ambiguous);
}
{
  const rules = [{ name: '排除测试', any: ['教程'], none: ['python'] }];
  const items = mkItems([{ t: 'Python 教程' }, { t: 'Excel 教程' }]);
  const { assignment } = classifyAll(items, rules);
  eq('排除词生效，Python 教程不进该类', assignment.get(100), '待分类');
  eq('Excel 教程正常命中', assignment.get(101), '排除测试');
}
{
  const rules = [{ name: 'UP加权', upper: ['老师'], any: [] }, { name: '弱命中', any: ['视频'] }];
  const items = mkItems([{ t: '这个视频', u: '张老师' }]);
  const s = scoreItem(items[0], rules);
  eq('UP 主命中权重更高，排在前面', s[0].name, 'UP加权');
}
{
  const items = mkItems([{ t: 'x' }]);
  const { assignment } = classifyAll(items, DEFAULT_RULES, { keepUnmatched: true });
  eq('keepUnmatched 时不给兜底分类', assignment.has(100), false);
}

// ---------- AI 返回解析 ----------
section('AI 返回解析容错');
eq('裸 JSON', extractJson('{"results":[]}'), { results: [] });
eq('带 markdown 围栏', extractJson('```json\n{"results":[{"id":1}]}\n```'), { results: [{ id: 1 }] });
eq('前后有废话', extractJson('好的，结果如下：{"results":[]} 以上。'), { results: [] });
eq('无法解析返回 null', extractJson('完全不是 JSON'), null);
eq('空输入返回 null', extractJson(''), null);

// ---------- 风控引擎 ----------
section('风控引擎');
{
  eq('-412 判为风控', classifyResult({ code: -412 }).kind, 'risk');
  eq('-352 判为风控', classifyResult({ code: -352 }).kind, 'risk');
  eq('-101 判为登录失效', classifyResult({ code: -101 }).kind, 'auth');
  eq('0 判为成功', classifyResult({ code: 0 }).kind, 'ok');
  eq('其他判为普通失败', classifyResult({ code: -404 }).kind, 'fail');
  ok('风控码与登录码不重叠', [...RISK_CODES].every((c) => !AUTH_CODES.has(c)));
}
{
  const r = new RiskEngine({ minDelayMs: 1000, maxDelayMs: 1000, minFloorMs: 500, maxCeilMs: 20000 });
  const d0 = r.curDelay;
  const cd = r.onRateLimit();
  ok('撞限流后延迟翻倍', r.curDelay === d0 * 2);
  eq('首次冷却 60s', cd, 60000);
  r.onRateLimit();
  eq('第二次冷却 120s', r.cooldownUntil - Date.now() > 110000, true);
}
{
  const r = new RiskEngine({ minDelayMs: 1000, minFloorMs: 500 });
  r.curDelay = 4000;
  for (let i = 0; i < 4; i++) r.onSuccess();
  eq('连续 4 次成功还不放开', r.curDelay, 4000);
  r.onSuccess();
  ok('第 5 次成功后延迟收缩到 0.85 倍', Math.abs(r.curDelay - 3400) < 1);
}
{
  const r = new RiskEngine({ minFloorMs: 500 });
  r.curDelay = 500;
  for (let i = 0; i < 20; i++) r.onSuccess();
  eq('不会跌破下限', r.curDelay, 500);
}
{
  const r = new RiskEngine({ maxCeilMs: 3000, minDelayMs: 1000 });
  for (let i = 0; i < 20; i++) r.onRateLimit();
  eq('不会涨破上限', r.curDelay, 3000);
}
{
  const r = new RiskEngine({ hardCapPerRound: 100 });
  ok('100 次以内放行', r.checkRoundCap(100).ok);
  ok('101 次拦下', !r.checkRoundCap(101).ok);
}
{
  const r = new RiskEngine();
  const now = Date.now();
  r.events = [{ t: now, op: 'folderAdd', n: 10 }];
  const s1 = r.status(now);
  r.events = [{ t: now, op: 'unfollow', n: 10 }];
  const s2 = r.status(now);
  ok('建收藏夹的热度权重高于取关', s1.heat > s2.heat);
}
{
  const r = new RiskEngine();
  const now = Date.now();
  r.events = [{ t: now - 45 * 60_000, op: 'unfollow', n: 100 }];
  const old = r.status(now).heat;
  r.events = [{ t: now, op: 'unfollow', n: 100 }];
  const fresh = r.status(now).heat;
  ok('45 分钟半衰期：旧事件热度明显低于新事件', old < fresh);
}
{
  const r = new RiskEngine();
  const now = Date.now();
  r.events = [{ t: now - 25 * 3600_000, op: 'unfollow', n: 999 }];
  eq('超过 24h 的事件不计入热度', r.status(now).heat, 0);
}
{
  const r = new RiskEngine();
  eq('零事件时为 green', r.status().level, 'green');
  eq('green 无附加静默', r.levelPauseMs('green'), 0);
  ok('red 附加静默最久', r.levelPauseMs('red') > r.levelPauseMs('orange'));
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
