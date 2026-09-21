import { defineCommand } from '../registry.mjs';
import { connect, loadProbes, store } from '../context.mjs';
import { probe } from '../../cdp.mjs';
import { EXIT } from '../output.mjs';

export default defineCommand({
  name: 'status',
  summary: '检查 Chrome 连接 / 登录态 / 收藏夹 / AI 配置 / 探针结果',
  // 端口不通时也要能给出有意义的输出，所以自己 probe 而不是让 runner 硬连
  needsChrome: false,
  examples: ['status --json'],

  async plan(ctx) {
    const p = await probe(ctx.cfg.cdpPort);
    const probes = loadProbes();
    if (!p.ok) {
      return {
        data: { chrome: p, loggedIn: false, dataDir: store.DATA_DIR, probes: Object.keys(probes) },
        warnings: [{ code: 'NO_CHROME', message: `Chrome 调试端口 ${ctx.cfg.cdpPort} 未就绪：${p.error}` }],
      };
    }
    await connect(ctx);
    const folders = await ctx.bili.favFolders();
    return {
      data: {
        chrome: p, loggedIn: true, me: ctx.me, folders,
        aiConfigured: !!ctx.cfg.ai.apiKey,
        dataDir: store.DATA_DIR,
        probes: Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.at])),
      },
    };
  },

  render(r, ctx) {
    const d = r.data;
    if (!d.loggedIn) {
      ctx.say(`Chrome 调试端口 ${ctx.cfg.cdpPort}：未就绪（${d.chrome.error}）`);
      ctx.say('先跑 npm run chrome，在打开的窗口里登录 B 站。');
      return;
    }
    ctx.say(`收藏夹 ${d.folders.length} 个：`);
    for (const f of d.folders) ctx.say(`  ${String(f.id).padEnd(12)} ${f.title}  (${f.count} 条)`);
    ctx.say(`AI：${d.aiConfigured ? ctx.cfg.ai.provider + ' / ' + ctx.cfg.ai.model : '未配置'}`);
    ctx.say(`数据目录：${d.dataDir}`);
    const pk = Object.keys(d.probes);
    ctx.say(`探针：${pk.length ? pk.join(' / ') : '未跑过（bili-station probe --help）'}`);
  },
});
