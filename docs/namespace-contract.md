# 订阅工具命名空间合同（03）

本合同描述离线候选的请求投影，不表示安装、当前进程已更新、真实 SIWC 服务端已接受参数或缓存命中已改善。工具响应、持久化与历史降级由 04 继续实施，本票不修改 BC。

## 声明与增量声明

- 身份主键为 `(namespace, name)`；同一主键必须保留相同的 `function` / `custom` 类型与定义。不同命名空间中的相同裸名称是不同身份。
- 顶层平铺的本地工具归入 `dsh`。已有 `dsh` 组时保留其元数据与子工具顺序，再按平铺工具出现顺序追加；没有该组时在已有命名空间后创建默认组。显式命名空间按首次出现顺序保留，兼容的同名组稳定合并。
- 同一位置内，完全相同的工具定义稳定去重；对象属性顺序不影响相等性。数组顺序仍有意义。类型、参数或其他定义元数据冲突，以及同名组的不兼容元数据，在 HTTP 前以固定安全诊断拒绝，不返回原始声明内容。缺失的组元数据可以补入，已有值不覆盖。
- 每个 `additional_tools` 在原历史位置独立归一化。顶层和各历史边界之间只验证同一限定身份的定义是否冲突；不跨边界去重、合并或搬移相同声明。新增能力不会提前移到顶层。不同边界的兼容组元数据不被强制统一。
- 受控原生搜索仅过滤平铺或 `dsh` 中的本地 `web_search` 声明；例如 `remote.web_search` 仍是另一个本地工具身份。历史搜索调用和结果不是声明，不删除。原生托管 `web_search` 仍由适配器添加。

实现见 [请求投影](../src/provider.ts)，主行为验收见 [完整适配器测试](../test/adapter-namespace.test.ts)。

## 选择器：证据不足时拒绝，不推测

`auto`、`none`、`required` 保留既定支持。仅受控原生搜索路径保留已有的 `{ type: 'web_search' }`（不带其他字段）选择。`purpose=compaction` 先确定最终有效策略为 `none`，晚期 hook 不会重新放开工具。

2026-10-29 核对官方 [SIWC Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) 与 [Responses 指南](https://developers.openai.com/api/docs/guides/responses)：前者确认本地工具使用 namespace、动态工具使用 `additional_tools`，但没有建立 function/custom 强制选择器的精确 SIWC 格式。通用 Responses 的工具定义、选择器或 `allowed_tools` 形式不能自动作为订阅路由支持证据。

因此 function/custom 强制选择先按最终声明的限定身份解析，未声明或歧义时明确失败；即使身份唯一，仍以未确认 SIWC selector 合同拒绝。未知形式、`allowed_tools`、伪装成模式的对象或数组也在 HTTP 前拒绝。此为有意收紧旧版“调用工具定义验证器后原样透传”的行为，不宣称这些格式在线必然被拒绝。

## 供 04 消费的窄身份接口

[提供方模块](../src/provider.ts) 导出：

- `QualifiedToolIdentity = { namespace, name, type: 'function' | 'custom' }`。
- `qualifiedToolKey(identity)`：用 JSON 二元组编码 namespace/name，避免分隔符碰撞，不把类型变化当作另一个同名身份。
- `resolveToolIdentity(trustedIdentities, { name, namespace?, type? })`：只在给定可信身份集合中解析，拒绝未声明、歧义或同一主键的矛盾类型；不把缺失命名空间默认补成 `dsh`。
- `CapabilityError`：固定安全诊断类型，经过现有请求错误策略传播。

**可信来源由调用方负责。** 对历史回放，集合可以来自可信原始 call / envelope，而不只限于当前工具列表；当前未声明某个旧工具，不能单独否认有效历史身份。只有可证明的本地平铺来源才能归入 `dsh`。本票没有替 04 实现这项生命周期策略。

## BC 合法协议夹具与已知消费者边界

[可复用 JSON 夹具](../test/fixtures/bc-namespace-contract.json) 声明真实的 `dsh.run_code`，没有为迎合消费者而扁平化或伪造顶层 `run_code`。两条完整适配器入口均断言最终 HTTP wire 保留该组及适配器管理的原生搜索。

[可选只读核对脚本](../scripts/verify-bc-namespace.mjs) 从显式指定的、已审计 BC bundle 中仅提取并执行原始纯扫描/决策函数，不导入 BC、不启动运行时、不访问 profile/状态、不联网；不把 BC 或巨型审计 bundle 加入默认测试依赖。它针对已核源码形状，源码变化时失败，不能当通用 JavaScript 解析器或不可信代码沙箱。

Node 24，在仓库根目录执行（将参数替换为已审计 BC 源码路径）：

```bash
node scripts/verify-bc-namespace.mjs /absolute/path/to/billion-context/dist/index.js
```

本次对 BC 0.1.209 原始 bundle 的只读结果：

- SHA-256：`97dbbde960d3626ca8b7bd39f89c75046c1af19837053fd574317a5ddf75a173`。
- 实际 `observeDeclaredTools` 返回 `["dsh"]`，未识别子工具 `run_code`。
- 实际 `resolveLaneDecisions` 在 `pluginAgent=dsh`、`protocol=responses`、`pluginMode=true`、plugin header 存在及应注入的条件下，返回 `compressReachable=false`、`compressSurfaceOn=false`。

消费者需要识别 namespace 子工具身份，而不是要求适配器删除合法包装。本票没有修改 BC、压缩调度、紧急截短或缓存归因；离线候选绿色不表示 BC 普通压缩已恢复，也不能证明低缓存命中已消失。
