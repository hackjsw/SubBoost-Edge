# Raise Edge stored YAML limit

## Goal

Raise the Edge stored YAML limit from 2 MiB to 8 MiB while retaining the 20 MiB total KV record guard, with boundary regression coverage.

## Confirmed Facts

- Edge currently returns HTTP 413 `配置文件过大` before any KV write when generated YAML exceeds 2 MiB.
- A managed subscription may contain up to 10,000 nodes, so a valid subscription with about 1,600 verbose nodes can exceed the current YAML limit without exceeding the node quota.
- The serialized subscription record has a separate 20 MiB guard and remains the final application-level protection before KV persistence.

## Requirements

- Set `MAX_STORED_YAML_BYTES` to 8 MiB for Edge subscription create and update flows.
- Keep `MAX_STORED_SUBSCRIPTION_BYTES` at 20 MiB and preserve the existing `订阅数据过大，无法保存到 KV` behavior.
- Preserve the existing HTTP 413 `配置文件过大` response for YAML content above the new 8 MiB limit.
- Add regression coverage proving content above the old 2 MiB limit is accepted and content above the new 8 MiB limit is rejected.
- Deploy the verified change to Cloudflare and push all work and Trellis bookkeeping commits to GitHub `main`.

## Acceptance Criteria

- [x] A valid YAML payload larger than 2 MiB and no larger than 8 MiB can be stored.
- [x] A YAML payload larger than 8 MiB returns HTTP 413 with `配置文件过大` and is not written to KV.
- [x] A serialized subscription record larger than 20 MiB still returns the existing KV-size error.
- [x] Edge tests, type checks, lint, and production build pass.
- [x] The deployed custom domain returns HTTP 200 on the new Worker version.

## Out Of Scope

- Changing source import limits, node quotas, line limits, KV schema, compression, or Local deployment behavior.
