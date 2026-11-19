/**
 * 命令注册表 —— 参数的唯一真源。
 *
 * 一个 flag 的存在性以前散在三处（解析器隐式接受 / 命令体现场解释 / help 手写文本），
 * 所以加参数要改 3 个地方，漏一处就静默不一致（重构前 help 已经漏了 5 个）。
 * 现在声明一次，解析、校验、help、schema 全部由它生成，物理上不可能再漏。
 *
 * 能力开关（capability）是第二个要点：勾一个开关就自动获得一组共享 flag +
 * 一段 runner 行为。新命令是勾开关，不是复制样板。
 */

/** 所有命令都有的 flag */
export const GLOBAL_FLAGS = {
  json: { type: 'boolean', desc: 'stdout 只输出 JSON 信封，人类日志走 stderr' },
  'json-flat': { type: 'boolean', desc: '旧版扁平 JSON 形状（兼容重构前的调用脚本）' },
  quiet: { type: 'boolean', desc: '不输出人类可读日志' },
  help: { type: 'boolean', desc: '看这个命令的用法' },
  'data-dir': { type: 'path', desc: '覆盖数据目录（等价于 BILI_STATION_DIR）' },
  'cdp-port': { type: 'int', min: 1, max: 65535, desc: 'Chrome 调试端口，覆盖配置文件' },
};

/**
 * 能力开关注入的 flag。
 * mutating   → 干跑闸门 + 强制备份 + Job 执行 + 语义退出码
 * ordered    → 提交前按时间重排（见 plan.mjs orderItems 的注释）
 * selectable → 候选清单 / 外部回填 / 受保护对象硬护栏
 */
export const CAPABILITY_FLAGS = {
  mutating: {
    yes: { type: 'boolean', desc: '真正执行。不加则一律干跑，只打印计划' },
    'auto-rounds': {
      type: 'boolean',
      desc: '写操作超过单轮硬上限时自动拆轮连续执行。硬上限是防「一次性几百次无间隔写入」'
        + '的，多轮之间留足冷却就是它本来的用法',
    },
    'round-pause': { type: 'int', min: 0, max: 60, default: 5, desc: '自动拆轮时每轮之间停多少分钟' },
  },
  ordered: {
    order: {
      type: 'enum',
      values: ['original', 'reverse', 'pubdate', 'as-scanned'],
      default: 'original',
      desc: '新夹里的排列顺序：original=和原来一致（最近收藏的在最上面）/ reverse=反过来 / pubdate=按投稿时间 / as-scanned=重构前的行为',
    },
    'order-scope': {
      type: 'enum',
      values: ['per-source', 'global'],
      default: 'per-source',
      desc: 'per-source=每个来源夹内部有序，调用次数不变；global=全局严格有序，来源交错处会多出碎块',
    },
    'chunk-size': {
      type: 'int', min: 1, max: 20, default: 20,
      desc: '每批多少条。调到 1 可以做到逐条精确排序，代价是 20 倍调用次数',
    },
  },
  selectable: {
    'emit-candidates': { type: 'path', desc: '把候选清单写到文件，交给调用方（你 / agent）裁决' },
    apply: { type: 'path', desc: '回填裁决结果：{"<id>":"<理由>"}。不在候选清单里的一律拒收' },
    'max-select': { type: 'int', min: 1, desc: '单次最多选中多少个，超出即拒绝整份回填' },
    'allow-protected': { type: 'boolean', desc: '允许选中受保护对象（特别关注等）。默认硬拒绝' },
  },
};

const registry = new Map();

/**
 * @param {object} spec
 *   name        命令名
 *   summary     一句话说明
 *   aliases     别名
 *   needsChrome 是否需要连 Chrome（自动 connect / finally close）
 *   mutating    是否写操作
 *   ordered     是否受提交顺序影响
 *   selectable  是否支持外部裁决选择器
 *   subs        子命令说明 { name: desc }
 *   usage       位置参数用法串
 *   flags       专属 flag
 *   examples    示例
 *   plan(ctx)   只读、只算，返回 { data, ops?, backup?, nothing?, jobKind?, resumeKey? }
 *   render(r, ctx) 人类可读输出
 */
export function defineCommand(spec) {
  if (!spec.name) throw new Error('命令必须有 name');
  if (typeof spec.plan !== 'function') throw new Error(`命令 ${spec.name} 缺少 plan()`);

  const flags = { ...(spec.flags ?? {}) };
  for (const cap of ['mutating', 'ordered', 'selectable']) {
    if (spec[cap]) Object.assign(flags, CAPABILITY_FLAGS[cap]);
  }
  Object.assign(flags, GLOBAL_FLAGS);

  return {
    aliases: [],
    subs: null,
    usage: '',
    examples: [],
    needsChrome: false,
    mutating: false,
    ordered: false,
    selectable: false,
    render: null,
    ...spec,
    flags,
    ownFlags: spec.flags ?? {},
  };
}

export function register(cmd) {
  registry.set(cmd.name, cmd);
  for (const a of cmd.aliases) registry.set(a, cmd);
  return cmd;
}

export function lookup(name) { return registry.get(name) ?? null; }

/** 去重后的命令列表，按注册顺序 */
export function allCommands() {
  const seen = new Set();
  const out = [];
  for (const cmd of registry.values()) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

export function commandNames() { return [...registry.keys()]; }
