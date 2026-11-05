# APQP 交付物字段级关联关系表

版本：v1.3（2026-11-02，强关联候选与审批闭环修订）  
适用系统：电阻器质量系统（APQP / DFMEA / PFMEA / PFD / CP / SPC / MSA / PPAP）  
说明：本表对照系统全部68项目录和PPAP 18项，区分字段同步、候选、受控引用和待实现关系。字段级关系验收以§12为准，§2–7为阶段概览，§11为68项索引。字段实现依据为 `lib/deliverable-sync.js`、`lib/control-sync.js`、`lib/db.js`、`lib/logic.js` 及服务器接口；未经结构化的数据只记录来源，不声称已自动转换。

本次已确认的业务规则：上游批准后才作为正式来源；下游人工改动保留并提示冲突；已批准或待审核的下游只记录待复核差异，必须先退回草稿才能采用；MSA覆盖所有适用测量系统，不限于SPC项目。当前同步入口已接入服务器批准/发布、保存及相关模块API；`已实现`表示有后端路径和对应聚焦测试，不表示浏览器E2E、并发压力或真实项目全流程已验证。各关系的代码位置、验收标准和尚未覆盖边界在§12逐项列出。

## 1. 统一关系规则

| 对象链 | 主键规则 | 数据原则 |
|---|---|---|
| 项目与文档 | 当前文档：`project_id + doc_code`；批准记录：`project_doc_revision.rev_id` | 从最新已批准revision快照取数；正在编辑的来源草稿不污染已批准来源 |
| 特性 | `char_master.char_id -> project_char.pchar_id` | 项目特性是项目主数据；特殊特性只是来源之一，还可来自图纸/规范、PFMEA及人工识别；不得把普通特性排除 |
| 特性穿透 | `char_link.product_char_id <-> process_char_id` | 产品特性与过程特性通过显式关系关联，不用名称模糊匹配 |
| 工序 | `process_step.step_id` | `step_no` 是跨 PFD、PFMEA、CP、SOP 的显示编号，名称不能作为唯一键 |
| FMEA | `fmea_row.row_id` | `func_id`、`upstream_row_id`、`effect_ref` 分开表达，不能混用 |
| 控制与测量 | `cp_row.cp_row_id -> monitoring_item.mon_id -> spc_dataset.dataset_id` | 控制计划是监控定义的来源，SPC 保存实际数据 |
| MSA | `cp_row/project_char_id/gauge_id -> msa_plan_item.plan_id -> msa_study.study_id` | 研究默认引用计划，不重复录入特性和量具 |
| PPAP | `project_id + ppap_element.element_no` | PPAP读取上游证据；提交时冻结基线，不复制成另一套业务数据；证据就绪不等于顾客批准 |
| 表单行 | `data_json._syncRows[tableKey][index]` | 二维数组保持兼容，另存稳定行ID；保存/批准时为无ID行生成ID，重复ID的全部重复行换新ID，禁止按名称/行号猜测历史身份 |

同步策略含义：

- **自动新增**：上游批准后，明确字段映射创建下游草稿；不自动生成试验结果、FMEA功能或失效。
- **自动更新**：上游字段变化时，更新下游尚未人工覆盖的字段。
- **只读引用**：下游直接显示上游数据，不允许重复录入。
- **人工确认**：系统预填候选，责任人确认后才生效。
- **批准快照**：正式输出保存来源版本；已批准目标的差异待复核，后续变更按项目变更流程重审。
- **受控引用**：保留来源编号、批准版本、稳定行ID和上下游去向；不假装自然语言已转成结构化字段。

## 2. 阶段 0：项目启动

| 上游交付物 | 下游交付物/对象 | 关联信息 | 触发时机 | 同步策略 | 当前状态 |
|---|---|---|---|---|---|
| P0-01 跨职能小组 | 全部APQP任务、Gate、交付物 | owner、责任部门、评审/批准人和授权范围 | 小组批准 | 受控引用；不根据名单自动授权账号 | 项目已有角色权限；小组表未自动生成角色映射 |
| P0-02 项目范围 | 全部模块 | project_id、part_no、family_id、series_id及范围说明 | 范围批准 | 受控引用；项目实体提供隔离及产品范围 | 已有项目隔离；范围说明未自动分解全部对象 |
| P0-10 5T/进度计划 | `apqp_task`；P1-16仅里程碑约束 | 阶段、任务名称、结束日期→due、责任人、交付物；开始日期保留来源快照（当前任务表无对应字段） | 计划批准 | 自动新增/保护式更新任务；不生成质量成本交付目标 | 本轮引擎 `project-task` |
| P0-10 5T/进度计划 | 预警中心/驾驶舱 | 任务权重、计划日期、实际完成日期、偏差 | 任务状态更新 | 只读引用 | 待完善 |

## 3. 阶段 1：策划和定义项目

| 上游交付物 | 下游交付物/对象 | 关联信息 | 触发时机 | 同步策略 | 当前状态 |
|---|---|---|---|---|---|
| VOC、CSR、顾客输入 | P1-07 设计目标 | 客户要求、接受准则、优先级、来源；当前尚无统一req_id实体 | 输入批准 | 受控引用，人工完成要求转化 | 引用；未实现自然语言字段转换 |
| VOC、CSR、顾客输入 | P1-08 可靠性/质量目标 | 可靠性指标、寿命、试验项目、目标值、判定准则 | 输入批准 | 受控引用，人工确认目标 | 引用；未自动转换 |
| VOC、CSR、顾客输入 | P1-11 初始特殊特性识别 | 特性编号、名称、产品/过程类型、特殊符号、判定依据 | 输入批准 | 受控引用，人工识别 | 未实现VOC/CSR自动生成特性 |
| VOC、CSR、顾客输入 | P1-17 风险评估缓解计划 | 风险描述、影响、缓解措施、责任人、期限；当前尚无统一risk_id实体 | 输入批准 | 受控引用 | 引用；未自动识别风险 |
| 业务计划/标杆/产品设想 | P1-07/P1-08 | 市场目标、标杆指标、设计约束、可靠性目标 | 策划输入确认 | 只读引用 | 待完善 |
| P1-07 设计目标 | P2-06 工程图 | 目标编号、名义值、上下限、单位、设计依据 | 设计目标批准 | 自动候选+人工确认 | 待完善 |
| P1-07 设计目标 | P2-11 产品和过程特殊特性 | 特性目标、上下限、单位、特殊分类；普通目标不自动判特殊 | 设计目标批准 | 受控引用+人工判定 | 引用；未自动分类 |
| P1-08 可靠性/质量目标 | P2-03 DVP&R | tests的试验项目→dvp验证项目；判定准则→接受准则；条件及样本量→样本/方法说明；不复制结果 | 可靠性目标批准 | 待采用候选，采用后建草稿行 | 本轮引擎 `reliability-dvp` |
| P1-09 初始 BOM | P2-06 工程图 | 物料号、零件号、版本、层级、材料 | BOM 发布 | 只读引用 | 待完善 |
| P1-09 初始 BOM | DFMEA结构候选；P2-08材料规范/P3-02包装规范 | 零件号、名称、规格、数量、供应商、批准行ID；不从BOM推断材料判定准则或包装防护 | BOM批准 | DFMEA待采用结构候选；材料/包装仅受控引用 | 本轮引擎 `bom-dfmea`、`bom-reference:*` |
| P1-09 初始 BOM | P2-10设备/工装要求 | 零件与工艺适用范围，不能由BOM直接推出设备能力 | BOM批准 | 人工工艺评审 | 未自动推断 |
| P1-10 初始流程图 | P3-04 PFD 的 `process_step` | 工序号→step_no；名称→name；类型→step_type；关键设备→equipment；关键特性→output_desc说明文本；源表无输入字段 | P1-10批准 | 稳定行ID新增/保护式更新PFD草稿；重复ID整组换ID；同号历史工序不猜测绑定 | 字段同步已实现；旧行保存后再批准可建立新ID链接 |
| P1-11 初始特殊特性 | P2-11正式特殊特性候选 | 编号、名称、CC/SC分类、识别类型、识别主体、识别依据、来源条款和版本；规格及保证工序留空待确认 | P1-11批准 | 按稳定行ID产生待采用候选；采用后写入P2-11草稿，不直接建立项目特性 | 字段候选已实现；缺少编号/类型/识别主体时待确认 |
| P2-11正式特殊特性 | `char_master`、`project_char` | 编号、名称、显式类型、特殊符号/分类、来源、规格/公差、顾客/组织分类与认可依据 | P2-11有效批准revision | 批准后项目字段新增/保护式更新；分类冲突或字典不兼容时待确认 | 字段同步已实现；不能从自由文本猜上下限 |
| P1-11初始特殊特性识别 | P2-11正式特性候选 | 初始识别编号、名称、分类、类型、主体、依据和来源版本 | P1-11批准后形成P2-11候选；采用后由责任人补规格/保证工序 | 不直接建立项目特性；P2-11正式批准后才进入project_char | 字段候选已实现；DFMEA/PFMEA按项目特性对象人工关联 |
| P1-12 产品保证计划 | DVP&R；DFMEA/P4-05引用 | 验证方式→验证项目，接受准则→接受准则，责任人→责任；风险项保留来源证据，不伪装成设计特性 | 保证计划批准 | DVP待采用候选，其他受控引用 | 本轮引擎 `assurance-dvp` |
| P1-13 产能规划 | P2-10、P3-05、P4-01 | 节拍、班次、产能、瓶颈、设备/人员资源 | 产能策划批准 | 自动候选+人工确认 | 待完善 |
| P1-15变更管理规则 | P2-09/ECR流程 | 变更分级、批准权限、通知范围；与单次ECR/ECO记录分开 | 规则批准 | 受控引用；具体ECR提供变更号、对象、版本和影响分析 | 不将规则文本自动转成变更记录 |
| P1-16 APQP项目目标 | 阶段评审、驾驶舱 | 质量/成本/交付目标及测量方式 | 目标批准 | 受控引用；不自动生成未定义的KPI公式 | 自动KPI转换未实现 |
| P1-17 风险评估缓解计划 | DFMEA、DVP&R、PFMEA | `risk_id`、风险等级、缓解措施、验证责任、关闭状态 | 风险评审批准 | 自动候选+人工确认 | 待完善 |

## 4. 阶段 2：产品设计和开发

| 上游交付物 | 下游交付物/对象 | 关联信息 | 触发时机 | 同步策略 | 当前状态 |
|---|---|---|---|---|---|
| P2-01 DFMEA | P2-03 DVP&R | 保留fmea_row_id；设计特性/功能→验证对象候选，验证项目/方法/准则仍由设计确认；不凭S/O/D生成试验结论 | DFMEA发布快照 | 待采用验证候选 | 本轮引擎 `dfmea-dvp`，来源行ID保存在_syncMeta |
| P2-01 DFMEA | P2-11特殊特性 | 设计影响、严重度、特性编号和识别依据 | DFMEA特性确认 | 受控引用+人工判特殊；不能仅靠S/AP自动分类 | 未自动生成正式特殊特性清单 |
| P2-01 DFMEA | PFMEA | 设计功能、设计失效影响、特殊特性、上游row_id | DFMEA发布 | 受控引用；PFMEA选择upstream_row_id，不继承过程原因 | 已有手动上游行引用；未自动复制设计分析成过程分析 |
| P2-02 DFM/DFA | P2-04 设计评审、P3-04/P3-06 | 设计问题、评分、制造/装配约束、关闭措施 | 评审提交 | 人工确认 | 待完善 |
| P2-03 DVP&R | P4-05生产确认测试；PPAP10引用 | 验证项目→项目；样本/方法→条件说明；接受准则→要求；不把设计试验实测/判定复制成生产确认实测/判定 | DVP批准 | 测试要求同步到草稿；已有生产结果保留 | 本轮引擎 `dvp-production-test`；PPAP证据另核验 |
| P2-04 设计评审 | P2-09 变更、DFMEA、DVP&R、BOM | 问题编号、决定、措施、责任人、期限、关闭状态 | 评审结论保存 | 自动候选+人工确认 | 待完善 |
| P2-05原型样件CP表单 | PROTO阶段控制计划实体 | 原型工序、特性、控制方法、样本、频率、反应计划；表单行无稳定CP对象ID | 人工在PROTO控制计划维护；P2-05文档批准不触发阶段实体复制 | 受控引用，不按名称迁移历史行 | P2-05表单与PROTO实体的字段同步待实现；阶段实体之间继承见§12 |
| P2-06 工程图 | P2-11、P2-12、DFMEA、DVP&R、PPAP 要素 1 | 图纸编号、版本、特性编号、名义值、容差、材料、特殊符号 | 图纸批准 | 只读引用 | 待完善 |
| P2-07 工程规范 | DVP&R、PFMEA、CP、P4-05 | 规范编号/版本、要求、试验方法、接受准则 | 规范批准 | 只读引用 | 待完善 |
| P2-08材料规范 | P4-05/PFMEA/CP/PPAP10 | 材料编号、规格、版本、接受准则 | 材料规范批准 | 受控引用 | 未将材料规范表逐字段自动转换为试验/控制项 |
| P2-09图纸/规范变更 | DFMEA/PFD/PFMEA/CP/MSA/SPC/PPAP | ECR/ECO号、版本、影响对象、生效日期、批准人 | 具体变更批准 | 影响分析+人工确认 | 已有变更/基线工具；通用自然语言变更内容不自动改业务字段 |
| P2-10 设备/工装要求 | P3-04、P3-05、P3-07、P3-08 | 设备编号、能力、工装、配套条件、布局要求 | 设备要求批准 | 自动候选+人工确认 | 待完善 |
| P2-11产品和过程特殊特性 | 项目特性→DFMEA/PFD/PFMEA/CP/SPC/MSA | char_id/project_char_id、类型、符号、规格文字及来源；目标/上下限只有显式字段时才可同步 | 特性批准 | 项目特性保护式更新，下游共享引用 | 本轮引擎；不从公差文本猜数值上下限 |
| P2-12量具和测试设备要求 | gauge、CP、MSA计划 | 量具要求、量程、分辨率、精度、数量；需求不等于已存在设备资产编号 | 需求批准/资产验收 | 受控引用，人工绑定实际gauge_id | 未自动建立已校准检具，不把“设备要求”当“校准合格” |
| P2-13团队可行性承诺 | Gate2、后续过程开发 | 可行性约束、资源、签署人与日期 | 承诺批准 | 批准证据引用 | Gate有状态核对；未自动代替团队签署 |

## 5. 阶段 3：过程设计和开发

| 上游交付物 | 下游交付物/对象 | 关联信息 | 触发时机 | 同步策略 | 当前状态 |
|---|---|---|---|---|---|
| P3-02包装规范 | P4-06包装评价 | 层级→评价项；材料/数量/标识/防护→要求；评价方法与实测结果由验证人员填写 | 包装规范批准 | 草稿要求新增/保护式更新 | 本轮引擎 `packaging-evaluation`；不映射PPAP13 AAR |
| P3-03 质量体系评审 | Gate 3、P3-06、P3-06b、P4-08 | 差距项、措施、责任人、期限、关闭状态 | 体系评审提交 | 人工确认 | 待完善 |
| P3-04 PFD | P3-07 SOP；PFMEA/CP/布局引用 | 工序号→步骤，工序名称→操作内容，输出描述→关键参数提示，保留step_id；具体作业动作、安全及设备参数不推断 | 工序发布版本快照 | SOP草稿行新增/保护式更新；PFMEA由专用稳定工序同步实现 | 本轮引擎 `pfd-sop`；不复制运行结果 |
| P3-05 平面布置图 | PFD、PFMEA、CP、P4-01 | 区域、物流方向、设备、隔离要求 | 布局批准 | 只读引用 | 待完善 |
| P3-06 PFMEA | P3-06b/P4-07 CP、PPAP6 | 稳定step_id、全部来源`fmea_row_id`、产品/过程项目特性、规范、PC/DC；AP不自动转特殊特性 | PFMEA发布后/CP专用生成 | CP草稿按稳定键映射，保存全部来源行；人工覆盖冲突需确认，批准CP不改写 | 本轮PFD→PFMEA、PFMEA→CP增量和冲突保护已实现 |
| P3-06b试生产CP | MSA计划实体、P3-09能力计划、P4-01运行、P4-07量产CP | 工序/项目特性/检具/方法/样本/频率/反应；测量系统不限于SPC；结果不从计划生成 | 控制行批准后自动建MSA计划；PILOT批准后阶段继承 | 试生产CP为MSA计划来源，`source_key`区分工序/特性/量具/方法/版本；量产CP继承为草稿 | MSA计划和阶段CP继承已实现；P3-09计划文档及运行结果仍分别维护 |
| P3-07 SOP/过程说明书 | CP、PFMEA、P4-01 | `step_id`、`step_no`、作业步骤、参数、安全、目视标准 | SOP 编制/批准 | 自动预填+人工确认 | 待完善 |
| MSA计划实体→P3-08派生视图 | P3-08文档 | plan_id对应特性、检具编号/名称、研究类型、GRR设计（属性研究明确显示“按适用方法”）、日期、责任、状态；不改签署及其他字段 | 计划实体维护后 | 草稿派生列表同步；批准文档只记复核差异 | 本轮引擎 `syncMsaPlanDocument` |
| MSA计划实体 | P4-02 MSA、PPAP8 | plan_id、项目特性、检具、研究类型、研究设计、日期和责任；研究只补原始数据并确认结果 | 从计划启动研究 | 强引用；完成后回写计划状态 | 专用MSA接口；覆盖所有适用测量系统，不能仅GRR/SPC |
| P3-09能力研究计划 | SPC、PPAP11 | 项目特性、样本、子组、频率、图表类型、能力目标及准则 | 计划批准 | 计划约束引用；原始数据来自真实生产 | 监控实体已有参数；P3-09文档尚未反向成为监控主数据 |

## 6. 阶段 4：产品和过程确认

| 上游交付物 | 下游交付物/对象 | 关联信息 | 触发时机 | 同步策略 | 当前状态 |
|---|---|---|---|---|---|
| P4-01有效生产运行 | SPC、PPAP样品/尺寸结果 | 批次、设备、班次、产量、良率、缺陷、节拍、样品来源 | 运行记录批准 | 受控引用；不从产量表伪造测量原始数据 | PPAP已有来源入口；逐样品/数据集批次绑定待实现 |
| P4-02 MSA研究 | MSA计划状态、CP/SPC测量资格、PPAP8 | plan_id/study_id、项目特性、检具、研究结果、适用性、完成时间；结果按完整测量系统关系读取 | 研究保存/确认 | 回写计划状态；CP/SPC读取资格；PPAP取证 | 不回写PSW，不以计划“存在”代替研究合格 |
| P4-03 SPC能力研究 | CP监控、PPAP11、改进活动 | mon_id、项目特性、原始数据集、控制图、能力值、异常点 | 导入真实数据并计算 | 读取计算结果+人工确认处置 | 已有SPC计算/取证；“有数据”不等于能力达标或顾客接受 |
| P4-05生产确认测试 | PPAP9尺寸/PPAP10材料性能；实验室及AAR需独立证据 | 测试项目、要求、生产实测、判定、报告编号；实验室资质范围与顾客外观批准不能由测试表状态推定 | 结果批准 | 批准结果取证 | PPAP12/13需额外文件，不等于一张测试表 |
| P4-06包装评价 | P4-08策划签发、P4-09量产准备 | 包装规范版本、运输条件、评价结果、判定；必要时作为顾客特殊要求证据 | 包装评价批准 | 受控引用 | 明确不等于PPAP13外观批准AAR |
| P4-07生产CP | SPC、PPAP7、持续改进 | SOP阶段CP版本、批准/生效状态、工序/特性及反应计划 | PILOT批准后创建/更新草稿；人工审核批准SOP | 稳定cp_stage_link阶段继承；不复制上游批准签署；冲突待复核 | 本轮PROTO→PILOT→SOP阶段继承已实现 |
| P4-08 质量策划签发 | P4-04 PPAP/PSW | 签发人、Gate、遗留问题、批准日期 | 签发完成 | 批准快照 | 待完善 |
| P4-04 PPAP | 量产放行/经验反馈、基线 | 18项适用性、来源证据、提交等级、基线版本、哈希和顾客决定 | 取证/提交/打包 | 读上游+冻结快照，人工确认适用性及顾客批准 | 已有工作流与基线打包；不自动签PSW或伪造顾客批准 |

## 7. 阶段 5：反馈、评估和纠正措施

| 上游交付物/数据 | 下游对象 | 关联信息 | 触发时机 | 同步策略 | 当前状态 |
|---|---|---|---|---|---|
| SPC/MSA/CP 反应计划 | P5-01 减少变差 | 问题、指标、改善前后值、措施、验证结果 | 失控/不合格 | 自动生成问题候选+人工确认 | 待完善 |
| 顾客投诉/现场失效 | VOC/CSR、DFMEA、PFMEA、ECR | 投诉号、失效、根因、影响、纠正措施、证据 | 投诉关闭 | 自动候选+人工确认 | 待完善 |
| 交付和服务数据 | P5-03 服务与交付 | 准时率、交付偏差、服务指标、问题单 | 月度/阶段复盘 | 只读引用 | 待完善 |
| P5-04 经验教训 | 新项目、产品族/系列、特性字典、工序字典 | 经验、适用产品族、适用工序、复用范围、来源项目 | 经验批准入库 | 人工确认后复用 | 待完善 |

## 8. PPAP 证据入口与来源

| PPAP 要素 | 系统来源 | 应引用的关键信息 |
|---:|---|---|
| 1 设计记录 | P2-06、P2-08 | 图纸/规范编号、版本、零件范围、材料 |
| 2 工程变更文件 | P2-09、ECR | 变更号、旧/新版本、批准人、实施日期 |
| 3 顾客工程批准 | 客户批准记录 | 批准文件、偏差号、范围、有效期 |
| 4 DFMEA | P2-01 | 结构、功能、失效链、特殊特性、AP、措施 |
| 5 过程流程图 | P3-04 | 工序号、工序类型、设备、输入/输出、版本 |
| 6 PFMEA | P3-06 | 工序、功能、失效、原因、控制、AP、措施 |
| 7 控制计划 | P4-07 生产 CP | CP 版本、工序、特性、样本、频率、反应计划 |
| 8 MSA | P3-08/P4-02 | 计划、量具、特性、原始数据、%GRR、判定 |
| 9 尺寸结果 | P4-05 | 图纸特性、样本、测量值、判定 |
| 10 材料/性能试验 | P2-03/P2-08/P4-05 | 试验项目、规范、方法、样本、结果 |
| 11 初始过程能力 | P3-09/P4-03 | 监控项、数据集、Cpk/Ppk、判异、反应 |
| 12 合格实验室文件 | 独立实验室资质/范围附件；P4-05关联试验报告 | 内外部实验室适用范围、认可/顾客接受证据、方法及报告；测试合格不能替代实验室资格 |
| 13 外观批准 | 独立外观件清单、AAR和顾客批准附件 | 颜色/纹理/光泽等外观要求及批准；包装评价不作为AAR |
| 14 生产件样品 | P4-01 | 正式工装、批次、节拍、样品来源 |
| 15 标准样品 | 样品台账 | 样品编号、封样批准、保存条件、有效期 |
| 16 检查辅具 | 适用的checking aids清单/批准图纸；gauge作为关联资产 | PPAP适用检查辅具及其设计/尺寸证明、维护校准和MSA关系；不把全厂量具台账整体当作此要素 |
| 17 顾客特殊要求 | VOC/CSR及顾客专项要求清单 | 逐项要求、适用性、落实位置、证据及顾客豁免；P1-11特殊特性仅覆盖其中一部分 |
| 18 PSW | P4-04、基线、批准记录 | 提交等级、适用性声明、批准人、日期、基线版本 |

## 9. 已识别风险和处理原则

1. 旧版`UNIQUE(project_id, project_char_id)`会合并多个工序/检具的计划。本轮数据层已改为项目内source_key：CP行、项目特性、检具、研究类型、来源版本、测量方法及规范快照共同区分，源变化形成新研究需要，已完成历史保留。
2. MSA结果按`project_id + project_char_id + gauge_id`及适用测量方法或plan_id查询，不能仅按项目和量具。数据层已有`latestMsaStudy`；各消费端必须使用精确匹配，不让相同检具的另一特性报告串用。
3. P1-10 批准同步 PFD 时，应保留 `step_no`，后续 PFMEA/CP/SOP 只通过 `step_id` 关联。
4. `project_char`是CP/SPC/MSA的统一项目特性主数据；P1-11/P2-11只是特殊特性来源，普通图纸/规范及PFMEA特性同样适用。新增字典定义必须保留项目适用范围与来源，不覆盖其他项目快照。
5. DFMEA→PFMEA 只继承设计影响、设计特性和上游引用；PFMEA 的过程原因、过程控制、工序字段不能写入 DFMEA。
6. PPAP 的来源关系只提供取证和状态，不复制另一套业务数据；打包前生成基线快照。
7. 草稿状态只能预填下游草稿；批准后的上游变更应通过 ECR 产生影响清单，由责任人确认是否重审。

## 10. 本轮字段同步实现清单

实现文件：`lib/deliverable-sync.js`、`lib/control-sync.js`、`lib/db.js`。自动新增/更新均写入草稿，不将“字段同步完成”当作下游审核批准。服务端触发路径已接入；列为“已实现”仍只表示代码/聚焦测试，不等于浏览器E2E。

| 规则ID | 正式来源 | 目标字段 | 适用边界与需补录内容 |
|---|---|---|---|
| initial-flow | P1-10批准revision的steps稳定行 | process_step.step_no/name/step_type/equipment/output_desc | output_desc仅关键特性说明；输入、工装、工步、结构化特性不推断。历史同号工序只提示确认，不按编号/名称自动绑定 |
| initial-special-characteristic | P1-11批准revision的chars稳定行 | P2-11候选编号/名称/分类/识别来源/类型/顾客或组织分类；规格与保证工序留空 | 唯一行ID、编号/名称、显式类型及识别主体有效才生成可采用候选；否则待确认 |
| special-characteristic | P2-11正式批准revision的chars稳定行 | 项目特性char_id/name/char_kind/is_special/special_symbol/source_type/source_ref/tol_text/分类依据 | 正式特性表批准后建立/更新项目特性；字典冲突或族系列不兼容时待确认；不从自由文本推导范围值 |
| reliability-dvp | P1-08.tests | P2-03.dvp验证项目、接受准则、条件/样本说明候选 | 用户采用后建立草稿行；责任、日期、设计对象需确认；不生成结果/判定 |
| assurance-dvp | P1-12.plan | P2-03.dvp验证项目、接受准则、责任候选 | 风险保留原批准证据；不把风险标题当设计特性 |
| bom-dfmea | P1-09.bom | DFMEA STRUCTURE名称/说明候选 | 用户采用后建立结构，不推断父子层级，不生成功能/失效；已发布DFMEA不能直接采用 |
| bom-reference:* | P1-09.bom | P2-08/P3-02的受控来源引用 | 不自动判断材料标准、防护方法、包装层级或试验条件 |
| bom-drawing-reference | P1-09.bom | P2-06图纸清单关联料号/层级/材料来源 | BOM不生成图纸尺寸或版本；图纸仍由设计批准 |
| dvp-production-test | P2-03.dvp | P4-05.tests项目、条件说明、要求 | 生产实测、判定、报告编号始终由真实结果补录，不复制设计验证结果 |
| packaging-evaluation | P3-02.pack | P4-06.items评价项、要求 | 评价方法、结果和判定人工补录；不是AAR |
| project-task | P0-10.plan | apqp_task.phase/name/due/owner/deliverable | 阶段须显式0–5；开始日期保留来源证据，当前任务实体无该字段；不从计划生成项目Q/C/D目标 |
| pfd-sop | 已发布process_step版本快照 | P3-07.steps步骤号、操作名称、输出提示 | 使用step_id稳定关联；真正的作业方法、安全、设定参数仍需工艺编制，不把输出说明当已验证参数 |
| dfmea-dvp | 已发布DFMEA版本快照 | P2-03.dvp设计对象候选及来源row_id | 设计人员确认验证项目、方法和接受准则；不生成试验结论 |
| p1-08-confirmation | P1-08目标/DVP → P4-05生产确认 | 仅由批准DVP要求继续引用到生产确认；不复制DVP实测 | 生产批次和报告确认后录结果；属于要求引用+实测隔离 |
| dfm-pfd-fmea | P2-02 DFM/DFA → P3-04/P3-06 | 制造/装配约束和问题需人工绑定工序/失效分析 | 不按自由文本自动创建PFMEA失效或工序 |
| pfd-pfmea | 已发布process_step及PFD版本 | PFMEA STRUCTURE节点step_id来源映射、节点名称/描述/父子层级 | 按稳定step_id增量更新，不替换已有分析；旧节点无法映射时提示，不按名称猜测 |
| pfmea-cp | 已发布PFMEA行+同项目process_step/project_char | CP行step_id、特性、规格、预防/探测控制、fmea_row_id及多行关联表 | 按工序和特性生成/更新草稿；保留CP行人工override；已批准CP只提示差异 |
| pfd-cp-basic | 已发布PFD工序 | PILOT CP基础工序行step_id及上游版本 | 仅为无PFMEA特性覆盖的工序建立基础控制行；SOP不自动添加缺失的新工序 |
| cp-stage | PROTO→PILOT、PILOT→SOP已批准CP快照 | cp_row关联字段及cp_stage_link稳定映射 | 仅批准/冻结源计划参与；目标有冲突或批准保护则待复核，不复制签署批准 |
| cp-measurement-msa | 适用阶段CP测量行、项目特性和检具 | msa_plan_item按source_key保存CP行/特性/检具/研究类型/规范/版本 | CP保存/同步时确保计划；源变化形成新研究需求，已完成研究保留 |
| msa-plan-view | MSA计划实体派生快照 | P3-08.data.plan | 不改签署及其他字段；批准目标仅待复核。P3-08不是另一套可独立反向覆盖实体的主数据 |
| msa-study | msa_plan_item | msa_study.plan_id/project_char_id/gauge_id/raw_json/result/judgment；完成时回写计划状态 | 研究保存须与计划的项目特性及检具匹配；只提交原始数据和确认结果 |
| spc-data | CP监控项/检具/项目特性→monitoring_item/spc_dataset | 控制定义与真实测量dataset分开；CP/monitor为监控配置源，测量导入为实际数据源 | 监控批准后导入符合样本结构的数据；不得将控制计划生成测量结果 |
| project-reference:* | 项目实体主数据 | 全部表单的项目ID/名称、零件号、顾客、产品族/系列、责任人引用 | 只读引用，GET可预填显示；不覆盖表单人工字段与签署，不把项目责任人代作批准人 |
| catalog-reference:* / module-reference:* | 已批准文档/发布模块 | 上下游编号、批准版本、来源对象及稳定行ID | 记录引用证据，不改写业务字段，也不自动批准相关文件 |

状态修正：P2-05文档表单未自动迁移到PROTO实体，不能称其字段同步已实现；已实现的是独立control_plan的阶段继承。PFD→PFMEA、PFMEA→CP、PFD→CP基础行、PROTO→PILOT→SOP继承及MSA计划按测量系统生成的代码与测试分别列在§12，不代表浏览器E2E。

测试依据：`node tests/deliverable-sync.js`、`node tests/control-sync.js`、`node tests/msa-plan-unit.js`均使用独立临时库。以上聚焦测试覆盖各自模块，不是浏览器E2E、并发压力或生产数据验收。`tests/deliverable-sync.js`覆盖批准快照、幂等、行重排、人工覆盖、批准目标保护、来源删除不级联、候选采用、显式类型、MSA视图和只读列表；`tests/control-sync.js`覆盖PFD→PFMEA、PFMEA→CP和阶段CP继承；`tests/msa-plan-unit.js`覆盖非SPC/多测量系统计划及来源变更。

## 11. 全部68项目录逐项核对

这里的“引用”均表示真实来源与版本可追溯，不表示该文件里的自然语言已自动转换为所有下游字段。活动/管理批准不能由数据同步代签。索引中没有对应§12专用字段映射规则的目录边，均只用于评审/证据导航（状态为受控引用或仅关系展示）；CATALOG箭头本身不是数据同步，不能据此宣称字段已经推送。

| 编号 | 交付物/活动 | 主要上游 | 主要下游 | 应复用的信息及当前边界 |
|---|---|---|---|---|
| P0-01 | 跨职能小组 | 项目立项/组织 | P0-10、P2-13、P4-08 | 角色、责任、授权；人员名单引用，不自动创建账号权限 |
| P0-02 | 项目范围 | 顾客及业务输入 | P1-07/09/10、DFMEA | 零件/版本/产品族范围、排除项；不能仅靠名称推断 |
| P0-05 | 供应商来源与风险评估（系统补充） | 采购/顾客指定/历史质量 | P1-09、P2-10、手册A-9（系统A-10） | 高风险因素、适用性、措施与APQP要求传递；不替代供应商现场审核 |
| P0-10 | 进度计划5T | 项目范围、团队 | apqp_task、P1-16里程碑、Gate | 任务结束日期和责任字段同步；目标值和Gate决定不自动生成 |
| P1-I-01 | VOC | 客诉/顾客沟通 | P1-07/08/11/17 | 要求、期望、失效反馈；受控引用与人工转化 |
| P1-I-02 | 业务/营销计划 | 市场/顾客需求 | P1-13、P1-16 | 数量、成本、交付窗口；不能自动形成设备能力结论 |
| P1-I-03 | 标杆数据 | 行业/相似项目 | P1-07/08/17 | 对标指标、适用条件、差距；保留来源 |
| P1-I-04 | 产品/过程设想 | 产品概念及边界 | P1-09/10、P2-02 | 初步结构/路线设想；设计确认后形成结构数据 |
| P1-I-05 | 产品可靠性研究 | 历史可靠性/现场数据 | P1-08/17、DFMEA | 历史失效、寿命、适用条件；不直接复制评分 |
| P1-I-06 | 顾客输入/CSR | 顾客图纸、规范和合同 | P1-07/11、P2-06/07、PPAP17 | 版本、要求和豁免；受控引用，不只特殊特性 |
| P1-07 | 设计目标 | VOC/CSR/标杆 | 图纸、工程规范、DFMEA、DVP、P2-11 | 可测量目标和来源；普通目标不得自动标为特殊 |
| P1-08 | 可靠性和质量目标 | 可靠性研究/顾客 | DVP | 试验项目、条件、样本、准则生成DVP候选 |
| P1-09 | 初始BOM | 概念/顾客设计记录 | DFMEA、材料规范、包装、采购 | 物料结构候选；材料/包装仅引用，不推断要求 |
| P1-10 | 初始流程图 | 过程设想/产能需求 | PFD、DFM/DFA | 工序字段同步PFD草稿；统一工序号与稳定源行 |
| P1-11 | 初始特殊特性识别 | VOC/CSR/经验风险 | P2-11、DFMEA、PFMEA、CP | 识别依据、显式类型与特殊符号进入项目特性 |
| P1-12 | 产品保证计划 | 可靠性/高风险/顾客 | DFMEA、DVP、生产确认 | 验证方式/准则/责任生成候选；不生成验证结果 |
| P1-13 | 产能规划 | 数量需求/初始路线 | 设备工装、布局、运行、爬坡 | 节拍/班次/瓶颈/资源；受控引用、实际能力需验证 |
| P1-14 | 领导支持 | 项目目标/资源需求 | 团队承诺/后续Gate | 资源及授权批准证据；不得系统代签 |
| P1-15 | 变更管理规则 | 顾客/组织规则 | 变更流程、A-09 | 审批权限、分类、通知规则；与具体ECR分开 |
| P1-16 | APQP项目指标 | 所有阶段关键要素与项目特色指标 | 阶段评审、策划签发 | 实时红黄绿准备度汇总；批准时冻结指标快照，原有目标基线保留 |
| P1-17 | 风险缓解计划 | A-01、VOC、可靠性/业务 | DFMEA、DVP、PFMEA | 项目风险、措施、责任及关闭证据；不自动等同FMEA失效 |
| P2-01 | DFMEA | 产品结构、要求、初始特性 | DVP、正式特性、PFMEA、设计评审 | DVP验证对象候选；PFMEA保留上游行引用，过程原因不继承 |
| P2-02 | DFM/DFA/可服务性 | 初始路线/BOM/设计 | 设计评审、PFD、PFMEA | 制造装配约束及问题措施；人工工程判断 |
| P2-03 | DVP&R | 可靠性/保证计划/DFMEA/规范 | 生产确认、PPAP10、设计评审 | 候选计划和真实结果分开；向生产确认只传要求 |
| P2-04 | 设计评审 | DFMEA、DVP、图纸/规范 | 设计变更、团队承诺 | 结论/问题/措施/期限；签署和关闭需责任人 |
| P2-05 | 原型样件CP | 初始特殊特性/样件过程 | PROTO控制计划实体、试生产CP、PFMEA经验 | 已定位到PROTO阶段控制计划；旧表单数据无稳定ID不猜测迁移 |
| P2-06 | 工程图 | 设计目标/DFMEA/顾客 | 特性、量具要求、DVP、全尺寸、PPAP1 | 图号/版次、设计要求；图纸附件不会自动完整解析成测量项 |
| P2-07 | 工程规范 | 目标/图纸/顾客 | DVP、PFMEA/CP、确认测试 | 方法/准则/规范版本；自然语言只引用 |
| P2-08 | 材料规范 | BOM/图纸/顾客 | 材料试验、PFMEA/CP、采购 | 材料标准和准则；BOM引用不等于试验合格 |
| P2-09 | 图纸和规范变更 | 具体ECR/ECO/设计评审 | 全部受影响设计/过程对象 | 旧新版本、影响及实施；保护人工/批准对象，复核后重审 |
| P2-10 | 设备工装设施要求 | 产能/设计/过程方案 | PFD、布局、SOP、A-04 | 能力、数量和到位要求；需求不是已验收设备 |
| P2-11 | 正式特殊特性 | 初始识别、图纸、DFMEA | 项目特性及全部相关过程控制 | 显式类型、符号、规格；优先正式批准源，保留初始识别证据 |
| P2-12 | 量具测试设备要求 | 图纸/规范/特性 | 实际检具资产、CP、MSA、A-04 | 量程/分辨力/精度需求；人工绑定实际资产与校准 |
| P2-13 | 团队可行性承诺 | 设计评审及A-02/03/04 | Gate2、过程开发、策划签发 | 可行性、约束、资源和签署；不代替批准 |
| P3-02 | 包装标准规范 | 顾客/BOM/运输防护要求 | 包装评价、采购/量产准备 | 评价项和要求同步；包装不是外观批准 |
| P3-03 | 质量体系评审 | 体系/过程设计及A-05 | Gate3、策划签发 | 差距和关闭证据；不自动将“有文件”判合规 |
| P3-04 | PFD | 初始流程/设备/布局/过程特性 | PFMEA、CP、SOP、A-07 | 发布工序快照；SOP提示字段同步，细节人工编制 |
| P3-05 | 布局 | 设备/路线/隔离要求 | PFD、PFMEA、运行、A-06 | 区域及物流约束；图形坐标及环境控制不猜测 |
| P3-06 | PFMEA | PFD、设计影响、过程特性 | CP、PPAP6、A-08 | 特性/预防探测控制映射；AP不是特殊特性自动判定 |
| P3-06b | 试生产CP | PFD/PFMEA/特性/规范 | MSA计划、能力计划、运行、量产CP | 控制定义复用；计划不能生成生产结果 |
| P3-07 | 作业指导书 | PFD、CP、设备/规范 | 生产运行/培训/爬坡 | 工序号和输出提示复用；作业动作、安全需工艺编制 |
| P3-08 | MSA计划文档 | MSA计划实体/实际CP测量系统 | MSA研究、PPAP8 | 派生文档；实体是主数据，批准文档不被后台覆盖 |
| P3-09 | 初始能力研究计划 | CP/特性/顾客目标 | SPC/PPAP11 | 样本、子组、频率、目标；当前文档与monitoring实体需明确对象引用 |
| P3-10 | 领导支持 | 过程开发资源缺口 | Gate3/4、爬坡 | 资源及批准证据，不自动代签 |
| P4-01 | 有效生产运行 | 试生产CP/设备/人员/物料 | SPC数据批次、确认测试、生产样品 | 正式条件、批次、产出；不能伪造尺寸/能力数据 |
| P4-02 | MSA | 计划+测量系统+原始数据 | 计划关闭、CP/SPC资格、PPAP8 | 完整适用系统匹配，不只检具/不只SPC；研究完成须判定确认 |
| P4-03 | 初始能力研究 | 能力计划+有效运行+MSA | PPAP11、减少变差 | 原始数据、图表和Cpk/Ppk；存在数据不代表稳定/合格 |
| P4-04 | PPAP | 18项适用证据 | 顾客决定、基线、量产准备 | 统一取证/冻结；不伪造顾客批准或签PSW |
| P4-05 | 生产确认测试 | DVP要求、图纸、材料规范、生产批次 | PPAP9/10、策划签发 | 要求自动复用；生产实测独立，实验室资格/AAR需另附 |
| P4-06 | 包装评价 | 包装规范/真实运输评价 | 策划签发、量产准备、适用CSR | 真实结果与判定；不映射AAR |
| P4-07 | 生产CP | 试生产验证/更新后的PFMEA | SPC、PPAP7、爬坡、A-11 | 阶段草稿继承、人工差异和量产生效批准分开 |
| P4-08 | 策划签发及领导支持 | Gate结果/试生产/验证/包装/遗留项 | 量产准备/客户沟通 | 总结及领导签署；不等于客户PPAP批准 |
| P4-09 | 量产爬坡准备 | 已生效CP/MSA/产能/资源/PPAP决定 | 量产反馈 | 资源到位及放行条件；不可仅凭文档数量判就绪 |
| P5-01 | 减少变差 | SPC/MSA/CP异常 | PFMEA/CP改进、经验 | 指标与改善证据；仅形成候选问题，不自动改评分 |
| P5-02 | 顾客满意 | 投诉/现场/顾客评分 | VOC、DFMEA、PFMEA、经验 | 实际失效及纠正闭环；下一项目需确认适用性 |
| P5-03 | 服务与交付 | 交付/服务实际数据 | 业务输入/产能/经验 | 准交率/响应/问题；不从计划推断实际业绩 |
| P5-04 | 经验教训 | 风险、投诉、量产改进 | 新项目标杆/可靠性/风险输入 | 适用产品族/工序/条件；经批准复用，不覆盖新项目快照 |
| A-01 | APQP风险因素检查 | 项目/顾客/供方/资源 | P1-17、Gate0/1 | 检查证据、风险和措施；不自动写FMEA失效 |
| A-02 | DFMEA检查 | 已发布DFMEA及措施 | 设计评审、Gate2 | 覆盖/证据/遗留项；形式完整不等于风险已接受 |
| A-03 | 设计信息检查 | 图纸/工程材料规范/特性 | 设计评审、Gate2 | 版本、完整性、差距；不复制设计数据 |
| A-04 | 设备工装测试设备检查 | 设备/量具要求和验收 | 团队承诺/爬坡 | 需求、验收、能力证据；未到位不能靠勾选变合格 |
| A-05 | 产品过程质量检查 | 体系/PFMEA/CP/能力准备 | 体系评审、Gate3/4 | 问题、责任和闭环，人工结论 |
| A-06 | 布局检查 | 布局及物流/隔离要求 | 布局修订、Gate3 | 布局版本和检查发现；只引用 |
| A-07 | 过程流程图检查 | 发布PFD | PFD修订、Gate3 | 工序/返工/检验覆盖；不删除未通过工序 |
| A-08 | PFMEA检查 | 发布PFMEA | PFMEA修订、Gate3 | 功能失效控制覆盖、措施证据；不自动造功能/原因 |
| A-09 | 变更管理检查 | 变更规则+实际ECR/ECO | 变更整改/评审 | 权限、通知、影响及实施证据；规则与记录分开 |
| A-10 | 采购检查 | BOM/材料/包装/供应商证据 | 采购与过程准备 | 供方、外购件要求和状态；系统暂无完整供应商APQP实体时仅引用 |
| A-11 | 控制计划检查 | PFD/PFMEA/各阶段CP | 生产CP/策划签发 | 工序、特性、控制及反应一致性；不代签CP |

## 12. 规范化字段级关系验收台账

本台账为系统关系的规范化验收清单。每一行是一个单向关系；无直接字段同步的关系明确记“无自动字段映射”。状态只使用：`已实现`、`部分实现`、`仅关系展示`、`待实现`、`受控引用`。`已实现`表示有后端路径，必要时有聚焦自动化测试，不代表浏览器E2E、并发压力或客户现场全流程验证。§2–7为阶段概览，§11为68项目录索引；发生描述不一致时以本台账的代码依据及状态为准。

### 项目、阶段与设计开发关系

| 关系ID | 上游/下游交付物（稳定对象） | 关联字段与数据主来源 | 引用条件 | 同步时机 | 人工覆盖/批准保护 | 版本要求 | 实现状态 | 代码依据 | 待补功能 | 验收标准 |
|---|---|---|---|---|---|---|---|---|---|---|
| R00-TEAM | P0-01→APQP任务/Gate；成员→任务owner | 成员ID/角色由账号成员主数据维护；project_id隔离 | 同项目、账号启用 | 成员/任务分配 | 文档名单不自动授予账号权限或代签 | 成员启用时间、项目范围 | 受控引用 | server.js认证及项目路由；无成员同步函数 | 成员对象与任务责任角色映射 | 名单变化不改变账号角色；任务责任可识别来源 |
| R00-SCOPE | P0-02→APQP模块/项目对象 | part_no/family_id/series_id主来源project；范围明细为立项说明 | project_id有效、产品族系列适用 | 项目建档/范围评审 | 范围外对象需人工批准 | project_id/范围版本 | 受控引用 | db.js `project`；server.js `projectCharacterRows` | 项目范围对象化和范围版本 | 项目隔离；范围外对象不静默导入 |
| R010-TASK | P0-10.plan稳定行→apqp_task.task_id | phase/name/due/owner/deliverable；批准revision为源 | P0-10已批准、唯一_syncRows、phase 0..5 | 批准或sync API | 目标相对last有人工修改则冲突；批准目标待复核 | source revision/row ID、task_id | 已实现 | deliverable-sync.js `project-task`；server.js `syncProjectDeliverables`、docs approve | 开始日期在apqp_task无对应字段；UI/E2E | 批准行幂等建任务，结束日责任准确；无ID不匹配；不伪造Gate |
| R010-GATE | P0-10/P1-16→Gate/驾驶舱 | 计划/目标分别以各自表单为源，gate_review为评审源 | 同项目、阶段门适用 | 评审时引用 | Gate结论不从计划日期/文件数自动得出 | 计划revision和Gate记录版次 | 待实现 | logic.js `dashboard/alerts`；server.js gate routes；无计划偏差桥 | 计划偏差和Gate检查证据关系 | 任务逾期可追计划；不能自动判Gate通过 |
| R1-INPUT-GOAL | P1-I-01..06→P1-07/08/13/16 | 顾客要求、市场/可靠性指标及来源版本；当前无统一req实体 | 顾客/业务输入经责任团队确认适用 | 策划批准 | 目标值、优先级人工确认 | 输入文件编号/CSR版本 | 受控引用 | doctpl.js `CATALOG/T`；无VOC同步函数 | requirement对象和逐条目标链接 | 每目标可追来源条款；不从自由文本猜数值 |
| R1-INPUT-CHAR | 顾客输入/CSR→P1-11.chars | 要求编号/版本/适用范围/初始依据；P1-11识别行是结构化输入 | 顾客要求经责任团队确认适用 | P1-11编制/评审 | 不由自由文本自动生成特殊属性或项目特性 | CSR/顾客输入版本及P1-11 revision | 受控引用 | doctpl.js P1-11/P1-I-06；无要求对象抽取 | CSR条款对象桥接 | P1-11能追输入编号/版本；特殊分类由人判断 |
| R1-08-DVP | P1-08.tests→P2-03.dvp | 试验项→验证项目，准则→接受准则，条件样本→方法；P1-08是源 | 批准且row ID唯一 | 批准后生成候选 | adopt才建草稿；不复制结果/判定 | source revision/row ID | 已实现 | deliverable-sync.js `reliability-dvp`；server.js docs approve/link resolve | 浏览器E2E、重复候选人工去重 | 候选出现；采用后草稿；结果空；重复同步不重复 |
| R1-12-DVP | P1-12.plan→P2-03.dvp | 验证方式/准则/责任候选；P1-12为主来源 | 批准且稳定行ID | 批准后候选 | 风险项不当作设计特性；目标人员确认 | revision/row ID | 已实现 | deliverable-sync.js `assurance-dvp` | UI采用及候选重复检查 | 能追来源行；不填结果、评分 |
| R1-09-DFMEA | P1-09.bom→DFMEA STRUCTURE候选 | 物料号/名称/规格/用量→候选说明；不推断父子结构 | BOM批准；DFMEA草稿；stable row ID | 批准后生成待采用项 | adopt确认结构；已发布DFMEA保护 | BOM revision/row ID/FMEA ID | 已实现 | deliverable-sync.js `bom-dfmea`；server.js docs approve/link resolve | 多层BOM parent映射UI/E2E | 未采用不建节点；采用不生成功能/失效 |
| R1-09-DRAW | P1-09.bom→P2-06图纸清单 | 料号、名称、层级、材料作为图纸范围引用；图纸号/版本由设计记录主数据维护 | 同项目、零件范围一致 | 图纸编制/评审时引用 | BOM不生成图号、图纸尺寸或批准版本 | BOM revision/row ID与drawing revision分开 | 受控引用 | doctpl.js P1-09/P2-06；无BOM到图纸字段同步 | BOM line ID到drawing part scope | 图纸能定位BOM料号/层级；无料号推断不生成图纸 |
| R1-09-REF | P1-09.bom→P2-08/P3-02 | 料号/规格/供应商只作来源引用；材料/包装要求各自为主 | 同项目零件适用 | BOM批准 | 只读引用，不覆盖目标字段 | BOM revision/row ID | 受控引用 | deliverable-sync.js `bom-reference:*` | material/packaging对象ID | 可回查BOM来源；不猜材料判据/防护层级 |
| R1-10-PFD | P1-10.steps稳定行→P3-04 `process_step.step_id` | step_no/name/type/equipment/output_desc←关键特性文本；输入/工装/工步结构不推断 | P1-10批准revision、行ID唯一；同号已有工序待确认 | 文档批准/同步API | 人工修改冲突；已发布目标待复核 | revision/row ID/process_step.ver | 已实现 | deliverable-sync.js `initial-flow`；server.js `/api/docs/:code/approve`、`normalizeDocumentRows` | 真实桌面浏览器批准E2E | 保存/批准缺ID时生成稳定ID；重复ID整组换新ID；精确字段同步、幂等、不覆盖已发布step |
| R1-11-CANDIDATE | P1-11.chars稳定行→P2-11.chars稳定行 | char_id/name/category/source_ref+识别主体/依据/来源版本→P2-11编号/名称/分类/来源/类型/顾客或组织分类；规格、公差和保证工序不自动填写 | P1-11已批准；编号、名称、显式类型和识别主体有效 | 批准后生成待采用候选；人工采用写入P2-11草稿 | 不自动批准P2-11；人工改动冲突，已批准目标仅待复核 | P1-11 revision/row ID及P2-11生成row ID | 已实现 | deliverable-sync.js `initial-special-characteristic`/`docRow`；server.js文档批准/resolve | 桌面浏览器端到端及来源修订后冲突验证 | 候选逐项中文显示；未采用不写入；采用不填推断规格/工序；源版本可追溯 |
| R1-11-CHAR | P2-11.chars稳定行→char_master/project_char.pchar_id | char_id/name/显式类型/special_symbol/source_ref/tol_text/分类及认可依据 | P2-11有效批准revision、唯一行ID、族系列及字典类型兼容 | P2-11批准后同步 | 非空项目值冲突；分类冲突/不兼容待确认；已批准消费方不改写 | source revision/row ID/pchar_id | 已实现 | deliverable-sync.js `special-characteristic`/`characteristicIssue`；server.js project chars routes | 与FMEA/CP共享特性对象的桌面浏览器E2E | 仅正式批准行建立项目特性；正确项目新增；字典类型和范围不符不生效 |
| R1-13-CAP | P1-13→P2-10/P3-05/P4-01/P4-09 | 计划节拍/班次/目标产能；实测与验收分别有主数据 | 产能方案批准、工序可定位 | 设备/产能评审 | 实测不得被计划覆盖 | 计划版本/工序ID | 受控引用 | doctpl.js P1-13；无同步函数 | 工序ID和实测产能实体 | 可比计划/实绩；差异需人工确认 |
| R1-15-CHANGE | P1-15规则→ECR/P2-09→受影响对象 | 审批规则和ECR ID/旧新版/影响范围分开 | 具体ECR批准且对象适用 | ECR批准后，实施动作生成并回链实施基线快照 | 逐对象人工确认；实施前不改对象；已批准目标不自动改 | ECR ID/base baseline/branch baseline/source-target rev | 部分实现 | server.js `/api/ecr`、`/api/ecr/:id/apply`；db.js `freezeBaseline` | 按稳定对象应用已批准变更及实施差异复核 | 实施快照仅生成一次并可回链；变更对象新旧值仍须逐项核对 |
| R1-17-RISK | P1-17.risks→DFMEA/DVP/PFMEA | 风险、措施、owner/due；当前无统一risk_id主数据 | 风险评审批准且人工选对象 | 批准后候选/引用 | 不自动转FMEA评分/AP或关闭 | 风险表revision/行ID待建 | 受控引用 | doctpl.js P1-17；无risk同步函数 | 风险主对象和FMEA/DVP引用 | 关联可追来源；FMEA分值不变 |
| R2-DF-DVP | 已发布DFMEA.fmea_row.row_id→P2-03.dvp | 设计验证对象候选、来源row_id | 同项目已发布DFMEA | FMEA publish/sync | 验证项目方法准则由设计确认；批准DVP保护 | FMEA rev/row ID | 已实现 | deliverable-sync.js `dfmea-dvp`；server.js FMEA publish/`syncProjectDeliverables` | 浏览器E2E/覆盖率闭环 | 候选追唯一行；不自动生成试验结果 |
| R2-DF-PF | DFMEA.row_id→PFMEA.upstream_row_id | 设计影响/设计特性引用；过程原因工序由PFMEA维护 | 同项目FMEA，PFMEA行人工关联 | PFMEA编辑/审核 | 不把过程原因回写DFMEA | DFMEA rev/row IDs | 受控引用 | server.js FMEA save/upstream行校验 | 发布版设计变更影响提醒 | 只能链接同项目DFMEA行；两域字段不交叉覆盖 |
| R2-REVIEW | P2-02/03/06/07/08→P2-04 | 评审对象、版次、问题/决定/行动/期限 | 评审范围确认 | 设计评审保存 | 结论/签署由评审人维护 | 每个源文件revision | 受控引用 | doctpl.js P2-04模板；无字段同步 | 稳定文档/问题对象引用 | 评审可见源版次和遗留项 |
| R2-DFM-PFD | P2-02 DFM/DFA→P3-04/P3-06 | 可制造/装配约束、问题和措施；P2-02评审行是来源 | 评审确认涉及具体工序/失效对象 | 人工评审后关联 | 不自动创建工序或PFMEA失效 | DFM评审版/PFD/PFMEA版 | 受控引用 | doctpl.js P2-02；无对象字段同步 | 约束项ID到step_id/fmea_row_id | 每项约束能打开对应对象；原始文字不生成分析 |
| R2-DVP-TEST | P2-03.dvp稳定行→P4-05.tests稳定行 | 项目、条件/方法、要求；生产结果独立 | DVP批准revision、stable row ID | 批准后同步要求 | 不复制设计实测/判定；目标批准保护 | DVP revision/row ID/P4-05 version | 已实现 | deliverable-sync.js `dvp-production-test`；server.js docs approve | 端到端变更复核 | 只同步要求；生产结果不变；重排不串行 |
| R2-PROTO | P2-05表单↔control_plan.PROTO/cp_row | P2-05旧表无cp_row_id；control_plan/cp_row为阶段控制主对象 | 当前无可靠历史映射条件 | P2-05批准不触发；PROTO实体独立维护 | 不按工序名猜迁移；阶段批准独立 | 文档版本和PROTO CP revision分别管理 | 待实现 | doctpl.js P2-05；db.js control_plan阶段初始化；control-sync.js `inheritStages` | 显式ID及历史迁移审查 | 未映射时不复制；有ID时目标/来源可验证并保留人工/批准值 |
| R2-SPECS | P2-06/07/08→project_char/DVP/CP | 图纸尺寸、工程/材料要求；源文件为原要求主数据 | 文件批准且每项有明确特性ID/单位/范围 | 人工识别批准后 | 不解析猜值/符号 | 文件编号/版次/条款ID | 待实现 | doctpl.js P2模板；无同步规则 | 结构化特性抽取/来源桥 | 候选逐项引用原条款，人工批准后才成为项目特性 |
| R2-EQUIP | P2-10/P2-12→设备资产/gauge/CP/MSA | 需求参数与实物资产ID/校准证书分别维护 | 设备验收并绑定工序/测量系统 | 资产登记/验收 | 需求不标作“在用/已校准” | asset ID/校准有效期 | 部分实现 | db.js gauge；server.js `/api/gauges`及CP/MSA校验 | 需求行→资产ID关系 | 未验收设备不进入有效测量研究；过期校准可阻断 |
| R2-DOC-REF | 批准P1/P2文档→目录直接下游 | 内部保存source_code/rev_id/version/row_id；界面仅显示交付物名称/文号/可读版本和受控关系，不展示内部ID | 同项目、最新批准revision、未隐藏 | 批准或sync API | 只写引用元数据，不改签署/业务字段 | 来源rev ID用于校验；界面仅显示可读版本；目标独立版次 | 受控引用 | deliverable-sync.js `approvedDocs/catalog-reference/displayRelation/list`；public/app.js `deliverableLinksHtml` | 桌面浏览器E2E与项目自定义名称验证 | 仅增加可追溯引用；界面不泄漏修订ID/原始JSON；目标内容hash不变 |

### 过程、控制计划、MSA及SPC关系

| 关系ID | 上游/下游交付物（稳定对象） | 关联字段与数据主来源 | 引用条件 | 同步时机 | 人工覆盖/批准保护 | 版本要求 | 实现状态 | 代码依据 | 待补功能 | 验收标准 |
|---|---|---|---|---|---|---|---|---|---|---|
| R3-PFD-PF | 发布process_step.step_id→PFMEA fmea_node.node_id | 节点名称/描述/parent_id/level；pfd_fmea_link映射 | PFD已发布、父步骤已发布、PFMEA同项目 | PFD同步入口 | 增量更新不替换FMEA分析；旧节点无法映射则issue | step.ver/PFD revision/node ID | 已实现 | control-sync.js `fromPfd`；server.js PFD发布/保存触发sync | 浏览器工步树E2E | 同step不重复；工步父层正确；原功能/失效保留 |
| R3-PFD-CP | 发布step_id→PILOT基础cp_row | step_id/upstream_ver；CP行为控制主对象 | PILOT草稿；无PFMEA特性CP覆盖 | CP generate/sync | override按字段保护；批准CP仅待复核 | PFD step ver/PILOT rev | 已实现 | control-sync.js `generate` basic loop | 基础方法工艺审核提示 | 无特性工序有基础CP行；SOP不自动加缺行 |
| R3-PFD-SOP | 已发布process_step→P3-07.steps | step_no/name/output_desc→作业步骤提示 | PFD发布且SOP未批准 | 发布/同步入口 | stable ID；不推断安全或工艺参数 | PFD step_id/ver | 已实现 | deliverable-sync.js `pfd-sop`; control-sync.js快照 | 页面编辑批准E2E | 重排按ID；参数/安全列不被推断填写 |
| R3-PFD-LAYOUT | P3-04 PFD→P3-05布局 | step_id/工序顺序/设备作为布局评审引用；布局坐标独立维护 | PFD已发布、设备区域规划明确 | 布局评审时引用 | 不从工序顺序自动推断布局坐标/物流距离 | PFD revision、layout revision分别保存 | 受控引用 | doctpl.js P3-05；server.js PFD APIs；无坐标同步函数 | step_id与layout area/equipment ID桥 | 布局对象能回溯相关工序，不自动产生图形坐标 |
| R3-QMS-REVIEW | P3-03质量体系评审→Gate3/P3-06/P3-06b/P4-08 | 差距项、责任、期限、关闭证据；体系评审记录为主 | 项目过程体系范围适用 | Gate3/阶段评审 | 评审结论、签署人工确认 | 审核标准版本/评审版次 | 受控引用 | doctpl.js P3-03；server.js Gate routes；无差距对象同步 | gap ID到整改/风险/CP对象 | 未关闭差距可被Gate review发现；仅提交文档不自动通过 |
| R3-LAYOUT-PROCESS | P3-05布局→PFD/PFMEA/CP/P4-01 | 区域/物流/隔离/设备位置作为过程评审约束；布局为几何源 | 布局批准、工序可映射区域 | PFD/过程确认评审 | 不以区域文字覆盖工序或CP内容 | layout revision与PFD/CP rev分别保存 | 受控引用 | doctpl.js P3-05；无布局对象关联同步 | area ID与step/equipment ID关联 | 关键隔离/物流问题有工序引用；无引用不能伪称同步 |
| R3-PF-CP | 已发布PFMEA行组+step/char→PILOT/SOP cp_row | step_id、char/pchar、spec、dc→measure_tech、pc→control_method、fmea_row/cp_fmea links | PFMEA发布、特性有效、同项目CP | CP generate/sync | override_fields_json逐字段保护；批准CP不改写 | PFMEA rev/row IDs/CP rev | 已实现 | control-sync.js `publishedPfmea/generate/applyCp`; server.js `/api/cp/generate` | UI冲突E2E、多来源行验证 | step+char稳定生成；多PFMEA来源可查；人工覆盖保留 |
| R3-CP-STAGE | PROTO→PILOT→SOP CP行 | cp_stage_link映射及控制字段；目标行独立ID | 源CP批准/冻结，同项目目标存在 | syncProjectDeliverables | 不复制签字；目标有override冲突；批准目标需先退回 | source cp_id/rev/row ID；target revision | 已实现 | control-sync.js `inheritStages/syncProject`; server.js sync wrapper | 浏览器E2E/真实数据升级 | 阶段映射唯一；未覆盖字段更新；批准值不覆盖 |
| R3-CP-MSA | 适用CP测量行→msa_plan_item.plan_id | source_key=CP行/特性/检具/方法/规范/版次；含非SPC适用项 | 同项目有效项目特性、检具且方法适用 | CP保存/同步及计划查询 | 人工计划参数保留；已完成研究历史不覆盖 | source_key/source_version/plan_id | 已实现 | db.js `ensureMsaPlans/listMsaPlans`; server.js sync wrapper; tests/msa-plan-unit.js | 方法适用性/用户提示E2E | 多工序/量具独立；非SPC适用项可创建；重复运行幂等 |
| R3-MSA-VIEW | msa_plan_item→P3-08.data.plan | 特性、检具、研究设计、日期、责任、状态；计划实体主导 | 存在项目计划 | 计划维护/同步入口 | 只更新派生plan；文档批准保护 | plan_id/source_key及文档revision | 已实现 | deliverable-sync.js `syncMsaPlanDocument`; server.js wrapper | 批准报告UI E2E | 计划变化反映；签署和其他字段不变；批准文档只待复核 |
| R4-MSA | msa_plan_item.plan_id→msa_study.study_id | project_char/gauge/method/设计参数→研究身份；raw_json/result为实际研究来源 | 同项目、计划未完成、特性/检具匹配 | POST研究/complete | 不匹配拒绝；完成后回写plan状态 | plan_id/study_id/测量系统复合键 | 已实现 | server.js `/api/msa`及complete；db.js `latestMsaStudy` | 各方法浏览器E2E | 错计划/错项目拒绝；正确研究回plan并能确认完成 |
| R4-CP-SPC | cp_row→monitoring_item→spc_dataset | cp_row_id/mon_id/char/gauge/chart/frequency→控制定义；dataset为实测主来源 | 监控批准、数据有效、仪器适用 | 配监控/导入数据 | 批准监控变更须复核；不从计划造数据 | CP/monitor/config版及dataset hash | 部分实现 | server.js monitoring/SPC routes；logic.js `spcCompute` | 生产run/batch稳定外键及E2E | 数据关联唯一批准monitor；缺数据不报能力完成 |
| R4-MSA-QUAL | MSA study+检具校准→CP/SPC资格 | project_char/gauge/method/result/calibration；研究和校准为主来源 | 测量系统完全匹配且有效 | MSA完成/CP/SPC校验 | 计划存在不视合格；异常需质量处理 | study_id、校准证书有效期 | 部分实现 | db.js `latestMsaStudy`; server.js各MSA/CP/SPC校验; logic.js alerts | 所有消费点精确按方法查询E2E | 其他特性/方法研究不串用；校准过期可阻断/告警 |
| R4-CAPABILITY | P3-09→monitoring/SPC | 特性/子组/频率/chart/目标；monitor配置为执行主对象 | 计划获批，特性和工序明确 | 人工采用计划配置 | 计划与实际结果分离 | P3-09 revision/monitor配置 | 受控引用 | doctpl.js P3-09；server.js monitoring routes；无自动转换 | P3-09稳定行ID到monitor | 采用配置可回查计划；真实数据单独导入 |
| R4-RUN | P4-01→SPC/PPAP样品 | batch/date/设备/班次/样品ID；P4-01为运行来源 | 正式生产条件和批次一致 | 运行批准/取证 | 不伪造尺寸/SPC值 | run/sample ID、CP/PFD revision | 受控引用 | doctpl.js P4-01；ppap-workflow.js no.9/14；无run ID桥 | run/sample/dataset外键 | 样品能追正式批次；产量表不替代实际样品 |
| R4-MSA-PPAP | MSA计划/研究→PPAP8 | plan/study/特性/检具/方法/raw/result | 所有适用研究完成有效 | PPAP readiness/evidence | 人工确认适用性/接受；不代签 | plan/study/校准版本入baseline | 部分实现 | ppap-workflow.js no.8；server.js PPAP evidence；db.js MSA查询 | 多方法附件及baseline E2E | 每个适用系统有对应研究；无研究不ready |
| R4-SPC-PPAP | monitor/dataset→PPAP11 | monitor/dataset/control chart/Cpk/Ppk/异常 | 有效生产数据，满足顾客和项目判据 | 导入/计算/ready查询 | 质量确认稳定性/处置 | dataset hash/CP rev/spec revision | 部分实现 | ppap-workflow.js no.11；server.js `spcCompute`/PPAP evidence | P3-09计划/生产批次链接 | 能复算；无数据/不达标不能ready |
| R4-PROD-TEST | DVP/材料规范→P4-05→PPAP9/10 | 要求由源同步；生产实测/报告独立录入 | 适用要求和正式生产样本 | 要求在上游批准时；结果批准后取证 | 不复制DVP实测/判定；质量批准结果 | DVP/spec/lot/report version | 部分实现 | deliverable-sync.js `dvp-production-test`; ppap-workflow.js no.9/10 | 材料/性能报告主实体 | 要求关联真实报告；缺生产结果不ready |
| R4-PACK | P3-02.pack→P4-06.items | 材料/数量/标识/防护→要求；结果由实际运输评价生成 | 包装方案获批、运输条件适用 | P3-02批准后 | 结果/判定人工填写；不能映射AAR | packaging revision/评价revision | 已实现 | deliverable-sync.js `packaging-evaluation` | 运输数据及顾客签批E2E | 只同步要求；PPAP13不被置ready |
| R4-QUALITY-REVIEW | P4-08质量策划签发→PPAP/量产准备 | Gate结论、遗留项、签发人/日期；签发为独立批准主对象 | 过程验证完成、遗留风险评估 | 领导评审/量产放行 | 授权人签字；系统不得用PPAP ready代签 | Gate/PPAP baseline/签发revision | 受控引用 | doctpl.js P4-08；server.js Gate/PPAP routes | 签发对象关联PPAP提交和remaining issue | 签发记录能定位baseline/遗留项；不自动等于客户接受 |
| R4-RAMP | P4-01/02/03/04/06/07→P4-09量产爬坡 | 生产批/能力/MSA/PPAP/包装/CP放行证据；P4-09活动记录为主 | 客户放行条件和内部量产门槛适用 | 量产准备评审 | 产能/人员/物料/遗留项由责任人确认 | 各来源baseline/有效日期 | 受控引用 | doctpl.js P4-09活动；server.js PPAP/gate routes | ramp checklist和资源到位实体 | 未达客户放行条件不能标ready；证据版本可追踪 |
| R4-SIGNOFF | Gate/验证/包装/PPAP→P4-08/P4-09 | 遗留项、资源、批准及有效CP/MSA/SPC | 同项目阶段门 | 策划签发/量产准备评审 | 授权人签署；不可数据代签 | Gate/review/baseline | 受控引用 | doctpl.js P4-08/P4-09；server.js gate/PPAP routes | 遗留项与ready规则 | 未关闭高风险/未批准PPAP不误判量产ready |
| R5-FEEDBACK | SPC/MSA/客诉/P5→DFMEA/PFMEA/CP/ECR/新项目 | issue/root cause/action/evidence/适用范围；当前无lesson实体 | 异常/投诉确认并经根因批准 | 人工建立改进/ECR/经验复用 | 不自动改FMEA评分、控制值或跨项目覆盖 | issue/ECR/baseline/系列版本 | 待实现 | P5活动doctpl/CATALOG；无lesson同步函数 | 问题单/经验库/审核复用关系 | 关闭问题追到受影响对象；复用需确认并记录源项目 |
| R-A01 | 项目/顾客/供方/资源→A-01/P1-17 | 风险因素、证据、措施；A-01答复主导 | 立项范围/供方和客户条件明确 | 风险因素检查/批准 | 结论人工评审 | 项目/检查表版本 | 受控引用 | doctpl.js A-01/CHK_1；无自动对象映射 | 检查行→risk ID | 风险可追证据/owner；不自动写FMEA评分 |
| R-A02 | DFMEA rows→A-02/P2-04 | FMEA完整性、遗漏、行动关闭；row_id为对象键 | 同项目已发布DFMEA | 设计门检查 | 检查人独立确认，不代替DFMEA批准 | fmea_id/rev/row ID | 受控引用 | doctpl.js A-02；server.js FMEA routes；无自动checklist link | 检查项到fmea_row_id | 高风险遗漏可定位来源行；清单未过不能伪标Gate通过 |
| R-A03 | P2-06/07/08/11→A-03 | 图纸/规范版次、特性、差距证据 | 设计信息适用范围确认 | Gate2检查 | 发现和结论人工维护 | 源文件revision+A-03版次 | 受控引用 | doctpl.js A-03/CHK_1；无字段映射 | checklist row稳定source ID | 能定位被查版本与差距；不改源设计文件 |
| R-A04 | P2-10/12及设备/检具资产→A-04 | 能力要求、到位、验收/校准证据；资产ID主导 | 资产对本项目工序适用 | 设备/工装验收 | 未到位/过期不能人工同步成合格，需审核记录 | asset ID/证书expiry/清单版次 | 部分实现 | doctpl.js A-04；db.js gauge；server.js `/api/gauges`；无A-04自动连接 | process/equipment asset与check row关联 | 检查行能定位真实设备/检具；需求不等实物验收 |
| R-A05 | P3-03/PFMEA/CP/能力准备→A-05 | 体系覆盖、差距、措施、owner/期限 | 过程审核范围确定 | Gate3/4质量审核 | 审核结论及签字人工保护 | 体系/PFMEA/CP版本 | 受控引用 | doctpl.js A-05；无逐项字段同步 | gap ID/close evidence对象 | 每差距有责任和证据；有文件不自动代表合规 |
| R-A06 | P3-05布局→A-06 | 区域/物流/隔离、布局版次 | 布局范围/工厂区域适用 | Layout评审 | 评审结论人工记录 | layout revision/checklist revision | 受控引用 | doctpl.js A-06；无layout area ID映射 | area ID→check row | 检查点能定位区域；布局变更要求复查 |
| R-A07 | P3-04 process_step→A-07 | step_id、返工/检验步骤及发布状态 | PFD工序已发布 | PFD完整性检查 | 发现项人工处理；不删除未通过工序 | PFD version/step_id | 受控引用 | control-sync.js `fromPfd`; doctpl.js A-07；无checklist link | A-07 row→step_id | 返工/检验逐工序可核对；缺项可定位步骤 |
| R-A08 | P3-06 fmea_row→A-08 | 功能/失效/4M/控制/措施，row_id/node_id | PFMEA发布且适用 | PFMEA完整性检查 | 检查结论独立审核 | PFMEA revision/row IDs | 受控引用 | control-sync.js `publishedPfmea`; doctpl.js A-08；无checklist link | row ID关联和关闭证据 | 每个发现定位PFMEA行；不自动造功能/原因 |
| R-A09 | P1-15规则+ECR/P2-09→A-09 | 规则、change ID、影响/批准/通知/实施 | 具体变更适用且获批 | 变更合规检查 | 变更影响和关闭人工批准 | ECR/ECO revision及规则版本 | 部分实现 | server.js ECR/baseline routes；doctpl.js A-09；无checklist link | 具体变更ID及对象范围关联 | 规则与ECR分离；影响对象、通知和实施证据齐全 |
| R-A10 | BOM/材料/包装/供应商→A-10 | supplier/part/spec/供方审核记录 | 供方/外购件适用当前项目 | 采购审核 | 供应商批准/偏差由采购质量人员确认 | supplier/material/packaging version | 待实现 | doctpl.js A-10；系统无完整supplier APQP实体 | 供应商主数据/审核证据对象 | 每个适用外购件对应批准供方和要求；无实体不得报自动同步 |
| R-A11 | PFD/PFMEA/CP rows→A-11 | step_id、特性、控制、频率/反应、来源row IDs | 对应阶段CP存在且有效 | CP一致性审核/Gate | 差异人工关闭；不得代签CP | PFD/PFMEA/CP各自revision | 受控引用 | doctpl.js A-11；control-sync.js PFMEA/PFD映射；无A-11 row link | A-11 item到cp_row及源多行关联 | 每行可核对PFD/PFMEA/CP并定位差异；未批准不得判通过 |
| R-CATALOG-DISPLAY | CATALOG.up/down→交付物关系图节点/边 | 仅doc_code和展示方向，无字段级业务载荷 | 节点存在于项目目录；隐藏项不展示 | 页面GET `/api/docs` 后渲染 | 只读；不得触发同步/创建 | 当前CATALOG定义版 | 仅关系展示 | doctpl.js `CATALOG`；server.js `/api/docs`；public/app.js `vTree`反向补边 | UI区分展示边与字段同步/受控引用边 | 打开关系图无业务表变化；边不显示成“已同步”状态 |

### PPAP 18项逐项字段级关系

当前来源和ready条件以`lib/ppap-workflow.js`的sourceType/sourceCodes及`server.js`工作流/证据查询为依据。ready表示来源准备状态，不代表顾客PPAP批准或PSW已签署。

| 关系ID | 上游/下游交付物（稳定对象） | 关联字段与数据主来源 | 引用条件 | 同步时机 | 人工覆盖/批准保护 | 版本要求 | 实现状态 | 代码依据 | 待补功能 | 验收标准 |
|---|---|---|---|---|---|---|---|---|---|---|
| PPAP-01 | P2-06/P2-08→ppap_element(1) | 图纸/规范号、版次、零件范围/材料；批准设计记录主导 | 同零件且客户适用版 | PPAP查询/打包 | 人工确认适用；不覆盖批准附件 | 图纸/规范revision+baseline | 部分实现 | ppap-workflow.js item1；server.js `ppapWorkflowRows/get evidence` | 图纸版本和附件实体结构化 | 显示批准文件及版次；缺失/不一致不ready |
| PPAP-02 | P2-09/ECR→ppap_element(2) | ECR号、旧新版、批准人、实施日 | 变更已批准实施 | 提交前证据查询 | 影响/实施人工确认 | ECR ID/baseline/生效版 | 部分实现 | ppap-workflow.js item2；server.js ECR/baseline routes | 变更附件及实施对象稳定链接 | 所有适用变更可核对；未批准变更不ready |
| PPAP-03 | 客户批准/偏差许可→ppap_element(3) | 批准文件、偏差号、范围、有效期；客户文件主导 | 顾客要求批准时；N/A须有理由 | 提交前核验 | 顾客/授权人批准，系统不能代签 | 文件版次/expiry | 受控引用 | ppap-workflow.js item3 `manual` | 附件ID、有效期、豁免流程 | 适用时有效批准；N/A可审计 |
| PPAP-04 | DFMEA发布→ppap_element(4) | 结构/功能/失效/特殊特性/AP/措施；DFMEA主导 | FMEA已发布且项目/零件匹配 | readiness/evidence | FMEA/客户决定人工 | fmea_id/rev/row IDs | 部分实现 | ppap-workflow.js item4; server.js PPAP FMEA evidence | 全量内容baseline快照 | 定位最终DFMEA版本/行；未发布不ready |
| PPAP-05 | P3-04步骤→ppap_element(5) | 工序号/type/equipment/input/output/version | 所有适用工序发布且与PFMEA/CP一致 | evidence/打包 | 差异人工闭环 | PFD ver/step_id | 部分实现 | ppap-workflow.js item5; server.js PFD evidence | 受控全量导出附件 | 工序覆盖且能对照三方 |
| PPAP-06 | P3-06 PFMEA→ppap_element(6) | 工序/功能/失效/原因/控制/AP/行动；PFMEA主导 | PFMEA已发布，工序一致 | evidence/打包 | 评审关闭由责任人批准 | fmea_id/rev/row IDs | 部分实现 | ppap-workflow.js item6; server.js FMEA evidence | 全量行及签批附件冻结 | 适用PFMEA完整可追溯 |
| PPAP-07 | SOP control_plan/cp_row→ppap_element(7) | CP版次/批准/生效/工序/特性/样本/频率/反应 | SOP CP已批准生效 | readiness/evidence | 不复制签署；变更需重审 | cp_id/rev/row IDs | 部分实现 | ppap-workflow.js item7 cpStage SOP；control-sync stage inherit | 全量CP附件和签署baseline | 仅有效批准SOP CP ready |
| PPAP-08 | MSA plan/study→ppap_element(8) | plan/study/特性/检具/方法/raw/%GRR/%Tol/判定 | 所有适用系统完成有效MSA | readiness/evidence | 质量确认适用性/判定 | plan/study/校准版 | 部分实现 | ppap-workflow.js item8；db.js `ensureMsaPlans/latestMsaStudy` | 多方法报告附件及baseline E2E | 每适用系统一研究；计划存在不算完成 |
| PPAP-09 | P4-05/P4-01→ppap_element(9) | 图纸特性、样本、实测、判定、report ID | 全尺寸覆盖且样品来自有效生产 | 结果批准后 | 实测/报告质量批准，DVP不代替 | drawing rev/lot/report ID | 部分实现 | ppap-workflow.js item9 P4-01/P4-05；deliverable-sync要求同步 | 特性/样本/报告主实体 | 每项真实实测/判定；DVP结果不作生产结果 |
| PPAP-10 | P2-03/P2-08/P4-05→ppap_element(10) | 材料/性能项目、规范、方法、样本、报告 | 顾客适用项目完成、规范有效 | 结果批准后 | 计划和规范不能当结果 | spec rev/lot/report ID | 部分实现 | ppap-workflow.js item10 docs | 材料性能报告实体 | 每项真实报告匹配方法/规范 |
| PPAP-11 | P3-09/P4-03→ppap_element(11) | monitor/dataset/chart/Cpk/Ppk/异常 | 有生产能力数据且达到适用门槛 | 导入/计算/ready查询 | 质量确认稳定性和行动关闭 | monitor/dataset hash/spec rev | 部分实现 | ppap-workflow.js item11 spc；server.js `spcCompute/evidence` | 计划行/生产批次外键 | 可复算；缺数据/不达标不ready |
| PPAP-12 | 实验室资格范围→ppap_element(12) | 实验室、认可范围、方法、有效期、report | 范围涵盖试验，顾客规则满足 | 报告提交/审核 | 质量/顾客确认 | 证书有效期/范围版 | 受控引用 | ppap-workflow.js item12 `manual`；P4-05无资格对象 | 实验室主数据和范围校验 | 每份试验可匹配有效资质范围/方法 |
| PPAP-13 | AAR/顾客外观批准→ppap_element(13) | 外观件/颜色/纹理/光泽及顾客批准；AAR独立主来源 | 需外观批准且适用 | PPAP提交前 | 顾客批准/豁免，不代签；包装评价不是AAR | AAR版次/样件/批准日 | 受控引用 | ppap-workflow.js item13 `manual`；P4-06只是包装评价 | AAR对象/附件 | 适用时找到顾客批准；P4-06不置ready |
| PPAP-14 | P4-01/样品台账→ppap_element(14) | sample ID、正式工装、批次、节拍、日期 | 样品来自正式生产运行 | 样品批准/提交 | 代表性样品需质量确认 | sample/run/CP/PFD版 | 部分实现 | ppap-workflow.js item14 P4-01 | sample/run实体外键 | 每样品追批次/工装，产量汇总不替代样品 |
| PPAP-15 | 标准样品封样→ppap_element(15) | sample ID、批准、保存、有效期 | 客户/内部要求封样 | 封样审批/提交 | 授权质量批准 | sample revision/expiry | 受控引用 | ppap-workflow.js item15 `manual` | 标准样品生命周期对象 | 适用项有有效封样；过期提示重制 |
| PPAP-16 | 实际checking aids/gauge→ppap_element(16) | 辅具清单/设计证明/实际资产/校准/MSA | 仅适用产品的检查辅具及客户要求 | 资产验收/提交 | 要求≠实物，校准需计量批准 | asset ID/证书有效期 | 部分实现 | ppap-workflow.js item16 gauge；server.js gauge evidence | checking-aid实体/维护记录 | 逐项为实际资产和有效记录；不把全厂gauge表直接当适用证据 |
| PPAP-17 | VOC/CSR→ppap_element(17) | CSR条款ID、适用性、落实位置、证据/豁免 | 客户条款适用于该项目 | 要求评审/提交 | 逐条人工确认；豁免需客户证据 | CSR版本/客户/产品范围 | 受控引用 | ppap-workflow.js item17 `manual`；P1-I-06/P1-11 | CSR条款对象和跨模块证据链接 | 每条有落实证据或正式豁免；P1-11不能代替全部CSR |
| PPAP-18 | PPAP package/baseline/PSW→ppap_element(18) | 提交等级、适用性、声明、签字/日期、baseline/hash | 适用证据齐、顾客提交规则明确 | submit/package/签批 | 授权质量签PSW，客户决定独立记录 | baseline_id/package hash/PSW版本 | 部分实现 | ppap-workflow.js item18 `manual`；server.js package/baseline routes | PSW结构和客户决定hash一致校验 | 18项适用性/提交等级/签署/baseline可核查；无客户批准不得标批准 |

## 13. 接入与冲突处理契约

1. 数据库初始化后调用`init()`，建立同步元数据与不可变来源快照表，不改原有业务表定义。
2. 文档保存/批准时为缺失行ID生成稳定ID；发现重复ID时该ID对应的所有重复行均重新生成，旧同步记录不按名称/行号复用。P1-11显式类型在第6列，P2-11在第7列，也接受`_syncMeta.chars[rowId].char_kind`。
3. 正式批准revision保存成功后调用`syncProject(projectId)`；PFD/FMEA发布后同样调用。未批准来源编辑不能替换正式来源。
4. `list(projectId, docCode?)`只执行SELECT；打开页面/读取关系不会创建计划、修复文档或覆盖内容。
5. 每个同步对象保存上次同步值。下游当前值与上次同步值一致才自动更新；首次无同步历史的非空目标值一律视为需确认，不认定为系统旧值。
6. 人工改动产生`conflict`；批准/待审核目标产生`review_required`。`adopt`重新验证目标状态，批准目标必须先退回草稿；`keep`保留人工值，来源再次改变会重新提示。
7. 来源行从最新批准快照移除，标记`source_missing`，不级联删除下游行、测量结果、措施或证据。
8. 需要实际工程判断的DVP/BOM行先形成候选。候选采用后建立草稿；未采用不创建正式结构、功能、失效或试验结果。
9. 专用模块可通过`syncFields(projectId, options)`复用字段保护；调用方必须传入经审核的来源快照，并在自己的批准事件中触发，不在GET请求里触发。同一来源行对应多个目标（例如多阶段CP）时，ruleId须包含目标ID，避免不同目标共用同步记录。
10. 联动区将目录/模块引用明确标成“仅追溯、不复制业务字段”；字段关系以中文字段名和值显示，未映射时不显示内部键或原始JSON。批准反馈包含新增、更新、冲突、待复核和失效来源数量。

工程边界：本轮没有从图片/自然语言自动推断图纸尺寸、规范上下限、FMEA评分、检具资格、顾客批准或真实试验结果。能力研究文档、实验室资格、AAR、样品/检查辅具、供应商APQP等没有完整结构实体的内容应保留受控附件和引用，不能以一条“完成”状态替代证据。

