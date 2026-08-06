# ACL4SSR 远程配置选择器

## Goal

让 EdgeSub 用户在创建或更新持久订阅时选择一个可信的 Clash 规则方案，并在不更换订阅链接的情况下由 Worker 按所选方案返回原生 YAML 或通过 subconverter 套用 ACL4SSR 远程配置。

## Background

- 快捷模式中的“精简版 / 标准版 / 完整版”属于 EdgeSub 内置生成模板，会直接改变编辑器预览。
- ACL4SSR `Clash/config/*.ini` 属于 subconverter 外部配置，不能假装成可直接应用到编辑器的同类模板。
- 当前 Edge `/clash` 已固定使用 `ACL4SSR_Online.ini`，但主界面创建的 `/config/<token>` 订阅始终返回 KV 中保存的原生 YAML。
- 当前 Edge 订阅记录没有转换方案字段，旧记录必须继续按原生方案工作。

## Requirements

- 在生成订阅链接对话框中提供一个独立的“Clash 规则方案”入口，并以单选弹窗展示方案。
- 弹窗使用 EdgeSub 亮色工作台视觉，支持键盘操作、清晰选中态和移动端滚动。
- 默认方案为 `EdgeSub 原生`，不得改变现有订阅的输出行为。
- 提供经过代码白名单固定的 ACL4SSR 官方在线方案：标准、精简、完整、AI、多地区、无自动测速、无拦截。
- 不接受用户提供的任意远程配置 URL；前端和 Worker 共享同一份方案 ID 与元数据定义。
- 创建和更新 Edge KV 订阅时持久化方案 ID，并在详情响应中返回该字段。
- `/config/<token>` 保持稳定：原生方案直接返回保存的 YAML，远程方案通过既有 subconverter 后端转换。
- Worker 给 subconverter 的输入使用同一 token 的原始 YAML 只读地址；不得递归调用转换地址。
- 旧 KV 记录缺少方案字段时按原生方案处理。
- 非法方案 ID 在写入边界返回 400，不得写入 KV 或访问 subconverter。
- 既有 `/clash` 接口允许通过白名单方案 ID 选择官方远程配置，同时保持无参数时的旧默认行为。
- 远程方案更新依赖 ACL4SSR `master` URL；Worker 继续使用现有 5 分钟转换缓存，不增加 Cron。

## Out Of Scope

- 任意用户自定义 `config=` URL。
- 将 ACL4SSR INI 解析或转换成 EdgeSub 内置模板。
- 新增模板社区、收藏、评分或上传功能。
- 改变 Local/Prisma 部署的订阅输出方式。

## Acceptance Criteria

- [x] Edge 用户可从订阅链接弹窗打开方案选择器，并看到原生及 7 个 ACL4SSR 方案。
- [x] 当前方案在触发器与列表中均有明确选中态，选择后关闭弹窗仍保留。
- [x] 创建订阅时方案 ID 写入 KV；重新编辑订阅时恢复相同方案。
- [x] 更新订阅方案不会改变 `/config/<token>` 地址。
- [x] 原生方案返回保存的 YAML，且不调用 subconverter。
- [x] ACL4SSR 方案调用 subconverter，并传递与白名单 ID 对应的官方配置 URL。
- [x] subconverter 获取原始 YAML 时不会再次触发转换。
- [x] 缺少方案字段的旧记录仍返回原生 YAML。
- [x] 非法方案写入请求返回 400；未知公开读取参数不会绕过白名单。
- [x] Edge Worker、共享 Hook 与弹窗的聚焦测试通过。
- [x] `npm run edge:typecheck`、`npm run lint`、`npm run edge:build` 通过。
- [x] 亮色弹窗在桌面和移动视口无文本溢出、遮挡或不可滚动区域。

## Notes

- ACL4SSR 上游来源：`https://github.com/ACL4SSR/ACL4SSR/tree/master/Clash/config`。
- 默认远程配置仍为 `ACL4SSR_Online.ini`，但持久订阅默认保持 EdgeSub 原生以兼容现有行为。
