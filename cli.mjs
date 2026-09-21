#!/usr/bin/env node
/**
 * bili-station CLI —— 设计成可被 Claude / Codex 这类 agent 直接调用。
 *
 * agent 友好的约定：
 *   · --json 时 stdout 只有一个 JSON 信封，所有人类可读日志走 stderr
 *   · 从不交互提问；破坏性操作默认干跑，必须显式 --yes
 *   · 退出码有语义：0 成功 / 1 一般错误 / 2 风控中止 / 3 登录失效 / 4 无事可做 / 5 参数错误
 *   · 参数写错立刻失败（带最接近的候选名），绝不静默走默认路径
 *   · 同一条命令重复跑是安全的（断点续跑会跳过已完成项）
 *   · `schema --json` 吐出全部命令与参数的机器可读定义，不用读 README
 *
 * 这个文件只负责：解析 → 校验 → 分发 → 统一收尾。
 * 命令本身在 src/cli/commands/，管线在 src/cli/runner.mjs。
 */

// --data-dir 必须在 store.mjs 被导入之前生效（DATA_DIR 在模块加载时就算好了），
// 所以这里先扫一遍 argv，再动态 import 其余模块。
const rawArgv = process.argv.slice(2);
{
  const i = rawArgv.findIndex((a) => a === '--data-dir' || a.startsWith('--data-dir='));
  if (i >= 0) {
    const v = rawArgv[i].includes('=') ? rawArgv[i].split('=').slice(1).join('=') : rawArgv[i + 1];
    if (v && !v.startsWith('--')) process.env.BILI_STATION_DIR = v;
  }
}

const { parseArgs } = await import('./src/cli/args.mjs');
const { register, lookup, allCommands } = await import('./src/cli/registry.mjs');
const { EXIT, makeSay, emit, fail } = await import('./src/cli/output.mjs');
const { loadConfig } = await import('./src/cli/context.mjs');
const { runCommand } = await import('./src/cli/runner.mjs');
const { rootHelp, commandHelp, schema } = await import('./src/cli/help.mjs');

for (const m of ['status', 'folders', 'scan', 'sort', 'merge', 'dead', 'follow', 'unfollow', 'probe']) {
  register((await import(`./src/cli/commands/${m}.mjs`)).default);
}

// ---------- 分发 ----------
const name = rawArgv[0] && !rawArgv[0].startsWith('--') ? rawArgv[0] : null;

// help / schema 不走注册表管线：它们不需要配置也不需要 Chrome
if (!name || name === 'help') {
  const target = rawArgv[1] ? lookup(rawArgv[1]) : null;
  process.stdout.write(target ? commandHelp(target) : rootHelp());
  process.exit(EXIT.OK);
}
if (name === 'schema') {
  const wantJson = rawArgv.includes('--json');
  const s = schema();
  if (wantJson) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  else {
    process.stdout.write(`bili-station schema v${s.v} —— ${s.commands.length} 个命令\n`);
    for (const c of s.commands) {
      process.stdout.write(`  ${c.name.padEnd(10)} ${c.summary}${c.capabilities.length ? '  [' + c.capabilities.join(',') + ']' : ''}\n`);
    }
    process.stdout.write('\n完整定义：bili-station schema --json\n');
  }
  process.exit(EXIT.OK);
}

const cmd = lookup(name);
if (!cmd) {
  const names = allCommands().map((c) => c.name).join(' / ');
  fail({ message: `未知命令：${name}。可用：${names}。用 --help 看用法。`, code: EXIT.USAGE, json: rawArgv.includes('--json') });
}

// ---------- 解析与校验 ----------
const { positionals, flags, errors } = parseArgs(rawArgv.slice(1), cmd.flags);
const json = !!flags.json || !!flags['json-flat'];
const flat = !!flags['json-flat'];

if (flags.help) {
  process.stdout.write(commandHelp(cmd));
  process.exit(EXIT.OK);
}

if (errors.length) {
  fail({
    command: cmd.name,
    message: errors.map((e) => e.message).join('；'),
    code: EXIT.USAGE, json, flat,
    detail: { errors },
  });
}

// ---------- 上下文 ----------
const say = makeSay(!!flags.quiet || false);
const ctx = {
  argv: rawArgv, positionals, flags, json, flat,
  yes: !!flags.yes,
  quiet: !!flags.quiet,
  say,
  cfg: loadConfig({ cdpPort: flags['cdp-port'] }),
  cdp: null, bili: null, me: null,
  /** 参数用错了：抛出带 USAGE 退出码的错误，由下面统一收口 */
  usageError(message) {
    const e = new Error(message);
    e.exitCode = EXIT.USAGE;
    throw e;
  },
};

// ---------- 执行 ----------
try {
  process.exit(await runCommand(cmd, ctx));
} catch (e) {
  try { ctx.cdp?.close(); } catch { /* 已经关了就算了 */ }
  const code = e.exitCode
    ?? (/登录态失效|未登录|Cookie/.test(e.message ?? '') ? EXIT.AUTH : EXIT.ERROR);
  fail({ command: cmd.name, message: e.message ?? String(e), code, json, flat });
}
