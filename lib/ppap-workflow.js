'use strict';

/**
 * PPAP 18 项与 APQP 阶段/上游对象的初始关联草案。
 * 这里只定义“应该从哪里取证”，是否完成仍由质量人员确认。
 */
const items = [
  {
    no: 1, phase: 'P1-P3', sourceType: 'docs', sourceCodes: ['P2-06', 'P2-08'],
    sourceLabel: '设计记录 / 工程图纸 / 材料规范', owner: '设计、项目',
    rule: '顾客图纸、零件图和规范应处于已批准版本，并与 BOM、特殊特性一致。',
  },
  {
    no: 2, phase: 'P2-P3', sourceType: 'docs', sourceCodes: ['P2-09'],
    sourceLabel: '工程变更记录 / ECR', owner: '设计、变更负责人',
    rule: '所有已实施变更都应有日期、批准人、影响分析和对应版本。',
  },
  {
    no: 3, phase: 'P1-P2', sourceType: 'manual',
    sourceLabel: '顾客书面批准 / 偏差许可', owner: '项目经理',
    rule: '需要顾客工程批准的文件必须取得顾客书面证据；不适用时需记录理由。',
  },
  {
    no: 4, phase: 'P2', sourceType: 'fmea', fmeaType: 'DFMEA',
    sourceLabel: 'DFMEA', owner: '设计',
    rule: 'DFMEA 应已发布，高风险项已有关闭决定。',
  },
  {
    no: 5, phase: 'P3', sourceType: 'pfd',
    sourceLabel: '过程流程图 PFD', owner: '工艺',
    rule: 'PFD 工序已发布，并与 PFMEA、控制计划工序号一致。',
  },
  {
    no: 6, phase: 'P3', sourceType: 'fmea', fmeaType: 'PFMEA',
    sourceLabel: 'PFMEA', owner: '工艺、质量',
    rule: 'PFMEA 应已发布，结构、功能和失效链完整，高 AP 项已闭环。',
  },
  {
    no: 7, phase: 'P3-P4', sourceType: 'cp', cpStage: 'SOP',
    sourceLabel: '生产控制计划', owner: '工艺',
    rule: '量产控制计划已批准、已生效，并与 PFMEA、PFD、SPC 监控特性一致。',
  },
  {
    no: 8, phase: 'P3-P4', sourceType: 'msa',
    sourceLabel: 'MSA 计划 / GR&R 研究', owner: '质量、计量',
    rule: 'MSA 计划中的每个测量系统均已完成研究，综合判定为接受并由责任人确认完成。',
  },
  {
    no: 9, phase: 'P4', sourceType: 'docs', sourceCodes: ['P4-01', 'P4-05'],
    sourceLabel: '全尺寸结果 / 有效生产运行', owner: '质量',
    rule: '全尺寸报告覆盖图纸和规范要求，样本来自有效生产运行。',
  },
  {
    no: 10, phase: 'P2-P4', sourceType: 'docs', sourceCodes: ['P2-03', 'P4-05'],
    sourceLabel: '材料与性能试验结果', owner: '质量、实验室',
    rule: '材料、性能和可靠性试验项目、方法、样本和判定均有结果证据。',
  },
  {
    no: 11, phase: 'P4', sourceType: 'spc',
    sourceLabel: '初始过程能力研究', owner: '质量',
    rule: '已批准 SPC 特性具有有效数据，Cpk/Ppk 达到项目或顾客要求。',
  },
  {
    no: 12, phase: 'P2-P4', sourceType: 'manual',
    sourceLabel: '合格实验室文件', owner: '实验室',
    rule: '单独引用实验室资质、认可范围及有效期；生产确认测试结果不能替代实验室资格证据。',
  },
  {
    no: 13, phase: 'P4', sourceType: 'manual',
    sourceLabel: '外观批准报告 AAR', owner: '质量、顾客',
    rule: '有外观要求时单独引用 AAR 及顾客批准；包装评价不能替代外观批准，不适用时记录判定理由。',
  },
  {
    no: 14, phase: 'P4', sourceType: 'docs', sourceCodes: ['P4-01'],
    sourceLabel: '生产件样品', owner: '生产、质量',
    rule: '样品来自正式生产工装、过程、人员和节拍。',
  },
  {
    no: 15, phase: 'P3-P4', sourceType: 'manual',
    sourceLabel: '标准样品 / 封样记录', owner: '质量',
    rule: '标准样品的标识、保存、有效期和批准状态受控。',
  },
  {
    no: 16, phase: 'P2-P4', sourceType: 'gauge',
    sourceLabel: '检具清单 / 校准记录', owner: '计量',
    rule: '用于 PPAP 和 SPC 的检具均已登记、校准有效，并有 MSA 状态。',
  },
  {
    no: 17, phase: 'P1-P4', sourceType: 'manual',
    sourceLabel: '顾客特殊要求 CSR 清单与证据', owner: '项目经理、质量',
    rule: '顾客特殊要求已逐条识别、落实并保留符合性证据。',
  },
  {
    no: 18, phase: 'P4', sourceType: 'manual',
    sourceLabel: 'PSW / 提交等级 / 批准记录', owner: '质量经理',
    rule: 'PSW 的等级、声明、批准人和日期完整，所有适用 PPAP 要素可追溯。',
  },
];

const EVIDENCE = {
  1: ['受控设计记录清单', '顾客图纸/零件图批准版本', '材料与工程规范', 'BOM 与图纸版本一致性确认'],
  2: ['ECR/ECN 清单', '每项变更的批准记录', '变更影响分析', '变更后文件版本与实施日期'],
  3: ['顾客书面批准或偏差许可', '顾客批准人/日期', '不适用时的批准理由'],
  4: ['最终发布 DFMEA', '结构/功能/失效链完整性检查', '高 AP 项关闭决定', 'DFMEA 版本和批准人'],
  5: ['最终发布 PFD', '工序号与版本', 'PFD/PFMEA/CP 工序一致性检查', '变更记录'],
  6: ['最终发布 PFMEA', '措施和关闭证据', '高 AP 项关闭决定', 'PFMEA 版本和批准人'],
  7: ['SOP 生产控制计划', '控制计划批准和生效日期', '特殊特性、SPC 和反应计划', '与 PFMEA/PFD 一致性检查'],
  8: ['P3-08 MSA 计划', 'GR&R 原始数据', '量具分辨力和校准证据', 'MSA 判定及完成确认人'],
  9: ['全尺寸检验报告', '样本来源和数量', '图纸版本和尺寸覆盖清单', '判定结果'],
  10: ['材料/性能试验报告', '适用规范和试验方法', '样本、条件和结果', '实验室与批准人'],
  11: ['初始过程能力计划', '控制图和原始数据', 'Cpk/Ppk 计算与目标对比', '异常点及反应措施'],
  12: ['实验室资质和范围', '试验方法有效性', '设备校准状态', '报告批准人'],
  13: ['外观件清单', 'AAR 批准记录', '颜色/纹理/光泽等外观标准', '不适用理由'],
  14: ['正式生产样品清单', '取样日期和批次', '工装/过程/节拍说明', '样品与检验结果'],
  15: ['标准样品编号', '封样批准记录', '保存条件和有效期', '变更或失效处理记录'],
  16: ['检具清单', '校准证书和到期日', '量具分辨力/量程', 'MSA 和 SPC 使用关系'],
  17: ['顾客特殊要求逐条清单', '落实位置和责任', '符合性证据', '顾客确认或豁免记录'],
  18: ['PSW 签批文件', '提交等级', '适用性声明', '批准人、日期和顾客批准记录'],
};

for (const item of items) item.evidenceItems = EVIDENCE[item.no] || [];

module.exports = items;
