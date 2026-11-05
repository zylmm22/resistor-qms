'use strict';
/**
 * 人员权限内核（零依赖）
 *
 * 三层授权：
 *   ① 项目范围  scope: 'all' 全部项目 / 'member' 仅参与项目
 *   ② 模块动作  权限点（edit / approve / manage）
 *   ③ 交付物归属 交付物目录 owner → 角色
 *
 * 兼容：admin / engineer / quality / auditor 四个历史角色保留，
 *       admin 全权；engineer、quality 视为“历史兼容角色”，模块内可编辑全部内容，
 *       但交付物仍按 owner 归属校验（避免越部门改稿）。auditor 只读。
 */

/* 权限点：<模块>.<动作> */
const PERMISSIONS = {
  // 交付物
  'doc.edit': '编制交付物',
  'doc.approve': '批准 / 退回交付物',
  'doc.complete': '标记交付物完成',
  'doc.manage': '新建 / 改名 / 隐藏交付物',
  // 门径
  'gate.fill': '填写 Gate 检查表',
  'gate.decide': '出具 Gate 评审结论',
  // 质量工具
  'fmea.edit': '编辑 FMEA',
  'fmea.approve': '批准 / 发布 FMEA',
  'cp.edit': '编辑控制计划',
  'cp.approve': '批准控制计划',
  'spc.edit': '录入 / 维护 SPC',
  'spc.review': '审核 SPC 监控项',
  'msa.edit': '编制 MSA 研究',
  'msa.void': '作废 MSA 研究',
  'msa.gauge.edit': '维护检具台账与校准',
  'msa.assess': '测量能力评定',
  'ppap.edit': '维护 PPAP 证据',
  'ppap.approve': '批准 PPAP',
  // 基础数据
  'dict.edit': '维护工序 / 特性 / 产品族字典',
  'pfd.edit': '维护过程流程图',
  'apmatrix.manage': '维护 AP 矩阵与等级规则',
  'template.edit': '编制交付物模板',
  'template.approve': '批准模板与字段映射',
  // 采购与设备
  'purchase.edit': '维护供应商 / 外包方',
  'equipment.edit': '维护设备 / 工装 / 备件',
  'facility.edit': '维护环境与设施（温湿度 / 洁净度 / 水电气 / 纯水）',
  // 变更与版本
  'ecr.edit': '发起 / 编辑工程变更',
  'ecr.approve': '批准 / 关闭工程变更',
  'baseline.freeze': '冻结基线',
  'activity.request': '申请活动审批',
  'activity.approve': '审批活动',
  // 系统
  'project.manage': '新建 / 删除项目、配置项目成员',
  'user.manage': '账号与权限管理',
  'backup.manage': '数据库备份与重算',
};

/* 角色：名称、部门、项目范围、权限点 */
const ROLES = {
  admin: {
    name: '系统管理员', department: '办公室', scope: 'all', legacy: true,
    permissions: ['*'],
  },
  gm: {
    name: '总经理', department: '总经理', scope: 'all',
    permissions: ['gate.fill', 'gate.decide', 'doc.edit', 'doc.approve', 'doc.complete',
      'ppap.approve', 'baseline.freeze'],
  },
  chief: {
    name: '总工', department: '总工', scope: 'all',
    permissions: ['gate.fill', 'gate.decide', 'doc.edit', 'doc.approve', 'doc.complete',
      'fmea.approve', 'cp.approve', 'ecr.approve', 'ppap.approve', 'baseline.freeze'],
  },
  mgmt_rep: {
    name: '管理者代表', department: '管理者代表', scope: 'all',
    permissions: ['gate.fill', 'gate.decide', 'doc.edit', 'doc.approve', 'doc.complete',
      'fmea.approve', 'cp.approve', 'spc.review', 'msa.void', 'msa.assess',
      'ppap.approve', 'template.approve', 'ecr.approve', 'baseline.freeze'],
  },
  vp_tech: {
    name: '技术副总经理', department: '技术副总经理', scope: 'all', board: 'tech',
    permissions: ['gate.fill', 'doc.approve', 'doc.complete', 'fmea.approve', 'cp.approve'],
  },
  vp_safety: {
    name: '安全生产副总经理', department: '安全生产副总经理', scope: 'all', board: 'safety',
    permissions: ['gate.fill', 'doc.approve', 'doc.complete', 'spc.review', 'facility.edit'],
  },
  vp_ops: {
    name: '副总经理（市场/工艺/科技）', department: '副总经理', scope: 'all', board: 'ops',
    permissions: ['gate.fill', 'doc.approve', 'doc.complete', 'cp.approve', 'fmea.approve',
      'template.approve'],
  },
  vp_admin: {
    name: '行政财务副总经理', department: '行政财务副总经理', scope: 'all', board: 'admin',
    permissions: ['gate.fill', 'doc.approve', 'doc.complete', 'purchase.edit', 'equipment.edit',
      'template.approve'],
  },
  quality: {
    name: '质量工程师', department: '质量管理部', scope: 'member', legacy: true,
    permissions: ['gate.fill', 'gate.decide', 'doc.edit', 'doc.approve', 'doc.complete',
      'fmea.edit', 'fmea.approve', 'cp.edit', 'cp.approve', 'spc.edit', 'spc.review',
      'msa.edit', 'msa.void', 'msa.assess', 'msa.gauge.edit', 'ppap.edit', 'ppap.approve',
      'dict.edit', 'pfd.edit', 'template.edit', 'template.approve', 'ecr.edit', 'ecr.approve',
      'baseline.freeze', 'activity.request', 'activity.approve', 'purchase.edit', 'equipment.edit'],
  },
  engineer: {
    name: '工艺工程师', department: '技术工艺部', scope: 'member', legacy: true,
    permissions: ['gate.fill', 'doc.edit', 'doc.complete', 'fmea.edit', 'cp.edit', 'spc.edit',
      'msa.edit', 'msa.gauge.edit', 'ppap.edit', 'dict.edit', 'pfd.edit', 'template.edit',
      'ecr.edit', 'activity.request'],
  },
  auditor: {
    name: '内审员', department: '质量管理部 · 内审组', scope: 'all', legacy: true,
    permissions: [],
  },
  design: {
    name: '设计工程师 / 项目经理', department: '科研一所', scope: 'member',
    permissions: ['gate.fill', 'doc.edit', 'fmea.edit', 'ecr.edit', 'dict.edit', 'activity.request'],
  },
  production: {
    name: '生产工程师', department: '生产部', scope: 'member',
    permissions: ['gate.fill', 'doc.edit', 'spc.edit', 'ppap.edit', 'ecr.edit', 'activity.request'],
  },
  inspector: {
    name: '检验员', department: '质量管理部 · 检验组', scope: 'member',
    permissions: ['spc.edit', 'msa.edit'],
  },
  purchase: {
    name: '采购 / 设备工装 / 计量管理员', department: '企业管理部', scope: 'member',
    permissions: ['gate.fill', 'doc.edit', 'purchase.edit', 'equipment.edit',
      'msa.gauge.edit', 'msa.assess', 'ecr.edit', 'activity.request'],
  },
  business: {
    name: '市场 / 商务', department: '市场一部', scope: 'member',
    permissions: ['gate.fill', 'doc.edit', 'ecr.edit', 'activity.request'],
  },
  std: {
    name: '标准化 / 文控', department: '科技管理中心', scope: 'member',
    permissions: ['doc.edit', 'template.edit', 'dict.edit'],
  },
  staff: {
    name: '综合只读', department: '人力资源部 / 计划财务部 / 办公室', scope: 'member',
    permissions: [],
  },
  // 安全环保部的“环境与设施”不单独设角色：staff 账号打 facility 标记后获得 facility.edit
};

/* 交付物目录 owner → 可编制角色。
   目录里写的是岗位名（设计 / 工艺 / 质量 / 生产 / 市场 / 采购 / 设备 / 项目经理 / 厂长）。 */
const OWNER_ROLE_MAP = {
  '设计': ['design'],
  '工艺': ['engineer'],
  '质量': ['quality'],
  '生产': ['production'],
  '市场': ['business'],
  '销售': ['business'],
  '采购': ['purchase'],
  '设备': ['purchase'],
  '项目经理': ['design'],
  // 领导支持类：按 2026-11-05 组织调整，由总工 / 总经理 / 管理者代表签署
  '厂长': ['chief', 'gm', 'mgmt_rep'],
};

/* 交付物 owner → 副总经理分管板块（供副总审批范围判定） */
const OWNER_BOARD_MAP = {
  '设计': 'tech', '项目经理': 'tech', '质量': 'tech',
  '工艺': 'ops', '市场': 'ops', '销售': 'ops',
  '生产': 'safety',
  '采购': 'admin', '设备': 'admin',
  // 领导支持类由总工 / 总经理 / 管理者代表签署，不归任何副总板块
  '厂长': null,
};

function boardsForOwner(owner) {
  const boards = new Set();
  String(owner || '').split(/[、,，/／;；\s]+/).filter(Boolean).forEach(token => {
    if (OWNER_BOARD_MAP[token]) boards.add(OWNER_BOARD_MAP[token]);
  });
  return boards;
}

/** 副总只能批准本板块交付物；非副总角色不受板块限制 */
function boardAllows(role, owner) {
  const def = roleDef(role);
  if (!def || !def.board) return true;
  const boards = boardsForOwner(owner);
  if (!boards.size) return false;
  return boards.has(def.board);
}

/** 把目录里的 owner 文本（可能是“采购、项目经理”）解析成角色集合 */
function rolesForOwner(owner) {
  const roles = new Set();
  String(owner || '').split(/[、,，/／;；\s]+/).filter(Boolean).forEach(token => {
    (OWNER_ROLE_MAP[token] || []).forEach(role => roles.add(role));
  });
  return roles;
}

function roleDef(role) {
  return ROLES[role] || null;
}

/** 该角色是否拥有某个权限点 */
function roleCan(role, point, flags = '') {
  const def = roleDef(role);
  if (!def) return false;
  if (def.permissions.includes('*')) return true;
  if (def.permissions.includes(point)) return true;
  // 设施标记：staff 角色按账号打 facility 标记后获得环境与设施编制权
  if (point === 'facility.edit' && hasFlag(flags, 'facility')) return true;
  return false;
}

function hasFlag(flags, name) {
  return String(flags || '').split(/[,;|\s]+/).map(f => f.trim()).includes(name);
}

/** 账号可用权限点（含 flag 扩展），供 /api/auth/me 下发 */
function permissionsFor(user) {
  const def = roleDef(user?.role);
  if (!def) return [];
  if (def.permissions.includes('*')) return Object.keys(PERMISSIONS);
  const set = new Set(def.permissions);
  if (hasFlag(user.flags, 'facility')) set.add('facility.edit');
  return [...set];
}

/** 能否访问某个项目（scope=all 的全局角色始终可以） */
function canSeeAllProjects(role) {
  return roleDef(role)?.scope === 'all';
}

/** 该角色对某交付物是否具备编制权；admin 放行 */
function canEditDoc(role, flags, docOwner) {
  if (role === 'admin') return true;
  if (!roleCan(role, 'doc.edit', flags)) return false;
  const allowed = rolesForOwner(docOwner);
  // 目录里没有归属的交付物（自定义编号、无 owner）：拥有 doc.edit 即可
  if (!allowed.size) return true;
  return allowed.has(role);
}

module.exports = {
  PERMISSIONS, ROLES, OWNER_ROLE_MAP, OWNER_BOARD_MAP,
  roleDef, roleCan, permissionsFor, hasFlag,
  canSeeAllProjects, canEditDoc, rolesForOwner, boardsForOwner, boardAllows,
};
