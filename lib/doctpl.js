'use strict';
/**
 * APQP 交付物目录（依据 AIAG《APQP 第三版》思维导图重排）
 * - phase: 0 入门 / 1 策划和定义项目 / 2 产品设计和开发 / 3 过程设计和开发 / 4 产品和过程确认 / 5 反馈评定和纠正措施
 * - group: input 输入 / output 输出 / activity 活动
 * - kind : form 模板文档 / module 系统内模块 / none 纯活动
 * - up/down: 关联关系（本文件的上游输入、下游去向），用于联动与追溯
 * - ⚑ 为第三版新增项（note 中标注）
 */

const F = (k, label, type = 'text', extra = {}) => Object.assign({ k, label, type }, extra);
const S = (t, fields, note) => ({ t, fields, note });

const base = () => S('基本信息', [
  F('proj', '项目名称', 'text', { w: 'half' }),
  F('part_no', '零件号 / 型号', 'text', { w: 'half' }),
  F('author', '编制', 'text', { w: 'half' }),
  F('date', '日期', 'date', { w: 'half' }),
]);

const sign = () => S('签署', [
  F('prepared', '编制', 'text', { w: 'half' }),
  F('reviewed', '审核', 'text', { w: 'half' }),
  F('approved', '批准', 'text', { w: 'half' }),
  F('approve_date', '批准日期', 'date', { w: 'half' }),
]);

const tbl = (k, label, cols) => F(k, label, 'table', { cols });

const GENERIC = () => [
  base(),
  S('主要内容', [
    F('content', '内容与结论', 'textarea'),
    tbl('items', '要点 / 措施', ['序号', '事项', '责任人', '期限', '状态']),
  ]),
  sign(),
];

/* ------------------------------------------------------------------ 模板 */
const T = {
  /* ==== 阶段 0 ==== */
  'P0-01': [
    base(),
    S('项目团队与参与方', [
      tbl('members', '跨职能团队', [
        '职能/组织', '成员姓名', '角色/职责', '授权范围', '供应商/顾客团队接口', '有效状态',
      ]),
      F('process_owner', 'APQP 过程所有者', 'text', { w: 'half' }),
      F('project_manager', '项目/项目团队经理', 'text', { w: 'half' }),
      F('training', 'APQP/核心工具培训需求与完成情况', 'textarea'),
      F('communication', '顾客/组织/供应商团队沟通渠道与频次', 'textarea'),
    ]),
  ],
  'P0-02': [
    base(),
    S('项目范围与要求', [
      F('customers', '内部与外部顾客', 'text'),
      tbl('scope', '纳入/不纳入范围及顾客要求', [
        '类型（纳入/不纳入/要求）', '产品/过程/要求描述', '零件/版本/适用范围',
        '来源/顾客条款', '澄清状态', '责任人',
      ]),
      F('feasibility', '初步设计、性能与制造过程可行性', 'textarea'),
      F('constraints', '成本、时间、资源和其他约束', 'textarea'),
      F('customer_support', '需要顾客提供的协助与待澄清事项', 'textarea'),
      F('document_control', '所需文件及维护/更新办法', 'textarea'),
    ]),
  ],
  'P1-I-01': [
    base(),
    S('顾客的声音与质量历史', [
      tbl('voice', '需求、期望与历史关注', [
        '编号', '来源类型', '需求/关注内容', '质量/可靠性目标或证据',
        '产品/过程假设', '适用范围', '来源版本', '责任人',
      ]),
      F('communication', '顾客澄清、供应链传递及沟通记录', 'textarea'),
    ]),
  ],
  'P1-I-06': [
    base(),
    S('顾客输入与 CSR', [
      tbl('requirements', '受控要求', [
        '要求编号', '来源类型（图纸/规范/CSR/法规）', '条款/图号', '要求内容',
        '接受准则', '相关特性编号', '来源版本', '适用性/澄清状态', '责任人',
      ]),
      F('customer_approval', '顾客批准/偏差/待澄清事项及证据', 'textarea'),
    ]),
  ],
  'P0-05': [
    base(),
    S('供应商来源与风险评估', [
      F('applicability', '供应商范围与不适用理由', 'textarea'),
      tbl('suppliers', '供应商评估', [
        '供应商', '零件/材料/服务', '层级', '高风险因素', '设计/质量/产能评估',
        '行动计划', '责任人', '期限', '状态', 'APQP要求传递/确认',
      ]),
    ]),
  ],
  'P0-10': [
    base(),
    S('质量策划时间计划', [
      tbl('plan', '任务与节点', [
        '阶段', '任务/里程碑', '计划开始', '计划完成', '责任人', '交付物',
        '实际开始', '实际完成', '客户/内部节点', '进度状态',
      ]),
      F('critical', '关键路径与浮动说明', 'textarea'),
    ]),
  ],
  'P0-11': [
    base(),
    S('时序图相关计划', [
      F('relation', '关键并行关系（哪些任务必须同步）', 'textarea'),
      tbl('seq', '时序约束', ['前置任务', '后续任务', '约束类型', '提前期']),
    ]),
  ],

  /* ==== 阶段 1 ==== */
  'P1-07': [ /* 设计目标 */
    base(),
    S('设计目标', [
      tbl('targets', '目标项', ['特性', '目标值', '公差', '来源（客户/法规/内部）']),
      F('rationale', '目标设定依据', 'textarea'),
    ]),
  ],
  'P1-08': [ /* 可靠性和质量目标 */
    base(),
    S('可靠性与质量目标', [
      F('life', '寿命目标', 'text', { w: 'half' }),
      F('fit', '失效率目标（FIT / ppm）', 'text', { w: 'half' }),
      tbl('tests', '可靠性试验项', ['试验项目', '条件', '样本量', '判定准则']),
    ]),
  ],
  'P1-09': [ /* 初始物料清单 */
    base(),
    S('初始 BOM', [tbl('bom', '物料', ['层级', '物料编码', '名称', '规格', '用量', '供应商'])]),
  ],
  'P1-10': [ /* 初始流程图 */
    base(),
    S('初始流程图', [
      tbl('steps', '工序', ['工序号', '工序名称', '类型', '关键设备', '关键特性']),
      F('note', '与量产流程的差异说明', 'textarea'),
    ]),
  ],
  'P1-11': [ /* 初始产品和过程特殊特性识别 ⚑ */
    base(),
    S('特殊特性识别', [
      tbl('chars', '识别结果', [
        '编号', '特性名称', '分类（CC/SC/安全/配合）', '来源', '初判依据',
        '类型（产品/过程）', '识别主体（顾客/组织）', '来源条款/文件编号', '来源版本',
      ]),
      F('note', '顾客符号/组织分类映射及确认记录', 'textarea'),
    ]),
  ],
  'P1-12': [ /* 产品保证计划 */
    base(),
    S('产品保证计划', [
      F('scope', '保证范围与承诺', 'textarea'),
      tbl('plan', '保证措施', [
        '要求/风险项', '验证方式', '接受准则', '可靠性/耐久性目标',
        '责任人', '计划日期', '状态/证据',
      ]),
    ]),
    sign(),
  ],
  'P1-13': [ /* 产能规划 ⚑ */
    base(),
    S('产能规划', [
      tbl('line', '工序产能', ['工序', '设备', '节拍(pcs/h)', '班次', '日产能', '瓶颈']),
      F('volume_timing', '项目产量/时间、共享设备及售后需求', 'textarea'),
      F('historical_oee', '历史/替代 OEE 与依据', 'textarea'),
      F('prototype_load', '原型及试生产设备负荷', 'textarea'),
      F('bottleneck_action', '瓶颈识别与缓解计划', 'textarea'),
      F('maintenance_downtime', '工装/设备/设施维护停机假设', 'textarea'),
      F('ramp_support', '爬坡、人员和生产支持计划', 'textarea'),
      F('supplier_capacity', '各级供应商质量/合同/产能书面确认', 'textarea'),
      F('run_at_rate_plan', '系统能力分析和实际 Run at Rate 验证计划', 'textarea'),
      F('conclusion', '是否满足客户需求', 'textarea'),
    ]),
  ],
  'P1-15': [ /* 变更管理 ⚑ */
    base(),
    S('变更管理要求', [
      F('rule', '变更分级与审批权限', 'textarea'),
      tbl('flow', '变更流程', ['变更类型', '发起方', '评审人', '批准人', '通知范围']),
    ]),
  ],
  'P1-16': [ /* APQP 项目指标；保留已有 goals 数据作为项目目标基线 */
    base(),
    S('项目目标基线', [
      tbl('goals', '质量/成本/交付目标', ['维度（质量/成本/交付）', '目标值', '测量方式', '责任人']),
    ]),
    S('项目特色指标', [
      tbl('custom_metrics', '特殊/独有项目要素', ['要素', '目标/验收准则', '责任人', '计划日期', '备注']),
      F('metric_note', '阶段评审说明', 'textarea'),
    ]),
  ],
  'P1-17': [ /* 风险评估缓解计划 ⚑ */
    base(),
    S('风险评估', [
      tbl('risks', '风险与缓解策略（REMS）', [
        '风险描述/范围', '优先级', '影响/安全使用要素', '策略（回避/降低/转移/接受/监视）',
        '缓解行动', '沟通/实施计划', '责任人', '期限', '验证/监视证据', '状态',
      ]),
      F('trigger', '升级与触发条件', 'textarea'),
      F('manager', '项目经理监督/复核记录', 'textarea'),
    ]),
  ],

  /* ==== 阶段 2 ==== */
  'P2-02': [ /* DFM & DFA */
    base(),
    S('可制造性与可装配性', [
      tbl('items', '检查项', ['检查项', '评估结论', '改进建议', '责任人']),
      F('conclusion', '结论', 'textarea'),
    ]),
  ],
  'P2-03': [ /* 设计验证 DVP&R */
    base(),
    S('验证计划', [
      tbl('dvp', 'DVP&R', ['序号', '设计特性', '验证项目', '接受准则', '样本/方法', '责任', '计划完成', '结果', '判定']),
    ]),
    S('说明', [F('note', '未覆盖的风险与补充验证', 'textarea')]),
  ],
  'P2-04': [ /* 设计评审 */
    base(),
    S('评审信息', [
      F('subject', '评审对象与版本', 'text', { w: 'half' }),
      F('attendees', '参加人', 'text', { w: 'half' }),
    ]),
    S('评审检查项', [tbl('items', '检查项', ['检查项', '要求', '符合性', '问题描述'])]),
    S('结论', [
      F('conclusion', '结论', 'select', { options: ['通过', '有条件通过', '不通过'] }),
      tbl('actions', '遗留问题', ['问题', '措施', '责任人', '期限', '状态']),
    ]),
    sign(),
  ],
  'P2-06': [ /* 工程图 */
    base(),
    S('工程图清单', [
      tbl('list', '图纸', ['图号', '名称', '版本', '生效日期', '关键特性标注']),
    ]),
  ],
  'P2-07': [ /* 工程规范 */
    base(),
    S('工程规范', [F('spec', '规范内容与要求', 'textarea')]),
  ],
  'P2-08': [ /* 材料规范 */
    base(),
    S('材料规范', [
      tbl('mat', '材料要求', ['材料', '标准', '关键参数', '判定准则', '供应商']),
    ]),
  ],
  'P2-09': [ /* 图纸和规范的变更 */
    base(),
    S('变更记录', [
      tbl('changes', '变更', ['变更单号', '日期', '变更内容', '原因', '影响范围', '批准人']),
    ]),
  ],
  'P2-10': [ /* 新设备、工装和设施要求 */
    base(),
    S('设备与工装要求', [
      tbl('equip', '要求', ['项目', '名称/型号', '能力要求', '数量', '到位时间', '状态']),
    ]),
  ],
  'P2-11': [ /* 产品和过程特殊特性 ⚑ */
    base(),
    S('特殊特性清单', [
      tbl('chars', '特殊特性', [
        '编号', '名称', '规格/公差', '分类', '来源', '保证工序',
        '类型（产品/过程）', '顾客分类', '组织分类/对照', '顾客同意依据',
      ]),
    ]),
  ],
  'P2-12': [ /* 量具和测试设备要求 */
    base(),
    S('量具与测试设备', [
      tbl('gauge', '要求', ['项目', '量具/设备', '量程', '分辨力', '精度要求', '数量']),
    ]),
  ],
  'P2-13': [ /* 团队可行性承诺 */
    base(),
    S('承诺', [
      F('statement', '团队可行性承诺内容', 'textarea'),
      tbl('sign', '签署', ['角色', '姓名', '意见', '日期']),
    ]),
  ],

  /* ==== 阶段 3 ==== */
  'P3-02': [ /* 包装标准和规范 */
    base(),
    S('包装与标识', [
      tbl('pack', '包装层级', ['层级', '材料', '数量', '标识内容', '防护要求']),
      F('label', '标签与追溯码规则', 'textarea'),
    ]),
  ],
  'P3-03': [ /* 产品/过程质量体系评审 */
    base(),
    S('体系评审', [tbl('items', '检查项', ['条款', '要求', '现状', '差距', '措施'])]),
    sign(),
  ],
  'P3-05': [ /* 平面布置图 */
    base(),
    S('布置说明', [
      F('layout', '区域与流向说明', 'textarea'),
      F('issues', '物流/人流/环境隔离要点', 'textarea'),
    ]),
    S('区域清单', [tbl('areas', '区域', ['区域', '功能', '洁净等级', '温湿度要求', '面积'])]),
  ],
  'P3-07': [ /* 过程说明书 */
    base(),
    S('作业步骤', [
      F('equipment', '设备与工装', 'text', { w: 'half' }),
      F('material', '材料', 'text', { w: 'half' }),
      tbl('steps', '步骤', ['步骤', '操作内容', '关键参数', '注意事项']),
    ]),
    S('安全与异常', [F('safety', '安全注意事项与异常处置', 'textarea')]),
  ],
  'P3-08': [ /* 测量系统分析计划 */
    base(),
    S('MSA 计划', [
      tbl('plan', '计划', ['特性', '检具编号', '检具名称', '研究类型', '零件数×人数×次数', '计划日期', '责任人', '状态']),
    ]),
  ],
  'P3-09': [ /* 初始过程能力研究计划 */
    base(),
    S('能力研究计划', [
      tbl('plan', '计划', ['特性', '工序', '样本量', '抽样频率', '目标 Cpk', '判定准则']),
    ]),
  ],

  /* ==== 阶段 4 ==== */
  'P4-01': [ /* 有效生产运行 */
    base(),
    S('试生产运行', [
      F('batch', '批次与数量', 'text', { w: 'half' }),
      F('date_range', '生产日期', 'text', { w: 'half' }),
      F('condition', '生产条件（人机料法环）', 'textarea'),
      F('production_resources', '生产工装、设备、设施、人员与量具', 'textarea'),
      F('required_quantity', '顾客/项目规定的运行数量', 'text', { w: 'half' }),
      F('actual_rate', '实际生产速率及对报价产能的验证', 'textarea'),
      F('control_plan_checks', '本次运行对控制计划检查项目的覆盖', 'textarea'),
      tbl('output', '产出', ['工序', '投入', '产出', '不良', '合格率', '主要不良模式']),
      tbl('samples', '初始生产样品与证据', [
        '样品/批次标识', '来源工序', '特性编号', '检验/测试报告', '结果状态', '备注',
      ]),
      F('process_review', '运行评审、问题与投产前待解决事项', 'textarea'),
    ]),
  ],
  'P4-05': [ /* 生产确认测试 */
    base(),
    S('确认测试', [
      tbl('tests', '测试项', ['项目', '条件', '要求', '实测', '判定', '报告编号']),
    ]),
  ],
  'P4-06': [ /* 包装评价 */
    base(),
    S('包装评价', [
      tbl('items', '评价项', ['评价项', '方法', '要求', '结果', '判定']),
    ]),
  ],
  'P4-08': [ /* 质量策划签发和领导支持 */
    base(),
    S('签发', [
      tbl('signoff_checks', '发运前质量策划确认', [
        '确认内容', '状态', '证据/现场核对', '差距/措施', '责任人', '期限',
      ]),
      F('summary', '质量策划总结', 'textarea'),
      F('support', '领导支持事项（资源/授权）', 'textarea'),
    ]),
    sign(),
  ],
  'P5-04': [ /* 经验教训与最佳实践 */
    base(),
    S('经验教训与最佳实践', [
      tbl('lessons', '经验记录', [
        '来源（TGR/TGW/保修/纠正措施/FMEA/防错等）', '事实/问题', '根因与影响',
        '措施/防错方案', '适用产品/过程', '责任人', '状态', '实施证据',
      ]),
      F('reuse', '向类似产品/基础或家族 FMEA 横向展开的结果', 'textarea'),
      F('reviewed_stages', '已完成经验教训复核的 APQP 阶段', 'text'),
    ]),
  ],

  /* ==== 附录 A 检查表（通用结构） ==== */
  CHK_1: [
    base(),
    S('检查表', [
      tbl('items', '检查项', [
        '序号', '检查问题', '结论（是/否/不适用）', '证据/来源',
        '差距与措施计划', '责任人', '计划完成日期', '关闭状态', '变更影响',
      ]),
    ]),
    S('结论', [F('conclusion', '结论与差距', 'textarea')]),
    sign(),
  ],
};

const CHECKLIST_QUESTIONS = {
  'A-01': [
    '已识别项目团队、职责、顾客/供应商参与和高风险评估方法',
    '项目范围、顾客要求、资源、产能与主要时间约束已评估',
    '新技术、法规/安全、历史质量和供应链风险已有措施或监控计划',
    '每个不可接受或待定风险均有责任人、计划日期和缓解措施',
  ],
  'A-02': [
    'DFMEA 范围、结构、功能和顾客要求完整且版本适用',
    '潜在失效影响、模式、原因/机理及现行设计控制已评估',
    '特殊特性和高严重度/高 AP 项已评审并有决定或措施',
    '预防措施、验证证据、责任人与期限已跟踪到关闭',
  ],
  'A-03': [
    '图纸/数模及工程规范均为适用版本并满足顾客要求',
    '尺寸、公差、基准、材料、性能、外观和安全/法规要求已评审',
    '特殊特性标识、检验方法和量具可行性已评估',
    '变更、待定规范和顾客批准要求均可追溯',
  ],
  'A-04': [
    '新设备、工装、设施和量具需求已识别并纳入时间计划',
    '设备/工装能力、数量、交付时间和产能要求已评估',
    '量具范围、精度、分辨力、校准和 MSA 要求已定义',
    '未到位或能力未确认的资源均有措施、责任人和期限',
  ],
  'A-05': [
    '制造现场质量体系和顾客要求覆盖情况已评审',
    '新增控制/程序变化已纳入流程图、PFMEA、控制计划或作业指导书',
    '不合格品隔离、追溯、过程审核和记录控制已覆盖',
    '差距、措施、责任人、期限和关闭证据已记录',
  ],
  'A-06': [
    '布局覆盖适用区域，物料流与过程流程图、控制计划一致',
    '特殊过程、检验/返工返回点和不合格品隔离区域已标识',
    '控制图位置、目视辅具、维修工位和环境隔离已评估',
    '物流/人流风险及未解决布局问题有责任人和措施',
  ],
  'A-07': [
    '流程图覆盖从接收到发运的全部过程，并包含外部过程/服务',
    '工序顺序、工序号、返工/检验点和设备信息完整',
    '流程图用于 PFMEA 和控制计划开发，三者工序范围一致',
    '过程变更和流程图版本已批准并向受影响方传达',
  ],
  'A-08': [
    'PFMEA 在生产前完成，并依据适用 DFMEA 和过程流程图编制',
    '每个适用过程步骤的失效影响、模式、原因和控制已分析',
    '产品/过程特殊特性及 4M 相关风险得到适当覆盖',
    '预防/探测控制、措施、责任人、期限和关闭证据已跟踪',
  ],
  'A-09': [
    'APQP 输出变更记录包含原因、申请人、批准人和日期',
    '可能影响形状/配合/功能的变更已完成影响分析和重新批准判断',
    '顾客同意的特殊关键特性未被未经批准地改变或删除',
    '受影响顾客、组织区域和供应商已及时通知；防错记录可追溯',
  ],
  'A-10': [
    '供应商适用性、质量/设计/产能/交付能力及高风险因素已评估',
    '高风险供应商已召开启动会、安排定期 APQP 会议并建立风险缓解计划',
    '适用 APQP 要求已向供应链下层传递并取得确认',
    '采购检查表待定项均有措施、责任人、期限和完成证据',
  ],
  'A-11': [
    '适用的原型、试生产、生产控制计划阶段均已建立并获所需批准',
    '控制计划覆盖产品/过程特性、特殊特性、方法、样本、频次和反应计划',
    '控制计划与流程图、PFMEA、过程说明书逐工序一致',
    '安全投产适用性、进入/退出准则和加强遏制措施已明确',
    'MSA/能力研究覆盖所有适用的特殊特性和顾客要求',
  ],
};

const CHECKLIST_COLUMNS = [
  '序号', '检查问题', '结论（是/否/不适用）', '证据/来源',
  '差距与措施计划', '责任人', '计划完成日期', '关闭状态', '变更影响',
];
for (const code of Object.keys(CHECKLIST_QUESTIONS)) {
  T[code] = [
    base(),
    S('附录 A 检查表', [tbl('items', '检查项', CHECKLIST_COLUMNS)]),
    S('结论', [F('conclusion', '结论与差距', 'textarea')]),
    sign(),
  ];
}

/* ------------------------------------------------------------------ 目录 */
const CATALOG = [
  /* ---------- 阶段 0：项目启动（只保留真正的开工前置条件） ----------
     手册「引言」中的培训、同步工程、问题解决等属于贯穿全程的基本规则，
     不是某一阶段的交付物，统一移到 GLOBAL_REQS，不在阶段里计完成度。 */
  { code: 'P0-01', phase: 0, group: 'output', name: '组建跨职能小组', kind: 'form', fmt: 'xlsx', owner: '项目经理', desc: '指定 APQP 过程所有者、跨职能角色职责、供应商/顾客接口和培训' },
  { code: 'P0-02', phase: 0, group: 'output', name: '确定范围（含 / 不含）', kind: 'form', fmt: 'xlsx', owner: '项目经理', desc: '定义内部/外部顾客、顾客要求、范围、可行性、约束和文件维护办法' },
  { code: 'P0-05', phase: 0, group: 'output', name: '供应商来源与风险评估', kind: 'form', fmt: 'xlsx', owner: '采购、项目经理', desc: '评估供应商适用性和高风险因素；适用的供应商 APQP 要求须向下传递并确认', down: ['P1-09', 'P2-10', 'A-10'] },
  { code: 'P0-10', phase: 0, group: 'output', name: '项目质量策划时间计划', kind: 'form', fmt: 'xlsx', owner: '项目经理', desc: '项目类型、复杂度与顾客期望驱动里程碑、任务、责任、开始/完成计划与实绩、阶段门及关键路径', down: ['P1-16'] },

  /* ---------- 阶段 1：策划和定义项目 ---------- */
  { code: 'P1-I-01', phase: 1, group: 'input', name: '顾客的声音（VOC）', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '顾客需求、历史质量/保修问题、团队经验和相关证据' },
  { code: 'P1-I-02', phase: 1, group: 'input', name: '业务计划和营销策略', kind: 'none', owner: '市场', desc: '产品定位、销量与时间窗口' },
  { code: 'P1-I-03', phase: 1, group: 'input', name: '产品 / 过程标杆数据', kind: 'none', owner: '设计', desc: '竞品与行业标杆的指标' },
  { code: 'P1-I-04', phase: 1, group: 'input', name: '产品 / 过程设想', kind: 'none', owner: '设计', desc: '概念方案与工艺路线设想' },
  { code: 'P1-I-05', phase: 1, group: 'input', name: '产品可靠性研究', kind: 'none', owner: '设计', desc: '历史失效、寿命与可靠性数据' },
  { code: 'P1-I-06', phase: 1, group: 'input', name: '顾客输入', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '顾客图纸、工程/材料规范、CSR、法规要求、偏差及澄清' },
  { code: 'P1-07', phase: 1, group: 'output', name: '设计目标', kind: 'form', fmt: 'docx', owner: '设计', desc: '把顾客要求转成可测量的设计目标', up: ['P1-I-01', 'P1-I-06'], down: ['P2-06', 'P2-11'] },
  { code: 'P1-08', phase: 1, group: 'output', name: '可靠性和质量目标', kind: 'form', fmt: 'docx', owner: '设计', desc: '寿命、FIT、试验项与判定', up: ['P1-I-05'], down: ['P2-03'] },
  { code: 'P1-09', phase: 1, group: 'output', name: '初始物料清单（BOM）', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '初始物料与关键参数', down: ['P2-08', 'P3-02'] },
  { code: 'P1-10', phase: 1, group: 'output', name: '初始流程图', kind: 'form', module: 'pfd', arg: 'INITIAL', fmt: 'docx', owner: '工艺', desc: '初版工序路线；进入阶段一流程图工作台', down: ['P3-04'] },
  { code: 'P1-11', phase: 1, group: 'output', name: '初始产品和过程特殊特性识别', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '由顾客和组织识别；依据顾客需求/产品假设、可靠性目标、预期过程及类似零件FMEA', up: ['P1-I-01', 'P1-I-06', 'P1-08', 'P1-09', 'P1-10', 'P5-04'], down: ['P2-11', 'P3-06'] },
  { code: 'P1-12', phase: 1, group: 'output', name: '产品保证计划', kind: 'form', fmt: 'docx', owner: '质量', desc: '对高风险项的保证措施与验证方式', down: ['P2-03'] },
  { code: 'P1-13', phase: 1, group: 'output', name: '产能规划', kind: 'form', fmt: 'xlsx', owner: '工艺', desc: '⚑ 第三版新增：节拍、班次与瓶颈', down: ['P2-10'] },
  { code: 'P1-14', phase: 1, group: 'output', name: '领导支持', kind: 'none', owner: '厂长', desc: '资源与授权承诺' },
  { code: 'P1-15', phase: 1, group: 'output', name: '变更管理', kind: 'form', fmt: 'docx', owner: '质量', desc: '⚑ 第三版新增：变更分级、审批与通知', down: ['P2-09'] },
  { code: 'P1-16', phase: 1, group: 'output', name: 'APQP 项目指标', kind: 'form', fmt: 'xlsx', owner: '项目经理', desc: '项目经理汇总所有关键要素和特色指标的阶段准备度，供领导层评审；保留质量/成本/交付目标基线', up: ['P0-10', 'P1-I-02', 'P1-I-03'] },
  { code: 'P1-17', phase: 1, group: 'output', name: '风险评估缓解计划', kind: 'form', fmt: 'docx', owner: '质量', desc: '⚑ 第三版新增：风险清单与缓解措施', down: ['P2-01'] },

  /* ---------- 阶段 2：产品设计和开发 ---------- */
  { code: 'P2-01', phase: 2, group: 'output', name: 'DFMEA', kind: 'module', module: 'fmea', arg: 'DFMEA', owner: '设计', desc: '设计失效模式与影响分析（七步法）', up: ['P1-11', 'P1-17'], down: ['P3-06', 'P2-03'] },
  { code: 'P2-02', phase: 2, group: 'output', name: 'DFM & DFA 和可服务性设计', kind: 'form', fmt: 'docx', owner: '设计', desc: '可制造性、可装配性、可维护性评估', up: ['P1-10'] },
  { code: 'P2-03', phase: 2, group: 'output', name: '设计验证（DVP&R）', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '设计特性的验证计划与结果', up: ['P1-08', 'P1-12'], down: ['P4-05'] },
  { code: 'P2-04', phase: 2, group: 'output', name: '设计评审', kind: 'form', fmt: 'docx', owner: '设计', desc: '阶段评审记录与遗留问题闭环' },
  { code: 'P2-05', phase: 2, group: 'output', name: '原型样件制造 — 控制计划', kind: 'module', module: 'cp', arg: 'PROTO', owner: '工艺', desc: '原型阶段控制计划，与试生产、量产控制计划共用受控数据', up: ['P1-11'], down: ['P3-06b'] },
  { code: 'P2-06', phase: 2, group: 'output', name: '工程图', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '图纸清单与关键特性标注', up: ['P1-07'], down: ['P2-12'] },
  { code: 'P2-07', phase: 2, group: 'output', name: '工程规范', kind: 'form', fmt: 'docx', owner: '设计', desc: '材料、性能与试验规范' },
  { code: 'P2-08', phase: 2, group: 'output', name: '材料规范', kind: 'form', fmt: 'docx', owner: '设计', desc: '关键材料的参数与判定准则', up: ['P1-09'], down: ['P4-05'] },
  { code: 'P2-09', phase: 2, group: 'output', name: '图纸和规范的变更', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '变更记录与影响范围', up: ['P1-15'] },
  { code: 'P2-10', phase: 2, group: 'output', name: '新设备、工装和设施要求', kind: 'form', fmt: 'xlsx', owner: '设备', desc: '设备与工装的能力要求', up: ['P1-13'], down: ['P3-05'] },
  { code: 'P2-11', phase: 2, group: 'output', name: '产品和过程特殊特性', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '⚑ 第三版：正式确认 CC/SC 并贯穿下游', up: ['P1-07', 'P1-11'], down: ['P2-01', 'P3-06', 'P3-04'] },
  { code: 'P2-12', phase: 2, group: 'output', name: '量具和测试设备要求', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '量具量程、精度与数量要求', up: ['P2-06'], down: ['P3-08'] },
  { code: 'P2-13', phase: 2, group: 'output', name: '团队可行性承诺和领导支持', kind: 'form', fmt: 'docx', owner: '项目经理', desc: '跨职能团队的可行性承诺签署' },

  /* ---------- 阶段 3：过程设计和开发 ---------- */
  { code: 'P3-02', phase: 3, group: 'output', name: '包装标准和规范', kind: 'form', fmt: 'docx', owner: '工艺', desc: '包装层级、标识与防护', up: ['P1-09'], down: ['P4-06'] },
  { code: 'P3-03', phase: 3, group: 'output', name: '产品 / 过程质量体系评审', kind: 'form', fmt: 'docx', owner: '质量', desc: '体系覆盖度与差距' },
  { code: 'P3-04', phase: 3, group: 'output', name: '过程流程图（PFD）', kind: 'module', module: 'pfd', arg: 'PROCESS', owner: '工艺', desc: '工序分解、类型与设备', up: ['P1-10'], down: ['P3-06', 'P3-06b'] },
  { code: 'P3-05', phase: 3, group: 'output', name: '平面布置图', kind: 'form', fmt: 'docx', owner: '工艺', desc: '区域、流向与环境隔离', up: ['P2-10'] },
  { code: 'P3-06', phase: 3, group: 'output', name: 'PFMEA', kind: 'module', module: 'fmea', arg: 'PFMEA', owner: '工艺', desc: '过程失效模式与影响分析（继承 DFMEA）', up: ['P2-01', 'P3-04'], down: ['P3-06b', 'P4-04'] },
  { code: 'P3-06b', phase: 3, group: 'output', name: '试生产控制计划', kind: 'module', module: 'cp', arg: 'PILOT', owner: '工艺', desc: '⚑ 第三版：试生产阶段即出 CP（与生产 CP 分开）', up: ['P3-04', 'P3-06'], down: ['P3-08', 'P3-09', 'P4-07'] },
  { code: 'P3-07', phase: 3, group: 'output', name: '过程说明书（作业指导书）', kind: 'form', fmt: 'docx', owner: '工艺', desc: '步骤、参数与安全', up: ['P3-04'] },
  { code: 'P3-08', phase: 3, group: 'output', name: '测量系统分析计划', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '需做 GR&R 的检具与排期', up: ['P3-06b'], down: ['P4-02'] },
  { code: 'P3-09', phase: 3, group: 'output', name: '初始过程能力研究计划', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '特性、样本与 Cpk 目标', up: ['P3-06b'], down: ['P4-03'] },
  { code: 'P3-10', phase: 3, group: 'output', name: '领导支持', kind: 'none', owner: '厂长', desc: '过程开发阶段的资源保障' },

  /* ---------- 阶段 4：产品和过程确认 ---------- */
  { code: 'P4-01', phase: 4, group: 'output', name: '有效生产运行', kind: 'form', fmt: 'docx', owner: '生产', desc: '试生产运行记录与合格率', up: ['P3-06b'], down: ['P4-03'] },
  { code: 'P4-02', phase: 4, group: 'output', name: '测量系统分析（MSA）', kind: 'module', module: 'msa', owner: '质量', desc: 'GR&R 实施与判定', up: ['P3-08'], down: ['P4-04', 'P4-09'] },
  { code: 'P4-03', phase: 4, group: 'output', name: '初始过程能力研究（SPC）', kind: 'module', module: 'spc', owner: '质量', desc: 'Cpk/Ppk 与判异', up: ['P3-09', 'P4-01'], down: ['P4-04'] },
  { code: 'P4-04', phase: 4, group: 'output', name: '生产件批准（PPAP）', kind: 'module', module: 'ppap', owner: '质量', desc: '18 项要素与提交等级', up: ['P4-02', 'P4-03', 'P4-05'], down: ['P5-01'] },
  { code: 'P4-05', phase: 4, group: 'output', name: '生产确认测试', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '尺寸、材料与性能确认', up: ['P2-03', 'P2-08'], down: ['P4-04'] },
  { code: 'P4-06', phase: 4, group: 'output', name: '包装评价', kind: 'form', fmt: 'docx', owner: '质量', desc: '包装防护与运输验证', up: ['P3-02'] },
  { code: 'P4-07', phase: 4, group: 'output', name: '生产控制计划', kind: 'module', module: 'cp', arg: 'SOP', owner: '工艺', desc: '⚑ 第三版：由试生产 CP 升版', up: ['P3-06b'], down: ['P4-09'] },
  { code: 'P4-08', phase: 4, group: 'output', name: '质量策划签发和领导支持', kind: 'form', fmt: 'docx', owner: '厂长', desc: '质量策划总结与签发' },
  { code: 'P4-09', phase: 4, group: 'activity', name: '量产爬坡准备', kind: 'none', owner: '生产', desc: '产能、人员与物料到位' },

  /* ---------- 阶段 5：反馈、评定和纠正措施 ---------- */
  { code: 'P5-01', phase: 5, group: 'activity', name: '减少变差', kind: 'none', owner: '质量', desc: '基于 SPC/MSA 持续降低变差' },
  { code: 'P5-02', phase: 5, group: 'activity', name: '提升顾客满意度', kind: 'none', owner: '质量', desc: '投诉响应与满意度跟踪' },
  { code: 'P5-03', phase: 5, group: 'activity', name: '改善顾客服务和交付', kind: 'none', owner: '销售', desc: '交付准时率与响应时效' },
  { code: 'P5-04', phase: 5, group: 'output', name: '经验教训与最佳实践', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '各阶段复核 TGR/TGW、绩效、纠正措施、类似产品/FMEA 与防错经验，并记录实施计划' },

  /* ---------- 附录 A：检查表 ---------- */
  { code: 'A-01', phase: 0, group: 'checklist', name: 'APQP 风险因素检查表', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '系统编号 A-01，对应手册附录 A-0 风险因素检查' },
  { code: 'A-02', phase: 2, group: 'checklist', name: '设计 FMEA 检查表', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '系统编号 A-02，对应手册附录 A-1 DFMEA 完整性检查' },
  { code: 'A-03', phase: 2, group: 'checklist', name: '设计信息检查表', kind: 'form', fmt: 'xlsx', owner: '设计', desc: '系统编号 A-03，对应手册附录 A-2 图纸、规范、材料信息检查' },
  { code: 'A-04', phase: 2, group: 'checklist', name: '新设备工装和测试设备检查表', kind: 'form', fmt: 'xlsx', owner: '设备', desc: '系统编号 A-04，对应手册附录 A-3 设备能力与工装到位检查' },
  { code: 'A-05', phase: 3, group: 'checklist', name: '产品 / 过程质量检查表', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '系统编号 A-05，对应手册附录 A-4 质量体系与过程检查' },
  { code: 'A-06', phase: 3, group: 'checklist', name: '平面图检查表', kind: 'form', fmt: 'xlsx', owner: '工艺', desc: '系统编号 A-06，对应手册附录 A-5 布局与物流检查' },
  { code: 'A-07', phase: 3, group: 'checklist', name: '过程流程图检查表', kind: 'form', fmt: 'xlsx', owner: '工艺', desc: '系统编号 A-07，对应手册附录 A-6 PFD 完整性检查' },
  { code: 'A-08', phase: 3, group: 'checklist', name: '过程 FMEA 检查表', kind: 'form', fmt: 'xlsx', owner: '工艺', desc: '系统编号 A-08，对应手册附录 A-7 PFMEA 完整性检查' },
  { code: 'A-09', phase: 3, group: 'checklist', name: '变更管理检查表', kind: 'form', fmt: 'xlsx', owner: '质量', desc: '系统编号 A-09，对应手册附录 A-8 变更管理检查' },
  { code: 'A-10', phase: 3, group: 'checklist', name: '采购检查表', kind: 'form', fmt: 'xlsx', owner: '采购', desc: '系统编号 A-10，对应手册附录 A-9 采购/供应商检查' },
  { code: 'A-11', phase: 4, group: 'checklist', name: '控制计划检查表', kind: 'form', fmt: 'xlsx', owner: '工艺', desc: '系统编号 A-11，对应手册附录 A-10 控制计划检查' },
];

const PHASES = [
  { no: 0, name: '入门', short: '组织与准备' },
  { no: 1, name: '策划和定义项目', short: '输入 6 / 输出 11' },
  { no: 2, name: '产品设计和开发', short: '13 项输出' },
  { no: 3, name: '过程设计和开发', short: '10 项输出' },
  { no: 4, name: '产品和过程确认', short: '8 项输出' },
  { no: 5, name: '反馈、评定和纠正措施', short: '4 项' },
];

/* 预置示例内容 */
const SAMPLE = {
  'P1-07': {
    proj: 'RJ 系列 1/4W 金属膜电阻器', part_no: 'RJ-0.25W-10K', author: '设计-陈', date: '2026-02-18',
    targets: [
      ['阻值精度', '10 kΩ', '±1.0%', '客户图纸 DR-2026-014'],
      ['TCR', '25 ppm/℃', '≤ ±50 ppm/℃', '客户图纸 DR-2026-014'],
      ['耐压', '500 V AC', '≥ 500 V / 1 min', 'IEC 60115'],
      ['湿热稳定性', '—', '1000h 后漂移 ≤ ±0.5%', 'AEC-Q200'],
    ],
    rationale: '客户图纸与 AEC-Q200 为强制要求；TCR 取图纸中心值以留出工艺波动余量。',
  },
  'P1-11': {
    proj: 'RJ 系列 1/4W 金属膜电阻器', part_no: 'RJ-0.25W-10K', author: '设计-陈', date: '2026-02-25',
    chars: [
      ['CHR-D-0142', '阻值精度', 'CC', '客户图纸', 'S=8 的失效影响 + 客户指定', 'PRODUCT', '顾客', 'DR-2026-014', 'Rev C'],
      ['CHR-D-0163', '耐压', '安全', 'IEC 60115', '失效后果为起火风险，S=10', 'PRODUCT', '顾客', 'IEC 60115', 'Ed. 5'],
      ['CHR-D-0151', '湿热后阻值漂移', 'SC', 'AEC-Q200', '可靠性要求，过程特性无法覆盖', 'PRODUCT', '组织', 'AEC-Q200', 'Rev E'],
      ['CHR-P-0047', '激光功率/切槽深度', 'CC', '内部', '调阻是阻值精度的强关联过程特性', 'PROCESS', '组织', 'P1-10', 'V1.0'],
    ],
    note: '客户 A 用 ▽ 表示 CC；系统内部统一 CC/SC，导出时按客户符号映射。',
  },
  'P2-03': {
    proj: 'RJ 系列 1/4W 金属膜电阻器', part_no: 'RJ-0.25W-10K', author: '设计-陈', date: '2026-06-18',
    dvp: [
      ['1', '阻值精度 ±1%', '25℃ 全检阻值分布（n=50）', 'Cpk ≥ 1.67', '电桥 G-014 / 50 pcs', '陈', '2026-07-30', 'Cpk 1.75', '通过'],
      ['2', 'TCR ≤ ±50 ppm/℃', '温度循环 -55/+125℃', '≤ ±50 ppm/℃', 'TCR 台 / 10 pcs', '陈', '2026-08-15', '42 ppm/℃', '通过'],
      ['3', '耐压 ≥ 500 V AC', '耐压 1 min', '无击穿', '耐压仪 / 20 pcs', '王', '2026-08-20', '全部通过', '通过'],
      ['4', '耐湿 1000h', '85℃/85%RH', '≤ ±0.5%', '恒温恒湿 / 12 pcs', '王', '2026-11-30', '进行中', '待定'],
    ],
    note: '耐湿试验周期最长，是关键路径；失败则回到 DFMEA 重评 CHR-D-0151 的探测措施。',
  },
};

/** 贯穿全程的基本规则（手册「引言」）：不进阶段、不计完成度，只作评审提示 */
const GLOBAL_REQS = [
  { name: '培训', desc: 'APQP / FMEA / SPC / MSA 方法培训，确保团队具备分析能力；新项目启动时确认' },
  { name: '顾客与组织的参与', desc: '明确顾客介入的节点（设计评审、门径评审、PPAP 提交）与沟通方式' },
  { name: '同步工程', desc: '设计、工艺、质量并行开展，避免串行等待；在产品设计阶段就引入工艺代表' },
  { name: '问题解决', desc: '8D / 5Why 等闭环机制；跨阶段发现的失效与偏差都走同一套问题解决流程' },
  { name: '采购', desc: '⚑ 第三版新增：供应商同步开发与能力评估，关键外购件纳入 APQP 计划' },
  { name: '团队对团队（小组间沟通）', desc: '与顾客、供应商团队建立对接机制；接口责任必须书面明确' },
  { name: '控制计划意识', desc: '控制计划是阶段 3、4 的产物，但阶段 0 就要明确谁负责、何时出' },
  { name: '时序图 / 进度图表', desc: '与进度计划配套，用于标识并行任务与前置约束；纳入门径评审检查' },
];

module.exports = { CATALOG, T, GENERIC, SAMPLE, PHASES, GLOBAL_REQS, CHECKLIST_QUESTIONS };
