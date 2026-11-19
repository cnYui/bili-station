/**
 * 本地整理台服务端。零依赖：只用 Node 内置模块。
 * 只监听 127.0.0.1，不对外暴露。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpSession, probe } from './src/cdp.mjs';
import { Bili } from './src/bili.mjs';
import * as store from './src/store.mjs';
import { planUnfollow, planFavClassify, planDeadCleanup } from './src/plan.mjs';
import { classifyAll, DEFAULT_RULES } from './src/classify/keyword.mjs';
import { classifyWithAI } from './src/classify/ai.mjs';
import { Job, buildUnfollowOps, buildFavOps, buildDeadOps, buildTagOps } from './src/executor.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- 全局状态 ----------
const app = {
  cdp: null,
  bili: null,
  me: null,
  followings: null,      // { list, total, truncated }
  special: new Set(),
  tags: [],
  uploadInfo: new Map(),
  folders: [],
  favItems: new Map(),   // mediaId -> items[]
  lastPlan: null,        // { kind, ... }
  job: null,
  sse: new Set(),
};

/**
 * 逐键兜底。原本写的是 store.read('config.json', DEFAULTS)，而那个默认值**只在
 * 文件不存在时生效** —— 用户手改出一个局部 config.json（比如只写了 cdpPort），
 * 其余默认值就全丢了，/api/status 里的 c.ai.apiKey 直接 TypeError。
 * CLI 侧一直是 spread 写法，这里对齐。
 */
const cfg = () => {
  const c = store.read('config.json', {}) ?? {};
  return {
    cdpPort: 9222,
    dryRunDefault: true,
    folderQuota: 20,
    perFolderCap: 1000,
    privacy: 1,
    rules: DEFAULT_RULES,
    ...c,
    risk: { ...(c.risk ?? {}) },
    ai: {
      provider: 'deepseek', apiKey: '', model: '', baseUrl: '', chunkSize: 25, concurrency: 2,
      ...(c.ai ?? {}),
    },
  };
};

function broadcast(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of app.sse) { try { res.write(line); } catch { app.sse.delete(res); } }
}

// ---------- 工具 ----------
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};
const ok = (res, body = {}) => json(res, 200, { ok: true, ...body });
const err = (res, message, code = 400) => json(res, code, { ok: false, error: message });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function requireBili(res) {
  if (!app.bili) { err(res, '尚未连接 Chrome，请先在「连接」页点击连接', 409); return false; }
  return true;
}

// 只把计划里必要的字段发给前端，避免几千条 intro/cover 把页面撑爆
const slimItem = (it) => ({ id: it.id, bvid: it.bvid, title: it.title, upper: it.upper, dead: it.dead, srcMediaId: it.srcMediaId, favTime: it.favTime });

// ---------- 路由 ----------
const routes = {
  'GET /api/status': async (req, res) => {
    const c = cfg();
    const p = await probe(c.cdpPort);
    ok(res, {
      chrome: p,
      connected: !!app.bili,
      me: app.me,
      counts: {
        followings: app.followings?.list.length ?? 0,
        followingsTotal: app.followings?.total ?? null,
        truncated: app.followings?.truncated ?? false,
        folders: app.folders.length,
        favItems: [...app.favItems.values()].reduce((a, b) => a + b.length, 0),
        uploadInfo: app.uploadInfo.size,
      },
      job: app.job?.snapshot() ?? null,
      config: { ...c, ai: { ...c.ai, apiKey: c.ai.apiKey ? '••••' + c.ai.apiKey.slice(-4) : '' } },
      dataDir: store.DATA_DIR,
    });
  },

  'POST /api/connect': async (req, res) => {
    const c = cfg();
    try {
      app.cdp?.close();
      app.cdp = await new CdpSession(c.cdpPort).connect();
      app.bili = new Bili(app.cdp);
      app.me = await app.bili.init();
      app.tags = await app.bili.tags();
      broadcast({ type: 'log', level: 'info', msg: '已连接：' + app.me.uname + '（UID ' + app.me.mid + '）' });
      ok(res, { me: app.me, tags: app.tags, page: app.cdp.targetUrl });
    } catch (e) {
      app.cdp = null; app.bili = null; app.me = null;
      err(res, e.message, 502);
    }
  },

  'GET /api/events': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    app.sse.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 20_000);
    req.on('close', () => { clearInterval(ping); app.sse.delete(res); });
  },

  'POST /api/scan/followings': async (req, res) => {
    if (!requireBili(res)) return;
    try {
      broadcast({ type: 'log', msg: '开始拉取关注列表…' });
      const r = await app.bili.followings((n, total) => {
        if (n % 100 === 0) broadcast({ type: 'log', msg: '  已拉取 ' + n + (total ? '/' + total : '') });
      });
      app.followings = r;
      app.special = await app.bili.specialFollowings();
      app.tags = await app.bili.tags();
      store.write('followings.json', r);
      if (r.truncated) {
        broadcast({ type: 'log', level: 'warn', msg: '⚠ 关注列表未拉全：接口只返回了 ' + r.list.length + '/' + (r.total ?? '?') + ' 条'
          + (r.stopCode ? '（停在 code=' + r.stopCode + '）' : '') + '。这是 B 站分页深度限制，不是本工具读完了。' });
      }
      ok(res, { count: r.list.length, total: r.total, truncated: r.truncated, special: app.special.size, tags: app.tags });
    } catch (e) { err(res, e.message, 500); }
  },

  'POST /api/scan/uploads': async (req, res) => {
    if (!requireBili(res)) return;
    const { limit = 300 } = await readBody(req);
    if (!app.followings) return err(res, '请先拉取关注列表');
    const targets = app.followings.list.filter((u) => !app.uploadInfo.has(u.mid)).slice(0, limit);
    broadcast({ type: 'log', msg: '开始探测 ' + targets.length + ' 个 UP 的最近投稿（这一步是读操作，但也会被限流，慢一点）' });
    let done = 0, failed = 0;
    for (const u of targets) {
      try {
        const r = await app.bili.lastUpload(u.mid);
        if (r.ok) app.uploadInfo.set(u.mid, { lastPubTs: r.lastPubTs, count: r.count });
        else failed++;
      } catch { failed++; }
      done++;
      if (done % 20 === 0) broadcast({ type: 'log', msg: '  投稿探测 ' + done + '/' + targets.length });
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 500));
    }
    store.write('uploads.json', [...app.uploadInfo]);
    ok(res, { probed: done, failed, cached: app.uploadInfo.size });
  },

  'POST /api/scan/favorites': async (req, res) => {
    if (!requireBili(res)) return;
    const { mediaIds = null } = await readBody(req);
    try {
      app.folders = await app.bili.favFolders();
      const want = mediaIds?.length ? app.folders.filter((f) => mediaIds.includes(f.id)) : app.folders;
      broadcast({ type: 'log', msg: '开始拉取 ' + want.length + ' 个收藏夹的内容…' });
      for (const f of want) {
        const r = await app.bili.favItems(f.id, (n) => {
          if (n % 100 === 0) broadcast({ type: 'log', msg: '  ' + f.title + '：' + n });
        });
        app.favItems.set(f.id, r.list);
        broadcast({ type: 'log', msg: '  ✓ ' + f.title + '：' + r.list.length + ' 条'
          + (r.error ? '（中断于 code=' + r.error.code + '）' : '') });
      }
      store.write('favorites.json', { folders: app.folders, items: [...app.favItems] });
      ok(res, { folders: app.folders, counts: Object.fromEntries([...app.favItems].map(([k, v]) => [k, v.length])) });
    } catch (e) { err(res, e.message, 500); }
  },

  'POST /api/plan/unfollow': async (req, res) => {
    if (!app.followings) return err(res, '请先拉取关注列表');
    const b = await readBody(req);
    const protectTags = new Set();
    if (b.protectTagIds?.length) {
      for (const u of app.followings.list) {
        const t = u.tags ?? [];
        if (Array.isArray(t) && t.some((x) => b.protectTagIds.includes(x))) protectTags.add(u.mid);
      }
    }
    const p = planUnfollow(app.followings.list, {
      keep: b.keep ?? null,
      special: app.special,
      protectTags,
      inactive: app.uploadInfo,
      inactiveDays: b.inactiveDays ?? null,
      onlyInactive: !!b.onlyInactive,
    });
    app.lastPlan = { kind: 'unfollow', targets: p.targets };
    ok(res, {
      total: p.total, willUnfollow: p.targets.length, kept: p.keptCount,
      byReason: p.summary.byReason,
      preview: p.targets.slice(0, 200).map((u) => ({ mid: u.mid, uname: u.uname, reason: p.reasons.get(u.mid) })),
    });
  },

  'POST /api/plan/fav': async (req, res) => {
    const b = await readBody(req);
    const c = cfg();
    const srcIds = b.sourceIds?.length ? b.sourceIds : [...app.favItems.keys()];
    const items = srcIds.flatMap((id) => (app.favItems.get(id) ?? []).filter((it) => b.includeDead ? true : !it.dead));
    if (!items.length) return err(res, '没有可分类的条目，请先拉取收藏夹内容');

    let assignment, detail, extra = {};
    if (b.method === 'ai') {
      if (!c.ai.apiKey) return err(res, '未配置 AI API Key，请先到设置里填写');
      const cats = b.categories?.length ? b.categories : [...new Set(c.rules.map((r) => r.name))];
      broadcast({ type: 'log', msg: '开始 AI 分类：' + items.length + ' 条，候选分类 ' + cats.length + ' 个' });
      const r = await classifyWithAI(items, cats, c.ai, (p) => {
        broadcast({ type: 'log', msg: '  AI 分类 ' + p.done + '/' + p.total + (p.failedChunks ? '（失败分片 ' + p.failedChunks + '）' : '') });
      });
      assignment = r.assignment; detail = r.detail;
      extra = { failedChunks: r.failedChunks };
    } else {
      const r = classifyAll(items, c.rules, { keepUnmatched: !!b.keepUnmatched });
      assignment = r.assignment; detail = r.detail;
      extra = { unmatched: r.unmatched };
    }

    const fav = planFavClassify(items, assignment, app.folders, {
      folderQuota: c.folderQuota, perFolderCap: c.perFolderCap, mode: b.mode ?? 'copy',
    });
    app.lastPlan = { kind: 'fav', fav, mode: b.mode ?? 'copy' };

    ok(res, {
      ...extra,
      mode: fav.mode, categories: fav.categories, totalItems: fav.totalItems,
      newFolders: fav.newFolders, reusedFolders: fav.reusedFolders,
      warnings: fav.warnings,
      groups: fav.plan.map((p) => ({
        category: p.category, count: p.count, isNew: p.isNew, reuseKind: p.reuseKind,
        existingCount: p.existingCount, overflow: p.overflow,
        sample: p.items.slice(0, 8).map((it) => ({ ...slimItem(it), ...detail.get(it.id) })),
        needReview: p.items.filter((it) => detail.get(it.id)?.ambiguous).length,
      })),
    });
  },

  'POST /api/plan/dead': async (req, res) => {
    const b = await readBody(req);
    const p = planDeadCleanup(app.favItems, { action: b.action ?? 'archive', archiveName: b.archiveName });
    app.lastPlan = { kind: 'dead', dead: p };
    ok(res, {
      action: p.action, archiveName: p.archiveName, total: p.total,
      groups: p.groups.map((g) => ({
        mediaId: g.mediaId,
        folderTitle: app.folders.find((f) => f.id === g.mediaId)?.title ?? String(g.mediaId),
        count: g.count,
        sample: g.items.slice(0, 5).map(slimItem),
      })),
    });
  },

  'POST /api/run': async (req, res) => {
    if (!requireBili(res)) return;
    if (!app.lastPlan) return err(res, '还没有可执行的计划，请先在上面生成一个');
    if (app.job && app.job.status === 'running') return err(res, '已有任务在跑，先停掉它', 409);
    const b = await readBody(req);
    const c = cfg();
    const dryRun = b.dryRun ?? c.dryRunDefault;

    let ops = [];
    const plan = app.lastPlan;
    const folderIds = new Map();

    try {
      if (plan.kind === 'unfollow') {
        if (!dryRun) store.backup('followings', app.followings);
        ops = buildUnfollowOps(app.bili, plan.targets);
      } else if (plan.kind === 'fav') {
        if (!dryRun) store.backup('favorites', { folders: app.folders, items: [...app.favItems] });
        ops = buildFavOps(app.bili, plan.fav, folderIds, { mode: plan.mode, privacy: c.privacy });
      } else if (plan.kind === 'dead') {
        if (!dryRun) store.backup('favorites', { folders: app.folders, items: [...app.favItems] });
        let archiveId = null;
        if (plan.dead.action === 'archive') {
          const exist = app.folders.find((f) => f.title.trim() === plan.dead.archiveName.trim());
          if (exist) archiveId = exist.id;
          else if (!dryRun) {
            const r = await app.bili.createFolder(plan.dead.archiveName, { privacy: c.privacy });
            if (r?.code !== 0) return err(res, '创建归档收藏夹失败：' + (r?.message || r?.code));
            archiveId = r.data.id;
            app.folders.push({ id: archiveId, title: plan.dead.archiveName, count: 0 });
          }
        }
        ops = buildDeadOps(app.bili, plan.dead, archiveId);
      } else if (plan.kind === 'tag') {
        ops = buildTagOps(app.bili, plan.assignments);
      }
    } catch (e) { return err(res, e.message, 500); }

    const job = new Job('job-' + Date.now(), plan.kind, { dryRun, riskOpts: c.risk, resumeKey: plan.kind });
    app.job = job;
    job.on((ev) => broadcast({ scope: 'job', ...ev }));
    ok(res, { started: true, dryRun, opCount: ops.length });
    job.run(ops).catch((e) => {
      job.status = 'error'; job.error = e.message;
      broadcast({ scope: 'job', type: 'log', level: 'error', msg: '任务异常：' + e.message });
    });
  },

  'POST /api/job/stop': async (req, res) => { app.job?.stop(); ok(res); },
  'POST /api/job/pause': async (req, res) => { app.job?.pause(); ok(res); },
  'POST /api/job/resume': async (req, res) => { app.job?.resume(); ok(res); },

  'POST /api/config': async (req, res) => {
    const patch = await readBody(req);
    const cur = cfg();
    // 前端回传的是打码后的 key，别把真 key 覆盖没了
    if (patch.ai && typeof patch.ai.apiKey === 'string' && patch.ai.apiKey.startsWith('••••')) {
      patch.ai.apiKey = cur.ai.apiKey;
    }
    const next = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai ?? {}) }, risk: { ...cur.risk, ...(patch.risk ?? {}) } };
    store.write('config.json', next);
    ok(res, { saved: true });
  },

  'GET /api/backups': async (req, res) => ok(res, { backups: store.listBackups().slice(0, 50) }),

  'POST /api/reset-resume': async (req, res) => {
    const { kind } = await readBody(req);
    store.write('resume-' + kind + '.json', { done: {}, failed: {} });
    ok(res, { cleared: kind });
  },
};

// ---------- 静态文件 ----------
async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, safe);
  if (!file.startsWith(WEB)) return err(res, 'forbidden', 403);
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (handler) {
    try { await handler(req, res); }
    catch (e) { if (!res.headersSent) err(res, e.message, 500); }
    return;
  }
  if (url.pathname.startsWith('/api/')) return err(res, 'not found', 404);
  await serveStatic(url.pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  B 站本地整理台已启动');
  console.log('  打开： http://127.0.0.1:' + PORT);
  console.log('  数据： ' + store.DATA_DIR);
  console.log('');
  console.log('  前提：Chrome 需以调试端口启动，并已登录 B 站。');
  console.log('  没启动的话先跑： npm run chrome');
  console.log('');
});
