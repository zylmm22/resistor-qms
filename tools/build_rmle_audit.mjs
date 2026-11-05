#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const DT = require("../lib/doctpl");
const FG = require("../lib/field-guide");
const PPAP = require("../lib/ppap-workflow");
// 外部表格工具的位置因机器而异，允许用环境变量覆盖，避免把本机路径写进仓库
const artifactToolPath = process.env.ARTIFACT_TOOL_PATH
  || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs");
const { SpreadsheetFile, Workbook } = await import(pathToFileURL(artifactToolPath).href);

const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};

// 路径都可由命令行/环境变量覆盖，默认值相对本仓库，不写死本机位置
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
const inputPath = path.resolve(
  arg("--input") || process.env.RMLE_AUDIT_INPUT || path.join(REPO_ROOT, "outputs", "rmle-audit-data.json"),
);
const outputPath = path.resolve(
  arg("--output") || process.env.RMLE_AUDIT_OUTPUT ||
    path.join(REPO_ROOT, "outputs", "rmle-c-audit", "RMLE(C)_项目_APQP_系统差异与导入指引_v1.0.xlsx"),
);
const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
const inventory = raw.rows;
const projectRoot = arg("--source-root") || process.env.RMLE_SOURCE_ROOT || "";

const headersBySheet = {
  "01_文件总账": [
    "序号", "阶段目录", "相对路径", "文件名", "扩展名", "大小KB", "SHA256", "重复组",
    "文件类别", "识别编号", "映射状态", "解析状态", "标题/首个内容", "内容摘要",
    "表格/工作表摘要", "转换状态", "备注",
  ],
  "02_APQP对标": [
    "编号", "阶段", "分类", "交付物/活动", "系统形态", "手册依据", "项目证据数",
    "主证据", "状态", "差异说明", "待确认/补件",
  ],
  "03_字段映射": [
    "映射ID", "系统交付物", "系统表格", "系统字段", "源文件", "源表/章节", "源字段",
    "映射类型", "转换规则", "置信度", "当前状态", "备注",
  ],
  "04_交付物填写指引": [
    "阶段", "交付物", "名称", "章节", "字段/列", "字段类型", "必填规则",
    "填写说明", "RMLE(C)示例", "建议来源", "不得推断", "缺失处理",
  ],
  "05_缺口与冲突": [
    "缺口ID", "类型", "优先级", "对象", "证据/位置", "问题", "影响", "建议", "当前状态",
  ],
  "06_导入顺序": [
    "顺序", "导入批次", "对象", "系统交付物", "依赖", "候选源文件/位置", "当前就绪度", "导入规则",
  ],
  "07_关键主数据": [
    "数据域", "字段", "值", "来源/位置", "状态", "说明",
  ],
  "08_PPAP证据": [
    "序号", "PPAP要素", "来源/证据要求", "项目候选证据", "当前判断", "缺口/需确认",
  ],
};

const phaseLabel = phase => ({
  0: "P0 入门",
  1: "P1 策划和定义项目",
  2: "P2 产品设计和开发",
  3: "P3 过程设计和开发",
  4: "P4 产品和过程确认",
  5: "P5 反馈、评定和纠正",
})[phase] || "附录/其他";

function evidenceRows(code) {
  return inventory.filter(row => {
    if (!String(row["识别编号"] || "").split(";").includes(code)) return false;
    return !["Office锁文件", "空白模板", "重复/归档副本"].includes(row["文件类别"]);
  });
}

function primaryEvidence(code) {
  const rows = evidenceRows(code);
  return rows.slice(0, 3).map(row => row["相对路径"]).join("\n");
}

const statusOverrides = {
  "P0-01": ["部分具备", "原表含联系方式、技能要求和具备情况；系统 P0-01 只有 6 列。"],
  "P0-02": ["部分具备", "立项报告覆盖范围与可行性，未按系统矩阵逐项拆分。"],
  "P0-05": ["缺失", "未发现独立供应商来源与高风险评估记录。"],
  "P0-10": ["已具备", "APQP 计划和设计开发任务表提供阶段、任务、日期、交付物和责任部门。"],
  "P1-I-01": ["部分具备", "立项报告含市场与用户需求，未形成系统 VOC 表。"],
  "P1-I-06": ["部分具备", "详细规范和立项资料包含顾客要求，需逐条形成受控要求清单。"],
  "P1-07": ["部分具备", "设计目标散落在详细规范和立项报告，需要按系统目标表转写。"],
  "P1-08": ["部分具备", "可靠性/质量目标需从详细规范试验要求提取。"],
  "P1-09": ["部分具备", "原材料清单字段比系统 BOM 多检验规范和质量要求。"],
  "P1-10": ["已具备", "现有产品初始过程流程图可直接映射工序路线。"],
  "P1-11": ["部分具备", "特殊特性有工序、产品/过程特性、规范与符号，但缺系统特性编号和明确识别主体。"],
  "P1-12": ["已具备", "产品质量保证计划包含风险、主要失效模式和措施。"],
  "P1-13": ["部分具备", "产能分析在阶段 4 提供实际数据，阶段 1 目标计划需补充。"],
  "P1-14": ["部分具备", "阶段评审记录体现管理者支持，但没有单独的领导支持表。"],
  "P1-15": ["部分具备", "临时变更清单可作证据，缺系统分级审批规则。"],
  "P1-16": ["部分具备", "APQP 计划提供节点，缺系统质量、成本、交付指标基线。"],
  "P1-17": ["部分具备", "质量保证计划有风险和主要失效模式，缺完整 REMS 责任人/期限。"],
  "P2-01": ["已具备", "新版 DFMEA Excel 含结构、功能、失效、PC/DC、S/O/D/AP 和措施。"],
  "P2-02": ["部分具备", "立项与过程输入评审涉及可制造性，但未形成系统 DFM/DFA 检查项。"],
  "P2-03": ["已具备", "样件验证计划、报告和试验数据记录可合并为 DVP&R。"],
  "P2-04": ["已具备", "各阶段设计评审报告和输出评审报告可追溯。"],
  "P2-05": ["已具备", "样件控制计划存在，需转成 PROTO 阶段 CP 行。"],
  "P2-06": ["部分具备", "装配图存在，但产品图纸 DOCX 是零字节占位文件。"],
  "P2-07": ["已具备", "Q/RV570-2023 详细规范为产品规范主依据。"],
  "P2-08": ["部分具备", "材料规范占位文件为空，详细规范和原材料清单含部分材料要求。"],
  "P2-09": ["部分具备", "临时变更清单存在，正式图纸/规范变更记录不完整。"],
  "P2-10": ["已具备", "设备、工装和试验设备清单/检查表已提供。"],
  "P2-11": ["已具备", "阶段 3 产品和过程特殊特性清单已正式维护。"],
  "P2-12": ["部分具备", "测量设备信息散落在设备清单、MSA 计划和评价报告中。"],
  "P2-13": ["已具备", "小组可行性承诺已提供。"],
  "P3-02": ["部分具备", "包装图纸和包装评价存在，包装标准与规范需整合。"],
  "P3-03": ["已具备", "产品质量体系检查表和阶段评审报告已提供。"],
  "P3-04": ["已具备", "阶段 3 产品过程流程图可作为 PFD 主数据。"],
  "P3-05": ["已具备", "车间平面定置图、布局图和检查表已提供。"],
  "P3-06": ["已具备", "旧版 PFMEA/PFAMA Excel 已成功转换，可按七步法字段导入。"],
  "P3-06b": ["已具备", "试生产控制计划存在，需与 PFD/PFMEA 特性关联。"],
  "P3-07": ["已具备", "关键/特殊工序作业指导书和工艺文件成套。"],
  "P3-08": ["部分具备", "MSA 计划表存在但表单多数字段空白，另有评价报告。"],
  "P3-09": ["已具备", "初始过程能力研究计划已提供。"],
  "P3-10": ["部分具备", "阶段评审体现资源支持，无独立领导支持记录。"],
  "P4-01": ["部分具备", "生产过程确认记录完整，工作令与检验记录为零字节空模板。"],
  "P4-02": ["已具备", "测量系统评价报告已提供，原始数据完整度需复核。"],
  "P4-03": ["已具备", "镍层、锡铅层和锡层初始能力数据含规格、Pp/Ppk。"],
  "P4-04": ["部分具备", "PPAP 清单、PSW、18 项表格和证据包存在，提交等级/顾客批准待确认。"],
  "P4-05": ["部分具备", "鉴定/验证试验计划存在，试验报告仍为零字节缺项模板。"],
  "P4-06": ["已具备", "包装评价报告已提供。"],
  "P4-07": ["已具备", "量产控制计划已提供，需与试生产 CP 阶段继承核对。"],
  "P4-08": ["已具备", "产品质量策划总结和认定表已提供。"],
  "P4-09": ["已具备", "量产交接清单已提供，生产线平衡和产能分析可作支撑。"],
  "A-01": ["缺失", "没有独立 APQP 风险因素检查表。"],
  "A-02": ["已具备", "DFMEA 检查表已提供。"],
  "A-03": ["已具备", "产品设计信息检查表已提供。"],
  "A-04": ["已具备", "设备、工装和试验设备检查表已提供。"],
  "A-05": ["已具备", "产品质量体系检查表已提供。"],
  "A-06": ["已具备", "车间平面定置图检查表已提供。"],
  "A-07": ["已具备", "过程流程图检查表已提供。"],
  "A-08": ["已具备", "PFMEA 检查表已提供。"],
  "A-09": ["部分具备", "临时变更清单可作证据，缺独立变更管理检查表。"],
  "A-10": ["缺失", "没有独立采购检查表，原材料清单不能替代。"],
  "A-11": ["部分具备", "样件控制计划检查表存在，量产 CP 检查需补。"],
  "P5-01": ["缺失", "未包含量产持续降低变差记录。"],
  "P5-02": ["缺失", "未包含顾客满意度记录。"],
  "P5-03": ["缺失", "未包含交付和服务绩效记录。"],
  "P5-04": ["缺失", "未包含经验教训与最佳实践总结。"],
};

const apqpRows = DT.CATALOG.map(item => {
  const rows = evidenceRows(item.code);
  const [status, note] = statusOverrides[item.code] ||
    [rows.length ? "部分具备" : "缺失", rows.length ? "存在候选证据，需按系统字段人工确认。" : "未发现直接证据。"];
  return [
    item.code,
    phaseLabel(item.phase),
    item.group === "input" ? "输入" : item.group === "checklist" ? "检查表" : item.group === "activity" ? "活动" : "输出",
    item.name,
    item.kind === "module" ? `系统模块：${item.module}/${item.arg || ""}` : item.kind === "none" ? "纯活动" : item.fmt || "表单",
    item.phase <= 5 ? `APQP第三版 ${["入门", "第一章", "第二章", "第三章", "第四章", "第五章"][item.phase]}` : "附录A",
    rows.length,
    rows.slice(0, 3).map(row => row["相对路径"]).join("\n"),
    status,
    note,
    status === "已具备" ? "核对系统字段与版本/签署信息" :
      status === "部分具备" ? "补齐系统未覆盖字段并确认来源" :
        "寻找项目证据或明确不适用理由",
  ];
});

const manualMappings = [
  ["MAP-001", "P0-01 组建跨职能小组", "跨职能团队", "职能/组织", "第一阶段/跨部门职能项目小组及职责表", "主表第 4 行起", "部门", "直接映射", "去除合并单元格空值；同一成员跨部门时保留主部门", "高", "可用", "联系方式不进入系统"],
  ["MAP-002", "P0-01 组建跨职能小组", "跨职能团队", "成员姓名", "第一阶段/跨部门职能项目小组及职责表", "姓名列", "姓名", "直接映射", "只导入人员姓名，不生成账号", "高", "可用", "系统账号须另行创建"],
  ["MAP-003", "P0-01 组建跨职能小组", "跨职能团队", "角色/职责", "第一阶段/跨部门职能项目小组及职责表", "小组内角色 + 工作内容", "角色、工作内容", "转换映射", "角色与职责合并为可读文本", "高", "可用", "联系方式、技能要求、Y/N 为系统扩展候选"],
  ["MAP-004", "P0-01 组建跨职能小组", "跨职能团队", "授权范围", "第一阶段/跨部门职能项目小组及职责表", "工作内容/技能要求", "职责描述", "转换映射", "只写已明确的决策/执行权限", "中", "待确认", "原表未单列授权范围"],
  ["MAP-005", "P1-09 初始 BOM", "物料", "名称", "第一阶段/原材料清单", "材料名称", "材料名称", "直接映射", "保留原始名称", "高", "可用", ""],
  ["MAP-006", "P1-09 初始 BOM", "物料", "规格", "第一阶段/原材料清单", "型号/规格", "型号/规格", "直接映射", "保留厚度、材质、牌号等原文", "高", "可用", ""],
  ["MAP-007", "P1-09 初始 BOM", "物料", "供应商", "第一阶段/原材料清单", "供应商名称", "供应商名称", "直接映射", "多个供应商用换行或分号保留", "高", "可用", ""],
  ["MAP-008", "P1-09 初始 BOM", "物料", "系统扩展列", "第一阶段/原材料清单", "检验规范、质量要求", "检验规范、质量要求", "系统暂不支持", "建议后续增加“检验规范/质量要求”自定义列", "高", "待确认", "不能只塞备注而丢失业务含义"],
  ["MAP-009", "P1-11 初始特殊特性", "识别结果", "特性名称", "第一阶段/产品和过程特殊特性清单", "产品特性或过程特性", "产品特性/过程特性", "转换映射", "产品列非空则 char_kind=PRODUCT；过程列非空则 PROCESS", "高", "可用", "同一行两列不得同时有值"],
  ["MAP-010", "P1-11 初始特殊特性", "识别结果", "分类（CC/SC/安全/配合）", "第一阶段/产品和过程特殊特性清单", "特殊特性符号", "Z/G", "转换映射", "G→安全/关键；Z→重要；客户原符号保留在 special_symbol", "中", "待确认", "需客户符号映射确认"],
  ["MAP-011", "P1-11 初始特殊特性", "识别结果", "来源/初判依据", "第一阶段/产品和过程特殊特性清单", "工序、备注、规范", "工序/规范/备注", "转换映射", "组合为可追溯说明", "中", "待确认", "原表没有独立判定依据列"],
  ["MAP-012", "P1-11 初始特殊特性", "识别结果", "类型（产品/过程）", "第一阶段/产品和过程特殊特性清单", "产品特性/过程特性列", "产品特性/过程特性", "直接映射", "空值保持待确认", "高", "可用", "禁止根据名称猜测类型"],
  ["MAP-013", "P1-11 初始特殊特性", "识别结果", "识别主体（顾客/组织）", "第一阶段/产品和过程特殊特性清单", "无独立列", "待确认", "源数据缺失", "产品特性可能来自顾客，但必须人工确认", "低", "待确认", "不得凭列内容自动推断"],
  ["MAP-014", "P2-05 原型样件控制计划", "控制计划行", "零件/过程编号", "第二阶段/样件控制计划", "零件/过程编号", "过程编号", "直接映射", "统一为 step_no；创建稳定 step_id", "高", "可用", "名称不能作唯一键"],
  ["MAP-015", "P2-05 原型样件控制计划", "控制计划行", "过程名称/操作描述", "第二阶段/样件控制计划", "过程名称/操作描述", "过程名称", "直接映射", "保留原文", "高", "可用", ""],
  ["MAP-016", "P2-05 原型样件控制计划", "控制计划行", "产品/过程特性", "第二阶段/样件控制计划", "特性-产品/过程", "特性", "转换映射", "关联 project_char；无正式特性编号时先待确认", "中", "待确认", "不能仅凭名称创建重复特性"],
  ["MAP-017", "P2-05 原型样件控制计划", "控制计划行", "产品/过程规范/公差", "第二阶段/样件控制计划", "规范/公差", "spec_text", "直接映射", "保留单位与范围", "高", "可用", ""],
  ["MAP-018", "P2-05 原型样件控制计划", "控制计划行", "评价/测量技术", "第二阶段/样件控制计划", "评价/测量技术", "measure_tech", "直接映射", "保留方法和设备类型", "高", "可用", ""],
  ["MAP-019", "P2-05 原型样件控制计划", "控制计划行", "样本容量/频率", "第二阶段/样件控制计划", "容量、频率", "sample_size/freq_value/freq_unit", "转换映射", "拆分数量和频率，不存成自由文本", "中", "待确认", "原表可能为空"],
  ["MAP-020", "P2-05 原型样件控制计划", "控制计划行", "控制方法/反应计划", "第二阶段/样件控制计划", "控制方法、反应计划", "control_method/reaction_plan", "直接映射", "保留人工控制要求", "高", "可用", ""],
  ["MAP-021", "P2-01 DFMEA", "DFMEA 结构/分析行", "结构分析", "第二阶段/DFMEA Excel", "上一级/关注要素/下一级", "fmea_node", "转换映射", "按结构层级建节点；稳定 ID 由系统生成", "中", "待确认", "原文件无系统 node_id"],
  ["MAP-022", "P2-01 DFMEA", "DFMEA 结构/分析行", "功能分析", "第二阶段/DFMEA Excel", "上一级/关注要素/下一级功能", "fmea_function", "转换映射", "按节点关联功能", "中", "待确认", "不得自动派生额外功能"],
  ["MAP-023", "P2-01 DFMEA", "DFMEA 结构/分析行", "失效链", "第二阶段/DFMEA Excel", "FE/FM/FC", "fmea_row", "转换映射", "一行一个 FE/FM/FC；重复组合待确认", "中", "待确认", "原表无 row_id"],
  ["MAP-024", "P2-01 DFMEA", "DFMEA 结构/分析行", "S/O/D/AP", "第二阶段/DFMEA Excel", "S/O/D/AP 列", "fmea_row", "直接映射", "AP 由系统矩阵复核；原表值与系统不一致时待确认", "高", "可用", ""],
  ["MAP-025", "P3-06 PFMEA", "PFMEA 结构/分析行", "过程项/过程步骤/4M", "第三阶段/PFMEA Excel", "结构分析三列", "fmea_node", "转换映射", "过程项/步骤/4M 建层级；同一工序复用稳定 step_id", "中", "待确认", "原文件无系统 node_id"],
  ["MAP-026", "P3-06 PFMEA", "PFMEA 结构/分析行", "功能/产品特性/过程特性", "第三阶段/PFMEA Excel", "功能分析三列", "fmea_function/project_char", "转换映射", "先建特性字典候选，再关联分析行", "中", "待确认", "不能按名称直接复用不兼容特性"],
  ["MAP-027", "P3-06 PFMEA", "PFMEA 结构/分析行", "FE/FM/FC/PC/DC/SOD/AP", "第三阶段/PFMEA Excel", "风险分析列", "fmea_row", "转换映射", "逐行导入并复核 AP", "中", "待确认", ""],
  ["MAP-028", "P3-04 过程流程图", "工序", "工序号/工序/设备/输入输出", "第三阶段/产品过程流程图", "序号、工序、设备、过程流程", "process_step", "转换映射", "10–150 作为 step_no；名称与设备拆分", "高", "可用", "合并行需向下填充工序号"],
  ["MAP-029", "P3-04 过程流程图", "工序", "产品/过程特性/特殊特性符号", "第三阶段/产品过程流程图", "对应列", "project_char", "转换映射", "建立或关联项目特性；符号保留 Z/G", "中", "待确认", "特性编号需确认"],
  ["MAP-030", "P4-03 初始过程能力研究", "SPC 数据集", "检验项目", "第四阶段/初始过程能力评价", "工作表名与检验项目", "project_char", "转换映射", "镍层/锡铅层/锡层厚度分别建监控项", "高", "可用", ""],
  ["MAP-031", "P4-03 初始过程能力研究", "SPC 数据集", "DATA", "第四阶段/初始过程能力评价", "DATA 区", "spc_dataset", "直接映射", "保留原始测量值，一组一行或按系统导入格式转换", "高", "可用", "数值不得转文本"],
  ["MAP-032", "P4-03 初始过程能力研究", "SPC 数据集", "规格上下限", "第四阶段/初始过程能力评价", "规格列", "project_char lsl/usl", "直接映射", "核对单位和上下限顺序", "高", "可用", ""],
  ["MAP-033", "P4-03 初始过程能力研究", "SPC 数据集", "Pp/Ppk", "第四阶段/初始过程能力评价", "计算值", "系统重算结果", "校验项", "导入原始数据后由系统重算，不直接信任文件公式", "高", "可用", "源文件值与系统值差异需解释"],
  ["MAP-034", "P3-08 MSA计划", "MSA计划", "检验项目/量具/方法/样本/准则", "第三阶段/MSA计划", "同名列", "msa_plan_item", "转换映射", "空表单不生成计划；先可由 CP 测量系统生成", "中", "待确认", "计划表空白时不能伪造计划"],
  ["MAP-035", "P4-02 MSA", "MSA研究", "量具/方法/数据/结果/判定", "第四阶段/测量系统评价报告", "报告表格及原始记录", "msa_study", "转换映射", "只导入可读取到原始数据的研究", "中", "待确认", "报告无原始数据时只能作附件引用"],
  ["MAP-036", "P4-07 生产控制计划", "控制计划行", "量产 CP 字段", "第四阶段/量产控制计划", "同控制计划列", "control_plan/cp_row", "转换映射", "按 SOP 阶段导入；保留人工审批边界", "高", "可用", ""],
  ["MAP-037", "P4-04 PPAP", "PPAP 18项", "证据与状态", "第四阶段/PPAP 清单与文件包", "PPAP 清单、PSW、18项表格", "ppap_element", "转换映射", "文件存在仅作证据候选；完成状态由质量确认", "高", "可用", "不自动签批 PSW/顾客批准"],
];

const fieldGuideRows = [];
for (const meta of DT.CATALOG.filter(item => item.kind === "form")) {
  const sections = DT.T[meta.code] || [];
  for (const section of sections) {
    for (const field of section.fields || []) {
      const fields = field.type === "table"
        ? (field.cols || []).map((label, index) => ({
            label, type: "table-column", guide: FG.forColumn(meta.code, section.t, field, label, index),
          }))
        : [{ label: field.label, type: field.type, guide: FG.forField(meta.code, section.t, field) }];
      for (const item of fields) {
        const guide = item.guide;
        fieldGuideRows.push([
          phaseLabel(meta.phase),
          meta.code,
          meta.name,
          section.t,
          item.label,
          item.type,
          guide.required,
          guide.guidance,
          guide.example,
          guide.source,
          guide.example ? "示例来自本项目文件；导入前仍需核对版本和适用范围。" : "不得凭文件名、位置或经验自动补齐。",
          guide.missing,
        ]);
      }
    }
  }
}

const moduleGuides = [
  ["P2-01", "DFMEA", "表头", "DFMEA ID/版本/日期/团队", "文本/日期", "必填", "标识分析对象、版本和批准状态；稳定ID由系统生成。", "DFMEA ID：10；日期 2023-01-16", "DFMEA Excel", "不得把文件名当版本号。"],
  ["P2-01", "DFMEA", "结构分析", "上一级/关注要素/下一级", "树节点", "至少一个完整结构链", "每个关注要素必须有明确上下级关系。", "电阻器 → 电阻芯片 → 膜层", "DFMEA Excel 结构分析列", "不能凭文字相似自动建层级。"],
  ["P2-01", "DFMEA", "功能分析", "功能和要求", "文本", "每个分析结构必填", "按动词+对象+可测量要求描述。", "提供规定阻值", "DFMEA Excel 功能列", "不生成文件未列出的功能。"],
  ["P2-01", "DFMEA", "失效分析", "FE/FM/FC", "三类节点", "每条分析行必备", "FE 是影响，FM 是关注要素失效模式，FC 是下一级原因。", "温度系数超差 / 阻值偏小", "DFMEA Excel 失效列", "不把原因写成影响。"],
  ["P2-01", "DFMEA", "风险分析", "S/O/D/AP", "整数/枚举", "每条分析行必备", "AP由系统矩阵复核，原表值与系统计算不一致时待确认。", "S=7, O=2, D=3, AP=L", "DFMEA Excel 风险列", "不使用 RPN 代替 AP。"],
  ["P2-01", "DFMEA", "优化", "PC/DC/措施/责任人/日期/状态", "文本/日期", "高风险项闭合时必填", "区分当前控制和新增措施，并记录证据。", "参考成熟产品选择材料", "DFMEA Excel 优化列", "无证据不得标完成。"],
  ["P3-04", "PFD", "工序", "step_no/name/type/equipment/input/output", "主数据", "每个有效工序必填", "工序号和稳定 step_id 是下游统一关联键。", "10 进厂检验；30 电阻芯片加工", "阶段3产品过程流程图", "工步不得按行序猜测父子关系。"],
  ["P3-06", "PFMEA", "结构/功能/失效/风险", "现场结构、4M、FE/FM/FC、PC/DC、SOD/AP", "七步法", "发布前完整", "从已发布PFD和正式项目特性建立分析对象。", "10 进厂检验 / 操作人 / 检验结果不准确", "PFMEA Excel", "不照搬DFMEA原因和评分。"],
  ["P2-05/P3-06b/P4-07", "控制计划", "CP行", "工序、特性、规范、设备、样本、频率、控制方法、反应计划", "结构化行", "批准前完整", "特性必须引用项目特性；抽样拆分字段。", "游标卡尺；Z；尺寸", "样件/试生产/量产控制计划", "不得只保存为自由文本附件。"],
  ["P4-02", "MSA", "研究", "量具、特性、方法、零件数、评价人数、试验次数、原始数据、判定", "研究记录", "每个适用测量系统必填", "从计划直接带入，实际数据另行录入。", "量具、检验项目见测量系统评价报告", "MSA计划/评价报告", "不能以计划存在代替研究完成。"],
  ["P4-03", "SPC", "监控项/数据集", "特性、规格、子组、频率、图型、数据、Cpk/Ppk", "监控与数据", "形成能力结论前完整", "导入真实测量数据并系统重算。", "镍层厚度规格3–16，Ppk约1.67", "初始过程能力评价Excel", "不直接把文件Pp/Ppk写到正式结果。"],
  ["P4-04", "PPAP", "18项证据", "要素、适用性、文件、版本、批准状态", "证据清单", "提交前逐项确认", "文件存在只是证据候选，完成和顾客批准分别确认。", "PPAP提交时间2023-11-28", "PPAP清单/PSW/文件包", "不自动签PSW。"],
];
for (const [code, name, section, label, type, required, guidance, example, source, noInference] of moduleGuides) {
  const meta = DT.CATALOG.find(item => item.code === code.split("/")[0]);
  fieldGuideRows.push([
    phaseLabel(meta?.phase ?? 2), code, name, section, label, type, required, guidance,
    example, source, noInference, "无法追溯的值保持空白并标记待确认。",
  ]);
}

const gapRows = [];
let gapSerial = 0;
const addGap = (type, priority, object, evidence, issue, impact, action, status = "待处理") => {
  gapSerial += 1;
  gapRows.push([
    `GAP-${String(gapSerial).padStart(3, "0")}`, type, priority, object, evidence,
    issue, impact, action, status,
  ]);
};

for (const row of inventory.filter(item => item["文件类别"] === "Office锁文件")) {
  addGap("Office锁文件", "P3", row["文件名"], row["相对路径"], "临时锁文件不是正式交付物", "可能造成版本混淆", "审计时排除；关闭Office后确认正式文件版本", "已识别");
}
for (const row of inventory.filter(item => item["文件类别"] === "空白模板")) {
  addGap("空白/缺项模板", "P1", row["文件名"], row["相对路径"], "文件为零字节或仅占位，无业务内容", "对应交付物或PPAP证据不完整", "向项目责任人索取已填写版本；不得自动补造", "待补件");
}
for (const row of inventory.filter(item => item["解析状态"].includes("转换失败"))) {
  addGap("旧版文件解析失败", "P2", row["文件名"], row["相对路径"], row["解析状态"], "无法读取工作令卡内容", "转为PDF/可打开版本或人工复核", "待处理");
}
for (const row of apqpRows.filter(item => item[8] === "缺失")) {
  addGap("APQP缺口", "P1", `${row[0]} ${row[3]}`, row[7], row[9], "阶段证据链不完整", row[10], "待补件");
}
for (const row of apqpRows.filter(item => ["P0-05", "A-01", "A-10", "P5-01", "P5-02", "P5-03", "P5-04"].includes(item[0]))) {
  addGap("关键交付物缺失", "P0", `${row[0]} ${row[3]}`, row[7], row[9], "Gate/PPAP或量产闭环无法完整证明", row[10], "待补件");
}
addGap("字段差异", "P1", "P0-01 团队", "跨部门职能项目小组及职责表", "联系方式、技能要求、具备情况在系统P0-01无对应列", "人员资格与联络信息丢失", "保留原附件并评估扩展自定义列", "待确认");
addGap("字段差异", "P1", "P1-09 BOM", "原材料清单", "检验规范、质量要求无系统标准列", "关键材料验收要求可能只留在备注", "增加自定义列或材料规范关联", "待确认");
addGap("字段差异", "P1", "特殊特性符号", "产品和过程特殊特性清单", "项目使用Z/G，系统标准展示CC/SC/安全", "分类映射可能失真", "建立客户符号映射表，保留原符号", "待确认");
addGap("版本/命名", "P2", "项目型号", "多份文件", "文件名存在RML/RMLE混用", "自动匹配和产品主数据可能串项", "以详细规范和项目主数据为准，建立别名映射", "待确认");
addGap("版本/命名", "P2", "控制计划", "附表2-9", "同名编号用于样件、试生产、量产CP", "仅按文件名会错误归阶段", "必须以目录阶段和项目状态区分P2-05/P3-06b/P4-07", "已识别");
addGap("审批/签署", "P0", "多份项目表单", "签署/日期栏", "大量编制、审核、批准、日期空白", "历史文件存在不等于系统批准", "只作历史证据引用，不在系统代签", "待确认");
addGap("PPAP", "P0", "PPAP提交等级", "PPAP文件清单/PSW", "提交等级为空", "无法确认顾客要求的证据完整度", "向项目/质量责任人确认等级", "待确认");
addGap("PPAP", "P0", "顾客工程批准", "PPAP清单第3项", "原清单标记否，但需确认适用性", "可能缺少顾客批准证据", "确认是否不适用并保留依据", "待确认");
addGap("PPAP", "P0", "PSW/顾客批准", "PPAP清单附件-PSW", "PSW未见完整顾客批准结果", "不能把PSW草稿视为PPAP批准", "确认签署和顾客决定记录", "待确认");

const importOrder = [
  [1, "主数据", "项目/客户/组织/型号", "项目主数据", "无", "详细规范、立项报告、PPAP清单", "已具备", "创建新项目草稿；产品族PF-LOW-OHM，系列RML(C)"],
  [2, "主数据", "团队与职责", "P0-01", "项目主数据", "跨部门职能项目小组及职责表", "部分具备", "导入姓名/部门/角色/职责；联系方式和技能作为扩展列候选"],
  [3, "主数据", "项目范围与计划", "P0-02/P0-10", "项目主数据", "立项论证、立项评审、APQP计划、设计开发任务表", "部分具备", "范围矩阵需人工拆写；计划日期和任务可直接导入"],
  [4, "输入", "顾客要求/VOC/设计目标", "P1-I-01/P1-I-06/P1-07/P1-08", "P0主数据", "详细规范、立项报告", "部分具备", "逐条建要求对象；不能只上传一份详细规范"],
  [5, "主数据", "原材料/BOM", "P1-09", "项目主数据", "原材料清单", "部分具备", "材料名称/规格/供应商导入；检验规范/质量要求先列待确认"],
  [6, "主数据", "初始流程与特殊特性", "P1-10/P1-11", "BOM/详细规范", "初始过程流程图、特殊特性清单", "部分具备", "工序稳定ID；特性编号和识别主体人工确认"],
  [7, "风险", "产品保证/风险评估", "P1-12/P1-17", "顾客要求", "产品质量保证计划", "部分具备", "导入风险和措施；补责任人/期限"],
  [8, "设计", "DFMEA", "P2-01", "项目特性/设计目标", "DFMEA Excel", "已具备", "按结构/功能/失效链导入；AP由系统复核"],
  [9, "设计", "DVP&R", "P2-03", "设计目标/DFMEA", "验证计划、验证报告、试验记录", "已具备", "合并计划与结果；保留报告编号"],
  [10, "设计", "工程图/规范/材料规范", "P2-06/P2-07/P2-08", "设计目标", "详细规范、装配图、材料清单", "部分具备", "空图纸/空材料规范保持缺项；附件引用"],
  [11, "设计", "设备工装要求", "P2-10/P2-12", "PFD/CP需求", "设备清单/检查表、MSA计划", "部分具备", "需求与实物资产分开；不得把要求当已验收"],
  [12, "设计", "正式特殊特性", "P2-11", "P1-11/DFMEA", "阶段3特殊特性清单", "已具备", "建立项目特性对象并关联PFD/PFMEA"],
  [13, "设计", "可行性承诺/设计评审", "P2-04/P2-13", "DFMEA/DVP", "评审报告、可行性承诺", "已具备", "签署信息按历史证据引用，不代签"],
  [14, "过程", "PFD", "P3-04", "P1-10/设备要求", "产品过程流程图", "已具备", "导入10–150工序和特性；合并行向下填充"],
  [15, "过程", "PFMEA", "P3-06", "PFD/正式特性", "PFMEA Excel", "已具备", "按过程项/步骤/4M导入；原因/控制/Action分列"],
  [16, "过程", "样件/试生产控制计划", "P2-05/P3-06b", "PFD/PFMEA/特性", "样件CP、试生产CP", "已具备", "分别导入PROTO/PILOT，禁止合并成一份"],
  [17, "过程", "作业指导书/布局", "P3-05/P3-07", "PFD/CP", "工艺文件、作业指导书、布局图", "已具备", "作业指导书为附件引用；工序与PFD统一编号"],
  [18, "过程", "能力研究计划/MSA计划", "P3-08/P3-09", "CP", "初始能力计划、MSA计划", "部分具备", "MSA空白表按CP测量系统重建；能力计划导入"],
  [19, "确认", "有效生产运行/生产确认", "P4-01/P4-05", "CP/作业指导书", "生产过程确认、试验计划/报告", "部分具备", "工作令/试验报告空模板保持缺项"],
  [20, "确认", "MSA研究", "P4-02", "MSA计划", "测量系统评价报告", "部分具备", "导入原始数据和判定；无原始数据只作附件引用"],
  [21, "确认", "SPC/初始能力", "P4-03", "能力计划/真实数据", "初始过程能力评价", "已具备", "导入镍层/锡铅层/锡层数据和规格，系统重算"],
  [22, "确认", "量产控制计划", "P4-07", "试生产CP", "量产控制计划", "已具备", "导入SOP阶段并保留阶段差异"],
  [23, "确认", "PPAP 18项", "P4-04", "全部上游证据", "PPAP清单、PSW、18项表格、PDF证据包", "部分具备", "文件存在=候选；适用性和顾客批准人工确认"],
  [24, "确认", "质量策划总结/量产交接", "P4-08/P4-09", "PPAP/Gate", "质量策划总结、量产交接、文件归档清单", "已具备", "导入总结与交接，不自动推进Gate"],
  [25, "反馈", "量产反馈/经验教训", "P5-01..P5-04", "量产数据", "项目资料未提供P5闭环文件", "缺失", "暂不导入；标记缺项和责任人"],
];

const masterRows = [
  ["项目", "项目名称", "车规级RMLE(C)系列超低阻精密片式固定电阻器", "详细规范/立项报告", "已确认", ""],
  ["项目", "项目编号", "KYS2211N02", "多份项目文件", "已确认", ""],
  ["项目", "顾客", "北京经纬恒润科技股份有限公司", "DFMEA/PFMEA/PPAP清单", "已确认", ""],
  ["项目", "组织", "北京七一八友晟电子有限公司", "详细规范/PPAP PSW", "已确认", ""],
  ["项目", "产品类型", "超低阻精密片式固定电阻器", "详细规范", "已确认", ""],
  ["项目", "产品族", "PF-LOW-OHM 超低阻/采样电阻器", "系统产品字典", "已确认", "系统已有"],
  ["项目", "产品系列", "RML(C) 超低阻精密片式固定电阻器", "系统产品字典", "已确认", "系统已有"],
  ["项目", "型号", "RMLE2012C、RMLE3216C、RMLE5025C、RMLE6332C、RMLE7142C", "详细规范/多份表单", "已确认", "RML/RMLE 混用需统一显示"],
  ["项目", "详细规范", "Q/RV570-2023", "企业详细规范", "已确认", "2023-03-15 发布，2023-03-30 实施"],
  ["项目", "APQP计划周期", "2022-10-07 至 2024-04-15", "APQP计划.pdf", "已确认", "计划含阶段5，但项目证据主要到阶段4"],
  ["项目", "PPAP提交日期", "2023-11-28", "PPAP文件清单", "已确认", "提交等级为空"],
  ["团队", "项目负责人", "王晶晶；科研一所", "跨部门职能项目小组及职责表", "已确认", "联系方式在原件"],
  ["团队", "设计人员", "赵瑞、田敬雪；科研一所", "团队表", "已确认", ""],
  ["团队", "工艺负责人", "任洪芳；技术工艺部", "团队表", "已确认", ""],
  ["团队", "质量人员", "张云璐；质量管理部", "团队表", "已确认", ""],
  ["团队", "顾客代表", "胡本华；市场一部", "团队表", "已确认", ""],
  ["材料", "合金带", "厚度0.1–0.2mm；铜基/镍铬合金；两家供应商", "原材料清单", "部分确认", "检验规范与质量要求需扩展列"],
  ["材料", "散热金属带", "厚度0.1–0.2mm；铜或铝", "原材料清单", "部分确认", "供应商见原件"],
  ["材料", "隔离层浆料", "外观、绝缘性能", "初始流程图/原材料清单", "部分确认", "牌号/供应商需补"],
  ["材料", "环氧模塑料", "外观、胶化时间、螺旋流动长度、粘度", "初始流程图/原材料清单", "部分确认", "牌号/供应商需补"],
  ["材料", "电镀用磷铜球/镍冠/锡铅球", "理化性能、尺寸和数量", "初始流程图/PPAP进厂规范", "部分确认", "按牌号拆分"],
  ["工序", "10", "进厂检验", "PFD", "已确认", ""],
  ["工序", "20", "入库/贮存", "PFD", "已确认", ""],
  ["工序", "30", "电阻芯片加工", "PFD", "已确认", ""],
  ["工序", "40", "电阻芯片带检验", "PFD", "已确认", ""],
  ["工序", "50", "散热芯片加工", "PFD", "已确认", ""],
  ["工序", "60", "隔离层印刷", "PFD", "已确认", ""],
  ["工序", "70", "塑封", "PFD", "已确认", ""],
  ["工序", "80", "塑封检验", "PFD", "已确认", ""],
  ["工序", "90", "打标", "PFD", "已确认", ""],
  ["工序", "100", "分粒", "PFD", "已确认", ""],
  ["工序", "110", "电镀", "PFD", "已确认", ""],
  ["工序", "120", "电镀检验", "PFD", "已确认", ""],
  ["工序", "130", "测量分选", "PFD", "已确认", ""],
  ["工序", "140", "质量一致性检验", "PFD", "已确认", ""],
  ["工序", "150", "包装", "PFD", "已确认", ""],
  ["特殊特性", "10 尺寸", "与标称值偏差±5%，最大厚度偏差≤10μm；Z", "阶段3特殊特性清单", "已确认", "产品特性"],
  ["特殊特性", "10 电阻率", "阻值偏差≤±10%；Z", "特殊特性清单", "已确认", "产品特性"],
  ["特殊特性", "10 温度系数", "满足成品要求；Z", "特殊特性清单", "部分确认", "规范需从详细规范补齐"],
  ["特殊特性", "30 阻值", "Z", "特殊特性清单", "部分确认", "规格空白"],
  ["特殊特性", "30 材料选择", "6J40/6J23/6J12；Z", "特殊特性清单", "已确认", "过程特性"],
  ["特殊特性", "30 切割速度", "3–4 m/min；Z", "特殊特性清单", "已确认", "过程特性"],
  ["特殊特性", "70 尺寸/塑封参数", "尺寸Z；185±10℃、6.5–9.5MPa、100–110s；Z", "特殊特性清单", "已确认", "过程特性"],
  ["特殊特性", "100 安全控制", "模具选择；G", "特殊特性清单", "已确认", "安全/关键特性"],
  ["能力研究", "镍层厚度", "规格3–16；Pp≈3.814；Ppk≈1.666", "初始过程能力评价.xlsx", "可导入", "系统需重算"],
  ["能力研究", "锡铅层厚度", "规格2.5–13；Pp≈2.164；Ppk≈1.669", "初始过程能力评价.xlsx", "可导入", "系统需重算"],
  ["能力研究", "锡层厚度", "规格2.5–13；Pp≈2.527；Ppk≈1.671", "初始过程能力评价.xlsx", "可导入", "系统需重算"],
];

const ppapCandidatePatterns = {
  1: [/详细规范/, /装配图/, /原材料清单/],
  2: [/临时变更清单/, /更改单/],
  3: [/顾客.*批准/, /偏差/],
  4: [/DFMEA/],
  5: [/过程流程图/],
  6: [/PFMEA|PFAMA/],
  7: [/量产控制计划/],
  8: [/测量系统分析计划/, /测量系统评价报告/],
  9: [/尺寸检测结果/, /PPAP表格/, /鉴定.*报告/],
  10: [/材料试验结果/, /性能试验结果/, /试验.*报告/, /进厂检验规范/],
  11: [/初始过程能力评价/, /初始过程能力.*报告/],
  12: [/实验室|资质|认可/],
  13: [/AAR|外观批准/],
  14: [/样品|工作令|生产确认/],
  15: [/封样|标准样品/],
  16: [/检具/, /设备、工装和试验设备清单/],
  17: [/详细规范/, /顾客输入/],
  18: [/PSW/, /PPAP文件清单/],
};

const ppapRows = PPAP.map(item => {
  const patterns = ppapCandidatePatterns[item.no] || [];
  const candidates = inventory.filter(row =>
    !["Office锁文件", "空白模板"].includes(row["文件类别"]) &&
    patterns.some(pattern => pattern.test(row["相对路径"]))
  ).slice(0, 6);
  const judgement =
    [1, 4, 5, 6, 7, 8, 10, 11, 14, 16].includes(item.no) ? "有候选证据，待质量确认" :
      [2, 9, 17, 18].includes(item.no) ? "部分证据，需核对适用性和批准" :
        "待确认/可能缺项";
  const gap =
    item.no === 3 ? "未找到顾客工程批准/偏差文件；原PPAP清单可能标否，需确认适用性" :
      item.no === 12 ? "未找到独立实验室资质和认可范围文件" :
        item.no === 13 ? "AAR表格存在但未见完整外观批准" :
          item.no === 15 ? "未找到标准样品封样记录" :
            item.no === 18 ? "PSW存在，提交等级和顾客批准未完成确认" :
              item.evidenceItems.filter(Boolean).join("；");
  return [
    item.no,
    item.sourceLabel,
    item.rule,
    candidates.map(row => row["相对路径"]).join("\n"),
    judgement,
    gap,
  ];
});

const workbook = Workbook.create();
const fontName = "Arial";

function addSheet(name, title, subtitle, headers, rows, widths, options = {}) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  sheet.tabColor = options.tabColor || "#355C8A";
  const lastColumn = String.fromCharCode(64 + headers.length);
  sheet.getRange(`A1:${lastColumn}1`).merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange("A1").format.font = { name: fontName, size: 14, bold: true, color: "#000000" };
  sheet.getRange("A1").format.verticalAlignment = "center";
  sheet.getRange("A1").format.rowHeight = 26;
  sheet.getRange(`A2:${lastColumn}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange("A2").format.font = { name: fontName, size: 9.5, italic: true, color: "#4B5768" };
  sheet.getRange("A2").format.wrapText = true;
  sheet.getRange("A2").format.rowHeight = 30;
  sheet.getRange(`A4:${lastColumn}4`).values = [headers];
  sheet.getRange(`A4:${lastColumn}4`).format = {
    fill: "#16263D",
    font: { name: fontName, size: 10, bold: true, color: "#FFFFFF" },
    borders: { preset: "all", style: "thin", color: "#FFFFFF" },
    verticalAlignment: "center",
    horizontalAlignment: "center",
    wrapText: true,
  };
  sheet.getRange(`A4:${lastColumn}4`).format.rowHeight = 30;
  if (rows.length) {
    sheet.getRange(`A5:${lastColumn}${4 + rows.length}`).values = rows;
    sheet.getRange(`A5:${lastColumn}${4 + rows.length}`).format = {
      font: { name: fontName, size: 9.5, color: "#1B2430" },
      verticalAlignment: "top",
      wrapText: true,
      borders: { preset: "all", style: "thin", color: "#E4E9F0" },
    };
    sheet.getRange(`A5:${lastColumn}${4 + rows.length}`).format.rowHeight = options.rowHeight || 28;
  }
  widths.forEach((width, index) => {
    const column = String.fromCharCode(65 + index);
    sheet.getRange(`${column}:${column}`).format.columnWidth = width;
  });
  sheet.freezePanes.freezeRows(4);
  if (options.tableName) {
    sheet.tables.add(`A4:${lastColumn}${Math.max(4 + rows.length, 5)}`, true, options.tableName);
  }
  return sheet;
}

const phaseCounts = Object.entries(
  inventory.reduce((acc, row) => {
    acc[row["阶段目录"]] = (acc[row["阶段目录"]] || 0) + 1;
    return acc;
  }, {}),
);

const statusCounts = apqpRows.reduce((acc, row) => {
  acc[row[8]] = (acc[row[8]] || 0) + 1;
  return acc;
}, {});

const infoRows = [
  ["审计对象", "车规级RMLE(C)系列超低阻精密片式固定电阻器"],
  ["项目编号", "KYS2211N02"],
  ["顾客", "北京经纬恒润科技股份有限公司"],
  ["项目资料目录", projectRoot],
  ["审计日期", "2026-11-02"],
  ["文件总数", String(inventory.length)],
  ["资料总大小", `${(inventory.reduce((sum, row) => sum + row["大小KB"], 0) / 1024).toFixed(2)} MB`],
  ["阶段分布", phaseCounts.map(([key, value]) => `${key} ${value}`).join("；")],
  ["文件格式", Object.entries(inventory.reduce((acc, row) => { acc[row["扩展名"]] = (acc[row["扩展名"]] || 0) + 1; return acc; }, {})).map(([key, value]) => `${key} ${value}`).join("；")],
  ["重复组", "19 组（哈希完全相同）"],
  ["Office锁文件", "10 个（审计排除）"],
  ["零字节模板", "7 个（需补件）"],
  ["旧版Office转换", "34 个成功；1 个工作令卡因安全检查失败"],
  ["APQP状态统计", Object.entries(statusCounts).map(([key, value]) => `${key} ${value}`).join("；")],
  ["审计范围", "文件清点、APQP/PPAP对标、字段映射、填写指引、缺口与导入顺序"],
  ["不在范围", "扫描图纸尺寸识别、手写签名识别、向现有业务数据库写入、系统自动审批"],
  ["导入原则", "先审计后导入；只导入可追溯事实；空白待确认；不自动签名/批准；原文件不变"],
  ["状态定义-已具备", "有直接且可读取的项目证据，但仍需核对版本和签署"],
  ["状态定义-部分具备", "有相关证据，但字段、版本、审批或结构不完整"],
  ["状态定义-仅计划", "只存在于计划、空表或未执行模板中"],
  ["状态定义-缺失", "未找到直接证据，或文件为零字节/无法解析"],
  ["状态定义-待确认", "可由多处资料推导但缺少明确业务声明，必须人工决定"],
];

const sheet00 = workbook.worksheets.add("00_说明");
sheet00.showGridLines = false;
sheet00.tabColor = "#0E1A2B";
sheet00.getRange("A1:C1").merge();
sheet00.getRange("A1").values = [["RMLE(C) 项目—APQP—系统差异与导入指引"]];
sheet00.getRange("A1").format.font = { name: fontName, size: 15, bold: true, color: "#000000" };
sheet00.getRange("A1").format.rowHeight = 30;
sheet00.getRange("A2:C2").merge();
sheet00.getRange("A2").values = [["只读审计快照。文件存在只表示证据候选，不表示已批准、已有效或顾客已接受。"]];
sheet00.getRange("A2").format.font = { name: fontName, size: 10, italic: true, color: "#4B5768" };
sheet00.getRange("A2").format.wrapText = true;
sheet00.getRange("A2").format.rowHeight = 28;
sheet00.getRange("A4:C4").values = [["项目", "内容", "说明"]];
sheet00.getRange("A4:C4").format = {
  fill: "#16263D",
  font: { name: fontName, size: 10, bold: true, color: "#FFFFFF" },
  borders: { preset: "all", style: "thin", color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
sheet00.getRange(`A5:C${4 + infoRows.length}`).values = infoRows.map(([key, value]) => [key, value, ""]);
sheet00.getRange(`A5:C${4 + infoRows.length}`).format = {
  font: { name: fontName, size: 9.5, color: "#1B2430" },
  wrapText: true,
  verticalAlignment: "top",
  borders: { preset: "all", style: "thin", color: "#E4E9F0" },
};
sheet00.getRange("A:A").format.columnWidth = 24;
sheet00.getRange("B:B").format.columnWidth = 95;
sheet00.getRange("C:C").format.columnWidth = 35;
sheet00.freezePanes.freezeRows(4);

addSheet(
  "01_文件总账",
  "文件总账",
  "全部 177 个文件逐项登记；锁文件、空白模板、重复副本和解析状态均单独标识。",
  headersBySheet["01_文件总账"],
  inventory.map(row => headersBySheet["01_文件总账"].map(header => row[header] ?? "")),
  [7, 10, 45, 35, 8, 10, 68, 10, 16, 18, 12, 20, 40, 55, 55, 16, 24],
  { tableName: "RmleFileInventory", rowHeight: 24 },
);

const sheet02 = addSheet(
  "02_APQP对标",
  "APQP 第三版与系统交付物对标",
  "覆盖系统 68 项目录。状态依据项目证据候选生成，审批有效性需责任人确认。",
  headersBySheet["02_APQP对标"],
  apqpRows,
  [10, 18, 10, 30, 24, 20, 10, 55, 12, 55, 40],
  { tableName: "RmleApqpComparison", rowHeight: 30 },
);
sheet02.getRange(`I5:I${4 + apqpRows.length}`).conditionalFormats.add("containsText", {
  text: "缺失",
  format: { fill: "#FDE2E2", font: { bold: true, color: "#B91C1C" } },
});
sheet02.getRange(`I5:I${4 + apqpRows.length}`).conditionalFormats.add("containsText", {
  text: "部分具备",
  format: { fill: "#FEF3C7", font: { color: "#92400E" } },
});
sheet02.getRange(`I5:I${4 + apqpRows.length}`).conditionalFormats.add("containsText", {
  text: "已具备",
  format: { fill: "#DCFCE7", font: { color: "#166534" } },
});

addSheet(
  "03_字段映射",
  "关键字段映射",
  "列出已确认与待确认的字段转换。系统暂不支持的字段只能保留证据或扩展列，不能塞入备注冒充等价字段。",
  headersBySheet["03_字段映射"],
  manualMappings,
  [9, 28, 18, 24, 45, 28, 28, 16, 55, 10, 12, 40],
  { tableName: "RmleFieldMappings", rowHeight: 30 },
);

const sheet04 = addSheet(
  "04_交付物填写指引",
  "交付物字段填写指引",
  "覆盖 49 个表单的所有字段与表格列，并补充 9 个系统模块的关键业务字段。",
  headersBySheet["04_交付物填写指引"],
  fieldGuideRows,
  [18, 16, 28, 20, 26, 15, 20, 58, 42, 30, 38, 32],
  { tableName: "RmleFieldGuide", rowHeight: 27 },
);
sheet04.getRange(`G5:G${4 + fieldGuideRows.length}`).conditionalFormats.add("containsText", {
  text: "必填",
  format: { fill: "#FEF3C7", font: { color: "#92400E" } },
});

const sheet05 = addSheet(
  "05_缺口与冲突",
  "项目资料缺口与冲突",
  "优先级 P0 表示阻碍完整导入或PPAP判断；P1 表示关键业务字段缺口；P2/P3 为版本、格式和归档问题。",
  headersBySheet["05_缺口与冲突"],
  gapRows,
  [10, 22, 8, 32, 55, 55, 38, 50, 12],
  { tableName: "RmleGapRegister", rowHeight: 30 },
);
sheet05.getRange(`C5:C${4 + gapRows.length}`).conditionalFormats.add("containsText", {
  text: "P0",
  format: { fill: "#FDE2E2", font: { bold: true, color: "#B91C1C" } },
});
sheet05.getRange(`C5:C${4 + gapRows.length}`).conditionalFormats.add("containsText", {
  text: "P1",
  format: { fill: "#FEF3C7", font: { color: "#92400E" } },
});

addSheet(
  "06_导入顺序",
  "导入顺序与依赖",
  "先主数据和质量要求，再设计/过程分析，最后CP、MSA、SPC和PPAP。",
  headersBySheet["06_导入顺序"],
  importOrder,
  [7, 12, 26, 28, 30, 55, 12, 55],
  { tableName: "RmleImportOrder", rowHeight: 32 },
);

addSheet(
  "07_关键主数据",
  "RMLE(C) 关键主数据",
  "可直接作为新项目草稿的基础数据；部分值仍需责任人确认。",
  headersBySheet["07_关键主数据"],
  masterRows,
  [16, 24, 80, 48, 12, 40],
  { tableName: "RmleMasterData", rowHeight: 28 },
);

const sheet08 = addSheet(
  "08_PPAP证据",
  "PPAP 18 项证据对标",
  "文件存在仅表示候选证据；适用性、完成状态、PSW签署和顾客批准必须分别确认。",
  headersBySheet["08_PPAP证据"],
  ppapRows,
  [7, 30, 60, 65, 24, 60],
  { tableName: "RmlePpapEvidence", rowHeight: 45 },
);
sheet08.getRange(`E5:E${4 + ppapRows.length}`).conditionalFormats.add("containsText", {
  text: "待确认",
  format: { fill: "#FEF3C7", font: { color: "#92400E" } },
});

workbook.recalculate();

const outDir = path.dirname(outputPath);
await fs.mkdir(outDir, { recursive: true });
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 10000,
  tableMaxRows: 4,
  tableMaxCols: 8,
  tableMaxCellChars: 70,
});
console.log(summary.ndjson);
console.log(JSON.stringify({
  output: outputPath,
  files: inventory.length,
  apqp: apqpRows.length,
  mappings: manualMappings.length,
  fieldGuide: fieldGuideRows.length,
  gaps: gapRows.length,
  importOrder: importOrder.length,
  ppap: ppapRows.length,
}, null, 2));
