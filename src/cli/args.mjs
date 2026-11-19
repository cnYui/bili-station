/**
 * 类型化参数解析与校验。
 *
 * 为什么不沿用原来的 parseArgs：它不知道每个 flag 的类型，所以
 * `folders create --yes "A,B"` 会把位置参数当成 --yes 的值吞掉。
 * 类型已知之后 boolean 永不消费下一个 token，这类错位从根上消失。
 *
 * 第二个作用同样重要：**未知 flag 直接报错**（带最接近的候选名）。
 * agent 拼错参数时必须立刻失败，而不是静默走默认路径 —— 后者是最坏的
 * 失败模式，调用方会以为参数生效了。
 */

/** 每种类型是否需要消费下一个 token */
const CONSUMES = {
  boolean: false,
  string: true,
  int: true,
  float: true,
  enum: true,
  csv: true,
  idList: true,
  midList: true,
  path: true,
  folderRef: true,
  tagRef: true,
};

export const FLAG_TYPES = Object.keys(CONSUMES);

/** 编辑距离，用于「你是不是想输 --folders」 */
function distance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function suggest(name, known) {
  let best = null, bestD = Infinity;
  for (const k of known) {
    const d = distance(name, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  // 距离超过名字长度一半就别瞎猜了
  return bestD <= Math.max(2, Math.ceil(name.length / 2)) ? best : null;
}

function coerce(name, spec, raw) {
  const t = spec.type;
  if (t === 'boolean') return { ok: true, value: raw !== false };

  const s = String(raw).trim();
  if (s === '') return { ok: false, error: `--${name} 需要一个值` };

  if (t === 'int' || t === 'float') {
    const n = t === 'int' ? Number.parseInt(s, 10) : Number.parseFloat(s);
    if (!Number.isFinite(n)) return { ok: false, error: `--${name} 需要一个${t === 'int' ? '整' : ''}数，收到「${s}」` };
    if (spec.min != null && n < spec.min) return { ok: false, error: `--${name} 不能小于 ${spec.min}，收到 ${n}` };
    if (spec.max != null && n > spec.max) return { ok: false, error: `--${name} 不能大于 ${spec.max}，收到 ${n}` };
    return { ok: true, value: n };
  }

  if (t === 'enum') {
    const hit = spec.values.find((v) => v.toLowerCase() === s.toLowerCase());
    if (!hit) {
      return { ok: false, error: `--${name} 只能是 ${spec.values.join(' | ')}，收到「${s}」` };
    }
    return { ok: true, value: hit };
  }

  if (t === 'csv') {
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return { ok: false, error: `--${name} 解析后是空列表` };
    return { ok: true, value: parts };
  }

  if (t === 'idList') {
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    const nums = parts.map(Number);
    const bad = parts.filter((_, i) => !Number.isFinite(nums[i]));
    if (bad.length) return { ok: false, error: `--${name} 里这些不是数字 id：${bad.join(', ')}` };
    if (!nums.length) return { ok: false, error: `--${name} 解析后是空列表` };
    return { ok: true, value: nums };
  }

  if (t === 'midList') {
    // mid 是大整数，一律按字符串处理，避免精度问题
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = parts.filter((x) => !/^\d+$/.test(x));
    if (bad.length) return { ok: false, error: `--${name} 里这些不是合法 UID：${bad.join(', ')}` };
    if (!parts.length) return { ok: false, error: `--${name} 解析后是空列表` };
    return { ok: true, value: parts };
  }

  // string / path / folderRef / tagRef 都原样带走，语义解析留给命令自己
  return { ok: true, value: s };
}

/**
 * @param {string[]} argv          已去掉命令名的参数
 * @param {object}   flagSpecs     { name: {type, ...} }
 * @returns {{positionals: string[], flags: object, errors: Array}}
 */
export function parseArgs(argv, flagSpecs) {
  const positionals = [];
  const flags = {};
  const errors = [];
  const known = Object.keys(flagSpecs);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { positionals.push(a); continue; }

    let name = a.slice(2);
    let inline = null;
    const eq = name.indexOf('=');
    if (eq > 0) { inline = name.slice(eq + 1); name = name.slice(0, eq); }

    // --no-xxx 关闭一个 boolean
    let negate = false;
    if (!flagSpecs[name] && name.startsWith('no-') && flagSpecs[name.slice(3)]?.type === 'boolean') {
      negate = true;
      name = name.slice(3);
    }

    const spec = flagSpecs[name];
    if (!spec) {
      const guess = suggest(name, known);
      errors.push({
        code: 'UNKNOWN_FLAG',
        message: `未知参数 --${name}` + (guess ? `，是不是想写 --${guess}？` : '') + '（--help 看全部）',
      });
      // 未知 flag 后面那个 token 归属不明，保守起见不吞
      continue;
    }

    if (!CONSUMES[spec.type]) {
      if (inline != null) {
        const v = String(inline).toLowerCase();
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(v)) {
          errors.push({ code: 'BAD_VALUE', message: `--${name} 是开关，不接受值「${inline}」` });
          continue;
        }
        flags[name] = ['true', '1', 'yes'].includes(v) !== negate;
      } else {
        flags[name] = !negate;
      }
      continue;
    }

    let raw = inline;
    if (raw == null) {
      const next = argv[i + 1];
      // 关键：只有确实还有下一个 token、且它不是另一个 flag 时才消费
      if (next == null || (next.startsWith('--') && next !== '--')) {
        errors.push({ code: 'MISSING_VALUE', message: `--${name} 后面缺少值` });
        continue;
      }
      raw = next;
      i++;
    }

    const r = coerce(name, spec, raw);
    if (!r.ok) errors.push({ code: 'BAD_VALUE', message: r.error });
    else flags[name] = r.value;
  }

  // 默认值与必填校验
  for (const [name, spec] of Object.entries(flagSpecs)) {
    if (flags[name] === undefined && spec.default !== undefined) flags[name] = spec.default;
    if (spec.required && flags[name] === undefined) {
      errors.push({ code: 'MISSING_FLAG', message: `缺少必填参数 --${name}：${spec.desc ?? ''}`.trim() });
    }
  }

  return { positionals, flags, errors };
}

/** 供 help / schema 用：把一个 flag 的类型渲染成可读形式 */
export function typeHint(spec) {
  switch (spec.type) {
    case 'boolean': return '';
    case 'enum': return spec.values.join('|');
    case 'int': return '<n>';
    case 'float': return '<x>';
    case 'csv': return '<a,b,c>';
    case 'idList': return '<id,...>';
    case 'midList': return '<uid,...>';
    case 'path': return '<file>';
    case 'folderRef': return '<id或名称>';
    case 'tagRef': return '<分组名或id>';
    default: return '<值>';
  }
}
