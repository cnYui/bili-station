import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../registry.mjs';
import { store } from '../context.mjs';
import { loadCache, saveCache, itemsOf, scanMany } from '../favcache.mjs';
import { sleep, RiskEngine, RISK_CODES, AUTH_CODES } from '../../risk.mjs';
import { EXIT } from '../output.mjs';
import { openLog, readLog, analyze } from '../reqlog.mjs';

export default defineCommand({
  name: 'scan',
  summary: '把 B 站的数据拉到本地缓存（只读，可反复跑，会断点续扫）',
  usage: '[fav|follow|uploads|sample]',
  needsChrome: true,
  subs: {
    fav: '收藏夹内容（默认）',
    follow: '关注列表 + 特别关注 + 分组',
    uploads: 'UP 主最近投稿时间 —— unfollow 的 --inactive-days 依赖它',
    sample: '抽样读取一个夹，用于设计分类体系',
  },
  flags: {
    folder: { type: 'idList', desc: 'fav/sample：只处理这几个夹；默认全部' },
    refresh: { type: 'boolean', desc: '忽略本地缓存重新拉取' },
    'page-delay': { type: 'int', min: 0, desc: '翻页间隔 ms，覆盖按规模自动降速' },
    ratio: { type: 'float', min: 0.01, max: 1, default: 0.25, desc: 'sample：抽样比例' },
    out: { type: 'path', desc: 'sample：样本输出路径' },
    limit: { type: 'int', min: 1, desc: 'uploads：只查前 N 个（按最近关注排序）' },
    delay: {
      type: 'int', min: 300, max: 10000, default: 1200,
      desc: 'uploads：每次请求之间的基础间隔 ms（实际会再加 0~600ms 抖动）。'
        + '实测 500ms 跑到第 ~150 个就会撞 -412 墙，所以默认给到 1200。'
        + '真正的保护是连续失败熔断，不是这个数字',
    },
    videos: {
      type: 'int', min: 0, max: 50, default: 5,
      desc: 'uploads：每个 UP 取最近 N 条视频的标题/简介/发布时间。0 = 只要最后投稿时间。'
        + '取 1 条和取 50 条是同一次请求，不影响调用次数。上限 50（实测 100 会 -400）',
    },
  },
  examples: [
    'scan fav --folder 106154023',
    'scan uploads --limit 300',
    'scan uploads --videos 0        # 只判断停更，最省',
    'scan uploads --videos 10       # 给语义判断留足证据',
    'scan sample --folder 106154023 --ratio 0.3',
  ],

  async plan(ctx) {
    const what = ctx.positionals[0] ?? 'fav';
    const pageDelay = ctx.flags['page-delay'];

    if (what === 'fav') {
      const folders = await ctx.bili.favFolders();
      const only = ctx.flags.folder;
      const want = only ? folders.filter((f) => only.includes(Number(f.id))) : folders;
      if (only && !want.length) return ctx.usageError(`--folder 指定的夹一个都不存在：${only.join(', ')}`);

      const { cache, incomplete } = await scanMany(
        ctx.bili, want.map((f) => f.id), folders, ctx,
        { refresh: !!ctx.flags.refresh, pageDelayMs: pageDelay },
      );
      const counts = Object.fromEntries(want.map((f) => [f.id, itemsOf(cache, f.id).length]));
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return {
        data: { folders, counts, total, incomplete },
        warnings: incomplete ? [{ code: 'INCOMPLETE_SCAN', message: `${incomplete} 个夹未扫完，重跑会自动续扫` }] : [],
      };
    }

    if (what === 'follow') {
      const r = await ctx.bili.followings((n, t) => { if (n % 200 === 0) ctx.say(`  已拉取 ${n}${t ? '/' + t : ''}`); });
      const special = await ctx.bili.specialFollowings();
      const tags = await ctx.bili.tags();
      store.write('followings.json', r);
      store.write('special.json', [...special]);
      store.write('tags.json', tags);
      return {
        data: { count: r.list.length, total: r.total, truncated: r.truncated, special: special.size, tags },
        warnings: r.truncated
          ? [{ code: 'TRUNCATED', message: `只读到 ${r.list.length}/${r.total ?? '?'}，这是 B 站分页深度限制，不是 bug` }]
          : [],
      };
    }

    if (what === 'uploads') {
      // 重构前这个数据只有 Web UI 能生成，导致 CLI 的 --inactive-days / --only-inactive
      // 恒定命中 0 个目标（读的是一个永远为空的 uploads.json）。这里补上生产者。
      let data = store.read('followings.json', null);
      if (!data || ctx.flags.refresh) {
        ctx.say('先拉关注列表…');
        data = await ctx.bili.followings((n, t) => { if (n % 200 === 0) ctx.say(`  ${n}${t ? '/' + t : ''}`); });
        store.write('followings.json', data);
      }
      const known = new Map(store.read('uploads.json', []));
      // 风控码留下的记录是「没读到」，不是「这个 UP 没有视频」—— 直接清掉重查，
      // 否则它们会一直以 {ok:false} 的形式赖在文件里冒充数据
      let purged = 0;
      for (const [k, v] of known) {
        if (v?.ok === false && RISK_CODES.has(v.code)) { known.delete(k); purged++; }
      }
      if (purged) ctx.say(`清掉 ${purged} 条被风控污染的记录（-412/-352 是没读到，不是没视频）`);
      const nVideos = ctx.flags.videos;
      let list = data.list;
      if (ctx.flags.limit) list = list.slice(0, ctx.flags.limit);

      // 已有记录但视频条数不够时也要重查 —— 否则先跑了 --videos 0 再跑 --videos 5 会全被跳过
      const enough = (rec) => rec && rec.ok !== false && (nVideos === 0 || (rec.videos?.length ?? 0) >= Math.min(nVideos, rec.count ?? 0));
      const todo = ctx.flags.refresh ? list : list.filter((u) => !enough(known.get(String(u.mid))));

      const perReq = (ctx.flags.delay + 300) / 1000 + 0.25;   // 间隔 + 抖动均值 + 请求本身
      ctx.say(`关注 ${data.list.length} 个，本次需要查 ${todo.length} 个（已有 ${known.size} 条缓存）`);
      ctx.say(nVideos === 0
        ? '只取最后投稿时间（够用来判断停更）'
        : `每个 UP 取最近 ${nVideos} 条视频的标题/简介/发布时间 —— 和只取时间是同一次请求，不多花调用`);
      if (todo.length > 200) {
        ctx.say(`预计约 ${Math.ceil(todo.length * perReq / 60)} 分钟。这是只读操作，中断了重跑会接着查。`);
      }

      // 读操作也必须受风控约束。第一版这个循环既不退避也不熔断，撞墙后
      // 又硬撞了 80 分钟 / 4830 次（-412 占 3900 个），而热度表因为没记录
      // 还一直报 green。三个洞一起补上。
      const risk = new RiskEngine(ctx.cfg.risk, store.read('risk-history.json', null));
      // 逐次埋点：聚合数字（「4980 次里失败 4595」）答不出「失败从第几次、
      // 什么速率下开始」，而限流的一切都在时间维度上
      const log = openLog('scan-uploads.jsonl');
      const MAX_CONSECUTIVE = 5;   // 连续这么多个都撞风控码就认定「墙立起来了」
      const RETRY = 2;
      let done = 0, failed = 0, riskHits = 0, consecutive = 0, added = 0;
      let stopped = null;

      const fetchOne = async (mid) => (nVideos === 0
        ? ctx.bili.lastUpload(mid)
        : ctx.bili.spaceVideos(mid, { ps: nVideos }));

      for (const u of todo) {
        if (stopped) break;
        let r = null;
        for (let attempt = 1; attempt <= RETRY + 1; attempt++) {
          try { r = await fetchOne(u.mid); } catch (e) { r = { ok: false, code: -1, message: e.message }; }
          log.record({ mid: String(u.mid), code: r.ok === false ? r.code : 0, ok: r.ok !== false, delayMs: ctx.flags.delay, attempt });
          if (r.ok !== false || !RISK_CODES.has(r.code)) break;
          riskHits++;
          if (attempt > RETRY) break;
          // 和 favItems 同一套退避：撞一次就放弃会把「读不到」伪装成「没有」
          const wait = 15_000 * attempt;
          ctx.say(`  ⏸ 被限流（code=${r.code}），退避 ${wait / 1000}s 后重试（第 ${attempt} 次）`);
          await sleep(wait);
        }

        if (r.ok === false && AUTH_CODES.has(r.code)) {
          stopped = { reason: 'auth', code: r.code };
          break;
        }
        if (r.ok === false && RISK_CODES.has(r.code)) {
          consecutive++;
          failed++;
          // 撞墙即停，和执行器的 stopOnRisk 同一个道理：退避过还是撞，
          // 说明不是抖动而是墙。继续撞只会让墙更高。
          if (consecutive >= MAX_CONSECUTIVE) { stopped = { reason: 'risk', code: r.code }; }
        } else {
          consecutive = 0;
          if (r.ok === false) failed++;
          else risk.record('read', 1);
          known.set(String(u.mid), r.ok === false ? { ok: false, code: r.code } : {
            ok: true,
            count: r.count ?? 0,
            lastPubTs: r.lastPubTs ?? r.videos?.[0]?.created ?? null,
            ...(r.videos ? { videos: r.videos } : {}),
          });
          if (r.ok !== false) added++;
        }

        done++;
        if (done % 25 === 0) {
          store.write('uploads.json', [...known]);   // 边查边存，中断也不白跑
          store.write('risk-history.json', risk.toJSON());
          ctx.say(`  ${done}/${todo.length}${failed ? `（失败 ${failed}）` : ''}  热度 ${risk.status().heat}/100`);
        }
        if (!stopped && done < todo.length) await sleep(ctx.flags.delay + Math.random() * 600);
      }

      store.write('uploads.json', [...known]);
      store.write('risk-history.json', risk.toJSON());
      const withVideos = [...known.values()].filter((x) => x.videos?.length).length;
      const okCount = [...known.values()].filter((x) => x.ok !== false).length;

      const curve = analyze(readLog('scan-uploads.jsonl'));
      if (curve?.firstFailAt) {
        ctx.say(`曲线：首次失败在第 ${curve.firstFailAt} 次（code=${curve.firstFailCode}），`
          + `当时瞬时速率 ${curve.rateAtFirstFail?.toFixed(1) ?? '?'} 次/分`
          + (curve.leakRateAfterWall != null ? `，墙后漏过率 ${(curve.leakRateAfterWall * 100).toFixed(1)}%` : ''));
      }

      const warnings = [];
      if (stopped?.reason === 'risk') {
        warnings.push({
          code: 'RISK_WALL',
          message: `连续 ${MAX_CONSECUTIVE} 个 UP 都撞上风控码（最后一个 code=${stopped.code}），已中止本轮。`
            + `本次新增 ${added} 条，进度已保存，重跑会从没查到的接着查。`
            + '建议等 1 小时以上，并把 --delay 调大（比如 2000）再来。',
        });
      }
      if (stopped?.reason === 'auth') {
        warnings.push({ code: 'AUTH', message: `登录态失效（code=${stopped.code}），请在 Chrome 里重新登录 B 站。` });
      }
      if (failed && !stopped) {
        warnings.push({ code: 'PARTIAL', message: `${failed} 个 UP 没查到（私密空间 / 已注销），重跑会再试一次` });
      }

      return {
        data: {
          checked: done, added, failed, riskHits, cached: known.size, ok: okCount,
          withVideos, videosPerUp: nVideos, followings: data.list.length,
          heat: risk.status().heat, stopped: stopped?.reason ?? null, curve,
          remaining: todo.length - done,
        },
        warnings,
        exit: stopped?.reason === 'risk' ? EXIT.RISK : stopped?.reason === 'auth' ? EXIT.AUTH : EXIT.OK,
      };
    }

    if (what === 'sample') {
      const folders = await ctx.bili.favFolders();
      const fid = Number(ctx.flags.folder?.[0] ?? folders[0]?.id);
      const f = folders.find((x) => Number(x.id) === fid);
      if (!f) return ctx.usageError(`找不到收藏夹 ${fid}。用 bili-station folders 看现有的。`);

      const step = Math.max(1, Math.round(1 / ctx.flags.ratio));
      const totalPages = Math.ceil(f.count / 20);
      const willRead = Math.ceil(totalPages / step);
      ctx.say(`「${f.title}」共 ${f.count} 条 / ${totalPages} 页`);
      ctx.say(`抽样：每 ${step} 页取 1 页 → 读 ${willRead} 页，约 ${willRead * 20} 条（${Math.round(100 / step)}%），预计 ${Math.ceil(willRead * 2.75 / 60)} 分钟`);

      const r = await ctx.bili.favSample(fid, {
        totalCount: f.count, step,
        ...(pageDelay != null ? { pageDelayMs: pageDelay } : {}),
        onProgress: (p) => {
          if (p.throttled) ctx.say(`  ⏸ 第 ${p.page} 页被限流（code=${p.code}），退避 ${Math.round(p.waitMs / 1000)}s（第 ${p.attempt} 次）`);
          else if (p.done % 10 === 0) ctx.say(`  ${p.done}/${p.totalPages} 页，已取 ${p.items} 条`);
        },
      });
      const out = ctx.flags.out ?? join(store.DATA_DIR, 'sample-' + fid + '.json');
      writeFileSync(out, JSON.stringify({ folder: f, ...r }, null, 2));
      return {
        data: { folder: f, sampled: r.list.length, sampledPages: r.sampledPages, totalPages: r.totalPages, failed: r.failed, out },
        warnings: r.failed.length ? [{ code: 'PARTIAL', message: `${r.failed.length} 页读取失败` }] : [],
      };
    }

    return ctx.usageError(`未知子命令：scan ${what}（可用：fav / follow / uploads / sample）`);
  },

  render(r, ctx) {
    const d = r.data;
    if (d.counts) {
      for (const [id, n] of Object.entries(d.counts)) {
        const f = d.folders.find((x) => String(x.id) === String(id));
        ctx.say(`  ${String(id).padEnd(12)} ${(f?.title ?? '').padEnd(14)} ${n} 条`);
      }
      ctx.say(`合计 ${d.total} 条`);
    } else if (d.checked != null) {
      ctx.say(`投稿信息：本次查了 ${d.checked} 个，累计缓存 ${d.cached} 条${d.withVideos ? `（其中 ${d.withVideos} 个带视频详情）` : ''}`);
      ctx.say('现在可以用了：');
      ctx.say('  确定性过滤   unfollow --only-inactive --inactive-days 365');
      if (d.withVideos) ctx.say('  语义裁决     follow remove --inactive-days 180 --emit-candidates cand.json');
    } else if (d.sampled != null) {
      ctx.say(`样本 ${d.sampled} 条（${d.sampledPages}/${d.totalPages} 页）已写入 ${d.out}`);
    } else if (d.count != null) {
      ctx.say(`关注 ${d.count} 个，特别关注 ${d.special} 个，分组 ${d.tags.length} 个`);
    }
    for (const w of r.warnings ?? []) ctx.say('  ⚠ ' + w.message);
  },
});
