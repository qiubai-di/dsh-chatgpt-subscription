# Changelog

此文件记录可交付行为变化；版本遵循语义化版本。离线验收不代表安装、运行生效或真实服务验收。

## [0.1.8] - 2026-11-02

### Fixed

- 当前工具项的证据共享 call_id 或原生 item id 时，任何显式矛盾均在释放可执行块之前拒绝；同一 item 改写 call_id 不再绕过命名空间/类型检查。保留缺失 terminal 的 item-done 回退和既有 JSON 终止字段省略修复。

### Changed

- 2026-11-02 首次公开分发 0.1.8，整理中英文 README 与公开交付说明；合成测试夹具统一使用明确的测试标识。
- CLI `--version` 显示同步为 `0.1.8`；模型、OAuth、请求和其他产品逻辑保持不变。
- 两入口新增 added/terminal 与本地/remote 身份冲突回归；精确归档扩大到 82 个场景，原始流同时经过包内与实际宿主持久化边界。
- 补丁版本及投影标识同步为 `subscription@0.1.8`；依赖、缓存键算法、OAuth、模型和 credits 设置不变。离线验收不代表真实服务保证。

## [0.1.7] - 2026-10-30

### Fixed

- 无 replay 的终止事件省略该属性，并剥离失败／取消事件的旧 replay，避免包装器主动生成不可无损持久化的 `undefined`。
- 当前可执行工具块在原始身份与本次本地声明验证前不释放，禁止把远端命名空间的同名调用调到本地工具；保留既有远端及 custom 历史回放。

### Changed

- 源码与精确归档验收直接检查原始 chunk 的 accumulator、展开及组装，不依赖会静默丢字段的 JSON 清洗；归档可额外验证指定实际宿主。
- 补齐两入口终止、错误／取消、迭代清理、重放及合成指令、技能结果和历史内容传输回归；内容送达与真实模型遵循分别说明。
- 归档检查规范化临时目录真实路径，避免 macOS 临时目录别名造成依赖越界误报。
- 请求投影标识同步为 `subscription@0.1.7`；不改 prompt cache key 算法，不承诺跨版本零冷读。

## [0.1.6] - 2026-10-29

### Fixed

- 标准 HTTP 400 / SSE `context_length_exceeded` 保留为 DSH `CONTEXT_WINDOW_EXCEEDED`，保留可信 partial/usage，不增加提供商重试。
- 摘要最终禁工具策略不可被晚期 hook 覆盖；异常 function/custom/hosted 返回不暴露可执行本地事件，不生成成功摘要或 replay。
- 异常工具帧之后已有的 overflow/quota/其他净化失败不被摘要 guard 改写；取消仍优先。
- 没有完整可信 report 时，不向宿主发送把未知伪装为精确零的 usage；SDK 内部数字 sentinel 不变，明确有效的零及既有 cache 读写映射仍保留。
- 工具声明按 namespace/name/kind 归一化，兼容组稳定合并，冲突及未确认的强制 selector 在 HTTP 前安全拒绝。
- 工具身份随真实响应、JSON 持久化、当前可见内容降级和重新 apply 保留；不能可靠恢复的历史不猜 namespace 或 function/custom 类型。

### Changed

- 请求投影标识同步为 `subscription@0.1.6/native-replay-v2;tool-identity=v1;pi-replay-body-state=v1`。native-replay-v2 是回放算法修订，不升级既有 envelope schema，也不承诺跨版本零冷读。
- 分发归档包含[命名空间合同](<docs/namespace-contract.md>)、[工具身份合同](<docs/durable-tool-identity.md>)、[合法 BC JSON 夹具](<test/fixtures/bc-namespace-contract.json>)及统一[交付边界](<docs/candidate-delivery.md>)；不捆绑或修改 BC。
- [归档 smoke](<scripts/smoke-package.mjs>)从解包后的公共根入口 apply，使用包内依赖，以两条真实 LLM 入口覆盖组合行为；只在测试期串行安装并恢复公开 SDK hook spy。

## [0.1.5]

### Added

- 提供最终摘要禁工具、不可变账号绑定和 `optchat/request-policy` v1 producer facts。
