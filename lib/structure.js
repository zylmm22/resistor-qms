'use strict';
/**
 * 系统信息架构（对照商业 APQP 系统的「模块 → 阶段 → 功能页」三级菜单）
 * target:
 *   { type:'doc',    code }   —— 打开对应交付物模板
 *   { type:'module', id, arg }—— 跳转到专业工具（fmea/pfd/cp/spc/msa/ppap）
 *   { type:'page',   id }     —— 跳到本系统实现的页面
 *   { type:'planned' }        —— 规划中（对照商业系统存在，本系统尚未实现）
 */

const PHASE_TABS = {
  0: [
    { name: '组建小组', target: { type: 'doc', code: 'P0-01' } },
    { name: '确定范围', target: { type: 'doc', code: 'P0-02' } },
    { name: '供应商来源与风险评估', target: { type: 'doc', code: 'P0-05' } },
    { name: '进度计划 5T', target: { type: 'doc', code: 'P0-10' } },
    { name: 'APQP 风险因素检查', target: { type: 'doc', code: 'A-01' } },
    { name: '采购检查', target: { type: 'doc', code: 'A-10' } },
    { name: '核心交付物关系', target: { type: 'page', id: 'tree' } },
    { name: '交付物管理', target: { type: 'page', id: 'phase-docs' } },
  ],
  1: [
    { name: '项目立项', target: { type: 'doc', code: 'P0-01' } },
    { name: 'CSR 管理', target: { type: 'doc', code: 'P1-I-06' } },
    { name: '设计目标', target: { type: 'doc', code: 'P1-07' } },
    { name: '可靠性质量目标', target: { type: 'doc', code: 'P1-08' } },
    { name: '初始 BOM', target: { type: 'doc', code: 'P1-09' } },
    { name: '初始流程图', target: { type: 'module', id: 'pfd', arg: 'INITIAL' } },
    { name: '初始特殊特性', target: { type: 'doc', code: 'P1-11' } },
    { name: '产能规划', target: { type: 'doc', code: 'P1-13' } },
    { name: '变更管理', target: { type: 'doc', code: 'P1-15' } },
    { name: 'APQP 项目指标', target: { type: 'doc', code: 'P1-16' } },
    { name: '风险缓解计划', target: { type: 'doc', code: 'P1-17' } },
    { name: '交付物管理', target: { type: 'page', id: 'phase-docs' } },
  ],
  2: [
    { name: '设计规范', target: { type: 'doc', code: 'P2-07' } },
    { name: 'DFMEA 分析', target: { type: 'module', id: 'fmea', arg: 'DFMEA' } },
    { name: 'DFMEA-DVP&R 闭环', target: { type: 'planned' } },
    { name: 'DVP&R 验证', target: { type: 'doc', code: 'P2-03' } },
    { name: '设计评审', target: { type: 'doc', code: 'P2-04' } },
    { name: 'BOM 管理', target: { type: 'doc', code: 'P1-09' } },
    { name: '材料规范', target: { type: 'doc', code: 'P2-08' } },
    { name: '特殊特性', target: { type: 'doc', code: 'P2-11' } },
    { name: 'DFM/DFA 评分', target: { type: 'doc', code: 'P2-02' } },
    { name: '交付物管理', target: { type: 'page', id: 'phase-docs' } },
  ],
  3: [
    { name: '过程流程图', target: { type: 'module', id: 'pfd', arg: 'PROCESS' } },
    { name: 'PFMEA 分析', target: { type: 'module', id: 'fmea', arg: 'PFMEA' } },
    { name: 'PFMEA-CP 闭环', target: { type: 'module', id: 'cp' } },
    { name: '特殊特性清单', target: { type: 'doc', code: 'P2-11' } },
    { name: '控制计划', target: { type: 'module', id: 'cp' } },
    { name: '作业指导书 SOP', target: { type: 'doc', code: 'P3-07' } },
    { name: 'MSA 详细计划', target: { type: 'doc', code: 'P3-08' } },
    { name: 'Ppk 能力研究计划', target: { type: 'doc', code: 'P3-09' } },
    { name: '采购检查', target: { type: 'doc', code: 'A-10' } },
    { name: '包装符合性声明', target: { type: 'doc', code: 'P3-02' } },
    { name: '交付物管理', target: { type: 'page', id: 'phase-docs' } },
  ],
  4: [
    { name: 'PPAP 提交', target: { type: 'module', id: 'ppap' } },
    { name: '全尺寸测量', target: { type: 'doc', code: 'P4-05' } },
    { name: 'MSA 分析', target: { type: 'module', id: 'msa' } },
    { name: 'SPC 控制', target: { type: 'module', id: 'spc' } },
    { name: '试生产报告', target: { type: 'doc', code: 'P4-01' } },
    { name: '包装评价', target: { type: 'doc', code: 'P4-06' } },
    { name: '生产控制计划', target: { type: 'module', id: 'cp' } },
    { name: '质量策划签发', target: { type: 'doc', code: 'P4-08' } },
    { name: '交付物管理', target: { type: 'page', id: 'phase-docs' } },
  ],
  5: [
    { name: '持续改进', target: { type: 'planned' } },
    { name: '经验教训', target: { type: 'doc', code: 'P5-04' } },
    { name: '客户满意度', target: { type: 'planned' } },
    { name: '年度复审', target: { type: 'planned' } },
    { name: '交付物管理', target: { type: 'page', id: 'phase-docs' } },
  ],
};

const GATE_CRITERIA_VERSION = 'APQP3-GATE-2026-11';

/** Appendix B Gate 0-5 review headings; approval remains an authorized human decision. */
const GATES = [
  { no: 0, name: '概念启动/批准', criteria: [
    '团队职责、顾客/供应商参与、高风险及初步可行性已评估；未接受项有措施',
    '项目时间计划覆盖里程碑、责任、资源和产能评估',
    '领导支持、项目指标、采购/供应商评估及适用经验教训已纳入结果记录',
  ] },
  { no: 1, name: '项目批准', criteria: [
    'Gate 0 评估项已有可接受结论；待定项有完成日期和措施计划',
    'VOC/CSR、设计目标、可靠性/质量目标及初始产品/过程范围已策划',
    'BOM、初始流程、初始特殊特性、产品保证及风险缓解输出已准备',
    '变更管理日志和经验教训实施已评审；未结项有责任人和计划日期',
  ] },
  { no: 2, name: '设计可行性', criteria: [
    'DFMEA、DFM/DFA/服务设计、设计验证和设计评审已评估并处置未结项',
    '原型控制计划及图纸、工程/材料规范评审已完成；待定规范有措施',
    '客户识别与组织新增特殊特性已分别计数、分类并记录分类共识/顾客同意',
    '设备/工装/量具和供应商设计要求已评估；可行性及经验教训已签署',
  ] },
  { no: 3, name: '过程可行性', criteria: [
    '质量体系差距、PFD 和布局已评审，物流/过程范围相互一致',
    'PFMEA 使用 DFMEA 与流程图完成分析，控制建议和未结项可追溯',
    '试生产控制计划、过程说明书及需要的安全投产控制已策划并获适用批准',
    'MSA/初始能力计划覆盖控制计划要求；供应商过程准备有结论和措施',
  ] },
  { no: 4, name: '生产准备就绪', criteria: [
    '有效生产运行使用生产工装、设备、人员、环境、设施、量具和生产速率；控制计划检查已执行',
    '所有适用测量系统在有效运行前完成 MSA，特殊特性能力研究有真实生产数据',
    '生产控制计划、作业指导书、PFD、PFMEA 一致；未关闭问题有处置及签发依据',
    '生产确认、包装、PPAP、供应商准备和安全投产/退出准则已按适用性确认',
  ] },
  { no: 5, name: '反馈评估与纠正措施', criteria: [
    '量产绩效同时评估特殊原因和普通原因变差，改进建议含成本、时间和预期效果',
    '顾客满意度、保修/现场问题和交付问题已遏制、纠正并评估顾客通知/PPAP影响',
    '本阶段经验教训、防错方案已归档、横向展开评估并形成未结事项措施',
  ] },
];

/** 对标商业系统的模块级差距（用于「功能增减」决策与看板展示） */
const MODULES = [
  { id: 'dash', name: '项目总览', status: 'done', note: '项目 KPI + 健康度评分 + Gate 准时率' },
  { id: 'alerts', name: '预警中心', status: 'done', note: 'FMEA 高风险 / 待审批 / Gate 待评审 / 进度偏差' },
  { id: 'phases', name: '阶段管理（三级页签）', status: 'done', note: 'Phase 0–5 + 功能页签' },
  { id: 'gate', name: '门径评审 Gate 0–5', status: 'done', note: '评审记录 + 通过/驳回 + 准时率' },
  { id: 'gantt', name: '甘特图', status: 'partial', note: '交付物计划条（简化版）' },
  { id: 'ecr', name: '变更管理 ECR/ECO', status: 'done', note: '变更单 + 影响清单 + 审批状态' },
  { id: 'fmea', name: '专业工具：DFMEA/PFMEA', status: 'done', note: '七步法 + AP 矩阵' },
  { id: 'cp', name: '专业工具：控制计划', status: 'done', note: '自动映射 + 试生产/量产' },
  { id: 'spc', name: '专业工具：SPC', status: 'done', note: 'X̄-R + Cpk/Ppk' },
  { id: 'msa', name: '专业工具：MSA', status: 'done', note: 'GR&R 均值极差法' },
  { id: 'ppap', name: '专业工具：PPAP', status: 'done', note: '18 项 + 打包哈希' },
  { id: 'sop', name: 'SOP / SIP 自动生成', status: 'planned', note: '从控制计划一键生成作业/检验指导书' },
  { id: 'runrate', name: 'Run@Rate 产能验证', status: 'planned', note: '节拍、瓶颈与爬坡分析' },
  { id: 'supplier', name: '供应商 VDA6.3', status: 'planned', note: '供应商评估与不符合项跟踪' },
  { id: 'report', name: '报表中心', status: 'planned', note: '多维报表与图表导出' },
  { id: 'rbac', name: '用户与权限', status: 'planned', note: '5 类角色 + 对象级权限' },
];

module.exports = { PHASE_TABS, GATES, GATE_CRITERIA_VERSION, MODULES };
