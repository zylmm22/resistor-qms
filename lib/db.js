'use strict';
/**
 * 数据层：SQLite（node:sqlite，零依赖）
 * 表结构对齐《07 数据字典》的 24 张业务表，并补充 APQP / PPAP。
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DB_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = process.env.QMS_DB_PATH
  ? path.resolve(process.env.QMS_DB_PATH)
  : path.join(DB_DIR, 'qms.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;
let transactionSequence = 0;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS product_family(
  family_id TEXT PRIMARY KEY, code TEXT, name TEXT, category TEXT,
  status TEXT DEFAULT '生效'
);
CREATE TABLE IF NOT EXISTS product_series(
  series_id TEXT PRIMARY KEY, family_id TEXT, code TEXT, name TEXT,
  status TEXT DEFAULT '生效'
);
CREATE TABLE IF NOT EXISTS project(
  project_id TEXT PRIMARY KEY, code TEXT, name TEXT, family_id TEXT, series_id TEXT,
  customer TEXT, standard TEXT, phase INTEGER DEFAULT 1, owner TEXT,
  status TEXT DEFAULT '进行中', start_date TEXT, part_no TEXT
);
CREATE TABLE IF NOT EXISTS char_master(
  char_id TEXT PRIMARY KEY, char_kind TEXT, name TEXT, description TEXT, domain TEXT, unit TEXT,
  target REAL, lsl REAL, usl REAL, tol_text TEXT, is_special INTEGER DEFAULT 0,
  special_symbol TEXT, source_type TEXT, source_ref TEXT, family_id TEXT,
  status TEXT DEFAULT '生效', series_id TEXT
);
CREATE TABLE IF NOT EXISTS project_char(
  pchar_id TEXT PRIMARY KEY, project_id TEXT, char_id TEXT, name TEXT, description TEXT, char_kind TEXT,
  domain TEXT, unit TEXT, target REAL, lsl REAL, usl REAL, tol_text TEXT,
  is_special INTEGER DEFAULT 0, special_symbol TEXT, source_type TEXT, source_ref TEXT,
  status TEXT DEFAULT '生效', created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS char_link(
  link_id INTEGER PRIMARY KEY AUTOINCREMENT, product_char_id TEXT, process_char_id TEXT,
  direction TEXT, strength TEXT, mechanism TEXT, evidence_ref TEXT, valid_baseline TEXT,
  created_by TEXT, created_at TEXT, status TEXT DEFAULT '生效'
);
CREATE TABLE IF NOT EXISTS process_dict(
  dict_id TEXT PRIMARY KEY, code TEXT, name TEXT, step_type TEXT,
  default_equipment TEXT, effective_from TEXT, effective_to TEXT, status TEXT DEFAULT '生效'
);
CREATE TABLE IF NOT EXISTS process_step(
  step_id TEXT PRIMARY KEY, project_id TEXT, dict_id TEXT, step_no TEXT, name TEXT, step_type TEXT,
  seq INTEGER, parent_step_id TEXT, equipment TEXT, fixture TEXT, input_desc TEXT, output_desc TEXT,
  status TEXT DEFAULT '已发布', ver TEXT DEFAULT 'V1.0', pfd_mode TEXT DEFAULT 'PROCESS',
  origin_step_id TEXT,
  published_at TEXT, published_by TEXT, change_summary TEXT
);
-- P-04：PFD 发布/撤回留版本快照，回答“上一版工序是怎么规定的”
CREATE TABLE IF NOT EXISTS process_step_revision(
  rev_id TEXT PRIMARY KEY, project_id TEXT, step_id TEXT, step_no TEXT, ver TEXT,
  status TEXT, data_json TEXT, changed_by TEXT, changed_at TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS fmea_header(
  fmea_id TEXT PRIMARY KEY, project_id TEXT, fmea_type TEXT, title TEXT,
  ap_ver TEXT DEFAULT 'AP-2019', status TEXT DEFAULT '草稿', rev TEXT DEFAULT 'r1',
  meta_json TEXT, published_at TEXT, published_by TEXT, approved_by TEXT
);
CREATE TABLE IF NOT EXISTS fmea_node(
  node_id TEXT PRIMARY KEY, fmea_id TEXT, parent_id TEXT, node_type TEXT,
  node_subtype TEXT, seq INTEGER, name TEXT, char_id TEXT, desc TEXT, level INTEGER,
  status TEXT DEFAULT '生效'
);
CREATE TABLE IF NOT EXISTS fmea_row(
  row_id TEXT PRIMARY KEY, fmea_id TEXT, focus_node_id TEXT, fe_id TEXT, fm_id TEXT,
  fc_id TEXT, char_id TEXT, process_char_id TEXT, step_id TEXT, s INTEGER, o INTEGER, d INTEGER, ap TEXT,
  pc_text TEXT, dc_text TEXT, effect_ref TEXT, seq INTEGER,
  s_plant INTEGER, s_ship INTEGER, s_user INTEGER, filter_code TEXT,
  func_id TEXT, upstream_row_id TEXT
);
CREATE TABLE IF NOT EXISTS fmea_action(
  action_id INTEGER PRIMARY KEY AUTOINCREMENT, row_id TEXT, action_type TEXT,
  description TEXT, owner TEXT, due_date TEXT, status TEXT DEFAULT '未开始',
  completed_at TEXT, improved_dim TEXT, s_after INTEGER, o_after INTEGER, d_after INTEGER,
  ap_after TEXT, effect_verified INTEGER DEFAULT 0, evidence_ref TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS fmea_decision(
  row_id TEXT PRIMARY KEY, decision TEXT, rationale TEXT, approved_by TEXT,
  review_due TEXT, status TEXT DEFAULT '待评审', approved_at TEXT
);
CREATE TABLE IF NOT EXISTS control_plan(
  cp_id TEXT PRIMARY KEY, project_id TEXT, stage TEXT, rev TEXT, part_no TEXT,
  part_name TEXT, customer TEXT, plant TEXT, prepared_by TEXT, approved_by TEXT,
  status TEXT DEFAULT '草稿', effective_date TEXT,
  safe_launch_applicability TEXT DEFAULT '未判定',
  safe_launch_status TEXT DEFAULT '未开始',
  safe_launch_note TEXT,
  safe_launch_entry_criteria TEXT, safe_launch_exit_criteria TEXT,
  safe_launch_exited_by TEXT, safe_launch_exited_at TEXT
);
CREATE TABLE IF NOT EXISTS cp_row(
  cp_row_id TEXT PRIMARY KEY, cp_id TEXT, seq INTEGER, step_id TEXT, char_id TEXT,
  project_char_id TEXT,
  fmea_row_id TEXT, spec_text TEXT, measure_tech TEXT, gauge_id TEXT,
  sample_size INTEGER, freq_value REAL, freq_unit TEXT, freq_trigger TEXT,
  control_method TEXT, reaction_plan TEXT, is_spc INTEGER DEFAULT 0,
  override_flag INTEGER DEFAULT 0, override_reason TEXT, upstream_ver TEXT,
  override_fields_json TEXT
);
-- 控制计划版本快照：批准/降级时保存表头+全部行，回答“上一版是怎么规定的”
CREATE TABLE IF NOT EXISTS cp_revision(
  rev_id TEXT PRIMARY KEY, project_id TEXT, cp_id TEXT, rev TEXT, status TEXT,
  header_json TEXT, rows_json TEXT, changed_by TEXT, changed_at TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS gauge(
  gauge_id TEXT PRIMARY KEY, code TEXT, name TEXT, model TEXT, range_text TEXT,
  calibration_due TEXT, owner_dept TEXT, status TEXT DEFAULT '在用', resolution REAL
);
CREATE TABLE IF NOT EXISTS msa_study(
  study_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, gauge_id TEXT, study_type TEXT,
  char_id TEXT, project_char_id TEXT, tolerance REAL,
  result_pct REAL, ev_pct REAL, av_pct REAL, pct_tol REAL, ndc INTEGER, judgment TEXT,
  studied_at TEXT, operator TEXT, raw_json TEXT,
  plan_id TEXT, status TEXT DEFAULT '已计算', completed_by TEXT, completed_at TEXT,
  plan_snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS msa_plan_item(
  plan_id TEXT PRIMARY KEY, project_id TEXT, project_char_id TEXT, char_id TEXT,
  gauge_id TEXT, gauge_code_snapshot TEXT, gauge_name_snapshot TEXT,
  study_type TEXT DEFAULT 'GRR', parts INTEGER DEFAULT 10,
  operators INTEGER DEFAULT 3, trials INTEGER DEFAULT 3, planned_date TEXT,
  owner TEXT, status TEXT DEFAULT '计划', trigger_source TEXT DEFAULT 'SPC',
  study_id INTEGER, cp_row_id TEXT, monitor_id TEXT, note TEXT,
  created_at TEXT, updated_at TEXT, completed_at TEXT,
  source_key TEXT, source_version TEXT, measure_tech TEXT, spec_text TEXT,
  char_name_snapshot TEXT, char_unit_snapshot TEXT, char_target_snapshot REAL,
  char_lsl_snapshot REAL, char_usl_snapshot REAL, char_tol_text_snapshot TEXT,
  tolerance REAL, source_active INTEGER DEFAULT 1, source_status TEXT DEFAULT '有效'
);
CREATE TABLE IF NOT EXISTS monitoring_item(
  mon_id TEXT PRIMARY KEY, cp_row_id TEXT, is_spc INTEGER DEFAULT 1, chart_type TEXT,
  char_id TEXT, project_char_id TEXT,
  subgroup_n INTEGER, freq_value REAL, freq_unit TEXT, cpk_target REAL,
  gauge_id TEXT, before_sort INTEGER DEFAULT 1, status TEXT DEFAULT '启用',
  approval_status TEXT DEFAULT '待审核', approved_by TEXT, approved_at TEXT,
  review_note TEXT, created_by TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS spc_dataset(
  dataset_id INTEGER PRIMARY KEY AUTOINCREMENT, mon_id TEXT, batch_no TEXT,
  imported_at TEXT, imported_by TEXT, file_hash TEXT, data_json TEXT, n_sub INTEGER
);
CREATE TABLE IF NOT EXISTS baseline(
  baseline_id TEXT PRIMARY KEY, project_id TEXT, tag TEXT, version TEXT,
  hash TEXT, frozen_at TEXT, frozen_by TEXT, note TEXT, scope_json TEXT, status TEXT DEFAULT '冻结'
);
CREATE TABLE IF NOT EXISTS baseline_item(
  item_id INTEGER PRIMARY KEY AUTOINCREMENT, baseline_id TEXT, object_type TEXT,
  object_id TEXT, object_hash TEXT, snapshot TEXT
);
CREATE TABLE IF NOT EXISTS change_request(
  cr_id TEXT PRIMARY KEY, project_id TEXT, base_baseline TEXT, title TEXT,
  reason TEXT, status TEXT DEFAULT '草稿', requested_by TEXT, created_at TEXT,
  approved_by TEXT, planned_date TEXT, source_type TEXT, source_id TEXT,
  payload_json TEXT, applied_at TEXT
);
CREATE TABLE IF NOT EXISTS change_item(
  ci_id INTEGER PRIMARY KEY AUTOINCREMENT, cr_id TEXT, object_type TEXT,
  object_id TEXT, change_type TEXT, distance INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS audit_event(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT,
  object_type TEXT, object_id TEXT, before_json TEXT, after_json TEXT,
  reason TEXT, created_at TEXT, project_id TEXT, ip TEXT, session_id TEXT
);
CREATE TABLE IF NOT EXISTS ap_matrix(
  s INTEGER, o INTEGER, d INTEGER, ap TEXT, k INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS apqp_phase(
  project_id TEXT, phase INTEGER, name TEXT, status TEXT DEFAULT '未开始',
  gate_criteria TEXT, PRIMARY KEY(project_id, phase)
);
CREATE TABLE IF NOT EXISTS apqp_task(
  task_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, phase INTEGER,
  name TEXT, owner TEXT, due TEXT, status TEXT DEFAULT '未开始',
  deliverable TEXT, weight INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ppap_element(
  project_id TEXT, element_no INTEGER, name TEXT, required INTEGER DEFAULT 1,
  status TEXT DEFAULT '未完成', evidence TEXT, note TEXT,
  PRIMARY KEY(project_id, element_no)
);
CREATE TABLE IF NOT EXISTS ppap_package(
  pkg_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, level INTEGER,
  baseline_id TEXT, created_at TEXT, manifest TEXT, pkg_hash TEXT,
  zip_path TEXT, zip_hash TEXT, file_count INTEGER
);
CREATE TABLE IF NOT EXISTS ppap_submission(
  project_id TEXT PRIMARY KEY, level INTEGER DEFAULT 3, submission_reason TEXT DEFAULT '',
  customer TEXT DEFAULT '', organization TEXT DEFAULT '', part_revision TEXT DEFAULT '',
  requested_by TEXT DEFAULT '', requested_at TEXT DEFAULT '', approved_by TEXT DEFAULT '',
  approved_at TEXT DEFAULT '', status TEXT DEFAULT '准备中', updated_at TEXT DEFAULT '',
  baseline_id TEXT, required_items_json TEXT
);
-- B-04：质量门不满足时的书面偏差；批准后只对指定 PPAP 要素、在有效期内放行
CREATE TABLE IF NOT EXISTS ppap_deviation(
  deviation_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
  element_no INTEGER NOT NULL, source_type TEXT DEFAULT '', reason TEXT NOT NULL,
  object_ref TEXT DEFAULT '', valid_until TEXT DEFAULT '',
  requested_by TEXT DEFAULT '', requested_at TEXT DEFAULT '',
  approved_by TEXT DEFAULT '', approved_at TEXT DEFAULT '',
  status TEXT DEFAULT '待批准', note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS project_doc(
  doc_code TEXT, project_id TEXT, status TEXT DEFAULT '未开始', owner TEXT,
  data_json TEXT, updated_at TEXT, updated_by TEXT, version TEXT DEFAULT 'V1.0',
  custom_name TEXT, hidden INTEGER DEFAULT 0, cols_json TEXT,
  submitted_by TEXT, submitted_at TEXT, approved_by TEXT, approved_at TEXT,
  rejected_reason TEXT, published_version TEXT,
  PRIMARY KEY(doc_code, project_id)
);
CREATE TABLE IF NOT EXISTS doc_template(
  tpl_id TEXT PRIMARY KEY, name TEXT, phase INTEGER, source TEXT, filename TEXT,
  schema_json TEXT, status TEXT DEFAULT '草稿', pct INTEGER DEFAULT 0,
  created_at TEXT, created_by TEXT, updated_at TEXT, doc_code TEXT,
  project_id TEXT, mapping_json TEXT, mapping_status TEXT DEFAULT '未配置',
  approved_by TEXT, approved_at TEXT, source_path TEXT
);
CREATE TABLE IF NOT EXISTS gate_review(
  project_id TEXT, phase INTEGER, decision TEXT, reviewer TEXT, comment TEXT,
  reviewed_at TEXT, checks_json TEXT, criteria_version TEXT, actions_json TEXT,
  PRIMARY KEY(project_id, phase)
);
CREATE TABLE IF NOT EXISTS ecr(
  ecr_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, reason TEXT, scope TEXT,
  status TEXT DEFAULT '待审批', requested_by TEXT, created_at TEXT,
  approved_by TEXT, baseline_id TEXT, branch_baseline_id TEXT
);
CREATE TABLE IF NOT EXISTS fmea_image(
  fmea_id TEXT PRIMARY KEY, data TEXT, labels_json TEXT, created_at TEXT
);
-- 交付物附件（包装图片、工程图预览与 CAD 源文件）：二进制存文件系统，表只存元数据，
-- 避免把 base64 塞进 project_doc.data_json 后被每次版本快照整份复制。
CREATE TABLE IF NOT EXISTS doc_attachment(
  attachment_id TEXT PRIMARY KEY, project_id TEXT, doc_code TEXT,
  category TEXT, caption TEXT, group_label TEXT,
  file_name TEXT, mime TEXT, size INTEGER, sha256 TEXT, storage_path TEXT,
  sort_order INTEGER DEFAULT 0, status TEXT DEFAULT '有效',
  created_by TEXT, created_at TEXT, voided_by TEXT, voided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_attachment_doc
  ON doc_attachment(project_id, doc_code, category, status);
CREATE TABLE IF NOT EXISTS app_setting(
  k TEXT PRIMARY KEY, v TEXT
);
CREATE TABLE IF NOT EXISTS auth_user(
  user_id TEXT PRIMARY KEY, username TEXT UNIQUE, display_name TEXT,
  role TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  status TEXT DEFAULT '启用', created_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_session(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- 项目成员关系：某项目一旦配置成员，非成员（admin 除外）不得通过 ?p= 访问
CREATE TABLE IF NOT EXISTS project_member(
  project_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT,
  PRIMARY KEY(project_id, user_id)
);
CREATE TABLE IF NOT EXISTS fmea_function(
  func_id TEXT PRIMARY KEY, node_id TEXT, text TEXT,
  status TEXT DEFAULT '正式', source TEXT DEFAULT 'manual',
  seq INTEGER DEFAULT 0, created_at TEXT, rationale TEXT
);
CREATE TABLE IF NOT EXISTS fmea_failure_cand(
  cand_id TEXT PRIMARY KEY, node_id TEXT, func_id TEXT,
  effect TEXT, mode TEXT, cause TEXT, s INTEGER DEFAULT 8,
  status TEXT DEFAULT '候选', source TEXT DEFAULT 'ai', created_at TEXT,
  pc TEXT, dc TEXT, cat TEXT, row_id TEXT
);
CREATE TABLE IF NOT EXISTS project_doc_revision(
  rev_id TEXT PRIMARY KEY, doc_code TEXT, project_id TEXT, version TEXT,
  status TEXT, data_json TEXT, cols_json TEXT, changed_by TEXT, changed_at TEXT,
  change_note TEXT, approved_by TEXT, approved_at TEXT
);
CREATE TABLE IF NOT EXISTS activity_approval(
  approval_id TEXT PRIMARY KEY, project_id TEXT, action_type TEXT, object_type TEXT,
  object_id TEXT, title TEXT, payload_json TEXT, status TEXT DEFAULT '待审批',
  requested_by TEXT, requested_at TEXT, approved_by TEXT, approved_at TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS export_event(
  export_id TEXT PRIMARY KEY, project_id TEXT, object_type TEXT, object_id TEXT,
  format TEXT, baseline_id TEXT, file_name TEXT, file_hash TEXT,
  exported_by TEXT, exported_at TEXT
);
`;

/* ------------------------------------------------------------------ 工具 */
function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}
function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}
function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(passwordDigest(password, salt), 'hex');
  const target = Buffer.from(String(expected || ''), 'hex');
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}
function now() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
function rid(prefix, n) {
  return prefix + String(n).padStart(4, '0');
}

function ensureColumn(table, column, definition = 'TEXT') {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message || e))) throw e;
  }
}

function migrateMsaPlanUniqueness() {
  const uniqueIndexes = db.prepare("PRAGMA index_list('msa_plan_item')").all()
    .filter(index => index.unique && index.origin !== 'pk');
  const legacyIndex = uniqueIndexes.find(index => {
    const columns = db.prepare(`PRAGMA index_info("${index.name.replace(/"/g, '""')}")`).all()
      .map(column => column.name);
    return columns.length === 2 && columns.includes('project_id') && columns.includes('project_char_id');
  });
  if (!legacyIndex) return;
  if (legacyIndex.origin === 'c') {
    db.exec(`DROP INDEX "${legacyIndex.name.replace(/"/g, '""')}"`);
    return;
  }
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='msa_plan_item'").get();
  const schema = table.sql.replace(/,\s*UNIQUE\s*\(\s*project_id\s*,\s*project_char_id\s*\)/i, '');
  if (schema === table.sql) throw new Error('MSA 计划唯一约束迁移失败');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='msa_plan_item' AND sql IS NOT NULL").all();
  const columns = db.prepare("PRAGMA table_info('msa_plan_item')").all()
    .map(column => `"${column.name.replace(/"/g, '""')}"`).join(',');
  tx(() => {
    db.exec(schema.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?msa_plan_item/i, 'CREATE TABLE msa_plan_item_migration'));
    db.exec(`INSERT INTO msa_plan_item_migration(${columns}) SELECT ${columns} FROM msa_plan_item`);
    db.exec('DROP TABLE msa_plan_item');
    db.exec('ALTER TABLE msa_plan_item_migration RENAME TO msa_plan_item');
    for (const index of indexes) db.exec(index.sql);
  });
}

function tx(fn, mode = 'IMMEDIATE') {
  const savepoint = db.isTransaction ? `qms_tx_${++transactionSequence}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
  try {
    const result = fn();
    // S-16：事务包装是同步的；async 回调会在第一个 await 处提前提交，必须显式拒绝
    if (result && typeof result.then === 'function') {
      throw new Error('DB.tx() 不支持 async 回调：请在事务外完成异步操作，事务内只做同步写入');
    }
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
      if (savepoint) db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (e) { /* 保留原始错误 */ }
    throw error;
  }
}

// Q-16：Cpk 目标默认值集中一处，预警、SPC 配置、PPAP 就绪与页面共用
const DEFAULT_CPK_TARGET = 1.33;

/* ------------------------------------------------------------------ AP 矩阵 */
const AP_BANDS = [
  [[9, 10], [6, 10], [[10, 'H']]],
  [[9, 10], [4, 5], [[10, 'H']]],
  [[9, 10], [2, 3], [[3, 'M'], [6, 'M'], [10, 'H']]],
  [[9, 10], [1, 1], [[3, 'L'], [6, 'M'], [10, 'H']]],
  [[7, 8], [8, 10], [[10, 'H']]],
  [[7, 8], [6, 7], [[7, 'M'], [10, 'H']]],
  [[7, 8], [4, 5], [[4, 'M'], [7, 'M'], [10, 'H']]],
  [[7, 8], [2, 3], [[7, 'L'], [10, 'M']]],
  [[7, 8], [1, 1], [[10, 'L']]],
  [[5, 6], [8, 10], [[4, 'M'], [7, 'M'], [10, 'H']]],
  [[5, 6], [5, 7], [[7, 'M'], [10, 'M']]],
  [[5, 6], [3, 4], [[7, 'L'], [10, 'M']]],
  [[5, 6], [1, 2], [[10, 'L']]],
  [[1, 4], [8, 10], [[7, 'L'], [10, 'M']]],
  [[1, 4], [1, 7], [[10, 'L']]],
];
/** 仅按内置 AP 规则计算（种子/自愈用，不读表）。 */
function bandLookup(s, o, d) {
  for (const [sr, or, bands] of AP_BANDS) {
    if (s >= sr[0] && s <= sr[1] && o >= or[0] && o <= or[1]) {
      for (const [dmax, ap] of bands) if (d <= dmax) return ap;
    }
  }
  return '?';
}

function apLookup(s, o, d) {
  if (db) {
    try {
      const row = db.prepare('SELECT ap FROM ap_matrix WHERE s=? AND o=? AND d=?').get(s, o, d);
      if (row && row.ap) return row.ap;
    } catch (e) { /* 初始化阶段回退到内置规则 */ }
  }
  return bandLookup(s, o, d);
}

/** F-03：启动时校验 1000 格，缺格按内置规则补齐，避免不同安装得到不同 AP。 */
function healApMatrix() {
  const ins = db.prepare('INSERT OR IGNORE INTO ap_matrix(s,o,d,ap,k) VALUES(?,?,?,?,?)');
  let inserted = 0;
  for (let s = 1; s <= 10; s += 1) {
    for (let o = 1; o <= 10; o += 1) {
      for (let d = 1; d <= 10; d += 1) {
        const result = ins.run(s, o, d, bandLookup(s, o, d), s * 100 + o * 10 + d);
        inserted += Number(result.changes || 0);
      }
    }
  }
  const count = db.prepare('SELECT COUNT(*) c FROM ap_matrix').get().c;
  if (inserted) console.warn(`[AP 矩阵] 已补齐 ${inserted} 个缺失格，当前 ${count}/1000`);
  if (count < 1000) console.warn(`[AP 矩阵] 仍缺少 ${1000 - count} 格，请检查数据库完整性`);
  return { inserted, count };
}

/* ------------------------------------------------------------------ 种子数据 */
function seededRand(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}
function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const APQP_TASKS = [
  [1, '概念立项与 5T 分析', '产品经理', '完成项目章程、5T（意图/时间/团队/任务/工具）分析', '项目章程、5T 表'],
  [1, '客户要求收集与可行性', '质量', '收集图纸/技术协议/CSR，输出可行性评审', '客户要求清单、可行性报告'],
  [1, '初始特殊特性清单', '设计', '识别 CC/SC 候选并确定符号映射', '初始特殊特性清单'],
  [2, 'DFMEA（七步法）', '设计', '完成结构/功能/失效/风险/优化五步', 'DFMEA 表单、高 AP 处置台账'],
  [2, '设计验证计划（DVP）', '设计', '按 AEC-Q200 与客户要求编排验证项', 'DVP&R'],
  [3, 'PFD 工艺流程图', '工艺', '工序分解、类型标注、发布', 'PFD'],
  [3, 'PFMEA（七步法）', '工艺', '4M 要素建模、失效分析、措施', 'PFMEA 表单'],
  [3, '控制计划（试生产）', '工艺', '自动映射 + 反应计划 + 检具', '试生产控制计划'],
  [3, 'MSA 计划', '质量', '识别需做 GR&R 的检具并排期', 'MSA 计划表'],
  [4, '试生产与 SPC 验证', '质量', '收集数据、计算 Cpk/Ppk、判定能力', 'SPC 报告'],
  [4, 'MSA 实施（GR&R）', '质量', '按计划完成研究并判定', 'MSA 报告'],
  [4, 'PPAP 文件准备', '质量', '按等级收集 18 项要素', 'PPAP 包'],
  [5, '量产控制计划与反应计划', '工艺', '量产 CP 升版、反应计划确认', '量产控制计划'],
  [5, '持续改进与年度复审', '质量', '年度 FMEA/CP 复审、Cpk 监控', '复审记录'],
];

const PPAP_ELEMENTS = [
  '设计记录', '工程更改文件', '顾客工程批准', 'DFMEA', '过程流程图', 'PFMEA',
  '控制计划', '测量系统分析研究', '尺寸结果', '材料/性能试验结果', '初始过程研究',
  '合格实验室文件', '外观批准报告（AAR）', '生产件样品', '标准样品', '检具清单',
  '顾客特殊要求记录', '零件提交保证书（PSW）',
];

const PRODUCT_FAMILIES = [
  ['FM', 'RJ', '金属膜固定电阻器', '通用类产品'],
  ['FW', 'RX', '绕线固定电阻器', '通用类产品'],
  ['PF-CHIP-THIN', 'CHIP-THIN', '片式薄膜电阻器', '通用类产品'],
  ['PF-CHIP-FOIL', 'CHIP-FOIL', '片式合金箔电阻器', '通用类产品'],
  ['PF-CHIP-THICK', 'CHIP-THICK', '片式厚膜电阻器', '通用类产品'],
  ['PF-CHIP-NET', 'CHIP-NET', '片式电阻网络', '通用类产品'],
  ['PF-PLUG-NET', 'PLUG-NET', '插装电阻网络', '通用类产品'],
  ['PF-FOIL', 'FOIL', '合金箔电阻器', '特种类产品'],
  ['PF-GLASS', 'GLASS', '玻璃釉膜电阻器', '通用类产品'],
  ['PF-HVPULSE', 'HV-PULSE', '高压脉冲电阻器', '特种类产品'],
  ['PF-HIGHPOWER', 'HIGHPOWER', '大功率电阻器', '特种类产品'],
  ['PF-CERAMIC', 'CERAMIC', '陶瓷电阻器', '特种类产品'],
  ['PF-THERMAL', 'THERMAL', '铂热敏电阻器', '特种类产品'],
  ['PF-FUSE', 'FUSE', '熔断器', '特种类产品'],
  ['PF-LOW-OHM', 'LOW-OHM', '超低阻 / 采样电阻器', '特种类产品'],
  ['PF-CUSTOM', 'CUSTOM', '定制化产品', '特种类产品'],
];

const PRODUCT_SERIES = [
  ['FM', 'RJ', 'RJ 系列金属膜固定电阻器'],
  ['FM', 'RJ23/RJ24/RJ25/RJ57/RJ58', '高稳定金属膜固定电阻器'],
  ['FM', 'RJ13/RJ14/RJ15/RJ16/RJ17', '金属膜固定电阻器'],
  ['FM', 'RJ14S/RJ15S/RJ16S/RJ24A/RJ25A', '金属膜固定电阻器'],
  ['FM', 'RY94/RY95/RY97/RY98/RY99', '耐电冲击金属氧化膜固定电阻器'],
  ['FM', 'RYG1/RYG2', '金属氧化膜固定电阻器'],
  ['FW', 'RX', 'RX 绕线电阻器'],
  ['FW', 'RXG21', '功率型线绕固定电阻器'],
  ['FW', 'RX81', '功率型线绕固定电阻器'],
  ['FW', 'RXG712', '功率型线绕固定电阻器'],
  ['FW', 'RX21/RX21A', '功率型线绕固定电阻器'],
  ['FW', 'RXG210', '功率型线绕固定电阻器'],
  ['FW', 'RX70/RX76/RX72-1', '精密型线绕固定电阻器'],
  ['FW', 'RX71/RX12-3', '精密型线绕固定电阻器'],
  ['FW', 'RXG24/RXHG', '功率型线绕固定电阻器'],
  ['FW', 'RX20/RX22', '被釉线绕固定电阻器'],
  ['FW', 'RXGA/RXGA-7A/RXGA-9A', '功率型线绕固定电阻器'],
  ['FW', 'RX9E-1/RXS2-6000', '水冷线绕固定电阻器'],
  ['PF-CHIP-THIN', 'RMK', '有失效率等级片式薄膜固定电阻器'],
  ['PF-CHIP-THIN', 'RM', '片式薄膜固定电阻器'],
  ['PF-CHIP-THIN', 'RMV', '耐湿热片式薄膜固定电阻器'],
  ['PF-CHIP-THIN', 'RMTME', '车规级片式薄膜固定电阻器'],
  ['PF-CHIP-THIN', 'RMCT', '芯片薄膜电阻器'],
  ['PF-CHIP-FOIL', 'RMK/RM', '片式合金箔固定电阻器'],
  ['PF-CHIP-FOIL', 'RMBK7050', '密封精密片式合金箔固定电阻器'],
  ['PF-CHIP-THICK', 'RMK/RM', '片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMF', '车规级片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RII-15', '片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMZ', '零欧姆片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMG', '功率型片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMHV/RMHT', '高压 / 高温片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMS', '抗浪涌片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMK6363', '火工品片式厚膜固定电阻器'],
  ['PF-CHIP-THICK', 'RMAS/RMGAS/RMHVAS', '抗硫化片式厚膜固定电阻器'],
  ['PF-CHIP-NET', 'RNK5084/RNK5085', '有失效率等级表面安装电阻网络'],
  ['PF-CHIP-NET', 'RNZ', '零欧姆表面安装电阻网络'],
  ['PF-CHIP-NET', 'RN5084/RN5085/RN5086/RN5161', '表面安装电阻网络'],
  ['PF-CHIP-NET', 'RNK5083', '表面安装电阻网络'],
  ['PF-CHIP-NET', 'RN5042/RN5062/RN5087', '表面安装电阻网络'],
  ['PF-CHIP-NET', 'RNCT', '芯片薄膜电阻网络'],
  ['PF-PLUG-NET', 'RN1032/RN1042/RN1052/RN1062/RN1072/RN1082/RN1092/RN1102', '膜固定电阻网络'],
  ['PF-PLUG-NET', 'RNII-6/RN1063/RN1083/RN1103', '厚膜 SIP 电阻网络'],
  ['PF-PLUG-NET', 'RN5162/RN5141', '双列表面贴装厚膜电阻网络'],
  ['PF-PLUG-NET', 'RN2', '双列直插 DIP 电阻网络'],
  ['PF-FOIL', 'RJK711/RNC', '精密合金箔固定电阻器'],
  ['PF-FOIL', 'RJL-18', '高精密合金箔固定电阻器'],
  ['PF-FOIL', 'RJK711S/RJ711S/RJ712S', '精密合金箔固定电阻器'],
  ['PF-FOIL', 'RJ711H/RJ711F', '密封合金箔固定电阻器 / 分压器'],
  ['PF-GLASS', 'RI12/RI21/RI21A/RI42', '玻璃釉膜固定电阻器'],
  ['PF-GLASS', 'RI71/RI72/RI80/RI81', '精密及高压玻璃釉膜电阻器'],
  ['PF-GLASS', 'RI80F/RI814F/RI81A/RI81C', '高压玻璃釉膜电阻器 / 分压器'],
  ['PF-GLASS', 'RI829/RI88/RI89', '玻璃釉膜固定电阻器'],
  ['PF-GLASS', 'RIG1/RIG1A/RIG2/RIG5', '玻璃釉膜固定电阻器'],
  ['PF-HVPULSE', 'RI83/(G)RI83A', '高压脉冲固定电阻器'],
  ['PF-HVPULSE', 'RI85/RI85C/RI85A/RI85D', '高压脉冲固定电阻器'],
  ['PF-HIGHPOWER', 'RIG4/400/RJG4/400', '散热器安装功率电阻器'],
  ['PF-HIGHPOWER', 'RIG4/300A/RIG4/600/RIG4/800A', '散热器安装玻璃釉膜固定电阻器'],
  ['PF-HIGHPOWER', 'RIGB-1/RIGB-2/RIGB-3', '功率型玻璃釉膜固定电阻器'],
  ['PF-HIGHPOWER', 'RIGB-5/RIGB-5C/RIGB-5E/RIGB-7', '功率型玻璃釉膜固定电阻器'],
  ['PF-HIGHPOWER', 'RXGD-3/RJGA-1/RJGD-1/RXGC', '定制大功率电阻器'],
  ['PF-CERAMIC', 'RSL', '氧化锡陶瓷固定电阻器'],
  ['PF-CERAMIC', 'RCC/RCD', '碳陶瓷固定电阻器'],
  ['PF-THERMAL', 'MZBB', '铂薄膜热敏电阻器'],
  ['PF-THERMAL', 'WZPK-3C/WZPK-3', '铠装铂电阻器'],
  ['PF-FUSE', 'CFF', '片式熔断器'],
  ['PF-LOW-OHM', 'RML(A)/RML(C)/RML(D)', '超低阻精密片式固定电阻器'],
  ['PF-LOW-OHM', 'RMLK(C)/RMLK7142DW', '有失效率等级超低阻精密片式固定电阻器'],
  ['PF-LOW-OHM', 'RML11570CW/RML6332BK/RML9194BK/RML26013B', '超低阻精密片式固定电阻器'],
  ['PF-LOW-OHM', 'RMLG(B)', '超低阻功率片式固定电阻器'],
  ['PF-CUSTOM', 'RJS/640P/RJS/500', '绝缘双冷合金带电阻柜'],
];

const STEPS = [
  ['05', '领料与来料检验', '检验', '数显电桥、卡尺', '基体/靶材/浆料', '合格物料'],
  ['10', '基体准备', '制造', '清洗槽、烘箱', '合格瓷基体', '洁净基体'],
  ['20', '成膜（磁控溅射）', '制造', '磁控溅射镀膜机', '洁净基体、靶材', '带膜基体'],
  ['25', '热处理（退火）', '制造', '退火炉', '带膜基体', '稳定化基体'],
  ['30', '激光调阻', '制造', '激光调阻机', '稳定化基体', '调阻后基体'],
  ['35', '中间检验', '检验', '数显电桥、TCR 测试台', '调阻后基体', '合格半成品'],
  ['40', '端电极与引线焊接', '制造', '焊接机', '合格半成品、焊料', '焊接件'],
  ['45', '涂装 / 包封', '制造', '浸涂机', '焊接件、包封料', '包封件'],
  ['50', '固化 / 烘干', '制造', '固化炉', '包封件', '固化件'],
  ['55', '打标', '制造', '激光打标机', '固化件', '打标件'],
  ['60', '测试分选', '检验', '自动分选机', '打标件', '合格成品'],
  ['65', '包装入库', '储存', '编带机', '合格成品', '成品箱'],
];

function seed() {
  const proj = 'RES-CHIP-2026-01';
  const DT = require('./doctpl');
  const DT_PHASES = DT.PHASES;

  db.exec("INSERT OR IGNORE INTO product_family(family_id,code,name,category,status) VALUES('FM','RJ','金属膜固定电阻器','RES-FILM','生效')");
  db.exec("INSERT OR IGNORE INTO product_series VALUES('SR-RJ','FM','RJ','RJ 系列','生效')");
  db.exec("INSERT OR IGNORE INTO product_series VALUES('SR-RX','FW','RX','RX 系列','生效')");
  db.exec(`INSERT INTO project(
    project_id,code,name,family_id,series_id,customer,standard,phase,owner,status,start_date,part_no
  ) VALUES('${proj}','${proj}','RJ 系列 1/4W 金属膜电阻器',
    'FM','SR-RJ','车规客户 A','AIAG-VDA 2019',3,'张工艺','进行中','2026-01-12','RJ-0.25W-10K')`);

  // ---- AP 矩阵（F-03：INSERT OR IGNORE，初始化中断后重跑可补齐）
  const insAp = db.prepare('INSERT OR IGNORE INTO ap_matrix(s,o,d,ap,k) VALUES(?,?,?,?,?)');
  for (let s = 1; s <= 10; s++)
    for (let o = 1; o <= 10; o++)
      for (let d = 1; d <= 10; d++)
        insAp.run(s, o, d, bandLookup(s, o, d), s * 100 + o * 10 + d);

  const insDict = db.prepare(`INSERT INTO process_dict(
    dict_id,code,name,step_type,default_equipment,effective_from,effective_to,status
  ) VALUES(?,?,?,?,?,?,?,?)`);
  STEPS.forEach(step => insDict.run(
    `PD-FM-${step[0]}`, step[0], step[1], step[2], step[3], '2026-01-01', null, '生效'
  ));

  // ---- 特性
  const chars = [
    ['CHR-D-0142', 'PRODUCT', '阻值精度', '电气', 'kΩ', 10, 9.9, 10.1, '±1.0%（9.90–10.10 kΩ）', 1, 'CC', '客户图纸', 'DR-2026-014', 'FM'],
    ['CHR-D-0151', 'PRODUCT', '湿热后阻值漂移', '环境', '%', 0, -0.5, 0.5, '±0.5% / 1000h', 1, 'SC', 'AEC-Q200', '耐湿试验', 'FM'],
    ['CHR-D-0163', 'PRODUCT', '耐压', '电气', 'V', 500, 500, null, '≥500 V AC 1min', 1, 'SAFETY', 'IEC 60115', '7.4', 'FM'],
    ['CHR-D-0171', 'PRODUCT', 'TCR', '电气', 'ppm/℃', 25, null, 50, '≤±50', 1, 'CC', '客户图纸', 'DR-2026-014', 'FM'],
    ['CHR-P-0031', 'PROCESS', '成膜厚度', '尺寸', 'μm', 1.2, 1.15, 1.25, '1.2±0.05 μm', 1, 'CC', '内部', 'DOE-2026-003', 'FM'],
    ['CHR-P-0047', 'PROCESS', '激光功率 / 切槽深度', '工艺参数', 'W', 12, 11.5, 12.5, '12±0.5 W', 1, 'CC', '内部', 'DOE-2026-007', 'FM'],
    ['CHR-P-0059', 'PROCESS', '退火温度', '工艺参数', '℃', 420, 410, 430, '420±10 ℃', 1, 'SC', '内部', 'PV-2025-011', 'FM'],
    ['CHR-P-0071', 'PROCESS', '焊接温度曲线', '工艺参数', '℃', 245, 235, 255, '235–255 ℃', 0, null, '内部', '—', 'FM'],
    ['CHR-P-0083', 'PROCESS', '包封前清洁度', '工艺参数', '级', null, null, null, '离子残留 ≤1.5 μg/cm²', 0, null, '内部', '—', 'FM'],
    ['CHR-P-0085', 'PROCESS', '涂层厚度', '尺寸', 'μm', 30, 25, 35, '25–35 μm', 1, 'SC', '内部', 'PV-2025-014', 'FM'],
  ];
  const insChar = db.prepare(`INSERT INTO char_master(
    char_id,char_kind,name,domain,unit,target,lsl,usl,tol_text,is_special,
    special_symbol,source_type,source_ref,family_id,status
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of chars) insChar.run(...c, '生效');

  // ---- 特性关联（穿透模型核心）
  const links = [
    ['CHR-D-0142', 'CHR-P-0031', '负相关', '强', '膜厚直接决定单位面积电阻（方阻），是一阶决定因素', 'DOE-2026-003'],
    ['CHR-D-0142', 'CHR-P-0047', '负相关', '强', '切槽减小有效导电截面，阻值随切槽单调上升', 'DOE-2026-007'],
    ['CHR-D-0142', 'CHR-P-0059', '非线性', '中', '消除应力、稳定晶格，抑制后续漂移；超温改变膜层结构', 'PV-2025-011'],
    ['CHR-D-0142', 'CHR-P-0071', '正相关', '弱', '端头接触电阻串入总阻值，虚焊时显著增大', '—'],
    ['CHR-D-0142', 'CHR-P-0083', '非线性', '弱', '残留离子在湿热下引起长期漂移，短期测量不可见', 'RL-2025-004'],
    ['CHR-D-0163', 'CHR-P-0047', '阈值型', '强', '切槽过深伤及基体，形成微裂纹 → 耐压失效', 'FA-2026-002'],
    ['CHR-D-0171', 'CHR-P-0031', '非线性', '中', '膜厚与膜层成分共同决定温度系数', 'DOE-2026-003'],
    ['CHR-D-0151', 'CHR-P-0085', '非线性', '强', '涂层致密性决定水汽渗透速率', 'RL-2025-004'],
  ];
  const insLink = db.prepare('INSERT INTO char_link(product_char_id,process_char_id,direction,strength,mechanism,evidence_ref,valid_baseline) VALUES(?,?,?,?,?,?,\'V1.0\')');
  for (const l of links) insLink.run(...l);

  // ---- 工序
  const insStep = db.prepare(`INSERT INTO process_step(
    step_id,project_id,step_no,name,step_type,seq,equipment,fixture,input_desc,output_desc,status,ver
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  STEPS.forEach((s, i) => insStep.run('PS-FM-' + s[0], proj, s[0], s[1], s[2], i + 1, s[3], '', s[4], s[5], '已发布', 'V1.0'));

  // ---- DFMEA
  db.exec(`INSERT INTO fmea_header(
    fmea_id,project_id,fmea_type,title,ap_ver,status,rev
  ) VALUES('DF-0001','${proj}','DFMEA','RJ 金属膜电阻器 设计 FMEA','AP-2019','已发布','r3')`);
  const dfNodes = [
    ['N-100', null, 'STRUCTURE', null, 1, 'RJ 金属膜电阻器'],
    ['N-101', 'N-100', 'STRUCTURE', null, 1, '电阻芯体'],
    ['N-102', 'N-100', 'STRUCTURE', null, 2, '包封层'],
    ['N-103', 'N-100', 'STRUCTURE', null, 3, '陶瓷基体'],
    ['N-200', 'N-101', 'FUNCTION', null, 1, '提供规定阻值'],
    ['N-201', 'N-101', 'FAILURE', 'FE', 1, '整机增益偏移，客户功能异常'],
    ['N-202', 'N-102', 'FAILURE', 'FE', 1, '湿热环境后阻值漂移超差'],
    ['N-203', 'N-103', 'FAILURE', 'FE', 1, '耐压击穿，存在起火风险'],
    ['N-301', 'N-201', 'FAILURE', 'FM', 1, '阻值超出 ±1.0% 允许偏差'],
    ['N-302', 'N-202', 'FAILURE', 'FM', 1, '长期阻值漂移'],
    ['N-303', 'N-203', 'FAILURE', 'FM', 1, '基体微裂纹导致绝缘失效'],
    ['N-401', 'N-301', 'FAILURE', 'FC', 1, '膜层厚度均匀性不足'],
    ['N-402', 'N-301', 'FAILURE', 'FC', 2, '激光调阻切槽深度偏差'],
    ['N-403', 'N-302', 'FAILURE', 'FC', 1, '包封致密性不足（气泡 / 针孔）'],
    ['N-404', 'N-303', 'FAILURE', 'FC', 1, '调阻切槽过深伤及基体'],
  ];
  const insNode = db.prepare(`INSERT INTO fmea_node(
    node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id
  ) VALUES(?,?,?,?,?,?,?,?)`);
  for (const n of dfNodes) insNode.run(n[0], 'DF-0001', n[1], n[2], n[3], n[4], n[5], null);

  const dfRows = [
    ['FR-DF-00001', 'N-101', 'N-201', 'N-301', 'N-401', 'CHR-D-0142', null, 8, 4, 3,
      '溅射功率与走速参数固化，首件确认', '首件阻值测试（每批）', null, 1],
    ['FR-DF-00002', 'N-101', 'N-201', 'N-301', 'N-402', 'CHR-D-0142', null, 8, 5, 2,
      '调阻程序版本管控，每班功率点检', '首件阻值 + 每 2h 抽检 5pcs', null, 2],
    ['FR-DF-00003', 'N-102', 'N-202', 'N-302', 'N-403', 'CHR-D-0151', null, 7, 4, 6,
      '涂料粘度管控，固化曲线固化', '湿热试验（抽样 1000h）', null, 3],
    ['FR-DF-00004', 'N-103', 'N-203', 'N-303', 'N-404', 'CHR-D-0163', null, 10, 6, 5,
      '切槽深度上限锁定在设备程序内', '耐压测试（100% 全检）', null, 4],
  ];
  const insRow = db.prepare(`INSERT INTO fmea_row(
    row_id,fmea_id,focus_node_id,fe_id,fm_id,fc_id,char_id,step_id,s,o,d,ap,pc_text,dc_text,effect_ref,seq
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of dfRows) {
    const [id, focus, fe, fm, fc, ch, st, s, o, d, pc, dc, eff, seq] = r;
    insRow.run(id, 'DF-0001', focus, fe, fm, fc, ch, st, s, o, d, apLookup(s, o, d), pc, dc, eff, seq);
  }
  db.exec(`INSERT INTO fmea_decision(
    row_id,decision,rationale,approved_by,review_due,status
  ) VALUES('FR-DF-00004','TAKE_ACTION','S=10 且 O≥4 时 AP 恒为 H，仅改善探测无法降低优先级，必须从切槽深度闭环控制入手降低 O。','质量经理 王','2027-03-31','已批准')`);
  const insAct = db.prepare(`INSERT INTO fmea_action(row_id,action_type,description,owner,due_date,status,completed_at,improved_dim,s_after,o_after,d_after,ap_after,effect_verified,evidence_ref)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insAct.run('FR-DF-00001', '预防', '增加膜厚在线监控（X 荧光）', '工艺-张', '2026-12-31', '进行中', null, 'O', 8, 3, 3, apLookup(8, 3, 3), 0, null);
  insAct.run('FR-DF-00002', '探测', '增加切槽深度视觉检测', '设备-李', '2027-03-31', '未开始', null, 'D', 8, 4, 2, apLookup(8, 4, 2), 0, null);
  insAct.run('FR-DF-00003', '预防', '增加涂层厚度在线测量', '工艺-王', '2026-12-31', '进行中', null, 'O', 7, 3, 4, apLookup(7, 3, 4), 0, null);
  insAct.run('FR-DF-00004', '预防', '增加切槽深度闭环控制（功率-深度反馈）', '设备-赵', '2027-06-30', '未开始', null, 'O', 10, 4, 4, apLookup(10, 4, 4), 0, null);

  // ---- PFMEA
  db.exec(`INSERT INTO fmea_header(
    fmea_id,project_id,fmea_type,title,ap_ver,status,rev
  ) VALUES('PF-0001','${proj}','PFMEA','RJ 金属膜电阻器 过程 FMEA','AP-2019','已发布','r2')`);
  const pfNodes = [
    ['P-100', null, 'STRUCTURE', null, 1, '电阻器制造'],
    ['P-110', 'P-100', 'STRUCTURE', null, 1, '20 成膜'],
    ['P-120', 'P-100', 'STRUCTURE', null, 2, '30 激光调阻'],
    ['P-130', 'P-100', 'STRUCTURE', null, 3, '45 涂装 / 包封'],
    ['P-121', 'P-120', 'STRUCTURE', null, 1, '机：激光器（聚焦镜片）'],
    ['P-122', 'P-120', 'STRUCTURE', null, 2, '法：调阻程序'],
    ['P-111', 'P-110', 'STRUCTURE', null, 1, '机：磁控溅射镀膜机'],
    ['P-131', 'P-130', 'STRUCTURE', null, 1, '环：洁净度'],
    ['P-201', 'P-120', 'FAILURE', 'FE', 1, '整机增益偏移（继承 DFMEA CHR-D-0142）'],
    ['P-202', 'P-130', 'FAILURE', 'FE', 1, '湿热后阻值漂移（继承 DFMEA CHR-D-0151）'],
    ['P-301', 'P-201', 'FAILURE', 'FM', 1, '切槽深度不均'],
    ['P-302', 'P-202', 'FAILURE', 'FM', 1, '涂层存在针孔 / 气泡'],
    ['P-311', 'P-201', 'FAILURE', 'FM', 2, '膜层厚度不均'],
    ['P-401', 'P-301', 'FAILURE', 'FC', 1, '聚焦镜片污染导致能量衰减'],
    ['P-402', 'P-301', 'FAILURE', 'FC', 2, '调阻程序版本错误（目标值与补偿量不匹配）'],
    ['P-411', 'P-311', 'FAILURE', 'FC', 1, '真空度不达标（泵抽速下降）'],
    ['P-421', 'P-302', 'FAILURE', 'FC', 1, '洁净度不足，粉尘落入湿膜'],
  ];
  for (const n of pfNodes) insNode.run(n[0], 'PF-0001', n[1], n[2], n[3], n[4], n[5], null);

  const pfRows = [
    ['FR-PF-00001', 'P-121', 'P-201', 'P-301', 'P-401', 'CHR-P-0047', 'PS-FM-30', 8, 4, 3,
      '每班清洁镜片 + 功率点检记录', '首件阻值 + 每 2h 抽检 5pcs', 'FR-DF-00001', 1],
    ['FR-PF-00002', 'P-122', 'P-201', 'P-301', 'P-402', 'CHR-P-0047', 'PS-FM-30', 8, 3, 2,
      '程序版本管控，换型双人确认', '首件阻值测试', 'FR-DF-00002', 2],
    ['FR-PF-00003', 'P-111', 'P-201', 'P-311', 'P-411', 'CHR-P-0031', 'PS-FM-20', 8, 3, 4,
      '真空度联锁，未达标不启动', 'X 荧光测厚（首件 + 每 2h）', 'FR-DF-00001', 3],
    ['FR-PF-00004', 'P-131', 'P-202', 'P-302', 'P-421', 'CHR-P-0085', 'PS-FM-45', 7, 4, 6,
      '涂装区正压 + 每班洁净度点检', '涂层厚度抽检 + 外观 100% 目视', 'FR-DF-00003', 4],
  ];
  for (const r of pfRows) {
    const [id, focus, fe, fm, fc, ch, st, s, o, d, pc, dc, eff, seq] = r;
    insRow.run(id, 'PF-0001', focus, fe, fm, fc, ch, st, s, o, d, apLookup(s, o, d), pc, dc, eff, seq);
  }
  db.exec(`INSERT INTO fmea_decision(
    row_id,decision,rationale,approved_by,review_due,status
  ) VALUES('FR-PF-00001','PENDING','待与设备部门确认镜片清洁频次是否可自动化','—','2026-12-31','待评审')`);

  // ---- 检具
  const gauges = [
    ['G-014', 'G-014', '数显电桥', 'TH2830', '0.001 Ω – 20 MΩ', '2027-05-20', '质量部'],
    ['G-021', 'G-021', 'X 荧光测厚仪', 'FISCHER XDL', '0 – 100 μm', '2026-11-01', '质量部'],
    ['G-033', 'G-033', '炉温记录仪', 'KIC 2000', '0 – 500 ℃', '2027-02-14', '工艺部'],
    ['G-045', 'G-045', '涂层测厚仪', 'PHYNIX FN', '0 – 1500 μm', '2026-12-10', '质量部'],
    ['G-060', 'G-060', '自动分选机', 'SR-200', '0.1 Ω – 10 MΩ', '2027-08-01', '质量部'],
  ];
  const gaugeResolutions = [0.001, 0.01, 0.1, 0.1, 0.001];
  const insG = db.prepare(`INSERT INTO gauge(
    gauge_id,code,name,model,range_text,calibration_due,owner_dept,status,resolution
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  gauges.forEach((g, index) => insG.run(...g, '在用', gaugeResolutions[index]));

  // ---- 控制计划
  db.exec(`INSERT INTO control_plan(
    cp_id,project_id,stage,rev,part_no,part_name,customer,plant,prepared_by,approved_by,status,effective_date
  ) VALUES('CP-CHIP-PILOT-r1','${proj}','PILOT','r1','RJ-0.25W-10K','金属膜固定电阻器',
    '车规客户 A','一厂','张工艺','—','已批准','2026-09-01')`);
  const cpRows = [
    ['CP-00020', 1, 'PS-FM-20', 'CHR-P-0031', 'FR-PF-00003', '1.15 – 1.25 μm', 'X 荧光测厚仪', 'G-021', 3, 2, 'h', '巡检', '真空度联锁 + 参数固化', '停机 → 隔离上一批 → 通知工艺 → 重新调机 → 首件确认', 1, 0, null],
    ['CP-00030', 2, 'PS-FM-30', 'CHR-P-0047', 'FR-PF-00001', '9.90 – 10.10 kΩ', '数显电桥', 'G-014', 5, 2, 'h', '首件,巡检', '功率闭环 + 程序版本校验', '停机 → 隔离上一批 → 校准功率 → 复测首件 → 追溯自上次合格起的全部产品', 1, 1, '客户要求抽检频次由 4h 改为 2h'],
    ['CP-00025', 3, 'PS-FM-25', 'CHR-P-0059', '—', '410 – 430 ℃', '炉温记录仪 + 热电偶', 'G-033', 1, 1, '炉', '每批', '温度曲线自动记录，超限报警', '隔离该炉产品 → 评估阻值漂移 → 必要时 100% 复测', 0, 0, null],
    ['CP-00045', 4, 'PS-FM-45', 'CHR-P-0085', 'FR-PF-00004', '25 – 35 μm', '涂层测厚仪', 'G-045', 3, 1, '批', '每批', '粘度管控 + 正压环境', '隔离该批 → 加做耐压测试 → 判定返工或报废', 1, 0, null],
    ['CP-00060', 5, 'PS-FM-60', 'CHR-D-0142', '—', '±1.0%', '自动分选机（电桥）', 'G-060', 1, 1, '件', '全检', '阈值受控 + 每班标准件校验', '停机 → 标准件复核设备 → 追溯自上次校验起的全部产品', 1, 0, null],
  ];
  const insCp = db.prepare(`INSERT INTO cp_row(
    cp_row_id,cp_id,seq,step_id,char_id,fmea_row_id,spec_text,measure_tech,gauge_id,
    sample_size,freq_value,freq_unit,freq_trigger,control_method,reaction_plan,
    is_spc,override_flag,override_reason,upstream_ver
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of cpRows) {
    insCp.run(r[0], 'CP-CHIP-PILOT-r1', r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10],
      r[11], r[12], r[13], r[14], r[15], r[16], 'PF-0001 r2');
  }

  // ---- 监控项
  db.exec(`INSERT INTO monitoring_item(
    mon_id,cp_row_id,is_spc,chart_type,subgroup_n,freq_value,freq_unit,cpk_target,gauge_id,before_sort,status,
    approval_status,approved_by,approved_at,created_by,created_at
  ) VALUES('MON-0001','CP-00060',1,'Xbar-R',5,2,'h',1.67,'G-060',0,'启用',
    '已批准','系统','${now()}','系统','${now()}')`);
  db.exec(`INSERT INTO monitoring_item(
    mon_id,cp_row_id,is_spc,chart_type,subgroup_n,freq_value,freq_unit,cpk_target,gauge_id,before_sort,status,
    approval_status,approved_by,approved_at,created_by,created_at
  ) VALUES('MON-0002','CP-00020',1,'Xbar-R',3,2,'h',1.33,'G-021',1,'启用',
    '已批准','系统','${now()}','系统','${now()}')`);

  // ---- SPC 数据（25 子组）
  const spcIns = db.prepare('INSERT INTO spc_dataset(mon_id,batch_no,imported_at,imported_by,file_hash,data_json,n_sub) VALUES(?,?,?,?,?,?,?)');
  const mk = (monId, batch, n, mean, sd, seedv) => {
    const rnd = seededRand(seedv);
    const subs = [];
    for (let i = 0; i < 25; i++) {
      const row = [];
      for (let j = 0; j < n; j++) row.push(+(mean + gauss(rnd) * sd).toFixed(4));
      subs.push({ t: `09-${String(Math.floor(i / 2) + 1).padStart(2, '0')} ${i % 2 ? '14' : '08'}:00`, v: row });
    }
    const json = JSON.stringify(subs);
    spcIns.run(monId, batch, now(), '质检-陈', crypto.createHash('sha256').update(json).digest('hex').slice(0, 16), json, 25);
  };
  mk('MON-0001', 'LOT-2609-A', 5, 10.0, 0.02, 7771);
  mk('MON-0002', 'LOT-2609-B', 3, 1.2, 0.035, 3312);

  // ---- MSA（GR&R 原始数据 + 结果）
  // M-04：先写入 char_id，项目与项目特性在 migrateProjectDefaults 之后回填
  const insMsa = db.prepare('INSERT INTO msa_study(gauge_id,study_type,result_pct,ev_pct,av_pct,ndc,judgment,studied_at,operator,raw_json,char_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const grr = (gauge, parts, ops, trials, base, partSd, measSd, when) => {
    const rnd = seededRand(parts * 7 + ops * 13 + trials);
    const partVals = Array.from({ length: parts }, (_, i) => base + gauss(rnd) * partSd);
    const data = [];
    for (let o = 0; o < ops; o++) {
      for (let t = 0; t < trials; t++) {
        data.push(partVals.map(pv => +(pv + gauss(rnd) * measSd).toFixed(4)));
      }
    }
    return { data, partVals };
  };
  const g1 = grr('G-014', 10, 3, 3, 10.0, 0.05, 0.006, '2026-06-12');
  const g2 = grr('G-021', 10, 3, 3, 1.2, 0.03, 0.013, '2025-09-18');
  const r1 = computeGRR(g1.data, 10, 3, 3, 0.2);   // 容差 0.2 kΩ
  const r2 = computeGRR(g2.data, 10, 3, 3, 0.1);
  insMsa.run('G-014', 'GRR', r1.pctGRR, r1.pctEV, r1.pctAV, r1.ndc, r1.judgment,
    '2026-06-12', '陈-计量', JSON.stringify(g1.data), 'CHR-D-0142');
  insMsa.run('G-021', 'GRR', r2.pctGRR, r2.pctEV, r2.pctAV, r2.ndc, r2.judgment,
    '2025-09-18', '陈-计量', JSON.stringify(g2.data), 'CHR-D-0151');

  // ---- APQP（第三版：阶段 0–5）
  const insPh = db.prepare('INSERT INTO apqp_phase VALUES(?,?,?,?,?)');
  const gates = [
    '团队组建、范围定义、培训完成',
    '设计目标、特殊特性识别、风险评估缓解计划批准',
    'DFMEA、DVP&R、特殊特性确认、图纸规范发布',
    'PFD/PFMEA/试生产 CP 发布、MSA 与能力研究计划就绪',
    'PPAP 客户批准、生产控制计划生效',
    '量产表现达标、经验教训入库',
  ];
  DT_PHASES.forEach((p, i) => insPh.run(proj, p.no, p.name, i <= 3 ? '进行中' : '未开始', gates[i]));
  const insTask = db.prepare('INSERT INTO apqp_task(project_id,phase,name,owner,due,status,deliverable,weight) VALUES(?,?,?,?,?,?,?,?)');
  const done = { 'DFMEA（七步法）': '已完成', 'PFD 工艺流程图': '已完成', '初始特殊特性清单': '已完成', '概念立项与 5T 分析': '已完成' };
  for (const t of APQP_TASKS) {
    insTask.run(proj, t[0], t[1], t[2], '2026-12-31', done[t[1]] || '进行中', t[4], 1);
  }

  // ---- PPAP
  const insP = db.prepare('INSERT INTO ppap_element(project_id,element_no,name,required,status,evidence,note) VALUES(?,?,?,?,?,?,?)');
  PPAP_ELEMENTS.forEach((n, i) => {
    const no = i + 1;
    const ready = { 1: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }.hasOwnProperty(String(no));
    insP.run(proj, no, n, 1, ready ? '已完成' : '未完成', ready ? '已关联系统文件' : '', '');
  });

  // ---- APQP 交付物（按第三版目录）
  const insDoc = db.prepare('INSERT INTO project_doc(doc_code,project_id,status,owner,data_json,updated_at,updated_by,version) VALUES(?,?,?,?,?,?,?,?)');
  const seedDocs = (pid, withSample) => {
    for (const d of DT.CATALOG) {
      const sample = withSample && d.code === 'P1-16'
        ? { goals: DT.SAMPLE['P1-16']?.goals || [] }
        : withSample ? DT.SAMPLE[d.code] : null;
      const status = d.kind === 'module' ? '系统模块' : (sample ? '已完成' : '未开始');
      insDoc.run(d.code, pid, status, d.owner, sample ? JSON.stringify(sample) : '{}',
        sample ? now() : null, sample ? d.owner : null, 'V1.0');
    }
  };
  seedDocs(proj, true);

  // ---- 其它项目（用于项目清单与隔离演示）
  const projects = [
    ['RES-CHIP-2026-02', 'RJ 系列 1/2W 金属膜电阻器 100Ω', '车规客户 B', 2, '2026-03-02', 'RJ-0.5W-100R', 'FM', 'SR-RJ'],
    ['RES-WIRE-2026-01', 'RX 系列 5W 绕线电阻器 22Ω', '工业客户 C', 1, '2026-09-15', 'RX-5W-22R', 'FW', 'SR-RX'],
  ];
  const insProj = db.prepare(`INSERT INTO project(
    project_id,code,name,family_id,series_id,customer,standard,phase,owner,status,start_date,part_no
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insP2 = db.prepare('INSERT INTO ppap_element(project_id,element_no,name,required,status,evidence,note) VALUES(?,?,?,?,?,?,?)');
  projects.forEach((p, idx) => {
    const [pid, name, cust, phase, start, partNo, familyId, seriesId] = p;
    insProj.run(pid, pid, name, familyId, seriesId, cust, 'AIAG-VDA 2019', phase, idx === 0 ? '李工艺' : '周工艺',
      '进行中', start, partNo);
    DT_PHASES.forEach((ph, i) => insPh.run(pid, ph.no, ph.name,
      i < phase ? '已完成' : (i === phase ? '进行中' : '未开始'), gates[i]));
    PPAP_ELEMENTS.forEach((n, i) => insP2.run(pid, i + 1, n, 1, '未完成', '', ''));
    seedDocs(pid, false);
  });

  // ---- 门径评审（项目 1：Gate 0/1 通过，Gate 2 待评审）
  const insGate = db.prepare('INSERT INTO gate_review(project_id,phase,decision,reviewer,comment,reviewed_at,checks_json) VALUES(?,?,?,?,?,?,?)');
  insGate.run(proj, 0, '通过', '质量经理 王', '市场机会与初步可行性确认，预算已批', '2026-02-10 14:20', JSON.stringify([1, 1, 1]));
  insGate.run(proj, 1, '通过', '质量经理 王', '目标可量化、特殊特性已识别、风险计划已批准', '2026-03-18 10:05', JSON.stringify([1, 1, 1, 1]));
  insGate.run(proj, 2, '待评审', '', 'DFMEA 已发布，DVP&R 尚缺 2 项', '2026-09-01 09:00', JSON.stringify([1, 0, 1, 0]));

  // ---- 变更单
  const insEcr = db.prepare('INSERT INTO ecr(ecr_id,project_id,title,reason,scope,status,requested_by,created_at,approved_by,baseline_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insEcr.run('ECR-2026-001', proj, '激光功率规格由 12 W 调整为 10 W', '客户要求降低切槽热影响区，减少基体微裂纹风险',
    'DFMEA 1 项 / PFMEA 3 行 / CP 2 行', '待审批', '工艺-张', '2026-09-12 16:40', '', 'BL-V10');
  insEcr.run('ECR-2026-002', proj, '包封固化温度曲线优化', '缩短固化时间 8 分钟，提升产能', 'CP 1 行 / SOP 1 份',
    '已批准', '工艺-王', '2026-08-20 09:15', '质量经理 王', 'BL-V10');

  // ---- 初始基线
  freezeBaseline(proj, 'PPAP V1.0', 'V1.0', '系统', '初始冻结，用于 PPAP 提交');

  // ---- 审计
  db.exec(`INSERT INTO audit_event(actor,action,object_type,object_id,before_json,after_json,reason,created_at)
    VALUES('张工艺','修改','cp_row','CP-00030','{"freq_value":4}','{"freq_value":2}','客户要求抽检频次由 4h 改为 2h','${now()}')`);
}

/* ------------------------------------------------------------------ 业务算法 */
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

/**
 * 均值-极差法 GR&R（AIAG MSA 第 4 版，10 件 × 3 人 × 3 次）
 * data[o*trials + t][p]  —— 第 o 个评价人第 t 次试验对第 p 个零件的测量值
 */
function computeGRR(data, parts, ops, trials, tolerance) {
  const cell = (o, p) => {
    const v = [];
    for (let t = 0; t < trials; t++) v.push(data[o * trials + t][p]);
    return v;
  };
  // 重复性 EV：同人同件多次测量的极差
  const ranges = [];
  for (let o = 0; o < ops; o++)
    for (let p = 0; p < parts; p++) {
      const v = cell(o, p);
      ranges.push(Math.max(...v) - Math.min(...v));
    }
  const Rbar = mean(ranges);
  // M-01：AIAG K1 倒数（2.481 对应 5 次试验），不能用普通极差系数 2.326
  const d2t = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.481 }[trials] || 1.693;
  const EV = Rbar / d2t;

  // 再现性 AV：评价人均值之间的极差
  const opMeans = [];
  for (let o = 0; o < ops; o++) {
    const pm = [];
    for (let p = 0; p < parts; p++) pm.push(mean(cell(o, p)));
    opMeans.push(mean(pm));
  }
  const R0 = Math.max(...opMeans) - Math.min(...opMeans);
  const d2o = { 2: 1.41, 3: 1.91, 4: 2.24, 5: 2.48 }[ops] || 1.91;
  const AV = Math.sqrt(Math.max(0, (R0 / d2o) ** 2 - (EV ** 2) / (parts * trials)));

  // 零件变差 PV
  const partMeans = [];
  for (let p = 0; p < parts; p++) {
    const v = [];
    for (let o = 0; o < ops; o++) for (let t = 0; t < trials; t++) v.push(data[o * trials + t][p]);
    partMeans.push(mean(v));
  }
  const Rp = Math.max(...partMeans) - Math.min(...partMeans);
  // M-01：PV 使用 AIAG K3 的倒数（1.414/1.912/2.239/2.481/2.672/2.830/2.963/3.078/3.179），
  // 不是普通极差系数 d2，否则 PV 会被系统性放大。
  const d2p = {
    2: 1.414, 3: 1.912, 4: 2.239, 5: 2.481, 6: 2.672,
    7: 2.830, 8: 2.963, 9: 3.078, 10: 3.179,
  }[parts] || 3.179;
  const PV = Rp / d2p;

  const GRR = Math.sqrt(EV ** 2 + AV ** 2);
  const TV = Math.sqrt(GRR ** 2 + PV ** 2);
  const pctGRR = TV > 0 ? (GRR / TV) * 100 : 0;
  const pctEV = TV > 0 ? (EV / TV) * 100 : 0;
  const pctAV = TV > 0 ? (AV / TV) * 100 : 0;
  const pctTol = tolerance > 0 ? (6 * GRR / tolerance) * 100 : 0;
  const ndc = GRR > 0 ? Math.min(99, Math.floor((1.41 * PV) / GRR)) : 0;
  const pctOverall = Math.max(pctGRR, pctTol);
  // M-14：低于 AIAG 建议样本量时给出提示，但不阻断计算
  const warnings = [];
  if (parts < 10) warnings.push(`零件数 ${parts} 低于 AIAG 建议的 10 件，样本代表性不足`);
  if (ops < 2) warnings.push(`评价人数 ${ops} 低于 AIAG 建议的 2 人，再现性无法评估`);
  // M-02：判定收敛为单一函数。ndc<5 表示分辨等级不足，不能作为“有条件接受”放行；
  // GRR=0（无变差）单独判接受，避免被 ndc=0 误伤。
  let judgment;
  let reason;
  if (GRR <= 1e-12) {
    judgment = '接受';
    reason = '测量系统未观测到变差（GRR=0）';
  } else if (ndc < 5) {
    judgment = '不接受';
    reason = `可区分类别数 ndc=${ndc}（<5），不足以用于过程控制`;
  } else if (pctOverall < 10) {
    judgment = '接受';
    reason = `综合变差 ${pctOverall.toFixed(2)}%（<10%）且 ndc=${ndc}`;
  } else if (pctOverall <= 30) {
    judgment = '条件接受';
    reason = `综合变差 ${pctOverall.toFixed(2)}%（10%–30%），需书面条件接受批准`;
  } else {
    judgment = '不接受';
    reason = `综合变差 ${pctOverall.toFixed(2)}%（>30%）`;
  }
  return {
    pctGRR: +pctGRR.toFixed(2), pctEV: +pctEV.toFixed(2), pctAV: +pctAV.toFixed(2),
    pctTol: +pctTol.toFixed(2), pctOverall: +pctOverall.toFixed(2), ndc, judgment, reason, warnings,
    EV: +EV.toFixed(5), AV: +AV.toFixed(5), GRR: +GRR.toFixed(5), PV: +PV.toFixed(5), TV: +TV.toFixed(5),
  };
}

function freezeBaseline(projectId, tag, version, user, note, selectedScopes = null) {
  return tx(() => {
    const id = `BL-${version.replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString(36).slice(-6)}`;
    const project = db.prepare('SELECT * FROM project WHERE project_id=?').get(projectId);
    if (!project) throw new Error('项目不存在');
    const objs = [];
    const add = (type, idValue, row) => objs.push([type, String(idValue), row]);
    const scoped = type => !selectedScopes || !selectedScopes.length || selectedScopes.includes(type);
    const q = (sql, ...a) => db.prepare(sql).all(...a);

    if (scoped('PROJECT')) add('PROJECT', project.project_id, project);
    if (scoped('PRODUCT_FAMILY')) {
      const family = db.prepare('SELECT * FROM product_family WHERE family_id=?').get(project.family_id);
      if (family) add('PRODUCT_FAMILY', family.family_id, family);
    }
    if (scoped('PRODUCT_SERIES')) {
      const series = db.prepare('SELECT * FROM product_series WHERE series_id=? AND family_id=?')
        .get(project.series_id, project.family_id);
      if (series) add('PRODUCT_SERIES', series.series_id, series);
    }
    if (scoped('CHAR')) {
      // 基线只快照本项目实际引用到的特性主数据，避免把全库/全族特性带入证据包
      q(`SELECT DISTINCT c.* FROM char_master c
         WHERE c.char_id IN (SELECT char_id FROM project_char WHERE project_id=? AND char_id IS NOT NULL)`,
      projectId).forEach(row => add('CHAR', row.char_id, row));
    }
    if (scoped('PROJECT_CHAR')) q('SELECT * FROM project_char WHERE project_id=?', projectId)
      .forEach(row => add('PROJECT_CHAR', row.pchar_id, row));
    if (scoped('CHAR_LINK')) {
      q(`SELECT DISTINCT l.* FROM char_link l
         WHERE l.product_char_id IN (SELECT char_id FROM project_char WHERE project_id=? AND char_id IS NOT NULL)
            OR l.process_char_id IN (SELECT char_id FROM project_char WHERE project_id=? AND char_id IS NOT NULL)`,
      projectId, projectId).forEach(row => add('CHAR_LINK', row.link_id, row));
    }
    if (scoped('PROCESS_DICT')) q('SELECT * FROM process_dict').forEach(row => add('PROCESS_DICT', row.dict_id, row));
    if (scoped('AP_MATRIX')) {
      add('AP_MATRIX', 'AP-2019', {
        version: 'AP-2019',
        rows: q('SELECT s,o,d,ap FROM ap_matrix ORDER BY s,o,d'),
      });
    }
    if (scoped('APQP_PHASE')) q('SELECT * FROM apqp_phase WHERE project_id=?', projectId)
      .forEach(row => add('APQP_PHASE', `${row.project_id}:${row.phase}`, row));
    if (scoped('APQP_TASK')) q('SELECT * FROM apqp_task WHERE project_id=?', projectId)
      .forEach(row => add('APQP_TASK', row.task_id, row));
    if (scoped('PROJECT_DOC')) q('SELECT * FROM project_doc WHERE project_id=?', projectId)
      .forEach(row => add('PROJECT_DOC', `${row.project_id}:${row.doc_code}`, row));
    if (scoped('PROJECT_DOC_REVISION')) q(
      'SELECT * FROM project_doc_revision WHERE project_id=?', projectId
    ).forEach(row => add('PROJECT_DOC_REVISION', row.rev_id, row));
    if (scoped('GATE_REVIEW')) q('SELECT * FROM gate_review WHERE project_id=?', projectId)
      .forEach(row => add('GATE_REVIEW', `${row.project_id}:${row.phase}`, row));
    if (scoped('ECR')) q('SELECT * FROM ecr WHERE project_id=?', projectId)
      .forEach(row => add('ECR', row.ecr_id, row));
    if (scoped('APPROVAL')) q('SELECT * FROM activity_approval WHERE project_id=?', projectId)
      .forEach(row => add('APPROVAL', row.approval_id, row));
    if (scoped('CHANGE_REQUEST')) q('SELECT * FROM change_request WHERE project_id=?', projectId)
      .forEach(row => add('CHANGE_REQUEST', row.cr_id, row));
    if (scoped('CHANGE_ITEM')) q(
      `SELECT i.* FROM change_item i JOIN change_request r ON r.cr_id=i.cr_id WHERE r.project_id=?`,
      projectId
    ).forEach(row => add('CHANGE_ITEM', row.ci_id, row));

    const headers = q('SELECT * FROM fmea_header WHERE project_id=?', projectId);
    if (scoped('FMEA_HEADER')) headers.forEach(row => add('FMEA_HEADER', row.fmea_id, row));
    for (const header of headers) {
      if (scoped('FMEA_NODE')) q('SELECT * FROM fmea_node WHERE fmea_id=?', header.fmea_id)
        .forEach(row => add('FMEA_NODE', row.node_id, row));
      if (scoped('FMEA_FUNCTION')) q(
        `SELECT f.* FROM fmea_function f JOIN fmea_node n ON n.node_id=f.node_id WHERE n.fmea_id=?`,
        header.fmea_id
      ).forEach(row => add('FMEA_FUNCTION', row.func_id, row));
      if (scoped('FMEA_ROW')) q('SELECT * FROM fmea_row WHERE fmea_id=?', header.fmea_id)
        .forEach(row => add('FMEA_ROW', row.row_id, row));
      if (scoped('FMEA_ACTION')) q(
        `SELECT a.* FROM fmea_action a JOIN fmea_row r ON r.row_id=a.row_id WHERE r.fmea_id=?`,
        header.fmea_id
      ).forEach(row => add('FMEA_ACTION', row.action_id, row));
      if (scoped('FMEA_DECISION')) q(
        `SELECT d.* FROM fmea_decision d JOIN fmea_row r ON r.row_id=d.row_id WHERE r.fmea_id=?`,
        header.fmea_id
      ).forEach(row => add('FMEA_DECISION', row.row_id, row));
      if (scoped('FMEA_CANDIDATE')) q(
        `SELECT c.* FROM fmea_failure_cand c JOIN fmea_node n ON n.node_id=c.node_id WHERE n.fmea_id=?`,
        header.fmea_id
      ).forEach(row => add('FMEA_CANDIDATE', row.cand_id, row));
      if (scoped('FMEA_IMAGE')) q('SELECT * FROM fmea_image WHERE fmea_id=?', header.fmea_id)
        .forEach(row => add('FMEA_IMAGE', row.fmea_id, row));
    }
    if (scoped('STEP')) q('SELECT * FROM process_step WHERE project_id=?', projectId)
      .forEach(row => add('STEP', row.step_id, row));

    const plans = q('SELECT * FROM control_plan WHERE project_id=?', projectId);
    if (scoped('CONTROL_PLAN')) plans.forEach(row => add('CONTROL_PLAN', row.cp_id, row));
    const cpRows = q(
      `SELECT c.* FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id WHERE p.project_id=?`,
      projectId
    );
    if (scoped('CP_ROW')) cpRows.forEach(row => add('CP_ROW', row.cp_row_id, row));
    const monitorRows = q(
      `SELECT m.* FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
       JOIN control_plan p ON p.cp_id=c.cp_id WHERE p.project_id=?`,
      projectId
    );
    if (scoped('MONITORING_ITEM')) monitorRows.forEach(row => add('MONITORING_ITEM', row.mon_id, row));
    if (scoped('SPC_DATASET')) {
      for (const monitor of monitorRows) {
        q('SELECT * FROM spc_dataset WHERE mon_id=?', monitor.mon_id)
          .forEach(row => add('SPC_DATASET', row.dataset_id, row));
      }
    }
    if (scoped('GAUGE')) {
      // 与 projectGauges 同口径：只快照本项目控制计划引用到的检具
      q(`SELECT DISTINCT g.* FROM gauge g WHERE EXISTS(
        SELECT 1 FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
        WHERE p.project_id=? AND c.gauge_id=g.gauge_id
      )`, projectId).forEach(row => add('GAUGE', row.gauge_id, row));
    }
    if (scoped('MSA_STUDY')) q('SELECT * FROM msa_study WHERE project_id=?', projectId)
      .forEach(row => add('MSA_STUDY', row.study_id, row));
    if (scoped('MSA_PLAN')) q('SELECT * FROM msa_plan_item WHERE project_id=?', projectId)
      .forEach(row => add('MSA_PLAN', row.plan_id, row));
    if (scoped('PPAP_ELEMENT')) q('SELECT * FROM ppap_element WHERE project_id=?', projectId)
      .forEach(row => add('PPAP_ELEMENT', `${row.project_id}:${row.element_no}`, row));
    if (scoped('PPAP_PACKAGE')) q('SELECT * FROM ppap_package WHERE project_id=?', projectId)
      .forEach(row => add('PPAP_PACKAGE', row.pkg_id, row));
    if (scoped('DOC_TEMPLATE')) q(
      'SELECT * FROM doc_template WHERE project_id=? OR project_id IS NULL', projectId
    ).forEach(row => add('DOC_TEMPLATE', row.tpl_id, row));
    for (const [table, type, idField] of [
      ['deliverable_sync_item', 'DELIVERABLE_LINK', 'sync_id'],
      ['deliverable_sync_snapshot', 'DELIVERABLE_SOURCE', 'object_id'],
    ]) {
      if (!scoped(type) || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      q(`SELECT * FROM ${table} WHERE project_id=?`, projectId).forEach(row =>
        add(type, type === 'DELIVERABLE_SOURCE' ? `${row.source_code}:${row[idField]}:${row.version}` : row[idField], row));
    }

    const ins = db.prepare(`INSERT INTO baseline_item(
      baseline_id,object_type,object_id,object_hash,snapshot
    ) VALUES(?,?,?,?,?)`);
    const hashes = [];
    for (const [type, objectId, row] of objs) {
      const json = JSON.stringify(row);
      const h = crypto.createHash('sha256').update(json).digest('hex');
      ins.run(id, type, objectId, h, json);
      hashes.push(h);
    }
    const bh = crypto.createHash('sha256').update(hashes.sort().join('')).digest('hex');
    db.prepare(`INSERT INTO baseline(
      baseline_id,project_id,tag,version,hash,frozen_at,frozen_by,note,scope_json,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, projectId, tag, version, bh, now(), user, note,
      JSON.stringify(selectedScopes || []), '冻结'
    );
    return { id, hash: bh, count: objs.length };
  });
}

function ensureProjectChars(projectId, charIds = null) {
  const project = db.prepare('SELECT * FROM project WHERE project_id=?').get(projectId);
  if (!project) return [];
  const existing = db.prepare('SELECT * FROM project_char WHERE project_id=? ORDER BY char_kind DESC,char_id')
    .all(projectId);
  if (!Array.isArray(charIds)) return existing;
  const requested = [...new Set(charIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!requested.length) return existing;
  const projectKey = String(projectId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const chars = db.prepare(`SELECT * FROM char_master
    WHERE COALESCE(status,'生效')<>'作废'
      AND (family_id=? OR family_id IS NULL)
      AND (series_id IS NULL OR series_id=?)
      AND char_id IN (${requested.map(() => '?').join(',')})
    ORDER BY char_id`).all(project.family_id, project.series_id || '', ...requested);
  const ins = db.prepare(`INSERT OR IGNORE INTO project_char(
    pchar_id,project_id,char_id,name,description,char_kind,domain,unit,target,lsl,usl,tol_text,
    is_special,special_symbol,source_type,source_ref,status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const char of chars) {
    const pcharId = `PC-${projectKey}-${String(char.char_id).replace(/[^A-Z0-9]/gi, '')}`;
    ins.run(
      pcharId, projectId, char.char_id, char.name, char.description || '', char.char_kind, char.domain || '',
      char.unit || '', char.target, char.lsl, char.usl, char.tol_text || '',
      char.is_special ? 1 : 0, char.special_symbol || '', char.source_type || '',
      char.source_ref || '', '生效', now(), now()
    );
  }
  db.prepare(`UPDATE cp_row SET project_char_id=(
      SELECT pc.pchar_id FROM project_char pc JOIN control_plan cp ON cp.project_id=pc.project_id
      WHERE cp.cp_id=cp_row.cp_id AND pc.char_id=cp_row.char_id AND pc.project_id=?
      LIMIT 1)
    WHERE project_char_id IS NULL AND cp_id IN (SELECT cp_id FROM control_plan WHERE project_id=?)`
  ).run(projectId, projectId);
  db.prepare(`UPDATE monitoring_item SET
      project_char_id=COALESCE(project_char_id,(SELECT project_char_id FROM cp_row WHERE cp_row_id=monitoring_item.cp_row_id)),
      char_id=COALESCE(char_id,(SELECT char_id FROM cp_row WHERE cp_row_id=monitoring_item.cp_row_id))`
  ).run();
  return db.prepare('SELECT * FROM project_char WHERE project_id=? ORDER BY char_kind DESC,char_id')
    .all(projectId);
}

function ensureProjectChar(projectId, charId) {
  const project = db.prepare('SELECT * FROM project WHERE project_id=?').get(projectId);
  if (!project) throw new Error('项目不存在');
  const char = db.prepare(`SELECT * FROM char_master
    WHERE char_id=? AND COALESCE(status,'生效')<>'作废'`).get(charId);
  if (!char) throw new Error('特性字典中不存在该有效特性');
  if (char.family_id && project.family_id && char.family_id !== project.family_id) {
    throw new Error('该特性不属于当前项目产品族');
  }
  if (char.series_id && char.series_id !== project.series_id) {
    throw new Error('该特性仅适用于其他产品系列');
  }
  const exists = db.prepare('SELECT * FROM project_char WHERE project_id=? AND char_id=?')
    .get(projectId, charId);
  if (exists) return exists;
  const projectKey = String(projectId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pcharId = `PC-${projectKey}-${String(char.char_id).replace(/[^A-Z0-9]/gi, '')}`;
  db.prepare(`INSERT INTO project_char(
    pchar_id,project_id,char_id,name,description,char_kind,domain,unit,target,lsl,usl,tol_text,
    is_special,special_symbol,source_type,source_ref,status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    pcharId, projectId, char.char_id, char.name, char.description || '', char.char_kind, char.domain || '',
    char.unit || '', char.target, char.lsl, char.usl, char.tol_text || '',
    char.is_special ? 1 : 0, char.special_symbol || '', char.source_type || '',
    char.source_ref || '', '生效', now(), now()
  );
  return db.prepare('SELECT * FROM project_char WHERE pchar_id=?').get(pcharId);
}

function listMsaPlans(projectId) {
  return db.prepare(`SELECT p.*,COALESCE(p.char_name_snapshot,pc.name) char_name,
      COALESCE(p.char_unit_snapshot,pc.unit) char_unit,
      COALESCE(p.char_target_snapshot,pc.target) char_target,
      COALESCE(p.char_lsl_snapshot,pc.lsl) char_lsl,COALESCE(p.char_usl_snapshot,pc.usl) char_usl,
      COALESCE(p.gauge_name_snapshot,g.name) gauge_name,
      COALESCE(p.gauge_code_snapshot,g.code,p.gauge_id) gauge_code,
      g.resolution,s.step_no,s.name step_name,
      cp.stage cp_stage,cp.status cp_status,
      ms.result_pct study_result,ms.judgment study_judgment,ms.status study_status
    FROM msa_plan_item p
    LEFT JOIN project_char pc ON pc.pchar_id=p.project_char_id
    LEFT JOIN gauge g ON g.gauge_id=p.gauge_id
    LEFT JOIN cp_row c ON c.cp_row_id=p.cp_row_id
    LEFT JOIN process_step s ON s.step_id=c.step_id AND s.project_id=p.project_id
    LEFT JOIN control_plan cp ON cp.cp_id=c.cp_id AND cp.project_id=p.project_id
    LEFT JOIN msa_study ms ON ms.study_id=p.study_id AND ms.project_id=p.project_id
      AND ms.project_char_id=p.project_char_id AND ms.gauge_id=p.gauge_id
    WHERE p.project_id=?
    ORDER BY CASE p.status WHEN '计划' THEN 1 WHEN '研究中' THEN 2 WHEN '已完成' THEN 3 ELSE 4 END,
      p.planned_date,p.plan_id`).all(projectId);
}

function latestMsaStudy(projectId, projectCharId, gaugeId, measureTech) {
  if (!projectId || !projectCharId || !gaugeId) return null;
  return db.prepare(`SELECT ms.* FROM msa_study ms
    LEFT JOIN msa_plan_item p ON p.plan_id=ms.plan_id AND p.project_id=ms.project_id
    WHERE ms.project_id=? AND ms.project_char_id=? AND ms.gauge_id=?
      AND (? IS NULL OR p.measure_tech=?)
    ORDER BY ms.studied_at DESC,ms.study_id DESC LIMIT 1`).get(
    projectId, projectCharId, gaugeId, measureTech == null ? null : String(measureTech).trim(),
    measureTech == null ? null : String(measureTech).trim()
  ) || null;
}

function ensureMsaPlans(projectId) {
  const project = db.prepare('SELECT * FROM project WHERE project_id=?').get(projectId);
  if (!project) return [];
  const sources = db.prepare(`SELECT c.cp_row_id,c.char_id,c.project_char_id,c.gauge_id,c.measure_tech,c.spec_text,
      g.code gauge_code,g.name gauge_name,cp.cp_id,cp.rev,cp.stage,
      pc.name,pc.unit,pc.target,pc.lsl,pc.usl,pc.tol_text,
      (SELECT m.mon_id FROM monitoring_item m
        WHERE m.cp_row_id=c.cp_row_id AND m.project_char_id=c.project_char_id
          AND m.gauge_id=c.gauge_id AND m.status='启用' AND m.approval_status='已批准'
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) mon_id
    FROM cp_row c JOIN control_plan cp ON cp.cp_id=c.cp_id
    JOIN project_char pc ON pc.pchar_id=c.project_char_id AND pc.project_id=cp.project_id
    JOIN gauge g ON g.gauge_id=c.gauge_id
    WHERE cp.project_id=? AND cp.status IN ('已批准','已冻结') AND COALESCE(c.status,'启用')='启用'
      AND COALESCE(pc.status,'生效')<>'作废' AND COALESCE(g.status,'')<>'报废'
    ORDER BY cp.cp_id,c.seq,c.cp_row_id`).all(projectId);
  const planRevision = db.prepare(`SELECT version,data_json,cols_json FROM project_doc_revision
    WHERE project_id=? AND doc_code='P3-08' AND status='已批准' AND TRIM(COALESCE(approved_by,''))<>''
    ORDER BY COALESCE(approved_at,changed_at) DESC,rowid DESC LIMIT 1`).get(projectId);
  const planData = planRevision ? JSON.parse(planRevision.data_json || '{}') : {};
  const planColumns = planRevision ? JSON.parse(planRevision.cols_json || '{}').plan || [] : [];
  const planRows = Array.isArray(planData.plan) ? planData.plan : [];
  const planRowIds = planData._syncRows?.plan || [];
  const gauges = db.prepare('SELECT gauge_id,code,name,status FROM gauge').all();
  const projectChars = db.prepare(`SELECT pchar_id,char_id,name,unit,target,lsl,usl,tol_text
    FROM project_char WHERE project_id=? AND COALESCE(status,'生效')<>'作废'`).all(projectId);
  const gaugeByCode = new Map(gauges.flatMap(gauge => [
    [String(gauge.gauge_id || '').trim(), gauge],
    [String(gauge.code || '').trim(), gauge],
  ]).filter(([key]) => key));
  const gaugeByName = new Map(gauges.map(gauge => [String(gauge.name || '').trim(), gauge]));
  const charById = new Map(projectChars.flatMap(char => [
    [String(char.pchar_id || '').trim(), char],
    [String(char.char_id || '').trim(), char],
  ]).filter(([key]) => key));
  const charByName = new Map(projectChars.map(char => [String(char.name || '').trim(), char]));
  const columnIndex = (...patterns) => planColumns.findIndex(label =>
    patterns.some(pattern => pattern.test(String(label || ''))));
  const charIndex = columnIndex(/^特性$/, /项目特性/);
  const gaugeCodeIndex = columnIndex(/检具编号/, /量具编号/, /设备编号/);
  const gaugeNameIndex = columnIndex(/检具名称/, /量具名称/, /测量设备/, /设备名称/);
  const studyTypeIndex = columnIndex(/研究类型/);
  const designIndex = columnIndex(/零件数.*人数.*次数/);
  const plannedIndex = columnIndex(/计划日期/);
  const ownerIndex = columnIndex(/责任人/);
  const statusIndex = columnIndex(/^状态$/);
  const value = (row, index) => index >= 0 ? String(row?.[index] || '').trim() : '';
  const plannedDefault = new Date(Date.now() + 8 * 3600e3 + 14 * 86400e3).toISOString().slice(0, 10);
  const documentSources = [];
  const documentSourceKeys = new Set();
  for (const [index, row] of planRows.entries()) {
    if (!Array.isArray(row) || !row.some(cell => String(cell || '').trim())) continue;
    const gaugeCode = value(row, gaugeCodeIndex);
    const gaugeName = value(row, gaugeNameIndex);
    const gauge = gaugeByCode.get(gaugeCode) || gaugeByName.get(gaugeName) || null;
    const charText = value(row, charIndex);
    const char = charById.get(charText) || charByName.get(charText) || null;
    const studyText = value(row, studyTypeIndex);
    const studyType = /属性|计数|目视|合格.*不合格|attribute|go\s*\/?\s*no/i.test(studyText)
      ? 'ATTRIBUTE' : 'GRR';
    const dimensions = value(row, designIndex).match(/(\d+)\s*[×xX*]\s*(\d+)\s*[×xX*]\s*(\d+)/);
    const rowId = planRowIds[index] || hash(JSON.stringify(row));
    const sourceVersion = `P3-08 ${planRevision.version}`.trim();
    const sourceKey = hash(JSON.stringify([
      projectId, 'P3-08', rowId, sourceVersion, gauge?.gauge_id || '', gaugeCode, gaugeName,
      char?.pchar_id || '', charText, studyText, designIndex >= 0 ? value(row, designIndex) : '',
      plannedIndex >= 0 ? value(row, plannedIndex) : '', ownerIndex >= 0 ? value(row, ownerIndex) : '',
      char?.target ?? null, char?.lsl ?? null, char?.usl ?? null, char?.tol_text || '',
    ]));
    documentSourceKeys.add(sourceKey);
    documentSources.push({
      planId: `MSP-${sourceKey.slice(0, 32)}`, projectChar: char, charText,
      gauge, gaugeCode, gaugeName, studyType,
      parts: +(dimensions?.[1] || 10), operators: +(dimensions?.[2] || 3), trials: +(dimensions?.[3] || 3),
      plannedDate: value(row, plannedIndex) || plannedDefault,
      owner: value(row, ownerIndex) || project.owner || '质量工程师',
      status: ['计划', '研究中', '已完成'].includes(value(row, statusIndex))
        ? value(row, statusIndex) : '计划',
      sourceVersion, sourceKey,
      note: [
        '由已批准 MSA 计划 P3-08 生成',
        // M-12：表头变更导致解析失败时不能静默套用 10×3×3
        designIndex < 0 ? 'P3-08 表头缺少“零件数×人数×次数”列，研究设计默认 10×3×3，请人工确认'
          : !dimensions ? '研究设计无法解析（如“10×3×3”），默认 10×3×3，请人工确认' : '',
        !char && charText ? `项目特性待关联：${charText}` : '',
        !gauge && (gaugeCode || gaugeName) ? `检具待关联：${[gaugeCode, gaugeName].filter(Boolean).join(' ')}` : '',
      ].filter(Boolean).join('；'),
    });
  }
  const insert = db.prepare(`INSERT INTO msa_plan_item(
    plan_id,project_id,project_char_id,char_id,gauge_id,gauge_code_snapshot,gauge_name_snapshot,study_type,parts,operators,trials,
    planned_date,owner,status,trigger_source,cp_row_id,monitor_id,note,created_at,updated_at,
    source_key,source_version,measure_tech,spec_text,char_name_snapshot,char_unit_snapshot,
    char_target_snapshot,char_lsl_snapshot,char_usl_snapshot,char_tol_text_snapshot,tolerance
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const select = db.prepare('SELECT plan_id FROM msa_plan_item WHERE project_id=? AND source_key=?');
  const legacy = db.prepare(`SELECT * FROM msa_plan_item
    WHERE project_id=? AND cp_row_id=? AND project_char_id=? AND gauge_id=?
      AND COALESCE(study_type,'GRR')=? AND source_key IS NULL
    ORDER BY created_at,plan_id LIMIT 1`);
  const adoptLegacy = db.prepare(`UPDATE msa_plan_item SET source_key=?,source_version=?,measure_tech=?,
    spec_text=?,char_name_snapshot=?,char_unit_snapshot=?,char_target_snapshot=?,char_lsl_snapshot=?,
    char_usl_snapshot=?,char_tol_text_snapshot=?,tolerance=? WHERE plan_id=? AND status<>'已完成'`);
  const adoptCompletedLegacy = db.prepare(`UPDATE msa_plan_item SET source_key=?,source_version=?,measure_tech=?
    WHERE plan_id=? AND source_key IS NULL`);
  const updateSourceStatus = db.prepare(`UPDATE msa_plan_item SET source_active=?,source_status=?
    WHERE plan_id=? AND (COALESCE(source_active,1)<>? OR COALESCE(source_status,'')<>?)`);
  const currentKeys = new Map();
  tx(() => {
    for (const source of sources) {
      const method = String(source.measure_tech || '').trim();
      const studyType = /目视|通止|计数|定性|合格[ /、和与]*不合格|attribute|go\s*\/?\s*no\s*go|visual/i.test(method)
        ? 'ATTRIBUTE' : 'GRR';
      const sourceVersion = `${source.cp_id} ${source.rev || ''}`.trim();
      const tolerance = source.lsl != null && source.usl != null
        ? +Math.abs(source.usl - source.lsl).toFixed(10) : null;
      const snapshot = [
        sourceVersion, method, source.spec_text || '', source.name || '', source.unit || '',
        source.target, source.lsl, source.usl, source.tol_text || '', tolerance,
      ];
      const sourceKey = hash(JSON.stringify([
        projectId, source.cp_row_id, source.project_char_id, source.gauge_id, studyType, ...snapshot,
      ]));
      currentKeys.set(source.cp_row_id, sourceKey);
      if (select.get(projectId, sourceKey)) continue;
      const old = legacy.get(projectId, source.cp_row_id, source.project_char_id, source.gauge_id, studyType);
      if (old) {
        if (old.status === '已完成') {
          // Legacy completed plans lack a specification snapshot; keep their evidence unchanged.
          adoptCompletedLegacy.run(sourceKey, sourceVersion, method, old.plan_id);
        } else {
          adoptLegacy.run(sourceKey, ...snapshot, old.plan_id);
        }
        continue;
      }
      insert.run(
        `MSP-${sourceKey.slice(0, 32)}`, projectId, source.project_char_id, source.char_id,
        source.gauge_id, source.gauge_code || '', source.gauge_name || '',
        studyType, 10, 3, 3, plannedDefault, project.owner || '质量工程师', '计划',
        source.mon_id ? 'SPC监控' : 'CP', source.cp_row_id, source.mon_id || null,
        '由已批准控制计划测量行自动生成', now(), now(), sourceKey, ...snapshot
      );
    }
    for (const source of documentSources) {
      if (select.get(projectId, source.sourceKey)) continue;
      const char = source.projectChar;
      const tolerance = char?.lsl != null && char?.usl != null
        ? +Math.abs(char.usl - char.lsl).toFixed(10) : null;
      const charName = char?.name || source.charText || '';
      insert.run(
        source.planId, projectId, char?.pchar_id || null, char?.char_id || null,
        source.gauge?.gauge_id || null, source.gaugeCode || source.gauge?.code || '',
        source.gaugeName || source.gauge?.name || '', source.studyType,
        source.parts, source.operators, source.trials, source.plannedDate, source.owner, source.status,
        'P3-08', null, null, source.note, now(), now(), source.sourceKey, source.sourceVersion,
        '', '', charName, char?.unit || '', char?.target ?? null, char?.lsl ?? null, char?.usl ?? null,
        char?.tol_text || '', tolerance,
      );
    }
    const plans = db.prepare(`SELECT p.plan_id,p.cp_row_id,p.source_key,p.source_active,p.trigger_source,
        c.cp_row_id live_cp_row_id,c.status cp_row_status,cp.status cp_status
      FROM msa_plan_item p LEFT JOIN cp_row c ON c.cp_row_id=p.cp_row_id
      LEFT JOIN control_plan cp ON cp.cp_id=c.cp_id AND cp.project_id=p.project_id
      WHERE p.project_id=?`).all(projectId);
    for (const plan of plans) {
      if (plan.trigger_source === 'P3-08' || documentSourceKeys.has(plan.source_key)) {
        const active = documentSourceKeys.has(plan.source_key) ? 1 : 0;
        const sourceStatus = active ? '有效' : '来源已失效';
        updateSourceStatus.run(active, sourceStatus, plan.plan_id, active, sourceStatus);
        continue;
      }
      const currentKey = currentKeys.get(plan.cp_row_id);
      const missing = !plan.live_cp_row_id || plan.cp_row_status === '停用';
      const active = missing ? 0 : currentKey ? +(currentKey === plan.source_key) : +(plan.source_active !== 0);
      const sourceStatus = missing ? '来源已失效' : !active ? '已替代'
        : currentKey && ['已批准', '已冻结'].includes(plan.cp_status) ? '有效' : '待复核';
      updateSourceStatus.run(active, sourceStatus, plan.plan_id, active, sourceStatus);
    }
  });
  return listMsaPlans(projectId);
}

function migrateProjectDefaults() {
  const insertFamily = db.prepare(`INSERT OR IGNORE INTO product_family(
    family_id,code,name,category,status
  ) VALUES(?,?,?,?, '生效')`);
  for (const [familyId, code, name, category] of PRODUCT_FAMILIES) {
    insertFamily.run(familyId, code, name, category);
  }
  db.prepare(`UPDATE product_family SET category='通用类产品'
    WHERE (family_id='FM' AND category='RES-FILM')
      OR (family_id='FW' AND category='RES-WIRE')`).run();

  const findSeries = db.prepare('SELECT series_id FROM product_series WHERE family_id=? AND code=?');
  const insertSeries = db.prepare(`INSERT OR IGNORE INTO product_series(
    series_id,family_id,code,name,status
  ) VALUES(?,?,?,?, '生效')`);
  for (const [familyId, code, name] of PRODUCT_SERIES) {
    if (findSeries.get(familyId, code)) continue;
    const idPart = value => value.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    insertSeries.run(`SR-MAN-${idPart(familyId)}-${idPart(code)}`, familyId, code, name);
  }

  const projects = db.prepare('SELECT * FROM project').all();
  for (const project of projects) {
    const used = db.prepare(`SELECT char_id, process_char_id FROM fmea_row r
      JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE h.project_id=?`)
      .all(project.project_id)
      .flatMap(row => [row.char_id, row.process_char_id])
      .filter(Boolean);
    ensureProjectChars(project.project_id, used);
    ensureMsaPlans(project.project_id);
  }
  const dictIns = db.prepare(`INSERT OR IGNORE INTO process_dict(
    dict_id,code,name,step_type,default_equipment,effective_from,effective_to,status
  ) VALUES(?,?,?,?,?,?,?,?)`);
  const legacySteps = db.prepare(`SELECT step_no,name,step_type,MAX(equipment) equipment
    FROM process_step GROUP BY step_no,name,step_type ORDER BY MIN(seq)`).all();
  for (const step of legacySteps) {
    dictIns.run(`PD-MIG-${String(step.step_no).replace(/[^A-Za-z0-9]/g, '')}-${encodeURIComponent(step.name).slice(0, 12)}`,
      step.step_no, step.name, step.step_type, step.equipment || '', '2026-01-01', null, '生效');
  }
  const insPpap = db.prepare(`INSERT OR IGNORE INTO ppap_element(
    project_id,element_no,name,required,status,evidence,note
  ) VALUES(?,?,?,?,?,?,?)`);
  const insTask = db.prepare(`INSERT INTO apqp_task(
    project_id,phase,name,owner,due,status,deliverable,weight
  ) SELECT ?,?,?,?,?,?,?,?
    WHERE NOT EXISTS (
      SELECT 1 FROM apqp_task WHERE project_id=? AND phase=? AND name=?
    )`);
  for (const project of projects) {
    PPAP_ELEMENTS.forEach((name, index) => {
      insPpap.run(project.project_id, index + 1, name, 1, '未完成', '', '');
    });
    for (const task of APQP_TASKS) {
      insTask.run(project.project_id, task[0], task[1], task[2], '2026-12-31',
        '未开始', task[4], 1, project.project_id, task[0], task[1]);
    }
  }

  const stages = ['PROTO', 'PILOT', 'SOP'];
  for (const project of projects) {
    const projectKey = String(project.project_id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const existing = db.prepare(
      'SELECT * FROM control_plan WHERE project_id=? ORDER BY stage'
    ).all(project.project_id);
    if (!existing.length) {
      for (const stage of stages) {
        db.prepare(`INSERT INTO control_plan(
          cp_id,project_id,stage,rev,part_no,part_name,customer,plant,prepared_by,approved_by,status,effective_date
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          `CP-${projectKey}-${stage}`, project.project_id, stage,
          'r1', project.part_no || '', project.name, project.customer || '',
          '', project.owner || '', '', '草稿', ''
        );
      }
      continue;
    }
    const anchor = existing[0];
    const anchorRows = db.prepare(
      'SELECT * FROM cp_row WHERE cp_id=? ORDER BY seq'
    ).all(anchor.cp_id);
    for (const stage of stages) {
      if (existing.some(cp => cp.stage === stage)) continue;
      const cpId = `CP-${projectKey}-${stage}`;
      db.prepare(`INSERT INTO control_plan(
        cp_id,project_id,stage,rev,part_no,part_name,customer,plant,prepared_by,approved_by,status,effective_date
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        cpId, project.project_id, stage, 'r1', anchor.part_no || project.part_no || '',
        anchor.part_name || project.name, anchor.customer || project.customer || '',
        anchor.plant || '', anchor.prepared_by || project.owner || '',
        '', '草稿', '');
      const insCpRow = db.prepare(`INSERT INTO cp_row(
        cp_row_id,cp_id,seq,step_id,char_id,fmea_row_id,spec_text,measure_tech,gauge_id,
        sample_size,freq_value,freq_unit,freq_trigger,control_method,reaction_plan,
        is_spc,override_flag,override_reason,upstream_ver
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      anchorRows.forEach((row, index) => {
        insCpRow.run(
          `${cpId}-${String(index + 1).padStart(3, '0')}`, cpId, row.seq,
          row.step_id, row.char_id, row.fmea_row_id, row.spec_text, row.measure_tech,
          row.gauge_id, row.sample_size, row.freq_value, row.freq_unit, row.freq_trigger,
          row.control_method, row.reaction_plan, 0, 0, '阶段复制', row.upstream_ver
        );
      });
    }
  }

  for (const project of projects) {
    const projectKey = String(project.project_id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const type of ['DFMEA', 'PFMEA']) {
      const exists = db.prepare('SELECT 1 FROM fmea_header WHERE project_id=? AND fmea_type=?')
        .get(project.project_id, type);
      if (!exists) {
        const headerId = `${type === 'DFMEA' ? 'DF' : 'PF'}-${projectKey}`;
        db.prepare(`INSERT INTO fmea_header(
          fmea_id,project_id,fmea_type,title,ap_ver,status,rev,meta_json
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          headerId, project.project_id, type,
          `${project.name} ${type === 'DFMEA' ? '设计FMEA' : '过程FMEA'}`,
          'AP-2019', '草稿', 'r1', '{}'
        );
      }
    }
    const headers = db.prepare('SELECT * FROM fmea_header WHERE project_id=?').all(project.project_id);
    for (const header of headers) {
      const hasRoot = db.prepare(
        "SELECT 1 FROM fmea_node WHERE fmea_id=? AND node_type='STRUCTURE' AND parent_id IS NULL"
      ).get(header.fmea_id);
      if (hasRoot) continue;
      const id = `N-${header.fmea_id}-ROOT`;
      db.prepare(`INSERT INTO fmea_node(
        node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc,level
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        id, header.fmea_id, null, 'STRUCTURE', null, 1,
        header.fmea_type === 'DFMEA' ? `${project.name} 产品总成` : `${project.name} 过程总成`,
        null, '系统迁移初始化根节点', 1
      );
    }
  }
}

function init() {
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  ensureColumn('auth_user', 'must_change_password', 'INTEGER DEFAULT 0');
  // 人员权限：部门 / 岗位 / 副总分管板块 / 账号标记（如 facility）
  ensureColumn('auth_user', 'department');
  ensureColumn('auth_user', 'position');
  ensureColumn('auth_user', 'vp_scope');
  ensureColumn('auth_user', 'flags');
  seedAuthUsers();
  ensureColumn('product_family', 'status', "TEXT DEFAULT '生效'");
  ensureColumn('project', 'series_id');
  ensureColumn('char_master', 'series_id');
  ensureColumn('char_master', 'description');
  ensureColumn('project_char', 'description');
  ensureColumn('char_link', 'created_by');
  ensureColumn('char_link', 'created_at');
  ensureColumn('char_link', 'status', "TEXT DEFAULT '生效'");
  ensureColumn('process_step', 'dict_id');
  ensureColumn('process_step', 'published_at');
  ensureColumn('process_step', 'published_by');
  ensureColumn('process_step', 'change_summary');
  ensureColumn('process_step', 'parent_step_id');
  ensureColumn('process_step', 'pfd_mode', "TEXT DEFAULT 'PROCESS'");
  // P-06：PROCESS 工序记录它派生自哪一条 INITIAL（P1-10）工序，来源可追溯
  ensureColumn('process_step', 'origin_step_id');
  db.exec('CREATE INDEX IF NOT EXISTS idx_process_step_origin ON process_step(origin_step_id)');
  db.exec("UPDATE process_step SET pfd_mode='PROCESS' WHERE pfd_mode IS NULL OR TRIM(pfd_mode)=''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_process_step_mode ON process_step(project_id,pfd_mode,seq)');
  ensureColumn('fmea_header', 'meta_json');
  ensureColumn('fmea_header', 'published_at');
  ensureColumn('fmea_header', 'published_by');
  ensureColumn('fmea_header', 'approved_by');
  ensureColumn('fmea_node', 'desc');
  ensureColumn('fmea_node', 'level', 'INTEGER');
  ensureColumn('fmea_node', 'status', "TEXT DEFAULT '生效'");
  ensureColumn('fmea_row', 's_plant', 'INTEGER');
  ensureColumn('fmea_row', 's_ship', 'INTEGER');
  ensureColumn('fmea_row', 's_user', 'INTEGER');
  ensureColumn('fmea_row', 'filter_code');
  ensureColumn('fmea_row', 'func_id');
  ensureColumn('fmea_row', 'upstream_row_id');
  ensureColumn('fmea_row', 'process_char_id');
  ensureColumn('fmea_action', 'created_at');
  ensureColumn('fmea_decision', 'approved_at');
  // 记录决定的提交人，用于禁止“自己提交、自己批准”
  ensureColumn('fmea_decision', 'submitted_by');
  // F-05：决定必须记录“基于哪一版 S/O/D/AP”，行变更后旧决定不再代表当前风险
  ensureColumn('fmea_decision', 's', 'INTEGER');
  ensureColumn('fmea_decision', 'o', 'INTEGER');
  ensureColumn('fmea_decision', 'd', 'INTEGER');
  ensureColumn('fmea_decision', 'ap');
  ensureColumn('fmea_decision', 'decided_at');
  ensureColumn('monitoring_item', 'approval_status', "TEXT DEFAULT '待审核'");
  ensureColumn('monitoring_item', 'approved_by');
  ensureColumn('monitoring_item', 'approved_at');
  ensureColumn('monitoring_item', 'review_note');
  ensureColumn('monitoring_item', 'created_by');
  ensureColumn('monitoring_item', 'created_at');
  // PPAP 提交所绑定的基线（打包/清单必须与它同源）
  ensureColumn('ppap_submission', 'baseline_id');
  // B-13：PPAP 要素适用性/顾客豁免；B-09：证据先“待确认”再完成
  ensureColumn('ppap_element', 'applicability', "TEXT DEFAULT '适用'");
  ensureColumn('ppap_element', 'waiver_ref');
  ensureColumn('ppap_element', 'confirmed_by');
  ensureColumn('ppap_element', 'confirmed_at');
  // B-02：项目级 PPAP 等级清单覆盖（顾客可对 Level 4 指定额外文件）
  ensureColumn('ppap_submission', 'required_items_json');
  // B-04：不符合质量门时的书面偏差（原因 + 批准人 + 有效期），与 PPAP 要素绑定
  ensureColumn('ecr', 'impact_analysis');
  ensureColumn('ecr', 'verification');
  ensureColumn('change_item', 'field_name');
  ensureColumn('change_item', 'old_value');
  ensureColumn('change_item', 'new_value');
  ensureColumn('change_item', 'applied_at');
  ensureColumn('change_item', 'applied_by');
  ensureColumn('change_item', 'applied_result');
  // 导出记录必须写明受控对象的版本，不能只挂“最近基线”
  ensureColumn('export_event', 'object_version');
  ensureColumn('cp_row', 'override_fields_json');
  ensureColumn('cp_row', 'status', "TEXT DEFAULT '启用'");
  ensureColumn('cp_row', 'project_char_id');
  ensureColumn('control_plan', 'safe_launch_applicability', "TEXT DEFAULT '未判定'");
  ensureColumn('control_plan', 'safe_launch_status', "TEXT DEFAULT '未开始'");
  ensureColumn('control_plan', 'safe_launch_note');
  ensureColumn('control_plan', 'safe_launch_entry_criteria');
  ensureColumn('control_plan', 'safe_launch_exit_criteria');
  ensureColumn('control_plan', 'safe_launch_exited_by');
  ensureColumn('control_plan', 'safe_launch_exited_at');
  ensureColumn('control_plan', 'safe_launch_exit_reason');
  ensureColumn('monitoring_item', 'char_id');
  ensureColumn('monitoring_item', 'project_char_id');
  ensureColumn('msa_study', 'char_id');
  ensureColumn('msa_study', 'project_char_id');
  ensureColumn('msa_study', 'tolerance', 'REAL');
  ensureColumn('msa_study', 'project_id');
  ensureColumn('msa_study', 'plan_id');
  ensureColumn('msa_study', 'status', "TEXT DEFAULT '已计算'");
  ensureColumn('msa_study', 'completed_by');
  ensureColumn('msa_study', 'completed_at');
  ensureColumn('msa_study', 'plan_snapshot_json');
  ensureColumn('msa_plan_item', 'source_key');
  ensureColumn('msa_plan_item', 'source_version');
  ensureColumn('msa_plan_item', 'gauge_code_snapshot');
  ensureColumn('msa_plan_item', 'gauge_name_snapshot');
  ensureColumn('msa_plan_item', 'measure_tech');
  ensureColumn('msa_plan_item', 'spec_text');
  ensureColumn('msa_plan_item', 'char_name_snapshot');
  ensureColumn('msa_plan_item', 'char_unit_snapshot');
  ensureColumn('msa_plan_item', 'char_target_snapshot', 'REAL');
  ensureColumn('msa_plan_item', 'char_lsl_snapshot', 'REAL');
  ensureColumn('msa_plan_item', 'char_usl_snapshot', 'REAL');
  ensureColumn('msa_plan_item', 'char_tol_text_snapshot');
  ensureColumn('msa_plan_item', 'tolerance', 'REAL');
  ensureColumn('msa_plan_item', 'source_active', 'INTEGER DEFAULT 1');
  ensureColumn('msa_plan_item', 'source_status', "TEXT DEFAULT '有效'");
  migrateMsaPlanUniqueness();
  ensureColumn('gauge', 'resolution', 'REAL');
  ensureColumn('baseline', 'scope_json');
  ensureColumn('baseline', 'status', "TEXT DEFAULT '冻结'");
  ensureColumn('change_request', 'approved_by');
  ensureColumn('change_request', 'planned_date');
  ensureColumn('change_request', 'source_type');
  ensureColumn('change_request', 'source_id');
  ensureColumn('change_request', 'payload_json');
  ensureColumn('change_request', 'applied_at');
  ensureColumn('ecr', 'branch_baseline_id');
  // B-06：ECR 分支基线显式记录父基线，便于追溯“从哪一版分支”
  ensureColumn('ecr', 'parent_baseline_id');
  ensureColumn('audit_event', 'project_id');
  ensureColumn('audit_event', 'ip');
  ensureColumn('audit_event', 'session_id');
  ensureColumn('ppap_package', 'zip_path');
  ensureColumn('ppap_package', 'zip_hash');
  ensureColumn('ppap_package', 'file_count', 'INTEGER');
  ensureColumn('project_doc', 'custom_name');
  ensureColumn('project_doc', 'hidden', 'INTEGER DEFAULT 0');
  // A-05：模板与交付物显式绑定后，审批状态统一记录在两边
  ensureColumn('doc_template', 'approved_by');
  ensureColumn('doc_template', 'approved_at');
  ensureColumn('doc_template', 'submitted_by');
  ensureColumn('doc_template', 'submitted_at');
  ensureColumn('doc_template', 'rejected_reason');
  ensureColumn('project_doc', 'cols_json');
  ensureColumn('project_doc', 'submitted_by');
  ensureColumn('project_doc', 'submitted_at');
  ensureColumn('project_doc', 'approved_by');
  ensureColumn('project_doc', 'approved_at');
  ensureColumn('project_doc', 'rejected_reason');
  ensureColumn('project_doc', 'published_version');
  // 乐观锁令牌：每次保存生成新值，旧令牌的保存请求返回 409，避免多标签页互相覆盖
  ensureColumn('project_doc', 'lock_token');
  ensureColumn('gate_review', 'criteria_version');
  ensureColumn('gate_review', 'actions_json', "TEXT DEFAULT '[]'");
  ensureColumn('doc_template', 'doc_code');
  ensureColumn('doc_template', 'project_id');
  ensureColumn('doc_template', 'mapping_json');
  ensureColumn('doc_template', 'mapping_status', "TEXT DEFAULT '未配置'");
  ensureColumn('doc_template', 'approved_by');
  ensureColumn('doc_template', 'approved_at');
  ensureColumn('doc_template', 'source_path');
  ensureColumn('fmea_failure_cand', 'pc');
  ensureColumn('fmea_failure_cand', 'dc');
  ensureColumn('fmea_failure_cand', 'cat');
  ensureColumn('fmea_failure_cand', 'row_id');
  ensureColumn('fmea_function', 'rationale');
  ensureColumn('msa_study', 'pct_tol', 'REAL');
  // 模拟研究的“零件真实值”（每条测量链的中心值），导出数据收集表时用于对照
  ensureColumn('msa_study', 'part_values_json');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_project_char ON project_char(project_id,char_id);
    CREATE INDEX IF NOT EXISTS idx_project_char_project ON project_char(project_id,char_kind,status);
    CREATE INDEX IF NOT EXISTS idx_project_doc_project ON project_doc(project_id, doc_code);
    CREATE INDEX IF NOT EXISTS idx_fmea_header_project ON fmea_header(project_id, fmea_type);
    CREATE INDEX IF NOT EXISTS idx_fmea_node_parent ON fmea_node(fmea_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_fmea_row_header ON fmea_row(fmea_id, seq);
    CREATE INDEX IF NOT EXISTS idx_fmea_row_func ON fmea_row(func_id);
    CREATE INDEX IF NOT EXISTS idx_fmea_row_upstream ON fmea_row(upstream_row_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_fmea_row_combo
      ON fmea_row(fmea_id,fe_id,fm_id,fc_id)
      WHERE fe_id IS NOT NULL AND fm_id IS NOT NULL AND fc_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cp_project ON control_plan(project_id, stage);
    CREATE INDEX IF NOT EXISTS idx_cp_row_cp ON cp_row(cp_id, seq);
    CREATE INDEX IF NOT EXISTS idx_cp_row_pchar ON cp_row(project_char_id);
    CREATE INDEX IF NOT EXISTS idx_mon_cp_row ON monitoring_item(cp_row_id);
    CREATE INDEX IF NOT EXISTS idx_spc_mon ON spc_dataset(mon_id, dataset_id);
    CREATE INDEX IF NOT EXISTS idx_msa_plan_project ON msa_plan_item(project_id,status,planned_date);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_msa_plan_source ON msa_plan_item(project_id,source_key)
      WHERE source_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_msa_study_source
      ON msa_study(project_id,project_char_id,gauge_id,studied_at,study_id);
    CREATE INDEX IF NOT EXISTS idx_baseline_project ON baseline(project_id, frozen_at);
    CREATE INDEX IF NOT EXISTS idx_baseline_item_key ON baseline_item(baseline_id, object_type, object_id);
    CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_event(object_type, object_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_export_project ON export_event(project_id, exported_at);
    CREATE INDEX IF NOT EXISTS idx_approval_project ON activity_approval(project_id, status, requested_at);
  `);
  db.exec(`
    UPDATE project_doc SET hidden=0 WHERE hidden IS NULL;
    UPDATE monitoring_item SET approval_status='已批准', approved_by=COALESCE(approved_by,'系统迁移'), approved_at=COALESCE(approved_at, datetime('now')) WHERE approval_status IS NULL;
    UPDATE monitoring_item SET approval_status='已批准', approved_by=COALESCE(NULLIF(approved_by,''),'系统迁移'),
      approved_at=COALESCE(approved_at, datetime('now'))
      WHERE approval_status='待审核' AND created_at IS NULL AND COALESCE(approved_by,'')='';
    UPDATE char_link SET status='生效' WHERE status IS NULL;
    UPDATE doc_template SET mapping_status='未配置' WHERE mapping_status IS NULL;
    UPDATE gauge SET resolution=CASE
      WHEN gauge_id IN ('G-014','G-060') THEN 0.001
      WHEN gauge_id='G-021' THEN 0.01
      WHEN gauge_id IN ('G-033','G-045') THEN 0.1
      ELSE resolution END
      WHERE resolution IS NULL;
    UPDATE msa_study SET project_id=(
      SELECT pc.project_id FROM project_char pc WHERE pc.pchar_id=msa_study.project_char_id
    ) WHERE project_id IS NULL AND project_char_id IS NOT NULL;
    UPDATE fmea_row SET func_id=effect_ref
      WHERE (func_id IS NULL OR func_id='')
        AND EXISTS (SELECT 1 FROM fmea_function f WHERE f.func_id=fmea_row.effect_ref);
    UPDATE fmea_row SET upstream_row_id=effect_ref
      WHERE (upstream_row_id IS NULL OR upstream_row_id='')
        AND EXISTS (SELECT 1 FROM fmea_row r2 WHERE r2.row_id=fmea_row.effect_ref);
  `);
  const row = db.prepare('SELECT COUNT(*) c FROM project').get();
  if (!row || row.c === 0) seed();
  healApMatrix();
  db.exec(`
    INSERT OR IGNORE INTO product_family(family_id,code,name,category,status) VALUES('FM','RJ','金属膜固定电阻器','RES-FILM','生效');
    INSERT OR IGNORE INTO product_family(family_id,code,name,category,status) VALUES('FW','RX','绕线固定电阻器','RES-WIRE','生效');
    INSERT OR IGNORE INTO product_series VALUES('SR-RJ','FM','RJ','RJ 系列','生效');
    INSERT OR IGNORE INTO product_series VALUES('SR-RX','FW','RX','RX 系列','生效');
    UPDATE project SET family_id='FW',series_id='SR-RX'
      WHERE series_id IS NULL AND (name LIKE 'RX%' OR code LIKE 'RX%');
    UPDATE project SET series_id='SR-RJ'
      WHERE series_id IS NULL AND family_id='FM';
  `);
  tx(() => migrateProjectDefaults());
  // M-04：项目特性创建后回填演示 MSA 研究的项目关联（原回填在 seed 之前，永远命中空表）
  db.exec(`
    UPDATE msa_study SET project_char_id=(
      SELECT pc.pchar_id FROM project_char pc
      WHERE pc.char_id=msa_study.char_id
      ORDER BY pc.created_at, pc.pchar_id LIMIT 1
    ) WHERE project_char_id IS NULL AND char_id IS NOT NULL;
    UPDATE msa_study SET project_id=(
      SELECT pc.project_id FROM project_char pc WHERE pc.pchar_id=msa_study.project_char_id
    ) WHERE project_id IS NULL AND project_char_id IS NOT NULL;
    UPDATE msa_study SET char_id=(
      SELECT pc.char_id FROM project_char pc WHERE pc.pchar_id=msa_study.project_char_id
    ) WHERE (char_id IS NULL OR char_id='') AND project_char_id IS NOT NULL;
  `);
}

// 历史上使用过的固定口令，仅用于启动巡检告警，不再作为默认值写入
const KNOWN_WEAK_PASSWORDS = ['admin123', 'engineer123', 'quality123', 'auditor123'];

/**
 * 部门-岗位账号（2026-11-05 组织架构）。
 * 首次启动按岗位建号，口令一次性生成并写入 initial-credentials.txt；后续可改名或停用。
 * 环境变量 QMS_SEED_DEPARTMENT_USERS=0 可关闭（仅保留 4 个基础账号）。
 */
const DEPARTMENT_ACCOUNTS = [
  // user_id, 登录名, 姓名（岗位）, 角色, 部门, 岗位, 扩展标记
  ['USR-GM', 'gm', '总经理', 'gm', '总经理', '总经理', ''],
  ['USR-CHIEF', 'chief', '总工', 'chief', '总工', '总工', ''],
  ['USR-MGMT-REP', 'mgmt_rep', '管理者代表', 'mgmt_rep', '管理者代表', '管理者代表', ''],
  ['USR-VP-TECH', 'vp_tech', '技术副总经理', 'vp_tech', '技术副总经理', '副总经理', ''],
  ['USR-VP-SAFETY', 'vp_safety', '安全生产副总经理', 'vp_safety', '安全生产副总经理', '副总经理', ''],
  ['USR-VP-OPS', 'vp_ops', '副总经理（市场/工艺/科技）', 'vp_ops', '副总经理', '副总经理', ''],
  ['USR-VP-ADMIN', 'vp_admin', '行政财务副总经理', 'vp_admin', '行政财务副总经理', '副总经理', ''],
  ['USR-QUALITY-01', 'quality01', '质量工程师 01', 'quality', '质量管理部', '质量工程师', ''],
  ['USR-QUALITY-02', 'quality02', '质量工程师 02', 'quality', '质量管理部', '质量工程师', ''],
  ['USR-INSPECTOR-01', 'inspector01', '检验员 01', 'inspector', '质量管理部', '检验员', ''],
  ['USR-DESIGN-01', 'design01', '设计工程师 01（项目经理）', 'design', '科研一所', '设计工程师', ''],
  ['USR-ENGINEER-01', 'engineer01', '工艺工程师 01', 'engineer', '技术工艺部', '工艺工程师', ''],
  ['USR-ENGINEER-02', 'engineer02', '工艺工程师 02', 'engineer', '技术工艺部', '工艺工程师', ''],
  ['USR-PRODUCTION-01', 'production01', '生产工程师 01', 'production', '生产部', '生产工程师', ''],
  ['USR-PURCHASE-01', 'purchase01', '采购员 01', 'purchase', '企业管理部', '采购员', ''],
  ['USR-PURCHASE-02', 'purchase02', '设备工装管理员 01', 'purchase', '企业管理部', '设备工装管理员', ''],
  ['USR-METROLOGY-01', 'metrology01', '计量评定员 01', 'purchase', '企业管理部', '计量 / 评定员', ''],
  ['USR-BUSINESS-01', 'business01', '客户经理 01', 'business', '市场一部', '客户经理', ''],
  ['USR-STD-01', 'std01', '标准化 / 文控 01', 'std', '科技管理中心', '标准化 / 文控', ''],
  ['USR-STAFF-01', 'staff01', '综合只读 01', 'staff', '人力资源部', '综合事务', ''],
  ['USR-FACILITY-01', 'facility01', '环境与设施管理员 01', 'staff', '安全环保部', '设施管理员', 'facility'],
  ['USR-AUDITOR-01', 'auditor01', '内审员 01', 'auditor', '质量管理部', '内审员', ''],
];

function appendCredentials(lines) {
  if (!lines.length) return null;
  // 每个库独立一个文件：走查库/测试库写自己的，不能混进正式库那一条，否则分不清哪条口令能登录
  const dbName = path.basename(DB_PATH, '.db');
  const credFile = path.join(dbDir, `initial-credentials.${dbName}.txt`);
  let existing = [];
  try { existing = fs.readFileSync(credFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* 首次生成 */ }
  const header = existing.length ? existing[0]
    : 'resistor-qms 初始账号（首次启动自动生成，登录后请立即修改）';
  const body = existing.slice(1);
  fs.writeFileSync(credFile, [header, ...body, ...lines].join('\n') + '\n', { mode: 0o600 });
  return credFile;
}

function seedAuthUsers() {
  const defaults = [
    ['USR-ADMIN', 'admin', '系统管理员', 'admin', 'QMS_ADMIN_PASSWORD', '办公室', '系统管理员', ''],
    ['USR-ENGINEER', 'engineer', '工艺工程师', 'engineer', 'QMS_ENGINEER_PASSWORD', '技术工艺部', '工艺工程师', ''],
    ['USR-QUALITY', 'quality', '质量工程师', 'quality', 'QMS_QUALITY_PASSWORD', '质量管理部', '质量工程师', ''],
    ['USR-AUDITOR', 'auditor', '审核员', 'auditor', 'QMS_AUDITOR_PASSWORD', '质量管理部', '内审员', ''],
  ];
  const seedDepartments = String(process.env.QMS_SEED_DEPARTMENT_USERS || '1') !== '0';
  const accounts = seedDepartments ? [...defaults, ...DEPARTMENT_ACCOUNTS] : defaults;
  const insert = db.prepare(`INSERT OR IGNORE INTO auth_user(
    user_id,username,display_name,role,password_salt,password_hash,status,created_at,
    department,position,flags
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const generated = [];
  for (const [id, username, displayName, role, ...rest] of accounts) {
    // 基础账号带环境变量名（8 列），部门岗位账号不带（7 列）
    const [envKey, department, position, flags] = rest.length >= 4 ? rest : ['', ...rest];
    const configured = String(process.env[envKey] || '');
    // 未配置环境变量时不再使用已知默认口令，而是生成一次性随机口令
    const password = configured || crypto.randomBytes(9).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const result = insert.run(id, username, displayName, role, salt,
      passwordDigest(password, salt), '启用', now(), department, position, flags || null);
    if (!configured && result.changes) {
      db.prepare('UPDATE auth_user SET must_change_password=1 WHERE user_id=?').run(id);
      generated.push(`${username}\t${password}\t${department} · ${position}`);
    }
    // 历史库补部门/岗位（只补空值，不覆盖管理员后来改过的内容）
    if (result.changes === 0) {
      db.prepare(`UPDATE auth_user SET department=COALESCE(NULLIF(department,''),?),
        position=COALESCE(NULLIF(position,''),?) WHERE user_id=?`)
        .run(department, position, id);
    }
  }
  const credFile = appendCredentials(generated);
  if (credFile) {
    console.warn(`[安全] 已生成初始账号口令：${credFile}（仅本机可读，登录后请立即修改）`);
  }
  // 已有数据库可能仍保留旧默认口令：启动时显式告警，便于及时更换
  const weak = [];
  for (const [id, username] of defaults) {
    const row = db.prepare('SELECT * FROM auth_user WHERE user_id=?').get(id);
    if (row && KNOWN_WEAK_PASSWORDS.some(pw => verifyPassword(pw, row.password_salt, row.password_hash))) {
      weak.push(username);
    }
  }
  if (weak.length) {
    console.warn(`[安全] 以下账号仍在使用已知默认口令，请立即修改：${weak.join('、')}`);
  }
}

module.exports = {
  init, get db() { return db; },
  get path() { return DB_PATH; },
  apLookup, computeGRR, freezeBaseline, ensureProjectChars, ensureProjectChar,
  ensureMsaPlans, listMsaPlans, latestMsaStudy, hash, now, rid, tx, passwordDigest, verifyPassword,
  APQP_TASKS, PPAP_ELEMENTS, healApMatrix, DEFAULT_CPK_TARGET,
};
