# 实施 13：清理冗余 legacy CI workflow

## 结论

任务 13 已按“一个 workflow 一个 PR、前一个合入后再开始下一个”的约束完成。owner 于 2026-09-06 直接查看 GitHub settings，确认 `main` 已启用 branch protection，required status checks 只有 `offline-ci`，不包含任何 `093A*` 的 `test`。本单未修改 branch protection / required checks 配置。

已删除 5 个被统一 `PR offline CI / offline-ci` 完全覆盖的 legacy workflow：

- `.github/workflows/task-093ag-tests.yml`
- `.github/workflows/task-093ah-tests.yml`
- `.github/workflows/task-093an-tests.yml`
- `.github/workflows/task-093ao-tests.yml`
- `.github/workflows/task-093aa-tests.yml`

每个删除 PR 均只删除对应的一个 workflow 文件；没有修改测试、源码、`package.json`、`tsconfig*.json`、`.mcp.json` 或 `pr-offline-ci.yml`。

## 逐 PR 验收

| 顺序 | workflow | branch | PR | 最终 exact head | 最终 head 完整 check 列表 | offline-ci run |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `Task 093AG tests` | `task/13-remove-093ag` | #92 | `56b80abe9cb93214fee48225e26fafb31e0da8a2` | `offline-ci` SUCCESS; `letta` SUCCESS | https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34047758533 |
| 2 | `Task 093AH tests` | `task/13-remove-093ah` | #93 | `c919a4f9a456d56c2c02911691203022089e8a30` | `offline-ci` SUCCESS; `letta` SUCCESS | https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34047830000 |
| 3 | `Task 093AN tests` | `task/13-remove-093an` | #94 | `8eb5da7bad762e1c7022abe8b81de6e1012cda1b` | `offline-ci` SUCCESS; `letta` SUCCESS | https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34047910644 |
| 4 | `Task 093AO tests` | `task/13-remove-093ao` | #95 | `c2cc771e5458a0c6851cb0bcd0d7fbcbe974a441` | `offline-ci` SUCCESS; `letta` SUCCESS | https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34047983443 |
| 5 | `Task 093AA tests` | `task/13-remove-093aa` | #96 | `330c9ae22a0917eb4e671cbead2a7d85b872d755` | `offline-ci` SUCCESS; `letta` SUCCESS | https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34048063701 |

GitHub Actions 的 run metadata 已逐一回读；上述 5 个 `offline-ci` run 的 `head_sha` 均与表中最终 exact head 完全一致。

## `093AA` skip 原因与删除依据

`task-093aa-tests.yml` 的 `pull_request` 触发器有路径过滤：`relationship-memory/**`、`scripts/**`、`package.json`、`package-lock.json` 以及该 workflow 自身。更关键的是，它唯一的 `test` job 还有 job-level 条件：

```yaml
if: github.head_ref == 'task/093aa-ombre-legacy-semantic-migration-runner' || github.head_ref == 'task/093aa-contract-correction-source-vs-canonical-subject'
```

PR #91 的 branch 不满足该 `github.head_ref` 条件，因此在相关路径已触发 workflow 的情况下，唯一 job 被 skip，表现为整个 `Task 093AA tests` check 为 SKIPPED。skip 原因不是“workflow 一直没用”，而是明确的历史 branch-name gate。

当该条件命中时，093AA 的实际步骤只有 `npm ci` 与 `npm test`，没有额外专项测试、provider 调用或其他行为。统一 `offline-ci` 无路径过滤，并执行 `npm ci`、`npm run test:ci` 与 `npm run typecheck`；因此 093AA 的有效执行内容也已被统一门禁覆盖，可以删除。

## 清理前后

清理前，以 PR #91 @ `8a0793648800d7f22bc67dc931177524ee09da2c` 的已确认列表为基准，共有 6 个相关 check：4 个成功的 `093AG/AH/AN/AO` 全量 `npm test`、1 个 skipped 的 `093AA`、1 个成功的 `offline-ci`。其中 legacy `093A*` check 为 5 个。

清理后，这 5 个 legacy check 对应的 workflow 均已从 `main` 删除，legacy check 数量由 **5 降为 0**。每个删除 PR 的最终 head 上都只观察到两个有效 check：`offline-ci` 与独立的 `letta`，均为 SUCCESS。由于删除 workflow 文件本身会触发 `letta`，这个“2”是本单删除 PR 的实测 check 数，不把它误写成所有未来 PR 恒定只有两个 check。

## 保留项

当前 `main` 的 `.github/workflows/` 只剩：

- `pr-offline-ci.yml`：统一 required gate，保留。
- `letta.yml`：独立 Letta Code 职责，任务 08 已明确不由统一 offline CI 替代，保留。
- `task-093ap-tests.yml`：任务 08 已确认包含专项 20× contention stress，具有独立测试价值，保留；本单不修改。

没有其他 `093AA/AG/AH/AN/AO` workflow 残留。

## STATUS 更新与观察项

`STATUS.md` 已更新为：owner 于 2026-09-06 直接查看 settings 确认 branch protection 已开启，required status checks 实为且仅为 `offline-ci`；任务 08 的 legacy 迁移项从挂起改为已完成，并指向本报告。

另登记一个不在本单修复范围内的观察项：任务 12 将 `hybridScore` 在语义分缺失时的回退值改为 `-1`，因此无向量文档会排到已知负相似度之后。backfill 进行中或 embedding provider cooldown 时可能出现大批无向量文档；这一排序行为目前没有测试覆盖。

## 范围声明

本单没有部署、没有进入 VPS、没有调用真实 Letta / model / embedding provider，也没有触碰 production 记忆数据。
