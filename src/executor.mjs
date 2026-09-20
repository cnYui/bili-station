/**
 * 执行器 —— 把计划跑成实际写操作。
 * 所有任务共用一个循环：干跑 / 硬上限 / 风控退避 / 断点续跑 / 撞墙即停 / 实时事件，全在这里统一。
 */
import { RiskEngine, classifyResult, sleep } from './risk.mjs';
import * as store from './store.mjs';
import { chunk, toResource } from './plan.mjs';

export class Job {
  constructor(id, kind, { dryRun = true, riskOpts = {}, resumeKey = null } = {}) {
    this.id = id;
    this.kind = kind;
    this.dryRun = dryRun;
    this.risk = new RiskEngine(riskOpts, store.read('risk-history.json', null));
    this.resumeKey = resumeKey;
    this.state = store.read(this.resumeFile(), { done: {}, failed: {} });
    this.listeners = new Set();
    this.status = 'idle';       // idle | running | paused | stopped | done | error
    this.stopRequested = false;
    this.pauseRequested = false;
    this.counters = { total: 0, done: 0, skipped: 0, failed: 0, riskHits: 0 };
    this.log = [];
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
  }

  resumeFile() { return 'resume-' + (this.resumeKey ?? this.kind) + '.json'; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(type, payload = {}) {
    const ev = { type, at: Date.now(), ...payload };
    if (type === 'log') {
      this.log.push(ev);
      if (this.log.length > 1000) this.log.splice(0, this.log.length - 1000);
    }
    for (const fn of this.listeners) { try { fn(ev); } catch { /* 单个订阅者出错不影响任务 */ } }
  }

  say(msg, level = 'info') { this.emit('log', { level, msg }); }

  snapshot() {
    return {
      id: this.id, kind: this.kind, status: this.status, dryRun: this.dryRun,
      counters: { ...this.counters },
      risk: this.risk.status(),
      startedAt: this.startedAt, finishedAt: this.finishedAt,
      error: this.error,
      recentLog: this.log.slice(-60),
    };
  }

  stop() { this.stopRequested = true; this.say('收到停止请求，将在当前操作后停下', 'warn'); }
  pause() { this.pauseRequested = true; this.say('已暂停', 'warn'); }
  resume() { this.pauseRequested = false; this.say('已继续'); }

  async waitIfPaused() {
    while (this.pauseRequested && !this.stopRequested) {
      this.status = 'paused';
      await sleep(400);
    }
    if (!this.stopRequested) this.status = 'running';
  }

  persist() {
    store.write(this.resumeFile(), this.state);
    store.write('risk-history.json', this.risk.toJSON());
  }

  /**
   * 通用执行循环。
   * @param {Array} ops  [{ key, label, op, run: async () => apiResponseBody }]
   *                     key 用于断点续跑去重；op 用于热度权重
   */
  async run(ops) {
    this.startedAt = Date.now();
    this.status = 'running';
    this.counters.total = ops.length;

    const cap = this.risk.checkRoundCap(ops.length);
    if (!cap.ok && !this.dryRun) {
      this.status = 'error';
      this.error = cap.reason;
      this.say(cap.reason, 'error');
      this.finishedAt = Date.now();
      this.emit('end', this.snapshot());
      return this.snapshot();
    }

    if (this.dryRun) {
      this.say('【干跑】以下 ' + ops.length + ' 项只预览，不会真正执行：', 'warn');
      for (const o of ops.slice(0, 50)) this.say('  · ' + o.label);
      if (ops.length > 50) this.say('  … 其余 ' + (ops.length - 50) + ' 项省略');
      this.counters.done = ops.length;
      this.status = 'done';
      this.finishedAt = Date.now();
      this.emit('end', this.snapshot());
      return this.snapshot();
    }

    let sinceBatch = 0;

    for (let i = 0; i < ops.length; i++) {
      if (this.stopRequested) { this.say('已按请求停止', 'warn'); break; }
      await this.waitIfPaused();
      if (this.stopRequested) break;

      const o = ops[i];
      if (o.key && this.state.done[o.key]) {
        this.counters.skipped++;
        continue;
      }

      await this.risk.waitCooldown((remain) => {
        if (remain % 5000 < 1100) this.say('全局冷却中，剩余 ' + Math.ceil(remain / 1000) + 's', 'warn');
      });

      let settled = false;
      for (let attempt = 1; attempt <= this.risk.opt.maxRetry && !settled; attempt++) {
        let body;
        try {
          body = await o.run();
        } catch (e) {
          this.say('请求异常（' + o.label + '）：' + e.message, 'error');
          await sleep(3000);
          continue;
        }

        const verdict = classifyResult(body);

        if (verdict.kind === 'ok') {
          settled = true;
          this.counters.done++;
          if (o.key) this.state.done[o.key] = { label: o.label, at: new Date().toISOString() };
          delete this.state.failed[o.key];
          this.risk.onSuccess();
          this.risk.record(o.op ?? 'unfollow', o.weight ?? 1);
          this.say('✓ ' + o.label);
        } else if (verdict.kind === 'risk') {
          this.counters.riskHits++;
          const cooldown = this.risk.onRateLimit();
          this.say('命中风控 code=' + verdict.code + '（' + (verdict.message || '') + '）', 'error');
          if (this.risk.opt.stopOnRisk) {
            this.say('已按「撞墙即停」策略中止本轮，避免升级为更严格的限制。进度已保存，稍后重跑会自动跳过已完成项。', 'error');
            this.stopRequested = true;
            break;
          }
          this.say('退避 ' + Math.round(cooldown / 1000) + 's 后重试（第 ' + attempt + ' 次）', 'warn');
          await this.risk.waitCooldown();
        } else if (verdict.kind === 'auth') {
          this.error = '登录态失效（code=' + verdict.code + '）。进度已保存，请在 Chrome 里重新登录 B 站后重跑。';
          this.say(this.error, 'error');
          this.persist();
          this.status = 'error';
          this.finishedAt = Date.now();
          this.emit('end', this.snapshot());
          return this.snapshot();
        } else {
          settled = true;
          this.counters.failed++;
          if (o.key) this.state.failed[o.key] = { label: o.label, code: verdict.code, message: verdict.message };
          this.say('✗ ' + o.label + '：code=' + verdict.code + ' ' + (verdict.message || ''), 'error');
        }
      }

      if (!settled && !this.stopRequested) {
        this.counters.failed++;
        if (o.key) this.state.failed[o.key] = { label: o.label, reason: '重试耗尽' };
      }

      if ((i + 1) % 10 === 0) this.persist();
      this.emit('progress', { done: this.counters.done, total: ops.length, index: i + 1 });

      sinceBatch++;
      if (sinceBatch >= this.risk.opt.batchSize && i < ops.length - 1) {
        sinceBatch = 0;
        const pause = this.risk.opt.batchPauseMs + this.risk.levelPauseMs();
        this.say('批次间歇 ' + Math.round(pause / 1000) + 's（热度 ' + this.risk.status().heat + '/100）');
        await sleep(pause);
      } else if (i < ops.length - 1) {
        await sleep(this.risk.nextDelayMs());
      }
    }

    this.persist();
    this.status = this.stopRequested ? 'stopped' : 'done';
    this.finishedAt = Date.now();
    this.say('结束：成功 ' + this.counters.done + ' / 失败 ' + this.counters.failed
      + ' / 跳过 ' + this.counters.skipped + ' / 风控 ' + this.counters.riskHits);
    this.emit('end', this.snapshot());
    return this.snapshot();
  }
}

// ---------- 各任务的 ops 构造 ----------

/** 取关 */
export function buildUnfollowOps(bili, targets) {
  return targets.map((u) => ({
    key: 'unfollow:' + u.mid,
    label: '取关 ' + u.uname + '（UID ' + u.mid + '）',
    op: 'unfollow',
    run: () => bili.unfollow(u.mid),
  }));
}

/** 批量打分组标签：一次最多塞一批 mid */
export function buildTagOps(bili, assignments, batchSize = 20) {
  const ops = [];
  for (const [tagId, mids] of assignments) {
    for (const part of chunk(mids, batchSize)) {
      ops.push({
        key: 'tag:' + tagId + ':' + part.join('_'),
        label: '将 ' + part.length + ' 个 UP 加入分组 ' + tagId,
        op: 'tagAdd',
        weight: part.length,
        run: () => bili.addUsersToTag(part, [tagId]),
      });
    }
  }
  return ops;
}

/**
 * 收藏夹分类：先建所需的新夹，再按批移动/复制。
 * folderIds 是一个 Map<分类名, mediaId>，执行中会被就地补全（新建的夹回填进去）。
 */
export function buildFavOps(bili, favPlan, folderIds, { mode = 'copy', moveChunk = 20, privacy = 1 } = {}) {
  const ops = [];
  // 建夹的幂等性靠「这个名字的夹是不是真的存在」来保证，而不是靠断点文件。
  // 否则断点说建过了、夹其实不在（被手动删了 / 建到一半失败），后续移动会全部落空。
  // 所以这些 op 不带 key（不参与断点跳过），每次都先查一次再决定建不建。
  let freshFolders = null;
  const lookup = async (title) => {
    if (!freshFolders) freshFolders = await bili.favFolders();
    const k = title.trim().toLowerCase();
    return freshFolders.find((f) => f.title.trim().toLowerCase() === k) ?? null;
  };

  for (const p of favPlan.plan) {
    if (p.isNew) {
      ops.push({
        label: '新建收藏夹「' + p.category + '」' + (privacy === 1 ? '（私密）' : '（公开）'),
        op: 'folderAdd',
        run: async () => {
          const hit = await lookup(p.category);
          if (hit) {
            folderIds.set(p.category, hit.id);
            return { code: 0, data: { id: hit.id }, _reused: true };
          }
          const body = await bili.createFolder(p.category, { privacy });
          if (body?.code === 0 && body.data?.id) {
            folderIds.set(p.category, body.data.id);
            freshFolders?.push({ id: body.data.id, title: p.category, count: 0 });
          }
          return body;
        },
      });
    } else {
      folderIds.set(p.category, p.targetId);
    }
  }
  for (const p of favPlan.plan) {
    // 同一批里可能混着来自不同源收藏夹的条目，move 接口要求 src 单一，所以按源分组
    const bySrc = new Map();
    for (const it of p.items) {
      const src = it.srcMediaId;
      if (!bySrc.has(src)) bySrc.set(src, []);
      bySrc.get(src).push(it);
    }
    for (const [src, list] of bySrc) {
      for (const part of chunk(list, moveChunk)) {
        ops.push({
          key: (mode === 'move' ? 'mv:' : 'cp:') + src + ':' + p.category + ':' + part.map((x) => x.id).join('_'),
          label: (mode === 'move' ? '移动 ' : '复制 ') + part.length + ' 条到「' + p.category + '」',
          op: 'favMove',
          weight: 1,
          run: async () => {
            const tar = folderIds.get(p.category);
            if (!tar) return { code: -1, message: '目标收藏夹「' + p.category + '」尚未创建成功，跳过' };
            const res = part.map(toResource);
            return mode === 'move'
              ? bili.moveResources(src, tar, res)
              : bili.copyResources(src, tar, res);
          },
        });
      }
    }
  }
  return ops;
}

/** 失效视频清理 */
export function buildDeadOps(bili, deadPlan, archiveId, { delChunk = 20 } = {}) {
  const ops = [];
  for (const g of deadPlan.groups) {
    for (const part of chunk(g.items, delChunk)) {
      const res = part.map(toResource);
      ops.push({
        key: deadPlan.action + ':' + g.mediaId + ':' + part.map((x) => x.id).join('_'),
        label: (deadPlan.action === 'archive' ? '归档 ' : '移除 ') + part.length + ' 条失效视频（源夹 ' + g.mediaId + '）',
        op: 'favDeal',
        run: () => deadPlan.action === 'archive'
          ? bili.moveResources(g.mediaId, archiveId, res)
          : bili.batchDel(g.mediaId, res),
      });
    }
  }
  return ops;
}

/**
 * 合并：把来源夹的条目搬进目标夹。
 * 失效条目单独成批 —— 万一接口拒收失效条目，不会把同批的正常视频一起拖下水。
 */
export function buildMergeOps(bili, mergePlan, { chunkSize = 20 } = {}) {
  const ops = [];
  const tar = mergePlan.target.id;
  for (const g of mergePlan.groups) {
    const batches = [
      ...chunk(g.live, chunkSize).map((part) => ({ part, dead: false })),
      ...chunk(g.dead, chunkSize).map((part) => ({ part, dead: true })),
    ];
    for (const { part, dead } of batches) {
      ops.push({
        key: 'merge:' + g.srcId + '->' + tar + ':' + part.map((x) => x.id).join('_'),
        label: '从「' + g.srcTitle + '」搬 ' + part.length + ' 条' + (dead ? '（失效条目）' : '') + '到「' + mergePlan.target.title + '」',
        op: 'favMove',
        run: () => bili.moveResources(g.srcId, tar, part.map(toResource)),
      });
    }
  }
  return ops;
}

/**
 * 收藏夹布局：把现有夹改名复用 + 新建缺的。
 * 改名和新建都是 folder 级写操作，风控权重最高，所以单独成 op、逐个做。
 * @param {Array} renames [{id, from, to}]
 * @param {Array} creates [name]
 * @param {Map}   folderIds 就地回填 名称 -> id
 */
export function buildLayoutOps(bili, renames, creates, folderIds, { privacy = 1 } = {}) {
  const ops = [];
  for (const r of renames) {
    ops.push({
      key: 'rename:' + r.id + ':' + r.to,
      label: '改名「' + r.from + '」→「' + r.to + '」(id ' + r.id + ')',
      op: 'folderAdd',
      run: async () => {
        const body = await bili.renameFolder(r.id, r.to, { privacy });
        if (body?.code === 0) folderIds.set(r.to, r.id);
        return body;
      },
    });
  }
  for (const name of creates) {
    ops.push({
      label: '新建收藏夹「' + name + '」',
      op: 'folderAdd',
      run: async () => {
        // 幂等：先看是不是已经存在（重跑 / 上次建到一半）
        const fresh = await bili.favFolders();
        const hit = fresh.find((f) => f.title.trim().toLowerCase() === name.trim().toLowerCase());
        if (hit) { folderIds.set(name, hit.id); return { code: 0, data: { id: hit.id }, _reused: true }; }
        const body = await bili.createFolder(name, { privacy });
        if (body?.code === 0 && body.data?.id) folderIds.set(name, body.data.id);
        return body;
      },
    });
  }
  return ops;
}
