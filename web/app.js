/* eslint-env browser */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));

let state = { connected: false, plan: {}, job: null };

// ---------- 通用请求 ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
  if (!j.ok) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}

// ---------- 日志 ----------
function logLine(msg, level = 'info') {
  const el = $('#log');
  const cls = level === 'error' ? 'err-l' : level === 'warn' ? 'warn-l' : '';
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.insertAdjacentHTML('beforeend', `<div class="${cls}">${esc(t)}  ${esc(msg)}</div>`);
  el.scrollTop = el.scrollHeight;
}

// ---------- 导航 ----------
$$('.navbtn').forEach((b) => b.addEventListener('click', () => {
  $$('.navbtn').forEach((x) => x.removeAttribute('aria-current'));
  b.setAttribute('aria-current', 'page');
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
}));

$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  next ? document.documentElement.setAttribute('data-theme', next)
       : document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('bs-theme', next); } catch { /* 隐私模式下忽略 */ }
});
try {
  const t = localStorage.getItem('bs-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
} catch { /* 无痕模式读不到，按系统配色走 */ }

$('#btn-clear-log').addEventListener('click', () => { $('#log').innerHTML = ''; });

// ---------- SSE ----------
const ev = new EventSource('/api/events');
ev.onmessage = (e) => {
  let d; try { d = JSON.parse(e.data); } catch { return; }
  if (d.type === 'log') logLine(d.msg, d.level);
  if (d.type === 'progress') {
    const pct = d.total ? (d.index / d.total) * 100 : 0;
    $('#prog').style.width = pct + '%';
    $('#prog-text').textContent = d.index + '/' + d.total;
  }
  if (d.type === 'end') {
    $('#btn-pause').disabled = true;
    $('#btn-stop').disabled = true;
    refresh();
  }
};

// ---------- 状态刷新 ----------
const HEAT = {
  green:  { color: 'var(--good)',     glyph: '●', text: '空闲' },
  yellow: { color: 'var(--warning)',  glyph: '▲', text: '偏热' },
  orange: { color: 'var(--serious)',  glyph: '▲', text: '高热' },
  red:    { color: 'var(--critical)', glyph: '■', text: '危险' },
};

async function refresh() {
  let s;
  try { s = await api('/api/status'); } catch { return; }
  state.connected = s.connected;

  $('#conn-state').textContent = s.chrome.ok
    ? (s.connected ? '已连接 · ' + s.chrome.browser : '调试端口就绪（' + s.chrome.browser + '），点上面连接')
    : '未检测到调试端口 ' + (s.config.cdpPort) + '，请先 npm run chrome';
  $('#whoami').textContent = s.me ? s.me.uname + '\nUID ' + s.me.mid : '未连接';

  const c = s.counts;
  $('#tiles').innerHTML = [
    tile('关注总数', fmt(c.followingsTotal), c.truncated ? '接口只读到 ' + fmt(c.followings) + '，未拉全' : (c.followings ? '已拉取 ' + fmt(c.followings) : '未拉取')),
    tile('收藏夹', fmt(c.folders), c.folders ? '上限 ' + s.config.folderQuota : '未拉取'),
    tile('收藏条目', fmt(c.favItems), c.favItems ? '已缓存' : '未拉取'),
    tile('投稿探测', fmt(c.uploadInfo), c.uploadInfo ? '已缓存' : '用于识别停更号'),
  ].join('');

  const r = s.job?.risk ?? { heat: 0, level: 'green', curDelayMs: 0, riskHits: 0 };
  const h = HEAT[r.level] ?? HEAT.green;
  $('#heat-fill').style.width = Math.max(2, r.heat) + '%';
  $('#heat-fill').style.background = h.color;
  $('#heat-chip').querySelector('.glyph').textContent = h.glyph;
  $('#heat-chip').querySelector('.glyph').style.color = h.color;
  $('#heat-label').textContent = r.level + ' · ' + h.text + ' · ' + r.heat + '/100';
  $('#heat-detail').textContent = '当前操作间隔 ' + Math.round((r.curDelayMs || 0) / 100) / 10 + 's'
    + ' · 累计命中风控 ' + (r.riskHits || 0) + ' 次'
    + (r.cooldownRemainMs ? ' · 冷却剩余 ' + Math.ceil(r.cooldownRemainMs / 1000) + 's' : '');

  const running = s.job && s.job.status === 'running';
  $('#btn-pause').disabled = !running;
  $('#btn-stop').disabled = !running;

  // 设置回填
  if (!$('#s-port').dataset.touched) {
    $('#s-port').value = s.config.cdpPort;
    $('#s-quota').value = s.config.folderQuota;
    $('#s-cap').value = s.config.perFolderCap;
    $('#s-privacy').value = String(s.config.privacy);
    $('#s-provider').value = s.config.ai.provider;
    $('#s-key').placeholder = s.config.ai.apiKey || '未设置';
    $('#s-model').value = s.config.ai.model || '';
  }
  if (s.tags) renderTags(s.tags);
}

const tile = (label, value, note) =>
  `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;

function renderTags(tags) {
  if (!tags?.length) return;
  $('#tag-list').innerHTML = '<table class="data"><thead><tr><th>分组</th><th class="num">人数</th></tr></thead><tbody>'
    + tags.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.count ?? '—'}</td></tr>`).join('')
    + '</tbody></table>';
}

// ---------- 连接与抓取 ----------
$('#btn-connect').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { const r = await api('/api/connect', {}); logLine('已连接：' + r.me.uname); }
  catch (x) { logLine('连接失败：' + x.message, 'error'); }
  finally { e.target.disabled = false; refresh(); }
});

const busy = (btn, fn) => async () => {
  btn.disabled = true;
  try { await fn(); } catch (x) { logLine(x.message, 'error'); }
  finally { btn.disabled = false; refresh(); }
};

$('#btn-scan-follow').addEventListener('click', busy($('#btn-scan-follow'), async () => {
  const r = await api('/api/scan/followings', {});
  logLine('关注拉取完成：' + r.count + (r.total ? '/' + r.total : '') + (r.truncated ? '（未拉全）' : ''));
}));
$('#btn-scan-fav').addEventListener('click', busy($('#btn-scan-fav'), async () => {
  const r = await api('/api/scan/favorites', {});
  logLine('收藏夹拉取完成：' + r.folders.length + ' 个夹');
}));
$('#btn-scan-uploads').addEventListener('click', busy($('#btn-scan-uploads'), async () => {
  const r = await api('/api/scan/uploads', { limit: 300 });
  logLine('投稿探测完成：' + r.probed + ' 个（失败 ' + r.failed + '）');
}));

// ---------- 关注清理 ----------
$('#btn-plan-unfollow').addEventListener('click', busy($('#btn-plan-unfollow'), async () => {
  const r = await api('/api/plan/unfollow', {
    keep: $('#f-only-inactive').checked ? null : Number($('#f-keep').value),
    inactiveDays: Number($('#f-days').value) || null,
    onlyInactive: $('#f-only-inactive').checked,
  });
  renderUnfollowPlan(r);
  logLine('计划生成：将取关 ' + r.willUnfollow + ' 个，保留 ' + r.kept + ' 个');
}));

function renderUnfollowPlan(r) {
  state.plan.unfollow = r;
  $('#btn-run-unfollow').disabled = r.willUnfollow === 0;

  const reasons = Object.entries(r.byReason ?? {});
  $('#unfollow-result').innerHTML = `
    <div class="tiles">
      ${tile('将取关', fmt(r.willUnfollow), '占总数 ' + (r.total ? Math.round(r.willUnfollow / r.total * 100) : 0) + '%')}
      ${tile('将保留', fmt(r.kept), '含特别关注')}
      ${tile('关注总数', fmt(r.total), '')}
    </div>
    ${reasons.length ? `<div class="card"><h2>取关原因分布</h2>
      <div class="bar-legend"><span class="key"><span class="swatch" style="background:var(--series-1)"></span>命中条数</span></div>
      ${barChart(reasons.map(([k, v]) => ({ name: reasonCn(k), value: v })))}
    </div>` : ''}
    <div class="card"><h2>即将取关（前 200）</h2>
      <div class="scrollbox"><table class="data">
        <thead><tr><th>UP 主</th><th>UID</th><th>原因</th></tr></thead>
        <tbody>${r.preview.map((u) => `<tr><td>${esc(u.uname)}</td><td class="mono">${esc(u.mid)}</td><td>${esc(reasonCn(u.reason))}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

const reasonCn = (k) => ({
  'over-keep': '超出保留名额', 'inactive': '长期停更',
  'over-keep+inactive': '超额且停更', 'special': '特别关注', 'protected-tag': '受保护分组',
  'recent': '最近关注', 'active': '仍在更新',
}[k] ?? k);

// ---------- 收藏夹分类 ----------
$('#btn-plan-fav').addEventListener('click', busy($('#btn-plan-fav'), async () => {
  const r = await api('/api/plan/fav', {
    method: $('#v-method').value,
    mode: $('#v-mode').value,
    keepUnmatched: $('#v-keep-unmatched').checked,
  });
  renderFavPlan(r);
  logLine('分类计划：' + r.totalItems + ' 条 → ' + r.categories + ' 类，新建 ' + r.newFolders + ' 个夹');
}));

function renderFavPlan(r) {
  state.plan.fav = r;
  $('#btn-run-fav').disabled = r.totalItems === 0;

  const needReview = r.groups.reduce((a, g) => a + (g.needReview || 0), 0);
  $('#fav-result').innerHTML = `
    ${(r.warnings ?? []).map((w) => `<div class="warn ${w.kind === 'folder-quota' ? 'critical' : ''}"><span class="glyph">${w.kind === 'folder-quota' ? '■' : '▲'}</span><span>${esc(w.message)}</span></div>`).join('')}
    <div class="tiles">
      ${tile('待处理条目', fmt(r.totalItems), r.mode === 'move' ? '移动模式 · 不可逆' : '复制模式 · 可回退')}
      ${tile('分类数', fmt(r.categories), '')}
      ${tile('将新建夹', fmt(r.newFolders), '复用已有 ' + r.reusedFolders + ' 个')}
      ${tile('需人工复核', fmt(needReview), needReview ? '置信度低或规则模糊' : '无')}
    </div>
    <div class="card">
      <h2>分类分布</h2>
      <div class="bar-legend">
        <span class="key"><span class="swatch" style="background:var(--series-1)"></span>复用已有收藏夹</span>
        <span class="key"><span class="swatch" style="background:var(--series-2)"></span>需要新建</span>
      </div>
      ${barChart(r.groups.map((g) => ({
        name: g.category, value: g.count, isNew: g.isNew,
        tag: g.isNew ? '新建' : (g.reuseKind === 'loose' ? '复用·宽松' : '复用'),
        title: g.category + '：' + g.count + ' 条' + (g.isNew ? '（将新建）' : '（并入已有 ' + g.existingCount + ' 条）') + (g.needReview ? ' · ' + g.needReview + ' 条待复核' : ''),
      })))}
    </div>
    <div class="card"><h2>抽样预览</h2>
      <div class="scrollbox"><table class="data">
        <thead><tr><th>分类</th><th>标题</th><th>UP 主</th><th class="num">置信/得分</th></tr></thead>
        <tbody>${r.groups.flatMap((g) => g.sample.map((it) => `<tr>
          <td>${esc(g.category)}</td><td>${esc(it.title)}</td><td>${esc(it.upper)}</td>
          <td class="num">${it.confidence != null ? it.confidence.toFixed(2) : (it.score ?? '—')}${it.ambiguous ? ' ⚠' : ''}</td>
        </tr>`)).join('')}</tbody>
      </table></div>
    </div>`;
}

// ---------- 失效视频 ----------
$('#btn-plan-dead').addEventListener('click', busy($('#btn-plan-dead'), async () => {
  const r = await api('/api/plan/dead', { action: $('#d-action').value, archiveName: $('#d-name').value });
  renderDeadPlan(r);
  logLine('失效扫描：共 ' + r.total + ' 条');
}));

function renderDeadPlan(r) {
  state.plan.dead = r;
  $('#btn-run-dead').disabled = r.total === 0;
  $('#dead-result').innerHTML = `
    <div class="tiles">${tile('失效条目', fmt(r.total), r.action === 'archive' ? '将归档到「' + r.archiveName + '」' : '将直接移除')}
    ${tile('涉及收藏夹', fmt(r.groups.length), '')}</div>
    ${r.groups.length ? `<div class="card"><h2>分布</h2>
      <div class="bar-legend"><span class="key"><span class="swatch" style="background:var(--series-1)"></span>失效条数</span></div>
      ${barChart(r.groups.map((g) => ({ name: g.folderTitle, value: g.count })))}</div>` : '<div class="card"><p class="hint">没有发现失效视频。</p></div>'}`;
}

// ---------- 条形图 ----------
function barChart(rows) {
  if (!rows.length) return '<p class="hint">无数据</p>';
  const max = Math.max(...rows.map((r) => r.value), 1);
  return '<div class="bars">' + rows.map((r) => {
    const w = Math.max(2, (r.value / max) * 100);
    return `<div class="bar-row" title="${esc(r.title ?? (r.name + '：' + r.value))}">
      <div class="bar-name">${esc(r.name)}${r.tag ? `<span class="tag">${esc(r.tag)}</span>` : ''}</div>
      <div class="bar-track"><div class="bar-fill${r.isNew ? ' is-new' : ''}" style="width:${w}%"></div></div>
      <div class="bar-val">${r.value}</div>
    </div>`;
  }).join('') + '</div>';
}

// ---------- 执行 ----------
function wireRun(btnSel, drySel, label) {
  $(btnSel).addEventListener('click', async () => {
    const dry = $(drySel).checked;
    if (!dry && !confirm(`即将真正执行「${label}」，此操作会修改你的 B 站账号数据。\n\n执行前会自动备份当前状态。确定继续？`)) return;
    try {
      const r = await api('/api/run', { dryRun: dry });
      logLine((dry ? '【干跑】' : '【执行】') + label + '：共 ' + r.opCount + ' 项');
      $('#btn-pause').disabled = false;
      $('#btn-stop').disabled = false;
    } catch (x) { logLine(x.message, 'error'); }
  });
}
wireRun('#btn-run-unfollow', '#f-dry', '批量取关');
wireRun('#btn-run-fav', '#v-dry', '收藏夹分类');
wireRun('#btn-run-dead', '#d-dry', '失效视频处理');

$('#btn-stop').addEventListener('click', () => api('/api/job/stop', {}).catch(() => {}));
let paused = false;
$('#btn-pause').addEventListener('click', async (e) => {
  paused = !paused;
  await api(paused ? '/api/job/pause' : '/api/job/resume', {}).catch(() => {});
  e.target.textContent = paused ? '继续' : '暂停';
});

// ---------- 设置 ----------
$$('#s-port,#s-quota,#s-cap,#s-privacy,#s-provider,#s-model').forEach((el) =>
  el.addEventListener('input', () => { el.dataset.touched = '1'; $('#s-port').dataset.touched = '1'; }));

$('#btn-save-cfg').addEventListener('click', async () => {
  try {
    await api('/api/config', {
      cdpPort: Number($('#s-port').value),
      folderQuota: Number($('#s-quota').value),
      perFolderCap: Number($('#s-cap').value),
      privacy: Number($('#s-privacy').value),
      risk: {
        minDelayMs: Number($('#s-min').value),
        maxDelayMs: Number($('#s-max').value),
        hardCapPerRound: Number($('#s-cap-round').value),
        batchSize: Number($('#s-batch').value),
        stopOnRisk: $('#s-stop').checked,
      },
      ai: {
        provider: $('#s-provider').value,
        apiKey: $('#s-key').value || undefined,
        model: $('#s-model').value,
        chunkSize: Number($('#s-chunk').value),
        concurrency: Number($('#s-conc').value),
      },
    });
    $('#cfg-msg').textContent = '已保存';
    $('#s-key').value = '';
    setTimeout(() => { $('#cfg-msg').textContent = ''; }, 2500);
  } catch (x) { logLine(x.message, 'error'); }
});

$('#btn-clear-resume').addEventListener('click', async () => {
  if (!confirm('清空断点续跑记录后，之前已完成的操作会被重新尝试一遍。确定？')) return;
  for (const k of ['unfollow', 'fav', 'dead']) await api('/api/reset-resume', { kind: k }).catch(() => {});
  logLine('断点记录已清空');
});

api('/api/backups').then((r) => {
  $('#backup-list').innerHTML = r.backups.length
    ? '<table class="data"><tbody>' + r.backups.map((b) => `<tr><td class="mono">${esc(b.file)}</td></tr>`).join('') + '</tbody></table>'
    : '还没有备份';
}).catch(() => {});

refresh();
setInterval(refresh, 4000);

// ---------- 预览模式：?demo=1 灌入示例数据，不连账号也能看清界面长什么样 ----------
if (new URLSearchParams(location.search).has('demo')) {
  logLine('【预览模式】以下全是假数据，没有连接任何账号', 'warn');

  renderUnfollowPlan({
    total: 3187, willUnfollow: 2412, kept: 775,
    byReason: { 'over-keep': 1806, 'inactive': 431, 'over-keep+inactive': 175 },
    preview: [
      { mid: '12345', uname: '某停更UP', reason: 'inactive' },
      { mid: '23456', uname: '三年没更新了', reason: 'over-keep+inactive' },
      { mid: '34567', uname: '随手关注的', reason: 'over-keep' },
    ],
  });

  renderFavPlan({
    mode: 'copy', categories: 7, totalItems: 1284, newFolders: 4, reusedFolders: 3,
    warnings: [
      { kind: 'folder-quota', message: '预计新建 14 个收藏夹，加上已有 9 个将超过上限 20。注意：配额满时 B 站返回的错误信息会像是限流，实际是配额问题，别误判为风控。' },
      { kind: 'folder-cap', message: '收藏夹「游戏」将达到 1043 条，超过单夹上限 1000 共 43 条，超出部分会失败。' },
    ],
    groups: [
      { category: '编程开发', count: 312, isNew: false, reuseKind: 'exact', existingCount: 120, needReview: 8, sample: [{ title: 'Python 异步编程详解', upper: '码农老王', score: 6, ambiguous: false }] },
      { category: '游戏', count: 245, isNew: false, reuseKind: 'loose', existingCount: 798, needReview: 2, sample: [{ title: '艾尔登法环全 boss 速通', upper: '魂系玩家', score: 5, ambiguous: false }] },
      { category: 'AI 与机器学习', count: 201, isNew: true, reuseKind: null, existingCount: 0, needReview: 31, sample: [{ title: '从零实现 Transformer', upper: 'AI 学堂', confidence: 0.92, ambiguous: false }] },
      { category: '美食烹饪', count: 180, isNew: true, reuseKind: null, existingCount: 0, needReview: 5, sample: [{ title: '家常红烧肉', upper: '厨房日记', score: 4, ambiguous: false }] },
      { category: '数码硬件', count: 156, isNew: false, reuseKind: 'exact', existingCount: 40, needReview: 3, sample: [{ title: '4090 开箱评测', upper: '数码君', score: 5, ambiguous: false }] },
      { category: '科普知识', count: 112, isNew: true, reuseKind: null, existingCount: 0, needReview: 12, sample: [{ title: '黑洞到底是什么', upper: '科学声音', confidence: 0.55, ambiguous: true }] },
      { category: '待分类', count: 78, isNew: true, reuseKind: null, existingCount: 0, needReview: 78, sample: [{ title: '随手拍', upper: '路人甲', score: 0, ambiguous: true }] },
    ],
  });

  renderDeadPlan({
    action: 'archive', archiveName: '已失效视频归档', total: 96,
    groups: [
      { mediaId: 1, folderTitle: '默认收藏夹', count: 54, sample: [] },
      { mediaId: 2, folderTitle: '游戏', count: 28, sample: [] },
      { mediaId: 3, folderTitle: '音乐', count: 14, sample: [] },
    ],
  });

  renderTags([{ name: '技术', count: 142 }, { name: '生活', count: 88 }, { name: '游戏', count: 63 }]);

  // 热度计打到 orange 档，好看清状态色与文案是怎么联动的
  const h = HEAT.orange;
  $('#heat-fill').style.width = '68%';
  $('#heat-fill').style.background = h.color;
  $('#heat-chip').querySelector('.glyph').textContent = h.glyph;
  $('#heat-chip').querySelector('.glyph').style.color = h.color;
  $('#heat-label').textContent = 'orange · ' + h.text + ' · 68/100';
  $('#heat-detail').textContent = '当前操作间隔 5.2s · 累计命中风控 2 次 · 冷却剩余 47s';
  $('#prog').style.width = '43%';
  $('#prog-text').textContent = '1043/2412';
}
