/**
 * help 与 schema 都从注册表生成 —— 声明即文档，漏写在物理上不可能发生。
 *
 * schema 是给 agent 的能力发现接口：不用读 README 就能知道有哪些命令、
 * 每个参数什么类型、枚举值是什么、哪些是写操作。同一份 schema 也是未来
 * 包一层 MCP server 的直接输入（一个命令 = 一个 tool，零额外维护）。
 */
import { allCommands, GLOBAL_FLAGS, CAPABILITY_FLAGS } from './registry.mjs';
import { typeHint } from './args.mjs';
import { EXIT, EXIT_MEANING, ENVELOPE_VERSION } from './output.mjs';

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - [...s].length));

function flagLine(name, spec) {
  const hint = typeHint(spec);
  const head = '--' + name + (hint ? ' ' + hint : '');
  let tail = spec.desc ?? '';
  if (spec.default !== undefined && spec.type !== 'boolean') tail += `（默认 ${spec.default}）`;
  if (spec.required) tail = '【必填】' + tail;
  return '  ' + pad(head, 34) + tail;
}

export function commandHelp(cmd) {
  const out = [];
  out.push(`bili-station ${cmd.name}${cmd.usage ? ' ' + cmd.usage : ''}`);
  out.push('');
  out.push('  ' + cmd.summary);
  if (cmd.mutating) out.push('  写操作：默认干跑，加 --yes 才真正执行。执行前自动快照备份。');
  out.push('');

  if (cmd.subs) {
    out.push('子命令');
    for (const [n, d] of Object.entries(cmd.subs)) out.push('  ' + pad(n, 34) + d);
    out.push('');
  }

  const own = Object.entries(cmd.ownFlags);
  if (own.length) {
    out.push('参数');
    for (const [n, s] of own) out.push(flagLine(n, s));
    out.push('');
  }

  for (const cap of ['mutating', 'ordered', 'selectable']) {
    if (!cmd[cap]) continue;
    out.push({ mutating: '执行', ordered: '排序', selectable: '选择器（外部裁决）' }[cap]);
    for (const [n, s] of Object.entries(CAPABILITY_FLAGS[cap])) out.push(flagLine(n, s));
    out.push('');
  }

  out.push('通用');
  for (const [n, s] of Object.entries(GLOBAL_FLAGS)) out.push(flagLine(n, s));

  if (cmd.examples.length) {
    out.push('');
    out.push('示例');
    for (const e of cmd.examples) out.push('  bili-station ' + e);
  }
  return out.join('\n') + '\n';
}

export function rootHelp() {
  const out = [];
  out.push('bili-station — B 站账号整理 CLI（可被 agent 直接调用）');
  out.push('');
  out.push('命令');
  for (const c of allCommands()) {
    out.push('  ' + pad(c.name + (c.usage ? ' ' + c.usage : ''), 34) + c.summary + (c.mutating ? '  [写]' : ''));
  }
  out.push('');
  out.push('通用');
  for (const [n, s] of Object.entries(GLOBAL_FLAGS)) out.push(flagLine(n, s));
  out.push('');
  out.push('退出码  ' + Object.entries(EXIT_MEANING).map(([k, v]) => `${k} ${v}`).join(' / '));
  out.push('');
  out.push('能力发现   bili-station schema --json       # 全部命令与参数的机器可读定义');
  out.push('单命令用法 bili-station <命令> --help');
  out.push('');
  out.push('给 agent 的典型序列');
  out.push('  bili-station status --json');
  out.push('  bili-station sort --folders "编程,游戏,美食" --limit 50 --json        # 干跑看计划');
  out.push('  bili-station sort --folders "编程,游戏,美食" --limit 50 --yes --json  # 确认后执行');
  return out.join('\n') + '\n';
}

/** 整个 CLI 表面的机器可读定义 */
export function schema() {
  return {
    v: ENVELOPE_VERSION,
    tool: 'bili-station',
    envelope: {
      ok: 'boolean', v: 'number', command: 'string', dryRun: 'boolean|null',
      exit: 'number', data: 'object', warnings: 'array', error: 'object|null',
    },
    exitCodes: Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, { name: k, meaning: EXIT_MEANING[v] }])),
    globalFlags: GLOBAL_FLAGS,
    capabilityFlags: CAPABILITY_FLAGS,
    commands: allCommands().map((c) => ({
      name: c.name,
      aliases: c.aliases,
      summary: c.summary,
      usage: c.usage,
      subs: c.subs,
      mutating: c.mutating,
      needsChrome: c.needsChrome,
      capabilities: ['mutating', 'ordered', 'selectable'].filter((k) => c[k]),
      flags: c.ownFlags,
      examples: c.examples,
    })),
  };
}
