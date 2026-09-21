/**
 * 统一执行管线：plan → render → 干跑闸门 → 备份 → Job → 信封 → 退出码。
 *
 * 重构前这 15 行样板在 5 个命令里各抄了一遍（cli.mjs 的 219/462/510/607/693）。
 * 现在只有这一份，新的写命令勾 `mutating: true` 就继承全部行为：
 * 干跑默认、强制备份、断点续跑、风控退避、单轮硬上限、语义退出码。
 */
import { Job } from '../executor.mjs';
import { sleep } from '../risk.mjs';
import { connect, store } from './context.mjs';
import { EXIT, emit, jobExit } from './output.mjs';

export async function runCommand(cmd, ctx) {
  if (cmd.needsChrome) await connect(ctx);

  try {
    const r = (await cmd.plan(ctx)) ?? {};

    // 命令自己处理了输出（比如 sort --emit-tasks 直接吐清单给调用方）
    if (r.handled) return r.exit ?? EXIT.OK;

    const data = r.data ?? {};
    const warnings = r.warnings ?? [];

    // 只读命令，或写命令里的只读子命令（如 folders list）：渲染 + 信封，结束
    if (!cmd.mutating || r.readonly) {
      if (!ctx.json) cmd.render?.(r, ctx);
      emit({ command: cmd.name, data, warnings, exit: r.exit ?? EXIT.OK, json: ctx.json, flat: ctx.flat });
      return r.exit ?? EXIT.OK;
    }

    // 写命令
    if (!ctx.json) cmd.render?.(r, ctx);

    if (r.nothing || !(r.ops ?? []).length) {
      if (!ctx.json) ctx.say(r.nothingReason ?? '没有需要执行的操作。');
      emit({ command: cmd.name, data: { ...data, nothing: true, reason: r.nothingReason ?? null }, warnings, exit: EXIT.NOTHING, json: ctx.json, flat: ctx.flat });
      return EXIT.NOTHING;
    }

    if (!ctx.yes) {
      ctx.say('');
      ctx.say(`以上为干跑结果，未做任何修改。加 --yes 才会真正执行（${r.ops.length} 次写操作）。`);
      emit({ command: cmd.name, data: { ...data, plannedWrites: r.ops.length }, warnings, dryRun: true, exit: EXIT.OK, json: ctx.json, flat: ctx.flat });
      return EXIT.OK;
    }

    // 备份：破坏性操作前的快照，带时间戳永不覆盖
    let backupPath = null;
    if (r.backup) {
      backupPath = store.backup(r.backup.kind, r.backup.payload);
      ctx.say(`已备份到 ${backupPath}`);
    }

    // 单轮硬上限（默认 100）挡的是「一次性几百次无间隔写入」。拆成多轮、
    // 轮间留足冷却，正是它本来的用法 —— 所以 --auto-rounds 不是绕过它。
    const cap = ctx.cfg.risk?.hardCapPerRound ?? 100;
    const chunks = (ctx.flags['auto-rounds'] && r.ops.length > cap)
      ? Array.from({ length: Math.ceil(r.ops.length / cap) }, (_, i) => r.ops.slice(i * cap, (i + 1) * cap))
      : [r.ops];

    if (chunks.length > 1) {
      ctx.say(`拆成 ${chunks.length} 轮（每轮 ≤ ${cap} 次），轮间停 ${ctx.flags['round-pause']} 分钟`);
    }

    const totals = { total: 0, done: 0, skipped: 0, failed: 0, riskHits: 0 };
    let snap = null;
    const rounds = [];

    for (let ri = 0; ri < chunks.length; ri++) {
      if (chunks.length > 1) ctx.say(`── 第 ${ri + 1}/${chunks.length} 轮（${chunks[ri].length} 次）`);
      const job = new Job('cli-' + Date.now(), r.jobKind ?? cmd.name, {
        dryRun: false,
        riskOpts: ctx.cfg.risk,
        resumeKey: r.resumeKey ?? cmd.name,
      });
      job.on((ev) => { if (ev.type === 'log' && !ctx.json) ctx.say('  ' + ev.msg); });

      snap = await job.run(chunks[ri]);
      for (const k of Object.keys(totals)) totals[k] += snap.counters[k] ?? 0;
      rounds.push({ round: ri + 1, status: snap.status, ...snap.counters });

      // 撞风控或出错就不再往下跑 —— 硬闯正是这套东西要避免的
      if (snap.status !== 'done') {
        ctx.say(`第 ${ri + 1} 轮以 ${snap.status} 结束，后面 ${chunks.length - ri - 1} 轮不再执行。进度已保存，重跑会跳过已完成项。`);
        break;
      }
      if (ri < chunks.length - 1 && ctx.flags['round-pause'] > 0) {
        ctx.say(`  轮间冷却 ${ctx.flags['round-pause']} 分钟…`);
        await sleep(ctx.flags['round-pause'] * 60_000);
      }
    }

    const exit = jobExit(snap);
    if (chunks.length > 1) snap = { ...snap, counters: totals };

    // 执行后的收尾（比如把新建夹的 名称→id 映射落盘）
    if (exit === EXIT.OK) await r._afterRun?.(ctx);

    emit({
      command: cmd.name,
      data: { ...data, backup: backupPath, result: snap.counters, status: snap.status, error: snap.error, ...(rounds.length > 1 ? { rounds } : {}) },
      warnings, dryRun: false, exit, json: ctx.json, flat: ctx.flat,
    });
    return exit;
  } finally {
    ctx.cdp?.close();
  }
}
