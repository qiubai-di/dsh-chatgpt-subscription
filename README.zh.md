# 在 DSH 中使用 ChatGPT 订阅

[English](<README.md>) | 简体中文

将你自己的 ChatGPT 订阅接入 DeepSeek Harness（DSH）的主模型层。DSH 继续管理会话、历史和本地工具执行；插件复用 DSH 的 PiAiAdapter 转换消息，通过 Sign in with ChatGPT（SIWC）的 OAuth 授权访问 Responses API，不启动第二个 Agent。

**0.2.0** 支持 **DSH 0.2.2-rc.1**。需要共享实例的 DSH 公共包改由宿主提供，工具隔离适配新版提示词和批量执行接口，登录锁超时会说明具体恢复方法。已有授权记录仍可读取。本项目是独立集成，不是经 OpenAI 认证或官方背书的产品。

## 实际功能

- 为 DSH 增加 `ChatGPT subscription` 提供商（`openai-chatgpt`）。可选模型取账号模型目录与锁定适配器能力目录的交集。不需要 API key，也不会回退到 API key 计费。
- 支持流式回复、本地 function/custom 工具、持久工具历史回放，以及模型目录声明支持的图片输入。图片复用 DSH 附件，以 data URL 发送，不使用 Files 上传 API。
- 在主模型同一条 Responses 请求中加入受控的原生 `web_search`，由模型按需搜索。此路由会过滤并阻止 DSH 的本地 `web_search`，但不替换全局搜索后端、不启动独立搜索 Agent，也不影响其他提供商。
- 主会话选中此提供商时，输入区显示 `Using ChatGPT plan` 和 `Manage usage` 链接，不显示账号身份或剩余额度。
- 强制摘要请求禁用工具，保留可信用量和明确的上下文溢出错误，并在本地执行前拒绝矛盾或不可信的工具身份。

图片生成、Files/File Search、Code Interpreter、MCP 等其他托管能力未启用。模型访问、原生搜索、服务端参数接受情况及服务可用性取决于账号、工作区和上游服务，离线测试不保证这些权益。

## 环境与版本边界

- **Node.js 24.9 或更新版本**。
- 支持的宿主为 **DSH `0.2.2-rc.1`**，配套 Cordis `4.1.0`、Schemastery `3.19.0`。共享宿主包声明为 peer dependencies，不再随插件打包；独立协议库仍锁定版本。0.2.0 不支持旧版 DSH。
- 安装器生成 POSIX shell 启动器；Windows 安装、命令 shim 和权限处理尚未验证。

## 从源码构建与安装

**请使用已构建的发行包或源码安装器。** 本文不提供已验证的一行式 GitHub 安装命令，也不据仓库存在推断 npm registry 可用。以下命令用于源码目录，不适用于解包后的运行时安装包。

在 0.2.0 源码目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`check` 执行类型检查、离线测试和构建，不登录账号或调用真实模型。使用宿主附件后端的图片测试默认跳过，需要显式启用；见[离线验收与交付限制](<docs/candidate-delivery.md>)。下载依赖可能需要联网。

安装或修改授权前，先关闭使用此提供商的 DSH 进程。确认所需版本的 DSH 可用后，安装专用配置和授权维护命令：

```sh
npm run install:local
```

[安装脚本](<scripts/install.mjs>)会构建并打包独立运行依赖，使用 DSH 原生插件管理器连接宿主公共包，通过 SHA-256 核对归档副本，创建专用数据目录和启动器。它不替换 DSH 可执行文件、不启动 DSH，也不登录。安装包时使用 `--ignore-scripts`，拒绝覆盖不属于本插件管理的已有目标。

将安装器报告的启动器目录加入 `PATH`，再创建你自己的授权：

```sh
dsh-chatgpt login
```

在浏览器中完成 OAuth 授权。命令通过本地回环回调接收结果，保存授权并读取账号支持的模型目录，不发送推理请求。

### 接入已有的 DSH Web 配置

原生 `web` profile（配置环境）须已存在。保持 DSH 停止，在源码目录执行：

```sh
npm run integrate:web
```

[接入脚本](<scripts/integrate-web.mjs>)会备份现有配置文件，安装 `install:local` 生成的归档，并设置本插件的 `credentialHome`。现有默认模型和其他提供商保持原值；授权由专用存储共享，不向原生配置复制令牌。此步骤不登录或发送模型请求。

随后启动 DSH，在会话模型选择器的 `ChatGPT subscription` 下选择模型：

```sh
dsh web
```

如果不接入原生 Web 配置，也可以用 `dsh-chatgpt run` 启动专用的 `chatgpt` 配置环境。

## 授权维护命令

| 命令 | 用途 |
| --- | --- |
| `dsh-chatgpt login` | 登录并刷新账号支持的模型目录。 |
| `dsh-chatgpt status` | 仅查看本地授权状态和模型缓存，不联网。输出可能含账号身份，分享前请脱敏。 |
| `dsh-chatgpt models` | 刷新账号模型目录，不发送推理请求。 |
| `dsh-chatgpt logout` | 撤销此应用的授权，成功后清除本地令牌。 |
| `dsh-chatgpt run` | 使用专用配置启动 DSH。 |
| `dsh-chatgpt help` | 查看命令说明。 |

CLI 接受 `--home` 指定专用数据目录。源码安装器接受 `--home`、`--bin-dir`、`--dsh`；Web 接入脚本接受 `--home`、`--dsh-home`、`--dsh`。自定义位置前请核对对应源码。模型目录刷新失败不会丢弃已保存的授权；撤销失败时保留令牌以便重试。登录、退出、重装或重新接入前，需要停止运行中的提供商。

### 登录锁超时

如果登录提示 `OPERATION_LOCK_TIMEOUT`，说明专用数据目录中的 `.operation-lock.lock` 一直未能取得。先停止 DSH 和其他登录命令，确认没有进程占用该锁；若它是意外退出遗留的空文件，再将该文件移到备份位置后重试。不要删除凭据目录或整个数据目录。空锁无法可靠识别持有者，插件不会仅按文件年龄自动删除它。

## 账号、隐私与订阅限制

OAuth 实现是通用代码。分发包不含真实账号、订阅授权、访问令牌或刷新令牌；每位用户的授权数据由本人登录后创建。插件不导入已有的 Pi 或 Codex 登录缓存。

授权通过 DSH 本地凭据服务保存在专用数据目录中。这是本地凭据文件，不是操作系统钥匙串加密存储。不要公开、分享或提交数据目录、凭据、授权链接或未经脱敏的状态输出。原生 Web 配置与维护 CLI 共享此存储及刷新锁。

请求消耗已有的 ChatGPT plan 限额；如果你在 ChatGPT 用量设置中允许使用 credits，也可能消耗 credits。插件不提供免费或无限订阅，不更改你的 credits 设置。API 价格估算为零，不代表余额或剩余额度。

提示、选取的历史和提供的内容会发送给 OpenAI。`store:false` 不代表零数据保留或企业级 Zero Data Retention（ZDR，零数据保留）。本集成及其离线检查不等于官方认证或完整法律合规评估。

## 技术合同与验收

- [0.2.0 离线验收、回放与缓存限制](<docs/candidate-delivery.md>)
- [工具命名空间合同](<docs/namespace-contract.md>)
- [持久工具身份回放合同](<docs/durable-tool-identity.md>)
- [用于 BC 互操作的合法命名空间夹具](<test/fixtures/bc-namespace-contract.json>)
- [变更记录](<CHANGELOG.md>)

0.1.8 修复了同一工具项的矛盾证据可能绕过身份校验的问题，在释放可执行工具块前拒绝冲突。回放、稳定请求前缀和离线持久化检查，不证明真实模型遵循、缓存命中、订阅节省或服务端上下文窗口。分发包不捆绑或修改 BC、OptChat。

## 许可证

[MIT](<LICENSE>)。
