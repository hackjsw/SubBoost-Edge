# ACL4SSR 远程配置选择器设计

## Architecture

```text
共享方案目录
  -> Edge 页面适配器
  -> useSubscriptionLink
  -> SubscriptionLinkDialog / 方案弹窗
  -> POST/PUT /api/subscriptions
  -> edge-config:<token> KV
  -> GET /config/<token>
       native -> record.yaml
       acl4ssr -> subconverter(url=/config/<token>?raw=1, config=<allowlisted ini>)
```

## Ownership

- `packages/core/src/subscription/clash-conversion-profiles.ts`
  - 唯一方案目录、ID 类型、默认值、查询与校验。
  - `native` 无远程 URL；ACL4SSR 条目只包含官方 HTTPS raw URL。
- `packages/ui/src/product/home/*`
  - 可选的订阅方案能力、选择状态、弹窗与保存 payload。
  - Shared UI 不直接调用 Worker，也不持有环境变量。
- `edge/app/page.tsx`
  - 启用方案能力并向共享 surface 提供共享目录。
- `edge/worker/edge-api.ts`
  - 校验并持久化方案 ID；生成稳定公开 URL；根据记录决定原生或远程响应。
- `edge/worker/subconverter.ts`
  - 构建受控 subconverter URL、执行转换、统一上游响应头处理。
- `edge/worker/subscription.ts`
  - 既有 `/clash` 使用同一白名单解析和转换 helper。

## Data Contract

`StoredSubscription` 增加可选字段：

```ts
conversionProfileId?: ClashConversionProfileId;
```

- 读取旧记录时缺省为 `native`，无需 KV 批量迁移。
- 新建记录总是写入规范化 ID。
- PUT 未提交该字段时保留现有值；显式非法值返回 400。
- 详情和列表响应暴露 `conversionProfileId`，但订阅 URL 始终为 `/config/<token>`。

`HomeSubscriptionAdapter` 增加可选 `conversionProfiles` 与默认 ID。Local 不提供能力时，Shared UI 不展示入口，也不发送字段。

## Conversion Flow

1. 客户端请求 `/config/<token>`。
2. Worker 从 KV 读取记录并规范化方案。
3. `native`：沿用当前响应头并返回 `record.yaml`。
4. ACL4SSR：构建 `/config/<token>?raw=1` 作为 subconverter 输入；`raw=1` 仅返回保存的 YAML。
5. subconverter 的 `config` 仅来自共享白名单，保留 `target=clash`、`emoji=true`、`udp=true`、`list=false` 与 300 秒 Cloudflare 缓存。
6. 转换失败返回 502，不静默回退原生配置，避免用户误以为远程规则已生效。

## Compatibility

- 旧 KV 记录和未启用该能力的 Local 页面按 `native` 工作。
- 现有订阅 URL 不变；更新方案后客户端下一次刷新即可生效。
- 既有 `/clash` 未传 `profile` 时继续使用 `ACL4SSR_CONFIG_URL` 环境覆盖或原默认 URL。
- `profile=native` 不适用于 `/clash`，返回 400；持久订阅的原生方案由 `/config/<token>` 处理。

## Security

- 不接收任意配置 URL，避免让第三方 subconverter 成为 SSRF/代理入口。
- 仅将 bearer 型原始订阅 URL 发送给当前配置的 subconverter；界面明确标注远程依赖。
- 不在日志中输出 token、源订阅 URL 或完整 converter URL。
- 未知方案在写入边界拒绝；KV 里意外出现未知值时按安全的 `native` 读取，不请求远端。

## UI

- 主订阅对话框显示紧凑选择行：图标、方案名称、来源/特征与向右箭头。
- 二级弹窗使用单列 radio 列表；原生方案置顶，ACL4SSR 方案按使用场景排列。
- 选中态使用 EdgeSub 青绿色边框与浅底，不复制参考图的深色紫色样式。
- 弹窗最大高度受视口约束，列表独立滚动；移动端保持底部确认按钮可见。

## Rollback

- 删除 UI 能力和 Worker 分支即可恢复原生输出。
- KV 新字段为可选且旧代码会忽略，无需数据回滚。
