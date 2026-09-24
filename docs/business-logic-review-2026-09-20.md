# Cloudflare 部署业务逻辑审查与订阅格式扩展

审查日期：2026-09-20。范围为 Cloudflare Worker、CF 静态页面及其调用的共享模块；不纳入本地端。部署目标为 Cloudflare `test` Worker：<https://test.110555343.workers.dev>。最终部署版本号以发布回执为准。

## 结论

可以同时提供 Clash / Mihomo 和 v2rayN 输出，且无需更换原订阅链接。本次已实现显式选择格式、前端下载/复制入口、缓存隔离，并修复审查列出的 7 项 CF 业务问题。共享界面通过部署能力开关启用新入口，只有 CF 页面开启；未修改本地端接口。

已有链接仍返回原有 YAML；只有追加 `format=v2rayn` 才导出 Base64 节点订阅。两种格式复用同一条订阅和最近成功的节点快照，更新时沿用原 token。

审查覆盖 CF 入口权限、输入解析与远程拉取、节点合并/删除/改名、配置与链式代理生成、订阅创建/编辑/删除、手动/Cron 刷新、KV 持久化、缓存与响应头，以及前端保存/下载。下文列出已经修复的问题和验证结果。

## 已修复的问题

### 1. P1：短链接查询参数可能绕过 POST 转换的登录检查

- 位置：`edge/worker/index.ts`。
- 触发：匿名请求 `POST /sub?id=任意非空值` 或 `/clash?id=任意非空值`，在 JSON 请求体中提供 `source`。
- 原因：公开短链接分支只检查 URL 查询参数；进入转换处理器后，POST 实际读取请求体。因此并不需要有效短链接即可进入原本要求登录的转换流程。
- 影响：未登录用户能够触发节点转换或远程拉取。任意路径上的旧 `?id=` 路由也需要同样保护。
- 修改：公开短链接分支仅处理 GET/HEAD；其他带 `id` 的未登录转换请求返回 401。正常 GET 订阅链接不变，已登录 POST 仍使用原流程。
- 验证：对 `/sub`、`/clash`、`/` 三种路径增加匿名 POST 回归，确认返回 401 且没有出站请求。

### 2. P2：CF 的局部设置更新可能关闭自动更新或改变调度时间

- 位置：`edge/worker/edge-api.ts`。
- 触发：PATCH 只提交名称或智能匹配选项，没有提交 `autoUpdateInterval`。
- 原因：缺失字段被归一化成 null；同时每次保存设置都会重新计算下次执行时间并删除失败记录。
- 修改：未提交的间隔沿用已有值；仅当间隔实际改变时重排调度并清理失败提示。只改名称不会关闭自动更新，也不会掩盖上游失败。
- 验证：保存已有自动更新/失败信息的订阅后仅修改名称，检查间隔、下次时间和失败信息均保留。

## 本轮已按建议修改

以下问题已在本轮修改，保留旧链接的默认行为，并为迁移风险加入回归覆盖。

| 优先级 | 问题 | 本轮修改 |
| --- | --- | --- |
| P1 | KV 跨实例写入竞争 | 新增 `SubscriptionStore` Durable Object，按 token 串行处理读写、删除和 KV 镜像；旧 KV 数据首次访问时自动导入 DO，token 与 `/config/:token` 不变。 `edge/worker/edge-api.ts` 在配置响应前读取 DO 版本，避免旧缓存跨实例继续生效。 |
| P1 | 外部 Clash 规则方案丢失自定义配置 | `subconverter` 恢复原 DNS、listeners 等非规则配置，合并两边代理组和 providers。普通同名组以外部规则方案为准；节点/监听依赖的原组及其传递依赖优先保留。原 proxy-provider 覆盖同名外部 provider，合并后检查引用。 |
| P1 | 链式代理缺少完整环路校验 | 新增共享 `validateProxyReferences`，最终 Clash 生成检查节点、代理组、dialer-proxy、provider、listeners 的引用和循环；保存的结构化 YAML 也执行严格校验。 |
| P2 | 旧 `/sub` 去重只看 host:port | 默认端点去重保持兼容；新增 `dedup_strategy=identity`，按完整协议、凭据和传输参数去重，短链接会保存该选项。 |
| P2 | 旧 `/sub` 解析差异 | SS/SSR 节点改用共享节点解析器；URI 行仅在逗号后紧跟另一个 URI 协议时拆分，`alpn=h2,http/1.1` 等参数不再被拆开。 |
| P2 | 部分源刷新失败时 userinfo 不完整 | 每个源的 userinfo 独立聚合；失败源沿用保存的上次值，并在 `X-SubBoost-Stale-Userinfo` 标记数量。 |
| P2 | 保存校验与刷新校验不一致 | CF 结构化保存使用与刷新相同的 `buildGenerateOptionsFromConfig` / `generateClashYaml`，以节点和配置生成权威快照。校验 YAML 顶层、节点对象/常用必填字段/地址端口、provider 定义及引用，并统一 10000 节点上限。拒绝无节点且无 provider 的结构化保存；修复空 proxies/groups 被序列化成 null 的问题。 |

Durable Object 使用 SQLite 保存权威记录；旧 KV 数据在对应 token 首次访问时按原 token 自动导入。并发修改采用内容版本比较，过期写入返回 409。大记录分块存储，删除留下标记，避免旧 KV 副本复活记录；首次访问时的暂时性 KV 未命中不会变成永久删除。

KV 继续作为管理列表/Cron 的发现索引和兼容镜像。镜像写入失败时由持久化 alarm 重试，因此列表和任务发现仍可能有短暂延迟；已有 token 的读取以 DO 为准。响应缓存按格式、GET/HEAD 和 DO 内容版本隔离，跨实例请求先确认版本。回滚时必须保留 DO 绑定及权威读取逻辑，不应直接回退到仅从 KV 读取的旧版本。

保存校验只用于新建/覆盖保存，不重新校验或重建已有记录的 GET 输出。仅提交 YAML 的快照经校验后按原文保存，允许显式 `proxies: []` 的直连配置；提交 `nodes/config` 或刷新源时，以服务端重新生成的结果为准。它是本项目的结构与引用校验，并非完整 Mihomo 内核配置校验。

## 两种格式的兼容契约

| 项目 | Clash / Mihomo | v2rayN |
| --- | --- | --- |
| CF 链接 | `/config/:token`，保持原状 | 同一 URL 增加 `?format=v2rayn` |
| 输出 | 原 YAML；原有 Clash 规则方案继续生效 | 当前已生成 YAML 内可兼容节点的分享链接，经 UTF-8 Base64 编码 |
| 内容范围 | 节点、分流、DNS、代理组等原配置 | 节点；不包含 Clash 分流、DNS、代理组、listeners 或 provider 定义 |
| 客户端识别 | 不根据 User-Agent 自动切换 | 只识别显式 `format=v2rayn` |
| 存储与更新 | token 和 URL 不变，权威存储迁移至 DO，KV 保留兼容镜像 | 读取同一 YAML 快照，不单独存储 v2rayN 副本；刷新失败时仍使用上次成功快照 |
| 缓存 | 默认/raw 响应分别缓存，并校验 DO 内容版本 | 独立格式缓存；保留 GET/HEAD 隔离，编辑/刷新/删除按 token 统一失效 |
| 外部转换服务 | 保留原逻辑 | 不调用 |
| 无可导出节点 | 原有行为 | HTTP 422；不会返回成功的空订阅 |

已有参数时使用 `&format=v2rayn`。`raw=1&format=v2rayn` 仍导出 v2rayN；原 `raw=1` 链接仍返回原 YAML。已有其他未识别的 format 值继续沿用原 Clash 行为。

双格式参数用于管理页保存生成的 `/config/:token` 链接。旧 `/sub`、`/clash`、`/shorten` 链接保持各自已有行为，不需要迁移。

支持 SS、VMess、VLESS、Trojan、Hysteria2、TUIC v5、AnyTLS 的常用参数。测试覆盖中文名称、特殊字符密码、IPv6、REALITY、WebSocket early data、HTTPUpgrade、gRPC、基础 XHTTP、SS 插件和 Hysteria2 混淆。对不支持的协议、链式代理依赖、H2、部分自定义请求头、动态 ECH、XHTTP download/reuse 等配置跳过并计数，不静默把这些连接降级成普通 TCP。

导出不保证不同客户端高级参数逐项等价。例如部分协议的带宽、连接复用、心跳、UDP 策略、监听端口属于客户端设置。需要完整保留这些行为时，继续使用原 Clash / Mihomo 输出。

跳过统计通过 `X-SubBoost-Skipped-Nodes` 和 `X-SubBoost-Skipped-Providers` 响应头提供，直接下载时在界面中提示。全部节点不可转换时拒绝导出。v2rayN 可用协议仍取决于客户端版本及所选内核，建议使用近期版本。

## 验证结果

- 22 个相关测试文件、216 个用例通过：序列化、URL 契约、响应头、CF GET/HEAD/cache/update/delete、原转换后端、旧 YAML 输出、引用/循环校验、userinfo 回退、去重和旧 URI 解析、保存/刷新生成一致性，以及前端下载/复制和部署能力开关。
- 其中 3 个用例通过 Miniflare/workerd 实际运行 Durable Object SQLite，验证旧记录导入、并发写入 204/409、版本缓存失效、删除标记、暂时性 KV 未命中恢复和超过 2 MiB 的 Unicode 分块往返。
- Edge TypeScript 检查通过，改动的 TypeScript/TSX 文件 ESLint 检查通过。
- 发布使用 Edge production build 和 Wrangler deploy；发布后通过 `/api/health` 检查 Worker。源码归档包含本轮新增的格式导出、DO 存储和校验代码。
- 保留原 Clash 下载内容、原 subscriptionUrl/token、流量头和更新间隔；新增格式请求与原格式交错访问已覆盖。
- `local/` 和 `README-CN.md` 无本轮改动；共享界面默认保持原入口，只有 CF 适配器启用 v2rayN。
- 未连接真实代理服务器、未在 v2rayN/Clash 桌面客户端执行导入连通性测试，未运行全仓测试。

分享字段参考了 v2rayN 上游 `ServiceLib/Handler/Fmt` 中的 BaseFmt、VLESSFmt、VmessFmt、TrojanFmt、ShadowsocksFmt、Hysteria2Fmt、TuicFmt、AnytlsFmt（2026-09-20 读取），并结合本项目现有解析器做参数回归。参考入口：[v2rayN 格式处理源码](https://github.com/2dust/v2rayN/tree/master/v2rayN/ServiceLib/Handler/Fmt)。
