# ACL4SSR 远程配置选择器实施计划

## Steps

1. 新增共享方案目录与单元测试。
2. 提取 Edge subconverter helper，并让既有 `/clash` 使用白名单方案。
3. 扩展 Edge KV 记录解析、创建、更新、公开响应和 `/config/<token>` 输出分支。
4. 扩展共享订阅 adapter、编辑上下文与 Hook payload 往返。
5. 新增亮色方案选择弹窗并接入 `SubscriptionLinkDialog`。
6. 在 Edge 页面适配器启用方案目录；Local 保持关闭。
7. 扩充 Worker、Hook、loader 和组件测试。
8. 执行聚焦测试、全量质量门禁与浏览器视觉验证。

## Validation

```text
npx vitest run edge/worker/index.test.ts
npx vitest run packages/ui/src/product/home/use-subscription-link.test.ts
npx vitest run packages/ui/src/product/home/subscription-link-dialog.test.ts
npm run edge:typecheck
npm run lint
npm run test:unit
npm run edge:build
```

## Risk Points

- 公开配置路由调用自身原始地址时必须通过 `raw=1` 终止递归。
- `PUT` 编辑必须保留旧方案，且修改方案后 URL 不变。
- Shared UI 的可选能力不得影响 Local 类型检查或现有测试。
- 第三方 subconverter 的测试必须使用 mock fetch，不依赖公网。

## Review Gates

- 检查所有方案 URL 均为 ACL4SSR 官方 HTTPS raw URL。
- 检查未知 ID 无法进入 KV 或远程请求。
- 检查旧记录读取路径和原生零远程请求路径。
- 检查桌面与移动弹窗的选中态、滚动、关闭和确认行为。
