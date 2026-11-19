/**
 * 输出层：人类日志走 stderr，机器可读的 JSON 信封走 stdout。
 *
 * 信封是给 agent 的契约：所有命令同形，带版本号。重构前每个命令一个形状，
 * 调用方得为 7 个命令写 7 套解析。
 */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  RISK: 2,
  AUTH: 3,
  NOTHING: 4,
  USAGE: 5,      // 参数写错了 —— 对 agent 来说这是可自我纠正的失败，必须和运行时错误区分开
};

export const EXIT_MEANING = {
  0: '成功',
  1: '一般错误',
  2: '风控中止',
  3: '登录失效',
  4: '无事可做',
  5: '参数错误（可修正后重试）',
};

export const ENVELOPE_VERSION = 1;

/** 人类日志。全部走 stderr，保证 --json 时 stdout 只有一个 JSON 对象。 */
export function makeSay(quiet) {
  return (...m) => { if (!quiet) process.stderr.write(m.join(' ') + '\n'); };
}

/**
 * 输出结果信封。
 * @param {object} o
 *   command  命令名
 *   data     业务负载
 *   warnings [{code, message}]
 *   dryRun   是否干跑
 *   exit     退出码
 *   json     是否输出 JSON
 *   flat     旧版扁平形状（兼容用）
 */
export function emit({ command, data = {}, warnings = [], dryRun = null, exit = EXIT.OK, json = false, flat = false }) {
  if (!json) return;
  if (flat) {
    // 重构前的形状：ok 与业务字段平铺
    process.stdout.write(JSON.stringify({ ok: exit === EXIT.OK || exit === EXIT.NOTHING, ...(dryRun == null ? {} : { dryRun }), ...data }, null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: exit === EXIT.OK || exit === EXIT.NOTHING,
    v: ENVELOPE_VERSION,
    command,
    dryRun,
    exit,
    data,
    warnings,
    error: null,
  }, null, 2) + '\n');
}

/** 输出错误信封并退出。 */
export function fail({ command = null, message, code = EXIT.ERROR, json = false, flat = false, detail = null, quiet = false }) {
  if (json) {
    process.stdout.write(flat
      ? JSON.stringify({ ok: false, error: message }, null, 2) + '\n'
      : JSON.stringify({
        ok: false, v: ENVELOPE_VERSION, command, dryRun: null, exit: code,
        data: detail ?? {}, warnings: [], error: { code: codeName(code), message },
      }, null, 2) + '\n');
  } else if (!quiet) {
    process.stderr.write('错误：' + message + '\n');
  }
  process.exit(code);
}

function codeName(code) {
  return Object.entries(EXIT).find(([, v]) => v === code)?.[0] ?? 'ERROR';
}

/** Job 结束状态 → 退出码 */
export function jobExit(snap) {
  if (snap.status === 'error' && /登录态失效/.test(snap.error ?? '')) return EXIT.AUTH;
  if (snap.status === 'stopped') return EXIT.RISK;
  if (snap.status === 'error') return EXIT.ERROR;
  return EXIT.OK;
}
