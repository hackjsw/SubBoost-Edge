<!-- markdownlint-disable MD033 MD041 -->
<div align="center">
  <p><img src="edge/public/edgesub-mark.svg" alt="EdgeSub" width="96"></p>
  <h1>EdgeSub</h1>
  <p>基于 SubBoost 的 Cloudflare Workers 边缘部署版</p>
  <p>
    <a href="https://github.com/hackjsw/SubBoost-Edge"><img src="https://img.shields.io/badge/source-EdgeSub-087f70.svg" alt="Source repository"></a>
    <a href="https://github.com/SubBoost/subboost"><img src="https://img.shields.io/badge/upstream-SubBoost-blue.svg" alt="Upstream project"></a>
    <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020.svg" alt="Cloudflare Workers">
    <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green.svg" alt="AGPL-3.0-only">
  </p>
  <p>
    <a href="https://sub.cces.us.ci/">当前部署</a> ·
    <a href="https://github.com/SubBoost/subboost">上游源码</a> ·
    <a href="https://docs.subboost.org">上游文档</a>
  </p>
</div>
<!-- markdownlint-enable MD033 MD041 -->

## 项目来源与致谢

EdgeSub 是基于 [SubBoost](https://github.com/SubBoost/subboost) **v2.6.0** 开发的非官方修改版本，不是 SubBoost 上游团队发布的官方版本。仓库保留了上游 Git 历史，以便清楚追溯代码来源和后续同步。

特别感谢原项目作者及主要维护者 [RyanVan（@Ryson-32）](https://github.com/Ryson-32)，感谢 [SubBoost 团队](https://github.com/SubBoost) 和所有 [项目贡献者](https://github.com/SubBoost/subboost/graphs/contributors) 持续完善订阅转换、节点解析、规则管理和可视化界面。没有他们的工作，就不会有这个 Edge 版本。

同时感谢以下开源项目及社区提供的基础能力、规则数据与反馈：

- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)：远端规则目录与规则集数据。
- [ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)：Clash 转换规则配置。
- [Cloudflare Workers](https://workers.cloudflare.com/)：边缘运行时、KV、Cron Triggers 和静态资源托管。
- LINUX DO、IDC Flare 及 SubBoost 社区的参与者和使用者。

本仓库在 **2026-07-21** 基于上游 v2.6.0 增加了 Cloudflare Workers 部署、登录保护、KV 订阅管理、定时更新和远端规则目录同步等功能。原项目及既有代码的版权归原作者和贡献者所有，本仓库的修改内容继续遵循 `AGPL-3.0-only`。

### EdgeSub 2.6.0-edge.5（2026-10-01）

本版本修复了编辑订阅时可能覆盖或丢失数据的问题，并让自动更新的时间和失败状态在界面上可见。

- 使用 ACL4SSR 模板的订阅不再在每次被客户端拉取时写入 KV。交给转换服务的临时链接改为加密的自包含链接（5～10 分钟有效），不包含订阅 token，同一版本在同一时间窗口内链接不变，可命中转换服务缓存；订阅内容变化后旧链接立即失效。同时避免了新写入的 KV 在其他机房尚不可见导致的偶发 502。
- 修复在“我的订阅”中点“新建订阅”时，首页仍处于上一条订阅的编辑状态，保存后会覆盖那条订阅的问题。
- 编辑订阅时登录过期，重新登录后会继续更新原订阅，不会另外新建一条；从“我的订阅”打开编辑时如果登录已过期，登录后会回到该订阅的编辑页。
- “我的订阅”在登录过期时显示登录提示，刷新、删除、保存设置遇到登录过期时提供“去登录”按钮；列表加载失败时显示错误和重试按钮，不再误显示“暂无订阅”。
- 修复 6 小时 Cron 下自动更新被推迟一整个周期的问题（例如 24 小时间隔实际变成 30 小时）。现在按所选间隔对齐到最近一次 Cron 执行。
- 自动更新最小间隔调整为 6 小时、以 6 小时为步长，界面说明同步改为“每 6 小时批量执行”；订阅响应中建议客户端的更新间隔不低于 6 小时。已有的更短间隔订阅仍可正常使用，实际按 6 小时执行。
- “我的订阅”显示下次自动更新时间；定时更新失败时显示失败时间和原因，并说明仍在提供上一次成功的配置。
- 页头显示当前访问的域名，不再写死 `sub.cces.us.ci`。

升级说明：需要重新部署 Worker；无需迁移数据。升级后，部署前生成的 ACL4SSR 临时链接会失效，不影响客户端，客户端下次拉取时会自动生成新链接。

### EdgeSub 2.6.0-edge.4（2026-10-01）

本版本主要降低 KV 写入量，避免订阅数量增加后很快用完 Cloudflare 免费版每天 1,000 次 KV 写入额度。

- 订阅自动更新 Cron 从每 15 分钟调整为每 6 小时（`0 */6 * * *`，UTC）。自动更新间隔小于 6 小时的订阅，实际按 6 小时执行；失败重试也会在下一次 Cron 时进行。
- 修复启用 Durable Object（`SUB_STORE`）后，Cron 每次运行都会把未到期订阅重写一遍的问题。以前每个已保存订阅每天固定产生约 96 次 KV 写入，现在只在 KV metadata 缺失或过期时补写一次。
- `SubscriptionStore` 收到内容和 metadata 都未变化的写入时直接返回，不再同步写入 KV。
- 旧版短链接（`/sub?id=...`）的 7 天滚动有效期改为每天最多续期一次。以前每次访问都会写一次 KV，现在同一条短链接每天最多写 1 次；升级前创建的短链接首次访问时会补记续期时间。
- 更新 Edge Worker 版本标识，新增 Cron 写入、Durable Object 去重和短链接续期的回归测试。

升级说明：需要重新部署 Worker，新的 Cron 配置才会生效；无需迁移数据，已有订阅和短链接可继续使用。

### EdgeSub 2.6.0-edge.3（2026-09-07）

- 优化 Cloudflare 节点连通性测试：显示测试进度、总耗时，并区分地址无效、连接超时和不可达。
- 保留 ACL4SSR 在线模板的远程更新机制：保存后的订阅请求会继续使用 ACL4SSR 上游配置，转换结果缓存约 5 分钟；Cron 不会复制模板文件到 KV。
- 更新 Edge Worker 版本标识，并补充相关回归测试与构建验证。

## 项目简介

EdgeSub 将 SubBoost 的配置生成器和订阅管理能力部署到一个 Cloudflare Worker 中。Next.js 前端会静态导出并由 Workers Static Assets 提供，API、登录、KV 数据和定时任务则在同一个 Worker 内运行，因此不需要额外维护服务器或数据库。

它不会提供代理节点或代理服务，只负责解析、转换、保存和更新用户自行提供的订阅内容。

## Edge 版本功能

- 保留 SubBoost 的 Clash/Mihomo 配置生成、节点导入、链式代理和智能分流能力。
- 转换后可下载 Clash YAML 或 v2rayN Base64 节点订阅；原有订阅链接不变，新增格式通过 `?format=v2rayn` 使用。
- 快捷模式在“完整版”下提供 ACL4SSR 模板入口，可选择 7 个官方远程配置。
- 支持 `/sub`、`/clash`、`/shorten` 和 `/test` 等原 Worker 接口。
- 使用 Worker Secret 密码登录，并通过签名的 HttpOnly Cookie 保护管理接口。
- 使用 `SUB_KV` 持久保存订阅、生成结果、自动更新设置和规则索引。
- 提供 `/dashboard` 管理已保存的订阅，可编辑、刷新、下载和删除记录。
- 每 6 小时扫描自动更新任务，未到期的记录不会重复写入 KV。
- 每天同步一次 MetaCubeX 规则目录，搜索结果缓存到 KV 24 小时。
- Dashboard 显示规则来源、数量和同步时间，并支持管理员立即同步。
- GitHub API 受限时自动降级到官方目录页面，再失败时使用内置规则目录。
- 构建时生成对应源码归档，并通过 `/subboost-edge-source.tar.gz` 向网络用户提供。

## 订阅输出格式

生成配置后，首页可分别下载 Clash 和 v2rayN 文件；保存订阅后的弹窗提供两种链接，仪表盘也可选择复制或下载的格式。

| 格式 | Edge 链接示例 | 内容 |
| --- | --- | --- |
| Clash / Mihomo | `/config/原token` | 原有 YAML 和已选择的 Clash 规则方案，行为不变 |
| v2rayN | `/config/原token?format=v2rayn` | 最近保存/刷新成功的节点，UTF-8 Base64 编码 |

已有查询参数时追加 `&format=v2rayn`。无需重建订阅、修改 token 或重新导入旧 Clash 链接；客户端 User-Agent 不会改变默认格式。Edge 原有 `/sub`、`/clash` 和 `/shorten` 的读取链接继续可用。双格式入口仅在 Cloudflare 部署中启用。

v2rayN 导出支持 SS、VMess、VLESS、Trojan、Hysteria2、TUIC v5、AnyTLS 的常用参数，以及可表达的 TCP、WebSocket、HTTPUpgrade、gRPC 和 XHTTP 传输。它不携带 Clash 分流、DNS、代理组、监听端口或远程节点提供者；依赖 `dialer-proxy`、不支持的协议/插件/传输参数会跳过，下载时显示跳过数量。没有可导出节点时返回 HTTP 422，不会返回成功的空订阅。高级客户端参数不保证逐项等价，完整配置请继续使用 Clash / Mihomo。

v2rayN 输出由浏览器或 Worker 内置代码生成，不调用外部 subconverter；Edge 缓存区分格式，编辑、刷新和删除会使两种格式同时失效。订阅写入由 Durable Object 按 token 串行处理，KV 继续作为兼容镜像。

业务逻辑审查、修复与验证结果见 [审查报告](docs/business-logic-review-2026-09-20.md)。

## 目录结构

| 目录 | 用途 |
| --- | --- |
| `edge/app` | Edge 版本的 Next.js 页面，包括首页、登录页和订阅管理页 |
| `edge/worker` | Worker 路由、登录、KV、订阅转换、规则 API 和 Cron 逻辑 |
| `edge/src` | Edge 页面使用的布局组件 |
| `packages/core` | 上游协议解析、配置生成和规则模型 |
| `packages/server-core` | 上游服务端订阅处理与规则目录能力 |
| `packages/ui` | 上游 SubBoost 配置器和通用界面 |
| `local` | 上游本地部署版本 |

## 部署

### 1. 环境要求

- Node.js `22.13+` 或 `24+`
- Cloudflare 账号和 Wrangler 登录状态
- 一个用于绑定 `SUB_KV` 的 KV Namespace

安装依赖：

```bash
npm ci
```

### 2. 配置 Worker 和 KV

创建 KV Namespace：

```bash
npx wrangler kv namespace create SUB_KV --config edge/wrangler.jsonc
```

将命令返回的 Namespace ID 写入 [`edge/wrangler.jsonc`](./edge/wrangler.jsonc)，并将其中的 Worker `name` 改成自己的名称。不要直接复用仓库里的生产 KV 数据或账号配置。

当前配置包含两个 Cron Trigger：

| Cron | 作用 |
| --- | --- |
| `0 */6 * * *` | 每 6 小时检查一次需要更新的订阅，自动更新间隔小于 6 小时的订阅实际按 6 小时执行 |
| `17 3 * * *` | 每天同步一次远端规则目录，Cloudflare Cron 使用 UTC |

### 3. 配置 Secret

登录密码和会话签名密钥必须保存在 Cloudflare Worker Secret 中，不要写进源码或 `.dev.vars.example`：

```bash
npx wrangler secret put EDGE_ADMIN_PASSWORD --config edge/wrangler.jsonc
npx wrangler secret put EDGE_SESSION_SECRET --config edge/wrangler.jsonc
```

如果规则搜索较频繁，可以配置只读 GitHub Token，提高 GitHub API 限额：

```bash
npx wrangler secret put GITHUB_TOKEN --config edge/wrangler.jsonc
```

### 4. 检查并部署

```bash
npm run edge:typecheck
npm run edge:build
npm run edge:deploy
```

如需绑定自定义域名，请在 Cloudflare Dashboard 的 Worker Routes 或 Custom Domains 中完成。Secret 和 KV 数据不会包含在 Git 仓库或构建生成的源码归档中。

## 常用接口

| 路径 | 说明 |
| --- | --- |
| `/` | EdgeSub 配置生成器 |
| `/login` | 管理员登录 |
| `/dashboard` | KV 订阅记录管理 |
| `/api/subscriptions` | 已保存订阅的管理接口 |
| `/api/rules/search` | 远端规则目录搜索接口，需要登录 |
| `/api/rules/cn-candidates` | 中国规则候选接口，需要登录 |
| `/api/rules/status` | 规则目录缓存与下次同步状态，需要登录 |
| `/api/rules/refresh` | 立即同步远端规则目录，仅接受登录后的 POST 请求 |
| `/sub` | 通用 Base64 订阅输出 |
| `/clash` | Clash YAML 转换输出 |
| `/config/:token` | 已保存订阅的固定访问地址 |

## ACL4SSR 官模与更新机制

Edge 部署在首页快捷模式的“完整版”下方提供 **ACL4SSR 模板**入口，可选择以下 7 个 ACL4SSR 官方远程配置：

- 标准版
- 精简版
- 完整版
- AI 版
- 多地区版
- 无测速版
- 无拦截版

所选方案会随订阅记录保存到 KV。访问订阅链接、缓存未命中时，Worker 将对应的 ACL4SSR `master` 配置地址交给 subconverter；Cron 更新订阅源，不会单独下载或复制模板文件到 KV。模板新鲜度还受转换服务自身缓存影响，不保证 5 分钟内与上游一致。

Worker 支持一个主后端和两个备用后端，通过 `edge/wrangler.jsonc` 的 `SUBCONVERTER_BACKEND` 和 `SUBCONVERTER_FALLBACK_BACKENDS`（逗号分隔）配置。当前使用 `api.dler.io`、`pub-api-1.bianyuan.xyz` 和 `api.wcc.best`，来自 [ACL4SSR 在线工具](https://acl4ssr-sub.github.io/) 的公开后端列表。超时、非 200 响应、无效 YAML 或空节点配置会自动切换，每个后端最多等待 8 秒。同一 Worker 实例会暂时跳过失败后端 60 秒；全部失败时返回明确错误，不会静默切换模板。

保存后的 ACL 订阅仅将节点名称和占位节点通过 5 分钟临时链接交给转换服务生成代理组，真实节点地址、凭据及 VLESS/XHTTP/ECH 字段由 Worker 填回，避免旧转换器丢弃节点。旧 `/clash` 接口仍按原有方式转交其输入源。公共后端仍可能限流或停服，可替换为自己的服务地址。

首页本地 YAML 预览仍使用 EdgeSub 内置模板。ACL4SSR 官模应用于保存后的订阅输出，也可以在“生成订阅链接”弹窗中再次确认或切换。

## 本地开发与检查

```bash
npm run edge:dev
npm run lint
npm run test:unit
npm run edge:typecheck
```

本地 Secret 可以参考 [`edge/.dev.vars.example`](./edge/.dev.vars.example)，实际的 `edge/.dev.vars` 已被 Git 忽略。

## 同步上游

克隆本仓库后，可以单独添加 SubBoost 官方仓库作为 `upstream`：

```bash
git remote add upstream https://github.com/SubBoost/subboost.git
git fetch upstream
```

合并上游更新前，请先检查 Edge 目录、共享包和依赖锁文件之间的差异，并重新执行测试和构建。

## 开源许可

EdgeSub 及其上游代码按照 [GNU Affero General Public License v3.0 only](./LICENSE) 发布。

如果修改本项目并通过网络向用户提供服务，AGPL-3.0 要求向这些用户提供部署版本对应的完整源码。本项目在页面导航中提供源码入口，并在构建时生成当前版本的源码归档。

请保留项目来源、原作者版权、许可证文件和修改说明，不要将此修改版描述为 SubBoost 官方版本。

## 免责声明

本项目不提供代理服务、节点或订阅内容，也不保证第三方订阅和规则源的可用性、合法性或安全性。使用者应自行确认所在地区的法律要求，并对导入的数据、部署配置和使用行为负责。
