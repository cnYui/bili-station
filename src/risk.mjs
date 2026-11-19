/**
 * 风控引擎 —— 把 12 个同类项目里各自只做对一半的做法合成一套。
 *
 *  1. 错误码语义分流        来自 bili-unfollow：风控码值得退避重试，登录码退多久都没用
 *  2. 衰减滑窗热度模型      来自 bilibili-following-manager 的「风控日历」
 *  3. AIMD 自适应快降慢升   来自 Bilibili-AI-Favorites-Organizer
 *  4. 单轮写操作硬上限      来自 following-manager 的社区实测（>500 无延迟 = 必风控）
 *  5. 随机抖动而非固定节奏  来自 bilibili-unfollow（固定 250ms 本身就是机器特征）
 *  6. 撞墙即停而非硬闯      来自 bilibili-unfollow 的 stop-to-avoid-stricter-limits
 */

/** 风控 / 频控：等一等有用 */
export const RISK_CODES = new Set([-352, -412, -509, -799, -503]);
/** 登录态失效：等多久都没用，必须立刻停并保存进度 */
export const AUTH_CODES = new Set([-101, -111]);

export const DEFAULTS = {
  minDelayMs: 1800,
  maxDelayMs: 3500,
  minFloorMs: 800,      // AIMD 放开的下限
  maxCeilMs: 30_000,    // AIMD 收紧的上限
  batchSize: 20,        // 每多少次写操作歇一次
  batchPauseMs: 8_000,
  hardCapPerRound: 100, // 单轮写操作硬上限
  backoffBaseMs: 60_000,
  maxRetry: 3,
  stopOnRisk: true,     // 撞风控直接停整轮，而不是硬闯
};

const HALF_LIFE_MIN = 45;               // 热度半衰期
const TAU = HALF_LIFE_MIN / Math.LN2;   // 指数衰减时间常数（分钟）

/** 不同写操作对账号热度的权重 */
const OP_WEIGHT = {
  unfollow: 1.0,
  follow: 1.4,      // 关注比取关更敏感：批量关注是典型的养号行为特征
  quietFollow: 1.4,
  favMove: 0.8,
  favDeal: 0.8,
  folderAdd: 2.5,   // 建收藏夹最敏感，连续建极易触发
  tagAdd: 1.0,
  tagEdit: 1.2,     // 建/改/删分组是账号结构变更，比往分组里塞人重
};

/**
 * 读操作**不计入热度**，单独按速率管。
 *
 * 这是实测逼出来的分离。读和写是两套完全不同的预算：
 *   · 读：50 次/分连跑 60 次零失败，65.5 次/分开始撞 -412，约 16 分钟自动解除
 *   · 写：同一天里以 20 次/分连做 66 次取关，风控码 0
 * 把两者加进同一个 0–100 的表里，一次 4000 次的只读扫描就能把热度顶到 100，
 * 让紧接着的写操作被毫无道理地拖慢 —— 这正是「先验不该当门槛」那条教训的翻版，
 * 而且这里的先验还是把两种不同的量硬加在一起。
 *
 * 所以：热度只反映写操作；读用 readPerMin 单独观测，阈值来自实测。
 */
export const READ_OPS = new Set(['read']);

/** 实测安全读速率上限（次/分）。65.5 次/分会撞墙，这里留了余量。 */
export const READ_SAFE_PER_MIN = 50;

/** 读速率的观测窗口（分钟） */
const READ_WINDOW_MIN = 5;

export class RiskEngine {
  /** @param {object} persisted 之前存下来的 { events: [{t, op, n}] } */
  constructor(opts = {}, persisted = null) {
    this.opt = { ...DEFAULTS, ...opts };
    this.events = persisted?.events ?? [];
    this.curDelay = this.opt.minDelayMs;
    this.riskHits = 0;
    this.successStreak = 0;
    this.cooldownUntil = 0;
    this.roundWrites = 0;
  }

  /** 记一次写操作，用于热度模型 */
  record(op, n = 1) {
    this.events.push({ t: Date.now(), op, n });
    const cutoff = Date.now() - 24 * 3600_000;
    if (this.events.length > 4000) this.events = this.events.filter((e) => e.t >= cutoff);
  }

  /** 0–100 的账号写操作热度 + green/yellow/orange/red 分级 */
  status(now = Date.now()) {
    let heat = 0;
    let readsInWindow = 0;
    const totals = {};
    for (const e of this.events) {
      const dtMin = (now - e.t) / 60_000;
      if (dtMin < 0 || dtMin > 24 * 60) continue;
      totals[e.op] = (totals[e.op] ?? 0) + e.n;
      if (READ_OPS.has(e.op)) {
        // 读不进热度，只统计最近窗口内的速率
        if (dtMin <= READ_WINDOW_MIN) readsInWindow += e.n;
        continue;
      }
      const w = OP_WEIGHT[e.op] ?? 1;
      heat += w * Math.exp(-dtMin / TAU) * e.n;
    }
    heat = Math.min(100, heat);
    const readPerMin = readsInWindow / READ_WINDOW_MIN;
    const level = heat < 30 ? 'green' : heat < 60 ? 'yellow' : heat < 80 ? 'orange' : 'red';
    const lastRisk = this.events.filter((e) => e.op === '_risk').at(-1);
    return {
      heat: Math.round(heat),
      level,
      readPerMin: Math.round(readPerMin * 10) / 10,
      readSafeMax: READ_SAFE_PER_MIN,
      readTooFast: readPerMin > READ_SAFE_PER_MIN,
      totals24h: totals,
      lastRiskAgeMin: lastRisk ? Math.round((now - lastRisk.t) / 60_000) : null,
      curDelayMs: Math.round(this.curDelay),
      riskHits: this.riskHits,
      cooldownRemainMs: Math.max(0, this.cooldownUntil - now),
    };
  }

  /** 热度越高，块间额外静默越久 */
  levelPauseMs(level = this.status().level) {
    return { green: 0, yellow: 1500, orange: 3000, red: 10_000 }[level] ?? 0;
  }

  /** 单次操作之间该睡多久：当前 AIMD 延迟 + 随机抖动 + 热度附加 */
  nextDelayMs() {
    const st = this.status();
    const jitter = Math.random() * (this.opt.maxDelayMs - this.opt.minDelayMs);
    return Math.round(this.curDelay + jitter + this.levelPauseMs(st.level));
  }

  /** AIMD：撞限流 → 延迟翻倍 + 进入全局冷却（60s × 命中次数，封顶 180s） */
  onRateLimit() {
    this.riskHits += 1;
    this.successStreak = 0;
    this.curDelay = Math.min(this.opt.maxCeilMs, this.curDelay * 2);
    const cooldown = Math.min(180_000, this.riskHits * 60_000);
    this.cooldownUntil = Date.now() + cooldown;
    this.events.push({ t: Date.now(), op: '_risk', n: 1 });
    return cooldown;
  }

  /** AIMD：连续成功 5 次 → 延迟 ×0.85 慢慢放开 */
  onSuccess() {
    this.successStreak += 1;
    if (this.successStreak >= 5 && this.curDelay > this.opt.minFloorMs) {
      this.curDelay = Math.max(this.opt.minFloorMs, this.curDelay * 0.85);
      this.successStreak = 0;
    }
  }

  async waitCooldown(onTick) {
    while (Date.now() < this.cooldownUntil) {
      const remain = this.cooldownUntil - Date.now();
      onTick?.(remain);
      await sleep(Math.min(1000, remain));
    }
  }

  /** 单轮写操作硬上限检查 */
  checkRoundCap(count) {
    if (count > this.opt.hardCapPerRound) {
      return {
        ok: false,
        reason: `单轮写操作 ${count} 次超过硬上限 ${this.opt.hardCapPerRound}。`
          + `社区实测：一次 500+ 无延迟写入几乎必然触发账号级风控（部分账号被强制实名数天）。`
          + `请拆分多轮执行。`,
      };
    }
    return { ok: true };
  }

  toJSON() { return { events: this.events }; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一次 API 返回归类成 ok / risk / auth / fail */
export function classifyResult(body) {
  const code = body?.code;
  if (code === 0) return { kind: 'ok' };
  if (RISK_CODES.has(code)) return { kind: 'risk', code, message: body?.message };
  if (AUTH_CODES.has(code)) return { kind: 'auth', code, message: body?.message };
  return { kind: 'fail', code, message: body?.message };
}
