/**
 * 命令上下文：配置、Chrome 连接、探针结果。
 * 命令体只拿 ctx，不自己读配置、不自己连 Chrome。
 */
import { CdpSession, probe } from '../cdp.mjs';
import { Bili } from '../bili.mjs';
import * as store from '../store.mjs';
import { EXIT } from './output.mjs';

/**
 * 逐键兜底的配置读取。
 * 注意这里是 spread 而不是 store.read(name, DEFAULTS)：后者的默认值只在文件
 * 不存在时生效，用户手改出一个局部 config.json 就会丢掉全部默认值。
 * （server.mjs 原本就是后一种写法，本次一并修掉。）
 */
export function loadConfig(overrides = {}) {
  const c = store.read('config.json', {}) ?? {};
  const cfg = {
    cdpPort: 9222,
    folderQuota: 20,
    perFolderCap: 1000,
    privacy: 1,
    risk: {},
    rules: [],
    ...c,
    ai: {
      provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', chunkSize: 25, concurrency: 2,
      ...(c.ai ?? {}),
      // 环境变量优先于配置文件，方便 CI / 临时换 key
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.BILI_AI_KEY || c.ai?.apiKey || '',
    },
  };
  if (overrides.cdpPort) cfg.cdpPort = overrides.cdpPort;
  return cfg;
}

/** 探针结果：B 站真实行为的实测记录，胜过代码里的猜测。 */
export function loadProbes() {
  return store.read('probes.json', {}) ?? {};
}

export function saveProbe(name, result) {
  const all = loadProbes();
  all[name] = { at: new Date().toISOString(), ...result };
  store.write('probes.json', all);
  return all[name];
}

/** 连 Chrome 并初始化 Bili。失败时抛出带退出码的错误，由入口统一处理。 */
export async function connect(ctx) {
  const p = await probe(ctx.cfg.cdpPort);
  if (!p.ok) {
    const e = new Error(`未检测到 Chrome 调试端口 ${ctx.cfg.cdpPort}。先跑 "npm run chrome" 并在打开的窗口里登录 B 站。（${p.error}）`);
    e.exitCode = EXIT.ERROR;
    throw e;
  }
  const cdp = await new CdpSession(ctx.cfg.cdpPort).connect();
  const bili = new Bili(cdp);
  const me = await bili.init();
  ctx.cdp = cdp;
  ctx.bili = bili;
  ctx.me = me;
  ctx.chromeProbe = p;
  ctx.say(`已连接：${me.uname}（UID ${me.mid}）`);
  return ctx;
}

export { store, probe };
