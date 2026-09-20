/**
 * CDP 传输层 —— 通过 Chrome DevTools Protocol 接管一个已登录的 B 站页面，
 * 所有 API 请求都在该页面上下文里用原生 fetch 发出。
 *
 * 为什么这么做（来自对 12 个同类项目的代码对比）：
 * 本地进程自己发请求时只带 Cookie + 手写 UA，缺 buvid3/buvid4/bili_ticket/
 * Sec-Fetch-* 以及真实行为轨迹，风控画像残缺，这正是纯 CLI 类工具不得不把
 * 退避做到 60s 起步的原因。在真实页面里 fetch 则全部原生具备。
 */

const HOST = '127.0.0.1';
export const WORK_URL = 'https://space.bilibili.com/';

async function httpJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export async function probe(port) {
  try {
    const v = await httpJson(`http://${HOST}:${port}/json/version`);
    return { ok: true, browser: v?.Browser ?? 'unknown' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listPages(port) {
  const list = await httpJson(`http://${HOST}:${port}/json/list`);
  return Array.isArray(list) ? list.filter((t) => t.type === 'page') : [];
}

/** 找一个已经开在 bilibili.com 上的标签页；没有就新开一个。 */
async function resolveTarget(port, { allowCreate = true } = {}) {
  const pages = await listPages(port);
  const hit = pages.find((p) => /^https:\/\/[a-z]+\.bilibili\.com\//.test(p.url || ''));
  if (hit) return hit;
  if (!allowCreate) return null;

  // Chrome 111+ 要求 PUT；老版本用 GET。两种都试。
  const target = `http://${HOST}:${port}/json/new?${encodeURIComponent(WORK_URL)}`;
  for (const method of ['PUT', 'GET']) {
    try {
      const created = await httpJson(target, { method });
      if (created && created.webSocketDebuggerUrl) return created;
    } catch { /* 换下一种 */ }
  }
  // 兜底：轮询新出现的页面
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const again = (await listPages(port)).find((p) => /bilibili\.com/.test(p.url || ''));
    if (again) return again;
  }
  throw new Error('无法在 Chrome 中打开 B 站页面，请手动开一个 space.bilibili.com 标签页后重试');
}

export class CdpSession {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.targetUrl = null;
  }

  async connect() {
    const target = await resolveTarget(this.port);
    this.targetUrl = target.url;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时（10s）')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP 连接失败: ' + (e.message || 'error'))); }, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
      this.ws = null;
    });
    this.ws = ws;

    // 如果接管的标签页不在 B 站域下（理论上 resolveTarget 已保证），强制导航
    if (!/bilibili\.com/.test(this.targetUrl)) {
      await this.send('Page.navigate', { url: WORK_URL });
      await new Promise((r) => setTimeout(r, 1500));
    }
    return this;
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时（30s）`)); }
      }, 30_000);
    });
  }

  /**
   * 在页面里执行一段 async 函数体。fnBody 是字符串，args 会 JSON 序列化后注入。
   * 返回值必须可 JSON 序列化。
   */
  async evaluate(fnBody, args = {}) {
    const expression = `(async (args) => { ${fnBody} })(${JSON.stringify(args)})`;
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面内执行出错: ' + (d.exception?.description || d.text || 'unknown'));
    }
    return res.result?.value;
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

/** 页面内的通用请求器：GET 读 JSON / POST 发表单，全部 credentials: 'include'。 */
export const PAGE_FETCH = `
  const { url, method, form } = args;
  const init = { method, credentials: 'include', headers: {} };
  if (method === 'POST') {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form || {}).toString();
  }
  const r = await fetch(url, init);
  const status = r.status;
  let body;
  try {
    body = await r.json();
  } catch {
    // 412 之类的限流会返回 HTML 而不是 JSON。把状态码带出去，否则上层只看到含糊的 -1。
    body = { code: status === 412 ? -412 : -1, message: 'non-JSON response (HTTP ' + status + ')', _status: status };
  }
  return { status, body };
`;
