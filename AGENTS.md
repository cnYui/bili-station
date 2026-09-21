# 给 agent 的操作说明

这个仓库提供 `bili-station` CLI，用来整理用户的 B 站账号（收藏夹分类、关注清理）。
你（Claude / Codex 等）可以直接调用它。**动手前先读完这一页。**

## 硬性规则

1. **任何写操作都必须先干跑。** 不加 `--yes` 就是干跑。先跑一次不带 `--yes` 的，把计划念给用户听，
   得到明确同意后再加 `--yes` 重跑同一条命令。**绝不要自己替用户决定执行。**
2. **默认用 `--mode copy`。** 只有用户明确说要移动时才用 `--mode move`——移动不可逆。
3. **先小批量试。** 第一次带 `--yes` 时加 `--limit 30`，让用户看过结果再放开。
4. **退出码 2（风控中止）时停手。** 不要重试、不要换参数再冲。告诉用户等一段时间（建议 1 小时以上）再继续。
5. **退出码 3（登录失效）时停手。** 让用户去 Chrome 里重新登录，不要尝试任何绕过。
6. **退出码 5（参数错误）是可以自己修的。** 错误信息会告诉你哪个参数错了、合法值是什么，
   拼错的 flag 还会给出最接近的候选名。改对了重跑即可，不用问用户。
7. 所有命令加 `--json`，stdout 会是单个 JSON 信封，stderr 是进度日志。

## 前置条件

```bash
npm run chrome        # 开一个带调试端口的 Chrome，用户需在里面登录 B 站
bili-station status --json
```

`status` 返回 `loggedIn: false` 就别往下走，先让用户完成上面两步。

## 能力发现

不用读这一页也能知道有什么命令、每个参数什么类型：

```bash
bili-station schema --json        # 全部命令 / 参数类型 / 枚举值 / 必填项 / 退出码语义
bili-station <命令> --help        # 单个命令的用法
```

## JSON 信封

所有命令同形，**业务数据在 `data` 下**：

```json
{ "ok": true, "v": 1, "command": "sort", "dryRun": true, "exit": 0,
  "data": { ... }, "warnings": [{ "code": "...", "message": "..." }], "error": null }
```

老脚本按扁平结构解析的，加 `--json-flat` 拿回旧形状。

## 收藏夹分类的标准流程

核心约束：**候选收藏夹由用户定，分类只能从候选里选唯一一个，不允许发明新分类。**
**分类由你来做**（默认 `--engine external`），CLI 不外挂模型、不需要任何 API key。

```bash
# 1. 看现状，把现有收藏夹念给用户，问他想分成哪几类
bili-station status --json

# 2. 拿待分类清单。stdout 是 {candidates, instruction, items}
bili-station sort --folders "编程开发,游戏,美食烹饪,科普知识" --emit-tasks tasks.json --json

# 3. 你来分类：给每条选一个 candidates 里的分类名，写成 {"<视频id>":"<分类名>"} 存成 assign.json

# 4. 干跑看计划
bili-station sort --folders "编程开发,游戏,美食烹饪,科普知识" --assign assign.json --json

# 5. 把计划念给用户（每类多少条、会新建哪几个夹、有没有 warnings），等他确认

# 6. 小批量执行
bili-station sort --folders "编程开发,游戏,美食烹饪,科普知识" --assign assign.json --limit 30 --yes --json

# 7. 用户满意后放开
bili-station sort --folders "编程开发,游戏,美食烹饪,科普知识" --assign assign.json --yes --json
```

分类时只看 `items` 里的 `title` / `up` / `intro`。**分类名必须与 candidates 逐字一致**
（大小写和首尾空格会被容忍，别的不会）。不在候选集里的会被**拒收**而不是静默乱放——
结果里的 `rejected` 不为 0 就说明你给错了名字，看 stderr 里列出的拒收项，改完重来。
`missing` 是你漏给的条数。

常用变体：
- `--include-existing` 把用户现有的收藏夹也纳入候选（多数情况下用户想要这个）
- `--source 101,102` 只处理指定来源夹；默认 `all` 且会自动排除候选夹本身
- `--lazy-create` 只创建真正分到视频的夹，避免留下空夹

不想自己分类时还有两条路，但**都不是默认**：
- `--engine keyword` 本地关键词规则
- `--engine deepseek` CLI 自己调模型，需要用户自备 `DEEPSEEK_API_KEY`；没有就别提这条路

## 关注清理

```bash
bili-station scan follow --json
bili-station unfollow --keep 500 --json                   # 干跑
bili-station unfollow --keep 500 --yes --json             # 执行
bili-station unfollow --only-inactive --inactive-days 365 --json
```

特别关注无条件保留，不受任何参数影响。

注意结果里的 `truncated`：为 true 说明 B 站的分页深度限制导致关注列表**没拉全**，
这时 `total` 和实际处理数对不上是正常的，要如实告诉用户，别说成「已全部清理」。

## 新夹里的排列顺序

B 站的 move/copy 会把 `fav_time` 重写成操作时间，所以**提交顺序的逆序 = 最终显示顺序**
（`probe fav-order` 实测确认）。默认 `--order original` 让新夹里「最近收藏的排最上面」，
和原来一致。用户说「顺序不对 / 最新的跑到最底下了」时，多半是在用旧数据或 `--order as-scanned`。

排序精度只到一批（默认 20 条）。用户要求逐条精确时才用 `--chunk-size 1`，
**先把调用次数上涨 20 倍这件事告诉他**。

## 关注管理

```bash
bili-station follow list --tag 编程 --json
bili-station follow list --state special --json
bili-station follow tag create "长期追更" --yes --json
bili-station scan uploads --videos 5 --json   # 投稿时间 + 最近 5 条视频的标题/简介
```

**先分清确定性和语义。** 「一年没更新」「投稿数为 0」这类有精确判据的，
用确定性过滤，别交给模型：

```bash
bili-station unfollow --only-inactive --inactive-days 365 --json
```

只有「内容转型了」「全是恰饭」「和我关注的方向无关」这类才需要语义裁决：

```bash
bili-station follow remove --inactive-days 180 --query "<用户原话>" --emit-candidates c.json --json
# 你读 candidates 里的 recentVideos 判断，写 {"selected":{"<uid>":"<理由>"}}
bili-station follow remove --apply picked.json --json        # 干跑
bili-station follow remove --apply picked.json --yes --json  # 执行
```

**特别关注受配额限制**：22117 的 message 是「特殊关注达到上限」。写入路径是通的，
只是名额满了——如实告诉用户「先在网页端移除几个特别关注再来」，别说成"接口不支持"。

**悄悄关注目前设不了**（act=3 → -400）。CLI 会直接拦下，别绕过，也别告诉用户"设好了"。

**绝不要手写 tagid**。B 站对不存在的 tagid 返回 code 0（静默接受），
而分组是覆盖语义——传错会清空那个人的分组。一律用 `follow list` 读出来的真实 tagid。

详见 `docs/context/ai/03-探针实测.md`。

## 需要如实转述给用户的字段

（都在 `data` 下，除了 `warnings`）

- `warnings[]` —— 配额/容量预警。特别是 `folder-quota`：**配额满时 B 站的报错长得像限流，其实不是**，别误导用户以为是风控。
- `data.needReview` —— 置信度偏低、建议人工复核的条数。
- `data.truncated` —— 关注列表是否没拉全。
- `data.orderCost` —— `--order-scope global` 会多花多少次调用。
- `data.result.riskHits` —— 本轮命中风控几次。不为 0 就要提醒用户放慢。
- `data.status` 为 `stopped` —— 是撞风控主动停的，不是跑完了。
- `data.rejected` —— 被拒收的条数（分类名不在候选集 / 受保护对象 / 没给理由）。
  **拒收的那些什么都没做**，别算进成功数。

## 不要做的事

- 不要为了「跑快点」去改 `~/.bili-station/config.json` 里的风控参数。
- 不要在失败后循环重试；执行器内部已有退避，外层再重试只会加重风控。
- 不要把 `~/.bili-station/config.json` 的内容打印出来（可能有 API key）。
- 不要替用户去申请、填写或硬编码任何 API key。默认路径根本不需要 key。
- 不要用 `--mode move` 做第一次尝试。
