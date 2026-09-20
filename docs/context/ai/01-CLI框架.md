# P0：CLI 框架

## 问题

重构前 `cli.mjs` 是 802 行单文件，7 个命令各 60–150 行。真正的问题不是长，
是**参数没有单一真源**：一个 flag 的存在性散在三个地方——

1. `parseArgs` 隐式接受任意字符串
2. 命令体里 `args.flags.x ?? 默认值` 现场解释
3. help 里一段手写文本

后果是可验证的，不是理论推测：

- **help 漏了 5 个已实现的 flag**（`scan --refresh` / `scan --page-delay` /
  `scan sample --out` / `sample --page-delay` / `merge --page-delay`）
- **拼错的 flag 完全不报错**，静默走默认路径。对 agent 这是最坏的失败模式，
  它会以为参数生效了
- **boolean flag 吞掉后面的位置参数**：`folders create --yes "A,B"` →
  `flags.yes = "A,B"`，名字列表为空
- 干跑闸门 + 备份 + Job + 信封这 15 行样板在 5 个命令里各抄一遍

## 结构

```
cli.mjs                     瘦入口（~120 行）：解析 → 校验 → 分发 → 统一收尾
src/cli/
  args.mjs        类型化解析 + 校验（boolean 永不消费下一个 token）
  registry.mjs    命令注册表 + 能力开关，参数的唯一真源
  context.mjs     ctx：配置、Chrome 连接、探针结果
  runner.mjs      plan → render → 干跑闸门 → 备份 → Job → 信封 → 退出码
  output.mjs      JSON 信封 + 退出码语义
  help.mjs        help 与 schema 都从注册表生成
  favcache.mjs    收藏夹缓存的**唯一**读写入口
  selector.mjs    外部裁决选择器（见 06）
  followdata.mjs  关注数据装载与状态判定（见 05）
  commands/       一命令一文件
```

`src/` 下原有的四层（`cdp` / `bili` / `plan` / `executor`）**边界没动**。
这次重构只在编排层，纯逻辑层照旧不碰 IO。

## 能力开关（capability）

这是「新命令是勾开关而不是抄样板」的实现。`defineCommand` 里勾一个开关，
自动注入一组共享 flag + 一段 runner 行为：

| 开关 | 注入的 flag | runner 行为 |
|---|---|---|
| `mutating` | `--yes` | 干跑闸门 + 强制备份 + Job 执行 + 语义退出码 |
| `needsChrome` | — | 自动 connect / finally close |
| `ordered` | `--order` `--order-scope` `--chunk-size` | 提交前重排 + 摘要打印调用次数变化 |
| `selectable` | `--emit-candidates` `--apply` `--max-select` `--allow-protected` | 候选清单 + 回填校验 + 受保护对象拒收 |

加新命令时只需要写 `plan()` 和 `render()`，其余全部继承。

## plan / render / execute 三段拆分

```js
plan(ctx)   →  { data, ops, backup, warnings, nothing?, readonly?, handled? }
render(r, ctx)  →  只写人类可读输出，不做任何判断
runner      →  干跑闸门、备份、Job、信封、退出码
```

副产品比主产品更值钱：**`plan()` 不做任何写操作**，可以注入假 bili 直接断言。
`test-cli.mjs` 的 92 条断言全部基于这一点，一次 Chrome 都不用连。重构前的命令体
做不到——它们把「算」和「写」混在一个函数里。

特殊返回值：
- `readonly: true` —— 写命令里的只读子命令（如 `folders list`），跳过干跑闸门
- `handled: true` —— 命令自己处理了输出（如 `sort --emit-tasks` 吐清单后就停）
- `nothing: true` + `nothingReason` —— 无事可做，退出码 4，**带明确原因**

## JSON 信封

所有命令同形，带版本号：

```json
{
  "ok": true, "v": 1, "command": "merge", "dryRun": true, "exit": 0,
  "data": { ... }, "warnings": [{ "code": "...", "message": "..." }], "error": null
}
```

重构前每个命令一个形状，调用方要为 7 个命令写 7 套解析。
`--json-flat` 保留旧的扁平形状，给重构前写的脚本兜底。

## schema：给 agent 的能力发现

`bili-station schema --json` 吐出全部命令、参数类型、枚举值、必填项、
写操作标记、退出码语义。agent 不用读 README 就能发现能力。

同一份 schema 也是未来包一层 MCP server 的直接输入（一个命令 = 一个 tool，
零额外维护）。这是当初选注册表而不是 switch-case 的主要理由。

## 参数类型

`boolean / string / int / float / enum / csv / idList / midList / path / folderRef / tagRef`

- `boolean` 的 `CONSUMES = false` —— 这一条就根治了吞位置参数的问题
- 未知 flag 用编辑距离给出候选名（`--foldres` → 「是不是想写 --folders？」），
  退出码 5
- `midList` 一律按字符串处理：mid 是大整数，转 Number 会丢精度

## 验收

```bash
npm test          # 63 + 92 + 59 = 214 条，全部不需要 Chrome
npm run test:cli  # 只跑 CLI 框架层的 92 条
```

`test-cli.mjs` 覆盖：参数解析边界、排序、选择器护栏、每个命令的 `plan()`、
schema 完整性、缓存归一化。
