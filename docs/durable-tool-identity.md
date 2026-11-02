# 工具身份回放合同（04）

本地离线候选的工具身份由命名空间（namespace）、名称和 function/custom 类型共同约束。声明和选择器继续遵守[命名空间合同](namespace-contract.md)，本票不扩展 SIWC selector 支持，不修改 Pi 或宿主的公开内容模型。

## 可信来源与持久化

- 成功响应的原始 function/custom call 提供类型、命名空间、call ID 和 item ID。完整原生回放仍使用现有、与全部可见内容及状态摘要匹配的原始 output；没有改成按裸名称寻找调用。
- Pi 原有 per-block metadata 保留。适配器在 ReplayEnvelope.blocks 的工具块中增加私有 toolIdentity v1，保存完整复合调用 ID、名称、命名空间和 function/custom 类型，不保存旧参数或结果。
- 每个身份记录单独带完整性摘要，避免无关正文编辑或块裁剪同时丢失身份。普通 Pi envelope 另以 subscriptionReplay v1 将原生 signatures 绑定到当前整轮可见内容及状态。摘要用于检测损坏，不是针对任意恶意历史写入者的认证签名。
- 兼容旧的、仍通过完整性检查的原生 envelope，可从其中原始 call 恢复身份。旧 Pi 工具 metadata 只有 namespace、没有可信类型时，不按 item ID 前缀或参数形状猜 function/custom。旧 Pi 纯文本可保留 text IDs，但没有整轮可见内容绑定的 opaque reasoning 不再恢复，以免文本编辑后带回隐藏旧上下文。
- 只有在原响应对应请求的实际平铺声明能唯一证明本地来源时，才可为缺失的 namespace 补 dsh。单独的命名组、歧义裸名称、回放时的当前声明都不能替代该证明。

## 正常回放与失效降级

两条 SubscriptionAdapter 入口均穿过真实 Pi 转换和最终请求投影。JSON 持久化后换一个适配器实例，非 dsh function、dsh function 和 custom 仍保留身份；同裸名称的不同命名空间不混淆。工具结果仅按 call ID 与当前可见调用关联，custom call/result 保持 custom 类型。

编辑、裁剪、损坏、缺失响应级 envelope 或跨模型时，完整原生回放可以失效，但独立身份记录仍可使用。降级只修复 Pi 转换丢失的身份及类型，参数、文本、图片和结果继续来自当前可见消息；不恢复旧正文、已删轮次、旧 reasoning signature 或隐藏工具参数。当前工具列表未声明旧工具，不单独否认有效的历史身份。

含工具历史且身份来源缺失、损坏或不唯一时，返回净化后的失败终态，HTTP 请求数为零。缺失整个身份 envelope、旧 Pi 类型不可确定、重复 call ID、裁剪调用后留下孤立结果，均不猜测或改道。原始 wire 历史 call 缺失可信 namespace 时也拒绝，不再无条件补 dsh。纯文本历史继续安全降级。

## 稳定性与验收边界

同一持久历史重复发送的 input 严格一致；普通追加不改旧 input 前缀；临时随机 replay markers 在最终 wire 完全移除；同会话 prompt_cache_key 保持原映射。这不证明服务端缓存命中或订阅节省。

[完整适配器回放测试](../test/adapter-native-search.test.ts)覆盖两入口的生命周期、普通 Pi/原生回放、编辑/裁剪/损坏/跨模型及零 HTTP 拒绝；[命名空间测试](../test/adapter-namespace.test.ts)覆盖最终投影不猜 dsh。原有图片、引用成功边界、可信用量、取消及账号绑定回归继续适用。

本票没有升版本、打包、安装、重启、修改 BC、使用真实账号或请求真实服务端。候选编号和统一交付说明由 05 处理。
