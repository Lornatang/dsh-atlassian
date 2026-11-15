---
description: "在 dsh profile 中接入 Atlassian Cloud OAuth 与自建 Jira、Confluence REST：注册工具、Atlassian 设置区与 Jira 看板面板。"
kind: "package-bundle"
---

# @lornatang/dsh-atlassian

[English](README.md) | 中文

## 概要

`dsh-atlassian` 将 dsh profile 连接到 Atlassian Cloud，或连接到一对自建 Jira、Confluence 服务。Cloud 模式与 Atlassian 远程 MCP 服务器保持 OAuth 2.1 会话，并把它向 agent 会话公布的每个工具注册进来；server 模式注册一组固定的 REST 工具。它会在 Web 客户端中加入 Atlassian 设置区与 Jira 看板面板。安装或移除使用 `dsh plugin --profile <name> add|remove @lornatang/dsh-atlassian`。边界：每行一个连接，凭据以未加密形式存放在 profile 数据目录下，OAuth 回调走回环地址。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本层负责 profile 中属于 Atlassian 的那一半：Cloud 的 OAuth 会话或自建服务的 REST 客户端、其背后的凭据、它们注册的工具，以及驱动这些能力的设置区与看板。工具注册表、Web 服务器与客户端 slot 系统仍由 dsh 宿主提供，本包只是注册进去。

### 安装到 profile

```text
dsh plugin --profile <name> add @lornatang/dsh-atlassian
dsh plugin --profile <name> remove @lornatang/dsh-atlassian
```

安装仅发布到 GitHub 的 0.1.8 版本，请运行 `dsh plugin --profile <name> add https://github.com/Lornatang/dsh-atlassian/releases/download/v0.1.8/lornatang-dsh-atlassian-0.1.8.tgz`。npm 仓库中的版本可能较旧。

`add` 会把本层组合进 profile：profile 的 `cordis.patch.yml` 会增加一条 insert 记录，行 id 为 `atlassian`，包名为 `@lornatang/dsh-atlassian`，并带上随包提供的补丁中的五个值——`mode: cloud`、`serverName: atlassian`、`url: https://mcp.atlassian.com/v1/mcp`、`redirectPort: 3334` 与 `autoOpenBrowser: true`。包的 manifest 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，reconcile 步骤读取的正是这条声明；`remove` 会再次删除该记录。两条命令执行后都要重启 DSH，因为 profile 只在启动时组合自己的行与客户端部分，随后打开 Settings → Atlassian。0.1.5 之前的版本以 `@lornatang/dsh-atlassian-bridge` 发布；添加带作用域的新名称、从同一 profile 删除旧包、重启一次即可——行、其设置与已保存的凭据都会保留。

Cloud 模式在插件加载后立即开始连接。没有已保存会话时，MCP 客户端会返回授权错误，回调服务器绑定 `127.0.0.1:3334`，设置区显示 `Authorization required` 并给出授权链接；等待时间由 `authorizationTimeoutMs` 限制（默认 300000 毫秒）。在浏览器中批准后完成交换，工具完成注册，状态变为 `Connected`。若等待超时，状态变为 `Connection failed` 并带有 `authorization timed out`，此时点击 Connect 会重新尝试，并在 `autoOpenBrowser` 为 true 时打开浏览器。回调端口被占用时会回退到空闲端口，这会清除已保存的客户端注册、令牌与 PKCE verifier，因此下次启动需要重新授权。

自建模式只在存储中已有凭据时才主动连接；否则设置区显示已配置的服务 URL 与每个服务一张凭据表单，状态保持 `Not connected`。Connect 会把用户名和密码或令牌交给插件，插件用 Jira 的 `GET /rest/api/2/myself` 与 Confluence 的 `GET /rest/api/user/current` 校验，将凭据写入 profile 存储并注册 REST 工具。使用个人访问令牌时把用户名留空：请求改用 `Bearer <token>` 而不是 Basic 认证。

### 你将获得

Cloud 模式下工具面来自远程服务器的目录：MCP `tools/list` 返回的每个工具都以 `mcp__<serverName>__<name>` 注册，因此在默认 `serverName` 下名称形如 `mcp__atlassian__getJiraIssue`、`mcp__atlassian__searchJiraIssuesUsingJql`；该清单由本包之外的 Atlassian MCP 服务器定义。`publicToolName` 会把 `[A-Za-z0-9_-]` 之外的字符替换为 `_`；名称发生变化或超过 64 个字符时，会截到 51 个字符并追加 `_` 与原始名称 SHA-256 哈希的十二个十六进制字符。本层负责注册、`toolCallTimeoutMs` 时限与渲染：文本块会被拼接，其余内容块渲染为 `[<type> content]`。

自建模式下 `src/server-bridge.ts` 以同样的 `mcp__atlassian__<name>` 约定注册十四个固定操作：`getAccessibleAtlassianResources`、`searchJiraIssuesUsingJql`、`getJiraIssue`、`getVisibleJiraProjects`、`getTransitionsForJiraIssue`、`transitionJiraIssue`、`createJiraIssue`、`editJiraIssue`、`addCommentToJiraIssue`、`searchConfluenceUsingCql`、`getConfluencePage`、`getConfluenceSpaces`、`createConfluencePage` 与 `updateConfluencePage`。

客户端部分增加三行，均由本包实现并渲染，挂载到宿主提供的 slot 中（`dsh.client.inject` 指定 `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-settings`）：

- `settings.section`，id `atlassian`，order 30，label `Atlassian`——连接状态、工具数量、服务 URL、凭据表单、Connect 与 Disconnect。
- `sidebar.panellist`，id `jira-board`，order 40，label `Jira`——打开看板的侧边栏图标。
- `main`，key `jira-board`——看板本身：搜索、项目过滤、JQL 表单、按 issue 状态分列、带流转按钮的 issue 详情，以及 Send to current session / Send to new session / Copy prompt。

这些行背后的路由位于固定前缀 `/plugins/atlassian`（`status`、`configure`、`connect`、`disconnect`、`debug-tools`、`board`、`projects`、`transition`、`issue/<key>`、`issue/<key>/transitions`）。只有在 DSH `connection` 服务存在且其请求栅栏放行时它们才响应；没有该服务时路由返回 503。

### 配置

profile 补丁中有一条 `atlassian` 记录。随包提供的层以 Cloud 默认值插入该记录，因此 profile 只需写出要改的值：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: atlassian
  config:
    expectedSite: example.atlassian.net
    board:
      jql: 'project = DEMO ORDER BY updated DESC'
      limit: 25
      promptTemplate: 'Work on Jira issue {{key}}: {{summary}}'
```

`Config` 是定义在 `src/config.ts`、由 `src/index.ts` 导出的 schemastery schema，因此下表中的默认值与范围是 schema 约束；`serverName` 的字符模式在构造凭据文件名时校验。全部可用字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `cloud` | `cloud` 连接 Atlassian 远程 MCP 服务器；`server` 使用自建 REST 桥接。在 Settings 中保存服务 URL 会推导该值。 |
| `serverName` | `atlassian` | 工具名前缀（`mcp__<serverName>__…`）与凭据文件名中的身份标识；`[A-Za-z0-9_-]`，1–64 个字符。 |
| `url` | `https://mcp.atlassian.com/v1/mcp` | Cloud MCP 端点。除回环 HTTP 外必须使用 HTTPS。 |
| `redirectPort` | `3334` | 回环 OAuth 回调端口，0–65535；`0` 表示绑定空闲端口。 |
| `toolCallTimeoutMs` | `60000` | 单次工具调用的时限，最小 1。 |
| `expectedSite` | 空 | 设置后，若授权的站点主机与之不符，设置区给出警告。 |
| `authorizationTimeoutMs` | `300000` | 等待 OAuth 回调的时长，最小 1000。 |
| `autoOpenBrowser` | `true` | 需要授权时在浏览器中打开授权页面。 |
| `server.jiraUrl` | 空 | 自建 Jira 基础 URL；为空表示不启用 Jira。 |
| `server.confluenceUrl` | 空 | 自建 Confluence 基础 URL；为空表示不启用 Confluence。 |
| `server.jiraCaFile` | 空 | 可选的 PEM 信任文件，追加到 Jira 使用的 Node.js 根证书中。 |
| `server.confluenceCaFile` | 空 | 可选的 PEM 信任文件，追加到 Confluence 使用的 Node.js 根证书中。 |
| `server.allowInsecureHttp` | `false` | 允许明文 `http:` 服务 URL；凭据会以明文传输。 |
| `board.jql` | 空 | 初始 JQL；为空时使用 `updated >= -180d ORDER BY updated DESC`。 |
| `board.limit` | `50` | 每次加载看板的 issue 数量，1–100。 |
| `board.timeoutMs` | `90000` | 单次看板请求的时限，最小 1000。 |
| `board.promptTemplate` | 空 | 交接文本，其中 `{{key}}` 与 `{{summary}}` 会被替换；为空时使用内置提示。 |

在 Settings 中保存服务 URL 时会经过同样的校验：值必须是不含凭据、query 或 fragment 的 HTTP(S) 基础 URL，末尾斜杠会被去掉，只要任一 URL 非空，该行的 `mode` 就变为 `server`——两者都清空则回到 `cloud` 并恢复官方端点。凭据从不来自补丁；自建服务的用户名与密钥在 Settings 中输入并由 profile 存储保管。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

本层只有一条补丁记录：一个插入 `atlassian` 的 `insert`，并带上 Cloud 默认值。补丁没有平台门控；客户端部分在 `package.json` 中声明（`dsh.client.platform: web`，并注入两个 slot 包），因此无界面 profile 只加载宿主部分，设置区与看板行只出现在 Web profile 中。

`apply` 按 `mode` 选择桥接——Cloud 用 `AtlassianBridge`，自建用 `ServerBridge`——推导凭据身份（Cloud 为配置的 URL，自建为 `server:<jiraUrl>` 与 `<confluenceUrl>` 用 NUL 连接），用 `sessionFileFor(serverName, identity, patchPath)` 构造 `SessionStore`，创建看板，并把路由注册到 `webServer` 或 `httpServer`。所有路由都在 `connection` 服务的请求栅栏之后；若该服务在插件之后出现，`internal/service` 监听器会重新绑定路由。`void bridge.start()` 在后台运行并记录失败。

Cloud 路径通过 MCP SDK 使用带 PKCE 的 OAuth 2.1：`127.0.0.1:<redirectPort>` 上的回调服务器接收 `/callback`，`createCloudFetch` 拒绝所有非 HTTPS 端点（回环 HTTP 除外），并把响应体与 SSE 事件限制在 10 MiB；`connect` 之后桥接会分页读取 `tools/list`（最多 100 页、1000 个工具）并注册每个定义。站点标签来自 `getAccessibleAtlassianResources`。

自建路径通过 `node:https` 与一两个显式 REST 端点通信：有用户名时使用 Basic 认证，只存了密钥时使用 `Bearer`，可选追加 CA，同时保留主机名与 TLS 校验。响应上限 10 MiB，不跟随重定向、不回显服务器错误体，Jira 与 Confluence 的操作固定在 `src/server-bridge.ts` 中——没有发现、资源或提示词桥接。

客户端部分注册进 `settings.section`、`sidebar.panellist` 与 `main`，每五秒轮询 `GET /status`，并且只通过 `/plugins/atlassian` 与宿主通信。交接复用客户端的 `sessions` 服务：选中的 issue 经 `promptFor` 渲染（有 `{{key}}` 与 `{{summary}}` 的模板，或内置提示），再排入当前会话或新连接的工作区。

| 源文件 | 内容 |
| --- | --- |
| `cordis.patch.yml` | 本层本身：一条 insert 记录，行 id `atlassian`，Cloud 默认值。 |
| `src/index.ts` | `apply`：选择桥接、凭据身份、工具宿主、路由注册、后台启动。 |
| `src/config.ts` | `Config` schema、默认值与 `configureEndpoints` 的 URL 校验和模式推导。 |
| `src/bridge.ts` | Cloud MCP 客户端、OAuth 重试、工具命名、注册、调用与断开。 |
| `src/server-bridge.ts` | 自建桥接：凭据校验、十四个 REST 操作及其工具定义。 |
| `src/server-http.ts` | 单个 Jira 或 Confluence 端点：Basic/Bearer 头、附加 CA、超时、字节上限。 |
| `src/oauth.ts` | PKCE provider、回环回调服务器、仅 HTTPS 的 fetch 包装、响应大小限制。 |
| `src/store.ts` | profile 范围的凭据文件：命名、属主与符号链接检查、原子 `0600` 写入。 |
| `src/board.ts` | `JiraBoard`：JQL 搜索、站点解析、issue 详情、流转、项目。 |
| `src/routes.ts` | DSH 请求栅栏之后的 `/plugins/atlassian` 处理器。 |
| `src/open-url.ts` | 授权页面的浏览器启动，仅 HTTPS 或回环 HTTP。 |
| `src/client/index.tsx` | 设置区、侧边栏入口与看板面板；调用上面的路由。 |
| `tests/*.test.mjs` | 桥接、配置、安全、服务端与浏览器测试套件。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CHANGELOG.md](CHANGELOG.md)——发布历史，包括 0.1.5 的改名与 0.1.6 的 DSH 版本范围。
- [LICENSE](LICENSE)——Apache-2.0。
- [NOTICE](NOTICE)——随包分发的归属声明。
- [DeepSeek Harness 配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)——本行 `config` 块遵循的部署参考。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过工具注册表：连接建立后，本层注册每个 Atlassian 工具定义，因此工具的名称、描述与输入 schema 作为请求工具列表的一部分到达模型。

#### KV 缓存影响

工具列表是请求缓存前缀的一部分，因此激活会改变它：未连接的 profile 不发送 Atlassian 工具，已连接则发送所有已注册定义。Cloud 模式下这些定义来自远程 `tools/list` 响应，因此 Atlassian 一侧的目录变化会在下次连接时改变前缀；自建模式的定义固定。设置区与看板通过 HTTP 路由工作，不向请求添加任何内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

以下约束说明本层没有桥接什么，以及 profile 需要在哪些地方绕行。

- **每行一个连接**——一个桥接实例加上固定的 `/plugins/atlassian` 路由前缀，意味着本层假定每个 profile 只有一个 Cloud 站点或一对自建 Jira/Confluence 服务；第二个站点需要单独的 profile。看板还会绑定第一个可访问资源，并在进程生命周期内缓存它。
- **自建模式是固定子集**——它提供上面十四个 REST 操作而不是 Cloud 的 MCP 目录，Confluence 页面是 storage 格式 XHTML，更新必须带上当前页面版本，本层会在写入前立即读取该版本。
- **凭据以未加密形式存储**——每个 profile 与连接一个 JSON 文件，位于 `profiles/<name>/data/` 下，POSIX 上权限为 `0600` 并做符号链接与属主检查；Windows 上只依赖 profile 目录的 ACL，备份该目录即泄露令牌。
- **OAuth 回调必须可达**——浏览器与 DSH 必须共享回环主机，另一台机器上的 DSH 需要把 `redirectPort` 转发过去。端口被占用时会回退到临时端口，这会清除已保存的客户端注册、令牌与 verifier，并强制重新授权。
- **Cloud 端点必须是 HTTPS**——`createCloudFetch` 拒绝任何非 HTTPS URL（包括重定向目标），只有回环 `http:` MCP URL 例外，因此远程主机上的明文端点会被拒绝。
- **非文本工具输出变成占位符**——文本之外的内容块渲染为 `[<type> content]`，MCP 资源与提示词没有桥接，因此附件或图片结果以占位字符串到达模型。
- **看板加载按需触发**——设置区每五秒轮询 `/status`，但看板每次加载只执行一次 JQL 搜索（连接、搜索、刷新或流转），最多返回 `board.limit` 个 issue（1–100），无限制查询会以 `updated >= -180d ORDER BY updated DESC` 重试一次。
- **Disconnect 只在本地生效**——它会删除已保存的凭据并注销工具，但不会在 Atlassian 侧撤销授权；请到 Atlassian 账户设置中撤销。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`npm run build` 清理 `lib/`，用 `tsc` 编译宿主与客户端两个树，再用 `scripts/bundle-client.mjs` 把 `src/client/index.tsx` 打包成 `lib/client.js`。`npm test` 先执行该构建，再执行 `node --test tests/*.test.mjs`，其中包含依赖 Chrome 的浏览器套件；`npm run typecheck` 执行两次 `tsc --noEmit`。`npm run test:dsh` 执行 `scripts/verify-dsh.mjs`：用 `npm pack` 打包插件，并驱动真实的 `dsh` 二进制（默认 `dsh`，可用 `DSH_TEST_BINARY` 覆盖）依次完成创建 profile、`plugin add`、带认证的 Web 路由请求、自建连接、看板加载与 `plugin remove`，最后执行浏览器检查。脚本读取的环境变量是 `DSH_TEST_BINARY`、`DSH_TEST_MODE=server`、`DSH_TEST_UPGRADE_FROM=legacy-fixture`、`DSH_TEST_LANGUAGE` 与 `CHROME_PATH`。

`lib/` 已提交，CI 会执行 `git diff --exit-code -- lib`，因此任何源码改动都要重新构建并一并提交 `lib/`。需要 Node.js 22.19 或更新版本（`engines.node`），peer 依赖是 `@deepseek-ai/cordis ~4.1.0`，可选的 `dsh-tools`/`dsh-llm` 开发依赖跟随 `0.2.2-rc.2` 的 DSH 版本线。存储文件为 `data/atlassian-bridge-<serverName>-<sha256(identity) 前 12 个十六进制字符>.json`，内容带 `version: 1`；修改身份计算或文件命名会让已保存的凭据失配。`tests/language.test.mjs` 会扫描 `README.md`、`CHANGELOG.md`、`NOTICE`、`src/` 与 `lib/` 中的 CJK 字符，因此英文写在 `README.md`，中文只能放在 `README.zh.md`。

</details>
