# OpenCodeReview 评审与修复记录 v1.0（2026-11-05）

工具：`alibaba/open-code-review`（`ocr` v1.13.6，DeepSeek flash）。
范围：首次提交 `b2c832d`，OCR 选中 49 个文件（`server.js`、`public/app.js` 因 `too_large` 被排除）。
处理原则：高风险与确凿缺陷全部修复；纯风格/耦合类建议按“改动收益 > 风险”取舍，未采纳的在此说明。

## 已修复（高 / 中）

| 来源 | 问题 | 修复 |
|---|---|---|
| `lib/logic.js:203` | I-MR 只有 1 个点时 `MR̄` 为 NaN，污染控制限与判异 | 少于 2 点直接抛错 |
| `lib/deliverable-sync.js:333` | 配置字段映射会把**已批准**目标交付物静默降回草稿并清空批准人 | 非草稿目标一律 409，提示先发起修订 |
| `lib/control-sync.js:220` | PFMEA 特性只在 `project_char` 时，`ensureProjectChar` 抛错导致整批 CP 生成中止 | 先查 `char_master` 再决定是否建项目特性 |
| `lib/logic.js:709` | `cockpit` 里 `all`、`DT` 未使用；`trackable` 是无意义包装 | 删除；注意 `trackable` 实际还有两处引用，已一并改为 `progress.total` |
| `lib/db.js:587` | `seed()` 里 `rand` 声明后从未使用 | 删除 |
| `tools/strip-demo-actors.js` | 正则删除**所有** `user: '...'` 行，会改坏 `user: '管理员'` 这类真实请求体 | 改为按演示姓名白名单替换 |
| `tools/seed_relationship_validation_project.mjs` | 源码写死 `admin/admin123` | 改读 `QMS_USER` / `QMS_PASSWORD`，缺失即报错 |
| `tools/build_rmle_audit.mjs` | 写死本机绝对路径 | 改由 `ARTIFACT_TOOL_PATH` / `RMLE_AUDIT_INPUT` / `RMLE_AUDIT_OUTPUT` / `--source-root` 覆盖，默认相对仓库 |
| `tests/dialog-browser-e2e.js` | 写死 `admin123`；断言请求体含 `user`（服务端才补该字段，永远不成立）；fetch 桩不还原；重复注入守卫 | 改读 `QMS_E2E_PASSWORD`；只断言 `{reason}`；断言后还原 `fetch`；去掉重复注入 |
| `tests/quality-tools-browser-e2e.js` | 写死端口 8848 与 `admin123`；`target` 可能为 undefined | 端口取自 `BASE`；口令读环境变量；补 `未找到 QMS 浏览器页面` 明确报错 |
| `tests/security.js` | 复用系统黑名单口令；ZIP 断言 `/ZIP/` 三种失败都能匹配；启动失败静默继续 | 改独立口令；收窄为 `/条目过大|解压失败/` 与 `/不支持的 ZIP 压缩方式/`；断言服务已就绪 |
| `tests/smoke.js` | `auditorLogin.headers.get('set-cookie').split()` 无状态校验，失败时只抛 null-deref | 先断言 200 与 Cookie 存在 |
| `tests/ocr.js` | 逐词断言，缺词只报第一个；成功信息写死引擎名 | 一次报出全部缺词；去掉引擎名 |
| `tests/field-guide.js` | 断言一个 `P0-01` 里不存在的列（`联系方式`），永远通过 | 改为从 `DT.T['P0-01']` 取真实列断言 |
| `tests/spc-subgroup-ui.js` | `doesNotMatch(/id="spcBatch" value="LOT-\$\{Date\.now/)` 匹配的模板已不存在，永远通过 | 改为截取 `spcBatch` 片段再判断 |
| `tests/permissions.js` | `must_change_password` 判断用的是重置**前**的 `me`，强制改密分支是死代码；总工审批目标 P2-06 从未提交，只能 400；`notEqual(403)` 掩盖 401/500 | 改密后重新读 `/auth/me`；先由设计岗填写并提交 P2-06 再断言总工 200；修订断言改为 400 + 提示文案 |
| `tests/p2-ui-and-data.js` | 按标记切片时标记缺失会静默返回空串，报错指向错误位置 | 新增 `sliceBy()`，标记缺失直接点名 |
| `tests/attachment-api.js` | 只断言 `is_pdf === true`，缺负向分支 | 补 `PNG.is_pdf === false` |

## 未采纳（有记录）

- **`lib/db.js` 大量 `ensureColumn` 重复、`project_char` 两处插入逻辑重复**：属于结构性重构，改动面覆盖启动迁移路径，收益小于风险；已在交接记录里标注。
- **`lib/control-sync.js` 的 `cp_stage_link` / `deliverable_sync_item` 复用与 SOP 继承顺序**：需要完整业务确认（“研究中计划能否被覆盖”同类问题），不在本轮擅自改语义。
- **`tests/*` 与 `public/app.js` 的整文件正则耦合**（`quality-tool-export-ui.js`、`dialog-ui.js`、`spc-subgroup-ui.js` 剩余部分）：依赖 DOM 级 e2e，但两个 e2e 需要本机 Chrome 与登录口令，CI 上跑不了；先保留静态断言作为快速回归。
- **`lib/perm.js` 头注释与权限表不一致**：注释已描述“历史兼容角色可编辑全部内容”，实现是按权限点精确授权；以实现为准，后续统一注释。
- **`tools/rmle_audit_extract.py` 阶段 5 正则、重复读文件**：该脚本只用于一次性生成审计底稿，当前数据无毒；记录在案。

## 遗留（本次未做）

- `server.js`（约 1.1 万行）与 `public/app.js`（约 2.4 万行）超出 OCR 单文件上限，未被评审。要覆盖它们需要拆分文件或改用 `ocr scan --path` 配更大 `--max-tokens`。
- OCR 有 2 组文件因工具调用轮次上限未完成（`lib/control-sync.js` + `lib/deliverable-sync.js` 一组、6 个测试文件一组），结论不完整。

## 验证

`npm test` 全绿：smoke、linkage 168、P0 20/20、PFD 56、P1-2 34、MSA 判定与导出链、attachment 48、permissions 72、P1-3～6 47、p2-ui 92、p3 39、p3-2-5 90、security（160 并发 + 恶意 ZIP）。
