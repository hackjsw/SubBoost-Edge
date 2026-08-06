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

## 项目简介

EdgeSub 将 SubBoost 的配置生成器和订阅管理能力部署到一个 Cloudflare Worker 中。Next.js 前端会静态导出并由 Workers Static Assets 提供，API、登录、KV 数据和定时任务则在同一个 Worker 内运行，因此不需要额外维护服务器或数据库。

它不会提供代理节点或代理服务，只负责解析、转换、保存和更新用户自行提供的订阅内容。

## Edge 版本功能

- 保留 SubBoost 的 Clash/Mihomo 配置生成、节点导入、链式代理和智能分流能力。
- 快捷模式在“完整版”下提供 ACL4SSR 模板入口，可选择 7 个官方远程配置。
- 支持 `/sub`、`/clash`、`/shorten` 和 `/test` 等原 Worker 接口。
- 使用 Worker Secret 密码登录，并通过签名的 HttpOnly Cookie 保护管理接口。
- 使用 `SUB_KV` 持久保存订阅、生成结果、自动更新设置和规则索引。
- 提供 `/dashboard` 管理已保存的订阅，可编辑、刷新、下载和删除记录。
- 每 15 分钟扫描自动更新任务，并通过 KV metadata 跳过尚未到期的记录。
- 每天同步一次 MetaCubeX 规则目录，搜索结果缓存到 KV 24 小时。
- Dashboard 显示规则来源、数量和同步时间，并支持管理员立即同步。
- GitHub API 受限时自动降级到官方目录页面，再失败时使用内置规则目录。
- 构建时生成对应源码归档，并通过 `/subboost-edge-source.tar.gz` 向网络用户提供。

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
| `*/15 * * * *` | 每 15 分钟检查一次需要更新的订阅 |
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

所选方案会随订阅记录保存到 KV。手动刷新或 Cron 到期刷新订阅时，Worker 会将对应的 ACL4SSR `master` 配置地址交给 subconverter，因此会使用上游当前版本；Worker 不会每 15 分钟单独下载或复制模板文件到 KV。若 ACL4SSR 或 subconverter 暂时不可用，转换请求会返回错误，不会静默切换到原生规则。

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
