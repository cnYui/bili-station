#!/usr/bin/env node
/**
 * bili-station CLI —— 设计成可被 Claude / Codex 这类 agent 直接调用。
 *
 * agent 友好的约定：
 *   · --json 时 stdout 只有一个 JSON 对象，所有人类可读日志走 stderr
 *   · 从不交互提问；破坏性操作默认干跑，必须显式 --yes
 *   · 退出码有语义：0 成功 / 1 一般错误 / 2 风控中止 / 3 登录失效 / 4 无事可做
 *   · 同一条命令重复跑是安全的（断点续跑会跳过已完成项）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CdpSession, probe } from './src/cdp.mjs';
import { Bili } from './src/bili.mjs';
import * as store from './src/store.mjs';
import { planFavClassify, planUnfollow, planMerge, planDeadCleanup } from './src/plan.mjs';
import { classifyAll } from './src/classify/keyword.mjs';
import { classifyWithAI } from './src/classify/ai.mjs';
import { buildTasks, applyExternalAssignment } from './src/classify/external.mjs';
import { join } from 'node:path';
import { Job, buildUnfollowOps, buildFavOps, buildMergeOps, buildDeadOps, buildLayoutOps } from './src/executor.mjs';

const EXIT = { OK: 0, ERROR: 1, RISK: 2, AUTH: 3, NOTHING: 4 };

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const TASKS_DEFAULT = join(store.DATA_DIR, 'tasks.json');
const JSON_MODE = !!args.flags.json;
const say = (...m) => process.stderr.write(m.join(' ') + '\n');
const emit = (obj) => process.stdout.write(JSON_MODE ? JSON.stringify(obj, null, 2) + '\n' : '');

function die(msg, code = EXIT.ERROR) {
  if (JSON_MODE) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
  else say('错误：' + msg);
  process.exit(code);
}

const cfg = () => {
  const c = store.read('config.json', {});
  return {
    cdpPort: 9222, folderQuota: 20, perFolderCap: 1000, privacy: 1, risk: {},
    ...c,
    ai: {
      provider: 'deepseek', model: 'deepseek-chat', chunkSize: 25, concurrency: 2,
      ...(c.ai ?? {}),
      // 环境变量优先于配置文件，方便 CI / 临时换 key
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.BILI_AI_KEY || c.ai?.apiKey || '',
    },
  };
};

async function connect(c) {
  const p = await probe(c.cdpPort);
  if (!p.ok) die(`未检测到 Chrome 调试端口 ${c.cdpPort}。先跑 "npm run chrome" 并在打开的窗口里登录 B 站。`);
  const cdp = await new CdpSession(c.cdpPort).connect();
  const bili = new Bili(cdp);
  const me = await bili.init();
  say(`已连接：${me.uname}（UID ${me.mid}）`);
  return { cdp, bili, me };
}

const jobExit = (snap) =>
  snap.status === 'error' && /登录态失效/.test(snap.error ?? '') ? EXIT.AUTH
  : snap.status === 'stopped' ? EXIT.RISK
  : snap.status === 'error' ? EXIT.ERROR
  : EXIT.OK;

function wireJob(job) {
  job.on((ev) => { if (ev.type === 'log' && !JSON_MODE) say('  ' + ev.msg); });
}


/**
 * 扫描一个收藏夹，带断点续扫与缓存保护。
 * 缓存结构：{ items, complete, nextPage }
 * 原则：**绝不用更差的结果覆盖已有缓存**。失败的扫描把好数据盖掉，
 * 会让下一次从零开始，用更多请求去撞同一堵墙。
 */
async function scanFolder(bili, id, cache, { refresh = false, onSay = () => {}, pageDelayMs, folderCount = 0 } = {}) {
  const prev = cache.get(Number(id));
  if (!refresh && prev?.complete) return prev;

  const startPage = (!refresh && prev && !prev.complete && prev.nextPage) ? prev.nextPage : 1;
  const seed = startPage > 1 ? (prev.items ?? []) : [];
  if (startPage > 1) onSay(`    从第 ${startPage} 页续扫（已有 ${seed.length} 条）`);

  // 大收藏夹要翻几百页，用小夹那种节奏必然撞 412。按规模自动降速。
  const pages = Math.ceil((folderCount || 0) / 20);
  const auto = pages > 150 ? 2200 : pages > 50 ? 1400 : 450;
  const delay = pageDelayMs ?? auto;
  const jitter = Math.round(delay * 1.1);
  if (pages > 50) onSay(`    约 ${pages} 页，翻页间隔 ${(delay / 1000).toFixed(1)}~${((delay + jitter) / 1000).toFixed(1)}s，预计 ${Math.ceil(pages * (delay + jitter / 2) / 60000)} 分钟`);

  const r = await bili.favItems(id, (n, info) => {
    if (info?.throttled) onSay(`    ⏸ 读取被限流（code=${info.code}），退避 ${Math.round(info.waitMs / 1000)}s 后重试（第 ${info.attempt} 次）`);
    else if (n && n % 200 === 0) onSay(`    ${n} 条…`);
  }, { startPage, seed, pageDelayMs: delay, pageJitterMs: jitter, backoffMs: 30_000, maxRetry: 5 });

  const next = { items: r.list, complete: !!r.complete, nextPage: r.nextPage ?? null };

  // 只有「扫完了」或「拿到的更多」才写回缓存
  const better = next.complete || next.items.length > (prev?.items?.length ?? -1);
  if (better) cache.set(Number(id), next);
  else onSay(`    ⚠ 本次只拿到 ${next.items.length} 条，不如已缓存的 ${prev.items.length} 条，保留旧数据`);

  if (!next.complete) {
    onSay(`    ⚠ 未扫完（停在第 ${r.error?.atPage ?? '?'} 页，code=${r.error?.code}），已保存进度，下次自动续扫`);
  }
  return cache.get(Number(id)) ?? next;
}

/** 旧格式（裸数组）兼容：统一成 { items, complete, nextPage } */
function loadCache() {
  const cached = store.read('favorites.json', null);
  const m = new Map();
  for (const [k, v] of (cached?.items ?? [])) {
    m.set(Number(k), Array.isArray(v) ? { items: v, complete: true, nextPage: null } : v);
  }
  return m;
}
const saveCache = (folders, cache) => store.write('favorites.json', { folders, items: [...cache] });
const itemsOf = (cache, id) => cache.get(Number(id))?.items ?? [];

// ---------- 命令 ----------
const CMD = {};

CMD.status = async () => {
  const c = cfg();
  const p = await probe(c.cdpPort);
  if (!p.ok) {
    emit({ ok: true, chrome: p, loggedIn: false });
    if (!JSON_MODE) say(`Chrome 调试端口 ${c.cdpPort}：未就绪（${p.error}）`);
    return EXIT.OK;
  }
  const { cdp, bili, me } = await connect(c);
  const folders = await bili.favFolders();
  cdp.close();
  emit({ ok: true, chrome: p, loggedIn: true, me, folders, aiConfigured: !!c.ai.apiKey, dataDir: store.DATA_DIR });
  if (!JSON_MODE) {
    say(`收藏夹 ${folders.length} 个：`);
    for (const f of folders) say(`  ${String(f.id).padEnd(12)} ${f.title}  (${f.count} 条)`);
    say(`AI：${c.ai.apiKey ? c.ai.provider + ' / ' + c.ai.model : '未配置'}`);
  }
  return EXIT.OK;
};

CMD.folders = async () => {
  const sub = args._[1];
  const c = cfg();
  const folderIdsSeed = new Map();
  const { cdp, bili } = await connect(c);
  try {
    if (!sub || sub === 'list') {
      const folders = await bili.favFolders();
      emit({ ok: true, folders });
      if (!JSON_MODE) for (const f of folders) say(`  ${String(f.id).padEnd(12)} ${f.title}  (${f.count} 条)`);
      return EXIT.OK;
    }
    if (sub === 'create') {
      const names = args._.slice(2).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (!names.length) die('没给要新建的收藏夹名。用法：bili-station folders create "游戏,科普"');
      const existing = await bili.favFolders();
      const have = new Map(existing.map((f) => [f.title.trim().toLowerCase(), f]));
      const created = [], reused = [];
      for (const n of names) {
        const hit = have.get(n.trim().toLowerCase());
        if (hit) { reused.push({ name: n, id: hit.id }); say(`  复用已有：${n}（id ${hit.id}）`); continue; }
        if (!args.flags.yes) { say(`  [干跑] 将新建：${n}`); continue; }
        const r = await bili.createFolder(n, { privacy: Number(c.privacy) });
        if (r?.code !== 0) die(`新建「${n}」失败：code=${r?.code} ${r?.message}`);
        created.push({ name: n, id: r.data.id });
        say(`  已新建：${n}（id ${r.data.id}）`);
        await new Promise((res) => setTimeout(res, 1200 + Math.random() * 900));
      }
      emit({ ok: true, dryRun: !args.flags.yes, created, reused });
      return EXIT.OK;
    }
    if (sub === 'setup') {
      const mapFile = String(args.flags.map ?? '');
      if (!mapFile) die('需要 --map <file>，内容形如 {"renames":[{"id":123,"to":"新名"}],"creates":["名1","名2"]}');
      const plan = JSON.parse(readFileSync(mapFile, 'utf8'));
      const folders = await bili.favFolders();
      const byId = new Map(folders.map((f) => [Number(f.id), f]));
      const byName = new Map(folders.map((f) => [f.title.trim().toLowerCase(), f]));

      const renames = [];
      for (const r of (plan.renames ?? [])) {
        const f = byId.get(Number(r.id));
        if (!f) { say(`  ⚠ 跳过：找不到收藏夹 ${r.id}`); continue; }
        if (f.title.trim() === String(r.to).trim()) { say(`  · 已是「${r.to}」，无需改名`); folderIdsSeed.set(r.to, f.id); continue; }
        renames.push({ id: f.id, from: f.title, to: String(r.to) });
      }
      const creates = (plan.creates ?? []).filter((n) => {
        const hit = byName.get(String(n).trim().toLowerCase());
        if (hit) { say(`  · 「${n}」已存在（id ${hit.id}），跳过新建`); folderIdsSeed.set(n, hit.id); return false; }
        return true;
      });

      say('');
      say(`改名 ${renames.length} 个，新建 ${creates.length} 个，操作后收藏夹总数 ${folders.length + creates.length}`);
      for (const r of renames) say(`  改：${r.from}  →  ${r.to}`);
      for (const n of creates) say(`  建：${n}`);

      if (!args.flags.yes) {
        say('');
        say('以上为干跑结果，未做任何修改。加 --yes 才会真正执行。');
        emit({ ok: true, dryRun: true, renames, creates, totalAfter: folders.length + creates.length });
        return EXIT.OK;
      }

      store.backup('folders', folders);
      const folderIds = folderIdsSeed;
      const job = new Job('cli-' + Date.now(), 'layout', { dryRun: false, riskOpts: c.risk, resumeKey: 'layout' });
      wireJob(job);
      const snap = await job.run(buildLayoutOps(bili, renames, creates, folderIds, { privacy: Number(c.privacy) }));
      const after = await bili.favFolders();
      store.write('folder-map.json', Object.fromEntries(folderIds));
      emit({ ok: true, dryRun: false, result: snap.counters, status: snap.status, error: snap.error,
             folders: after.map((f) => ({ id: f.id, title: f.title, count: f.count })) });
      if (!JSON_MODE) {
        say('');
        say(`完成：成功 ${snap.counters.done} / 失败 ${snap.counters.failed}，当前共 ${after.length} 个收藏夹`);
        say(`名称→id 映射已存到 ${join(store.DATA_DIR, 'folder-map.json')}`);
      }
      return jobExit(snap);
    }
    die('未知子命令：folders ' + sub);
  } finally { cdp.close(); }
};

CMD.scan = async () => {
  const what = args._[1] ?? 'fav';
  const c = cfg();
  const { cdp, bili } = await connect(c);
  try {
    if (what === 'fav') {
      const folders = await bili.favFolders();
      const only = args.flags.folder ? String(args.flags.folder).split(',').map(Number) : null;
      const want = only ? folders.filter((f) => only.includes(f.id)) : folders;
      const cache = loadCache();
      let incomplete = 0;
      for (const f of want) {
        const have = cache.get(Number(f.id));
        if (!have?.complete || args.flags.refresh) say(`  拉取「${f.title}」（${f.count} 条）…`);
        const r = await scanFolder(bili, f.id, cache, {
          refresh: !!args.flags.refresh, onSay: say,
          folderCount: folders.find((x) => Number(x.id) === Number(f.id))?.count ?? 0,
          ...(args.flags['page-delay'] ? { pageDelayMs: Number(args.flags['page-delay']) } : {}),
        });
        if (!r.complete) incomplete++;
        say(`    ${r.items.length} 条${r.complete ? '' : '（未扫完）'}`);
      }
      saveCache(folders, cache);
      const counts = Object.fromEntries(want.map((f) => [f.id, itemsOf(cache, f.id).length]));
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (incomplete) say(`⚠ ${incomplete} 个夹未扫完，重跑会自动续扫`);
      emit({ ok: true, folders, counts, total, incomplete });
      return EXIT.OK;
    }
    if (what === 'follow') {
      const r = await bili.followings((n, t) => { if (n % 200 === 0) say(`  已拉取 ${n}${t ? '/' + t : ''}`); });
      const special = await bili.specialFollowings();
      store.write('followings.json', r);
      store.write('special.json', [...special]);
      if (r.truncated) say(`  ⚠ 未拉全：只读到 ${r.list.length}/${r.total ?? '?'}，这是 B 站分页深度限制`);
      emit({ ok: true, count: r.list.length, total: r.total, truncated: r.truncated, special: special.size });
      return EXIT.OK;
    }
    if (what === 'sample') {
      const folders = await bili.favFolders();
      const fid = Number(args.flags.folder ?? folders[0]?.id);
      const f = folders.find((x) => Number(x.id) === fid);
      if (!f) die('找不到收藏夹 ' + fid);
      const ratio = Number(args.flags.ratio ?? 0.25);
      const step = Math.max(1, Math.round(1 / ratio));
      const totalPages = Math.ceil(f.count / 20);
      const willRead = Math.ceil(totalPages / step);
      say(`「${f.title}」共 ${f.count} 条 / ${totalPages} 页`);
      say(`抽样：每 ${step} 页取 1 页 → 读 ${willRead} 页，约 ${willRead * 20} 条（${Math.round(100 / step)}%）`);
      say(`预计 ${Math.ceil(willRead * 2.75 / 60)} 分钟`);
      const r = await bili.favSample(fid, {
        totalCount: f.count, step,
        ...(args.flags['page-delay'] ? { pageDelayMs: Number(args.flags['page-delay']) } : {}),
        onProgress: (p) => {
          if (p.throttled) say(`  ⏸ 第 ${p.page} 页被限流（code=${p.code}），退避 ${Math.round(p.waitMs / 1000)}s（第 ${p.attempt} 次）`);
          else if (p.done % 10 === 0) say(`  ${p.done}/${p.totalPages} 页，已取 ${p.items} 条`);
        },
      });
      const out = String(args.flags.out ?? join(store.DATA_DIR, 'sample-' + fid + '.json'));
      writeFileSync(out, JSON.stringify({ folder: f, ...r }, null, 2));
      say(`
样本 ${r.list.length} 条（${r.sampledPages}/${r.totalPages} 页）已写入 ${out}`);
      if (r.failed.length) say(`⚠ ${r.failed.length} 页读取失败`);
      emit({ ok: true, folder: f, sampled: r.list.length, sampledPages: r.sampledPages, totalPages: r.totalPages, failed: r.failed, out });
      return EXIT.OK;
    }
    die('未知：scan ' + what);
  } finally { cdp.close(); }
};

/** 核心命令：先定收藏夹 → 模型只在这些夹里二选一 → 移动/复制 */
CMD.sort = async () => {
  const c = cfg();
  // 默认 external：调用方（Claude / Codex / 你自己）来分类，不外挂第二个 LLM、不需要第二把 key
  const engine = String(args.flags.engine ?? 'external');
  const mode = String(args.flags.mode ?? 'copy');
  if (!['copy', 'move'].includes(mode)) die('--mode 只能是 copy 或 move');

  const named = String(args.flags.folders ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!named.length && !args.flags['include-existing']) {
    die('必须用 --folders "A,B,C" 指定候选收藏夹，或加 --include-existing 把现有收藏夹全部作为候选。');
  }

  const { cdp, bili } = await connect(c);
  try {
    // 1. 候选集 = 指定的名字 ∪（可选）现有全部收藏夹
    let folders = await bili.favFolders();
    const existingNames = folders.map((f) => f.title);
    const candidates = [...new Set([...named, ...(args.flags['include-existing'] ? existingNames : [])])];
    if (!candidates.length) die('候选收藏夹为空');
    say(`候选收藏夹 ${candidates.length} 个：${candidates.join(' / ')}`);

    // 2. 先新建缺失的候选夹（除非 --lazy-create）
    const have = new Map(folders.map((f) => [f.title.trim().toLowerCase(), f]));
    const missing = candidates.filter((n) => !have.has(n.trim().toLowerCase()));
    if (missing.length && !args.flags['lazy-create']) {
      if (folders.length + missing.length > c.folderQuota) {
        // 收藏夹个数上限 B 站没有公开权威数字，所以这里只警告、不硬拦，
        // 真撞上了由下面的建夹失败给出可辨别的解释。
        say(`⚠ 将新建 ${missing.length} 个夹，加上已有 ${folders.length} 个会超过配置里的上限 ${c.folderQuota}。`);
        say('  如果建夹真的失败，多半是收藏夹个数配额满了（不是风控），届时请先删掉一些夹再来。');
      }
      if (!args.flags.yes) {
        say(`[干跑] 将新建 ${missing.length} 个收藏夹：${missing.join(' / ')}`);
      } else {
        say(`新建 ${missing.length} 个收藏夹…`);
        for (const n of missing) {
          const r = await bili.createFolder(n, { privacy: Number(c.privacy) });
          if (r?.code !== 0) {
            die(`新建收藏夹「${n}」失败：code=${r?.code} ${r?.message}
`
              + `  当前已有 ${folders.length} 个收藏夹。如果这个报错看着像限流，先考虑是不是**收藏夹个数配额满了** —— `
              + `B 站这两种情况的报错很像。确认办法：去网页端手动新建一个夹，建得出来就是限流，建不出来就是配额。`);
          }
          say(`  ✓ ${n}（id ${r.data.id}）`);
          // 建夹是风控权重最高的写操作，连续建一定要拉开间距
          await new Promise((res) => setTimeout(res, 1500 + Math.random() * 1200));
        }
        folders = await bili.favFolders();
      }
    }

    // 3. 来源条目
    const srcFlag = String(args.flags.source ?? 'all');
    const srcIds = srcFlag === 'all' ? folders.map((f) => f.id) : srcFlag.split(',').map(Number);
    // 目标夹本身不该作为来源，否则会把刚分好的又搅一遍
    const candLower = new Set(candidates.map((s) => s.trim().toLowerCase()));
    const realSrc = srcFlag === 'all'
      ? folders.filter((f) => !candLower.has(f.title.trim().toLowerCase())).map((f) => f.id)
      : srcIds;

    const cached = store.read('favorites.json', null);
    const cache = cached ? new Map(cached.items) : new Map();
    let items = [];
    for (const id of realSrc) {
      let list = itemsOf(cache, id);
      if (!list.length) {
        say(`  拉取收藏夹 ${id}…`);
        const r = await bili.favItems(id);
        list = r.list ?? [];
        cache.set(Number(id), { items: list, complete: r.complete !== false, nextPage: r.nextPage ?? 0 });
      }
      items.push(...list);
    }
    store.write('favorites.json', { folders, items: [...cache] });
    items = items.filter((it) => !it.dead);
    if (args.flags.limit) items = items.slice(0, Number(args.flags.limit));
    if (!items.length) { emit({ ok: true, nothing: true, reason: '没有可分类的条目' }); return EXIT.NOTHING; }
    say(`待分类 ${items.length} 条`);

    // 4. 分类：候选集就是唯一允许的输出集合
    let assignment, detail, engineMeta = {};
    if (engine === 'external') {
      // 给 Claude / Codex 用：CLI 吐清单，调用方回填，不需要第二把 key
      if (args.flags.assign) {
        const raw = JSON.parse(readFileSync(String(args.flags.assign), 'utf8'));
        const res = applyExternalAssignment(items, candidates, raw);
        assignment = res.assignment;
        detail = res.detail;
        engineMeta = { assigned: res.accepted, rejected: res.rejected.length, missing: res.missing };
        say(`外部分配：采纳 ${res.accepted} 条`
          + (res.rejected.length ? `，拒收 ${res.rejected.length} 条（分类名不在候选集内）` : '')
          + (res.missing ? `，未分配 ${res.missing} 条` : ''));
        for (const r of res.rejected.slice(0, 5)) say(`    拒收：「${r.given}」 <- ${r.title.slice(0, 24)}`);
        if (res.rejected.length > 5) say(`    … 另有 ${res.rejected.length - 5} 条`);
      } else {
        const tasks = buildTasks(items, candidates);
        const out = args.flags['emit-tasks'];
        if (out && out !== true) { writeFileSync(String(out), JSON.stringify(tasks, null, 2)); say(`待分类清单已写入 ${out}`); }
        process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
        say('把每条归到 candidates 里的唯一一个，存成 {"<id>":"<分类名>"} 后用 --assign <文件> 回填。');
        return EXIT.OK;
      }
    } else if (engine === 'keyword') {
      const rules = candidates.map((n) => ({ name: n, any: [n] }));
      const r = classifyAll(items, (c.rules ?? []).filter((x) => candidates.includes(x.name)).concat(rules), { keepUnmatched: true });
      assignment = r.assignment; detail = r.detail;
      engineMeta = { unmatched: r.unmatched };
    } else {
      if (!c.ai.apiKey) die('--engine deepseek 需要 API key：设 DEEPSEEK_API_KEY 环境变量即可。'
        + '（默认的 --engine external 不需要任何 key，由调用方自己分类）');
      say(`调用 ${c.ai.provider} / ${c.ai.model} 分类…`);
      const r = await classifyWithAI(items, candidates, c.ai, (p) => say(`  ${p.done}/${p.total}${p.failedChunks ? `（失败分片 ${p.failedChunks}）` : ''}`));
      assignment = r.assignment; detail = r.detail;
      engineMeta = { failedChunks: r.failedChunks.length, provider: c.ai.provider, model: c.ai.model };
      // 候选集之外的一律收敛到「待分类」；这里候选里没有它，直接剔除
      for (const [id, d] of detail) {
        if (!candidates.includes(d.category)) { assignment.delete(id); }
      }
    }

    // 5. 计划
    const fav = planFavClassify(items, assignment, folders, {
      folderQuota: c.folderQuota, perFolderCap: c.perFolderCap, mode,
    });
    const lowConf = [...detail.values()].filter((d) => d.ambiguous).length;
    const summary = {
      ok: true, mode, engine, ...engineMeta,
      totalItems: fav.totalItems, categories: fav.categories,
      newFolders: fav.newFolders, reusedFolders: fav.reusedFolders,
      needReview: lowConf,
      warnings: fav.warnings,
      groups: fav.plan.map((p) => ({ category: p.category, count: p.count, isNew: p.isNew, existingCount: p.existingCount, overflow: p.overflow })),
    };

    if (!JSON_MODE) {
      say('');
      for (const w of fav.warnings) say('  ⚠ ' + w.message);
      say(`分类结果（${mode === 'move' ? '移动' : '复制'}模式）：`);
      for (const p of fav.plan) say(`  ${String(p.count).padStart(5)}  ${p.category}${p.isNew ? '（新建）' : ''}`);
      if (lowConf) say(`  其中 ${lowConf} 条置信度偏低，建议人工复核`);
    }

    if (!fav.totalItems) { emit({ ...summary, nothing: true }); return EXIT.NOTHING; }

    // 6. 执行
    if (!args.flags.yes) {
      say('');
      say('以上为干跑结果，未做任何修改。加 --yes 才会真正执行。');
      emit({ ...summary, dryRun: true });
      return EXIT.OK;
    }

    store.backup('favorites', { folders, items: [...cache] });
    const folderIds = new Map();
    const ops = buildFavOps(bili, fav, folderIds, { mode, privacy: Number(c.privacy) });
    const job = new Job('cli-' + Date.now(), 'fav', { dryRun: false, riskOpts: c.risk, resumeKey: 'fav' });
    wireJob(job);
    const snap = await job.run(ops);
    emit({ ...summary, dryRun: false, result: snap.counters, status: snap.status, error: snap.error });
    return jobExit(snap);
  } finally { cdp.close(); }
};

CMD.unfollow = async () => {
  const c = cfg();
  const { cdp, bili } = await connect(c);
  try {
    let data = store.read('followings.json', null);
    if (!data || args.flags.refresh) {
      say('拉取关注列表…');
      data = await bili.followings((n, t) => { if (n % 200 === 0) say(`  ${n}${t ? '/' + t : ''}`); });
      store.write('followings.json', data);
    }
    if (data.truncated) say(`⚠ 关注列表未拉全：只读到 ${data.list.length}/${data.total ?? '?'}`);
    const special = await bili.specialFollowings();

    const p = planUnfollow(data.list, {
      keep: args.flags.keep != null ? Number(args.flags.keep) : null,
      special,
      inactiveDays: args.flags['inactive-days'] != null ? Number(args.flags['inactive-days']) : null,
      inactive: new Map(store.read('uploads.json', [])),
      onlyInactive: !!args.flags['only-inactive'],
    });

    const summary = {
      ok: true, total: p.total, willUnfollow: p.targets.length, kept: p.keptCount,
      byReason: p.summary.byReason, truncated: data.truncated,
    };
    if (!JSON_MODE) {
      say(`关注 ${p.total} 个 → 将取关 ${p.targets.length}，保留 ${p.keptCount}（特别关注 ${special.size} 个无条件保留）`);
      for (const u of p.targets.slice(0, 20)) say(`  ${u.uname}（${u.mid}）— ${p.reasons.get(String(u.mid))}`);
      if (p.targets.length > 20) say(`  … 其余 ${p.targets.length - 20} 个`);
    }
    if (!p.targets.length) { emit({ ...summary, nothing: true }); return EXIT.NOTHING; }
    if (!args.flags.yes) {
      say('以上为干跑结果，未做任何修改。加 --yes 才会真正执行。');
      emit({ ...summary, dryRun: true });
      return EXIT.OK;
    }
    store.backup('followings', data);
    const job = new Job('cli-' + Date.now(), 'unfollow', { dryRun: false, riskOpts: c.risk, resumeKey: 'unfollow' });
    wireJob(job);
    const snap = await job.run(buildUnfollowOps(bili, p.targets));
    emit({ ...summary, dryRun: false, result: snap.counters, status: snap.status, error: snap.error });
    return jobExit(snap);
  } finally { cdp.close(); }
};


/** 合并：把若干收藏夹的内容全部搬进一个目标夹 */
CMD.merge = async () => {
  const c = cfg();
  const intoArg = args.flags.into;
  if (!intoArg) die('必须用 --into <收藏夹id或名称> 指定目标夹。例：--into 默认收藏夹');

  const { cdp, bili } = await connect(c);
  try {
    const folders = await bili.favFolders();
    const titleOf = (id) => folders.find((f) => Number(f.id) === Number(id))?.title ?? String(id);

    // 目标夹：优先按 id 精确匹配，其次按名称（忽略大小写与首尾空格）
    const byId = folders.find((f) => String(f.id) === String(intoArg));
    const nameHits = folders.filter((f) => f.title.trim().toLowerCase() === String(intoArg).trim().toLowerCase());
    if (!byId && nameHits.length > 1) {
      die(`名称「${intoArg}」对应 ${nameHits.length} 个收藏夹（id ${nameHits.map((f) => f.id).join(', ')}），请改用 id 指定。`);
    }
    const target = byId ?? nameHits[0];
    if (!target) die(`找不到收藏夹「${intoArg}」。用 bili-station folders 看现有的。`);

    // 来源：默认「除目标夹外的全部」
    const exclude = new Set(String(args.flags.exclude ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number));
    const fromIds = args.flags.from
      ? String(args.flags.from).split(',').map((x) => Number(x.trim())).filter(Boolean)
      : folders.map((f) => f.id).filter((id) => Number(id) !== Number(target.id));
    const sources = fromIds.filter((id) => !exclude.has(Number(id)) && Number(id) !== Number(target.id));
    if (!sources.length) { emit({ ok: true, nothing: true, reason: '没有来源收藏夹' }); return EXIT.NOTHING; }

    say(`目标：「${target.title}」(id ${target.id}，现有 ${target.count} 条)`);
    say(`来源：${sources.length} 个收藏夹`);

    // 拉来源内容（有缓存就用，--refresh 强制重拉）
    const cache = loadCache();
    const itemsBySource = new Map();
    let incomplete = 0;
    for (const id of sources) {
      const have = cache.get(Number(id));
      if (!have?.complete || args.flags.refresh) say(`  拉取「${titleOf(id)}」…`);
      const r = await scanFolder(bili, id, cache, {
          refresh: !!args.flags.refresh, onSay: say,
          folderCount: folders.find((x) => Number(x.id) === Number(id))?.count ?? 0,
          ...(args.flags['page-delay'] ? { pageDelayMs: Number(args.flags['page-delay']) } : {}),
        });
      if (!r.complete) incomplete++;
      itemsBySource.set(Number(id), r.items);
    }
    saveCache(folders, cache);
    if (incomplete) say(`⚠ 有 ${incomplete} 个来源夹没扫完，本次不会搬全。等限流过去后重跑会续扫。`);

    const plan = planMerge(itemsBySource, target, {
      perFolderCap: c.perFolderCap,
      includeDead: args.flags['skip-dead'] ? false : true,
      titleOf,
    });

    const summary = {
      ok: true,
      target: { id: target.id, title: target.title, countBefore: target.count },
      sources: plan.groups.length,
      totalItems: plan.total,
      deadItems: plan.deadTotal,
      duplicateInSources: plan.duplicateInSources,
      countAfter: (target.count ?? 0) + plan.total,
      warnings: plan.warnings,
      groups: plan.groups.map((g) => ({ srcId: g.srcId, srcTitle: g.srcTitle, count: g.count, dead: g.dead.length })),
    };

    if (!JSON_MODE) {
      say('');
      for (const w of plan.warnings) say('  ⚠ ' + w.message);
      say('将搬运：');
      for (const g of plan.groups) {
        say(`  ${String(g.count).padStart(4)}  ${g.srcTitle}${g.dead.length ? `（含 ${g.dead.length} 条失效）` : ''}`);
      }
      say(`  ────`);
      say(`  ${String(plan.total).padStart(4)}  合计 → 「${target.title}」将从 ${target.count} 变为 ${(target.count ?? 0) + plan.total} 条`);
      say('');
      say('注意：这是 move，来源夹会被清空（但夹本身仍在，不会被删除）。');
    }

    if (!plan.total) { emit({ ...summary, nothing: true }); return EXIT.NOTHING; }

    if (!args.flags.yes) {
      say('以上为干跑结果，未做任何修改。加 --yes 才会真正执行。');
      emit({ ...summary, dryRun: true });
      return EXIT.OK;
    }

    // 备份的是「每条视频原本在哪个夹」，这是回滚所需的全部信息
    const backupPath = store.backup('merge', {
      target: { id: target.id, title: target.title },
      origin: plan.groups.map((g) => ({
        srcId: g.srcId, srcTitle: g.srcTitle,
        items: [...g.live, ...g.dead].map((it) => ({ id: it.id, bvid: it.bvid, type: it.type, title: it.title })),
      })),
    });
    say(`已备份原始归属到 ${backupPath}`);

    const job = new Job('cli-' + Date.now(), 'merge', { dryRun: false, riskOpts: c.risk, resumeKey: 'merge' });
    wireJob(job);
    const snap = await job.run(buildMergeOps(bili, plan));
    emit({ ...summary, dryRun: false, backup: backupPath, result: snap.counters, status: snap.status, error: snap.error });
    return jobExit(snap);
  } finally { cdp.close(); }
};


/** 失效视频：归档到一个夹，或直接从收藏夹移除 */
CMD.dead = async () => {
  const c = cfg();
  const action = String(args.flags.action ?? 'archive');
  if (!['archive', 'remove'].includes(action)) die('--action 只能是 archive 或 remove');

  const { cdp, bili } = await connect(c);
  try {
    const folders = await bili.favFolders();
    const titleOf = (id) => folders.find((f) => Number(f.id) === Number(id))?.title ?? String(id);

    const only = args.flags.folder ? String(args.flags.folder).split(',').map(Number) : null;
    const wanted = (only ?? folders.map((f) => f.id)).map(Number);

    const cache = loadCache();
    const itemsByFolder = new Map();
    let incomplete = 0;
    for (const id of wanted) {
      const have = cache.get(Number(id));
      if (!have?.complete || args.flags.refresh) {
        say(`  拉取「${titleOf(id)}」（${folders.find((f) => Number(f.id) === Number(id))?.count ?? '?'} 条）…`);
      }
      const r = await scanFolder(bili, id, cache, {
          refresh: !!args.flags.refresh, onSay: say,
          folderCount: folders.find((x) => Number(x.id) === Number(id))?.count ?? 0,
          ...(args.flags['page-delay'] ? { pageDelayMs: Number(args.flags['page-delay']) } : {}),
        });
      if (!r.complete) incomplete++;
      itemsByFolder.set(Number(id), r.items);
    }
    saveCache(folders, cache);
    if (incomplete) {
      say('');
      say(`⚠ 有 ${incomplete} 个收藏夹没扫完，下面的统计是不完整的。等限流过去后重跑会自动续扫。`);
    }

    const plan = planDeadCleanup(itemsByFolder, {
      action,
      archiveName: String(args.flags['archive-name'] ?? '已失效视频归档'),
    });

    const summary = {
      ok: true, action, archiveName: plan.archiveName, total: plan.total,
      groups: plan.groups.map((g) => ({ mediaId: g.mediaId, folder: titleOf(g.mediaId), count: g.count })),
    };

    if (!JSON_MODE) {
      say('');
      if (!plan.total) { say('没有发现失效视频。'); }
      else {
        say(`失效视频共 ${plan.total} 条，分布在 ${plan.groups.length} 个收藏夹：`);
        for (const g of plan.groups) say(`  ${String(g.count).padStart(4)}  ${titleOf(g.mediaId)}`);
        say('');
        say(action === 'remove'
          ? '⚠ --action remove 会把它们从收藏夹里删掉。失效视频无法重新收藏，此操作不可逆。'
          : `将归档到「${plan.archiveName}」，原夹清空但条目仍在，可随时翻回。`);
      }
    }

    if (!plan.total) { emit({ ...summary, nothing: true }); return EXIT.NOTHING; }

    if (!args.flags.yes) {
      say('以上为干跑结果，未做任何修改。加 --yes 才会真正执行。');
      emit({ ...summary, dryRun: true });
      return EXIT.OK;
    }

    // 备份完整清单：删掉之后这就是唯一的记录
    const backupPath = store.backup('dead-' + action, {
      action,
      items: plan.groups.flatMap((g) => g.items.map((it) => ({
        folderId: g.mediaId, folder: titleOf(g.mediaId),
        aid: it.id, bvid: it.bvid, upper: it.upper, attr: it.attr, favTime: it.favTime,
      }))),
    });
    say(`已把完整清单备份到 ${backupPath}`);

    let archiveId = null;
    if (action === 'archive') {
      const hit = folders.find((f) => f.title.trim() === plan.archiveName.trim());
      if (hit) { archiveId = hit.id; say(`复用已有归档夹（id ${archiveId}）`); }
      else {
        const r = await bili.createFolder(plan.archiveName, { privacy: Number(c.privacy) });
        if (r?.code !== 0) die(`创建归档夹失败：code=${r?.code} ${r?.message}`);
        archiveId = r.data.id;
        say(`已新建归档夹「${plan.archiveName}」（id ${archiveId}）`);
      }
    }

    const job = new Job('cli-' + Date.now(), 'dead', { dryRun: false, riskOpts: c.risk, resumeKey: 'dead' });
    wireJob(job);
    const snap = await job.run(buildDeadOps(bili, plan, archiveId));
    emit({ ...summary, dryRun: false, backup: backupPath, archiveId, result: snap.counters, status: snap.status, error: snap.error });
    return jobExit(snap);
  } finally { cdp.close(); }
};

CMD.help = async () => {
  process.stdout.write(`bili-station — B 站账号整理 CLI（可被 agent 直接调用）

命令
  status                              检查 Chrome 连接 / 登录态 / 收藏夹 / AI 配置
  folders [list]                      列出收藏夹
  folders create "A,B,C" --yes        新建收藏夹
  folders setup --map <file>          批量改名复用 + 新建（一次性铺好分类骨架）
  scan fav [--folder 1,2]             拉取收藏夹内容到本地缓存
  scan sample --folder <id>           抽样读取（--ratio 0.25，跳页取样）
  scan follow                         拉取关注列表
  sort   [选项]                       核心：按候选收藏夹给收藏视频分类
  merge  --into <夹>                  把其他收藏夹的内容全部并入一个夹
  dead   [选项]                       处理失效视频（归档或删除）
  unfollow [选项]                     关注清理

sort 选项
  --folders "游戏,科普,编程"          候选收藏夹（模型只能从这里面选唯一一个）
  --include-existing                  把现有全部收藏夹也纳入候选
  --source all|<id,...>               来源收藏夹，默认 all（自动排除候选夹本身）
  --engine external|keyword|deepseek  默认 external（调用方自己分类，无需 key）
  --mode copy|move                    默认 copy（可逆）
  --lazy-create                       只建真正分到视频的夹，不预先全建
  --limit N                           只处理前 N 条，试水用
  --emit-tasks <file>                 engine=external：输出待分类清单
  --assign <file>                     engine=external：回填 {"<id>":"<分类名>"}

merge 选项
  --into <id或名称>                   目标收藏夹（必填）
  --from <id,...>                     来源夹；默认「除目标外的全部」
  --exclude <id,...>                  从来源里排除某几个
  --skip-dead                         不搬失效视频
  --refresh                           忽略本地缓存，重新拉取来源内容

dead 选项
  --action archive|remove             归档（默认，可逆）或直接删除（不可逆）
  --folder <id,...>                   只处理这几个夹；默认全部
  --archive-name "..."                归档夹名称，默认「已失效视频归档」
  --refresh                           忽略缓存重新拉取
  --page-delay <ms>                   翻页间隔，覆盖自动降速（大夹默认 2.2s）

unfollow 选项
  --keep N                            保留最近关注的前 N 个
  --inactive-days N                   超过 N 天没投稿算停更
  --only-inactive                     只取关停更号
  --refresh                           强制重新拉取关注列表

通用
  --yes                               真正执行（不加则一律干跑）
  --json                              stdout 只输出 JSON，日志走 stderr
  --help

退出码  0 成功 / 1 错误 / 2 风控中止 / 3 登录失效 / 4 无事可做

AI key 优先级：DEEPSEEK_API_KEY 环境变量 > ~/.bili-station/config.json

给 agent 用的典型序列
  bili-station status --json
  bili-station sort --folders "编程,游戏,美食" --limit 50 --json        # 干跑看计划
  bili-station sort --folders "编程,游戏,美食" --limit 50 --yes --json  # 确认后执行
`);
  return EXIT.OK;
};

// ---------- 入口 ----------
const name = args._[0] ?? (args.flags.help ? 'help' : 'help');
const fn = CMD[name];
if (!fn) die(`未知命令：${name}。用 --help 看用法。`);

try {
  process.exit(await fn());
} catch (e) {
  if (/登录态失效|未登录|Cookie/.test(e.message)) die(e.message, EXIT.AUTH);
  die(e.message, EXIT.ERROR);
}
