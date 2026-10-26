<!-- markdownlint-disable MD033 MD041 -->
<div align="center">
  <p><img src="edge/public/edgesub-mark.svg" alt="EdgeSub" width="96"></p>
  <h1>EdgeSub</h1>
  <p>基于 SubBoost 的 Cloudflare Workers 边缘部署版</p>
  <p>
    <a href="https://github.com/hackjsw/SubBoost-Edge"><img src="https://img.shields.io/badge/source-EdgeSub-087f70.svg" alt="源码仓库"></a>
    <a href="https://github.com/SubBoost/subboost"><img src="https://img.shields.io/badge/upstream-SubBoost%20v2.10.0-blue.svg" alt="上游项目"></a>
    <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020.svg" alt="Cloudflare Workers">
    <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green.svg" alt="AGPL-3.0-only">
  </p>
  <p><strong><a href="README.md">English</a> | <a href="README-CN.md">中文</a></strong></p>
  <p>
    <a href="https://sub.cces.us.ci/">当前部署</a> ·
    <a href="https://github.com/SubBoost/subboost">上游源码</a> ·
    <a href="https://docs.subboost.org">上游文档</a>
  </p>
</div>
<!-- markdownlint-enable MD033 MD041 -->

## 项目简介

EdgeSub 把 SubBoost 的 Clash/Mihomo 配置生成器和订阅管理放进一个 Cloudflare Worker。Next.js 前端静态导出后由 Workers Static Assets 提供，API、登录、订阅存储和定时更新都在同一个 Worker 内运行，不需要额外维护服务器或数据库。

EdgeSub 不提供代理节点或代理服务，只负责解析、转换、保存和更新用户自己提供的订阅内容。

## 项目来源与致谢

EdgeSub 是基于 [SubBoost](https://github.com/SubBoost/subboost) 开发的非官方修改版本，不是 SubBoost 上游团队发布的官方版本。仓库保留了上游 Git 历史，便于追溯代码来源和后续同步。

- **2026-07-21**：基于上游 v2.6.0 增加 Cloudflare Workers 部署、登录保护、订阅管理、定时更新和远端规则目录同步。
- **2026-10-07**：同步上游 v2.9.0 的解析、刷新和配置能力。
- **2026-10-26**：同步上游 v2.10.0 的协议参数和规则目标修复。

界面始终保持 EdgeSub 自己的设计。

特别感谢原项目作者及主要维护者 [RyanVan（@Ryson-32）](https://github.com/Ryson-32)，感谢 [SubBoost 团队](https://github.com/SubBoost) 和所有[项目贡献者](https://github.com/SubBoost/subboost/graphs/contributors)持续完善订阅转换、节点解析、规则管理和可视化界面。没有他们的工作，就不会有这个 Edge 版本。

同时感谢以下开源项目及社区：

- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)：远端规则目录与规则集数据。
- [ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)：Clash 转换规则配置。
- [Cloudflare Workers](https://workers.cloudflare.com/)：边缘运行时、KV、Durable Objects、Cron Triggers 和静态资源托管。
- LINUX DO、IDC Flare 及 SubBoost 社区的参与者和使用者。

原项目及既有代码的版权归原作者和贡献者所有，本仓库的修改内容继续遵循 `AGPL-3.0-only`。

## 功能

- **配置生成**：保留 SubBoost 的 Clash/Mihomo 配置生成、节点导入、链式代理和精确分流能力。
- **三步生成器**：按“订阅来源 → 规则方案 → 保存”三步完成。
  - **订阅来源**：粘贴后自动识别订阅链接、Clash YAML 或节点链接，也可以拖入 `.yaml` 文件。
  - **规则方案**：可选内置规则或 7 个 ACL4SSR 在线模板。打开“自定义”后，可以调整节点、中转代理组、分流代理组、规则和 DNS。
- **两种输出格式**：Clash / Mihomo YAML 和 v2rayN Base64 订阅，详见[订阅输出格式](#订阅输出格式)。
- **我的订阅**（`/dashboard`）：
  - 显示每条订阅的刷新状态、节点数、已用流量和到期时间；
  - 支持筛选、搜索、复制链接、二维码、编辑、刷新、下载和删除；
  - 更新失败时直接显示原因，并提供重试按钮。
- **定时更新**：每 6 小时检查一次到期的订阅，每个订阅在独立调用中刷新。更新失败时继续提供上次成功的配置，并在一小时后重试。
- **规则目录**：每天同步一次 MetaCubeX 规则目录，搜索结果缓存 24 小时。GitHub API 受限时依次降级到官方目录页面和内置目录。
- **登录保护**：使用 Worker Secret 密码登录，管理和转换接口通过签名的 HttpOnly Cookie 鉴权。订阅地址 `/config/:token` 本身就是访问凭证，客户端无需登录。
- **主题**：支持跟随系统、浅色、深色三种模式；强调色可选 8 个预设，也可以自定义。
- **兼容旧接口**：保留原 Worker 的 `/sub`、`/clash`、`/shorten` 和 `/test` 接口。
- **源码提供**：构建时生成对应源码归档，通过 `/subboost-edge-source.tar.gz` 向网络用户提供。

## 订阅输出格式

| 格式 | 链接示例 | 内容 |
| --- | --- | --- |
| Clash / Mihomo | `/config/<token>` | 完整 YAML，包含所选规则方案 |
| v2rayN | `/config/<token>?format=v2rayn` | 最近一次保存或刷新成功的节点，UTF-8 Base64 编码 |

- **格式选择**：已有查询参数时追加 `&format=v2rayn`，无需重建订阅或修改 token。默认格式不会根据客户端 User-Agent 改变。
- **v2rayN 导出范围**：
  - 协议支持 SS、VMess、VLESS、Trojan、Hysteria2、TUIC v5 和 AnyTLS 的常用参数；
  - 传输方式支持可表达的 TCP、WebSocket、HTTPUpgrade、gRPC 和 XHTTP；
  - 不包含 Clash 的分流、DNS、代理组、监听端口和远程节点提供者。
- **会被跳过的节点**：依赖 `dialer-proxy` 的节点、不支持的协议/插件/传输参数。下载时会显示跳过的数量。没有可导出的节点时返回 HTTP 422。
- **缓存与写入**：v2rayN 输出由浏览器或 Worker 内置代码生成，不调用外部 subconverter。边缘缓存按格式分开，编辑、刷新或删除订阅会让两种格式的缓存同时失效。

## 存储架构

- **`SUB_STORE`**（SQLite Durable Object）：每个订阅一个实例，保存生成的 YAML、订阅来源和刷新设置，是订阅数据的权威来源。同一订阅的写入在这里串行处理。
- **`SUB_KV`**：发现索引和兼容镜像，供订阅列表和 Cron 扫描使用；同时缓存规则目录。
- **迁移**：旧版 KV 记录在首次访问时自动导入 Durable Object，订阅链接保持不变。
- **短暂延迟**：KV 镜像写入失败时由 Durable Object 闹钟重试，所以列表和 Cron 发现可能比实际写入略晚一点。

## ACL4SSR 在线模板

规则方案中提供 7 个 ACL4SSR 官方远程配置：标准版、精简版、完整版、AI 版、多地区版、无测速版、无拦截版。

- **模板来源**：所选模板随订阅保存。访问订阅链接时，Worker 把对应的 ACL4SSR `master` 配置交给 subconverter 生成；Cron 只更新订阅源，不复制模板文件。
- **转换缓存**：转换结果按“订阅 + 内容版本”缓存在 Cloudflare 边缘缓存中。30 分钟内直接返回缓存，所以模板更新一般在 30 分钟左右生效。边缘缓存只在自定义域名上生效，`*.workers.dev` 上每次都会重新转换。
- **转换后端**：在 `edge/wrangler.jsonc` 中通过 `SUBCONVERTER_BACKEND` 和 `SUBCONVERTER_FALLBACK_BACKENDS`（逗号分隔）配置，默认使用 [ACL4SSR 在线工具](https://acl4ssr-sub.github.io/)列出的公开后端。每个后端最多等待 8 秒，超时或返回无效结果时自动切换下一个，失败的后端在 60 秒内会被跳过。
- **全部失败时**：优先返回同一版本最近一次成功的转换结果（保留 7 天，响应头 `X-SubBoost-Converter-Cache: stale`）。没有可用结果时，返回该订阅使用内置规则生成的原生配置（响应头 `X-SubBoost-Converter-Fallback: native`）。
- **隐私**：交给转换服务的只有节点名称和占位节点，使用 5 分钟有效的临时链接。真实地址、凭据以及 VLESS/XHTTP/ECH 字段由 Worker 填回。

公共后端可能限流或停服，可以替换为自己的服务地址。

## 部署

### 1. 环境要求

- Node.js `22.13+` 或 `24+`
- Cloudflare 账号，并已登录 Wrangler
- 一个用于绑定 `SUB_KV` 的 KV Namespace

```bash
npm ci
```

### 2. 配置 Worker

创建 KV Namespace：

```bash
npx wrangler kv namespace create SUB_KV --config edge/wrangler.jsonc
```

然后编辑 [`edge/wrangler.jsonc`](./edge/wrangler.jsonc)：

- 把 `kv_namespaces` 中的 `id` 改成上一步返回的 Namespace ID。
- 把 Worker 的 `name` 改成自己的名称。
- 把 `services` 中 `SELF` 绑定的 `service` 改成同一个名称。Worker 通过这个绑定调用自身，让每个订阅的定时刷新在独立调用中执行。

不要直接复用仓库中的 KV ID 和 Worker 名称。

Cron Trigger 使用 UTC 时间：

| Cron | 作用 |
| --- | --- |
| `0 */6 * * *` | 每 6 小时检查到期的订阅。每个到期订阅通过 `SELF` 绑定独立刷新，每次最多 30 个，最久未更新的优先。自动更新间隔小于 6 小时的订阅实际按 6 小时执行 |
| `17 3 * * *` | 每天同步一次远端规则目录 |

### 3. 配置 Secret

登录密码和会话签名密钥必须保存在 Worker Secret 中，不要写进源码：

```bash
npx wrangler secret put EDGE_ADMIN_PASSWORD --config edge/wrangler.jsonc
npx wrangler secret put EDGE_SESSION_SECRET --config edge/wrangler.jsonc
```

规则搜索较频繁时，可以配置只读 GitHub Token 以提高 API 限额：

```bash
npx wrangler secret put GITHUB_TOKEN --config edge/wrangler.jsonc
```

### 4. 检查并部署

```bash
npm run edge:typecheck
npm run edge:build
npm run edge:deploy
```

自定义域名在 Cloudflare Dashboard 的 Worker Routes 或 Custom Domains 中绑定。Secret 和 KV 数据不会进入 Git 仓库或源码归档。

## 常用接口

| 路径 | 说明 |
| --- | --- |
| `/` | 配置生成器 |
| `/login` | 管理员登录 |
| `/dashboard` | 我的订阅 |
| `/config/:token` | 已保存订阅的固定地址，无需登录 |
| `/api/subscriptions` | 订阅管理接口，需要登录 |
| `/api/source-import` | 代理拉取远程订阅内容，需要登录 |
| `/api/rules/search` | 远端规则目录搜索，需要登录 |
| `/api/rules/cn-candidates` | 中国规则候选，需要登录 |
| `/api/rules/status` | 规则目录缓存和下次同步状态，需要登录 |
| `/api/rules/refresh` | 立即同步规则目录，只接受登录后的 POST |
| `/api/health` | 健康检查 |
| `/sub` | 通用 Base64 订阅输出（兼容旧接口） |
| `/clash` | Clash YAML 转换输出（兼容旧接口） |

## 目录结构

| 目录 | 用途 |
| --- | --- |
| `edge/app` | Edge 版 Next.js 页面：生成器、登录页和我的订阅 |
| `edge/src` | Edge 页面组件、主题和布局 |
| `edge/worker` | Worker 路由、登录、Durable Object、KV、订阅转换、规则 API 和 Cron |
| `packages/core` | 上游协议解析、配置生成和规则模型 |
| `packages/server-core` | 上游服务端订阅处理与规则目录 |
| `packages/ui` | 上游 SubBoost 配置器和通用界面 |
| `local` | 上游自部署版本（Node.js + PostgreSQL） |
| `docs/design/edge-ui-v2` | EdgeSub 界面设计稿 |

## 本地开发与检查

```bash
npm run edge:dev
npm run edge:typecheck
npm run test:unit
npm run lint
```

- **本地 Secret**：参考 [`edge/.dev.vars.example`](./edge/.dev.vars.example)，实际的 `edge/.dev.vars` 已被 Git 忽略。
- **根目录类型检查**：`npx tsc --noEmit -p tsconfig.json` 还会检查 `local/`。检查前需要先生成 Prisma 客户端：

  ```bash
  npm run local:db:generate
  ```

- **Windows 上的测试**：基于 workerd 的 Durable Object 运行时测试默认跳过，可设置 `EDGESUB_RUN_WORKERD_TESTS=1` 强制运行。

## 同步上游

```bash
git remote add upstream https://github.com/SubBoost/subboost.git
git fetch upstream
```

EdgeSub 的共享包已经和上游分叉，通常不能直接合并，需要按提交挑选（`git cherry-pick`）。挑选时注意：

- 保留 `edge/` 目录和 EdgeSub 界面。
- 上游的 `test/regression/` 在本仓库中已移除，相关冲突保持删除即可。
- 上游从 v2.10.0 起把 `js-yaml` 升级到 5.x，并新增 `packages/core/src/config/yaml-schema.ts`。本仓库仍使用 4.3.2，依赖这个文件的提交需要和依赖升级一起同步。
- 同步后运行 `npm run test:unit`、`npm run edge:typecheck` 和 `npm run edge:build`。

## 更新日志

### 未发布（main 分支，2026-10-26）

本次同步上游 SubBoost v2.10.0 中与订阅转换直接相关的修复，并清理根目录类型检查错误。界面不变。

- **协议参数保留**：导入订阅时不再丢失以下参数。这些高级选项需要客户端内核支持。
  - VLESS XHTTP 的独立下行设置（`download-settings`）、连接复用和填充等参数；
  - VLESS Reality 的混合密钥交换（`support-x25519mlkem768`）；
  - Hysteria2 的 ECH、TCP Fast Open 和混淆包长度；
  - TUIC/Hysteria、WireGuard、Snell（含 `shadow-tls`）和 SSH 的部分参数，此前会丢失或映射错误。
- **规则目标匹配**：修复导入规则后目标代理组匹配不上的问题，以及代理组改名、禁用、删除后规则引用失效的问题。编辑器和关系图预览保持一致。
- **YAML 兼容**：上游这部分修复用于 `js-yaml` 5.x。EdgeSub 使用的 4.3.2 已经能正确处理以下情况，因此没有引入上游的新 YAML 模块，只保留了对应的回归测试：
  - 以 `+.5` 这类字符开头的密码；
  - 多行 flow 数组的缩进；
  - `yes` 这类值不会被转成布尔值。
- **未采用的上游改动**：
  - IPv6 fake-ip DNS 环境下的 SSRF 复检：这是自部署服务器的场景，Worker 使用自己的远程抓取逻辑；
  - 依赖与 Node.js 24 安全基线升级：主要面向 Docker 镜像。
- **类型检查**：根目录 `tsc` 从 101 个错误降到 0 个：
  - 根 `tsconfig.json` 补上 `@local/*` 路径别名；
  - 路由测试改用 `NextRequest`；
  - 补齐测试数据缺少的字段。

升级说明：需要重新部署 Worker；无需迁移数据。

### EdgeSub 2.6.0-edge.13（2026-10-08）

本版本修复自定义强调色选不到浅色的问题，并让页面底色也跟随强调色。

- **浅色可以选了**：上个版本为了保证按钮白字可读，会把偏亮的颜色统一压暗，结果粉色变成灰褐、浅绿变成墨绿。现在按钮就是你选的颜色，按钮文字则按填充色亮度自动切换为白色或近黑色。任何颜色都至少有一种文字色满足 WCAG AA。
- **边框和淡色底可见**：浅色强调色下，边框和淡色底此前几乎看不见（例如 `#ffc0cb` 推导出的边框是 `#ffedf0`）。自定义色的色阶改用绝对亮度推导。
- **底色跟随强调色**：页面背景、卡片、分割线等中性色保留原有明暗层次，只把色相换成强调色的色相；共享 SubBoost 组件区域同步生效。正文文字的着色强度不变。
- **兼容性**：底色跟随用到 CSS 相对颜色语法（Chrome 119+ / Safari 16.4+ / Firefox 128+）。更老的浏览器自动回退到原来的中性配色。
- **已知取舍**：深色主题下自定义很暗的颜色时，按钮轮廓会变模糊，但按钮文字仍然清晰。

升级说明：需要重新部署 Worker；无需迁移数据。此前选过的自定义颜色会恢复成当初选的原色。

### EdgeSub 2.6.0-edge.12（2026-10-08）

本版本让主题强调色可以自定义，并统一了各强调色的对比度。

- **强调色菜单**：顶栏主题按钮改为下拉菜单，可选“跟随系统 / 浅色 / 深色”。强调色提供 8 个预设（橙、琥珀、玫瑰、紫、靛蓝、蓝、青、绿），也可以用取色器指定任意颜色。
- **本地保存**：选择只保存在浏览器本地，在首屏绘制前应用，不会闪色。
- **全局生效**：强调色对上游 SubBoost 组件区域同样生效，整套配色由一条 11 级色阶驱动。
- **对比度达标**：8 个预设全部达到 WCAG AA（4.70:1 – 6.29:1）。因此默认橙色加深，浅色主题按钮由 `#ea580c` 变为 `#c2410c`。

升级说明：需要重新部署 Worker；无需迁移数据。

### EdgeSub 2.6.0-edge.11（2026-10-07）

本版本同步上游 SubBoost v2.9.0 的节点解析、订阅刷新和配置功能，界面沿用 EdgeSub 自己的设计。

- **节点改名同步**：修复机场给节点改名后中转代理组失效的问题。刷新时，改名会同步到中转节点、落地节点、监听端口和代理组成员顺序。
- **REALITY 去重**：修复 REALITY 节点每次刷新都被当成新节点、重复追加的问题。机场改名后，手动修改过的节点名也不再丢失。
- **节点解析修复**：
  - Shadowrocket 的 VLESS 链接不再被误判为 REALITY；
  - 证书指纹不再被当作客户端指纹，`tfo` 参数得以保留；
  - 纯数字密码保留前导 0，WireGuard、Mieru 等节点不再被丢弃；
  - 规则含特殊字符时生成合法的 YAML；
  - IPv6、SSR 节点名和毫秒格式的到期时间解析正确。
- **自动处理节点**：新增“节点管理 → 自动处理”，用正则按节点原名保留或排除节点，定时更新时同样生效。为避免超出 Workers 的 CPU 限制，会额外拒绝高风险的正则写法。
- **代理组高级设置**：可以修改代理组类型、绑定本地监听端口；自动测速组可以单独设置测速地址。
- **自定义规则**：可以直接填写 `.mrs` 规则集链接，并支持批量导入。
- **未采用的上游改动**：
  - 上游的新主题；
  - 按每种客户端标识各拉一遍订阅的做法：在 Workers 上会让子请求翻倍；
  - 依赖 `node:crypto` 的 Cron 鉴权。

升级说明：需要重新部署 Worker；无需迁移数据。

### 更早版本

| 版本 | 日期 | 主要内容 |
| --- | --- | --- |
| 2.6.0-edge.10 | 2026-10-05 | 修复新粘贴的节点被残留删除记录隐藏；每次保存成功都有提示 |
| 2.6.0-edge.9 | 2026-10-05 | 修复同名节点删除一个后其余全部消失；编辑时“自定义”面板自动展开 |
| 2.6.0-edge.8 | 2026-10-05 | 修复从“我的订阅”进入编辑时节点和来源偶发丢失 |
| 2.6.0-edge.7 | 2026-10-02 | 界面全面改版：石墨灰/浅色主题、三步生成器、YAML 与关系图抽屉、新版“我的订阅”和手机布局 |
| 2.6.0-edge.6 | 2026-10-01 | 适配免费版 10 ms CPU 上限：每个订阅独立刷新；ACL4SSR 结果边缘缓存与故障回退；`/config` 支持 ETag/304 |
| 2.6.0-edge.5 | 2026-10-01 | 修复编辑订阅时的覆盖和丢失；自动更新时间和失败原因可见；最小间隔调整为 6 小时 |
| 2.6.0-edge.4 | 2026-10-01 | Cron 改为每 6 小时，大幅减少 KV 写入 |
| 2.6.0-edge.3 | 2026-09-07 | 优化节点连通性测试；保留 ACL4SSR 模板远程更新 |

业务逻辑审查、修复与验证结果见[审查报告](docs/business-logic-review-2026-09-20.md)。上游各版本说明见 [docs/release-notes.md](docs/release-notes.md)。

## 开源许可

EdgeSub 及其上游代码按照 [GNU Affero General Public License v3.0 only](./LICENSE) 发布。

如果修改本项目并通过网络向用户提供服务，AGPL-3.0 要求向这些用户提供部署版本对应的完整源码。本项目在页头、页脚和手机导航中提供源码入口，`npm run edge:build` 会在静态导出前生成当前版本的源码归档。

请保留项目来源、原作者版权、许可证文件和修改说明，不要将此修改版描述为 SubBoost 官方版本。

## 免责声明

本项目不提供代理服务、节点或订阅内容，也不保证第三方订阅和规则源的可用性、合法性或安全性。使用者应自行确认所在地区的法律要求，并对导入的数据、部署配置和使用行为负责。
