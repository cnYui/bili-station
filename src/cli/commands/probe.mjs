import { defineCommand } from '../registry.mjs';
import { saveProbe, loadProbes } from '../context.mjs';
import { RELATION_ACT, SPECIAL_TAG_ID } from '../../bili.mjs';
import { sleep, RISK_CODES, AUTH_CODES } from '../../risk.mjs';
import { toResource } from '../../plan.mjs';
import * as store from '../../store.mjs';
import { openLog, readLog, analyze } from '../reqlog.mjs';

/** 关注列表拉一次要两分钟，探针用缓存就够 —— 它只需要一个样本 UP */
const cachedFollowings = () => {
  const d = store.read('followings.json', null);
  return d?.list?.length ? d : null;
};

const PROBE_FOLDER = '_probe_排序探针';

export default defineCommand({
  name: 'probe',
  summary: '实测 B 站的真实行为，把结果写进 probes.json 供其他命令读取',
  usage: '<fav-order|relation-act|rate-limit|list>',
  needsChrome: true,
  mutating: true,
  subs: {
    'fav-order': 'move/copy 是否重写 fav_time、同批条目的内部次序（6 次写操作）',
    'relation-act': '哪些 act 取值可用、setUserTags 是不是覆盖语义（4 次写操作，不改变关注关系）',
    'rate-limit': '梯度加速逼出 -412 墙，测出限流阈值与恢复时间（只读请求，会故意撞墙）',
    'list': '看已有的探针结果',
  },
  flags: {
    source: { type: 'int', desc: 'fav-order：拿哪个收藏夹的条目做样本；默认挑第一个条目够多的' },
    mid: { type: 'midList', desc: 'relation-act：拿哪个已关注的 UP 做样本；默认挑最近关注的普通关注' },
    keep: { type: 'boolean', desc: 'fav-order：保留探针收藏夹里的条目，不清理' },
    'max-requests': { type: 'int', min: 20, max: 1000, default: 400, desc: 'rate-limit：请求总数硬上限' },
    'step-size': { type: 'int', min: 10, max: 200, default: 40, desc: 'rate-limit：每个速率档位跑多少次请求' },
    'recovery-minutes': { type: 'int', min: 0, max: 180, default: 40, desc: 'rate-limit：撞墙后最多花多少分钟等恢复。0 = 不等' },
  },
  examples: ['probe list', 'probe fav-order --yes', 'probe relation-act --yes', 'probe rate-limit --yes'],

  async plan(ctx) {
    const what = ctx.positionals[0];
    if (!what || what === 'list') {
      const all = loadProbes();
      return { readonly: true, data: { probes: all } };
    }
    if (what === 'fav-order') return favOrderProbe(ctx);
    if (what === 'relation-act') return relationActProbe(ctx);
    if (what === 'rate-limit') return rateLimitProbe(ctx);
    return ctx.usageError(`未知探针：${what}（可用：fav-order / relation-act / rate-limit / list）`);
  },

  render(r, ctx) {
    const d = r.data;
    if (d.probes) {
      const keys = Object.keys(d.probes);
      if (!keys.length) { ctx.say('还没跑过任何探针。'); return; }
      for (const [k, v] of Object.entries(d.probes)) {
        ctx.say(`${k}  （${v.at}）`);
        for (const line of (v.summary ?? [])) ctx.say('  ' + line);
      }
      return;
    }
    ctx.say('');
    for (const line of (d.summary ?? [])) ctx.say('  ' + line);
  },
});

/**
 * 排序探针。
 *
 * 要回答的问题：
 *   Q1 move/copy 之后 fav_time 是被保留还是被重写成操作时间？
 *   Q2 一次带 20 条的调用里，这 20 条的 fav_time 是否相同？（决定排序精度上限）
 *   Q3 copy 和 move 的行为是否一致？
 *
 * 做法：copy（而不是 move）样本条目到一个探针夹 —— 来源夹完全不受影响。
 * 逐条 copy 三条（间隔拉开），再一次性 copy 三条，然后回读探针夹对比。
 */
async function favOrderProbe(ctx) {
  const { bili } = ctx;
  const folders = await bili.favFolders();
  const src = ctx.flags.source
    ? folders.find((f) => Number(f.id) === ctx.flags.source)
    : folders.find((f) => f.count >= 6);
  if (!src) return ctx.usageError('找不到条目够多（≥6 条）的收藏夹做样本，用 --source <id> 指定一个。');

  ctx.say(`样本来源：「${src.title}」(id ${src.id})`);

  const page = await bili.favItems(src.id, null, { startPage: 1, pageDelayMs: 300 });
  const sample = page.list.slice(0, 6);
  if (sample.length < 6) return ctx.usageError(`「${src.title}」只读到 ${sample.length} 条，不够做探针。`);

  const single = sample.slice(0, 3);   // 逐条提交，用来测 Q1/Q3
  const batch = sample.slice(3, 6);    // 一次提交，用来测 Q2

  return {
    data: {
      source: { id: src.id, title: src.title },
      sample: sample.map((it) => ({ id: it.id, title: it.title.slice(0, 20), favTimeBefore: it.favTime })),
    },
    // 探针的写操作全部包在一个 op 里：它是一条不可拆的实验流程，
    // 中途被断点跳过会得到无意义的结果
    ops: [{
      label: `排序探针：建夹 + 逐条 copy 3 条 + 整批 copy 3 条 + 回读对比`,
      op: 'favMove',
      weight: 3,
      run: async () => {
        let probeFolder = folders.find((f) => f.title.trim() === PROBE_FOLDER);
        if (!probeFolder) {
          const r = await bili.createFolder(PROBE_FOLDER, { privacy: 1 });
          if (r?.code !== 0) return r;
          probeFolder = { id: r.data.id, title: PROBE_FOLDER };
          ctx.say(`  已建探针夹「${PROBE_FOLDER}」(id ${probeFolder.id})`);
        }

        const submitted = [];
        for (const it of single) {
          const r = await bili.copyResources(src.id, probeFolder.id, [toResource(it)]);
          if (r?.code !== 0) return r;
          submitted.push({ id: it.id, at: Math.floor(Date.now() / 1000) });
          ctx.say(`  逐条 copy：${it.title.slice(0, 18)}`);
          await sleep(2500);
        }
        const rb = await bili.copyResources(src.id, probeFolder.id, batch.map(toResource));
        if (rb?.code !== 0) return rb;
        ctx.say(`  整批 copy：3 条`);
        await sleep(2000);

        const after = await bili.favItems(probeFolder.id, null, { pageDelayMs: 300 });
        const byId = new Map(after.list.map((x) => [String(x.id), x]));

        // Q1：fav_time 有没有被重写
        const pairs = sample.map((it) => ({
          id: it.id,
          before: it.favTime,
          after: byId.get(String(it.id))?.favTime ?? null,
        })).filter((p) => p.after != null);
        const rewritten = pairs.filter((p) => p.after !== p.before).length;
        const favTimeRewritten = rewritten === pairs.length && pairs.length > 0;

        // Q2：整批的三条 fav_time 是否相同
        const batchTimes = batch.map((it) => byId.get(String(it.id))?.favTime).filter((x) => x != null);
        const batchSameTimestamp = batchTimes.length > 1 && new Set(batchTimes).size === 1;

        // Q3：回读顺序（接口按 mtime 降序返回）和提交顺序的关系
        const order = after.list.map((x) => String(x.id));
        const singleIds = single.map((x) => String(x.id));
        const posOf = (id) => order.indexOf(id);
        const submitFirstEndsLast = posOf(singleIds[0]) > posOf(singleIds[singleIds.length - 1]);

        const summary = [
          favTimeRewritten
            ? '✓ Q1：copy 会把 fav_time 重写成操作时间（所以提交顺序决定新夹里的排列）'
            : `✗ Q1：fav_time 没有被重写（${pairs.length} 条中有 ${rewritten} 条变了）—— 排序逻辑要重新考虑`,
          batchSameTimestamp
            ? '✓ Q2：同一次调用里的条目 fav_time 完全相同 → 排序精度上限就是一批（默认 20 条）'
            : `✗ Q2：同批条目的 fav_time 不同（${new Set(batchTimes).size} 个不同值）→ 批内也有序，精度更高`,
          submitFirstEndsLast
            ? '✓ Q3：先提交的排在后面 —— 印证「提交顺序的逆序 = 显示顺序」，--order original 的实现方向正确'
            : '✗ Q3：先提交的排在前面 —— --order 的方向需要反过来，order.mjs 的推导要改',
        ];
        for (const s of summary) ctx.say('  ' + s);

        saveProbe('fav-order', {
          favTimeRewritten, batchSameTimestamp, submitFirstEndsLast,
          orderDirection: submitFirstEndsLast ? 'submit-first-shows-last' : 'submit-first-shows-first',
          precision: batchSameTimestamp ? 'per-batch' : 'per-item',
          probeFolderId: probeFolder.id,
          pairs, summary,
        });

        if (!ctx.flags.keep) {
          await sleep(1500);
          const del = await bili.batchDel(probeFolder.id, sample.map(toResource));
          ctx.say(del?.code === 0
            ? `  已清空探针夹（夹本身留着，id ${probeFolder.id}，可手动删）`
            : `  ⚠ 探针夹没清干净（code=${del?.code}），里面有 ${sample.length} 条副本，可手动删`);
        }
        return { code: 0, data: { probe: 'fav-order' } };
      },
    }],
    jobKind: 'probe', resumeKey: 'probe-fav-order',
  };
}

const PROBE_TAG = '探针临时分组';   // 分组名不能含下划线等特殊字符（22101），实测得出

/**
 * B 站返回码的语义分类。
 *
 * 这一层是第一版探针缺的：把「act 无效」和「act 有效但前置条件不满足」混为一谈，
 * 会把 22014（已经关注用户）误判成「act=1 不可用」。实际上收到这个错误恰恰
 * 证明接口理解了这个动作。
 */
function classifyActCode(code, message) {
  if (code === 0) return { supported: true, note: '可用' };
  if (code === 22014) return { supported: true, note: `act 有效（返回「${message}」说明接口认得这个动作），只是样本 UP 已处于该状态` };
  if (code === -400) return { supported: false, note: '请求错误 —— 这个 act 值不被接受（可能已下线，或需要额外参数）' };
  if (code === -101 || code === -111) return { supported: null, note: '登录态问题，结论无效' };
  return { supported: false, note: `返回 code=${code} ${message ?? ''}`.trim() };
}

/**
 * 记录一次调用的**完整**返回，code 和 message 都要。
 *
 * 教训：第一版只记了 `setSpecialCode: 22117`，没记 message。结果面对一个
 * 光秃秃的数字只能猜，还猜错了方向（判成「接口不可写」），白绕一圈。
 * message 里写的是「特殊关注达到上限」—— B 站早就把答案直接给了。
 *
 * 探针的价值在于把猜测换成证据，那就别在记录环节把证据丢掉。
 */
const rec = (raw, key, r) => {
  raw[key] = { code: r?.code ?? null, message: r?.message ?? null };
  return r;
};

/**
 * 关系接口探针。
 *
 * 要回答的问题：
 *   Q1 act = 1/3 分别可不可用？（代码里只有 2 是早就实测过的）
 *   Q2 setUserTags 是覆盖语义还是追加语义？
 *   Q3 特别关注（tagid -10）能不能通过分组接口写入？
 *
 * **最小痕迹设计**：
 *   · 全程拿一个你**已经关注**的 UP 做实验，从头到尾保持关注状态
 *   · 不新关注任何人、不取关任何人，对方的粉丝列表毫无变化
 *   · Q2 在一个**临时新建的**分组里验证，不碰你现有的 13 个分组，结束即删
 *
 * 教训（第一版踩的）：Q2 原本是「加进特别关注 → 再移出 → 看移出成功没」，
 * 但加进去那步本身失败时，「移出成功」是空真，会给出假阳性。所以现在
 * 每一步都先断言前置条件成立，不成立就直接标 inconclusive。
 */
async function relationActProbe(ctx) {
  const { bili } = ctx;
  const data = cachedFollowings() ?? await bili.followings((n) => { if (n % 500 === 0) ctx.say(`  拉取关注 ${n}`); });
  if (!data.list.length) return ctx.usageError('关注列表为空，没法做关系探针。');

  const special = await bili.specialFollowings();
  const subject = ctx.flags.mid
    ? data.list.find((u) => String(u.mid) === ctx.flags.mid[0])
    : data.list.find((u) => !special.has(String(u.mid)));
  if (!subject) return ctx.usageError('找不到合适的样本 UP（需要一个已关注、且不是特别关注的）。用 --mid 指定。');

  const beforeTags = Array.isArray(subject.tags) ? subject.tags.map(Number).filter(Number.isFinite) : [];
  ctx.say(`样本 UP：${subject.uname}（UID ${subject.mid}），当前分组 [${beforeTags.join(', ') || '默认'}]`);
  ctx.say('全程保持关注状态：不新关注、不取关。临时分组用完即删，不碰现有分组。');

  return {
    data: {
      subject: { mid: subject.mid, uname: subject.uname, beforeTags },
      plan: ['建临时分组', '把样本加进去并回读', '恢复原分组并回读', '删临时分组', '试写 tagid=-10', '试 act=1 / act=3'],
    },
    ops: [{
      label: `关系探针：${subject.uname} 的分组进出 + act 取值实测`,
      op: 'tagEdit',
      weight: 4,
      run: async () => {
        const result = { verified: {}, raw: {} };
        const mid = String(subject.mid);

        // ---- Q2：在临时分组里验证覆盖语义 ----
        const existing = (await bili.tags()).find((t) => String(t.name).trim() === PROBE_TAG);
        let tagid = existing?.tagid ?? null;
        if (tagid == null) {
          const rc = await bili.createTag(PROBE_TAG);
          tagid = rc?.data?.tagid ?? rc?.data?.tag_id ?? null;
          result.raw.createTagCode = rc?.code ?? null;
        }
        if (tagid == null) {
          result.verified.setUserTagsIsReplace = null;
          ctx.say(`  ⚠ 建临时分组失败（code=${result.raw.createTagCode}），Q2 无法验证`);
        } else {
          await sleep(1500);
          const rAdd = await bili.setUserTags([mid], [...beforeTags, Number(tagid)]);
          result.raw.setUserTagsAddCode = rAdd?.code ?? null;
          await sleep(2000);
          const inTag = (await bili.tagUsers(tagid)).some((u) => String(u.mid) === mid);
          result.raw.addedToTempTag = inTag;

          if (!inTag) {
            // 前置条件没成立，后面的「移出」结论就是空真 —— 直接标 inconclusive
            result.verified.setUserTagsIsReplace = null;
            ctx.say(`  ⚠ 没能把样本加进临时分组（code=${rAdd?.code}），Q2 判定为「结论无效」而不是假阳性`);
          } else {
            ctx.say('  ✓ 样本已进入临时分组');
            await sleep(2000);
            const rBack = await bili.setUserTags([mid], beforeTags);
            result.raw.setUserTagsRestoreCode = rBack?.code ?? null;
            await sleep(2000);
            const stillIn = (await bili.tagUsers(tagid)).some((u) => String(u.mid) === mid);
            result.verified.setUserTagsIsReplace = !stillIn;
            ctx.say(!stillIn
              ? '  ✓ Q2：传入不含该分组的列表后样本被移出 → setUserTags 确实是覆盖语义'
              : `  ✗ Q2：样本还在分组里 → setUserTags 是追加语义，上层「算完整目标集合」的做法要改`);
          }
          await sleep(1500);
          const rDel = await bili.deleteTag(tagid);
          result.raw.deleteTagCode = rDel?.code ?? null;
          ctx.say(rDel?.code === 0 ? '  已删除临时分组' : `  ⚠ 临时分组没删掉（code=${rDel?.code}），叫「${PROBE_TAG}」，可手动删`);
        }

        // ---- Q3：特别关注能不能通过分组接口写 ----
        await sleep(2000);
        const rSpecial = rec(result.raw, 'setSpecial', await bili.setUserTags([mid], [...beforeTags, SPECIAL_TAG_ID]));
        await sleep(2000);
        const specialCount = (await bili.specialFollowings()).size;
        const nowSpecial = (await bili.specialFollowings()).has(mid);
        result.specialCount = specialCount;

        if (nowSpecial) {
          result.verified.specialWritableViaTags = true;
          result.specialQuotaFull = false;
          ctx.say('  ✓ Q3：可以通过 tagid=-10 写入特别关注');
          await sleep(2000);
          await bili.setUserTags([mid], beforeTags);   // 立刻恢复
          ctx.say('  已把样本移出特别关注，恢复原状');
        } else if (rSpecial?.code === 22117) {
          // 22117 的 message 是「特殊关注达到上限」—— 这是配额，不是接口限制。
          // 和 22014 同理：收到业务规则拒绝，恰恰说明写入路径是通的。
          result.verified.specialWritableViaTags = true;
          result.specialQuotaFull = true;
          ctx.say(`  ⚠ Q3：写入路径可用，但特别关注已满（${specialCount} 个，code=22117「${rSpecial?.message}」）`);
          ctx.say('     腾出名额后 tagid=-10 就能写。这是配额问题，不是接口不支持。');
        } else {
          result.verified.specialWritableViaTags = false;
          result.specialQuotaFull = null;
          ctx.say(`  ✗ Q3：tagid=-10 写不进去（code=${rSpecial?.code}「${rSpecial?.message}」），原因待查`);
        }

        // ---- Q4：不存在的 tagid 会不会被静默接受 ----
        // 实测 tagids=999999999 返回 code 0 "OK"。这意味着传错 id **不报错**，
        // 而 setUserTags 是覆盖语义 —— 上层必须自己校验 tagid，否则会静默清空分组。
        await sleep(2500);
        const rBogus = rec(result.raw, 'bogusTagid', await bili.setUserTags([mid], [999999999]));
        result.verified.bogusTagidRejected = rBogus?.code !== 0;
        ctx.say(result.verified.bogusTagidRejected
          ? `  ✓ Q4：不存在的 tagid 被拒绝（code=${rBogus?.code}）`
          : '  ⚠ Q4：不存在的 tagid 返回 code=0（静默接受）→ 上层必须自己校验 tagid');
        await sleep(2000);
        await bili.setUserTags([mid], beforeTags);   // 恢复原分组

        // ---- Q1：act 取值 ----
        for (const [name, act] of [['follow', RELATION_ACT.follow], ['quietFollow', RELATION_ACT.quietFollow]]) {
          await sleep(2500);
          const r = rec(result.raw, name, await bili.modifyRelation(subject.mid, act));
          const c = classifyActCode(r?.code, r?.message);
          result.verified[name] = c.supported;
          ctx.say(`  act=${act}（${name}）→ code=${r?.code}「${r?.message ?? ''}」：${c.note}`);
        }
        result.verified.unfollow = true;   // act=2 是项目里早就实测过的

        // 确认关注关系没被搞坏
        await sleep(2000);
        const after = await bili.followings();
        const stillFollowing = after.list.some((u) => String(u.mid) === mid);
        result.raw.stillFollowing = stillFollowing;
        ctx.say(stillFollowing
          ? `  ✓ ${subject.uname} 仍在关注列表里，关系未被改动`
          : `  ⚠ ${subject.uname} 不在关注列表里了，请到网页端确认`);

        const usable = Object.entries(result.verified).filter(([, v]) => v === true).map(([k]) => k);
        const unusable = Object.entries(result.verified).filter(([, v]) => v === false).map(([k]) => k);
        const unknown = Object.entries(result.verified).filter(([, v]) => v === null).map(([k]) => k);
        result.summary = [
          `setUserTags 覆盖语义：${fmt(result.verified.setUserTagsIsReplace)}`,
          `特别关注可通过 tagid=-10 写入：${fmt(result.verified.specialWritableViaTags)}`
            + (result.specialQuotaFull ? `（但已达上限 ${result.specialCount} 个，需先腾名额）` : ''),
          `不存在的 tagid 会被拒绝：${fmt(result.verified.bogusTagidRejected)}`
            + (result.verified.bogusTagidRejected === false ? '（危险：上层必须自己校验）' : ''),
          `可用：${usable.join(', ') || '无'}`,
          `不可用：${unusable.join(', ') || '无'}`,
          ...(unknown.length ? [`结论无效（需重跑）：${unknown.join(', ')}`] : []),
        ];
        for (const s of result.summary) ctx.say('  ' + s);
        saveProbe('relation-act', result);
        return { code: 0, data: { probe: 'relation-act' } };
      },
    }],
    jobKind: 'probe', resumeKey: 'probe-relation-act',
  };
}

const fmt = (v) => (v === true ? '是' : v === false ? '否' : '结论无效');

const RATE_LOG = 'probe-rate-limit.jsonl';

/**
 * 限流探针：梯度加速逼出 -412 墙，然后测恢复时间。
 *
 * ## 为什么值得故意撞墙
 *
 * 之前那次失败扫描只留下聚合数字（4980 次里失败 4595），答不出真正要紧的问题：
 * 失败是在第几次、什么速率下开始的？调慢到底有没有用？墙什么时候撤？
 * 这些只有带时间戳的逐次记录才能回答。
 *
 * ## 两个互斥假设，这个探针就是为了区分它们
 *
 *   A 速率上限：单位时间发太多才拦 → 调大间隔就能一直跑
 *   B 窗口总量：某个时间窗内总共只让发 N 次 → 调慢没用，只是把墙推后
 *
 * 梯度设计能同时看到两个维度：每档固定速率跑 step-size 次，跑干净就提速。
 * 如果是 A，会在某个速率档位上突然失败；如果是 B，会在累计次数接近某个值时失败，
 * 而与当时处在哪个档位无关。
 *
 * ## 和上次失控的区别
 *
 * 上次的代价不是「撞了墙」，是**撞墙之后又硬撞了 4830 次、80 分钟**（很可能正是
 * 登录态被清掉的原因）。这里确认墙立起来之后立刻停，额外请求不超过 CONFIRM 次。
 *
 * ## 顺带做点有用功
 *
 * 样本取还没扫过投稿数据的 UP，成功的请求直接写进 uploads.json，不浪费。
 */
async function rateLimitProbe(ctx) {
  const { bili } = ctx;
  const data = cachedFollowings();
  if (!data) return ctx.usageError('没有关注列表缓存，先跑 bili-station scan follow');

  const known = new Map(store.read('uploads.json', []));
  const pool = data.list.filter((u) => !known.has(String(u.mid)) || known.get(String(u.mid))?.ok === false);
  if (pool.length < 100) return ctx.usageError(`可用样本只有 ${pool.length} 个，不够做梯度探针`);

  // 从慢到快。每档固定速率跑 step-size 次，跑干净就进下一档。
  const STEPS = [2000, 1500, 1200, 900, 700, 500, 350, 250];
  const STEP_SIZE = ctx.flags['step-size'];
  const MAX_REQ = ctx.flags['max-requests'];
  const CONFIRM = 8;            // 首次失败后最多再试这么多次来确认是墙不是抖动
  const CONFIRM_THRESHOLD = 5;  // 这 CONFIRM 次里失败这么多次就判定为墙
  const RECOVERY_MIN = ctx.flags['recovery-minutes'];

  ctx.say('限流探针：梯度加速，直到逼出 -412');
  ctx.say(`  档位 ${STEPS.map((d) => Math.round(60000 / (d + 300)) + '/分').join(' → ')}`);
  ctx.say(`  每档 ${STEP_SIZE} 次，总上限 ${MAX_REQ} 次，确认撞墙后立即停`);
  ctx.say(`  样本：${pool.length} 个还没投稿数据的 UP —— 成功的请求会写进 uploads.json，不浪费`);
  ctx.say('');

  return {
    data: { steps: STEPS, stepSize: STEP_SIZE, maxRequests: MAX_REQ, poolSize: pool.length },
    ops: [{
      label: `限流探针：梯度加速 ${STEPS.length} 档 / 最多 ${MAX_REQ} 次只读请求，逼出限流阈值`,
      op: 'read',
      weight: 5,
      run: async () => {
        const log = openLog(RATE_LOG);
        let i = 0, wall = null, authFail = null;
        const stepStats = [];

        outer:
        for (const delayMs of STEPS) {
          const st = { delayMs, reqPerMin: Math.round(60000 / (delayMs + 300)), n: 0, ok: 0, firstFailAtSeq: null };
          ctx.say(`  ── 档位 ${delayMs}ms（约 ${st.reqPerMin} 次/分）`);

          for (let k = 0; k < STEP_SIZE; k++) {
            if (i >= MAX_REQ) { ctx.say('  达到请求总数上限，停止'); break outer; }
            const u = pool[i % pool.length];
            i++;

            const r = await bili.spaceVideos(u.mid, { ps: 5 });
            const good = r.ok !== false;
            log.record({ mid: String(u.mid), code: good ? 0 : r.code, ok: good, delayMs, step: st.reqPerMin });
            st.n++;

            if (good) {
              st.ok++;
              known.set(String(u.mid), {
                ok: true, count: r.count ?? 0,
                lastPubTs: r.videos?.[0]?.created ?? null, videos: r.videos,
              });
            } else {
              if (AUTH_CODES.has(r.code)) { authFail = r.code; break outer; }
              if (st.firstFailAtSeq == null) st.firstFailAtSeq = i;

              if (RISK_CODES.has(r.code)) {
                ctx.say(`  ⚠ 第 ${i} 次请求撞上 code=${r.code}，再试 ${CONFIRM} 次确认是不是墙…`);
                let confirmFail = 0;
                for (let c = 0; c < CONFIRM; c++) {
                  await sleep(delayMs);
                  const u2 = pool[i % pool.length];
                  i++;
                  const r2 = await bili.spaceVideos(u2.mid, { ps: 5 });
                  const ok2 = r2.ok !== false;
                  log.record({ mid: String(u2.mid), code: ok2 ? 0 : r2.code, ok: ok2, delayMs, step: st.reqPerMin, note: 'confirm' });
                  st.n++;
                  if (ok2) st.ok++; else confirmFail++;
                }
                if (confirmFail >= CONFIRM_THRESHOLD) {
                  wall = { atSeq: i - CONFIRM, code: r.code, delayMs, reqPerMin: st.reqPerMin, confirmFail, confirmOf: CONFIRM };
                  ctx.say(`  ✗ 确认撞墙：确认段 ${CONFIRM} 次里失败 ${confirmFail} 次。立即停止（上次就是这里没停，又硬撞了 80 分钟）`);
                  stepStats.push(st);
                  break outer;
                }
                ctx.say(`  · 确认段只失败 ${confirmFail}/${CONFIRM}，算抖动不算墙，继续`);
              }
            }
            await sleep(delayMs);
          }

          ctx.say(`     ${st.ok}/${st.n} 成功${st.firstFailAtSeq ? `（第 ${st.firstFailAtSeq} 次有过失败）` : ''}`);
          stepStats.push(st);
        }

        store.write('uploads.json', [...known]);

        // ---- 恢复计时：墙什么时候撤，这是最有操作价值的一个数 ----
        let recovery = null;
        if (wall && RECOVERY_MIN > 0) {
          ctx.say('');
          ctx.say(`  等待恢复：每 2 分钟单发一次请求，最多等 ${RECOVERY_MIN} 分钟`);
          const t0 = Date.now();
          for (let m = 2; m <= RECOVERY_MIN; m += 2) {
            await sleep(120_000);
            const u = pool[i % pool.length];
            i++;
            const r = await bili.spaceVideos(u.mid, { ps: 5 });
            const good = r.ok !== false;
            log.record({ mid: String(u.mid), code: good ? 0 : r.code, ok: good, delayMs: 120_000, note: 'recovery' });
            ctx.say(`     +${m} 分钟：${good ? '✓ 通了' : 'code=' + r.code}`);
            if (good) {
              recovery = { minutes: Math.round((Date.now() - t0) / 60000), probes: Math.ceil(m / 2) };
              known.set(String(u.mid), { ok: true, count: r.count ?? 0, lastPubTs: r.videos?.[0]?.created ?? null, videos: r.videos });
              store.write('uploads.json', [...known]);
              break;
            }
          }
          if (!recovery) recovery = { minutes: null, note: `等了 ${RECOVERY_MIN} 分钟仍未恢复` };
        }

        const curve = analyze(readLog(RATE_LOG));
        const summary = [
          authFail ? `⚠ 登录态在探测中失效（code=${authFail}）` : null,
          wall
            ? `撞墙：第 ${wall.atSeq} 次请求，档位 ${wall.delayMs}ms（约 ${wall.reqPerMin} 次/分），code=${wall.code}`
            : `跑完 ${i} 次都没撞墙（最快档 ${STEPS[STEPS.length - 1]}ms）`,
          curve?.rateAtFirstFail ? `首次失败时的瞬时速率：${curve.rateAtFirstFail.toFixed(1)} 次/分` : null,
          curve?.leakRateAfterWall != null ? `墙后漏过率：${(curve.leakRateAfterWall * 100).toFixed(1)}%` : null,
          recovery?.minutes != null ? `恢复耗时：约 ${recovery.minutes} 分钟` : (recovery?.note ?? null),
          `各档位成绩：${stepStats.map((s) => `${s.reqPerMin}/分 ${s.ok}/${s.n}`).join(' | ')}`,
          // 两个假设的判据
          wall && stepStats.length === 1
            ? '倾向「窗口总量上限」：第一个（最慢的）档位就撞墙了，说明不是速率的问题'
            : wall
              ? `倾向「速率上限」：前 ${stepStats.length - 1} 个较慢档位都跑干净了，是提速之后才撞的`
              : null,
        ].filter(Boolean);
        for (const s of summary) ctx.say('  ' + s);

        saveProbe('rate-limit', {
          wall, recovery, stepStats, curve, totalRequests: i,
          authFailed: authFail ?? null, logPath: log.path, summary,
        });
        return { code: 0, data: { probe: 'rate-limit' } };
      },
    }],
    jobKind: 'probe', resumeKey: 'probe-rate-limit',
  };
}
