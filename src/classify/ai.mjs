/**
 * AI 语义分类 —— 多厂商，走 OpenAI 兼容 / Anthropic / Gemini 三种协议。
 * 关键设计：
 *   - 强制模型只能从给定的候选分类里选，不允许自由发挥造出几十个新类（这是收藏夹配额爆掉的主因）
 *   - 每条返回置信度，低置信度在 UI 里单独筛出来复核
 *   - 分片 + 并发上限 + 失败重试，单片失败不影响整批
 *   - API Key 只存在本地 config，不随导出/备份外泄
 */

export const PROVIDERS = {
  deepseek:   { kind: 'openai',    base: 'https://api.deepseek.com/v1',                    model: 'deepseek-chat' },
  openai:     { kind: 'openai',    base: 'https://api.openai.com/v1',                      model: 'gpt-4o-mini' },
  moonshot:   { kind: 'openai',    base: 'https://api.moonshot.cn/v1',                     model: 'moonshot-v1-8k' },
  zhipu:      { kind: 'openai',    base: 'https://open.bigmodel.cn/api/paas/v4',           model: 'glm-4-flash' },
  dashscope:  { kind: 'openai',    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  siliconflow:{ kind: 'openai',    base: 'https://api.siliconflow.cn/v1',                  model: 'Qwen/Qwen2.5-7B-Instruct' },
  openrouter: { kind: 'openai',    base: 'https://openrouter.ai/api/v1',                   model: 'openai/gpt-4o-mini' },
  ollama:     { kind: 'openai',    base: 'http://127.0.0.1:11434/v1',                      model: 'qwen2.5' },
  anthropic:  { kind: 'anthropic', base: 'https://api.anthropic.com/v1',                   model: 'claude-sonnet-5' },
  gemini:     { kind: 'gemini',    base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
};

const SYS = [
  '你是一个视频收藏整理助手。用户会给你一批 B 站视频（标题 / UP主 / 简介片段）和一份候选分类清单。',
  '规则：',
  '1. 每个视频必须从候选分类里选恰好一个，不得创造候选清单之外的新分类。',
  '2. 实在无法归类的，归到「待分类」。',
  '3. 给出 0 到 1 的置信度，拿不准就给低分，不要硬凑高分。',
  '4. 只输出 JSON，不要任何解释文字或 markdown 代码块。',
  '输出格式：{"results":[{"id":<原样回传的数字 id>,"category":"分类名","confidence":0.0}]}',
].join('\n');

function buildUserPrompt(items, categories) {
  const lines = items.map((it) => {
    const intro = String(it.intro ?? '').replace(/\s+/g, ' ').slice(0, 60);
    return JSON.stringify({ id: it.id, title: it.title, up: it.upper, intro });
  });
  return [
    '候选分类（只能从中选）：' + JSON.stringify(categories),
    '',
    '待分类视频：',
    ...lines,
  ].join('\n');
}

async function callOpenAI(cfg, sys, user, signal) {
  const r = await fetch(cfg.base + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(cfg, sys, user, signal) {
  const r = await fetch(cfg.base + '/messages', {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model, max_tokens: 4096, temperature: 0,
      system: sys, messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.content?.map((c) => c.text ?? '').join('') ?? '';
}

async function callGemini(cfg, sys, user, signal) {
  const url = cfg.base + '/models/' + cfg.model + ':generateContent?key=' + encodeURIComponent(cfg.apiKey);
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
}

/** 模型偶尔会包 markdown 代码块或前后带废话，这里尽量抠出 JSON */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

async function callOnce(cfg, items, categories, signal) {
  const meta = PROVIDERS[cfg.provider];
  if (!meta) throw new Error('未知的 AI 供应商: ' + cfg.provider);
  const merged = {
    ...cfg,
    base: cfg.baseUrl || meta.base,
    model: cfg.model || meta.model,
  };
  const user = buildUserPrompt(items, categories);
  const raw = meta.kind === 'anthropic' ? await callAnthropic(merged, SYS, user, signal)
    : meta.kind === 'gemini' ? await callGemini(merged, SYS, user, signal)
    : await callOpenAI(merged, SYS, user, signal);
  const parsed = extractJson(raw);
  if (!parsed?.results) throw new Error('模型返回无法解析为预期 JSON');
  return parsed.results;
}

/**
 * 批量 AI 分类。
 * @param {Array} items
 * @param {Array<string>} categories 候选分类（含「待分类」）
 * @param {object} cfg { provider, apiKey, model?, baseUrl?, chunkSize?, concurrency?, maxRetry? }
 * @param {function} onProgress ({done, total, failedChunks})
 */
export async function classifyWithAI(items, categories, cfg, onProgress) {
  const chunkSize = cfg.chunkSize ?? 25;
  const concurrency = Math.max(1, Math.min(cfg.concurrency ?? 2, 5));
  const maxRetry = cfg.maxRetry ?? 2;

  const cats = categories.includes('待分类') ? categories : [...categories, '待分类'];
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));

  const assignment = new Map();
  const detail = new Map();
  const failedChunks = [];
  let done = 0;
  let cursor = 0;

  const catSet = new Set(cats);

  async function worker() {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const batch = chunks[idx];
      let ok = false;
      for (let attempt = 1; attempt <= maxRetry + 1 && !ok; attempt++) {
        try {
          const results = await callOnce(cfg, batch, cats);
          const byId = new Map(batch.map((b) => [String(b.id), b]));
          for (const r of results) {
            if (!byId.has(String(r.id))) continue;       // 模型编了个不存在的 id，丢弃
            const cat = catSet.has(r.category) ? r.category : '待分类'; // 越界分类强制收敛
            assignment.set(byId.get(String(r.id)).id, cat);
            detail.set(byId.get(String(r.id)).id, {
              category: cat,
              confidence: typeof r.confidence === 'number' ? r.confidence : null,
              ambiguous: typeof r.confidence === 'number' ? r.confidence < 0.6 : true,
              source: 'ai',
              coerced: !catSet.has(r.category),
            });
          }
          // 模型漏答的条目兜底
          for (const b of batch) {
            if (!assignment.has(b.id)) {
              assignment.set(b.id, '待分类');
              detail.set(b.id, { category: '待分类', confidence: 0, ambiguous: true, source: 'ai-missing' });
            }
          }
          ok = true;
        } catch (e) {
          if (attempt > maxRetry) {
            failedChunks.push({ index: idx, size: batch.length, error: e.message });
          } else {
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
      }
      done += batch.length;
      onProgress?.({ done, total: items.length, failedChunks: failedChunks.length });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { assignment, detail, failedChunks, categories: cats };
}
