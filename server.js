'use strict';
/** HTTP 服务：REST API + 静态资源 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');

const DB = require('./lib/db');
const L = require('./lib/logic');
const DT = require('./lib/doctpl');
const EX = require('./lib/export');
const PPAP_WORKFLOW = require('./lib/ppap-workflow');
const DS = require('./lib/deliverable-sync');
const CS = require('./lib/control-sync');
const FG = require('./lib/field-guide');
const PM = require('./lib/perm');
DB.init();
DS.init();
CS.init();

const PORT = Number(process.env.PORT || 8848);
const HOST = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const PUB = path.join(__dirname, 'public');
const DB_FILE = DB.path;
const PACKAGE_DIR = path.join(path.dirname(DB_FILE), 'packages');
const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const TEMPLATE_DIR = path.join(path.dirname(DB_FILE), 'templates');
// 交付物附件（包装图片、工程图）存这里；不放进 public/，避免绕过登录直接访问
const ATTACHMENT_DIR = path.join(path.dirname(DB_FILE), 'attachments');
if (!fs.existsSync(PACKAGE_DIR)) fs.mkdirSync(PACKAGE_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATE_DIR)) fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
if (!fs.existsSync(ATTACHMENT_DIR)) fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
// Old databases may not contain the demo seed anymore; an invalid fallback blanks the whole UI.
const DEFAULT_PROJECT = DB.db.prepare("SELECT project_id FROM project WHERE project_id='RES-CHIP-2026-01'").get()
  ?.project_id || DB.db.prepare('SELECT project_id FROM project ORDER BY rowid LIMIT 1').get()?.project_id || '';
const requestContext = new AsyncLocalStorage();
let fallbackProject = DEFAULT_PROJECT;
Object.defineProperty(globalThis, 'CUR', {
  configurable: true,
  get() { return (requestContext.getStore() || {}).projectId || fallbackProject; },
  set(value) { fallbackProject = value || DEFAULT_PROJECT; },
});
// 审计记录里的操作人一律取登录会话，调用点传入的姓名只在无会话场景（启动同步/迁移）兜底
L.setActorResolver(() => requestContext.getStore()?.user?.display_name || '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
const MAX_BODY_BYTES = 20 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      // 累计计数：每块都重算整个字符串会随体积平方增长，大上传时卡住事件循环
      bytes += Buffer.byteLength(c);
      if (bytes > MAX_BODY_BYTES) {
        // 不销毁连接：先让 413 送达；后续数据只丢弃不累积，内存仍被限制在上限以内
        tooLarge = true;
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (tooLarge) return;
      const clean = data.replace(/^\uFEFF/, '').trim();
      if (!clean) return resolve({});
      try { resolve(JSON.parse(clean)); } catch (e) { reject(new Error('JSON 解析失败：' + clean.slice(0, 60))); }
    });
    req.on('error', reject);
  });
}
const q = (s, ...a) => DB.db.prepare(s).get(...a);
const all = (s, ...a) => DB.db.prepare(s).all(...a);
function validateDocumentColumns(code, columns) {
  for (const field of (DT.T[code] || []).flatMap(section => section.fields || [])) {
    if (field.type !== 'table' || !columns[field.k]) continue;
    const saved = columns[field.k];
    if (DT.CHECKLIST_QUESTIONS[code] && Array.isArray(saved) && saved.length === 5) {
      continue;
    }
    if (!Array.isArray(saved) || saved.some((label, index) =>
      index < field.cols.length && label !== field.cols[index])) {
      throw new Error('受控表格的标准列不能删除、改名或调整顺序，请恢复标准列后保存');
    }
    const legacyWidths = code === 'P1-11' ? [5, 6]
      : code === 'P2-11' ? [6, 7]
        : DT.CHECKLIST_QUESTIONS[code] ? [5] : [];
    if (saved.length < field.cols.length
      && !legacyWidths.includes(saved.length)) {
      throw new Error('受控表格缺少标准列，请恢复标准列后保存');
    }
  }
}
function normalizeDocumentRows(data, schema, previous = {}) {
  const normalized = { ...previous, ...data };
  normalized._syncRows = {
    ...(previous._row_ids || {}), ...(previous._syncRows || {}),
    ...(data._row_ids || {}), ...(data._syncRows || {}),
  };
  normalized._syncMeta = { ...(previous._syncMeta || {}), ...(data._syncMeta || {}) };
  for (const field of (schema || []).flatMap(section => section.fields || [])) {
    if (field.type !== 'table' || !Array.isArray(normalized[field.k])) continue;
    const ids = normalized._syncRows[field.k] || [];
    const counts = new Map();
    for (const id of ids) {
      if (typeof id === 'string' && id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const seen = new Set();
    normalized[field.k] = normalized[field.k].map(row => {
      const values = Array.isArray(row) ? [...row] : [];
      while (values.length < (field.cols || []).length) values.push('');
      return values;
    });
    normalized._syncRows[field.k] = normalized[field.k].map((row, index) => {
      const candidate = ids[index];
      const duplicate = typeof candidate === 'string' && counts.get(candidate) > 1;
      const id = typeof candidate === 'string' && candidate.length <= 100 && !seen.has(candidate) && !duplicate
        ? candidate : crypto.randomUUID();
      seen.add(id);
      return id;
    });
  }
  return normalized;
}
function fillCharacteristicTypes(code, data) {
  if (!['P1-11', 'P2-11'].includes(code) || !Array.isArray(data.chars)) return data;
  const column = code === 'P1-11' ? 5 : 6;
  const rowIds = data._syncRows?.chars || [];
  for (const [index, row] of data.chars.entries()) {
    if (!Array.isArray(row) || String(row[column] || '').trim() || !String(row[0] || '').trim()) continue;
    const rowId = rowIds[index];
    const type = data._syncMeta?.chars?.[rowId]?.char_kind
      || (q('SELECT char_kind FROM char_master WHERE char_id=?', String(row[0]).trim()) || {}).char_kind;
    if (['PRODUCT', 'PROCESS'].includes(type)) row[column] = type;
  }
  return data;
}
const CHARACTERISTIC_SPEC_FIELDS = ['unit', 'target', 'lsl', 'usl', 'tol_text'];

function characteristicSpecText(char) {
  return char?.tol_text || (char?.lsl != null && char?.usl != null
    ? `${char.lsl} ~ ${char.usl} ${char.unit || ''}`.trim() : '');
}

function specificationValue(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value.trim() : value;
}

function specificationSame(left, right) {
  const a = specificationValue(left);
  const b = specificationValue(right);
  if (a === '' || b === '') return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number.isFinite(+a) && Number.isFinite(+b) && +a === +b;
  }
  const textA = String(a);
  const textB = String(b);
  if (textA === textB || textA.replace(/\s+/g, '') === textB.replace(/\s+/g, '')) return true;
  // 文本格式不同但数值含义相同（如 10±0.5 与 9.5 ~ 10.5）不视为规范变更
  const fingerprintA = DS.specificationFingerprint(DS.parseSpecification(textA));
  const fingerprintB = DS.specificationFingerprint(DS.parseSpecification(textB));
  return !!fingerprintA && fingerprintA === fingerprintB;
}

/**
 * CP 行规范文本是否需要跟随项目特性更新。
 * 不可解析的历史自由文本（如“见顾客图纸”）保留人工内容，只在新值为数值文本时提示同步。
 */
function specTextNeedsUpdate(current, desired) {
  if (specificationSame(current, desired)) return false;
  const currentText = String(specificationValue(current));
  if (!currentText) return String(specificationValue(desired)) !== '';
  const currentFingerprint = DS.specificationFingerprint(DS.parseSpecification(currentText));
  if (!currentFingerprint) return false;
  return true;
}

// D-10：来源类型使用受控词表，来源编号做格式校验；历史自由文本保留兼容，只提示不拒绝。
const CHAR_SOURCE_TYPES = ['客户图纸', '客户规范', 'AEC-Q200', 'IEC 标准', '国家标准',
  '试验报告', '内部', 'DOE', '工艺验证', '8D/FA', '其他', 'PFMEA 现场新增', '项目复制'];
const CHAR_SOURCE_TYPE_ALIASES = new Map([
  ['图纸', '客户图纸'], ['客户图纸/规范', '客户规范'], ['客户规范书', '客户规范'],
  ['AEC', 'AEC-Q200'], ['AECQ200', 'AEC-Q200'], ['AEC-Q200 车规', 'AEC-Q200'],
  ['IEC', 'IEC 标准'], ['国标', '国家标准'], ['GB', '国家标准'], ['GB/T', '国家标准'],
  ['试验', '试验报告'], ['测试报告', '试验报告'], ['内部规范', '内部'],
  ['工艺', '工艺验证'], ['FA', '8D/FA'], ['8D', '8D/FA'],
]);

function normalizeCharSource(typeValue, refValue, { validateRef = true } = {}) {
  let type = String(typeValue == null ? '' : typeValue).trim().replace(/\s+/g, ' ');
  if (CHAR_SOURCE_TYPE_ALIASES.has(type)) type = CHAR_SOURCE_TYPE_ALIASES.get(type);
  const ref = String(refValue == null ? '' : refValue).trim().replace(/[\r\n\t]+/g, ' ');
  if (validateRef) {
    if (ref.length > 120) throw new Error('来源编号不能超过 120 个字符');
    if (/[\u0000-\u001f\u007f]/.test(ref)) throw new Error('来源编号不能包含控制字符');
    const placeholder = ['—', '-', '/', 'N/A', '无'].includes(ref);
    if (ref && !placeholder && !/[\p{L}\p{N}]/u.test(ref)) {
      throw new Error('来源编号至少应包含一个字母、数字或汉字');
    }
  }
  return { type, ref, recognized: !type || CHAR_SOURCE_TYPES.includes(type) };
}

function projectCharSpecs(projectId) {
  return new Map(all(`SELECT pchar_id,char_id,name,unit,target,lsl,usl,tol_text
    FROM project_char WHERE project_id=?`, projectId).map(row => [row.pchar_id, row]));
}

/**
 * D-03/Q-09/C-04：项目特性是下游规范的唯一来源。
 * 规范变更后在同一事务里完成：
 *   1. cp_row.spec_text 与 project_char 同值（显式 override 的字段除外）；
 *   2. CP 降草稿（保留旧批准版本快照）；
 *   3. 关联 SPC 监控项回到待审核，并重新挂到当前项目特性；
 *   4. 未完成的 MSA 计划刷新规范快照与公差（已完成研究保持历史快照）。
 */
function reconcileCharacteristicSpecs(projectId, pcharIds = []) {
  const ids = [...new Set(pcharIds.filter(Boolean))];
  const result = { characteristics: 0, cp_rows: 0, cp_ids: [], monitoring_items: 0, msa_plans: 0 };
  if (!ids.length) return result;
  const placeholders = ids.map(() => '?').join(',');
  const chars = all(`SELECT * FROM project_char WHERE project_id=? AND pchar_id IN (${placeholders})`,
    projectId, ...ids);
  for (const char of chars) {
    result.characteristics += 1;
    const desired = characteristicSpecText(char);
    const rows = all(`SELECT r.cp_row_id,r.cp_id,r.spec_text,r.project_char_id,r.override_fields_json
      FROM cp_row r JOIN control_plan cp ON cp.cp_id=r.cp_id
      WHERE cp.project_id=? AND (r.project_char_id=? OR (r.project_char_id IS NULL AND r.char_id=?))
      ORDER BY r.cp_row_id`, projectId, char.pchar_id, char.char_id);
    const updates = [];
    for (const row of rows) {
      let overrides = [];
      try {
        const parsed = JSON.parse(row.override_fields_json || '[]');
        if (Array.isArray(parsed)) overrides = parsed;
      } catch (error) { overrides = []; }
      const linked = !!row.project_char_id;
      const specChanged = !overrides.includes('spec_text')
        && specTextNeedsUpdate(row.spec_text, desired);
      if (!linked || specChanged) updates.push({ row, linked, specChanged });
    }
    if (updates.length) {
      const cpIds = [...new Set(updates.filter(update => update.specChanged).map(update => update.row.cp_id))];
      for (const cpId of cpIds) markCpDraft(cpId, projectId);
      for (const update of updates) {
        DB.db.prepare(`UPDATE cp_row SET project_char_id=COALESCE(project_char_id,?),spec_text=?
          WHERE cp_row_id=?`).run(
          update.linked ? null : char.pchar_id,
          update.specChanged ? desired : update.row.spec_text,
          update.row.cp_row_id
        );
      }
      if (cpIds.length) {
        result.cp_rows += updates.filter(update => update.specChanged).length;
        result.cp_ids.push(...cpIds);
      }
    }
    if (rows.length) {
      // 即使 CP 行人工保护了 spec_text，监控项与 MSA 计划也必须随项目特性重新复核。
      const cpRowIds = rows.map(row => row.cp_row_id);
      const monitored = DB.db.prepare(`UPDATE monitoring_item SET
        char_id=?,project_char_id=?,approval_status='待审核',approved_by='',approved_at=NULL,
        review_note='特性规范已变更，需重新审核监控配置'
        WHERE cp_row_id IN (${cpRowIds.map(() => '?').join(',')})`)
        .run(char.char_id, char.pchar_id, ...cpRowIds);
      result.monitoring_items += Number(monitored.changes || 0);
    }
    // MSA 计划快照随规范更新；已完成研究保留其历史证据，不做覆盖。
    const tolerance = char.lsl != null && char.usl != null
      ? +Math.abs(char.usl - char.lsl).toFixed(10) : null;
    const plans = all(`SELECT * FROM msa_plan_item
      WHERE project_id=? AND project_char_id=? AND status<>'已完成'`, projectId, char.pchar_id);
    for (const plan of plans) {
      if (specificationSame(plan.char_name_snapshot, char.name)
          && specificationSame(plan.char_unit_snapshot, char.unit)
          && specificationSame(plan.char_target_snapshot, char.target)
          && specificationSame(plan.char_lsl_snapshot, char.lsl)
          && specificationSame(plan.char_usl_snapshot, char.usl)
          && specificationSame(plan.char_tol_text_snapshot, desired)
          && specificationSame(plan.tolerance, tolerance)) continue;
      DB.db.prepare(`UPDATE msa_plan_item SET
        char_name_snapshot=?,char_unit_snapshot=?,char_target_snapshot=?,char_lsl_snapshot=?,
        char_usl_snapshot=?,char_tol_text_snapshot=?,tolerance=?,
        source_status=CASE WHEN source_status='来源已失效' THEN source_status ELSE '待复核' END,
        updated_at=? WHERE plan_id=?`).run(
        char.name || '', char.unit || '', char.target, char.lsl, char.usl, desired || '',
        tolerance, DB.now(), plan.plan_id
      );
      result.msa_plans += 1;
    }
  }
  return result;
}

function syncProjectDeliverables(projectId, options = {}) {
  const specsBefore = options.reconcile === false ? null : projectCharSpecs(projectId);
  const sync = DS.syncProject(projectId);
  let spec = { characteristics: 0, cp_rows: 0, cp_ids: [], monitoring_items: 0, msa_plans: 0 };
  if (specsBefore) {
    // 启动时（reconcile:false）只回算引用与状态，不因历史数据格式差异批量降级已批准控制计划
    const specsAfter = projectCharSpecs(projectId);
    const changedPchars = new Set(options.pcharIds || []);
    for (const [pcharId, after] of specsAfter) {
      const before = specsBefore.get(pcharId);
      if (!before || CHARACTERISTIC_SPEC_FIELDS.some(field =>
        !specificationSame(before[field], after[field]))) {
        changedPchars.add(pcharId);
      }
    }
    spec = reconcileCharacteristicSpecs(projectId, [...changedPchars]);
  }
  const control = CS.syncProject(projectId);
  DB.ensureMsaPlans(projectId);
  const states = DS.list(projectId).summary;
  const controlConflicts = control.pfd.conflicts + control.cp.conflicts + control.stages.conflicts;
  return {
    ...sync,
    spec,
    conflicts: sync.conflicts + controlConflicts,
    review_required: states.review_required || 0,
    source_missing: states.source_missing || 0,
    control,
  };
}
function projectGauges(projectId) {
  return all(`SELECT DISTINCT g.* FROM gauge g WHERE EXISTS(
    SELECT 1 FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE p.project_id=? AND c.gauge_id=g.gauge_id
  ) ORDER BY g.gauge_id`, projectId);
}
/**
 * C-11：特殊特性或高 AP 失效链对应的控制计划行，批准前必须有可追溯的 PFMEA 依据。
 * 依据来源：cp_fmea_link 或 cp_row.fmea_row_id，且必须指向本项目 PFMEA 的现存行。
 */
function validateCpForApproval(cpId, projectId = CUR) {
  // 原型控制计划允许先于 PFMEA 建立；试生产/量产 CP 必须能追溯到 PFMEA。
  const plan = q('SELECT * FROM control_plan WHERE cp_id=? AND project_id=?', cpId, projectId);
  if (!plan || !['PILOT', 'SOP'].includes(plan.stage)) return [];
  const rows = all(`SELECT c.*, pc.is_special pc_special, pc.special_symbol pc_symbol,
      cm.is_special cm_special, cm.special_symbol cm_symbol
    FROM cp_row c
    LEFT JOIN project_char pc ON pc.pchar_id=c.project_char_id AND pc.project_id=?
    LEFT JOIN char_master cm ON cm.char_id=COALESCE(pc.char_id,c.char_id)
    WHERE c.cp_id=? AND COALESCE(c.status,'启用')='启用'`, projectId, cpId);
  const issues = [];
  for (const row of rows) {
    const special = !!(row.pc_special || row.cm_special);
    const linked = all(`SELECT DISTINCT r.row_id
      FROM cp_row c
      JOIN fmea_row r ON r.row_id=c.fmea_row_id OR EXISTS(
        SELECT 1 FROM cp_fmea_link l WHERE l.cp_row_id=c.cp_row_id AND l.fmea_row_id=r.row_id)
      JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE c.cp_row_id=? AND h.project_id=? AND h.fmea_type='PFMEA'`,
    row.cp_row_id, projectId).map(item => item.row_id);
    const highAp = row.step_id && row.char_id
      ? all(`SELECT r.row_id FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
          WHERE h.project_id=? AND h.fmea_type='PFMEA' AND r.step_id=?
            AND (r.char_id=? OR r.process_char_id=?) AND r.ap='H'`,
        projectId, row.step_id, row.char_id, row.char_id)
      : [];
    if (linked.length) continue;
    if (special) {
      issues.push({
        cp_row_id: row.cp_row_id, char_id: row.char_id || '',
        symbol: row.pc_symbol || row.cm_symbol || '',
        reason: '特殊特性行没有可追溯的 PFMEA 依据',
      });
    } else if (highAp.length) {
      issues.push({
        cp_row_id: row.cp_row_id, char_id: row.char_id || '',
        reason: `关联 ${highAp.length} 条高 AP PFMEA 行，但控制计划行未关联依据`,
      });
    }
  }
  if (issues.length) {
    throw Object.assign(
      new Error(`有 ${issues.length} 条高 AP/特殊特性控制计划行缺少 PFMEA 依据：${issues.map(item =>
        `${item.cp_row_id}${item.char_id ? `（${item.char_id}）` : ''}`).join('、')}`),
      { statusCode: 409, details: { cp_rows: issues } }
    );
  }
  return issues;
}

function markCpDraft(cpId, projectId = CUR) {
  // 自动降级前先留存已批准版本，否则下游一改动，原批准内容就再也查不到
  const approved = q(`SELECT 1 FROM control_plan WHERE cp_id=? AND project_id=?
    AND status IN ('已批准','已冻结')`, cpId, projectId);
  if (approved) snapshotCpRevision(cpId, '下游对象变更，控制计划自动降为草稿', projectId);
  DB.db.prepare(`UPDATE control_plan SET status='草稿',approved_by='',effective_date=''
    WHERE cp_id=? AND status IN ('已批准','已冻结')`).run(cpId);
}
/* F-06：删除 FMEA 行前，先清理它对控制计划的引用。
   1) 删除 cp_fmea_link 中的对应链接（否则 CP 行会因“仍有链接”而永远删不掉，自动同步也会误判）；
   2) 受影响控制计划（不论是否已批准）统一降为草稿，避免“依据被删了、CP 还是已批准”。
   cp_row.fmea_row_id 由调用方负责置空。 */
function invalidateCpForFmeaRows(rowIds = []) {
  const ids = [...new Set(rowIds.filter(Boolean))];
  if (!ids.length) return { cp_rows: 0, cp_ids: [] };
  const ph = ids.map(() => '?').join(',');
  const linked = all(`SELECT DISTINCT cp_row_id FROM cp_fmea_link WHERE fmea_row_id IN (${ph})`, ...ids)
    .map(row => row.cp_row_id);
  const direct = all(`SELECT cp_row_id FROM cp_row WHERE fmea_row_id IN (${ph})`, ...ids)
    .map(row => row.cp_row_id);
  const cpRowIds = [...new Set([...linked, ...direct])];
  DB.db.prepare(`DELETE FROM cp_fmea_link WHERE fmea_row_id IN (${ph})`).run(...ids);
  const cpIds = [...new Set(cpRowIds
    .map(cpRowId => (q('SELECT cp_id FROM cp_row WHERE cp_row_id=?', cpRowId) || {}).cp_id)
    .filter(Boolean))];
  for (const cpId of cpIds) markCpDraft(cpId);
  return { cp_rows: cpRowIds.length, cp_ids: cpIds };
}
function requireCurrentProject(sql, ...args) {
  const row = q(sql, ...args, CUR);
  if (!row) throw new Error('对象不属于当前项目或不存在');
  return row;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
// 口令策略：管理员重置时用的统一初始口令，长度下限 6 位；首次登录仍强制改密
const DEFAULT_PASSWORD = String(process.env.QMS_DEFAULT_PASSWORD || '123456');
const PASSWORD_MIN_LENGTH = 6;
// 已知弱口令：不能作为“修改后”的新口令
const WEAK_PASSWORDS = [...new Set([DEFAULT_PASSWORD, '123456',
  'admin123', 'engineer123', 'quality123', 'auditor123'])];
// 登录失败计数（单进程内存）：连续 5 次锁 5 分钟，避免局域网内暴力尝试。
// 键含来源 IP：只按用户名会被“随机用户名”撑爆内存，也会让攻击者锁死他人账号。
const LOGIN_ATTEMPTS = new Map();
const LOGIN_ATTEMPT_TTL_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_MAX = 5000;
function loginAttemptKey(req, username) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${ip}|${username.slice(0, 64)}`;
}
/** 惰性清理：超过 TTL 的记录在下次访问时丢弃，同时兜住内存上限 */
function pruneLoginAttempts() {
  const now = Date.now();
  for (const [key, entry] of LOGIN_ATTEMPTS) {
    if (!entry.until && now - entry.last > LOGIN_ATTEMPT_TTL_MS) LOGIN_ATTEMPTS.delete(key);
    else if (entry.until && entry.until < now - LOGIN_ATTEMPT_TTL_MS) LOGIN_ATTEMPTS.delete(key);
  }
  if (LOGIN_ATTEMPTS.size > LOGIN_ATTEMPT_MAX) {
    // 仍然超限时按最久未活跃淘汰，保证表不会无限增长
    const sorted = [...LOGIN_ATTEMPTS.entries()].sort((a, b) => a[1].last - b[1].last);
    for (const [key] of sorted.slice(0, LOGIN_ATTEMPTS.size - LOGIN_ATTEMPT_MAX)) {
      LOGIN_ATTEMPTS.delete(key);
    }
  }
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = DB.passwordDigest('not-a-real-password', DUMMY_SALT);
// 角色名称统一由权限内核提供（含新增的部门岗位角色）；缺省回退旧名称
const ROLE_NAMES = Object.fromEntries(Object.entries(PM.ROLES).map(([key, def]) => [key, def.name]));
function hashSession(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => {
    const i = item.indexOf('=');
    return i > 0 ? [item.slice(0, i).trim(), decodeURIComponent(item.slice(i + 1).trim())] : null;
  }).filter(Boolean));
}
function authUserFromRequest(req) {
  const token = parseCookies(req).qms_session;
  if (!token) return null;
  const row = q(`SELECT u.user_id,u.username,u.display_name,u.role,u.must_change_password,
      u.department,u.position,u.vp_scope,u.flags,u.perms_json
    FROM auth_session s JOIN auth_user u ON u.user_id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.status='启用'`, hashSession(token), DB.now());
  if (!row) return null;
  // 账号级权限勾选：解析后交给权限内核；为空表示沿用角色默认
  try { row.perms = row.perms_json ? JSON.parse(row.perms_json) : null; } catch { row.perms = null; }
  return row;
}
function publicUser(user) {
  return user ? { user_id: user.user_id, username: user.username, display_name: user.display_name,
    role: user.role, role_name: ROLE_NAMES[user.role] || user.role,
    department: user.department || '', position: user.position || '',
    permissions: PM.permissionsFor(user),
    must_change_password: !!user.must_change_password } : null;
}
function setSessionCookie(res, token, maxAge = SESSION_TTL_MS / 1000) {
  // 有 TLS 前置（QMS_HTTPS=1）时才加 Secure，否则明文 HTTP 下浏览器会丢弃 Cookie 导致无法登录
  const secure = String(process.env.QMS_HTTPS || '') === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `qms_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}
/* ---- 动作级权限：auditor < engineer < quality < admin ---- */
const ROLE_RANK = { auditor: 1, engineer: 2, quality: 3, admin: 4 };
// 这些字段在请求体里只能代表“当前登录人”，客户端传什么都会被会话身份覆盖
const ACTOR_FIELDS = ['user', 'approved_by', 'reviewer', 'published_by', 'requested_by',
  'imported_by', 'updated_by', 'changed_by', 'approved_by_name'];
function sessionUser() {
  const user = requestContext.getStore()?.user;
  if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
  return user;
}
function actorName(fallback = '系统') {
  return requestContext.getStore()?.user?.display_name || fallback;
}
function requireRoleLevel(minimum, label = '此操作') {
  const user = sessionUser();
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[minimum] || 0)) {
    throw Object.assign(
      new Error(`${label}需要${ROLE_NAMES[minimum] || minimum}及以上权限，当前账号为${ROLE_NAMES[user.role] || user.role}`),
      { statusCode: 403 }
    );
  }
  return user;
}
/**
 * 权限点校验（2026-11-05 组织架构）。
 * 与 ROLE_RANK 并存：旧角色仍按权限点放行，新角色按岗位授权。
 */
function requirePermission(point, label) {
  const user = sessionUser();
  if (PM.canUser(user, point)) return user;
  throw Object.assign(
    new Error(`${label || PM.PERMISSIONS[point] || '此操作'}需要相应岗位权限（当前账号：${ROLE_NAMES[user.role] || user.role}）`),
    { statusCode: 403 }
  );
}
/** 交付物编制权：按目录 owner 判定；admin 与“无归属”的自定义交付物放行 */
function assertDocEditable(code) {
  const user = sessionUser();
  const meta = DT.CATALOG.find(item => item.code === code);
  const owner = meta ? meta.owner : '';
  if (PM.canEditDoc(user.role, user.flags, owner)) return user;
  const roles = [...PM.rolesForOwner(owner)].map(role => ROLE_NAMES[role] || role).join(' / ');
  throw Object.assign(
    new Error(`该交付物归“${owner}”编制（可编制岗位：${roles || '未定义'}），当前账号无编制权限；如需代编请使用对应岗位账号或系统管理员`),
    { statusCode: 403 }
  );
}
/** 交付物审批：副总只能批准本板块 */
function assertDocApprovable(code) {
  const user = sessionUser();
  const meta = DT.CATALOG.find(item => item.code === code);
  if (PM.boardAllows(user.role, meta ? meta.owner : '')) return user;
  throw Object.assign(
    new Error(`该交付物不属于本副总分管板块，不能批准；请由对应板块副总或质量 / 总工 / 管理者代表审批`),
    { statusCode: 403 }
  );
}
// 受控审批必须由“编制/提交之外的人”执行，避免自编自批
function assertNotSelfApproval(ownerName, label = '批准') {
  const user = sessionUser();
  if (ownerName && String(ownerName).trim() && String(ownerName).trim() === String(user.display_name || '').trim()) {
    throw Object.assign(new Error(`不得${label}自己编制或提交的内容，请由其他有权限的人员执行`), { statusCode: 403 });
  }
  return user;
}
// 项目成员校验：默认兼容模式（未配置成员=全员可见）；QMS_STRICT_MEMBERS=1 时只放行成员与全局角色
const STRICT_MEMBERS = String(process.env.QMS_STRICT_MEMBERS || '') === '1';
function canAccessProject(user, projectId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (STRICT_MEMBERS && PM.canSeeAllProjects(user.role)) return true;
  const configured = q('SELECT COUNT(*) c FROM project_member WHERE project_id=?', projectId).c;
  if (!configured) return !STRICT_MEMBERS;
  return !!q('SELECT 1 FROM project_member WHERE project_id=? AND user_id=?', projectId, user.user_id);
}

/* ---------------------------------------------------------------- 路由 */
const routes = [];
// options.roles：允许调用该接口的角色白名单（缺省表示按 dispatcher 的通用规则）
const route = (method, pattern, fn, options = {}) => routes.push({ method, pattern, fn, ...options });

/**
 * 模块写守卫：写接口按模块要求对应岗位权限（读取不受限）。
 * [路径, 编辑权限点, 审批权限点]：具备任一即可通过，具体批准动作再由路由内部权限点细分。
 */
const WRITE_GUARDS = [
  [/^\/api\/(fmea|pfmea)(\/|$)/, 'fmea.edit', 'fmea.approve'],
  [/^\/api\/cp(\/|$)/, 'cp.edit', 'cp.approve'],
  [/^\/api\/(spc|monitoring)(\/|$)/, 'spc.edit', 'spc.review'],
  [/^\/api\/msa(\/|$)/, 'msa.edit', 'msa.void'],
  [/^\/api\/gauges(\/|$)/, 'msa.gauge.edit', 'msa.assess'],
  [/^\/api\/ppap(\/|$)/, 'ppap.edit', 'ppap.approve'],
  [/^\/api\/(process-dict|chars|char-links|project-chars|product-families|product-series)(\/|$)/, 'dict.edit', null],
  [/^\/api\/(pfd|steps)(\/|$)/, 'pfd.edit', null],
  [/^\/api\/ap-matrix(\/|$)/, 'apmatrix.manage', null],
  [/^\/api\/templates(\/|$)/, 'template.edit', 'template.approve'],
  [/^\/api\/ecr(\/|$)/, 'ecr.edit', 'ecr.approve'],
  [/^\/api\/baselines(\/|$)/, 'baseline.freeze', null],
  [/^\/api\/approvals(\/|$)/, 'activity.request', 'activity.approve'],
  [/^\/api\/gates(\/|$)/, 'gate.fill', 'gate.decide'],
  [/^\/api\/attachments(\/|$)/, 'doc.edit', null],
  [/^\/api\/docs(\/|$)/, 'doc.edit', 'doc.approve'],
  [/^\/api\/deliverable-links(\/|$)/, 'doc.edit', null],
  [/^\/api\/ai(\/|$)/, 'fmea.edit', null],
];
function moduleGuardAllows(user, entry) {
  const [, editPoint, approvePoint] = entry;
  if (PM.canUser(user, editPoint)) return true;
  if (approvePoint && PM.canUser(user, approvePoint)) return true;
  return false;
}

const pfdMode = value => String(value || 'PROCESS').toUpperCase() === 'INITIAL' ? 'INITIAL' : 'PROCESS';
route('GET', /^\/api\/deliverable-links$/, (m, body, query) =>
  DS.list(CUR, query.get('doc') || undefined));
route('GET', /^\/api\/deliverable-links\/relations$/, (m, body, query) =>
  DS.documentRelations(CUR, query.get('doc') || ''));
route('GET', /^\/api\/related-preview$/, (m, body, query) =>
  buildRelatedPreview(query.get('code') || '', query.get('version') || 'current'));
route('GET', /^\/api\/deliverable-links\/fields$/, (m, body, query) =>
  DS.documentMappingOptions(CUR, query.get('source'), query.get('target')));
route('POST', /^\/api\/deliverable-links\/fields$/, (m, body) => DB.tx(() => {
  const result = DS.configureFieldMapping(CUR, body);
  L.audit((requestContext.getStore() || {}).user?.display_name || '系统', '配置字段联动',
    'deliverable_field_mapping', result.mappingId, null, result.config, '手动配置交付物字段映射');
  return { ok: true, ...result, sync: syncProjectDeliverables(CUR) };
}));
route('POST', /^\/api\/deliverable-links\/sync$/, () => DB.tx(() => ({
  ok: true, sync: syncProjectDeliverables(CUR),
})));
route('POST', /^\/api\/deliverable-links\/([^/]+)\/resolve$/, (m, body) => DB.tx(() => {
  if (!['keep', 'adopt'].includes(body.action)) throw new Error('请选择保留本地或采用上游');
  const result = DS.resolve(CUR, decodePart(m[1]), body.action);
  L.audit((requestContext.getStore() || {}).user?.display_name || '系统', '处理同步差异',
    'deliverable_sync_item', decodePart(m[1]), null, body, '交付物字段联动');
  return { ...result, sync: syncProjectDeliverables(CUR) };
}));
// IDs imported from older versions may contain truncated percent-encoding.
// Keep those IDs addressable instead of letting a second decode throw URI malformed.
function decodePart(value) {
  try { return decodeURIComponent(String(value)); } catch (e) { return String(value); }
}

function idPart(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-10) || 'PROJECT';
}

function uniqueId(prefix, seed = '') {
  return `${prefix}-${idPart(seed)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}
const fmtNumber = value => Number.isFinite(+value) ? Number(+value).toFixed(2) : '—';

function recordApproval({ projectId, actionType, objectType, objectId, title, payload, approvedBy, requestedBy = '', note = '' }) {
  if (!approvedBy) throw new Error('该活动需要填写批准人');
  requestedBy = requestedBy || actorName();
  // 请求体里的批准人会被会话身份覆盖，单人操作会变成“自己批自己”；
  // 记录里统一标注为本人操作，避免审计把自动批准误读为双人审批
  approvedBy = `${approvedBy}（本人操作）`;
  const id = uniqueId('APR', projectId);
  DB.db.prepare(`INSERT INTO activity_approval(
    approval_id,project_id,action_type,object_type,object_id,title,payload_json,status,
    requested_by,requested_at,approved_by,approved_at,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, projectId, actionType, objectType || '', objectId || '', title || actionType,
    JSON.stringify(payload || {}), '已批准', requestedBy, DB.now(), approvedBy, DB.now(), note
  );
  L.audit(approvedBy, '批准', 'activity_approval', id, null,
    { actionType, objectType, objectId }, title || actionType);
  return id;
}

function recordExport({ objectType, objectId, format, fileName, buffer, baselineId = '', version = '' }) {
  const id = uniqueId('EXP', objectId);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  DB.db.prepare(`INSERT INTO export_event(
    export_id,project_id,object_type,object_id,format,baseline_id,file_name,
    file_hash,exported_by,exported_at,object_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, CUR, objectType, objectId, format, baselineId || '', fileName,
    fileHash, actorName(), DB.now(), version || null
  );
  L.audit(actorName(), '导出', objectType, objectId, null,
    { format, fileName, fileHash, baselineId, version }, '文件导出');
  return { id, fileHash };
}

// C-09：控制计划版本快照（表头 + 全部 CP 行），批准/降级时各存一份
// P-04：PFD 工序版本快照（发布 / 撤回 / 恢复前）
function snapshotStepRevision(step, note) {
  if (!step) return null;
  const revId = `PSREV-${crypto.randomUUID()}`;
  DB.db.prepare(`INSERT INTO process_step_revision(
    rev_id,project_id,step_id,step_no,ver,status,data_json,changed_by,changed_at,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    revId, step.project_id || CUR, step.step_id, step.step_no || '', step.ver || '',
    step.status || '', JSON.stringify(step), actorName(), DB.now(), note || ''
  );
  return revId;
}

function snapshotCpRevision(cpId, note = '', projectId = CUR) {
  const header = q('SELECT * FROM control_plan WHERE cp_id=? AND project_id=?', cpId, projectId);
  if (!header) return null;
  const rows = all('SELECT * FROM cp_row WHERE cp_id=? ORDER BY seq,cp_row_id', cpId);
  const revId = `CPREV-${crypto.randomUUID()}`;
  DB.db.prepare(`INSERT INTO cp_revision(
    rev_id,project_id,cp_id,rev,status,header_json,rows_json,changed_by,changed_at,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    revId, projectId, cpId, header.rev || 'r1', header.status || '',
    JSON.stringify(header), JSON.stringify(rows), actorName(), DB.now(), note
  );
  return { rev_id: revId, rev: header.rev || 'r1', status: header.status || '' };
}

function exportTable(label, cols, rows) {
  return { label, type: 'table', cols, rows };
}

function buildMsaGrrStandard({ project, study, snapshot, data, parts, operators, trials, char, gauge, result, generatedAt }) {
  const colName = index => {
    let value = index + 1;
    let name = '';
    while (value > 0) {
      const mod = (value - 1) % 26;
      name = String.fromCharCode(65 + mod) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  };
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const range = values => values.length ? Math.max(...values) - Math.min(...values) : 0;
  const matrix = Array.from({ length: operators * trials }, (_, row) =>
    Array.from({ length: parts }, (_, column) => +data?.[row]?.[column] || 0));
  const partColumns = Array.from({ length: parts }, (_, index) => colName(index + 2));
  const meanColumn = colName(parts + 2);
  const dataCells = {};
  const dataMerges = [];
  const dataHeights = {};
  const set = (ref, value, style = 6) => { dataCells[ref] = { value, style }; };
  const formula = (ref, expr, value, style = 6) => { dataCells[ref] = { formula: expr, value, style }; };

  set('A1', '量具重复性和再现性数据收集表', 1);
  dataMerges.push(`A1:${meanColumn}1`);
  set('A2', `${project.name} · ${char.name || char.char_id || ''} · ${gauge.name || gauge.gauge_id || ''} · ${parts} 件 × ${operators} 人 × ${trials} 次`, 3);
  dataMerges.push(`A2:${meanColumn}2`);
  set('A4', '评价者 / 测量次数', 2);
  dataMerges.push('A4:B4');
  set(`${partColumns[0]}4`, '零件', 2);
  dataMerges.push(`${partColumns[0]}4:${partColumns.at(-1)}4`);
  set(`${meanColumn}4`, '均值', 2);
  for (let part = 0; part < parts; part += 1) set(`${partColumns[part]}4`, `零件 ${part + 1}`, 2);
  dataHeights[4] = 30;

  const operatorMeans = [];
  const operatorRanges = [];
  const operatorMeanRows = [];
  const operatorRangeRows = [];
  let currentRow = 5;
  for (let operator = 0; operator < operators; operator += 1) {
    const label = String.fromCharCode(65 + operator);
    const trialStart = currentRow;
    const trialEnd = trialStart + trials - 1;
    if (trials > 1) dataMerges.push(`A${trialStart}:A${trialEnd}`);
    set(`A${trialStart}`, label, 8);
    for (let trial = 0; trial < trials; trial += 1) {
      const row = trialStart + trial;
      const values = matrix[operator * trials + trial];
      set(`B${row}`, trial + 1, 8);
      partColumns.forEach((column, part) => set(`${column}${row}`, values[part], 6));
      const trialMean = mean(values);
      const cellRange = `${partColumns[0]}${row}:${partColumns.at(-1)}${row}`;
      formula(`${meanColumn}${row}`, `AVERAGE(${cellRange})`, trialMean, 12);
      dataHeights[row] = 20;
    }
    const meanRow = trialEnd + 1;
    const rangeRow = meanRow + 1;
    set(`A${meanRow}`, `${label} 均值`, 5);
    set(`A${rangeRow}`, `${label} 极差`, 5);
    const partMeans = [];
    const partRanges = [];
    partColumns.forEach((column, part) => {
      const trialRange = `${column}${trialStart}:${column}${trialEnd}`;
      const values = matrix.slice(operator * trials, operator * trials + trials).map(row => row[part]);
      const partMean = mean(values);
      const partRange = range(values);
      partMeans.push(partMean);
      partRanges.push(partRange);
      formula(`${column}${meanRow}`, `AVERAGE(${trialRange})`, partMean, 12);
      formula(`${column}${rangeRow}`, `MAX(${trialRange})-MIN(${trialRange})`, partRange, 12);
    });
    const operatorMean = mean(partMeans);
    const operatorRange = mean(partRanges);
    const meanRange = `${partColumns[0]}${meanRow}:${partColumns.at(-1)}${meanRow}`;
    const rangeRange = `${partColumns[0]}${rangeRow}:${partColumns.at(-1)}${rangeRow}`;
    formula(`${meanColumn}${meanRow}`, `AVERAGE(${meanRange})`, operatorMean, 13);
    formula(`${meanColumn}${rangeRow}`, `AVERAGE(${rangeRange})`, operatorRange, 12);
    operatorMeans.push({ row: meanRow, value: operatorMean });
    operatorRanges.push({ row: rangeRow, value: operatorRange });
    operatorMeanRows.push(meanRow);
    operatorRangeRows.push(rangeRow);
    dataHeights[meanRow] = 22;
    dataHeights[rangeRow] = 22;
    currentRow = rangeRow + 1;
  }

  const partMeanRow = currentRow;
  set(`A${partMeanRow}`, '零件均值', 5);
  const overallPartMeans = [];
  partColumns.forEach((column, part) => {
    const refs = operatorMeanRows.map(row => `${column}${row}`).join(',');
    const samples = [];
    for (let operator = 0; operator < operators; operator += 1) {
      for (let trial = 0; trial < trials; trial += 1) samples.push(matrix[operator * trials + trial][part]);
    }
    const value = mean(samples);
    overallPartMeans.push(value);
    formula(`${column}${partMeanRow}`, `AVERAGE(${refs})`, value, 12);
  });
  const rp = range(overallPartMeans);
  const partMeanRange = `${partColumns[0]}${partMeanRow}:${partColumns.at(-1)}${partMeanRow}`;
  formula(`${meanColumn}${partMeanRow}`, `MAX(${partMeanRange})-MIN(${partMeanRange})`, rp, 12);

  // 模拟研究：把每条测量链的中心值（零件真实值）也写进数据收集表，便于核对“模拟→读数→报告”的链条
  let partValueRow = 0;
  let partValues = null;
  try { partValues = JSON.parse(study?.part_values_json || 'null'); } catch (e) { partValues = null; }
  if (Array.isArray(partValues) && partValues.length === parts) {
    partValueRow = partMeanRow + 1;
    set(`A${partValueRow}`, '零件真实值（模拟）', 5);
    partColumns.forEach((column, part) => set(`${column}${partValueRow}`, +partValues[part] || 0, 12));
    const simulatedRange = Math.max(...partValues.map(Number)) - Math.min(...partValues.map(Number));
    set(`${meanColumn}${partValueRow}`, simulatedRange, 12);
    dataHeights[partValueRow] = 22;
  }

  const rbarRow = (partValueRow || partMeanRow) + 1;
  const xdiffRow = rbarRow + 1;
  const uclrRow = xdiffRow + 1;
  set(`A${rbarRow}`, '评价者平均极差 R̄', 5);
  const operatorRangeRefs = operatorRanges.map(item => `${meanColumn}${item.row}`).join(',');
  const rbar = mean(operatorRanges.map(item => item.value));
  formula(`${meanColumn}${rbarRow}`, `AVERAGE(${operatorRangeRefs})`, rbar, 13);
  dataMerges.push(`A${rbarRow}:${partColumns.at(-1)}${rbarRow}`);

  set(`A${xdiffRow}`, '评价者均值差 X̄DIFF', 5);
  const operatorMeanRefs = operatorMeans.map(item => `${meanColumn}${item.row}`).join(',');
  const xdiff = Math.max(...operatorMeans.map(item => item.value)) - Math.min(...operatorMeans.map(item => item.value));
  formula(`${meanColumn}${xdiffRow}`, `MAX(${operatorMeanRefs})-MIN(${operatorMeanRefs})`, xdiff, 13);
  dataMerges.push(`A${xdiffRow}:${partColumns.at(-1)}${xdiffRow}`);

  const d4 = { 2: 3.27, 3: 2.58, 4: 2.28, 5: 2.11 }[trials] || 2.58;
  set(`A${uclrRow}`, '极差图控制上限 UCLR', 5);
  formula(`${meanColumn}${uclrRow}`, `${meanColumn}${rbarRow}*${d4}`, rbar * d4, 13);
  dataMerges.push(`A${uclrRow}:${partColumns.at(-1)}${uclrRow}`);

  const dataNoteRow = uclrRow + 2;
  set(`A${dataNoteRow}`, `注：2 次测量时 D4=3.27，3 次测量时 D4=2.58。当前研究为 ${trials} 次测量。`, 7);
  dataMerges.push(`A${dataNoteRow}:${meanColumn}${dataNoteRow}`);
  set(`A${dataNoteRow + 1}`, '注：____________________________________________________________', 7);
  dataMerges.push(`A${dataNoteRow + 1}:${meanColumn}${dataNoteRow + 1}`);
  dataHeights[dataNoteRow] = 36;
  dataHeights[dataNoteRow + 1] = 30;

  const k1 = { 2: 0.8862, 3: 0.5908, 4: 0.4857, 5: 0.4030 }[trials] || 0.5908;
  const k2 = { 2: 0.7071, 3: 0.5231, 4: 0.4467 }[operators] || 0.5231;
  const k3 = { 2: 0.7071, 3: 0.5231, 4: 0.4467, 5: 0.4030, 6: 0.3742, 7: 0.3534, 8: 0.3375, 9: 0.3249, 10: 0.3146 }[parts] || 0.3146;
  const reportCells = {};
  const reportMerges = [];
  const reportHeights = {};
  const rset = (ref, value, style = 6) => { reportCells[ref] = { value, style }; };
  const rformula = (ref, expr, value, style = 6) => { reportCells[ref] = { formula: expr, value, style }; };
  rset('A1', '量具重复性和再现性报告', 1);
  reportMerges.push('A1:F1');
  rset('A2', `AIAG MSA 均值-极差法 · ${char.name || char.char_id || ''} · ${gauge.name || gauge.gauge_id || ''}`, 3);
  reportMerges.push('A2:F2');
  const headerRows = [
    ['零件编号和名称', `${project.part_no || ''} / ${project.name || ''}`, '量具名称', gauge.name || '', '日期', study?.studied_at || generatedAt.slice(0, 10)],
    ['特性', char.name || char.char_id || '', '量具编号', gauge.gauge_id || '', '操作人员', study?.operator || ''],
    ['规范', snapshot?.char_tol_text_snapshot || char.tol_text || (char.lsl != null && char.usl != null ? `${char.lsl} ~ ${char.usl}` : ''),
      '量具型式', [gauge.model, gauge.range_text].filter(Boolean).join(' / '), '判定',
      result?.judgment ? `${result.judgment}${result.pctTol != null ? `（%Tol ${result.pctTol}%）` : ''}` : ''],
  ];
  headerRows.forEach((row, index) => {
    const rowNumber = index + 4;
    row.forEach((value, column) => rset(`${colName(column)}${rowNumber}`, value, column % 2 === 0 ? 5 : 6));
    reportHeights[rowNumber] = 28;
  });

  rset('A8', '测量单元分析', 4);
  reportMerges.push('A8:C8');
  rset('D8', '总变差百分比', 4);
  reportMerges.push('D8:F8');

  const evCell = 'B9'; const avCell = 'B10'; const grrCell = 'B11'; const pvCell = 'B12'; const tvCell = 'B13';
  const dataRef = ref => `'GRR数据收集表'!${ref}`;
  rset('A9', '重复性 - 设备变差 EV', 5);
  rformula(evCell, `IFERROR(${dataRef(`${meanColumn}${rbarRow}`)}*${k1},0)`, result?.EV || 0, 11);
  rset('C9', `K1 = ${k1}`, 6);
  rset('D9', '%EV', 5);
  rformula('E9', `IFERROR(100*${evCell}/${tvCell},0)`, result?.pctEV || 0, 10);
  reportMerges.push('E9:F9');

  rset('A10', '再现性 - 评价者变差 AV', 5);
  rformula(avCell,
    `IFERROR(SQRT(MAX(0,(${dataRef(`${meanColumn}${xdiffRow}`)}*${k2})^2-(${evCell}^2/(${parts}*${trials})))),0)`,
    result?.AV || 0, 11);
  rset('C10', `K2 = ${k2}`, 6);
  rset('D10', '%AV', 5);
  rformula('E10', `IFERROR(100*${avCell}/${tvCell},0)`, result?.pctAV || 0, 10);
  reportMerges.push('E10:F10');

  rset('A11', '重复性和再现性 GRR', 5);
  rformula(grrCell, `IFERROR(SQRT(${evCell}^2+${avCell}^2),0)`, result?.GRR || 0, 11);
  rset('C11', 'GRR', 6);
  rset('D11', '%GRR', 5);
  rformula('E11', `IFERROR(100*${grrCell}/${tvCell},0)`, result?.pctGRR || 0, 10);
  reportMerges.push('E11:F11');

  rset('A12', '零件变差 PV', 5);
  rformula(pvCell, `IFERROR(${dataRef(`${meanColumn}${partMeanRow}`)}*${k3},0)`, result?.PV || 0, 11);
  rset('C12', `K3 = ${k3}`, 6);
  rset('D12', '%PV', 5);
  rformula('E12', `IFERROR(100*${pvCell}/${tvCell},0)`, result?.TV ? +(result.PV / result.TV * 100).toFixed(4) : 0, 10);
  reportMerges.push('E12:F12');

  rset('A13', '总变差 TV', 5);
  rformula(tvCell, `IFERROR(SQRT(${grrCell}^2+${pvCell}^2),0)`, result?.TV || 0, 11);
  rset('C13', 'ndc', 6);
  rset('D13', '可区分类别数', 5);
  // 与判定口径一致：ndc 取整数（向下取整），不显示 13.98 这类原始比值
  rformula('E13', `IFERROR(INT(1.41*${pvCell}/${grrCell}),0)`, result?.ndc ?? 0, 6);
  reportMerges.push('E13:F13');

  rset('A15', '注：本表采用 AIAG MSA 均值-极差法。评价者、零件和试验次数来自系统原始研究数据；公式已保留，可在 Excel 中复核。', 7);
  reportMerges.push('A15:F15');
  reportHeights[15] = 38;
  dataHeights[1] = 32;
  dataHeights[2] = 26;
  dataHeights[4] = 30;
  dataHeights[dataNoteRow] = 34;
  dataHeights[dataNoteRow + 1] = 28;
  reportHeights[1] = 32;
  reportHeights[2] = 22;
  for (let row = 4; row <= 6; row += 1) reportHeights[row] = 26;
  reportHeights[8] = 24;
  for (let row = 9; row <= 13; row += 1) reportHeights[row] = 32;

  const show = (value, digits = 4) => value == null || value === ''
    ? '—'
    : Number(value).toFixed(digits).replace(/\.?0+$/, '');
  const pctText = value => value == null || value === '' ? '—' : `${show(value, 2)}%`;
  const ndcRaw = result?.GRR ? 1.41 * result.PV / result.GRR : 0;
  return {
    kind: 'msa-grr',
    title: `MSA GRR 报告 · ${char.name || char.char_id || ''}`,
    author: study?.operator || '',
    docxSections: [
      {
        t: '一、研究概况',
        note: '依据 AIAG MSA 均值-极差法，对当前项目的测量系统重复性和再现性进行研究。',
        fields: [{
          label: '研究对象与测量系统',
          type: 'table',
          cols: ['项目', '内容'],
          rows: [
            ['项目 / 零件号', `${project.name || ''} / ${project.part_no || ''}`],
            ['特性', char.name || char.char_id || ''],
            ['规范', snapshot?.char_tol_text_snapshot || char.tol_text || ''],
            ['量具名称 / 编号', `${gauge.name || ''} / ${gauge.gauge_id || ''}`],
            ['量具型号 / 分辨力', `${gauge.model || '—'} / ${gauge.resolution ?? '—'}`],
            ['研究日期 / 操作人员', `${study?.studied_at || generatedAt.slice(0, 10)} / ${study?.operator || '—'}`],
            ['研究设计', `${parts} 个零件 × ${operators} 名评价者 × ${trials} 次试验`],
            ['零件真实值（模拟）', Array.isArray(partValues) && partValues.length === parts
              ? partValues.map(value => show(value, 4)).join(' / ')
              : '该研究未记录模拟零件真实值（手工录入或外部数据）'],
          ],
        }],
      },
      {
        t: '二、评价者统计摘要',
        fields: [{
          label: '评价者均值与平均极差',
          type: 'table',
          cols: ['评价者', '零件均值总平均 X̄', '平均极差 R̄'],
          rows: operatorMeans.map((item, index) => [
            `评价者 ${String.fromCharCode(65 + index)}`,
            show(item.value, 4),
            show(operatorRanges[index]?.value, 3),
          ]).concat([['总体', show(mean(operatorMeans.map(item => item.value)), 4), show(rbar, 3)]]),
        }],
      },
      {
        t: '三、测量系统分析结果',
        fields: [
          { label: 'R̄ / X̄DIFF / R_p', value: `${show(rbar, 4)} / ${show(xdiff, 4)} / ${show(rp, 3)}` },
          {
            label: '测量单元分析',
            type: 'table',
            cols: ['指标', '说明', '结果', '百分比'],
            rows: [
              ['EV', `R̄ × K1（K1=${k1}）`, show(result?.EV, 5), pctText(result?.pctEV)],
              ['AV', `X̄DIFF × K2（K2=${k2}），扣除 EV²/(nr)`, show(result?.AV, 5), pctText(result?.pctAV)],
              ['GRR', '√(EV² + AV²)', show(result?.GRR, 5), pctText(result?.pctGRR)],
              ['PV', `R_p × K3（K3=${k3}）`, show(result?.PV, 5), result?.TV ? pctText(result.PV / result.TV * 100) : '—'],
              ['TV', '√(GRR² + PV²)', show(result?.TV, 5), '—'],
              ['ndc', '1.41 × PV / GRR', show(ndcRaw, 3) + (result?.ndc != null ? ` ≈ ${result.ndc}` : ''), ''],
            ],
          },
        ],
      },
      {
        t: '四、结论',
        fields: [
          { label: '测量系统判定', value: result?.judgment || '待确认' },
          { label: '%GRR', value: pctText(result?.pctGRR) },
          { label: '%Tol', value: pctText(study?.pct_tol ?? result?.pctTol) },
          { label: '可区分类别数 ndc', value: result?.ndc == null ? '—' : `${show(ndcRaw, 3)} ≈ ${result.ndc}` },
          { label: '结论说明', value: result?.judgment === '接受'
            ? '测量系统满足当前研究目标，可用于本项目该特性的测量。'
            : '测量系统需结合特性重要度、客户要求和实际测量风险进一步评审。' },
        ],
      },
    ],
    sheets: [
      {
        name: 'GRR数据收集表', widths: [14, 8, ...Array(parts).fill(9), 10],
        cells: dataCells, merges: dataMerges, heights: dataHeights,
        freeze: { xSplit: 2, ySplit: 4, topLeftCell: 'C5' },
        page: { paperSize: 9, orientation: 'portrait', fitToHeight: 1, left: 0.2, right: 0.2, top: 0.3, bottom: 0.3 },
      },
      {
        name: 'GRR报告', widths: [18, 14, 15, 14, 12, 16],
        cells: reportCells, merges: reportMerges, heights: reportHeights,
        page: { paperSize: 9, orientation: 'portrait', fitToHeight: 1, left: 0.25, right: 0.25, top: 0.35, bottom: 0.35 },
      },
    ],
  };
}

function buildQualityToolExport(tool, query) {
  const project = q('SELECT * FROM project WHERE project_id=?', CUR);
  if (!project) throw new Error('当前项目不存在');
  const generatedAt = DB.now();
  const base = {
    code: String(tool).toUpperCase(),
    title: '',
    subtitle: `${project.name} · ${project.part_no || project.project_id}`,
    author: project.owner || '',
    version: 'V1.0',
    generatedAt,
    sections: [],
    // D-08：声明这份导出对应哪个受控对象、是否已批准，导出记录与文件抬头都以此为准
    control: { controlled: false, status: '未识别', version: '', objectType: 'quality_tool', objectId: tool },
  };

  if (tool === 'fmea') {
    const type = String(query.get('type') || 'DFMEA').toUpperCase();
    const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
    if (!header) throw new Error(`未找到 ${type}`);
    const nodes = all(`SELECT * FROM fmea_node WHERE fmea_id=? AND COALESCE(status,'生效')<>'作废'
      ORDER BY node_type, seq`, header.fmea_id);
    const nodeName = new Map(nodes.map(node => [node.node_id, node.name]));
    const functions = all(`SELECT f.* FROM fmea_function f JOIN fmea_node n ON n.node_id=f.node_id
      WHERE n.fmea_id=? AND COALESCE(n.status,'生效')<>'作废'
      ORDER BY f.node_id, f.seq`, header.fmea_id);
    const rows = all(`SELECT r.*, nf.name fe_name, nm.name fm_name, nc.name fc_name,
        c.name char_name, c.special_symbol char_special_symbol, c.is_special char_is_special,
        pc.name process_char_name, s.step_no, s.name step_name, d.decision, d.status decision_status,
        (SELECT COUNT(*) FROM fmea_action a WHERE a.row_id=r.row_id) actions,
        (SELECT description FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_desc,
        (SELECT owner FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_owner,
        (SELECT due_date FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_due,
        (SELECT status FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_status,
        (SELECT completed_at FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_completed,
        (SELECT s_after FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_s_after,
        (SELECT o_after FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_o_after,
        (SELECT d_after FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_d_after,
        (SELECT ap_after FROM fmea_action a WHERE a.row_id=r.row_id ORDER BY action_id LIMIT 1) action_ap_after
      FROM fmea_row r
      LEFT JOIN fmea_node nf ON nf.node_id=r.fe_id
      LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
      LEFT JOIN fmea_node nc ON nc.node_id=r.fc_id
      LEFT JOIN char_master c ON c.char_id=r.char_id
      LEFT JOIN char_master pc ON pc.char_id=r.process_char_id
      LEFT JOIN process_step s ON s.step_id=r.step_id
      LEFT JOIN fmea_decision d ON d.row_id=r.row_id
      WHERE r.fmea_id=? ORDER BY r.seq`, header.fmea_id);
    base.code = `FMEA-${type}`;
    base.title = `${type} 失效模式与影响分析`;
    base.subtitle += ` · ${type} · ${header.rev || 'V1.0'}`;
    base.author = header.approved_by || project.owner || '';
    base.version = header.rev || 'V1.0';
    base.control = {
      controlled: header.status === '已发布',
      status: header.status || '草稿',
      version: header.rev || 'V1.0',
      objectType: 'fmea_header', objectId: header.fmea_id,
    };
    base.sections = [
      { t: '文件信息', fields: [
        { label: '项目', value: project.name },
        { label: '零件号', value: project.part_no || '' },
        { label: 'FMEA 类型', value: type },
        { label: '状态', value: header.status || '' },
        { label: '版本', value: header.rev || '' },
        { label: '批准人', value: header.approved_by || '' },
        { label: 'AP 矩阵', value: header.ap_ver || '' },
      ] },
      { t: '结构', fields: [exportTable('结构节点', ['名称', '类型', '子类型', '父节点', '说明'], nodes.map(node => [
        node.name || '', node.node_type || '', node.node_subtype || '',
        nodeName.get(node.parent_id) || '', node.desc || '',
      ]))] },
      { t: '功能', fields: [exportTable('功能清单', ['结构节点', '状态', '功能描述', '来源'], functions.map(fn => [
        nodeName.get(fn.node_id) || '', fn.status || '', fn.text || '', fn.source || '',
      ]))] },
      { t: '失效分析', fields: [exportTable('失效分析行',
        ['#', '结构节点', '功能', '失效影响', '失效模式', '失效原因', 'S', 'O', 'D', 'AP', '产品特性', '过程特性', '决定'],
        rows.map((row, index) => [
          index + 1, nodeName.get(row.focus_node_id) || '',
          functions.find(fn => fn.func_id === row.func_id)?.text || '',
          row.fe_name || '', row.fm_name || '', row.fc_name || '',
          row.s ?? '', row.o ?? '', row.d ?? '', row.ap || '',
          row.char_name || '', row.process_char_name || '', row.decision || row.decision_status || '',
        ]))] },
      { t: '现行控制与措施', fields: [exportTable('控制与措施', ['#', '预防控制', '探测控制', '措施数量'], rows.map((row, index) => [
        index + 1, row.pc_text || '', row.dc_text || '', row.actions || 0,
      ]))] },
    ];
    const nodeById = new Map(nodes.map(node => [node.node_id, node]));
    const functionById = new Map(functions.map(fn => [fn.func_id, fn]));
    const formRows = rows.map((row, index) => {
      const focus = nodeById.get(row.focus_node_id);
      const parent = nodeById.get(focus?.parent_id);
      const fn = functionById.get(row.func_id);
      const common = {
        seq: index + 1, char: row.char_id || '',
        special: row.char_is_special ? (row.char_special_symbol || '是') : '否',
        focus: focus?.name || '', fn: fn?.text || '',
        fe: row.fe_name || '', s: row.s ?? '', fm: row.fm_name || '', fc: row.fc_name || '',
        pc: row.pc_text || '', o: row.o ?? '', dc: row.dc_text || '', d: row.d ?? '', ap: row.ap || '',
        action: row.action_desc || '', owner: row.action_owner || '', due: row.action_due || '',
        status: row.action_status || row.decision_status || '', completed: row.action_completed || '',
        sAfter: row.action_s_after ?? '', oAfter: row.action_o_after ?? '',
        dAfter: row.action_d_after ?? '', apAfter: row.action_ap_after || '',
        note: row.decision || '',
      };
      if (type === 'PFMEA') {
        return [
          common.seq, row.step_no || '', row.step_name || '', common.focus, '',
          '', common.fn, '',
          common.fe, common.special, common.fm, common.fc,
          common.s, common.pc, common.o, common.dc, common.d, common.ap,
          common.action, common.owner, common.due, common.status, '', common.completed,
          common.sAfter, common.oAfter, common.dAfter, common.apAfter, common.note,
        ];
      }
      return [
        common.seq, parent?.name || '', common.focus, '',
        '', common.fn, '',
        common.fe, common.special, common.fm, common.fc,
        common.s, common.pc, common.o, common.dc, common.d, common.ap,
        common.action, common.owner, common.due, common.status, '', common.completed,
        common.sAfter, common.oAfter, common.dAfter, common.apAfter, common.note,
      ];
    });
    const dataRows = rows.map((row, index) => type === 'PFMEA' ? [
      index + 1, row.row_id, header.fmea_id, row.step_id || '', row.step_no || '', row.char_id || '',
      row.fe_id || '', row.fm_id || '', row.fc_id || '', row.s ?? '', row.o ?? '', row.d ?? '', row.ap || '',
      row.pc_text || '', row.dc_text || '', row.char_special_symbol || '', row.upstream_row_id || '',
      row.action_s_after ?? '', row.action_o_after ?? '', row.action_d_after ?? '', row.action_ap_after || '',
      row.action_status || row.decision_status || '', row.action_owner || '',
    ] : [
      index + 1, row.row_id, header.fmea_id, row.focus_node_id || '', row.char_id || '',
      row.fe_id || '', row.fm_id || '', row.fc_id || '', row.s ?? '', row.o ?? '', row.d ?? '', row.ap || '',
      row.pc_text || '', row.dc_text || '', row.step_id || '', row.effect_ref || '',
      row.char_special_symbol || '', row.action_s_after ?? '', row.action_o_after ?? '',
      row.action_d_after ?? '', row.action_ap_after || '',
      row.action_status || row.decision_status || '', row.action_owner || '',
    ]);
    const optimizationColumns = [
      '建议措施', '责任人', '目标完成日期', '状态', '已采取措施', '完成日期',
      '措施后S', '措施后O', '措施后D', '措施后AP',
    ];
    const fmeaColumns = type === 'PFMEA' ? [
      '序号', '工序号',
      '过程项', '过程步骤', '过程工作要素（4M）', '',
      '过程项功能', '过程步骤功能', '工作要素功能',
      '失效影响（FE）', '特殊特性', '失效模式（FM）', '失效原因（FC）',
      '严重度S', '现行预防控制（PC）', '频度O', '现行探测控制（DC）', '探测度D', '行动优先级AP',
      ...optimizationColumns, '备注',
    ] : [
      '序号',
      '上一较高级别要素', '焦点要素', '下一较低级别要素',
      '上一较高级别功能', '焦点功能', '下一较低级别功能',
      '失效影响（FE）', '特殊特性', '失效模式（FM）', '失效原因（FC）',
      '严重度S', '现行预防控制（PC）', '频度O', '现行探测控制（DC）', '探测度D', '行动优先级AP',
      ...optimizationColumns, '备注',
    ];
    const fmeaGroups = type === 'PFMEA' ? [
      { label: '序号', span: 1 }, { label: '结构分析', span: 4 }, { label: '功能分析', span: 3 },
      { label: '失效分析', span: 4 }, { label: '风险分析', span: 6 },
      { label: '优化', span: 10 }, { label: '备注', span: 1 },
    ] : [
      { label: '序号', span: 1 }, { label: '结构分析', span: 3 }, { label: '功能分析', span: 3 },
      { label: '失效分析', span: 4 }, { label: '风险分析', span: 6 },
      { label: '优化', span: 10 }, { label: '备注', span: 1 },
    ];
    const fmeaWidths = type === 'PFMEA'
      ? [5, 8, 16, 16, 16, 18, 18, 18, 22, 8, 20, 22, 7, 24, 7, 24, 7, 8, 26, 10, 12, 11, 24, 12, 7, 7, 7, 9, 10]
      : [5, 18, 18, 18, 18, 18, 18, 22, 8, 20, 22, 7, 24, 7, 24, 7, 8, 26, 10, 12, 11, 24, 12, 7, 7, 7, 9, 10];
    base.standardWorkbook = {
      sheetName: `${type}（AIAG-VDA 2019）`,
      title: `${type} 失效模式与影响分析`,
      subtitle: `${project.name} · ${project.part_no || ''} · ${header.rev || 'V1.0'}`,
      code: `FMEA-${type}`,
      version: header.rev || 'V1.0',
      generatedAt,
      author: header.approved_by || project.owner || '',
      projectName: project.name,
      source: 'AIAG & VDA FMEA Handbook, 1st Edition (2019)',
      sourceNotes: [
        '结构按七步法动态生成：规划与准备、结构分析、功能分析、失效分析、风险分析、优化、结果文件化。',
        '风险分析采用 S / O / D 与 Action Priority（AP），不使用 RPN。',
        '公开核对来源：AIAG FMEAAV-1 手册页、Quality-One AIAG & VDA FMEA 七步法说明、公开 MIT 许可 FMEA 七步法参考。',
        '本文件由系统业务数据生成，不复制任何第三方模板文件。',
      ],
      metaRows: [
        [{ label: '公司', value: project.company || project.organization || '' },
          { label: '工厂', value: project.plant || '' }, { label: '顾客', value: project.customer || '' }],
        [{ label: '项目', value: project.name },
          { label: '零件号', value: project.part_no || '' }, { label: '项目阶段', value: project.phase || '' }],
        [{ label: 'FMEA编号', value: header.fmea_id || '' },
          { label: '开始 / 修订日期', value: `${header.created_at || ''} / ${header.published_at || generatedAt}` },
          { label: '版本', value: header.rev || 'V1.0' }],
        [{ label: '跨职能团队', value: project.team || '' },
          { label: '分析类型', value: type }, { label: '批准人', value: header.approved_by || '' }],
      ],
      groups: fmeaGroups,
      columns: fmeaColumns,
      widths: fmeaWidths,
      centerCols: type === 'PFMEA'
        ? [0, 1, 9, 12, 14, 16, 17, 21, 24, 25, 26, 27]
        : [0, 8, 11, 13, 15, 16, 20, 23, 24, 25, 26],
      rows: formRows,
      notes: [
        '一行只对应一个失效原因；同一失效模式存在多个原因时应拆分为多行。',
        '失效链方向为 FE → FM → FC；S 属于失效影响，O 与预防控制相关，D 与探测控制相关。',
      ],
    };
  } else if (tool === 'cp') {
    const plans = all(`SELECT * FROM control_plan WHERE project_id=?
      ORDER BY CASE stage WHEN 'PROTO' THEN 1 WHEN 'PILOT' THEN 2 WHEN 'SOP' THEN 3 ELSE 9 END`, CUR);
    if (!plans.length) throw new Error('当前项目还没有控制计划');
    const stage = String(query.get('stage') || '').toUpperCase();
    const plan = plans.find(item => item.stage === stage) || plans[0];
    const stageName = { PROTO: '样件', PILOT: '试生产', SOP: '量产' }[plan.stage] || plan.stage;
    const rows = all(`SELECT c.*, s.step_no, s.name step_name, s.equipment,
        COALESCE(pc.name,cm.name) char_name, COALESCE(pc.char_kind,cm.char_kind) char_kind,
        COALESCE(pc.is_special,cm.is_special) is_special,
        COALESCE(pc.special_symbol,cm.special_symbol) special_symbol, g.name gauge_name
      FROM cp_row c
      LEFT JOIN process_step s ON s.step_id=c.step_id
      LEFT JOIN project_char pc ON pc.pchar_id=c.project_char_id
      LEFT JOIN char_master cm ON cm.char_id=c.char_id
      LEFT JOIN gauge g ON g.gauge_id=c.gauge_id
      WHERE c.cp_id=? AND COALESCE(c.status,'启用')='启用'
      ORDER BY COALESCE(s.step_no,'zzz'), c.seq`, plan.cp_id);
    base.code = `CP-${plan.stage}`;
    base.title = `${stageName}控制计划`;
    base.subtitle += ` · ${stageName} · ${plan.rev || 'V1.0'}`;
    base.author = plan.approved_by || plan.prepared_by || project.owner || '';
    base.version = plan.rev || 'V1.0';
    base.control = {
      controlled: ['已批准', '已冻结'].includes(plan.status),
      status: plan.status || '草稿',
      version: plan.rev || 'V1.0',
      objectType: 'control_plan', objectId: plan.cp_id,
    };
    base.sections = [
      { t: '文件信息', fields: [
        { label: '项目', value: project.name },
        { label: '零件号', value: plan.part_no || project.part_no || '' },
        { label: '阶段', value: stageName },
        { label: '版本', value: plan.rev || '' },
        { label: '状态', value: plan.status || '' },
        { label: '编制人', value: plan.prepared_by || '' },
        { label: '批准人', value: plan.approved_by || '' },
        { label: '生效日期', value: plan.effective_date || '' },
      ] },
      { t: '控制计划', fields: [exportTable('控制计划明细',
        ['#', '工序', '特性编号', '特性名称', '特殊特性', '规范/公差', '测量技术', '样本', '频率', '控制方法', '反应计划', '检具', 'SPC'],
        rows.map((row, index) => [
          row.seq || index + 1, `${row.step_no || ''} ${row.step_name || ''}`.trim(), row.char_id || '',
          row.char_name || '', row.is_special ? (row.special_symbol || '是') : '否', row.spec_text || '',
          row.measure_tech || '', row.sample_size ?? '', row.freq_value == null ? '' : `${row.freq_value} ${row.freq_unit || ''}`,
          row.control_method || '', row.reaction_plan || '', row.gauge_id ? `${row.gauge_id} ${row.gauge_name || ''}`.trim() : '',
          row.is_spc ? '是' : '否',
        ]))] },
    ];
    const formRows = rows.map((row, index) => [
      row.step_no || row.seq || index + 1,
      row.step_name || '',
      row.equipment || '',
      row.char_id || '',
      row.char_kind === 'PRODUCT' ? (row.char_name || '') : '',
      row.char_kind === 'PROCESS' ? (row.char_name || '') : '',
      row.is_special ? (row.special_symbol || '是') : '—',
      row.spec_text || '',
      [row.measure_tech || '', row.gauge_id ? `检具 ${row.gauge_id} ${row.gauge_name || ''}`.trim() : '']
        .filter(Boolean).join('；'),
      row.sample_size ?? '',
      [row.freq_value, row.freq_unit, row.freq_trigger].filter(value => value !== '' && value != null).join(' '),
      row.control_method || '',
      row.reaction_plan || '',
    ]);
    base.standardWorkbook = {
      sheetName: '控制计划',
      title: `${stageName}控制计划`,
      subtitle: `${project.name} · ${plan.part_no || project.part_no || ''} · ${plan.rev || 'V1.0'}`,
      code: `CP-${plan.stage}`,
      version: plan.rev || 'V1.0',
      generatedAt,
      author: plan.approved_by || plan.prepared_by || project.owner || '',
      projectName: project.name,
      source: 'AIAG APQP Control Plan 1st Edition / AIAG-VDA reference structure',
      sourceNotes: [
        '控制计划主体使用 13 列标准结构：过程编号、过程名称、设备工装、特性编号、产品特性、过程特性、特殊特性、规范公差、测量技术、样本容量、频率、控制方法、反应计划。',
        'PFMEA 的预防控制、探测控制、特殊特性和 AP 结果作为控制计划编制输入；最终控制方法、抽样和反应计划由责任人确认。',
        '公开核对来源：AIAG CP-1 手册页、公开 MIT 许可 Control Plan 模板参考。',
        '本文件由系统业务数据生成，不复制任何第三方模板文件。',
      ],
      metaRows: [
        [{ label: '控制计划编号', value: plan.cp_id || '' },
          { label: '阶段', value: stageName }, { label: '日期（原始 / 修订）', value: plan.effective_date || generatedAt.slice(0, 10) }],
        [{ label: '零件号 / 最新更改等级', value: `${plan.part_no || project.part_no || ''} / ${plan.rev || ''}` },
          { label: '零件名称', value: plan.part_name || project.name }, { label: '核心团队', value: project.team || '' }],
        [{ label: '供应商 / 工厂', value: plan.plant || project.plant || '' },
          { label: '供应商代码', value: project.supplier_code || '' }, { label: '主要联系人 / 电话', value: plan.prepared_by || project.owner || '' }],
        [{ label: '组织批准 / 日期', value: `${plan.approved_by || ''} / ${plan.effective_date || ''}` },
          { label: '顾客工程批准 / 日期', value: plan.customer_approved_by || '' },
          { label: '顾客质量批准 / 日期', value: plan.customer_quality_approved_by || '' }],
      ],
      groups: [
        { label: '零件 / 过程', span: 3 },
        { label: '产品与过程特性', span: 5 },
        { label: '控制方法', span: 5 },
      ],
      columns: [
        '零件 / 过程编号', '过程名称 / 操作描述', '机器 / 装置 / 夹具 / 工装',
        '特性编号', '产品特性', '过程特性', '特殊特性分类',
        '产品 / 过程规范与公差', '评价 / 测量技术',
        '样本容量', '样本频率', '控制方法', '反应计划',
      ],
      widths: [10, 22, 20, 10, 18, 18, 10, 22, 22, 9, 12, 28, 40],
      page: { paperSize: 9, orientation: 'landscape', fitToHeight: 1 },
      centerCols: [0, 3, 6, 9, 10],
      rows: formRows,
      notes: [
        '样本频率由频率值和单位合并显示；现场执行时仍应按 PFMEA、作业指导书及客户要求确认。',
        '安全 / 法规特殊特性不得使用无依据的抽样方案；反应计划必须明确隔离、停线、追溯和复产条件。',
      ],
    };
    base.page = { orientation: 'landscape' };
    base.docxSections = [
      { t: '文件信息', fields: [
        { label: '项目 / 零件号', value: `${project.name} / ${plan.part_no || project.part_no || ''}` },
        { label: '阶段 / 版本', value: `${stageName} / ${plan.rev || 'V1.0'}` },
        { label: '状态', value: plan.status || '' },
        { label: '编制 / 批准', value: `${plan.prepared_by || ''} / ${plan.approved_by || ''}` },
        { label: '生效日期', value: plan.effective_date || '' },
      ] },
      { t: '控制计划', fields: [{
        label: '13 列控制计划明细',
        type: 'table',
        cols: ['零件/过程编号', '过程名称/操作描述', '机器/装置/夹具/工装', '特性编号', '产品特性',
          '过程特性', '特殊特性', '规范/公差', '测量技术', '样本容量', '频率', '控制方法', '反应计划'],
        rows: formRows,
      }] },
    ];
  } else if (tool === 'spc') {
    const monId = String(query.get('mon_id') || '');
    const mon = (monId
      ? q(`SELECT m.*, r.cp_row_id, r.step_id, s.step_no, s.name step_name,
          COALESCE(pc.name,cm.name) char_name, COALESCE(pc.unit,cm.unit) unit,
          COALESCE(pc.target,cm.target) target, COALESCE(pc.lsl,cm.lsl) lsl,
          COALESCE(pc.usl,cm.usl) usl, COALESCE(pc.tol_text,cm.tol_text) tol_text
        FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
        JOIN control_plan cp ON cp.cp_id=r.cp_id
        LEFT JOIN process_step s ON s.step_id=r.step_id
        LEFT JOIN project_char pc ON pc.pchar_id=m.project_char_id
        LEFT JOIN char_master cm ON cm.char_id=m.char_id
        WHERE m.mon_id=? AND cp.project_id=?`, monId, CUR)
      : q(`SELECT m.*, r.cp_row_id, r.step_id, s.step_no, s.name step_name,
          COALESCE(pc.name,cm.name) char_name, COALESCE(pc.unit,cm.unit) unit,
          COALESCE(pc.target,cm.target) target, COALESCE(pc.lsl,cm.lsl) lsl,
          COALESCE(pc.usl,cm.usl) usl, COALESCE(pc.tol_text,cm.tol_text) tol_text
        FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
        JOIN control_plan cp ON cp.cp_id=r.cp_id
        LEFT JOIN process_step s ON s.step_id=r.step_id
        LEFT JOIN project_char pc ON pc.pchar_id=m.project_char_id
        LEFT JOIN char_master cm ON cm.char_id=m.char_id
        WHERE cp.project_id=? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`, CUR));
    if (!mon) throw new Error('当前项目还没有 SPC 监控项');
    const datasets = all('SELECT * FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC', mon.mon_id);
    const datasetId = +query.get('dataset_id') || datasets[0]?.dataset_id || 0;
    const dataset = datasets.find(item => item.dataset_id === datasetId) || datasets[0] || null;
    const requestedChart = String(query.get('chart') || mon.chart_type || 'Xbar-R');
    let subgroups = [];
    let stat = null;
    if (dataset) {
      try {
        subgroups = JSON.parse(dataset.data_json || '[]');
        const options = spcChartOptions(subgroups, mon, { lsl: mon.lsl, usl: mon.usl });
        stat = options[requestedChart] || options[mon.chart_type] || Object.values(options)[0] || null;
      } catch (e) { subgroups = []; }
    }
    const width = Math.max(0, ...subgroups.map(item => Array.isArray(item.v) ? item.v.length : 0));
    const secondaryName = String(requestedChart).toUpperCase() === 'I-MR'
      ? '移动极差 MR'
      : String(requestedChart).toUpperCase() === 'XBAR-S' ? '标准差 S' : '极差 R';
    const subgroupCols = ['序号', ...Array.from({ length: width }, (_, index) => `测量值 ${index + 1}`), '均值', secondaryName];
    // SPC 导出与页面同口径：原始值/均值/极差都按显示精度收敛，避免 15 位浮点尾差进入 Word/Excel
    const subgroupRows = subgroups.map((item, index) => {
      const values = (item.v || []).map(Number);
      const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : '';
      const computedRange = values.length ? Math.max(...values) - Math.min(...values) : '';
      const secondary = stat?.range
        ? (String(requestedChart).toUpperCase() === 'I-MR' ? stat.range[index - 1] : stat.range[index])
        : computedRange;
      return [index + 1, ...values.map(value => L.displayNumber(value)),
        mean === '' ? '' : L.displayNumber(mean),
        secondary == null ? '' : L.displayNumber(secondary)];
    });
    const chartSvg = stat ? EX.buildSpcControlChartSvg(stat, {
      title: `${mon.char_name || 'SPC'} · ${requestedChart} 控制图`,
      subtitle: `${project.name} · ${dataset?.batch_no || '最新数据'} · ${subgroups.length} 个子组`,
    }) : '';
    base.code = `SPC-${mon.mon_id}`;
    base.title = `${mon.char_name || 'SPC'} 过程监控报告`;
    base.subtitle += ` · ${requestedChart} · ${mon.mon_id}`;
    base.author = mon.approved_by || project.owner || '';
    base.control = {
      controlled: mon.approval_status === '已批准',
      status: mon.approval_status || '',
      version: dataset?.batch_no || '',
      objectType: 'monitoring_item', objectId: mon.mon_id,
    };
    base.sections = [
      { t: '监控信息', fields: [
        { label: '项目', value: project.name },
        { label: '监控编号', value: mon.mon_id },
        { label: '工序', value: `${mon.step_no || ''} ${mon.step_name || ''}`.trim() },
        { label: '项目特性', value: mon.char_name || '' },
        { label: '规范限', value: mon.lsl == null && mon.usl == null ? '' : `LSL ${mon.lsl ?? '—'} / USL ${mon.usl ?? '—'} ${mon.unit || ''}` },
        { label: '控制图', value: requestedChart || '' },
        { label: '测量设备', value: mon.gauge_id || '' },
        { label: '子组大小', value: mon.subgroup_n ?? '' },
        { label: 'Cpk 目标', value: mon.cpk_target ?? '' },
        { label: '当前批次', value: dataset?.batch_no || '' },
      ] },
      { t: '数据集历史', fields: [exportTable('历史数据集', ['批次号', '导入时间', '导入人', '子组数'],
        datasets.map(item => [item.batch_no || '', item.imported_at || '', item.imported_by || '', item.n_sub || 0]))] },
      ...(stat ? [{ t: '能力与控制限', fields: [exportTable('计算结果', ['指标', '数值'], [
        ['子组数', stat.labels?.length ?? ''],
        ['X̄̄ / CL', L.displayNumber(stat.Xbb ?? stat.center)],
        ['R̄ / S̄', L.displayNumber(stat.Rb)],
        ['UCL', L.displayNumber(stat.ucl)],
        ['LCL', L.displayNumber(stat.lcl)],
        ['Cp', L.displayNumber(stat.cp, 2)],
        ['Cpk', L.displayNumber(stat.cpk, 2)],
        ['Ppk', L.displayNumber(stat.ppk, 2)],
        ['判异点', stat.violations?.length ?? 0],
      ])] }] : []),
      { t: '子组数据', fields: [exportTable('子组明细', subgroupCols, subgroupRows)] },
    ];
    const violationSet = new Set((stat?.violations || []).map(item => item.i));
    const exportRows = subgroupRows.map((row, index) => [
      ...row,
      violationSet.has(index) ? (stat.violations.filter(item => item.i === index).map(item => item.type).join('；')) : '正常',
    ]);
    const mainUcl = stat?.seriesUcl || stat?.series?.map(() => stat.ucl) || [];
    const mainLcl = stat?.seriesLcl || stat?.series?.map(() => stat.lcl) || [];
    const secondaryValues = stat?.secondary?.values || stat?.range || [];
    const secondaryUcl = stat?.secondary?.ucl ?? stat?.uclR;
    const secondaryCenter = stat?.secondary?.center ?? stat?.Rb;
    const secondaryLcl = stat?.secondary?.lcl ?? stat?.lclR;
    const nativeRows = exportRows.map((row, index) => {
      const mean = stat?.series?.[index] ?? '';
      const secondaryValue = secondaryValues[index] ?? '';
      const mainViolation = violationSet.has(index) ? mean : '';
      const badSecondary = secondaryValue !== '' && secondaryUcl != null
        && (secondaryValue > secondaryUcl || secondaryValue < (secondaryLcl ?? 0));
      return [
        ...row,
        mainUcl[index] ?? stat?.ucl ?? '',
        stat?.center ?? stat?.Xbb ?? '',
        mainLcl[index] ?? stat?.lcl ?? '',
        mainViolation,
        secondaryUcl ?? '',
        secondaryCenter ?? '',
        secondaryLcl ?? '',
        badSecondary ? secondaryValue : '',
      ];
    });
    const nativeHeaders = [
      ...subgroupCols, '判异', 'UCL', 'CL', 'LCL', '主图判异值',
      '次级 UCL', '次级 CL', '次级 LCL', '次级判异值',
    ];
    const meanColumn = 1 + width;
    const secondaryColumn = 2 + width;
    const uclColumn = 4 + width;
    const clColumn = 5 + width;
    const lclColumn = 6 + width;
    const violationColumn = 7 + width;
    const secondaryUclColumn = 8 + width;
    const secondaryClColumn = 9 + width;
    const secondaryLclColumn = 10 + width;
    const secondaryViolationColumn = 11 + width;
    base.standardWorkbook = {
      sheetName: 'SPC控制图数据',
      title: `${mon.char_name || 'SPC'} 控制图与过程能力`,
      subtitle: `${project.name} · ${mon.mon_id} · ${dataset?.batch_no || '最新数据'}`,
      code: `SPC-${mon.mon_id}`,
      version: mon.cp_row_id || 'V1.0',
      generatedAt,
      author: mon.approved_by || project.owner || '',
      projectName: project.name,
      source: 'AIAG SPC reference structure',
      sourceNotes: [
        '控制图数据、子组统计量、控制限和过程能力按当前监控项导出。',
        '控制图用于识别过程稳定性；规格限用于能力评价，二者不能混用。',
      ],
      metaRows: [
        [{ label: '项目', value: project.name }, { label: '零件号', value: project.part_no || '' }, { label: '批次', value: dataset?.batch_no || '' }],
        [{ label: '特性', value: mon.char_name || '' }, { label: '控制图', value: requestedChart || '' }, { label: '测量设备', value: mon.gauge_id || '' }],
        [{ label: '规范', value: mon.lsl == null && mon.usl == null ? '' : `${mon.lsl} ~ ${mon.usl} ${mon.unit || ''}` }, { label: '子组大小', value: mon.subgroup_n || '' }, { label: 'Cpk目标', value: mon.cpk_target || '' }],
      ],
      groups: [{ label: '子组测量数据', span: width + 1 }, { label: '统计量', span: 2 }, { label: '判异', span: 1 }],
      columns: [...subgroupCols, '判异'],
      widths: [16, ...Array(width).fill(10), 10, 12, 26],
      centerCols: [0, ...Array.from({ length: width + 2 }, (_, index) => index + 1)],
      rows: exportRows,
      chartSvg,
      chartTitle: `${mon.char_name || 'SPC'} · ${requestedChart} 控制图`,
      chartType: requestedChart,
      chartViolations: stat?.violations?.length || 0,
      nativeChart: stat ? {
        title: `${mon.char_name || 'SPC'} · ${requestedChart} 控制图`,
        subtitle: `${project.name} · ${dataset?.batch_no || '最新数据'} · ${subgroups.length} 个子组`,
        headers: nativeHeaders,
        rows: nativeRows,
        charts: [
          {
            title: `${requestedChart} 主控制图`,
            series: [
              { name: '子组统计量', column: meanColumn, values: nativeRows.map(row => row[meanColumn]), color: '2D6CDF', marker: true },
              { name: 'UCL', column: uclColumn, values: nativeRows.map(row => row[uclColumn]), color: 'E07A5F', dash: 'dash' },
              { name: 'CL', column: clColumn, values: nativeRows.map(row => row[clColumn]), color: '475569', dash: 'dash' },
              { name: 'LCL', column: lclColumn, values: nativeRows.map(row => row[lclColumn]), color: 'D49A28', dash: 'dash' },
              { name: '判异点', column: violationColumn, values: nativeRows.map(row => row[violationColumn]), color: 'DC2626', markerOnly: true },
            ],
            yTitle: mon.char_name || '',
          },
          ...(secondaryValues.length ? [{
            title: stat.secondary?.title || (String(requestedChart).toUpperCase() === 'XBAR-S' ? '标准差控制图（S）' : '极差控制图（R）'),
            series: [
              { name: secondaryName, column: secondaryColumn, values: nativeRows.map(row => row[secondaryColumn]), color: '2D6CDF', marker: true },
              { name: 'UCL', column: secondaryUclColumn, values: nativeRows.map(row => row[secondaryUclColumn]), color: 'E07A5F', dash: 'dash' },
              { name: 'CL', column: secondaryClColumn, values: nativeRows.map(row => row[secondaryClColumn]), color: '475569', dash: 'dash' },
              { name: 'LCL', column: secondaryLclColumn, values: nativeRows.map(row => row[secondaryLclColumn]), color: 'D49A28', dash: 'dash' },
              { name: '判异点', column: secondaryViolationColumn, values: nativeRows.map(row => row[secondaryViolationColumn]), color: 'DC2626', markerOnly: true },
            ],
            yTitle: secondaryName,
          }] : []),
        ],
      } : null,
      page: { paperSize: 9, orientation: 'landscape', fitToHeight: 1 },
      notes: stat ? [
        `CL=${fmtNumber(stat.Xbb ?? stat.center)}；UCL=${fmtNumber(stat.ucl)}；LCL=${fmtNumber(stat.lcl)}；Cp=${fmtNumber(stat.cp)}；Cpk=${fmtNumber(stat.cpk)}；Ppk=${fmtNumber(stat.ppk)}。`,
        `判异点 ${stat.violations.length} 个；控制方法：${stat.controlMethod || ''}`,
      ] : ['当前批次没有可计算的控制图数据。'],
    };
    base.docxSections = [
      { t: '一、监控概况', fields: [
        { label: '项目 / 零件号', value: `${project.name} / ${project.part_no || ''}` },
        { label: '工序', value: `${mon.step_no || ''} ${mon.step_name || ''}`.trim() },
        { label: '项目特性', value: mon.char_name || '' },
        { label: '控制图 / 测量设备', value: `${requestedChart || ''} / ${mon.gauge_id || ''}` },
        { label: '批次 / 数据点', value: `${dataset?.batch_no || '—'} / ${subgroups.length}` },
        { label: '规格限', value: mon.lsl == null && mon.usl == null ? '' : `LSL ${mon.lsl} / USL ${mon.usl} ${mon.unit || ''}` },
      ] },
      ...(stat ? [{ t: '二、控制图与能力结果', fields: [exportTable('统计结果', ['指标', '数值'], [
        ['CL', fmtNumber(stat.Xbb ?? stat.center)], ['UCL', fmtNumber(stat.ucl)], ['LCL', fmtNumber(stat.lcl)],
        ['Cp', fmtNumber(stat.cp)], ['Cpk', fmtNumber(stat.cpk)], ['Ppk', fmtNumber(stat.ppk)],
        ['判异点', stat.violations.length],
      ])] }] : []),
      ...(chartSvg ? [{ t: '三、控制图', fields: [{
        type: 'image', label: `${requestedChart} 控制图`, value: chartSvg,
        widthInches: 6.05, heightInches: stat?.secondary || stat?.range?.length ? 3.44 : 2.92,
      }] }] : []),
      { t: '四、子组数据摘要', fields: [exportTable('子组明细', [...subgroupCols, '判异'], exportRows)] },
      { t: '五、判异与反应', fields: [
        { label: '判异摘要', value: stat?.violations?.length
          ? stat.violations.map(item => `第 ${item.i + 1} 点：${item.type}`).join('\n')
          : '未发现判异点' },
        { label: '反应要求', value: '出现判异或不满足能力目标时，应停止放行、隔离可疑产品并记录原因和纠正措施。' },
      ] },
    ];
  } else if (tool === 'msa') {
    const plans = DB.listMsaPlans(CUR);
    const studies = all(`SELECT ms.*, COALESCE(pc.name,cm.name) char_name,
        COALESCE(pc.unit,cm.unit) char_unit
      FROM msa_study ms
      LEFT JOIN project_char pc ON pc.pchar_id=ms.project_char_id
      LEFT JOIN char_master cm ON cm.char_id=ms.char_id
      WHERE ms.project_id=? ORDER BY ms.study_id DESC`, CUR);
    const gauges = all('SELECT * FROM gauge ORDER BY gauge_id');
    base.code = 'MSA';
    base.title = 'MSA 测量系统分析报告';
    base.subtitle += ' · 计划、研究与检具台账';
    base.sections = [
      { t: '文件信息', fields: [
        { label: '项目', value: project.name },
        { label: '零件号', value: project.part_no || '' },
        { label: '计划数', value: plans.length },
        { label: '研究记录数', value: studies.length },
        { label: '检具台账数', value: gauges.length },
      ] },
      { t: 'MSA 计划', fields: [exportTable('计划明细',
        ['计划编号', '项目特性', '检具', '研究类型', '研究设计', '计划日期', '责任人', '状态', '来源状态'],
        plans.map(plan => [
          plan.plan_id, plan.char_name || plan.char_id || '',
          `${plan.gauge_code || plan.gauge_id || ''} ${plan.gauge_name || ''}`.trim(),
          plan.study_type || 'GRR',
          (plan.study_type || 'GRR') === 'GRR' ? `${plan.parts} 件 × ${plan.operators} 人 × ${plan.trials} 次` : '按适用方法',
          plan.planned_date || '', plan.owner || '', plan.status || '', plan.source_status || '',
        ]))] },
      { t: 'MSA 研究', fields: [exportTable('研究记录',
        ['研究编号', '日期', '项目特性', '检具', '类型', '%GRR', '%Tol', 'ndc', '判定', '状态'],
        studies.map(study => [
          study.study_id, study.studied_at || '', study.char_name || study.char_id || '', study.gauge_id || '',
          study.study_type || 'GRR', study.result_pct ?? '', study.pct_tol ?? '', study.ndc ?? '',
          study.judgment || '', study.status || '',
        ]))] },
      { t: '检具台账', fields: [exportTable('检具',
        ['编号', '名称', '型号', '量程', '分辨力', '校准到期日', '状态', '使用部门'],
        gauges.map(gauge => [
          gauge.gauge_id, gauge.name || '', gauge.model || '', gauge.range_text || '',
          gauge.resolution ?? '', gauge.calibration_due || '', gauge.status || '', gauge.owner_dept || '',
        ]))] },
    ];
    const requestedStudyId = +query.get('study_id') || 0;
    const latestStudy = requestedStudyId
      ? studies.find(item => +item.study_id === requestedStudyId) || null
      : studies.find(item => item.raw_json) || null;
    if (requestedStudyId && !latestStudy?.raw_json) throw new Error('所选 MSA 研究不存在或没有原始数据');
    if (latestStudy) {
      let matrix = [];
      let snapshot = {};
      try { matrix = JSON.parse(latestStudy.raw_json || '[]'); } catch (e) { matrix = []; }
      try { snapshot = JSON.parse(latestStudy.plan_snapshot_json || '{}'); } catch (e) { snapshot = {}; }
      const parts = +snapshot.parts || matrix[0]?.length || 10;
      const operators = +snapshot.operators || 3;
      const trials = +snapshot.trials || 3;
      const char = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
        latestStudy.project_char_id, CUR) || {
        name: latestStudy.char_name, char_id: latestStudy.char_id, unit: latestStudy.char_unit,
        target: snapshot.char_target_snapshot, lsl: snapshot.char_lsl_snapshot,
        usl: snapshot.char_usl_snapshot, tol_text: snapshot.char_tol_text_snapshot,
      };
      const gauge = q('SELECT * FROM gauge WHERE gauge_id=?', latestStudy.gauge_id) || {
        gauge_id: latestStudy.gauge_id, name: snapshot.gauge_name_snapshot,
        code: snapshot.gauge_code_snapshot, resolution: snapshot.resolution,
      };
      const result = Array.isArray(matrix) && matrix.length === operators * trials
        && matrix.every(row => Array.isArray(row) && row.length === parts)
        ? DB.computeGRR(matrix, parts, operators, trials, +latestStudy.tolerance || +snapshot.tolerance || 0)
        : null;
      base.standardWorkbook = buildMsaGrrStandard({
        project, study: latestStudy, snapshot, data: matrix,
        parts, operators, trials, char, gauge, result, generatedAt,
      });
      base.docxSections = base.standardWorkbook.docxSections;
      base.author = latestStudy.operator || base.author;
      base.version = `Study ${latestStudy.study_id}`;
    }
    // MSA 没有统一审批流，受控性以“所选研究是否已被判定接受”为准
    base.control = {
      controlled: !!latestStudy && ['接受', '条件接受'].includes(latestStudy.judgment || ''),
      status: latestStudy ? (latestStudy.judgment || latestStudy.status || '未判定') : '无研究记录',
      version: latestStudy ? `Study ${latestStudy.study_id}` : '',
      objectType: 'msa_study', objectId: latestStudy ? String(latestStudy.study_id) : '',
    };
  } else if (tool === 'ppap') {
    const requestedSubmissionId = String(query.get('submission_id') || '');
    if (requestedSubmissionId && requestedSubmissionId !== CUR) {
      throw new Error('所选 PPAP 提交记录不属于当前项目');
    }
    const workflow = ppapWorkflowRows(CUR);
    const storedElements = new Map(effectivePpapElements(CUR, workflow)
      .map(item => [item.element_no, item]));
    const elements = workflow.map(item => ({
      ...item,
      ...(storedElements.get(item.no) || {}),
      name: DB.PPAP_ELEMENTS[item.no - 1] || item.sourceLabel || '',
    }));
    const packages = all('SELECT * FROM ppap_package WHERE project_id=? ORDER BY pkg_id DESC', CUR);
    const submission = ensurePpapSubmission(CUR);
    base.code = 'PPAP';
    base.title = 'PPAP 提交与零件保证书';
    base.subtitle += ` · ${elements.filter(item => item.status === '已完成').length}/${elements.length} 项完成`;
    base.version = `Level ${submission.level}`;
    base.control = {
      controlled: ['已批准', '已提交', '顾客已批准'].includes(submission.status),
      status: submission.status || '准备中',
      version: `Level ${submission.level}`,
      objectType: 'ppap_submission', objectId: CUR,
    };
    base.sections = [
      { t: '文件信息', fields: [
        { label: '项目', value: project.name },
        { label: '零件号', value: project.part_no || '' },
        { label: '提交等级', value: `Level ${submission.level}` },
        { label: '提交原因', value: submission.submission_reason || '' },
        { label: '顾客 / 组织', value: `${submission.customer || project.customer || ''} / ${submission.organization || ''}` },
        { label: '提交状态', value: submission.status || '' },
        { label: '申请 / 批准', value: `${submission.requested_by || ''} / ${submission.approved_by || ''}` },
        { label: '要素完成数', value: `${elements.filter(item => item.status === '已完成').length}/${elements.length}` },
        { label: '已生成提交包', value: packages.length },
      ] },
      { t: 'PPAP 18 项', fields: [exportTable('要素清单',
        ['#', '要素', '阶段', '上游来源', '关联状态', 'PPAP 状态', '证据'],
        elements.map(item => [
          item.no, item.name || '', item.phase || '', item.sourceLabel || (item.sourceCodes || []).join('；'),
          item.linked_status || '', item.status || '', item.evidence || '',
        ]))] },
      { t: '提交包', fields: [exportTable('已生成包',
        ['包编号', '等级', '基线', '生成时间', '文件数', '清单哈希'],
        packages.map(item => [
          item.pkg_id, `L${item.level}`, item.baseline_id || '', item.created_at || '',
          item.file_count || 0, item.pkg_hash || '',
        ]))] },
    ];
    base.standardWorkbook = {
      sheetName: 'PPAP证据矩阵',
      title: 'PPAP 提交证据矩阵',
      subtitle: `${project.name} · ${project.part_no || ''} · Level ${submission.level}`,
      code: 'PPAP',
      version: `Level ${submission.level}`,
      generatedAt,
      author: submission.approved_by || project.owner || '',
      projectName: project.name,
      source: 'AIAG PPAP 4th Edition structure',
      sourceNotes: [
        '18 项 PPAP 要素逐项记录适用性、上游来源、关联状态、提交状态和证据。',
        'PSW 的提交等级、提交原因、顾客/组织、零件版本和批准信息来自系统提交记录。',
        '本文件不替代顾客批准，也不把文件存在等同于 PPAP 已批准。',
      ],
      metaRows: [
        [{ label: '项目', value: project.name }, { label: '零件号', value: project.part_no || '' }, { label: '提交等级', value: `Level ${submission.level}` }],
        [{ label: '顾客', value: submission.customer || project.customer || '' }, { label: '组织', value: submission.organization || '' }, { label: '零件版本', value: submission.part_revision || '' }],
        [{ label: '提交原因', value: submission.submission_reason || '' }, { label: '状态', value: submission.status || '' }, { label: '申请/批准', value: `${submission.requested_by || ''} / ${submission.approved_by || ''}` }],
      ],
      groups: [{ label: 'PPAP 18 项证据', span: 8 }],
      columns: ['#', 'PPAP 要素', '适用', '阶段', '上游来源', '关联状态', 'PPAP 状态', '证据 / 版本'],
      widths: [6, 24, 8, 10, 26, 14, 14, 34],
      page: { paperSize: 9, orientation: 'landscape', fitToHeight: 1 },
      centerCols: [0, 2, 3, 5, 6],
      rows: elements.map(item => [
        item.no, item.name || '', item.required === 0 ? '否' : '是', item.phase || '',
        (item.sourceCodes || []).join('；') || item.sourceLabel || '',
        item.linked_status || '', item.status || '', item.evidence || '',
      ]),
      notes: [
        `提交包数量：${packages.length}；最近基线：${packages[0]?.baseline_id || '—'}。`,
        '标记 PPAP 要素完成仍需人工确认适用性并填写证据。',
      ],
    };
    base.docxSections = [
      { t: '一、零件提交保证书（PSW）摘要', fields: [
        { label: '项目 / 零件号', value: `${project.name} / ${project.part_no || ''}` },
        { label: '顾客 / 组织', value: `${submission.customer || project.customer || ''} / ${submission.organization || ''}` },
        { label: '提交等级 / 原因', value: `Level ${submission.level} / ${submission.submission_reason || '—'}` },
        { label: '零件版本', value: submission.part_revision || '' },
        { label: '申请 / 批准', value: `${submission.requested_by || ''} / ${submission.approved_by || ''}` },
        { label: '提交状态', value: submission.status || '' },
      ] },
      { t: '二、PPAP 18 项证据摘要', fields: [exportTable('要素清单',
        ['#', '要素', '适用', '关联状态', 'PPAP状态', '证据'],
        elements.map(item => [item.no, item.name || '', item.required === 0 ? '否' : '是',
          item.linked_status || '', item.status || '', item.evidence || '']))] },
    ];
  } else {
    throw new Error('不支持的导出模块');
  }
  return base;
}

function markFmeaDraft(fmeaId) {
  if (!fmeaId) return;
  DB.db.prepare("UPDATE fmea_header SET status='草稿',published_at=NULL WHERE fmea_id=?").run(fmeaId);
}

function gaussianRandom() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function gaugeResolution(gauge, tolerance) {
  if (gauge && Number.isFinite(+gauge.resolution) && +gauge.resolution > 0) return +gauge.resolution;
  const numbers = String((gauge && gauge.range_text) || '').match(/\d+(?:\.\d+)?/g)
    ?.map(Number).filter(value => Number.isFinite(value) && value > 0) || [];
  if (numbers.length >= 2) return Math.min(...numbers);
  if (numbers.length === 1) return +(numbers[0] / 10000).toPrecision(2);
  return tolerance ? +(tolerance / 1000).toPrecision(2) : 0.001;
}

function roundReading(value, resolution) {
  if (!resolution) return +value.toFixed(6);
  const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(resolution)) + 2));
  return +(Math.round(value / resolution) * resolution).toFixed(decimals);
}

function simulateMsaStudy({ projectChar, gauge, parts, ops, trials, targetPct, tolerance }) {
  const hasSpec = projectChar.lsl != null && projectChar.usl != null
    && Number.isFinite(+projectChar.lsl) && Number.isFinite(+projectChar.usl)
    && +projectChar.usl > +projectChar.lsl;
  const specLsl = hasSpec ? +projectChar.lsl : null;
  const specUsl = hasSpec ? +projectChar.usl : null;
  const toleranceValue = hasSpec ? specUsl - specLsl : (+tolerance || 0);
  if (!toleranceValue) throw new Error('模拟 MSA 前必须维护项目特性公差');
  const center = projectChar.target != null && Number.isFinite(+projectChar.target)
    ? +projectChar.target
    : hasSpec ? (specLsl + specUsl) / 2 : 0;
  if (hasSpec && (center < specLsl || center > specUsl)) {
    throw new Error('项目特性目标值不在 LSL/USL 范围内');
  }
  const lowerBound = hasSpec ? specLsl : center - toleranceValue / 2;
  const upperBound = hasSpec ? specUsl : center + toleranceValue / 2;
  const partTolerance = hasSpec ? specUsl - specLsl : toleranceValue;
  const noiseSigma = partTolerance * 0.004;
  const requestedHalfSpan = partTolerance * 0.36;
  const availableHalfSpan = Math.max(0,
    Math.min(center - lowerBound, upperBound - center) - noiseSigma * 3);
  const halfSpan = Math.min(requestedHalfSpan, availableHalfSpan);
  const partValues = Array.from({ length: +parts }, (_, index) => {
    const ratio = parts === 1 ? 0 : index / (parts - 1) - 0.5;
    const value = center + ratio * halfSpan * 2 + gaussianRandom() * noiseSigma;
    return Math.max(lowerBound, Math.min(upperBound, value));
  });
  const operatorNoise = Array.from({ length: ops }, () => gaussianRandom());
  const repeatNoise = Array.from({ length: ops * trials }, () =>
    Array.from({ length: parts }, () => gaussianRandom()));
  const partRange = Math.max(...partValues) - Math.min(...partValues);
  const d2Parts = {
    2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534,
    7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078,
  }[parts] || 3.078;
  const pvSigma = partRange / d2Parts;
  const desired = Math.max(1, Math.min(60, +targetPct || 10)) / 100;
  let grrSigma = Math.max(toleranceValue / 10000,
    desired * pvSigma / Math.sqrt(Math.max(0.05, 1 - desired ** 2)));
  const resolution = gaugeResolution(gauge, toleranceValue);
  let best = null;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const evSigma = grrSigma * 0.82;
    const avSigma = grrSigma * 0.57;
    const data = [];
    for (let row = 0; row < ops * trials; row += 1) {
      const operator = Math.floor(row / trials);
      data.push(partValues.map((part, partIndex) =>
        roundReading(part + operatorNoise[operator] * avSigma
          + repeatNoise[row][partIndex] * evSigma, resolution)));
    }
    const result = DB.computeGRR(data, +parts, +ops, +trials, toleranceValue);
    const error = Math.abs(result.pctGRR - +targetPct);
    if (!best || error < best.error) best = { data, result, error };
    if (result.pctGRR > 0) {
      grrSigma *= Math.max(0.35, Math.min(2.8, (+targetPct) / result.pctGRR));
    }
  }
  const recommendedResolution = toleranceValue / 10;
  const readings = best.data.flat();
  return {
    data: best.data,
    result: best.result,
    target_pct: +targetPct,
    actual_pct: best.result.pctGRR,
    tolerance: toleranceValue,
    spec_lsl: hasSpec ? specLsl : null,
    spec_usl: hasSpec ? specUsl : null,
    part_value_min: Math.min(...partValues),
    part_value_max: Math.max(...partValues),
    reading_min: Math.min(...readings),
    reading_max: Math.max(...readings),
    gauge_resolution: resolution,
    recommended_resolution: recommendedResolution,
    resolution_ok: resolution <= recommendedResolution,
    part_values: partValues.map(value => +value.toFixed(6)),
  };
}

function spcChartOptions(subs, monitor, char) {
  const configured = String(monitor.chart_type || 'Xbar-R');
  const options = {};
  const types = configured === 'P' ? ['P']
    : configured === 'C' ? ['C']
      : configured === 'I-MR' || configured === 'X-MR' ? ['I-MR']
        : Array.isArray(subs[0].v) && subs[0].v.length >= 2 ? ['Xbar-R', 'Xbar-S'] : ['I-MR'];
  for (const type of types) {
    try { options[type] = L.spcCompute(subs, char, { chartType: type }); } catch (e) { /* 当前数据不支持该图型 */ }
  }
  if (!options[configured] && options[types[0]]) options[configured] = options[types[0]];
  return options;
}

function createProjectCore(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('项目名称不能为空');
  const sourceId = String(body.copy_from || '').trim();
  const id = String(body.project_id || '').trim()
    || (sourceId ? `${sourceId}-COPY-${Date.now().toString(36).toUpperCase().slice(-4)}` : 'P-' + Date.now().toString(36).toUpperCase());
  if (q('SELECT 1 FROM project WHERE project_id=?', id)) throw new Error('项目编号已存在：' + id);
  const source = sourceId ? q('SELECT * FROM project WHERE project_id=?', sourceId) : null;
  if (sourceId && !source) throw new Error('复制来源项目不存在');
  // 复制等于读全量内容：不能借复制绕过项目成员限制
  if (source && !canAccessProject(sessionUser(), sourceId)) {
    throw Object.assign(new Error('不能复制无权访问的项目'), { statusCode: 403 });
  }
  const familyId = String(body.family_id || (source && source.family_id) || 'FM').trim();
  const family = q("SELECT * FROM product_family WHERE family_id=? AND COALESCE(status,'生效')<>'作废'", familyId);
  if (!family) throw new Error('产品族不存在');
  const manualSeriesCode = String(body.series_code || '').trim();
  const manualSeriesName = String(body.series_name || manualSeriesCode).trim();
  let seriesId = String(body.series_id || (source && source.series_id) || '').trim();
  if (manualSeriesCode) {
    const existingManual = q(`SELECT series_id FROM product_series
      WHERE family_id=? AND code=? AND COALESCE(status,'生效')<>'作废'`, familyId, manualSeriesCode);
    if (existingManual) {
      seriesId = existingManual.series_id;
    } else {
      seriesId = `SR-MAN-${idPart(familyId)}-${idPart(manualSeriesCode)}`;
      if (q('SELECT 1 FROM product_series WHERE series_id=?', seriesId)) {
        seriesId = `${seriesId}-${Date.now().toString(36).toUpperCase().slice(-4)}`;
      }
      DB.db.prepare(`INSERT INTO product_series(series_id,family_id,code,name,status)
        VALUES(?,?,?,?, '生效')`).run(seriesId, familyId, manualSeriesCode, manualSeriesName);
      L.audit(body.owner || '项目经理', '新增', 'product_series', seriesId,
        null, { family_id: familyId, code: manualSeriesCode, name: manualSeriesName },
        '新建项目时补充系列/型号');
    }
  }
  seriesId ||= ((q(`SELECT series_id FROM product_series WHERE family_id=? AND COALESCE(status,'生效')<>'作废'
    ORDER BY code,series_id LIMIT 1`, familyId) || {}).series_id);
  const series = seriesId
    ? q("SELECT * FROM product_series WHERE series_id=? AND family_id=? AND COALESCE(status,'生效')<>'作废'", seriesId, familyId)
    : null;
  if (!series) throw new Error('产品系列不存在或不属于所选产品族');
  let approvalId = null;
  if (source) {
    approvalId = recordApproval({
      projectId: source.project_id,
      actionType: 'PROJECT_COPY',
      objectType: 'project',
      objectId: id,
      title: `复制项目：${source.name} → ${name}`,
      payload: { sourceId, targetId: id },
      approvedBy: body.approved_by,
      requestedBy: body.owner || actorName(),
      note: '项目复制活动批准',
    });
  }

  DB.tx(() => {
    DB.db.prepare(`INSERT INTO project(
      project_id,code,name,family_id,series_id,customer,standard,phase,owner,status,start_date,part_no
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, id, name, familyId, seriesId,
      body.customer || (source && source.customer) || '',
      body.standard || (source && source.standard) || 'AIAG-VDA 2019', 1,
      body.owner || (source && source.owner) || actorName(), '进行中',
      body.start_date || DB.now().slice(0, 10),
      body.part_no || (source && source.part_no) || ''
    );
    for (const phase of DT.PHASES) {
      DB.db.prepare('INSERT INTO apqp_phase(project_id,phase,name,status,gate_criteria) VALUES(?,?,?,?,?)')
        .run(id, phase.no, phase.name, '未开始', '');
    }
    for (const item of DT.CATALOG) {
      DB.db.prepare(`INSERT INTO project_doc(
        project_id,doc_code,status,data_json,updated_at,updated_by,version
      ) VALUES(?,?,?,?,?,?,?)`).run(
        id, item.code, item.kind === 'module' ? '系统模块' : '未开始', '{}', null, null, 'V1.0'
      );
    }
    for (const task of DB.APQP_TASKS) {
      DB.db.prepare(`INSERT INTO apqp_task(
        project_id,phase,name,owner,due,status,deliverable,weight
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        id, task[0], task[1], task[2], '2026-12-31', '未开始', task[4], 1
      );
    }
    DB.PPAP_ELEMENTS.forEach((elementName, index) => {
      DB.db.prepare(`INSERT INTO ppap_element(
        project_id,element_no,name,required,status,evidence,note
      ) VALUES(?,?,?,?,?,?,?)`).run(id, index + 1, elementName, 1, '未完成', '', '');
    });

    if (!source) {
      for (const type of ['DFMEA', 'PFMEA']) {
        const headerId = `${type === 'DFMEA' ? 'DF' : 'PF'}-${idPart(id)}`;
        DB.db.prepare(`INSERT INTO fmea_header(
          fmea_id,project_id,fmea_type,title,ap_ver,status,rev,meta_json
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          headerId, id, type,
          `${name} ${type === 'DFMEA' ? '设计FMEA' : '过程FMEA'}`,
          'AP-2019', '草稿', 'r1', '{}'
        );
        DB.db.prepare(`INSERT INTO fmea_node(
          node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,desc,level
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          uniqueId('N', headerId), headerId, null, 'STRUCTURE', null, 1,
          type === 'DFMEA' ? `${name} 产品总成` : `${name} 过程总成`,
          '新建项目初始化根节点', 1
        );
      }
      for (const stage of ['PROTO', 'PILOT', 'SOP']) {
        DB.db.prepare(`INSERT INTO control_plan(
          cp_id,project_id,stage,rev,part_no,part_name,customer,plant,prepared_by,approved_by,status,effective_date
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          `CP-${idPart(id)}-${stage}`, id, stage, 'r1',
          body.part_no || '', name, body.customer || '', '', body.owner || actorName(),
          '', '草稿', ''
        );
      }
    }
    if (source) copyProjectData(source, id);
  });
  L.audit(body.owner || actorName(), '新增', 'project', id, null,
    { name, sourceId: sourceId || null, approvalId }, source ? '复制项目' : '新建项目');
  return {
    ok: true, project_id: id, copied_from: sourceId || null, approval_id: approvalId,
    project: q(`SELECT p.*,pf.name family_name,ps.name series_name
      FROM project p LEFT JOIN product_family pf ON pf.family_id=p.family_id
      LEFT JOIN product_series ps ON ps.series_id=p.series_id WHERE p.project_id=?`, id),
  };
}

function copyProjectData(source, target) {
  const sourceDocs = all('SELECT * FROM project_doc WHERE project_id=?', source.project_id);
  for (const doc of sourceDocs) {
    DB.db.prepare(`UPDATE project_doc SET
      status=?,data_json=?,cols_json=?,version=?,updated_at=?,updated_by=?,
      custom_name=?,hidden=?
      WHERE project_id=? AND doc_code=?`).run(
      doc.status, doc.data_json || '{}', doc.cols_json, doc.version || 'V1.0',
      DB.now(), doc.updated_by, doc.custom_name, doc.hidden || 0,
      target, doc.doc_code
    );
  }
  for (const phase of all('SELECT * FROM apqp_task WHERE project_id=?', source.project_id)) {
    DB.db.prepare(`UPDATE apqp_task SET status=?,owner=?,due=?
      WHERE project_id=? AND phase=? AND name=?`).run(
      phase.status, phase.owner, phase.due, target, phase.phase, phase.name
    );
  }

  const pcharMap = new Map();
  for (const sourceChar of all('SELECT * FROM project_char WHERE project_id=?', source.project_id)) {
    let targetChar = q('SELECT * FROM project_char WHERE project_id=? AND char_id=?',
      target, sourceChar.char_id);
    if (!targetChar && sourceChar.char_id) {
      try { targetChar = DB.ensureProjectChar(target, sourceChar.char_id); } catch (e) { targetChar = null; }
    }
    if (!targetChar) continue;
    pcharMap.set(sourceChar.pchar_id, targetChar.pchar_id);
    DB.db.prepare(`UPDATE project_char SET
      name=?,description=?,char_kind=?,domain=?,unit=?,target=?,lsl=?,usl=?,tol_text=?,is_special=?,
      special_symbol=?,source_type=?,source_ref=?,status=?,updated_at=?
      WHERE pchar_id=?`).run(
      sourceChar.name, sourceChar.description || '', sourceChar.char_kind, sourceChar.domain, sourceChar.unit,
      sourceChar.target, sourceChar.lsl, sourceChar.usl, sourceChar.tol_text,
      sourceChar.is_special, sourceChar.special_symbol, sourceChar.source_type,
      sourceChar.source_ref, sourceChar.status, DB.now(), targetChar.pchar_id
    );
  }

  const stepMap = new Map();
  const stepParentLinks = [];
  all('SELECT * FROM process_step WHERE project_id=? ORDER BY seq', source.project_id).forEach((step, index) => {
    const newId = `PS-${idPart(target)}-${String(index + 1).padStart(4, '0')}`;
    stepMap.set(step.step_id, newId);
    if (step.parent_step_id) stepParentLinks.push({ newId, sourceParentId: step.parent_step_id });
    DB.db.prepare(`INSERT INTO process_step(
      step_id,project_id,dict_id,step_no,name,step_type,seq,parent_step_id,equipment,fixture,input_desc,output_desc,status,ver,pfd_mode,published_at,published_by,change_summary
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      newId, target, step.dict_id || null, step.step_no, step.name, step.step_type, step.seq,
      null, step.equipment, step.fixture, step.input_desc, step.output_desc,
      step.status, step.ver, step.pfd_mode || 'PROCESS', step.published_at, step.published_by, '项目复制'
    );
  });
  stepParentLinks.forEach(link => {
    const newParentId = stepMap.get(link.sourceParentId);
    if (newParentId) {
      DB.db.prepare('UPDATE process_step SET parent_step_id=? WHERE step_id=?')
        .run(newParentId, link.newId);
    }
  });

  const sourceHeaders = all('SELECT * FROM fmea_header WHERE project_id=?', source.project_id);
  const headerMap = new Map();
  const nodeMap = new Map();
  const funcMap = new Map();
  const rowMap = new Map();
  for (const header of sourceHeaders) {
    const newHeader = `${header.fmea_type === 'DFMEA' ? 'DF' : 'PF'}-${idPart(target)}`;
    headerMap.set(header.fmea_id, newHeader);
    DB.db.prepare(`INSERT INTO fmea_header(
      fmea_id,project_id,fmea_type,title,ap_ver,status,rev,meta_json,published_at,published_by,approved_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      newHeader, target, header.fmea_type, header.title, header.ap_ver,
      '草稿', 'r1', header.meta_json || '{}', null, null, null
    );
  }
  for (const header of sourceHeaders) {
    const newHeader = headerMap.get(header.fmea_id);
    const nodes = all('SELECT * FROM fmea_node WHERE fmea_id=? ORDER BY seq', header.fmea_id);
    const idRows = new Map(nodes.map(node => [node.node_id,
      `N-${idPart(target)}-${header.fmea_type === 'DFMEA' ? 'DF' : 'PF'}-${String(nodes.indexOf(node) + 1).padStart(4, '0')}`]));
    idRows.forEach((newId, oldId) => nodeMap.set(oldId, newId));
    for (const node of nodes) {
      DB.db.prepare(`INSERT INTO fmea_node(
        node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc,level
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        idRows.get(node.node_id), newHeader, null, node.node_type, node.node_subtype,
        node.seq, node.name, node.char_id, node.desc, node.level
      );
    }
    for (const node of nodes) {
      DB.db.prepare('UPDATE fmea_node SET parent_id=? WHERE node_id=?').run(
        node.parent_id ? idRows.get(node.parent_id) : null, idRows.get(node.node_id)
      );
    }
    const funcs = all(`SELECT f.* FROM fmea_function f JOIN fmea_node n ON n.node_id=f.node_id WHERE n.fmea_id=?`, header.fmea_id);
    funcs.forEach((func, index) => {
      const newId = `FN-${idPart(target)}-${header.fmea_type === 'DFMEA' ? 'DF' : 'PF'}-${String(index + 1).padStart(4, '0')}`;
      funcMap.set(func.func_id, newId);
      DB.db.prepare(`INSERT INTO fmea_function(
        func_id,node_id,text,status,source,seq,created_at,rationale
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        newId, idRows.get(func.node_id), func.text, func.status, func.source, func.seq, DB.now(),
        func.rationale || ''
      );
    });
    const rows = all('SELECT * FROM fmea_row WHERE fmea_id=? ORDER BY seq', header.fmea_id);
    rows.forEach((row, index) => {
      const newId = `FR-${header.fmea_type === 'DFMEA' ? 'DF' : 'PF'}-${idPart(target)}-${String(index + 1).padStart(4, '0')}`;
      rowMap.set(row.row_id, newId);
    });
    for (const row of rows) {
      DB.db.prepare(`INSERT INTO fmea_row(
        row_id,fmea_id,focus_node_id,fe_id,fm_id,fc_id,char_id,process_char_id,step_id,s,o,d,ap,
        pc_text,dc_text,effect_ref,seq,s_plant,s_ship,s_user,filter_code,func_id,upstream_row_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        rowMap.get(row.row_id), newHeader,
        row.focus_node_id ? (idRows.get(row.focus_node_id) || null) : null,
        row.fe_id ? (idRows.get(row.fe_id) || null) : null,
        row.fm_id ? (idRows.get(row.fm_id) || null) : null,
        row.fc_id ? (idRows.get(row.fc_id) || null) : null,
        row.char_id, row.process_char_id || null,
        row.step_id ? (stepMap.get(row.step_id) || null) : null,
        row.s, row.o, row.d, row.ap, row.pc_text, row.dc_text, null, row.seq,
        row.s_plant, row.s_ship, row.s_user, row.filter_code,
        row.func_id ? funcMap.get(row.func_id) : null, null
      );
    }
    for (const row of rows) {
      DB.db.prepare('UPDATE fmea_row SET upstream_row_id=? WHERE row_id=?').run(
        row.upstream_row_id ? rowMap.get(row.upstream_row_id) : null, rowMap.get(row.row_id)
      );
      const actions = all('SELECT * FROM fmea_action WHERE row_id=?', row.row_id);
      for (const action of actions) {
        DB.db.prepare(`INSERT INTO fmea_action(
          row_id,action_type,description,owner,due_date,status,completed_at,improved_dim,
          s_after,o_after,d_after,ap_after,effect_verified,evidence_ref,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          rowMap.get(row.row_id), action.action_type, action.description, action.owner,
          action.due_date, action.status, action.completed_at, action.improved_dim,
          action.s_after, action.o_after, action.d_after, action.ap_after,
          action.effect_verified, action.evidence_ref, DB.now()
        );
      }
      const decision = q('SELECT * FROM fmea_decision WHERE row_id=?', row.row_id);
      if (decision) {
        DB.db.prepare(`INSERT INTO fmea_decision(
          row_id,decision,rationale,approved_by,review_due,status,approved_at
        ) VALUES(?,?,?,?,?,?,?)`).run(
          rowMap.get(row.row_id), decision.decision, decision.rationale,
          decision.approved_by, decision.review_due, decision.status, decision.approved_at
        );
      }
    }
  }

  const sourceCpChars = all(`SELECT DISTINCT c.char_id FROM cp_row c
    JOIN control_plan cp ON cp.cp_id=c.cp_id
    WHERE cp.project_id=? AND c.char_id IS NOT NULL`, source.project_id);
  for (const row of sourceCpChars) {
    try {
      const targetChar = DB.ensureProjectChar(target, row.char_id);
      const sourceChar = q('SELECT * FROM project_char WHERE project_id=? AND char_id=?', source.project_id, row.char_id);
      if (sourceChar) pcharMap.set(sourceChar.pchar_id, targetChar.pchar_id);
    } catch (e) { /* 来源特性不适用于目标项目范围时保留 null，由人工重新关联 */ }
  }
  const sourcePlans = all('SELECT * FROM control_plan WHERE project_id=?', source.project_id);
  for (const plan of sourcePlans) {
    const cpId = `CP-${idPart(target)}-${plan.stage}`;
    DB.db.prepare(`INSERT INTO control_plan(
      cp_id,project_id,stage,rev,part_no,part_name,customer,plant,prepared_by,approved_by,status,effective_date
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      cpId, target, plan.stage, 'r1', plan.part_no, plan.part_name,
      plan.customer, plan.plant, plan.prepared_by, '', '草稿', ''
    );
    const rows = all('SELECT * FROM cp_row WHERE cp_id=? ORDER BY seq', plan.cp_id);
    rows.forEach((row, index) => {
      let targetProjectCharId = null;
      if (row.char_id) {
        try { targetProjectCharId = DB.ensureProjectChar(target, row.char_id).pchar_id; }
        catch (e) { targetProjectCharId = null; }
      }
      if (row.project_char_id && pcharMap.get(row.project_char_id)) {
        targetProjectCharId = pcharMap.get(row.project_char_id);
      }
      DB.db.prepare(`INSERT INTO cp_row(
        cp_row_id,cp_id,seq,step_id,char_id,project_char_id,fmea_row_id,spec_text,measure_tech,gauge_id,
        sample_size,freq_value,freq_unit,freq_trigger,control_method,reaction_plan,
        is_spc,override_flag,override_reason,upstream_ver
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `${cpId}-${String(index + 1).padStart(3, '0')}`, cpId, row.seq,
        row.step_id ? (stepMap.get(row.step_id) || null) : null, row.char_id,
        targetProjectCharId,
        row.fmea_row_id ? (rowMap.get(row.fmea_row_id) || null) : null,
        row.spec_text, row.measure_tech, row.gauge_id, row.sample_size,
        row.freq_value, row.freq_unit, row.freq_trigger, row.control_method,
        row.reaction_plan, 0, 0, '项目复制', row.upstream_ver
      );
    });
  }
  for (const sourcePlan of all('SELECT * FROM msa_plan_item WHERE project_id=?', source.project_id)) {
    const targetCharId = pcharMap.get(sourcePlan.project_char_id);
    if (!targetCharId) continue;
    const key = String(targetCharId).replace(/[^A-Z0-9]/gi, '').slice(-32);
    const planId = `MSP-${idPart(target)}-${key}`;
    DB.db.prepare(`INSERT OR IGNORE INTO msa_plan_item(
      plan_id,project_id,project_char_id,char_id,gauge_id,study_type,parts,operators,trials,
      planned_date,owner,status,trigger_source,note,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      planId, target, targetCharId, sourcePlan.char_id, sourcePlan.gauge_id,
      sourcePlan.study_type || 'GRR', sourcePlan.parts || 10, sourcePlan.operators || 3,
      sourcePlan.trials || 3, sourcePlan.planned_date || '', sourcePlan.owner || '',
      '计划', sourcePlan.trigger_source || '项目复制', '由来源项目 MSA 计划复制',
      DB.now(), DB.now()
    );
  }
  const templates = all('SELECT * FROM doc_template WHERE project_id=?', source.project_id);
  for (const template of templates) {
    const tplId = uniqueId('TPL', target);
    let sourcePath = null;
    if (template.source_path) {
      const oldFile = path.join(TEMPLATE_DIR, path.basename(template.source_path));
      if (fs.existsSync(oldFile)) {
        sourcePath = `${tplId}-${path.basename(template.source_path).replace(/^[^-]+-/, '')}`;
        fs.copyFileSync(oldFile, path.join(TEMPLATE_DIR, sourcePath));
      }
    }
    DB.db.prepare(`INSERT INTO doc_template(
      tpl_id,name,phase,source,filename,schema_json,status,pct,created_at,created_by,
      updated_at,doc_code,project_id,mapping_json,mapping_status,approved_by,approved_at,source_path
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tplId, template.name, template.phase, template.source, template.filename,
      template.schema_json, '草稿', 0, DB.now(), template.created_by, DB.now(),
      template.doc_code, target, template.mapping_json || '[]',
      template.mapping_status || '未配置', template.approved_by, template.approved_at, sourcePath
    );
  }
}

function deleteProjectCascade(projectId) {
  return DB.tx(() => {
    const fmeaIds = all('SELECT fmea_id FROM fmea_header WHERE project_id=?', projectId).map(r => r.fmea_id);
    const cpIds = all('SELECT cp_id FROM control_plan WHERE project_id=?', projectId).map(r => r.cp_id);
    const baselineIds = all('SELECT baseline_id FROM baseline WHERE project_id=?', projectId).map(r => r.baseline_id);
    const rowIds = fmeaIds.length
      ? all(`SELECT row_id FROM fmea_row WHERE fmea_id IN (${fmeaIds.map(() => '?').join(',')})`, ...fmeaIds).map(r => r.row_id)
      : [];
    const nodeIds = fmeaIds.length
      ? all(`SELECT node_id FROM fmea_node WHERE fmea_id IN (${fmeaIds.map(() => '?').join(',')})`, ...fmeaIds).map(r => r.node_id)
      : [];
    const cpRowIds = cpIds.length
      ? all(`SELECT cp_row_id FROM cp_row WHERE cp_id IN (${cpIds.map(() => '?').join(',')})`, ...cpIds).map(r => r.cp_row_id)
      : [];
    const monIds = cpRowIds.length
      ? all(`SELECT mon_id FROM monitoring_item WHERE cp_row_id IN (${cpRowIds.map(() => '?').join(',')})`, ...cpRowIds).map(r => r.mon_id)
      : [];
    if (monIds.length) DB.db.prepare(`DELETE FROM spc_dataset WHERE mon_id IN (${monIds.map(() => '?').join(',')})`).run(...monIds);
    if (cpRowIds.length) DB.db.prepare(`DELETE FROM monitoring_item WHERE cp_row_id IN (${cpRowIds.map(() => '?').join(',')})`).run(...cpRowIds);
    if (cpRowIds.length) {
      DB.db.prepare(`DELETE FROM cp_fmea_link WHERE cp_row_id IN (${cpRowIds.map(() => '?').join(',')})`)
        .run(...cpRowIds);
      DB.db.prepare(`DELETE FROM cp_stage_link WHERE target_cp_row_id IN (${cpRowIds.map(() => '?').join(',')})
        OR source_cp_row_id IN (${cpRowIds.map(() => '?').join(',')})`).run(...cpRowIds, ...cpRowIds);
    }
    if (cpIds.length) {
      DB.db.prepare(`DELETE FROM cp_row WHERE cp_id IN (${cpIds.map(() => '?').join(',')})`).run(...cpIds);
      DB.db.prepare(`DELETE FROM control_plan WHERE cp_id IN (${cpIds.map(() => '?').join(',')})`).run(...cpIds);
    }
    if (rowIds.length) {
      DB.db.prepare(`DELETE FROM fmea_action WHERE row_id IN (${rowIds.map(() => '?').join(',')})`).run(...rowIds);
      DB.db.prepare(`DELETE FROM fmea_decision WHERE row_id IN (${rowIds.map(() => '?').join(',')})`).run(...rowIds);
      DB.db.prepare(`DELETE FROM fmea_row WHERE row_id IN (${rowIds.map(() => '?').join(',')})`).run(...rowIds);
    }
    if (nodeIds.length) {
      DB.db.prepare(`DELETE FROM fmea_failure_cand WHERE node_id IN (${nodeIds.map(() => '?').join(',')})`).run(...nodeIds);
      DB.db.prepare(`DELETE FROM fmea_function WHERE node_id IN (${nodeIds.map(() => '?').join(',')})`).run(...nodeIds);
      DB.db.prepare(`DELETE FROM fmea_node WHERE node_id IN (${nodeIds.map(() => '?').join(',')})`).run(...nodeIds);
    }
    if (fmeaIds.length) {
      DB.db.prepare(`DELETE FROM fmea_image WHERE fmea_id IN (${fmeaIds.map(() => '?').join(',')})`).run(...fmeaIds);
      DB.db.prepare(`DELETE FROM fmea_header WHERE fmea_id IN (${fmeaIds.map(() => '?').join(',')})`).run(...fmeaIds);
    }
    if (baselineIds.length) {
      DB.db.prepare(`DELETE FROM baseline_item WHERE baseline_id IN (${baselineIds.map(() => '?').join(',')})`).run(...baselineIds);
      DB.db.prepare(`DELETE FROM baseline WHERE baseline_id IN (${baselineIds.map(() => '?').join(',')})`).run(...baselineIds);
    }
    const changeIds = all('SELECT cr_id FROM change_request WHERE project_id=?', projectId).map(r => r.cr_id);
    if (changeIds.length) {
      DB.db.prepare(`DELETE FROM change_item WHERE cr_id IN (${changeIds.map(() => '?').join(',')})`).run(...changeIds);
    }
    for (const template of all('SELECT source_path FROM doc_template WHERE project_id=?', projectId)) {
      if (!template.source_path) continue;
      const sourceFile = path.join(TEMPLATE_DIR, path.basename(template.source_path));
      if (fs.existsSync(sourceFile)) fs.unlinkSync(sourceFile);
    }
    // 附件文件与记录一起删：否则同编号重建项目时旧图片会“复活”
    const projectDir = path.join(ATTACHMENT_DIR, String(projectId).replace(/[^A-Za-z0-9._-]/g, '_'));
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (e) { /* 文件被占用时下次再清 */ }
    for (const table of [
      'doc_attachment',
      'project_doc_revision', 'project_doc', 'apqp_phase', 'apqp_task', 'ppap_element',
      'ppap_package', 'process_step', 'gate_review', 'ecr', 'activity_approval',
      'export_event', 'change_request', 'doc_template', 'project_char', 'msa_study', 'msa_plan_item',
      'deliverable_field_mapping', 'deliverable_sync_item', 'deliverable_sync_snapshot', 'project_member'
    ]) {
      try { DB.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId); } catch (e) { /* 兼容旧库 */ }
    }
    DB.db.prepare('DELETE FROM project WHERE project_id=?').run(projectId);
  });
}

route('GET', /^\/api\/meta$/, () => {
  const project = q(`SELECT p.*,pf.code family_code,pf.name family_name,
      ps.code series_code,ps.name series_name
    FROM project p
    LEFT JOIN product_family pf ON pf.family_id=p.family_id
    LEFT JOIN product_series ps ON ps.series_id=p.series_id
    WHERE p.project_id=?`, CUR);
  return {
    project,
    phases: all('SELECT * FROM apqp_phase WHERE project_id=? ORDER BY phase', CUR),
    fmeaTypes: all('SELECT DISTINCT fmea_type, fmea_id, title, rev FROM fmea_header WHERE project_id=?', CUR),
    cp: q(`SELECT * FROM control_plan WHERE project_id=?`, CUR),
    stageLabel: { PROTO: '样件', PILOT: '试生产', SOP: '量产' },
    // Q-16：默认值由服务端统一下发，页面不再散落硬编码
    defaults: { cpk_target: DB.DEFAULT_CPK_TARGET },
  };
});

route('POST', /^\/api\/projects$/, (m, body) => {
  // 新建项目会生成整树数据并复制来源项目内容，只允许管理员
  requirePermission('project.manage', '新建项目');
  return createProjectCore(body);
});

route('DELETE', /^\/api\/projects\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const p = q('SELECT * FROM project WHERE project_id=?', id);
  if (!p) throw new Error('项目不存在');
  if (q('SELECT COUNT(*) c FROM project').c <= 1) throw new Error('至少保留一个项目');
  deleteProjectCascade(id);
  L.audit(actorName(), '删除', 'project', id, p, null, '删除项目');
  return { ok: true };
}, { roles: ['admin'] });

route('GET', /^\/api\/projects$/, () => {
  const user = requestContext.getStore()?.user;
  const rows = all(`SELECT p.*,pf.code family_code,pf.name family_name,
      ps.code series_code,ps.name series_name,
      (SELECT COUNT(*) FROM project_doc d WHERE d.project_id=p.project_id
        AND COALESCE(d.hidden,0)=0
        AND d.status IN ('已完成','已批准','系统模块')) done_docs,
      (SELECT COUNT(*) FROM project_doc d WHERE d.project_id=p.project_id AND COALESCE(d.hidden,0)=0) total_docs,
      (SELECT COUNT(*) FROM project_doc d WHERE d.project_id=p.project_id AND d.status IN ('草稿','待审核')) draft_docs,
      (SELECT COUNT(*) FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id WHERE h.project_id=p.project_id) fmea_rows,
      (SELECT COUNT(*) FROM cp_row c JOIN control_plan t ON t.cp_id=c.cp_id WHERE t.project_id=p.project_id) cp_rows,
      (SELECT COUNT(*) FROM process_step s WHERE s.project_id=p.project_id AND s.pfd_mode='PROCESS') steps,
      (SELECT COUNT(*) FROM baseline b WHERE b.project_id=p.project_id) baselines
    FROM project p
    LEFT JOIN product_family pf ON pf.family_id=p.family_id
    LEFT JOIN product_series ps ON ps.series_id=p.series_id
    ORDER BY p.project_id`)
    // 只返回当前账号有权访问的项目，避免项目切换器暴露其他项目
    .filter(r => !user || canAccessProject(user, r.project_id));
  return {
    current: CUR,
    list: rows.map(r => ({ ...r, pct: r.total_docs ? Math.round((r.done_docs / r.total_docs) * 100) : 0 })),
  };
});

/* 项目成员：管理员维护。
   未配置成员的项目对全部账号开放（演示兼容模式）；一旦配置，就只有成员 + 管理员可访问。 */
route('GET', /^\/api\/admin\/projects\/([^/]+)\/members$/, (m) => {
  const projectId = decodePart(m[1]);
  if (!q('SELECT 1 FROM project WHERE project_id=?', projectId)) throw new Error('项目不存在');
  const members = new Set(all('SELECT user_id FROM project_member WHERE project_id=?', projectId)
    .map(r => r.user_id));
  return {
    project_id: projectId,
    configured: members.size > 0,
    users: all('SELECT user_id,username,display_name,role,status FROM auth_user ORDER BY user_id')
      .map(u => ({ ...u, member: members.has(u.user_id) })),
  };
});
route('PUT', /^\/api\/admin\/projects\/([^/]+)\/members$/, (m, body) => {
  const projectId = decodePart(m[1]);
  if (!q('SELECT 1 FROM project WHERE project_id=?', projectId)) throw new Error('项目不存在');
  const ids = Array.isArray(body.user_ids) ? [...new Set(body.user_ids.map(String).filter(Boolean))] : [];
  for (const id of ids) {
    if (!q('SELECT 1 FROM auth_user WHERE user_id=?', id)) throw new Error(`账号不存在：${id}`);
  }
  DB.tx(() => {
    DB.db.prepare('DELETE FROM project_member WHERE project_id=?').run(projectId);
    const ins = DB.db.prepare('INSERT OR IGNORE INTO project_member(project_id,user_id,created_at) VALUES(?,?,?)');
    for (const id of ids) ins.run(projectId, id, DB.now());
    L.audit(actorName(), '配置项目成员', 'project', projectId, null, { user_ids: ids },
      ids.length ? '限定可访问该项目的账号' : '清空成员（兼容模式：所有账号可访问）');
  });
  return { ok: true, count: ids.length };
}, { roles: ['admin'] });

route('GET', /^\/api\/product-families$/, () => ({
  list: all("SELECT * FROM product_family WHERE COALESCE(status,'生效')<>'作废' ORDER BY code"),
}));

route('POST', /^\/api\/product-families$/, (m, body) => {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  if (!code || !name) throw new Error('产品族编码和名称不能为空');
  if (q('SELECT 1 FROM product_family WHERE family_id=? OR code=?', body.family_id || '', code)) {
    throw new Error('产品族编码已存在');
  }
  const id = String(body.family_id || `FM-${idPart(code)}-${Date.now().toString(36).toUpperCase()}`);
  DB.db.prepare('INSERT INTO product_family(family_id,code,name,category,status) VALUES(?,?,?,?,?)')
    .run(id, code, name, category, body.status === '作废' ? '作废' : '生效');
  L.audit(body.user || '产品字典', '新增', 'product_family', id, null, body, '新增产品族/类别');
  return { ok: true, family_id: id };
});

route('PATCH', /^\/api\/product-families\/([^/]+)$/, (m, body) => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM product_family WHERE family_id=?', id);
  if (!old) throw new Error('产品族不存在');
  const next = {
    code: body.code !== undefined ? String(body.code).trim() : old.code,
    name: body.name !== undefined ? String(body.name).trim() : old.name,
    category: body.category !== undefined ? String(body.category).trim() : (old.category || ''),
    status: body.status !== undefined ? body.status : old.status,
  };
  if (!next.code || !next.name) throw new Error('产品族编码和名称不能为空');
  if (!['生效', '作废'].includes(next.status)) throw new Error('无效的产品族状态');
  if (q('SELECT 1 FROM product_family WHERE code=? AND family_id<>?', next.code, id)) throw new Error('产品族编码已存在');
  DB.db.prepare('UPDATE product_family SET code=?,name=?,category=?,status=? WHERE family_id=?')
    .run(next.code, next.name, next.category, next.status, id);
  L.audit(body.user || '产品字典', '修改', 'product_family', id, old, next, '维护产品族/类别');
  return { ok: true };
});

route('GET', /^\/api\/product-series$/, (m, body, query) => {
  const familyId = String(query.get('family') || '').trim();
  const list = familyId
    ? all("SELECT * FROM product_series WHERE family_id=? AND COALESCE(status,'生效')<>'作废' ORDER BY code", familyId)
    : all("SELECT * FROM product_series WHERE COALESCE(status,'生效')<>'作废' ORDER BY family_id,code");
  return { list };
});

route('POST', /^\/api\/product-series$/, (m, body) => {
  const familyId = String(body.family_id || '').trim();
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!familyId || !code || !name) throw new Error('所属产品族、系列编码和名称不能为空');
  if (!q("SELECT 1 FROM product_family WHERE family_id=? AND COALESCE(status,'生效')<>'作废'", familyId)) throw new Error('所属产品族不存在或已作废');
  if (q('SELECT 1 FROM product_series WHERE series_id=? OR (family_id=? AND code=?)', body.series_id || '', familyId, code)) {
    throw new Error('产品系列编码已存在');
  }
  const id = String(body.series_id || `SR-${idPart(code)}-${Date.now().toString(36).toUpperCase()}`);
  DB.db.prepare('INSERT INTO product_series(series_id,family_id,code,name,status) VALUES(?,?,?,?,?)')
    .run(id, familyId, code, name, body.status === '作废' ? '作废' : '生效');
  L.audit(body.user || '产品字典', '新增', 'product_series', id, null, body, '新增产品系列/型号');
  return { ok: true, series_id: id };
});

route('PATCH', /^\/api\/product-series\/([^/]+)$/, (m, body) => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM product_series WHERE series_id=?', id);
  if (!old) throw new Error('产品系列不存在');
  const next = {
    family_id: body.family_id !== undefined ? String(body.family_id).trim() : old.family_id,
    code: body.code !== undefined ? String(body.code).trim() : old.code,
    name: body.name !== undefined ? String(body.name).trim() : old.name,
    status: body.status !== undefined ? body.status : old.status,
  };
  if (!next.family_id || !next.code || !next.name) throw new Error('所属产品族、系列编码和名称不能为空');
  if (!q("SELECT 1 FROM product_family WHERE family_id=? AND COALESCE(status,'生效')<>'作废'", next.family_id)) throw new Error('所属产品族不存在或已作废');
  if (!['生效', '作废'].includes(next.status)) throw new Error('无效的产品系列状态');
  if (q('SELECT 1 FROM product_series WHERE family_id=? AND code=? AND series_id<>?', next.family_id, next.code, id)) throw new Error('产品系列编码已存在');
  DB.db.prepare('UPDATE product_series SET family_id=?,code=?,name=?,status=? WHERE series_id=?')
    .run(next.family_id, next.code, next.name, next.status, id);
  L.audit(body.user || '产品字典', '修改', 'product_series', id, old, next, '维护产品系列/型号');
  return { ok: true };
});

route('GET', /^\/api\/character-sources$/, () => {
  const refs = all(`SELECT source_type,source_ref,COUNT(*) count
    FROM char_master WHERE TRIM(COALESCE(source_ref,''))<>'' GROUP BY source_type,source_ref
    ORDER BY source_type,source_ref`);
  const docs = all(`SELECT doc_code code,doc_code name FROM project_doc WHERE project_id=? AND COALESCE(hidden,0)=0 ORDER BY doc_code`, CUR);
  const ecr = all(`SELECT ecr_id code,title name FROM ecr WHERE project_id=? ORDER BY created_at DESC`, CUR);
  // D-10：受控来源词表由服务端下发，前端 datalist 与之一致
  return { refs, docs, ecr, source_types: CHAR_SOURCE_TYPES };
});

route('GET', /^\/api\/dashboard$/, () => L.dashboard(CUR));

route('GET', /^\/api\/ap-matrix$/, () => ({
  rows: all('SELECT s,o,d,ap FROM ap_matrix ORDER BY s,o,d'),
  summary: all('SELECT ap,COUNT(*) count FROM ap_matrix GROUP BY ap ORDER BY ap'),
}));

route('PATCH', /^\/api\/ap-matrix$/, (m, body) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new Error('没有 AP 矩阵变更');
  requirePermission('apmatrix.manage', '修改 AP 矩阵');
  const approver = actorName();
  for (const row of rows) {
    if (![row.s, row.o, row.d].every(value => Number.isInteger(+value) && +value >= 1 && +value <= 10)) {
      throw new Error('AP 矩阵 S/O/D 必须为 1–10');
    }
    if (!['H', 'M', 'L'].includes(row.ap)) throw new Error('AP 值必须为 H/M/L');
  }
  const approvalId = recordApproval({
    projectId: CUR, actionType: 'AP_MATRIX_CHANGE', objectType: 'ap_matrix',
    objectId: 'AP-2019', title: `批准 AP 矩阵变更（${rows.length} 格）`,
    payload: { rows }, approvedBy: approver,
    requestedBy: approver, note: body.note || 'AP 矩阵校对',
  });
  DB.tx(() => {
    const update = DB.db.prepare('UPDATE ap_matrix SET ap=? WHERE s=? AND o=? AND d=?');
    for (const row of rows) update.run(row.ap, +row.s, +row.o, +row.d);
  });
  L.audit(approver, '修改', 'ap_matrix', 'AP-2019', null,
    { rows: rows.length, approvalId }, body.note || 'AP 矩阵校对');
  return { ok: true, updated: rows.length, approval_id: approvalId };
});

function projectCharacterRows(projectId) {
  const project = q('SELECT * FROM project WHERE project_id=?', projectId) || {};
  const identified = new Set();
  const approvedDocs = all(`SELECT d.doc_code,r.data_json FROM project_doc d JOIN project_doc_revision r
      ON r.rev_id=(SELECT r2.rev_id FROM project_doc_revision r2
        WHERE r2.project_id=d.project_id AND r2.doc_code=d.doc_code
          AND r2.status='已批准' AND TRIM(COALESCE(r2.approved_by,''))<>''
        ORDER BY COALESCE(r2.approved_at,r2.changed_at) DESC,r2.rowid DESC LIMIT 1)
    WHERE d.project_id=? AND d.doc_code IN ('P1-11','P2-11') AND COALESCE(d.hidden,0)=0`, projectId);
  for (const doc of approvedDocs) {
    try {
      for (const row of JSON.parse(doc.data_json || '{}').chars || []) {
        if (Array.isArray(row) && String(row[0] || '').trim()) identified.add(String(row[0]).trim());
      }
    } catch (e) { /* 历史交付物损坏时仍可维护项目特性 */ }
  }
  const items = all(`SELECT pc.*, cm.family_id, cm.series_id, cm.status master_status,
      pf.code family_code,pf.name family_name,ps.code series_code,ps.name series_name,
      (SELECT COUNT(*) FROM cp_row r JOIN control_plan cp ON cp.cp_id=r.cp_id
        WHERE cp.project_id=pc.project_id
          AND (r.project_char_id=pc.pchar_id OR (r.project_char_id IS NULL AND r.char_id=pc.char_id))) cp_count,
      (SELECT COUNT(*) FROM fmea_row fr JOIN fmea_header fh ON fh.fmea_id=fr.fmea_id
        WHERE fh.project_id=pc.project_id
          AND (fr.char_id=pc.char_id OR fr.process_char_id=pc.char_id)) fmea_count,
      (SELECT COUNT(*) FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
        JOIN control_plan cp ON cp.cp_id=r.cp_id
        WHERE cp.project_id=pc.project_id
          AND (m.project_char_id=pc.pchar_id OR (m.project_char_id IS NULL AND m.char_id=pc.char_id))) monitor_count,
      (SELECT COUNT(*) FROM msa_study ms WHERE ms.project_id=pc.project_id
        AND (ms.project_char_id=pc.pchar_id OR (ms.project_char_id IS NULL AND ms.char_id=pc.char_id))) msa_count
    FROM project_char pc
    LEFT JOIN char_master cm ON cm.char_id=pc.char_id
    LEFT JOIN product_family pf ON pf.family_id=cm.family_id
    LEFT JOIN product_series ps ON ps.series_id=cm.series_id
    WHERE pc.project_id=?
    ORDER BY pc.is_special DESC, pc.char_kind DESC, pc.char_id`, projectId);
  const imported = new Set(items.map(item => item.char_id));
  const dictionary = all(`SELECT cm.*,pf.code family_code,pf.name family_name,
      ps.code series_code,ps.name series_name,
      EXISTS(SELECT 1 FROM project_char pc WHERE pc.project_id=? AND pc.char_id=cm.char_id) imported
    FROM char_master cm
    LEFT JOIN product_family pf ON pf.family_id=cm.family_id
    LEFT JOIN product_series ps ON ps.series_id=cm.series_id
    WHERE COALESCE(cm.status,'生效')<>'作废'
      AND (cm.family_id=? OR cm.family_id IS NULL)
      AND (cm.series_id IS NULL OR cm.series_id=?)
    ORDER BY CASE WHEN cm.series_id IS NULL THEN 1 ELSE 0 END,cm.char_kind DESC, cm.char_id`,
  projectId, project.family_id || '', project.series_id || '');
  const mappedItems = items.map(item => ({
      ...item,
      identified: identified.has(item.char_id),
      used_in: [
        item.cp_count ? 'CP' : '',
        item.fmea_count ? 'FMEA' : '',
        item.monitor_count ? 'SPC' : '',
        item.msa_count ? 'MSA' : '',
      ].filter(Boolean),
    }));
  mappedItems.sort((a, b) =>
    Number(b.identified) - Number(a.identified)
    || Number(b.used_in.length > 0) - Number(a.used_in.length > 0)
    || String(a.char_id).localeCompare(String(b.char_id)));
  return {
    items: mappedItems,
    dictionary: dictionary.map(item => ({ ...item, imported: !!item.imported || imported.has(item.char_id) })),
    project,
    families: all("SELECT * FROM product_family WHERE COALESCE(status,'生效')<>'作废' ORDER BY code"),
    series: all("SELECT * FROM product_series WHERE family_id=? AND COALESCE(status,'生效')<>'作废' ORDER BY code",
      project.family_id || ''),
  };
}

route('GET', /^\/api\/project-chars$/, () => projectCharacterRows(CUR));

route('PATCH', /^\/api\/project-chars\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('项目特性不存在');
  const nullableNumber = (value, fallback) => {
    if (value === undefined) return fallback;
    if (value === '' || value === null) return null;
    const number = +value;
    if (!Number.isFinite(number)) throw new Error('目标值和规范限必须是有效数字');
    return number;
  };
  const next = {
    ...old,
    name: body.name !== undefined ? String(body.name).trim() : old.name,
    description: body.description !== undefined ? String(body.description).trim() : old.description,
    char_kind: body.char_kind !== undefined ? body.char_kind : old.char_kind,
    domain: body.domain !== undefined ? String(body.domain).trim() : old.domain,
    unit: body.unit !== undefined ? String(body.unit).trim() : old.unit,
    target: nullableNumber(body.target, old.target),
    lsl: nullableNumber(body.lsl, old.lsl),
    usl: nullableNumber(body.usl, old.usl),
    tol_text: body.tol_text !== undefined ? String(body.tol_text).trim() : old.tol_text,
    is_special: body.is_special !== undefined ? (body.is_special ? 1 : 0)
      : (body.special_symbol ? 1 : old.is_special),
    special_symbol: body.special_symbol !== undefined
      ? String(body.special_symbol).trim() : old.special_symbol,
    source_type: body.source_type !== undefined ? String(body.source_type).trim() : old.source_type,
    source_ref: body.source_ref !== undefined ? String(body.source_ref).trim() : old.source_ref,
    status: body.status !== undefined ? String(body.status).trim() : old.status,
  };
  if (!next.name) throw new Error('特性名称不能为空');
  if (!['PRODUCT', 'PROCESS'].includes(next.char_kind)) throw new Error('特性类型必须为产品特性或过程特性');
  if (next.lsl != null && next.usl != null && next.lsl >= next.usl) {
    throw new Error('规范下限 LSL 必须小于上限 USL');
  }
  if (next.target != null && ((next.lsl != null && next.target < next.lsl)
      || (next.usl != null && next.target > next.usl))) {
    throw new Error('目标值必须位于规范上下限之间');
  }
  if (body.tol_text === undefined && (body.lsl !== undefined || body.usl !== undefined)) {
    next.tol_text = next.lsl != null && next.usl != null
      ? `${next.lsl} ~ ${next.usl} ${next.unit || ''}`.trim() : next.tol_text;
  }
  DB.db.prepare(`UPDATE project_char SET
    name=?,description=?,char_kind=?,domain=?,unit=?,target=?,lsl=?,usl=?,tol_text=?,is_special=?,
    special_symbol=?,source_type=?,source_ref=?,status=?,updated_at=?
    WHERE pchar_id=? AND project_id=?`).run(
    next.name, next.description || '', next.char_kind, next.domain || '', next.unit || '', next.target, next.lsl,
    next.usl, next.tol_text || '', next.is_special ? 1 : 0, next.special_symbol || '',
    next.source_type || '', next.source_ref || '', next.status || '生效', DB.now(), id, CUR
  );
  // D-03：规范字段变化时，由 reconcileCharacteristicSpecs 在同一事务内
  // 更新 CP spec_text、降草稿、重置 SPC 审核并刷新 MSA 计划快照。
  const specChanged = CHARACTERISTIC_SPEC_FIELDS.some(field =>
    !specificationSame(old[field], next[field]));
  const sync = syncProjectDeliverables(CUR, { pcharIds: specChanged ? [id] : [] });
  L.audit(body.user || actorName(), '修改', 'project_char', id, old,
    { ...next, downstream: sync.spec }, body.note || '调整项目特性参数');
  return {
    ok: true, sync, spec_changed: specChanged,
    item: projectCharacterRows(CUR).items.find(item => item.pchar_id === id),
  };
}));

route('POST', /^\/api\/project-chars\/from-dictionary$/, (m, body) => {
  const charId = String(body.char_id || '').trim();
  if (!charId) throw new Error('请选择特性字典中的特性');
  const item = DB.ensureProjectChar(CUR, charId);
  L.audit(body.user || actorName(), '引入', 'project_char', item.pchar_id, null,
    { char_id: charId }, body.note || '从产品族特性字典引入项目');
  return { ok: true, item: projectCharacterRows(CUR).items.find(row => row.pchar_id === item.pchar_id) };
});

route('GET', /^\/api\/chars$/, () =>
  all(`SELECT c.*,pf.code family_code,pf.name family_name,ps.code series_code,ps.name series_name,
        (SELECT COUNT(*) FROM char_link l WHERE l.product_char_id=c.char_id AND COALESCE(l.status,'生效')<>'作废') out_links,
        (SELECT COUNT(*) FROM char_link l WHERE l.process_char_id=c.char_id AND COALESCE(l.status,'生效')<>'作废') in_links
      FROM char_master c
      LEFT JOIN product_family pf ON pf.family_id=c.family_id
      LEFT JOIN product_series ps ON ps.series_id=c.series_id
      ORDER BY c.char_kind DESC, c.char_id`));

route('POST', /^\/api\/ai\/character-name$/, async (m, body) => {
  const description = String(body.description || '').trim();
  if (!description) throw new Error('请先用大白话描述产品特性或过程特性');
  const kind = body.char_kind === 'PROCESS' ? 'PROCESS' : 'PRODUCT';
  const project = q(`SELECT p.*,pf.name family_name,ps.name series_name
    FROM project p LEFT JOIN product_family pf ON pf.family_id=p.family_id
    LEFT JOIN product_series ps ON ps.series_id=p.series_id WHERE p.project_id=?`, CUR) || {};
  const key = getSetting('ai_key', '');
  const model = getSetting('ai_model', '');
  const base = getSetting('ai_base_url', 'https://api.openai.com/v1').replace(/\/+$/, '');
  const system = `你是 AIAG-VDA PFMEA 第三版教材中的特性定义专家。
要求：
1. 特性是产品可测量属性或过程控制参数，不是动作、功能或失效。
2. 名称必须是简单扼要的名词短语，通常 2-12 个汉字，不能包含“控制、确保、实现、提高、防止”等动词，不能包含数值。
3. 描述说明对象和可测量要求，一句话，不超过 50 个汉字。
4. 若输入包含数值、公差、上下限或单位，提取为标准 target/lsl/usl/tol_text；没有则留空。
5. 产品特性示例：阻值精度、涂层厚度、耐电压；过程特性示例：激光功率、退火温度、网版张力。
6. 只输出 JSON。`;
  const user = `项目：${project.name || ''}
产品族/系列：${project.family_name || ''} / ${project.series_name || ''}
特性类型：${kind === 'PRODUCT' ? '产品特性' : '过程特性'}
用户的原始描述：${description}

输出格式：
{"name":"简明特性名称","description":"一句话定义","domain":"电气/尺寸/工艺参数/外观/环境","unit":"","target":null,"lsl":null,"usl":null,"tol_text":"","special_symbol":"","rationale":""}`;
  let result = null;
  let source = 'local';
  let note = '';
  if (key && model) {
    try {
      const parsed = await requestAiJson({ base, key, model, system, user });
      const name = String(parsed.name || '').trim();
      if (name && name.length <= 16 && !/控制|确保|实现|提高|防止|失效|功能/.test(name)) {
        result = {
          name,
          description: String(parsed.description || description).trim().slice(0, 80),
          domain: String(parsed.domain || '').trim(),
          unit: String(parsed.unit || '').trim(),
          target: parsed.target === '' || parsed.target == null ? null : +parsed.target,
          lsl: parsed.lsl === '' || parsed.lsl == null ? null : +parsed.lsl,
          usl: parsed.usl === '' || parsed.usl == null ? null : +parsed.usl,
          tol_text: String(parsed.tol_text || '').trim(),
          special_symbol: String(parsed.special_symbol || '').trim(),
          rationale: String(parsed.rationale || '').trim(),
        };
        source = 'ai';
      }
    } catch (e) {
      note = 'AI 特性标准化失败：' + netErr(e);
    }
  }
  if (!result) {
    const rules = [
      { re: /槽深|切槽深度/, name: '切槽深度', domain: '尺寸', unit: 'μm' },
      { re: /膜层厚度|膜厚/, name: '膜层厚度', domain: '尺寸', unit: 'μm' },
      { re: /涂层厚度|涂覆厚度/, name: '涂层厚度', domain: '尺寸', unit: 'μm' },
      { re: /阻值|电阻值/, name: '阻值精度', domain: '电气', unit: 'kΩ' },
      { re: /耐压|耐电压/, name: '耐电压', domain: '电气', unit: 'V' },
      { re: /温度系数|TCR/i, name: '温度系数', domain: '电气', unit: 'ppm/℃' },
      { re: /退火温度|炉温|温度/, name: kind === 'PROCESS' ? '工艺温度' : '工作温度', domain: '工艺参数', unit: '℃' },
      { re: /压力/, name: '工艺压力', domain: '工艺参数', unit: 'MPa' },
      { re: /激光功率|功率/, name: '激光功率', domain: '工艺参数', unit: 'W' },
      { re: /张力/, name: '网版张力', domain: '工艺参数', unit: 'N/cm' },
      { re: /速度|速率/, name: '加工速度', domain: '工艺参数', unit: 'mm/s' },
      { re: /时间|时长/, name: '处理时间', domain: '工艺参数', unit: 's' },
      { re: /宽度|槽宽/, name: '槽宽', domain: '尺寸', unit: 'μm' },
      { re: /位置|偏移/, name: '加工位置偏差', domain: '尺寸', unit: 'mm' },
      { re: /清洁|残留/, name: '表面清洁度', domain: '清洁度', unit: '' },
      { re: /硬度/, name: '材料硬度', domain: '材料', unit: 'HV' },
    ];
    const hit = rules.find(rule => rule.re.test(description));
    const name = hit ? hit.name : description
      .replace(/[，。；：、,.!?！？]/g, ' ')
      .split(/\s+/).filter(Boolean).slice(0, 2).join('').slice(0, 10) || (kind === 'PRODUCT' ? '产品特性' : '过程特性');
    const unitMap = { '微米': 'μm', '毫米': 'mm', '摄氏度': '℃', '分钟': 'min', '兆帕': 'MPa' };
    const unitPattern = '(微米|毫米|摄氏度|分钟|兆帕|μm|um|mm|℃|W|V|%|s|min|N|MPa)';
    const targetMatch = description.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, 'i'));
    const toleranceMatch = description.match(new RegExp(`(?:±|允许偏差|公差)\\s*(\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, 'i'));
    const rawUnit = targetMatch?.[2] || toleranceMatch?.[2] || '';
    const unit = hit?.unit || unitMap[rawUnit] || rawUnit;
    const target = targetMatch ? +targetMatch[1] : null;
    const tolerance = toleranceMatch ? +toleranceMatch[1] : null;
    result = {
      name,
      description: description.slice(0, 80),
      domain: hit?.domain || (kind === 'PRODUCT' ? '产品要求' : '工艺参数'),
      unit,
      target,
      lsl: target != null && tolerance != null ? target - tolerance : null,
      usl: target != null && tolerance != null ? target + tolerance : null,
      tol_text: target != null && tolerance != null ? `${target}±${tolerance} ${unit}`.trim()
        : target != null ? `${target} ${unit}`.trim() : '',
      special_symbol: /关键|特殊|安全|CC|SC/i.test(description) ? (/安全/i.test(description) ? 'SAFETY' : 'CC') : '',
      rationale: '外部 AI 不可用时，根据关键词和数值规则生成，请人工复核',
    };
  }
  return {
    source,
    ...result,
    note: note || (source === 'ai'
      ? 'AI 已将口语描述标准化为特性定义，请复核后保存。'
      : 'AI 不可用，已用本地规则生成特性定义，请复核后保存。'),
  };
});

route('POST', /^\/api\/chars$/, (m, body) => DB.tx(() => {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  if (!name) throw new Error('特性名称不能为空');
  const kind = body.char_kind === 'PROCESS' ? 'PROCESS' : 'PRODUCT';
  const lsl = body.lsl != null && body.lsl !== '' ? +body.lsl : null;
  const usl = body.usl != null && body.usl !== '' ? +body.usl : null;
  const target = body.target != null && body.target !== '' ? +body.target : null;
  if (lsl != null && usl != null && lsl >= usl) throw new Error('规格下限必须小于上限');
  if (target != null && ((lsl != null && target < lsl) || (usl != null && target > usl))) {
    throw new Error('目标值必须位于规格上下限之间');
  }
  const prefix = kind === 'PRODUCT' ? 'CHR-D-' : 'CHR-P-';
  const max = q(`SELECT MAX(CAST(substr(char_id, 8) AS INTEGER)) m FROM char_master WHERE char_id LIKE ?`, prefix + '%').m || 0;
  const id = prefix + String(max + 1).padStart(4, '0');
  // D-05：特殊特性符号保留原文（可含 CC/SC/SAFETY 多标记），is_special 只是派生字段
  const symbol = String(body.special_symbol || '').trim();
  const familyId = String(body.family_id || (q('SELECT family_id FROM project WHERE project_id=?', CUR) || {}).family_id || 'FM').trim();
  const seriesId = String(body.series_id || '').trim() || null;
  const source = normalizeCharSource(body.source_type || '内部', body.source_ref || '');
  if (seriesId) {
    const series = q("SELECT 1 FROM product_series WHERE series_id=? AND family_id=? AND COALESCE(status,'生效')<>'作废'", seriesId, familyId);
    if (!series) throw new Error('产品系列不存在或不属于所选产品族');
  }
  DB.db.prepare(`INSERT INTO char_master(
    char_id,name,description,char_kind,domain,unit,target,lsl,usl,tol_text,is_special,
    special_symbol,source_type,source_ref,family_id,status,series_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, name, description, kind, body.domain || '', body.unit || '', target, lsl, usl,
    body.tol_text || '', (body.is_special || symbol) ? 1 : 0, symbol,
    source.type, source.ref, familyId,
    body.status || '生效', seriesId
  );
  // D-04：可从同一事务直接引入当前项目，避免“先建字典、再引入”中途失败留下半成品
  let item = null;
  if (body.import_project) item = DB.ensureProjectChar(CUR, id);
  L.audit(actorName(),'新增', 'char_master', id, null, body, '新增特性');
  // D-10：受控词表之外的历史自定义来源仍允许保存，但明确提示，便于逐步收敛
  return {
    ok: true, char_id: id, item,
    source_type: source.type,
    source_warning: source.recognized ? '' : `来源类型“${source.type}”不在受控词表中`,
  };
}));

route('PATCH', /^\/api\/chars\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM char_master WHERE char_id=?', id);
  if (!old) throw new Error('特性不存在');
  const name = body.name !== undefined ? String(body.name).trim() : old.name;
  if (!name) throw new Error('名称不能为空');
  const next = {
    description: body.description !== undefined ? String(body.description).trim() : old.description,
    unit: body.unit !== undefined ? body.unit : old.unit,
    target: body.target !== undefined ? (body.target === '' ? null : +body.target) : old.target,
    lsl: body.lsl !== undefined ? (body.lsl === '' ? null : +body.lsl) : old.lsl,
    usl: body.usl !== undefined ? (body.usl === '' ? null : +body.usl) : old.usl,
    tol_text: body.tol_text !== undefined ? body.tol_text : old.tol_text,
    special_symbol: body.special_symbol !== undefined ? String(body.special_symbol).trim() : old.special_symbol,
    domain: body.domain !== undefined ? body.domain : old.domain,
    source_type: old.source_type,
    source_ref: old.source_ref,
    family_id: body.family_id !== undefined ? String(body.family_id).trim() : old.family_id,
    series_id: body.series_id !== undefined ? (String(body.series_id).trim() || null) : old.series_id,
  };
  // D-10：只校验本次提交的来源字段，历史数据原样保留
  let source = { type: next.source_type, ref: next.source_ref, recognized: true };
  if (body.source_type !== undefined || body.source_ref !== undefined) {
    source = normalizeCharSource(
      body.source_type !== undefined ? body.source_type : next.source_type,
      body.source_ref !== undefined ? body.source_ref : next.source_ref,
      { validateRef: body.source_ref !== undefined },
    );
    next.source_type = source.type;
    next.source_ref = source.ref;
  }
  if (next.lsl != null && next.usl != null && next.lsl >= next.usl) throw new Error('规格下限必须小于上限');
  if (next.target != null && ((next.lsl != null && next.target < next.lsl) || (next.usl != null && next.target > next.usl))) {
    throw new Error('目标值必须位于规格上下限之间');
  }
  if (body.tol_text === undefined && (body.lsl !== undefined || body.usl !== undefined)) {
    next.tol_text = next.lsl != null && next.usl != null
      ? `${next.lsl} ~ ${next.usl} ${next.unit || ''}`.trim() : next.tol_text;
  }
  // D-05：符号原文保留多标记；is_special 由符号或显式标记派生，不吞掉已有特殊状态
  const isSpecial = next.special_symbol ? 1 : (body.is_special !== undefined
    ? (body.is_special ? 1 : 0) : (old.is_special ? 1 : 0));
  if (next.series_id) {
    const series = q("SELECT 1 FROM product_series WHERE series_id=? AND family_id=? AND COALESCE(status,'生效')<>'作废'", next.series_id, next.family_id);
    if (!series) throw new Error('产品系列不存在或不属于所选产品族');
  }
  DB.db.prepare(`UPDATE char_master SET
    name=?,description=?,unit=?,target=?,special_symbol=?,is_special=?,lsl=?,usl=?,tol_text=?,
    domain=?,source_type=?,source_ref=?,family_id=?,series_id=?
    WHERE char_id=?`).run(
    name, next.description || '', next.unit, next.target, next.special_symbol, isSpecial, next.lsl, next.usl,
    next.tol_text, next.domain, next.source_type, next.source_ref,
    next.family_id || null, next.series_id, id
  );
  // D-03：特性主数据是项目特性的导入来源。只更新“仍与旧主数据一致”的项目副本，
  // 已被 P2-11/项目特性人工确认的副本保留项目特定规范，避免共享字典覆盖受控值。
  const copies = all(`SELECT * FROM project_char
    WHERE char_id=? AND COALESCE(status,'生效')<>'作废'`, id);
  const affected = new Map();
  let preserved = 0;
  for (const copy of copies) {
    const untouched = CHARACTERISTIC_SPEC_FIELDS.every(field =>
      specificationSame(copy[field], old[field]));
    if (!untouched) { preserved += 1; continue; }
    const changed = CHARACTERISTIC_SPEC_FIELDS.some(field =>
      !specificationSame(copy[field], next[field]));
    if (!changed) continue;
    DB.db.prepare(`UPDATE project_char SET unit=?,target=?,lsl=?,usl=?,tol_text=?,updated_at=?
      WHERE pchar_id=? AND project_id=?`).run(
      next.unit || '', next.target, next.lsl, next.usl, next.tol_text || '', DB.now(),
      copy.pchar_id, copy.project_id
    );
    if (!affected.has(copy.project_id)) affected.set(copy.project_id, []);
    affected.get(copy.project_id).push(copy.pchar_id);
  }
  const propagation = {
    project_chars: 0, projects: [], preserved_local: preserved,
    spec: { characteristics: 0, cp_rows: 0, monitoring_items: 0, msa_plans: 0 },
  };
  const addSpec = spec => {
    for (const field of Object.keys(propagation.spec)) {
      propagation.spec[field] += Number(spec?.[field] || 0);
    }
  };
  let sync = null;
  for (const [projectId, pcharIds] of affected) {
    propagation.project_chars += pcharIds.length;
    propagation.projects.push(projectId);
    if (projectId === CUR) {
      sync = syncProjectDeliverables(CUR, { pcharIds });
      addSpec(sync.spec);
    } else {
      addSpec(reconcileCharacteristicSpecs(projectId, pcharIds));
      DB.ensureMsaPlans(projectId);
    }
  }
  L.audit(actorName(),'修改', 'char_master', id, old, { ...body, propagation },
    '修改特性主数据并同步下游规范');
  return {
    ok: true, propagation, sync,
    source_warning: source.recognized ? '' : `来源类型“${source.type}”不在受控词表中`,
  };
}));

route('DELETE', /^\/api\/chars\/([^/]+)$/, (m) => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM char_master WHERE char_id=?', id);
  if (!old) throw new Error('特性不存在');
  // D-02：特性是 PFMEA → CP → SPC/MSA → PPAP 主线的锚点，删除前检查全部引用表，
  // 只要有一处引用就不允许物理删除（否则下游会静默失去规范与依据）。
  const refs = [
    { label: 'PFMEA 行（产品特性）', n: q('SELECT COUNT(*) c FROM fmea_row WHERE char_id=?', id).c },
    { label: 'PFMEA 行（过程特性）', n: q('SELECT COUNT(*) c FROM fmea_row WHERE process_char_id=?', id).c },
    { label: '控制计划行（特性编号）', n: q('SELECT COUNT(*) c FROM cp_row WHERE char_id=?', id).c },
    { label: '控制计划行（项目特性）', n: q(`SELECT COUNT(*) c FROM cp_row WHERE project_char_id IN
      (SELECT pchar_id FROM project_char WHERE char_id=?)`, id).c },
    { label: '项目特性记录', n: q('SELECT COUNT(*) c FROM project_char WHERE char_id=?', id).c },
    { label: 'SPC 监控项', n: q(`SELECT COUNT(*) c FROM monitoring_item
      WHERE char_id=? OR project_char_id IN (SELECT pchar_id FROM project_char WHERE char_id=?)`, id, id).c },
    { label: 'MSA 计划项', n: q(`SELECT COUNT(*) c FROM msa_plan_item
      WHERE COALESCE(source_active,1)<>0 AND (char_id=? OR project_char_id IN
      (SELECT pchar_id FROM project_char WHERE char_id=?))`, id, id).c },
    { label: '特性关联', n: q('SELECT COUNT(*) c FROM char_link WHERE product_char_id=? OR process_char_id=?', id, id).c },
  ].filter(item => item.n > 0);
  if (refs.length) {
    const used = refs.reduce((sum, item) => sum + item.n, 0);
    throw Object.assign(
      new Error(`该特性仍被 ${used} 处引用（${refs.map(item => `${item.label} ${item.n}`).join('、')}），不能删除；请先在上游解除关联后再删除`),
      { statusCode: 409, details: { references: refs } }
    );
  }
  DB.db.prepare('DELETE FROM char_master WHERE char_id=?').run(id);
  L.audit(actorName(),'删除', 'char_master', id, old, null, '删除特性');
  return { ok: true };
});

route('GET', /^\/api\/chars\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const c = q('SELECT * FROM char_master WHERE char_id=?', id);
  if (!c) throw new Error('特性不存在');
  const down = all(`SELECT l.*, p.name pname, p.unit punit, p.lsl, p.usl, p.tol_text, p.is_special, p.special_symbol
     FROM char_link l JOIN char_master p ON p.char_id=l.process_char_id
     WHERE l.product_char_id=? AND COALESCE(l.status,'生效')<>'作废'`, id);
  const up = all(`SELECT l.*, p.name pname,p.unit punit,p.lsl,p.usl,p.tol_text
     FROM char_link l JOIN char_master p ON p.char_id=l.product_char_id
     WHERE l.process_char_id=? AND COALESCE(l.status,'生效')<>'作废'`, id);
  const charIds = [...new Set([
    id,
    ...down.map(link => link.process_char_id),
    ...up.map(link => link.product_char_id),
  ])];
  const charPlaceholders = charIds.map(() => '?').join(',');
  const projectChars = all(`SELECT pchar_id,char_id FROM project_char
    WHERE project_id=? AND char_id IN (${charPlaceholders})`, CUR, ...charIds);
  const projectCharIds = projectChars.map(row => row.pchar_id);
  const projectCharPlaceholders = projectCharIds.length
    ? projectCharIds.map(() => '?').join(',')
    : 'NULL';
  const cpRows = all(`SELECT c.*, s.name sname, s.step_no, p.stage, p.status cp_status, p.rev cp_rev
    FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
    LEFT JOIN process_step s ON s.step_id=c.step_id
    WHERE p.project_id=? AND (
      c.char_id IN (${charPlaceholders})
      OR c.project_char_id IN (${projectCharPlaceholders})
    )
    ORDER BY s.seq,c.seq`, CUR, ...charIds, ...projectCharIds);
  const mons = all(`SELECT m.* FROM monitoring_item m
    JOIN cp_row c ON c.cp_row_id=m.cp_row_id
    JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE p.project_id=? AND c.cp_row_id IN (${cpRows.length ? cpRows.map(() => '?').join(',') : 'NULL'})`,
    CUR, ...cpRows.map(row => row.cp_row_id));
  const fmeaRows = all(`SELECT r.row_id,r.fmea_id,h.fmea_type,r.func_id,
      f.text function_text,r.char_id,r.process_char_id,r.step_id,
      s.step_no,s.name step_name,nm.name failure_mode,r.ap,r.s,r.o,r.d,
      r.pc_text,r.dc_text
    FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    LEFT JOIN fmea_function f ON f.func_id=r.func_id
    LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
    LEFT JOIN process_step s ON s.step_id=r.step_id
    WHERE h.project_id=? AND (r.char_id IN (${charPlaceholders})
      OR r.process_char_id IN (${charPlaceholders}))
    ORDER BY h.fmea_type,s.seq,r.seq`, CUR, ...charIds, ...charIds);
  const msaPlans = all(`SELECT p.*,s.study_id,s.judgment,s.pct_tol,s.ndc
    FROM msa_plan_item p
    LEFT JOIN msa_study s ON s.study_id=p.study_id
    WHERE p.project_id=? AND (
      p.char_id IN (${charPlaceholders})
      OR p.project_char_id IN (${projectCharPlaceholders})
    ) ORDER BY p.created_at`, CUR, ...charIds, ...projectCharIds);
  return { char: c, down, up, projectChars, cpRows, mons, fmeaRows, msaPlans };
});

route('GET', /^\/api\/char-links$/, () => ({
  // S-02 / D-07：只返回当前项目引用到的特性之间的关联，不暴露其他项目数据
  list: all(`SELECT l.*, p.name product_name, process.name process_name
    FROM char_link l
    JOIN char_master p ON p.char_id=l.product_char_id
    JOIN char_master process ON process.char_id=l.process_char_id
    WHERE COALESCE(l.status,'生效')<>'作废'
      AND EXISTS(SELECT 1 FROM project_char pc WHERE pc.project_id=? AND pc.char_id=l.product_char_id)
      AND EXISTS(SELECT 1 FROM project_char pc WHERE pc.project_id=? AND pc.char_id=l.process_char_id)
    ORDER BY l.product_char_id, l.link_id`, CUR, CUR),
}));

route('POST', /^\/api\/char-links$/, (m, body) => {
  const productId = String(body.product_char_id || '').trim();
  const processId = String(body.process_char_id || '').trim();
  const mechanism = String(body.mechanism || '').trim();
  if (!productId || !processId) throw new Error('必须同时选择产品特性和过程特性');
  const product = q('SELECT * FROM char_master WHERE char_id=?', productId);
  const process = q('SELECT * FROM char_master WHERE char_id=?', processId);
  if (!product || product.char_kind !== 'PRODUCT') throw new Error('产品特性无效');
  if (!process || process.char_kind !== 'PROCESS') throw new Error('过程特性无效');
  if (!mechanism) throw new Error('必须填写传递机理');
  // D-06：同一产品-过程特性对只能有一条有效关联（历史 status 为 NULL 也视为生效）
  const dup = q(`SELECT 1 FROM char_link WHERE product_char_id=? AND process_char_id=?
    AND COALESCE(status,'生效')<>'作废'`, productId, processId);
  if (dup) throw new Error('该特性关联已存在；如需修改方向或机理，请编辑现有记录');
  const direction = ['正相关', '负相关', '非线性', '阈值型'].includes(body.direction) ? body.direction : '非线性';
  const strength = ['强', '中', '弱'].includes(body.strength) ? body.strength : '中';
  const result = DB.db.prepare(`INSERT INTO char_link(
    product_char_id,process_char_id,direction,strength,mechanism,evidence_ref,
    valid_baseline,created_by,created_at,status
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    productId, processId, direction, strength, mechanism, body.evidence_ref || '',
    body.valid_baseline || '', body.user || actorName(), DB.now(), '生效'
  );
  L.audit(body.user || actorName(), '新增', 'char_link', result.lastInsertRowid, null, body, '维护特性关联');
  return { ok: true, link_id: Number(result.lastInsertRowid) };
});

route('PATCH', /^\/api\/char-links\/(\d+)$/, (m, body) => {
  const id = +m[1];
  const old = q('SELECT * FROM char_link WHERE link_id=?', id);
  if (!old) throw new Error('特性关联不存在');
  const allowed = ['direction', 'strength', 'mechanism', 'evidence_ref', 'valid_baseline', 'status'];
  const sets = [];
  const values = [];
  for (const field of allowed) {
    if (body[field] !== undefined) {
      sets.push(`${field}=?`);
      values.push(body[field]);
    }
  }
  if (!sets.length) return { ok: true };
  if (body.mechanism !== undefined && !String(body.mechanism).trim()) throw new Error('传递机理不能为空');
  values.push(id);
  DB.db.prepare(`UPDATE char_link SET ${sets.join(',')} WHERE link_id=?`).run(...values);
  L.audit(body.user || actorName(), '修改', 'char_link', id, old, body, '维护特性关联');
  return { ok: true };
});

route('DELETE', /^\/api\/char-links\/(\d+)$/, (m) => {
  const id = +m[1];
  const old = q('SELECT * FROM char_link WHERE link_id=?', id);
  if (!old) throw new Error('特性关联不存在');
  DB.db.prepare("UPDATE char_link SET status='作废' WHERE link_id=?").run(id);
  L.audit(actorName(),'删除', 'char_link', id, old, { status: '作废' }, '作废特性关联');
  return { ok: true };
});

function validateStepForPublish(step) {
  const missing = [];
  if (!String(step.name || '').trim()) missing.push('工序名称');
  if (!String(step.step_no || '').trim()) missing.push('工序号');
  if (!String(step.step_type || '').trim()) missing.push('工序类型');
  if (['检验', '特殊过程', '制造', '工序'].includes(step.step_type)
      && !String(step.equipment || '').trim()) missing.push('设备/检具');
  if (!String(step.input_desc || '').trim()) missing.push('输入');
  if (!String(step.output_desc || '').trim()) missing.push('输出');
  if (missing.length) throw new Error('发布前必须补全：' + missing.join('、'));
}

/* P-06：P1-10（INITIAL）与 P3-04（PROCESS）的派生与一致性检查。
   派生只新增缺失的 PROCESS 工序并用 origin_step_id 记录来源，重复执行不会重复建；
   一致性检查回答三件事：哪些初始工序还没进过程版、哪些过程工序是后加的、有哪些改过。 */
const PFD_COMPARE_FIELDS = ['step_no', 'name', 'step_type', 'equipment', 'fixture', 'input_desc', 'output_desc'];
const pfdStepBrief = step => ({
  step_id: step.step_id, step_no: step.step_no || '', name: step.name || '',
  step_type: step.step_type || '', status: step.status || '',
  parent_step_id: step.parent_step_id || null,
});

function pfdConsistency(projectId) {
  const initial = all(`SELECT * FROM process_step
    WHERE project_id=? AND pfd_mode='INITIAL' ORDER BY seq,step_id`, projectId);
  const process = all(`SELECT * FROM process_step
    WHERE project_id=? AND pfd_mode='PROCESS' ORDER BY seq,step_id`, projectId);
  const initialById = new Map(initial.map(step => [step.step_id, step]));
  const liveInitial = initial.filter(step => step.status !== '作废');
  const liveProcess = process.filter(step => step.status !== '作废');
  const processByOrigin = new Map();
  for (const step of liveProcess) {
    if (step.origin_step_id) processByOrigin.set(step.origin_step_id, step);
  }
  const missing = liveInitial.filter(step => !processByOrigin.has(step.step_id));
  // 没有来源的过程工序＝阶段 3 自行新增（或来自批量导入/手工录入）
  const added = liveProcess.filter(step => !step.origin_step_id);
  // 来源初始工序已被作废/删除，但过程版仍在用
  const sourceObsolete = liveProcess.filter(step => step.origin_step_id
    && (!initialById.has(step.origin_step_id) || initialById.get(step.origin_step_id).status === '作废'));
  const changed = [];
  for (const [originId, step] of processByOrigin) {
    const source = initialById.get(originId);
    if (!source || source.status === '作废') continue;
    const fields = PFD_COMPARE_FIELDS.filter(field =>
      String(source[field] ?? '') !== String(step[field] ?? ''));
    if (fields.length) {
      changed.push({ origin_step_id: originId, fields, initial: pfdStepBrief(source), process: pfdStepBrief(step) });
    }
  }
  const originCounts = new Map();
  for (const step of liveProcess) {
    if (!step.origin_step_id) continue;
    originCounts.set(step.origin_step_id, (originCounts.get(step.origin_step_id) || 0) + 1);
  }
  const duplicateOrigin = [...originCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([originId, count]) => ({
      origin_step_id: originId,
      initial: initialById.has(originId) ? pfdStepBrief(initialById.get(originId)) : null,
      count,
      process: liveProcess.filter(step => step.origin_step_id === originId).map(pfdStepBrief),
    }));
  const byNo = new Map();
  for (const step of liveProcess) {
    const key = String(step.step_no || '').trim();
    if (!key) continue;
    if (!byNo.has(key)) byNo.set(key, []);
    byNo.get(key).push(step);
  }
  const stepNoConflicts = [...byNo.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([stepNo, rows]) => ({ step_no: stepNo, steps: rows.map(pfdStepBrief) }));
  const doc = q(`SELECT status, version FROM project_doc WHERE project_id=? AND doc_code='P1-10'`, projectId);
  return {
    initial_total: liveInitial.length,
    process_total: liveProcess.length,
    derived: liveProcess.length - added.length - sourceObsolete.length,
    missing_in_process: missing.map(pfdStepBrief),
    added_in_process: added.map(pfdStepBrief),
    changed,
    source_obsolete: sourceObsolete.map(step => ({ ...pfdStepBrief(step), origin_step_id: step.origin_step_id })),
    duplicate_origin: duplicateOrigin,
    step_no_conflicts: stepNoConflicts,
    initial_doc_status: doc ? doc.status : '',
    consistent: !missing.length && !added.length && !changed.length
      && !sourceObsolete.length && !duplicateOrigin.length,
  };
}

route('GET', /^\/api\/pfd\/consistency$/, () => ({ ok: true, ...pfdConsistency(CUR) }));

route('POST', /^\/api\/pfd\/derive-from-initial$/, () => DB.tx(() => {
  const initial = all(`SELECT * FROM process_step
    WHERE project_id=? AND pfd_mode='INITIAL' AND COALESCE(status,'')<>'作废' ORDER BY seq,step_id`, CUR);
  if (!initial.length) {
    throw new Error('初始流程图（P1-10）还没有工序，请先在阶段 1 维护初始流程图');
  }
  const liveProcess = all(`SELECT * FROM process_step
    WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废' ORDER BY seq,step_id`, CUR);
  const originToProcess = new Map(liveProcess
    .filter(step => step.origin_step_id)
    .map(step => [step.origin_step_id, step]));
  const initialIds = new Set(initial.map(step => step.step_id));
  // 先父后子：父工序 = 父级不在初始版内的工序（INITIAL 最多两层，与 process_step 约束一致）
  const ordered = [
    ...initial.filter(step => !step.parent_step_id || !initialIds.has(step.parent_step_id)),
    ...initial.filter(step => step.parent_step_id && initialIds.has(step.parent_step_id)),
  ];
  const createdByOrigin = new Map();
  const created = [];
  const skipped = [];
  const usedNo = new Map(liveProcess.map(step => [String(step.step_no || '').trim(), step]));
  const stepNoConflicts = [];
  let seq = liveProcess.reduce((max, step) => Math.max(max, +step.seq || 0), 0);
  const insert = DB.db.prepare(`INSERT INTO process_step(
    step_id,project_id,dict_id,step_no,name,step_type,seq,parent_step_id,equipment,fixture,
    input_desc,output_desc,status,ver,pfd_mode,origin_step_id,change_summary
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const source of ordered) {
    const existing = originToProcess.get(source.step_id);
    if (existing) {
      skipped.push({ ...pfdStepBrief(source), process_step_id: existing.step_id });
      continue;
    }
    const parentTarget = source.parent_step_id
      ? (createdByOrigin.get(source.parent_step_id) || originToProcess.get(source.parent_step_id) || null)
      : null;
    seq += 1;
    const id = uniqueId('PS', CUR);
    insert.run(
      id, CUR, source.dict_id || null, source.step_no || '', source.name || '',
      source.step_type || '工序', seq, parentTarget ? parentTarget.step_id : null,
      source.equipment || '', source.fixture || '', source.input_desc || '', source.output_desc || '',
      '草稿', 'V1.0', 'PROCESS', source.step_id,
      `源自 P1-10 初始流程图 ${source.step_no || ''}`.trim()
    );
    const row = {
      step_id: id, step_no: source.step_no || '', name: source.name || '',
      parent_step_id: parentTarget ? parentTarget.step_id : null, origin_step_id: source.step_id,
    };
    createdByOrigin.set(source.step_id, row);
    created.push(row);
    const key = String(source.step_no || '').trim();
    if (key && usedNo.has(key)) {
      stepNoConflicts.push({ step_no: key, name: source.name || '', existing_step_id: usedNo.get(key).step_id });
    } else if (key) {
      usedNo.set(key, { step_id: id });
    }
  }
  const doc = q(`SELECT status, version FROM project_doc WHERE project_id=? AND doc_code='P1-10'`, CUR);
  if (created.length) {
    L.audit(actorName(), '派生', 'process_step', CUR, null, {
      from: 'P1-10', created: created.length, skipped: skipped.length,
      step_ids: created.map(step => step.step_id),
    }, '从初始流程图派生过程流程图');
  }
  return {
    ok: true,
    created, skipped,
    created_count: created.length,
    skipped_count: skipped.length,
    initial_total: initial.length,
    initial_doc_status: doc ? doc.status : '',
    step_no_conflicts: stepNoConflicts,
  };
}));

route('GET', /^\/api\/process-dict$/, () => ({
  list: all(`SELECT * FROM process_dict ORDER BY
    CASE WHEN status='生效' THEN 0 ELSE 1 END, CAST(code AS INTEGER), code, name`),
}));

// D-09：同一工序编号的有效日期区间不能重叠（只比较生效中的记录）
function assertProcessDictPeriod(code, from, to, excludeId, status = '生效') {
  if (status !== '生效') return;
  const others = all(`SELECT dict_id,effective_from,effective_to FROM process_dict
    WHERE code=? AND COALESCE(status,'生效')='生效' AND dict_id<>?`, code, excludeId || '');
  const start = from || '0000-01-01';
  const end = to || '9999-12-31';
  for (const other of others) {
    const otherStart = other.effective_from || '0000-01-01';
    const otherEnd = other.effective_to || '9999-12-31';
    if (start <= otherEnd && otherStart <= end) {
      throw Object.assign(
        new Error(`工序 ${code} 的生效区间与 ${other.dict_id}（${other.effective_from || '不限'} ~ ${other.effective_to || '不限'}）重叠`),
        { statusCode: 409, details: { dict_id: other.dict_id } }
      );
    }
  }
}

route('POST', /^\/api\/process-dict$/, (m, body) => {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code || !name) throw new Error('工序编号和名称不能为空');
  if (q('SELECT 1 FROM process_dict WHERE code=?', code)) throw new Error('工序字典编号已存在');
  const stepType = body.step_type || '工序';
  if (!['制造', '工序', '检验', '特殊过程', '存储', '搬运'].includes(stepType)) {
    throw new Error('无效的工序类型');
  }
  const status = body.status || '生效';
  if (!['生效', '停用'].includes(status)) throw new Error('无效的字典状态');
  if (body.effective_to && body.effective_from && body.effective_to < body.effective_from) {
    throw new Error('失效日期不能早于生效日期');
  }
  // D-09：同一工序编号的生效区间不得重叠
  assertProcessDictPeriod(code, body.effective_from || DB.now().slice(0, 10),
    body.effective_to || null, null, status);
  const id = uniqueId('PD', code);
  DB.db.prepare(`INSERT INTO process_dict(
    dict_id,code,name,step_type,default_equipment,effective_from,effective_to,status
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    id, code, name, stepType, body.default_equipment || '',
    body.effective_from || DB.now().slice(0, 10), body.effective_to || null, status
  );
  L.audit(body.user || actorName(), '新增', 'process_dict', id, null, body, '新增工序字典');
  return { ok: true, dict_id: id };
});

route('PATCH', /^\/api\/process-dict\/([^/]+)$/, (m, body) => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM process_dict WHERE dict_id=?', id);
  if (!old) throw new Error('工序字典不存在');
  const fields = ['code', 'name', 'step_type', 'default_equipment', 'effective_from', 'effective_to', 'status'];
  const next = { ...old, ...body };
  next.code = String(next.code || '').trim();
  next.name = String(next.name || '').trim();
  if (!next.code || !next.name) throw new Error('工序编号和名称不能为空');
  if (!['制造', '工序', '检验', '特殊过程', '存储', '搬运'].includes(next.step_type)) {
    throw new Error('无效的工序类型');
  }
  if (!['生效', '停用'].includes(next.status)) throw new Error('无效的字典状态');
  if (next.effective_to && next.effective_from && next.effective_to < next.effective_from) {
    throw new Error('失效日期不能早于生效日期');
  }
  if (next.code !== old.code && q('SELECT 1 FROM process_dict WHERE code=? AND dict_id<>?', next.code, id)) {
    throw new Error('工序字典编号已存在');
  }
  // 只在校验相关字段发生变化时检查区间，避免历史重复编号导致普通编辑被误拦
  if (['code', 'effective_from', 'effective_to', 'status'].some(field => body[field] !== undefined)) {
    assertProcessDictPeriod(next.code, next.effective_from, next.effective_to, id, next.status);
  }
  const sets = [];
  const values = [];
  for (const field of fields) {
    if (body[field] !== undefined) {
      sets.push(`${field}=?`);
      values.push(field === 'effective_to' ? (body[field] || null) : body[field]);
    }
  }
  if (!sets.length) return { ok: true };
  values.push(id);
  DB.db.prepare(`UPDATE process_dict SET ${sets.join(',')} WHERE dict_id=?`).run(...values);
  L.audit(body.user || actorName(), '修改', 'process_dict', id, old, body, '维护工序字典');
  return { ok: true };
});

route('POST', /^\/api\/process-dict\/([^/]+)\/use$/, (m, body) => {
  const id = decodePart(m[1]);
  const dict = q("SELECT * FROM process_dict WHERE dict_id=? AND status='生效'", id);
  if (!dict) throw new Error('工序字典不存在或已失效');
  const today = DB.now().slice(0, 10);
  if ((dict.effective_from && dict.effective_from > today)
      || (dict.effective_to && dict.effective_to < today)) {
    throw new Error('该工序字典当前不在有效日期范围内');
  }
  const mode = pfdMode(body.mode);
  const seq = (q('SELECT MAX(seq) m FROM process_step WHERE project_id=? AND pfd_mode=?', CUR, mode).m || 0) + 1;
  const stepId = uniqueId('PS', CUR);
  DB.db.prepare(`INSERT INTO process_step(
    step_id,project_id,dict_id,step_no,name,step_type,seq,equipment,fixture,input_desc,output_desc,status,ver,pfd_mode
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    stepId, CUR, dict.dict_id, dict.code, dict.name, dict.step_type, seq,
    dict.default_equipment || '', '', '', '', '草稿', 'V1.0', mode
  );
  L.audit(actorName(),'引用', 'process_dict', dict.dict_id, null, { step_id: stepId, mode }, '从工序字典新增工序');
  return { ok: true, step_id: stepId };
});

route('GET', /^\/api\/steps$/, (m, body, query) => {
  const mode = pfdMode(query.get('mode'));
  return (
  all(`SELECT s.*, (SELECT COUNT(*) FROM fmea_row r WHERE r.step_id=s.step_id) fmea_rows,
       (SELECT COUNT(*) FROM process_step c
        WHERE c.parent_step_id=s.step_id AND COALESCE(c.status,'')<>'作废') child_count,
       o.step_no origin_step_no, o.name origin_name, o.status origin_status
       FROM process_step s LEFT JOIN process_step o ON o.step_id=s.origin_step_id
       WHERE s.project_id=? AND s.pfd_mode=? AND COALESCE(s.status,'')<>'作废' ORDER BY s.seq`,
  CUR, mode));
});

route('POST', /^\/api\/steps$/, (m, body) => {
  const mode = pfdMode(body.mode);
  const seq = (q('SELECT MAX(seq) m FROM process_step WHERE project_id=? AND pfd_mode=?', CUR, mode).m || 0) + 1;
  let parent = null;
  if (body.parent_step_id) {
    parent = q(`SELECT * FROM process_step WHERE step_id=? AND project_id=? AND pfd_mode=?
      AND COALESCE(status,'')<>'作废'`, body.parent_step_id, CUR, mode);
    if (!parent) throw new Error('所属工序不存在或已作废');
    if (parent.parent_step_id) throw new Error('工步下不能继续新增子工步');
    if (parent.status === '已发布') throw new Error('请先撤回所属工序的发布，再新增工步');
  }
  const topCount = q(`SELECT COUNT(*) c FROM process_step
    WHERE project_id=? AND pfd_mode=? AND parent_step_id IS NULL AND COALESCE(status,'')<>'作废'`, CUR, mode).c;
  const childRows = parent ? all(`SELECT step_no FROM process_step
    WHERE project_id=? AND pfd_mode=? AND parent_step_id=? AND COALESCE(status,'')<>'作废'`,
  CUR, mode, parent.step_id) : [];
  const maxChildNo = childRows.reduce((max, child) => {
    const suffix = Number(String(child.step_no || '').split('-')[1]);
    return Number.isFinite(suffix) ? Math.max(max, suffix) : max;
  }, 0);
  const parentNo = parent ? String(parent.step_no || '').split('-')[0] : '';
  const step = body.step_no || (parent
    ? `${parentNo}-${maxChildNo + 1}`
    : String((topCount + 1) * 10).padStart(3, '0'));
  // P-03：同一项目 + 同一流程图模式下工序号唯一，避免下游按工序号无法区分
  if (q(`SELECT 1 FROM process_step WHERE project_id=? AND pfd_mode=? AND step_no=?
      AND COALESCE(status,'')<>'作废' LIMIT 1`, CUR, mode, step)) {
    throw Object.assign(new Error(`工序号 ${step} 在该流程图中已存在`), { statusCode: 409 });
  }
  const id = uniqueId('PS', CUR);
  DB.db.prepare(`INSERT INTO process_step(
    step_id,project_id,dict_id,step_no,name,step_type,seq,parent_step_id,equipment,fixture,
    input_desc,output_desc,status,ver,pfd_mode
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, CUR, body.dict_id || null, step, body.name || '新工序', body.step_type || '制造', seq,
    parent ? parent.step_id : null, body.equipment || '', body.fixture || '', body.input_desc || '',
    body.output_desc || '', '草稿', body.ver || 'V1.0', mode
  );
  L.audit(actorName(),'新增', 'process_step', id, null, body,
    parent ? `${mode} PFD 在 ${parent.name} 下新增工步` : `${mode} PFD 新增工序`);
  return { step_id: id, step_no: step, pfd_mode: mode };
});

route('PATCH', /^\/api\/steps\/([^/]+)$/, (m, body, query) => DB.tx(() => {
  const id = m[1];
  const old = requireCurrentProject('SELECT * FROM process_step WHERE step_id=? AND project_id=?', id);
  if (!old) throw new Error('工序不存在');
  const requestedMode = body.mode || query.get('mode');
  if (requestedMode && old.pfd_mode !== pfdMode(requestedMode)) throw new Error('工序不属于当前流程图阶段');
  const effectiveBody = { ...body };
  if (old.status === '已发布' && body.status === undefined) {
    throw new Error('已发布工序需先撤回发布再编辑');
  }
  if (body.status === '已发布') {
    const match = /^V?(\d+)\.(\d+)$/i.exec(old.ver || 'V1.0');
    effectiveBody.ver = match ? `V${match[1]}.${+match[2] + 1}` : 'V1.1';
    effectiveBody.published_at = DB.now();
    effectiveBody.published_by = actorName();
    effectiveBody.change_summary = body.change_summary || 'PFD 发布';
  }
  // 作废与删除受同一保护：被 PFMEA / 控制计划引用的工序不能直接作废
  if (body.status === '作废' && old.status !== '作废') {
    const activeChildren = q(`SELECT COUNT(*) c FROM process_step
      WHERE parent_step_id=? AND project_id=? AND COALESCE(status,'')<>'作废'`, id, CUR).c;
    if (activeChildren) {
      throw Object.assign(new Error(`该工序下仍有 ${activeChildren} 个工步，请先处理工步`), { statusCode: 409 });
    }
    const usedFmea = q(`SELECT COUNT(*) c FROM fmea_row r
      JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE r.step_id=? AND h.project_id=?`, id, CUR).c;
    const usedCp = q(`SELECT COUNT(*) c FROM cp_row r
      JOIN control_plan p ON p.cp_id=r.cp_id
      WHERE r.step_id=? AND p.project_id=?`, id, CUR).c;
    if (usedFmea + usedCp) {
      throw Object.assign(
        new Error(`该工序已被 ${usedFmea} 条 PFMEA 行、${usedCp} 条控制计划行引用，不能作废；请先解除引用或改用迁移`),
        { statusCode: 409 }
      );
    }
  }
  const fields = ['step_no', 'name', 'step_type', 'equipment', 'fixture', 'input_desc', 'output_desc',
    'status', 'ver', 'published_at', 'published_by', 'change_summary'];
  if (effectiveBody.step_no !== undefined) {
    // P-03：改号同样不能与同项目同模式的在用工序重复
    const duplicate = q(`SELECT step_id FROM process_step WHERE project_id=? AND pfd_mode=? AND step_no=?
      AND step_id<>? AND COALESCE(status,'')<>'作废' LIMIT 1`,
    CUR, old.pfd_mode || 'PROCESS', String(effectiveBody.step_no).trim(), id);
    if (duplicate) {
      throw Object.assign(new Error(`工序号 ${effectiveBody.step_no} 已被 ${duplicate.step_id} 使用`),
        { statusCode: 409 });
    }
  }
  // P-05：发布人 / 发布时间只能由会话身份与服务端时间生成；撤回时清空
  if (body.status === '已发布') {
    effectiveBody.published_by = actorName();
    effectiveBody.published_at = DB.now();
  } else if (old.status === '已发布' && body.status === '草稿') {
    effectiveBody.published_by = '';
    effectiveBody.published_at = null;
  } else {
    delete effectiveBody.published_by;
    delete effectiveBody.published_at;
  }
  const sets = [], vals = [];
  for (const f of fields) if (effectiveBody[f] !== undefined) { sets.push(`${f}=?`); vals.push(effectiveBody[f]); }
  if (!sets.length) return { ok: true };
  if (body.status === '已发布') {
    // P-02：父工序发布前必须确认子工步也已受控，否则“已发布”在两层含义不一致
    const draftChildren = all(`SELECT step_id, step_no, name, status FROM process_step
      WHERE parent_step_id=? AND project_id=? AND pfd_mode=? AND COALESCE(status,'')<>'作废' AND status<>'已发布'
      ORDER BY seq`, id, CUR, old.pfd_mode || 'PROCESS');
    if (draftChildren.length) {
      throw Object.assign(
        new Error(`该工序下还有 ${draftChildren.length} 个工步未发布，请先发布全部工步再发布父工序`),
        { statusCode: 409, details: { draft_children: draftChildren } }
      );
    }
    validateStepForPublish({ ...old, ...effectiveBody });
  }
  vals.push(id);
  DB.db.prepare(`UPDATE process_step SET ${sets.join(',')} WHERE step_id=? AND project_id=?`).run(...vals, CUR);
  const updated = q('SELECT * FROM process_step WHERE step_id=? AND project_id=?', id, CUR);
  // P-04：发布留新版本快照；撤回留撤回前的已发布版本
  let revision = null;
  if (body.status === '已发布') {
    revision = snapshotStepRevision(updated, `发布 ${updated.ver || ''}`);
  } else if (old.status === '已发布' && body.status === '草稿') {
    revision = snapshotStepRevision(old, `撤回发布前 ${old.ver || ''}`);
  }
  L.audit(actorName(),'修改', 'process_step', id, old, effectiveBody,
    body.status === '已发布' ? 'PFD 发布新版本' : 'PFD 编辑');
  return {
    ok: true, ver: effectiveBody.ver || old.ver, revision,
    sync: syncProjectDeliverables(CUR),
  };
}));

// P-04：工序版本列表 / 快照 / 恢复
route('GET', /^\/api\/steps\/([^/]+)\/revisions$/, (m) => {
  const id = decodePart(m[1]);
  if (!q('SELECT 1 FROM process_step WHERE step_id=? AND project_id=?', id, CUR)) {
    throw new Error('工序不存在');
  }
  return {
    list: all(`SELECT rev_id,step_no,ver,status,changed_by,changed_at,note
      FROM process_step_revision WHERE project_id=? AND step_id=?
      ORDER BY changed_at DESC,rowid DESC`, CUR, id),
  };
});

route('GET', /^\/api\/steps\/([^/]+)\/revisions\/([^/]+)$/, (m) => {
  const id = decodePart(m[1]);
  const revision = q(`SELECT * FROM process_step_revision
    WHERE project_id=? AND step_id=? AND rev_id=?`, CUR, id, decodePart(m[2]));
  if (!revision) throw new Error('工序历史版本不存在');
  let data = {};
  try { data = JSON.parse(revision.data_json || '{}'); } catch (error) { data = {}; }
  return { revision: { ...revision, data_json: undefined }, data };
});

route('POST', /^\/api\/steps\/([^/]+)\/restore\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodePart(m[1]);
  const current = q('SELECT * FROM process_step WHERE step_id=? AND project_id=?', id, CUR);
  if (!current) throw new Error('工序不存在');
  if (current.status === '已发布') {
    throw Object.assign(new Error('已发布工序请先撤回发布，再恢复历史内容'), { statusCode: 409 });
  }
  const revision = q(`SELECT * FROM process_step_revision
    WHERE project_id=? AND step_id=? AND rev_id=?`, CUR, id, decodePart(m[2]));
  if (!revision) throw new Error('工序历史版本不存在');
  let data = {};
  try { data = JSON.parse(revision.data_json || '{}'); } catch (error) { data = {}; }
  snapshotStepRevision(current, `恢复前 ${current.ver || ''}`);
  DB.db.prepare(`UPDATE process_step SET step_no=?,name=?,step_type=?,equipment=?,fixture=?,
    input_desc=?,output_desc=?,status='草稿',ver=?,change_summary=? WHERE step_id=? AND project_id=?`).run(
    data.step_no || current.step_no, data.name || current.name, data.step_type || current.step_type,
    data.equipment || '', data.fixture || '', data.input_desc || '', data.output_desc || '',
    `${revision.ver || current.ver || 'V1.0'}`,
    `恢复自 ${revision.rev_id}`, id, CUR
  );
  L.audit(actorName(), '恢复', 'process_step', id, current,
    { status: '草稿', restored_from: revision.rev_id, ver: revision.ver }, body.note || '恢复工序历史版本');
  return { ok: true, status: '草稿', restored_from: revision.rev_id };
}));

route('DELETE', /^\/api\/steps\/([^/]+)$/, (m, body, query) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const step = requireCurrentProject('SELECT * FROM process_step WHERE step_id=? AND project_id=?', id);
  if (!step) throw new Error('工序不存在');
  if (query.get('mode') && step.pfd_mode !== pfdMode(query.get('mode'))) throw new Error('工序不属于当前流程图阶段');
  const activeChildren = q(`SELECT COUNT(*) c FROM process_step
    WHERE parent_step_id=? AND project_id=? AND COALESCE(status,'')<>'作废'`, id, CUR).c;
  if (activeChildren) throw new Error(`该工序下仍有 ${activeChildren} 个工步，请先处理工步`);
  const used = q(`SELECT COUNT(*) c FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    WHERE r.step_id=? AND h.project_id=?`, id, CUR).c
    + q(`SELECT COUNT(*) c FROM cp_row r
      JOIN control_plan p ON p.cp_id=r.cp_id
      WHERE r.step_id=? AND p.project_id=?`, id, CUR).c;
  if (used) throw new Error(`该工序已被 ${used} 处引用，不能直接删除`);
  DB.db.prepare("UPDATE process_step SET status='作废' WHERE step_id=? AND project_id=?").run(id, CUR);
  L.audit(actorName(),'删除', 'process_step', id, step, { status: '作废' }, '作废工序');
  return { ok: true, sync: syncProjectDeliverables(CUR) };
}));

route('POST', /^\/api\/steps\/reorder$/, (m, body) => {
  const ids = Array.isArray(body.step_ids) ? body.step_ids : [];
  if (!ids.length) throw new Error('缺少工序顺序');
  const mode = pfdMode(body.mode);
  const activeSteps = all(
    `SELECT step_id,parent_step_id FROM process_step
     WHERE project_id=? AND pfd_mode=? AND COALESCE(status,'')<>'作废' ORDER BY seq`,
    CUR, mode
  );
  const existing = new Set(activeSteps.map(x => x.step_id));
  const topSteps = activeSteps.filter(step =>
    !step.parent_step_id || !existing.has(step.parent_step_id));
  const topIds = new Set(topSteps.map(step => step.step_id));
  if (ids.some(id => !topIds.has(id))) throw new Error('工序顺序中包含无效的顶层 OP');
  if (ids.length !== topSteps.length || new Set(ids).size !== ids.length) {
    throw new Error('工序顺序必须包含全部顶层 OP 且不能重复');
  }
  DB.tx(() => {
    let order = 1;
    ids.forEach((id, index) => {
      const baseNo = String((index + 1) * 10).padStart(3, '0');
      DB.db.prepare('UPDATE process_step SET seq=?,step_no=? WHERE step_id=? AND project_id=?')
        .run(order++, baseNo, id, CUR);
      const children = all(`SELECT step_id FROM process_step
        WHERE project_id=? AND pfd_mode=? AND parent_step_id=? AND COALESCE(status,'')<>'作废' ORDER BY seq`,
      CUR, mode, id);
      children.forEach((child, childIndex) => {
        DB.db.prepare('UPDATE process_step SET seq=?,step_no=? WHERE step_id=? AND project_id=?')
          .run(order++, `${baseNo}-${childIndex + 1}`, child.step_id, CUR);
      });
    });
  });
  const steps = all(
    `SELECT s.*, (SELECT COUNT(*) FROM fmea_row r WHERE r.step_id=s.step_id) fmea_rows
     FROM process_step s WHERE s.project_id=? AND s.pfd_mode=? AND COALESCE(s.status,'')<>'作废' ORDER BY s.seq`,
    CUR, mode
  );
  L.audit(actorName(),'调整', 'process_step', CUR,
    { before: activeSteps.map(step => step.step_id) },
    { step_ids: ids, step_nos: steps.map(step => step.step_no) }, `${mode} PFD 工序排序并重排工序号`);
  return { ok: true, steps, pfd_mode: mode };
});

route('GET', /^\/api\/fmea$/, (m, body, query) => {
  const type = (query.get('type') || 'DFMEA').toUpperCase();
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!h) throw new Error('未找到 FMEA');
  const nodes = all(
    "SELECT * FROM fmea_node WHERE fmea_id=? AND COALESCE(status,'生效')<>'作废' ORDER BY node_type, seq",
    h.fmea_id
  );
  const rows = all(`SELECT r.*, nf.name fe_name, nm.name fm_name, nc.name fc_name,
      c.name char_name, c.tol_text, pc.name process_char_name, s.name step_name, s.step_no,
      d.decision, d.rationale, d.approved_by, d.review_due, d.status dstatus,
      focus.status focus_status,
      (SELECT COUNT(*) FROM fmea_action a WHERE a.row_id=r.row_id) actions
    FROM fmea_row r
    LEFT JOIN fmea_node nf ON nf.node_id=r.fe_id
    LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
    LEFT JOIN fmea_node nc ON nc.node_id=r.fc_id
    LEFT JOIN char_master c ON c.char_id=r.char_id
    LEFT JOIN char_master pc ON pc.char_id=r.process_char_id
    LEFT JOIN process_step s ON s.step_id=r.step_id
    LEFT JOIN fmea_decision d ON d.row_id=r.row_id
    LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
    WHERE r.fmea_id=?
      AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')
    ORDER BY r.seq`, h.fmea_id);
  for (const r of rows) {
    r.acts = all('SELECT * FROM fmea_action WHERE row_id=? ORDER BY action_id', r.row_id);
  }
  const functions = all(`SELECT f.* FROM fmea_function f
      JOIN fmea_node n ON n.node_id=f.node_id WHERE n.fmea_id=?
        AND COALESCE(n.status,'生效')<>'作废'
      ORDER BY f.node_id, CASE f.status WHEN '正式' THEN 0 ELSE 1 END, f.seq`, h.fmea_id);
  // F-02：AP 矩阵由后端下发，前端实时预览不得再维护一份硬编码副本
  const apMatrix = all('SELECT s,o,d,ap FROM ap_matrix');
  return { header: h, nodes, rows, functions, apMatrix };
});

/** 按名称找节点，没有就建（FE/FM/FC 通用） */
function makeNodeFinder(h) {
  let seq = 0;
  const next = () => {
    if (!seq) seq = (q('SELECT MAX(seq) m FROM fmea_node WHERE fmea_id=?', h.fmea_id).m || 0);
    return ++seq;
  };
  return (name, subtype, parentId) => {
    const clean = String(name || '').trim();
    // 占位符不算真实内容，不建节点
    if (!clean || /^[（(]\s*待补充\s*[）)]$/.test(clean) || clean === '—') return null;
    const hit = q(`SELECT node_id FROM fmea_node
      WHERE fmea_id=? AND node_subtype=? AND name=? AND (parent_id IS ? OR parent_id=?)
        AND COALESCE(status,'生效')<>'作废'`,
      h.fmea_id, subtype, clean, parentId || null, parentId || null);
    if (hit) return hit.node_id;
    const id = 'N-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 9000 + 1000);
    DB.db.prepare('INSERT INTO fmea_node(node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, h.fmea_id, parentId || null, 'FAILURE', subtype, next(), clean, null, null);
    return id;
  };
}

route('POST', /^\/api\/fmea\/row$/, (m, body) => {
  const db = DB.db;
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, body.fmea_type || 'PFMEA');
  // 失效影响三场景：分别评级，S 取三者最大值（AIAG-VDA P41-44）
  const num = v => (v === null || v === undefined || v === '' ? null : +v);
  let sp = num(body.s_plant), ss = num(body.s_ship), su = num(body.s_user);
  for (const [nm, v] of [['您的工厂', sp], ['发运至工厂', ss], ['最终用户', su]]) {
    if (v != null && !(v >= 1 && v <= 10)) throw new Error(`严重度（${nm}）必须为 1–10`);
  }
  let s = Math.max(sp || 0, ss || 0, su || 0, +body.s || 0);
  // F-11：只传总 S 时，把 S 回填到“最终用户”场景，避免行表有 S、场景列全空
  if (sp == null && ss == null && su == null && s >= 1 && s <= 10) su = s;
  const o = +body.o, d = +body.d;
  if (!(s >= 1 && s <= 10 && o >= 1 && o <= 10 && d >= 1 && d <= 10)) throw new Error('S/O/D 必须为 1–10');
  const ap = DB.apLookup(s, o, d);

  // FE/FM/FC：优先用文本（不存在则新建节点），兼容旧的 id 传参
  const findNode = makeNodeFinder(h);
  const focusId = body.focus_node_id || null;
  if (!focusId || !q("SELECT 1 FROM fmea_node WHERE node_id=? AND fmea_id=? AND node_type='STRUCTURE' AND COALESCE(status,'生效')<>'作废'",
    focusId, h.fmea_id)) {
    throw new Error('必须先选择有效的结构节点');
  }
  if (!body.fe_id && !String(body.fe_text || '').trim()) throw new Error('失效影响 (FE) 不能为空');
  if (!body.fm_id && !String(body.fm_text || '').trim()) throw new Error('失效模式 (FM) 不能为空');
  if (!body.fc_id && !String(body.fc_text || '').trim()) throw new Error('失效原因 (FC) 不能为空');
  const prev = body.row_id ? q('SELECT fe_id,fm_id,fc_id FROM fmea_row WHERE row_id=?', body.row_id) : null;
  const nameOf = id => (id ? (q('SELECT name FROM fmea_node WHERE node_id=?', id) || {}).name : null);
  // 文本没变就沿用它原来的节点 id，避免重复建同名节点
  const resolve = (idKey, textKey, subtype, parentId) => {
    if (body[idKey]) return body[idKey];
    const txt = String(body[textKey] || '').trim();
    if (!txt) return null;
    if (prev && prev[idKey]) {
      const previous = q('SELECT * FROM fmea_node WHERE node_id=?', prev[idKey]);
      if (previous && previous.name === txt) return prev[idKey];
      // F-08：编辑文本视为重命名当前节点，不能新建一个副本把旧节点留成孤儿
      if (previous && previous.fmea_id === h.fmea_id) {
        DB.db.prepare('UPDATE fmea_node SET name=? WHERE node_id=?').run(txt, previous.node_id);
        L.audit(actorName(), '修改', 'fmea_node', previous.node_id,
          { name: previous.name }, { name: txt }, `FMEA 行编辑重命名 ${subtype}`);
        return previous.node_id;
      }
    }
    return findNode(txt, subtype, parentId);
  };
  const feId = resolve('fe_id', 'fe_text', 'FE', focusId);
  const fmId = resolve('fm_id', 'fm_text', 'FM', feId || focusId);
  const fcId = resolve('fc_id', 'fc_text', 'FC', fmId || focusId);
  for (const id of [feId, fmId, fcId]) {
    if (id && !q('SELECT 1 FROM fmea_node WHERE node_id=? AND fmea_id=?', id, h.fmea_id)) {
      throw new Error('失效节点不属于当前 FMEA');
    }
  }
  if (body.step_id && !q(
    "SELECT 1 FROM process_step WHERE step_id=? AND project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'",
    body.step_id, CUR,
  )) throw new Error('工序不存在或不属于当前项目');
  // F-07：保存草稿只要求失效链完整；PC/DC 允许渐进补充，发布时再强制
  const missing = [];
  if (!feId) missing.push('失效影响 (FE)');
  if (!fmId) missing.push('失效模式 (FM)');
  if (!fcId) missing.push('失效原因 (FC)');
  if (missing.length) throw new Error('以下必填项未完成：' + missing.join('、'));

  // 一致性校验：同一失效影响下 S 必须一致（F-01：排除当前正在编辑的行，否则改 S 必然失败）
  if (feId) {
    const conflict = q(`SELECT s FROM fmea_row WHERE fmea_id=? AND fe_id=? AND s<>? AND row_id<>? LIMIT 1`,
      h.fmea_id, feId, s, body.row_id || '');
    if (conflict) throw new Error(`一致性校验失败：同一失效影响下已存在 S=${conflict.s}，本行 S=${s} 必须一致`);
  }
  const duplicate = q(`SELECT row_id FROM fmea_row
    WHERE fmea_id=? AND fe_id=? AND fm_id=? AND fc_id=? AND row_id<>?
    LIMIT 1`, h.fmea_id, feId, fmId, fcId, body.row_id || '');
  if (duplicate) throw new Error(`重复分析行：${duplicate.row_id} 已存在相同 FE/FM/FC`);
  const funcId = body.func_id || null;
  if (funcId) {
    const func = q(`SELECT f.func_id FROM fmea_function f JOIN fmea_node n ON n.node_id=f.node_id
      WHERE f.func_id=? AND n.node_id=? AND n.fmea_id=?`, funcId, focusId, h.fmea_id);
    if (!func) throw new Error('所选功能不属于当前结构节点');
  }
  const upstreamRowId = body.upstream_row_id || null;
  if (upstreamRowId) {
    const upstream = q(`SELECT r.row_id FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE r.row_id=? AND h.project_id=?`, upstreamRowId, CUR);
    if (!upstream) throw new Error('上游 FMEA 行不存在或不属于当前项目');
    if (upstreamRowId === body.row_id) throw new Error('上游 FMEA 行不能引用自身');
  }
  let productCharId = body.char_id || null;
  if (productCharId) {
    const productChar = DB.ensureProjectChar(CUR, productCharId);
    if (productChar.char_kind !== 'PRODUCT') throw new Error('关联产品特性类型不正确');
    productCharId = productChar.char_id;
  }
  let processCharId = body.process_char_id || null;
  if (processCharId) {
    const processChar = DB.ensureProjectChar(CUR, processCharId);
    if (processChar.char_kind !== 'PROCESS') throw new Error('关联过程特性类型不正确');
    processCharId = processChar.char_id;
  }
  // F-12：行号由数据库取最大序号，避免每次把全表 row_id 读进内存
  const genId = (prefix) => {
    const max = q(`SELECT COALESCE(MAX(CAST(substr(row_id, ?) AS INTEGER)),0) m FROM fmea_row
      WHERE row_id LIKE ?`, prefix.length + 1, prefix + '%').m || 0;
    return prefix + String(max + 1).padStart(5, '0');
  };
  const wasPublished = h.status === '已发布';
  let rowId = body.row_id;
  if (rowId) {
    const old = q('SELECT * FROM fmea_row WHERE row_id=?', rowId);
    if (!old || old.fmea_id !== h.fmea_id) throw new Error('分析行不存在');
    db.prepare(`UPDATE fmea_row SET
      s=?,o=?,d=?,ap=?,pc_text=?,dc_text=?,char_id=?,process_char_id=?,step_id=?,fe_id=?,fm_id=?,fc_id=?,
      effect_ref=?,func_id=?,upstream_row_id=?,s_plant=?,s_ship=?,s_user=?,filter_code=?
      WHERE row_id=?`)
      .run(s, o, d, ap, body.pc_text || '', body.dc_text || '', productCharId,
        processCharId, body.step_id || null,
        feId || null, fmId || null, fcId || null, funcId, funcId, upstreamRowId,
        sp, ss, su, body.filter_code || null, rowId);
    db.prepare("UPDATE fmea_header SET status='草稿' WHERE fmea_id=?").run(h.fmea_id);
    // F-05：S/O/D/AP 变化后，原处置决定针对的是旧风险，必须回到待评审重新确认
    const riskChanged = old.s !== s || old.o !== o || old.d !== d || old.ap !== ap;
    const decision = riskChanged
      ? q('SELECT * FROM fmea_decision WHERE row_id=?', rowId) : null;
    if (decision && decision.status === '已批准') {
      db.prepare(`UPDATE fmea_decision SET status='待评审',approved_by='',approved_at=NULL
        WHERE row_id=?`).run(rowId);
      L.audit(actorName(), '退回', 'fmea_decision', rowId,
        { status: decision.status, s: decision.s, o: decision.o, d: decision.d, ap: decision.ap },
        { status: '待评审', s, o, d, ap },
        'FMEA 行 S/O/D/AP 变更，原批准决定失效');
    }
    L.audit(actorName(),'修改', 'fmea_row', rowId, old, { s, o, d, ap }, 'FMEA 行编辑');
  } else {
    rowId = genId(h.fmea_type === 'DFMEA' ? 'FR-DF-' : 'FR-PF-');
    const seq = (q('SELECT MAX(seq) m FROM fmea_row WHERE fmea_id=?', h.fmea_id).m || 0) + 1;
    db.prepare(`INSERT INTO fmea_row(
      row_id,fmea_id,focus_node_id,fe_id,fm_id,fc_id,char_id,process_char_id,step_id,s,o,d,ap,
      pc_text,dc_text,effect_ref,seq,s_plant,s_ship,s_user,filter_code,func_id,upstream_row_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rowId, h.fmea_id, focusId, feId || null, fmId || null,
        fcId || null, productCharId, processCharId, body.step_id || null, s, o, d, ap,
        body.pc_text || '', body.dc_text || '', funcId, seq, sp, ss, su,
        body.filter_code || null, funcId, upstreamRowId);
    db.prepare("UPDATE fmea_header SET status='草稿' WHERE fmea_id=?").run(h.fmea_id);
    L.audit(actorName(),'新增', 'fmea_row', rowId, null, { s, o, d, ap, scenes: [sp, ss, su] }, 'FMEA 新增行');
  }
  // F-09：修改已发布 FMEA 会使其回到草稿，必须明确告知而不是静默成功
  return {
    row_id: rowId, ap,
    downgraded: wasPublished,
    message: wasPublished ? 'FMEA 已回到草稿状态，需重新发布后新版本才生效' : '',
  };
});

/* ---------------------------------------------------------------- 结构功能（一个节点多个功能） */
route('GET', /^\/api\/fmea\/functions$/, (m, body, qs) => {
  const nodeId = qs.get('node');
  if (!nodeId) throw new Error('缺少 node 参数');
  return {
    list: all(`SELECT f.*,
        (SELECT COUNT(*) FROM fmea_failure_cand c WHERE c.func_id=f.func_id AND c.status='候选') failure_candidate_count,
        (SELECT COUNT(*) FROM fmea_failure_cand c WHERE c.func_id=f.func_id AND c.status='已采用') adopted_failure_count
      FROM fmea_function f WHERE f.node_id=?
      ORDER BY CASE f.status WHEN '正式' THEN 0 ELSE 1 END, f.seq, f.created_at`, nodeId),
  };
});

route('POST', /^\/api\/fmea\/functions$/, (m, body) => {
  const nodeId = body.node_id;
  const text = String(body.text || '').trim();
  const node = requireCurrentProject(`SELECT n.* FROM fmea_node n
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE n.node_id=? AND h.project_id=?`, nodeId);
  if (!nodeId) throw new Error('缺少结构节点');
  if (!text) throw new Error('功能描述不能为空');
  if (!isValidStandardFunction(text)) {
    throw new Error('功能必须使用现在时动作动词 + 对象 + 可测量要求，不能填写失效或口语化长句');
  }
  if (q('SELECT COUNT(*) c FROM fmea_function WHERE node_id=?', nodeId).c >= 15) {
    throw new Error('该结构节点已有 15 条功能，请先采用、合并或删除不再使用的功能');
  }
  const dup = q('SELECT 1 FROM fmea_function WHERE node_id=? AND text=?', nodeId, text);
  if (dup) return { ok: true, duplicated: true };
  const seq = (q('SELECT MAX(seq) m FROM fmea_function WHERE node_id=?', nodeId).m || 0) + 1;
  const id = 'FN-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100);
  DB.db.prepare('INSERT INTO fmea_function(func_id,node_id,text,status,source,seq,created_at,rationale) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, nodeId, text, body.status || '正式', body.source || 'manual', seq, DB.now(), body.rationale || '');
  markFmeaDraft(node.fmea_id);
  L.audit(actorName(),'新增', 'fmea_function', id, null, { nodeId, text }, '新增功能');
  return { ok: true, func_id: id };
});

route('PATCH', /^\/api\/fmea\/functions\/([^/]+)$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const f = requireCurrentProject(`SELECT f.* FROM fmea_function f
    JOIN fmea_node n ON n.node_id=f.node_id
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE f.func_id=? AND h.project_id=?`, id);
  if (!f) throw new Error('功能不存在');
  const text = body.text !== undefined ? String(body.text).trim() : f.text;
  const status = body.status || f.status;
  if (!text) throw new Error('功能描述不能为空');
  if (status === '正式' && !isValidStandardFunction(text)) {
    throw new Error('采用前请确认功能使用现在时动作动词 + 对象 + 可测量要求');
  }
  DB.db.prepare(`UPDATE fmea_function SET text=?, status=? WHERE func_id=?
    AND node_id IN (SELECT n.node_id FROM fmea_node n
      JOIN fmea_header h ON h.fmea_id=n.fmea_id WHERE h.project_id=?)`)
    .run(text, status, id, CUR);
  markFmeaDraft((q('SELECT fmea_id FROM fmea_node WHERE node_id=?', f.node_id) || {}).fmea_id);
  L.audit(actorName(),'修改', 'fmea_function', id, f, { text, status }, '修改功能');
  return { ok: true };
});

route('DELETE', /^\/api\/fmea\/functions\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const f = requireCurrentProject(`SELECT f.* FROM fmea_function f
    JOIN fmea_node n ON n.node_id=f.node_id
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE f.func_id=? AND h.project_id=?`, id);
  if (!f) throw new Error('功能不存在');
  const fmeaId = (q('SELECT fmea_id FROM fmea_node WHERE node_id=?', f.node_id) || {}).fmea_id;
  DB.db.prepare(`DELETE FROM fmea_failure_cand WHERE func_id=?
    AND node_id IN (SELECT n.node_id FROM fmea_node n
      JOIN fmea_header h ON h.fmea_id=n.fmea_id WHERE h.project_id=?)`).run(id, CUR);
  DB.db.prepare(`DELETE FROM fmea_function WHERE func_id=?
    AND node_id IN (SELECT n.node_id FROM fmea_node n
      JOIN fmea_header h ON h.fmea_id=n.fmea_id WHERE h.project_id=?)`).run(id, CUR);
  markFmeaDraft(fmeaId);
  L.audit(actorName(),'删除', 'fmea_function', id, f, null, '删除功能');
  return { ok: true };
});

/* ---------------------------------------------------------------- 同名结构合并 */
function mergeSiblings(fmeaId, parentId, name, keepId) {
  const dups = all(`SELECT node_id FROM fmea_node
      WHERE fmea_id=? AND (parent_id IS ? OR parent_id=?) AND name=? AND node_type='STRUCTURE' AND node_id<>?`,
    fmeaId, parentId || null, parentId || null, name, keepId);
  let moved = 0;
  for (const d of dups) {
    DB.db.prepare('UPDATE fmea_node SET parent_id=? WHERE parent_id=?').run(keepId, d.node_id);
    DB.db.prepare('UPDATE fmea_row SET focus_node_id=? WHERE focus_node_id=?').run(keepId, d.node_id);
    DB.db.prepare('UPDATE fmea_function SET node_id=? WHERE node_id=?').run(keepId, d.node_id);
    DB.db.prepare('DELETE FROM fmea_node WHERE node_id=?').run(d.node_id);
    moved++;
  }
  return moved;
}

route('POST', /^\/api\/fmea\/nodes\/merge$/, () => {
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, 'DFMEA');
  if (!h) throw new Error('未找到 DFMEA');
  const groups = all(`SELECT parent_id, name, COUNT(*) c FROM fmea_node
      WHERE fmea_id=? AND node_type='STRUCTURE'
      GROUP BY COALESCE(parent_id,'(root)'), name HAVING c > 1`, h.fmea_id);
  let merged = 0;
  for (const g of groups) {
    const parentId = g.parent_id === '(root)' ? null : g.parent_id;
    const keep = q(`SELECT node_id FROM fmea_node WHERE fmea_id=? AND (parent_id IS ? OR parent_id=?) AND name=? ORDER BY seq LIMIT 1`,
      h.fmea_id, parentId, parentId, g.name);
    if (keep) merged += mergeSiblings(h.fmea_id, parentId, g.name, keep.node_id);
  }
  markFmeaDraft(h.fmea_id);
  L.audit(actorName(),'合并', 'fmea_node', h.fmea_id, { groups: groups.length }, { merged }, '合并同名结构节点');
  return { ok: true, groups: groups.length, merged };
});

/* ---------------------------------------------------------------- 失效候选（持久化） */
route('GET', /^\/api\/fmea\/failure-cands$/, (m, body, qs) => {
  const nodeId = qs.get('node');
  const funcId = qs.get('func');
  if (!nodeId) throw new Error('缺少 node');
  requireCurrentProject(`SELECT n.node_id FROM fmea_node n
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE n.node_id=? AND h.project_id=?`, nodeId);
  const rows = funcId
    ? all(`SELECT * FROM fmea_failure_cand WHERE node_id=? AND func_id=? AND status IN ('候选','已采用')
           ORDER BY CASE status WHEN '候选' THEN 0 ELSE 1 END, created_at`, nodeId, funcId)
    : all(`SELECT * FROM fmea_failure_cand WHERE node_id=? AND status IN ('候选','已采用')
           ORDER BY CASE status WHEN '候选' THEN 0 ELSE 1 END, created_at`, nodeId);
  return { list: rows };
});

route('PATCH', /^\/api\/fmea\/failure-cands\/([^/]+)$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const c = requireCurrentProject(`SELECT c.* FROM fmea_failure_cand c
    JOIN fmea_node n ON n.node_id=c.node_id
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE c.cand_id=? AND h.project_id=?`, id);
  if (!c) throw new Error('候选不存在');
  DB.db.prepare(`UPDATE fmea_failure_cand SET status=?, effect=?, mode=?, cause=?, s=?, pc=?, dc=?, row_id=COALESCE(?, row_id)
    WHERE cand_id=? AND node_id IN (SELECT n.node_id FROM fmea_node n
      JOIN fmea_header h ON h.fmea_id=n.fmea_id WHERE h.project_id=?)`)
    .run(body.status || c.status, body.effect ?? c.effect, body.mode ?? c.mode, body.cause ?? c.cause,
      body.s != null ? +body.s : c.s, body.pc ?? c.pc, body.dc ?? c.dc, body.row_id || null, id, CUR);
  return { ok: true };
});

route('DELETE', /^\/api\/fmea\/failure-cands\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  requireCurrentProject(`SELECT c.cand_id FROM fmea_failure_cand c
    JOIN fmea_node n ON n.node_id=c.node_id
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE c.cand_id=? AND h.project_id=?`, id);
  DB.db.prepare('DELETE FROM fmea_failure_cand WHERE cand_id=?').run(id);
  return { ok: true };
});

/* ---------------------------------------------------------------- PFD → PFMEA 结构 */
/* ---------------------------------------------------------------- FMEA 报告（第七步） */
route('GET', /^\/api\/fmea\/report$/, (m, body, qs) => {
  const type = (qs.get('type') || 'PFMEA').toUpperCase();
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!h) throw new Error('未找到 FMEA');
  const proj = q('SELECT * FROM project WHERE project_id=?', CUR) || {};
  const meta = JSON.parse(h.meta_json || '{}');
  const nodes = all(
    "SELECT * FROM fmea_node WHERE fmea_id=? AND COALESCE(status,'生效')<>'作废'",
    h.fmea_id
  );
  const struct = nodes.filter(n => n.node_type === 'STRUCTURE');
  const rows = all(`SELECT r.*, nf.name fe_name, nm.name fm_name, nc.name fc_name,
      d.decision,d.status dstatus,d.approved_by,d.review_due
     FROM fmea_row r LEFT JOIN fmea_node nf ON nf.node_id=r.fe_id
     LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
     LEFT JOIN fmea_node nc ON nc.node_id=r.fc_id
     LEFT JOIN fmea_decision d ON d.row_id=r.row_id
     LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
     WHERE r.fmea_id=?
       AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')
     ORDER BY r.seq`, h.fmea_id);
  const acts = all(`SELECT a.* FROM fmea_action a JOIN fmea_row r ON r.row_id=a.row_id WHERE r.fmea_id=?`, h.fmea_id);
  const fcount = q(`SELECT COUNT(*) c FROM fmea_function f JOIN fmea_node n ON n.node_id=f.node_id
     WHERE n.fmea_id=? AND f.status='正式'`, h.fmea_id).c;
  const cands = q(`SELECT COUNT(*) c FROM fmea_failure_cand WHERE node_id IN
     (SELECT node_id FROM fmea_node WHERE fmea_id=?) AND status='候选'`, h.fmea_id).c;
  const byAP = { H: [], M: [], L: [] };
  for (const r of rows) (byAP[r.ap] || byAP.L).push(r);
  const actByStatus = {};
  for (const a of acts) actByStatus[a.status || '未填'] = (actByStatus[a.status || '未填'] || 0) + 1;
  const fnSet = new Set(all(`SELECT f.node_id FROM fmea_function f JOIN fmea_node n ON n.node_id=f.node_id
     WHERE n.fmea_id=? AND f.status='正式'`, h.fmea_id).map(x => x.node_id));
  return {
    type, meta, project: { name: proj.name, part_no: proj.part_no, phase: proj.phase },
    header: { rev: h.rev, status: h.status, ap_ver: h.ap_ver },
    scope: {
      levels: [1, 2, 3].map(l => ({ level: l, count: struct.filter(n => n.level === l).length })),
      nodes: struct.length, functions: fcount, rows: rows.length, candidates: cands,
    },
    risk: {
      high: byAP.H.map(r => ({ row_id: r.row_id, fm: r.fm_name, fe: r.fe_name, fc: r.fc_name,
        s: r.s, o: r.o, d: r.d, decision: r.decision || '', decision_status: r.dstatus || '' })),
      counts: { H: byAP.H.length, M: byAP.M.length, L: byAP.L.length },
      noDecision: byAP.H.filter(r => !r.decision || r.dstatus !== '已批准' || !r.approved_by).length,
    },
    actions: { total: acts.length, byStatus: actByStatus },
    gaps: {
      noFunction: struct.filter(n => n.level >= 2 && !fnSet.has(n.node_id)).length,
      noRow: struct.filter(n => n.level === 2 && !rows.some(r => r.focus_node_id === n.node_id)).length,
    },
  };
});

/* ---------------------------------------------------------------- PFMEA 表头（手册 P13，11 字段） */
route('POST', /^\/api\/fmea\/header$/, (m, body) => {
  const type = (body.fmea_type || 'PFMEA').toUpperCase();
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!h) throw new Error('未找到 FMEA');
  const meta = body.meta || {};
  DB.db.prepare('UPDATE fmea_header SET meta_json=? WHERE fmea_id=?').run(JSON.stringify(meta), h.fmea_id);
  L.audit(actorName(),'修改', 'fmea_header', h.fmea_id, h.meta_json, meta, '修改 FMEA 表头');
  return { ok: true };
});

route('POST', /^\/api\/pfmea\/from-pfd$/, (m, body) => {
  const result = CS.fromPfd(CUR, { with4m: !!body.with4m });
  L.audit(actorName(),'同步', 'fmea_node', CUR, null, result, 'PFD 增量同步 PFMEA，保留已有分析');
  return result;
});

/* ---------------------------------------------------------------- 工艺流程图：图片识别 + 批量导入 */
route('POST', /^\/api\/pfd\/ocr$/, async (m, body) => {
  const b64 = body.imageBase64 || '';
  if (!b64) throw new Error('缺少图片');
  const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error('图片超过 8 MB');
  const tmp = path.join(__dirname, 'data', `_pfd_${crypto.randomUUID()}.png`);
  fs.writeFileSync(tmp, buf);
  try {
    const words = await OCR.runOCR(tmp);
    // 流程图是“行文本”，不做零件词典切分：按 y 聚行、按 x 排序
    const ws = words.filter(w => w && w.t).map(w => ({ t: String(w.t).trim(), x: +w.x, y: +w.y, w: +w.w || 16, h: +w.h || 16 }));
    const lines = [];
    for (const w of ws.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const cy = w.y + w.h / 2;
      const line = lines.find(l => Math.abs(l.cy - cy) <= Math.max(10, w.h * 0.7));
      if (line) { line.ws.push(w); line.cy = (line.cy * (line.ws.length - 1) + cy) / line.ws.length; }
      else lines.push({ cy, ws: [w] });
    }
    const out = [];
    for (const l of lines) {
      // 同一行里的多个方框会被 OCR 并成一行，这里按 x 间距再切开（方框之间间距通常较大）
      const ws2 = l.ws.sort((a, b) => a.x - b.x);
      let buf = '', prevEnd = null;
      for (const w of ws2) {
        if (prevEnd != null && w.x - prevEnd > 26) { if (buf) out.push(buf); buf = ''; }
        buf += w.t;
        prevEnd = w.x + w.w;
      }
      if (buf) out.push(buf);
    }
    return {
      lines: out.map(t => t.replace(/[\s\u3000]/g, '')).filter(t => t && /[\u4e00-\u9fa5]/.test(t)),
      wordCount: words.length,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  }
});

route('POST', /^\/api\/steps\/bulk$/, (m, body) => {
  const mode = pfdMode(body.pfd_mode);
  const names = (Array.isArray(body.names) ? body.names : [])
    .map(s => String(s || '').trim())
    .filter(Boolean);
  if (!names.length) throw new Error('没有可导入的工序');
  // P-07：替换会作废全部在用工序。先列出被 PFMEA 引用的工序，未显式确认则拒绝，
  // 避免“一次导入把在用工序和它们的分析依据一起作废”。
  let inUse = [];
  if (body.mode !== 'append') {
    inUse = all(
      'SELECT * FROM process_step WHERE project_id=? AND pfd_mode=? AND COALESCE(status,?)<>? ORDER BY seq',
      CUR, mode, '', '作废'
    ).map(step => {
      const fmeaRows = q('SELECT COUNT(*) n FROM fmea_row WHERE step_id=?', step.step_id).n;
      const fmeaLinks = q('SELECT COUNT(*) n FROM pfd_fmea_link WHERE project_id=? AND step_id=?', CUR, step.step_id).n;
      return { step_id: step.step_id, step_no: step.step_no, name: step.name, fmea_rows: fmeaRows, fmea_nodes: fmeaLinks };
    }).filter(item => item.fmea_rows || item.fmea_nodes);
    if (inUse.length && !body.confirm_replace) {
      throw Object.assign(
        new Error(`批量替换会作废 ${inUse.length} 个已被 PFMEA 引用的工序，请先确认影响面，或改用“追加”`),
        { statusCode: 409, details: { mode: 'replace', referencing_steps: inUse } }
      );
    }
  }
  const result = DB.tx(() => {
    const active = all(
      'SELECT * FROM process_step WHERE project_id=? AND pfd_mode=? AND COALESCE(status,?)<>? ORDER BY seq',
      CUR, mode, '', '作废'
    );
    let replaced = 0;
    if (body.mode !== 'append') {
      // 已确认替换：把受影响的下游对象一并置为待复核，避免“工序作废了、CP/FMEA 还是已批准”
      if (inUse.length) {
        const stepIds = inUse.map(item => item.step_id);
        const ph = stepIds.map(() => '?').join(',');
        DB.db.prepare(`DELETE FROM pfd_fmea_link WHERE project_id=? AND step_id IN (${ph})`)
          .run(CUR, ...stepIds);
        const fmeaIds = all(`SELECT DISTINCT h.fmea_id FROM fmea_row r
          JOIN fmea_header h ON h.fmea_id=r.fmea_id WHERE r.step_id IN (${ph})`, ...stepIds)
          .map(row => row.fmea_id);
        for (const fmeaId of fmeaIds) {
          DB.db.prepare("UPDATE fmea_header SET status='草稿' WHERE fmea_id=?").run(fmeaId);
        }
        const cpIds = all(`SELECT DISTINCT p.cp_id FROM cp_row r
          JOIN control_plan p ON p.cp_id=r.cp_id WHERE r.step_id IN (${ph})`, ...stepIds)
          .map(row => row.cp_id);
        for (const cpId of cpIds) markCpDraft(cpId);
      }
      for (const step of active) {
        DB.db.prepare(`UPDATE process_step SET
          status='作废',change_summary=COALESCE(change_summary,'')||? WHERE step_id=?`
        ).run(` [${DB.now()} 被批量导入替换]`, step.step_id);
        replaced += 1;
      }
    }
    const activeRows = body.mode === 'append'
      ? active
      : [];
    const maxNo = activeRows.reduce((max, row) => Math.max(max, Number(row.step_no) || 0), 0);
    const maxSeq = activeRows.reduce((max, row) => Math.max(max, row.seq || 0), 0);
    const start = body.mode === 'append' ? maxNo + 10 : 10;
    const ins = DB.db.prepare(`INSERT INTO process_step(
      step_id,project_id,step_no,name,step_type,seq,equipment,fixture,input_desc,output_desc,status,ver,pfd_mode,change_summary
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const stamp = Date.now().toString(36).toUpperCase();
    let index = 0;
    for (const name of names) {
      index += 1;
      const no = start + (index - 1) * 10;
      const type = /检验|检查|测量|抽检|判定/.test(name) ? '检验'
        : (/存储|存放|入库|仓|暂存/.test(name) ? '存储'
        : (/搬运|转运|运输|流转|周转/.test(name) ? '搬运'
        : (/电镀|热处理|焊接|固化|煅烧|退火/.test(name) ? '特殊过程' : '工序')));
      ins.run(
        `PS-PFD-${stamp}-${index}`, CUR, String(no).padStart(3, '0'), name, type,
        maxSeq + index, '', '', '', '', '草稿', 'v1', mode,
        body.mode === 'append' ? '批量追加' : '批量替换'
      );
    }
    return { count: names.length, replaced, referencing_steps: inUse };
  });
  L.audit(actorName(),'导入', 'process_step', CUR, null,
    { count: result.count, mode: body.mode || 'replace', pfd_mode: mode, replaced: result.replaced,
      referencing_steps: result.referencing_steps }, '导入工序');
  return { ok: true, ...result, pfd_mode: mode };
});

route('POST', /^\/api\/fmea\/node$/, (m, body) => {
  const type = String(body.fmea_type || 'PFMEA').toUpperCase() === 'DFMEA' ? 'DFMEA' : 'PFMEA';
  const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!header) throw new Error('未找到 FMEA');
  const name = String(body.name || '').trim();
  if (!name) throw new Error('结构节点名称不能为空');
  let parent = null;
  if (body.parent_id) {
    parent = q(`SELECT * FROM fmea_node
      WHERE node_id=? AND fmea_id=? AND node_type='STRUCTURE' AND COALESCE(status,'生效')<>'作废'`,
    body.parent_id, header.fmea_id);
    if (!parent) throw new Error('父结构节点不存在');
  }
  const seq = (q('SELECT MAX(seq) m FROM fmea_node WHERE fmea_id=?', header.fmea_id).m || 0) + 1;
  const id = uniqueId('N', header.fmea_id);
  DB.db.prepare(`INSERT INTO fmea_node(
    node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc,level,status
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, header.fmea_id, parent?.node_id || null, 'STRUCTURE', null, seq, name, null,
    String(body.desc || '').trim() || null, parent ? (+parent.level || 1) + 1 : 1, '生效'
  );
  markFmeaDraft(header.fmea_id);
  L.audit(body.user || actorName(), '新增', 'fmea_node', id, null,
    { name, parent_id: parent?.node_id || null }, '手工新增 FMEA 结构节点');
  return { ok: true, node_id: id };
});

route('PATCH', /^\/api\/fmea\/node\/([^/]+)$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const n = requireCurrentProject(`SELECT n.* FROM fmea_node n
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE n.node_id=? AND h.project_id=?`, id);
  if (!n) throw new Error('结构节点不存在：' + id);
  const name = body.name !== undefined ? String(body.name).trim() : n.name;
  if (!name) throw new Error('名称不能为空');
  const desc = body.desc !== undefined ? String(body.desc).trim() : n.desc;
  DB.db.prepare('UPDATE fmea_node SET name=?, desc=? WHERE node_id=?').run(name, desc || null, id);
  // 改名后若与同级节点同名，自动合并（下级内容挂到保留节点下）
  let mergedCount = 0;
  if (body.name !== undefined && name !== n.name) {
    mergedCount = mergeSiblings(n.fmea_id, n.parent_id, name, id);
  }
  markFmeaDraft(n.fmea_id);
  L.audit(actorName(),'修改', 'fmea_node', id, { name: n.name, desc: n.desc }, { name, desc, merged: mergedCount }, '修改结构节点');
  return { ok: true, merged: mergedCount };
});

// F-10：删除结构节点前列出将被级联删除/解引用的对象，供确认框展示
route('GET', /^\/api\/fmea\/node\/([^/]+)\/impact$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const node = requireCurrentProject(`SELECT n.* FROM fmea_node n
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE n.node_id=? AND h.project_id=?`, id);
  if (!node) throw new Error('结构节点不存在');
  const ids = [];
  const walk = nodeId => {
    ids.push(nodeId);
    for (const child of all('SELECT node_id FROM fmea_node WHERE parent_id=?', nodeId)) walk(child.node_id);
  };
  walk(id);
  const ph = ids.map(() => '?').join(',');
  const rows = all(`SELECT row_id FROM fmea_row WHERE focus_node_id IN (${ph})`, ...ids).map(row => row.row_id);
  const rowPh = rows.length ? rows.map(() => '?').join(',') : 'NULL';
  const cpRows = all(`SELECT DISTINCT c.cp_row_id,c.cp_id FROM cp_row c
    LEFT JOIN cp_fmea_link l ON l.cp_row_id=c.cp_row_id
    WHERE c.fmea_row_id IN (${rowPh}) OR l.fmea_row_id IN (${rowPh})`,
  ...(rows.length ? [...rows, ...rows] : [])).map(row => ({ cp_row_id: row.cp_row_id, cp_id: row.cp_id }));
  return {
    node: { node_id: node.node_id, name: node.name },
    nodes: ids.length,
    child_nodes: ids.length - 1,
    rows: rows.length,
    row_ids: rows.slice(0, 50),
    actions: rows.length
      ? q(`SELECT COUNT(*) c FROM fmea_action WHERE row_id IN (${rowPh})`, ...rows).c : 0,
    decisions: rows.length
      ? q(`SELECT COUNT(*) c FROM fmea_decision WHERE row_id IN (${rowPh})`, ...rows).c : 0,
    cp_rows: cpRows,
  };
});

route('DELETE', /^\/api\/fmea\/node\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const n = requireCurrentProject(`SELECT n.* FROM fmea_node n
    JOIN fmea_header h ON h.fmea_id=n.fmea_id
    WHERE n.node_id=? AND h.project_id=?`, id);
  if (!n) throw new Error('结构节点不存在：' + id);

  // 连同所有子孙节点一起删
  const ids = [];
  const walk = (nodeId) => {
    ids.push(nodeId);
    for (const c of all('SELECT node_id FROM fmea_node WHERE parent_id=?', nodeId)) walk(c.node_id);
  };
  walk(id);

  const ph = ids.map(() => '?').join(',');
  const result = DB.tx(() => {
    const rows = all(`SELECT row_id FROM fmea_row WHERE focus_node_id IN (${ph})`, ...ids);
    // 先解引用再删行：清理 cp_fmea_link 并把受影响控制计划降草稿
    const cpImpact = invalidateCpForFmeaRows(rows.map(row => row.row_id));
    for (const row of rows) {
      DB.db.prepare('UPDATE cp_row SET fmea_row_id=NULL WHERE fmea_row_id=?').run(row.row_id);
      DB.db.prepare("UPDATE fmea_failure_cand SET row_id=NULL,status='候选' WHERE row_id=?").run(row.row_id);
      DB.db.prepare('DELETE FROM fmea_action WHERE row_id=?').run(row.row_id);
      DB.db.prepare('DELETE FROM fmea_decision WHERE row_id=?').run(row.row_id);
      DB.db.prepare('DELETE FROM fmea_row WHERE row_id=?').run(row.row_id);
    }
    DB.db.prepare(`DELETE FROM fmea_failure_cand WHERE node_id IN (${ph})`).run(...ids);
    DB.db.prepare(`DELETE FROM fmea_function WHERE node_id IN (${ph})`).run(...ids);
    DB.db.prepare(`DELETE FROM fmea_node WHERE node_id IN (${ph})`).run(...ids);
    const orphanIds = all(`SELECT node_id FROM fmea_node
      WHERE fmea_id=? AND node_type='FAILURE'
        AND node_id NOT IN (
          SELECT fe_id FROM fmea_row WHERE fe_id IS NOT NULL
          UNION SELECT fm_id FROM fmea_row WHERE fm_id IS NOT NULL
          UNION SELECT fc_id FROM fmea_row WHERE fc_id IS NOT NULL)`, n.fmea_id).map(row => row.node_id);
    if (orphanIds.length) {
      const orphanPh = orphanIds.map(() => '?').join(',');
      DB.db.prepare(`DELETE FROM fmea_failure_cand WHERE node_id IN (${orphanPh})`).run(...orphanIds);
      DB.db.prepare(`DELETE FROM fmea_function WHERE node_id IN (${orphanPh})`).run(...orphanIds);
      DB.db.prepare(`DELETE FROM fmea_node WHERE node_id IN (${orphanPh})`).run(...orphanIds);
    }
    return { rows: rows.length, orphans: orphanIds.length };
  });

  L.audit(actorName(),'删除', 'fmea_node', id,
    { name: n.name, nodes: ids.length, rows: result.rows }, null, '删除结构节点');
  return { ok: true, nodes: ids.length, rows: result.rows, removed_orphans: result.orphans };
});

route('DELETE', /^\/api\/fmea\/rows$/, (m, body, qs) => {
  const type = (qs.get('type') || 'DFMEA').toUpperCase();
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!h) throw new Error('未找到 FMEA');
  const n = q('SELECT COUNT(*) c FROM fmea_row WHERE fmea_id=?', h.fmea_id).c;
  DB.tx(() => {
    const rowIds = all('SELECT row_id FROM fmea_row WHERE fmea_id=?', h.fmea_id).map(row => row.row_id);
    if (rowIds.length) {
      // 先解引用再删行：清理 cp_fmea_link 并把受影响控制计划降草稿
      invalidateCpForFmeaRows(rowIds);
      const ph = rowIds.map(() => '?').join(',');
      DB.db.prepare(`UPDATE cp_row SET fmea_row_id=NULL WHERE fmea_row_id IN (${ph})`).run(...rowIds);
      DB.db.prepare(`UPDATE fmea_failure_cand SET row_id=NULL,status='候选' WHERE row_id IN (${ph})`).run(...rowIds);
      DB.db.prepare(`DELETE FROM fmea_action WHERE row_id IN (${ph})`).run(...rowIds);
      DB.db.prepare(`DELETE FROM fmea_decision WHERE row_id IN (${ph})`).run(...rowIds);
    }
    DB.db.prepare('DELETE FROM fmea_row WHERE fmea_id=?').run(h.fmea_id);
    const failureNodes = all("SELECT node_id FROM fmea_node WHERE fmea_id=? AND node_type='FAILURE'", h.fmea_id)
      .map(row => row.node_id);
    if (failureNodes.length) {
      const ph = failureNodes.map(() => '?').join(',');
      DB.db.prepare(`DELETE FROM fmea_failure_cand WHERE node_id IN (${ph})`).run(...failureNodes);
      DB.db.prepare(`DELETE FROM fmea_function WHERE node_id IN (${ph})`).run(...failureNodes);
      DB.db.prepare(`DELETE FROM fmea_node WHERE node_id IN (${ph})`).run(...failureNodes);
    }
    DB.db.prepare("UPDATE fmea_header SET status='草稿' WHERE fmea_id=?").run(h.fmea_id);
  });
  L.audit(actorName(),'删除', 'fmea_row', h.fmea_id, { rows: n }, null, `清空 ${type} 全部分析行`);
  return { ok: true, removed: n };
});

route('DELETE', /^\/api\/fmea\/row\/([^/]+)$/, (m) => {
  const rowId = decodeURIComponent(m[1]);
  const row = requireCurrentProject(`SELECT r.* FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    WHERE r.row_id=? AND h.project_id=?`, rowId);
  if (!row) throw new Error('分析行不存在：' + rowId);
  const orphans = DB.tx(() => {
    // 先解引用再删行：清理 cp_fmea_link 并把受影响控制计划降草稿
    invalidateCpForFmeaRows([rowId]);
    DB.db.prepare('UPDATE cp_row SET fmea_row_id=NULL WHERE fmea_row_id=?').run(rowId);
    DB.db.prepare("UPDATE fmea_failure_cand SET row_id=NULL,status='候选' WHERE row_id=?").run(rowId);
    DB.db.prepare('DELETE FROM fmea_action WHERE row_id=?').run(rowId);
    DB.db.prepare('DELETE FROM fmea_decision WHERE row_id=?').run(rowId);
    DB.db.prepare('DELETE FROM fmea_row WHERE row_id=?').run(rowId);
    const orphanIds = all(`SELECT node_id FROM fmea_node
        WHERE fmea_id=? AND node_type='FAILURE'
          AND node_id NOT IN (
            SELECT fe_id FROM fmea_row WHERE fe_id IS NOT NULL
            UNION SELECT fm_id FROM fmea_row WHERE fm_id IS NOT NULL
            UNION SELECT fc_id FROM fmea_row WHERE fc_id IS NOT NULL)`, row.fmea_id).map(item => item.node_id);
    if (orphanIds.length) {
      const ph = orphanIds.map(() => '?').join(',');
      DB.db.prepare(`DELETE FROM fmea_failure_cand WHERE node_id IN (${ph})`).run(...orphanIds);
      DB.db.prepare(`DELETE FROM fmea_function WHERE node_id IN (${ph})`).run(...orphanIds);
      DB.db.prepare(`DELETE FROM fmea_node WHERE node_id IN (${ph})`).run(...orphanIds);
    }
    DB.db.prepare("UPDATE fmea_header SET status='草稿' WHERE fmea_id=?").run(row.fmea_id);
    return orphanIds;
  });

  L.audit(actorName(),'删除', 'fmea_row', rowId, row, null, '删除 FMEA 分析行');
  return { ok: true, removed_orphans: orphans.length };
});

route('POST', /^\/api\/fmea\/action$/, (m, body) => {
  requireCurrentProject(`SELECT r.row_id FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    WHERE r.row_id=? AND h.project_id=?`, body.row_id);
  if (!q('SELECT 1 FROM fmea_row WHERE row_id=?', body.row_id)) throw new Error('分析行不存在');
  const s = body.s_after ? +body.s_after : null, o = body.o_after ? +body.o_after : null, d = body.d_after ? +body.d_after : null;
  if ([s, o, d].some(value => value != null && !(value >= 1 && value <= 10))) {
    throw new Error('措施后 S/O/D 必须为 1–10');
  }
  const apAfter = s && o && d ? DB.apLookup(s, o, d) : null;
  const allowed = ['开放的', '尚未决定', '尚未执行', '已完成待验证', '已完成', '不执行'];
  let status = allowed.includes(body.status) ? body.status : '开放的';
  const verified = !!body.effect_verified && !!String(body.evidence_ref || '').trim();
  if (status === '已完成' && !verified) status = '已完成待验证';
  const r = DB.db.prepare(`INSERT INTO fmea_action(
    row_id,action_type,description,owner,due_date,status,completed_at,improved_dim,
    s_after,o_after,d_after,ap_after,effect_verified,evidence_ref,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    body.row_id, body.action_type || '预防', body.description || '',
    body.owner || '', body.due_date || '', status,
    ['已完成', '已完成待验证'].includes(status) ? (body.completed_at || DB.now().slice(0, 10)) : null,
    body.improved_dim || null, s, o, d, apAfter, verified ? 1 : 0,
    body.evidence_ref || null, DB.now()
  );
  L.audit(actorName(),'新增', 'fmea_action', String(r.lastInsertRowid), null, body, '新增措施');
  markFmeaDraft((q('SELECT fmea_id FROM fmea_row WHERE row_id=?', body.row_id) || {}).fmea_id);
  return { ok: true, ap_after: apAfter, status, effect_verified: verified };
});

route('PATCH', /^\/api\/fmea\/action\/(\d+)$/, (m, body) => {
  const id = +m[1];
  const old = requireCurrentProject(`SELECT a.* FROM fmea_action a
    JOIN fmea_row r ON r.row_id=a.row_id
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    WHERE a.action_id=? AND h.project_id=?`, id);
  if (!old) throw new Error('措施不存在');
  const allowed = ['开放的', '尚未决定', '尚未执行', '已完成待验证', '已完成', '不执行'];
  if (body.status && !allowed.includes(body.status)) throw new Error('措施状态无效');
  const evidence = body.evidence_ref !== undefined ? String(body.evidence_ref).trim() : old.evidence_ref;
  let verified = body.effect_verified !== undefined ? !!body.effect_verified : !!old.effect_verified;
  if (verified && !evidence) throw new Error('标记有效性已验证前必须填写证据');
  let status = body.status || old.status;
  if (status === '已完成' && !verified) status = '已完成待验证';
  const completedAt = body.completed_at !== undefined
    ? body.completed_at
    : (['已完成', '已完成待验证'].includes(status) && !old.completed_at
      ? DB.now().slice(0, 10) : old.completed_at);
  DB.db.prepare(`UPDATE fmea_action SET
    status=?,effect_verified=?,evidence_ref=?,completed_at=?,description=?,owner=?,due_date=?
    WHERE action_id=? AND row_id IN (
      SELECT r.row_id FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE h.project_id=?
    )`).run(
    status, verified ? 1 : 0, evidence || null, completedAt,
    body.description !== undefined ? body.description : old.description,
    body.owner !== undefined ? body.owner : old.owner,
    body.due_date !== undefined ? body.due_date : old.due_date, id, CUR
  );
  L.audit(actorName(),'修改', 'fmea_action', String(id), old, body, '措施状态更新');
  markFmeaDraft((q('SELECT fmea_id FROM fmea_row WHERE row_id=?', old.row_id) || {}).fmea_id);
  return { ok: true, status, effect_verified: verified };
});

route('POST', /^\/api\/fmea\/decision$/, (m, body) => {
  const row = requireCurrentProject(`SELECT r.* FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    WHERE r.row_id=? AND h.project_id=?`, body.row_id);
  if (!row) throw new Error('行不存在');
  if (!body.decision) throw new Error('请选择决定');
  // AP=高 是强制项；AP=中/低 按手册不强制，但允许主动登记（客户要求、企业规范等）
  if (body.decision === 'NO_ACTION' && (!body.rationale || body.rationale.length < 30)) {
    throw new Error('选择「不采取措施」时，理由至少 30 字');
  }
  if (body.decision === 'NO_ACTION' && !body.review_due) {
    throw new Error('选择「不采取措施」时必须填写复审日期');
  }
  const allowedStatus = ['待评审', '已批准', '已关闭'];
  const status = allowedStatus.includes(body.status) ? body.status : '待评审';
  // 决定是否批准由服务端判定：必须先提交为“待评审”，再由另一名质量角色批准
  const existing = q('SELECT * FROM fmea_decision WHERE row_id=?', body.row_id);
  let submittedBy = existing?.submitted_by || '';
  if (status === '已批准') {
    requirePermission('fmea.approve', '批准 FMEA 处置决定');
    if (!existing || existing.status !== '待评审') {
      throw Object.assign(
        new Error('处置决定必须先提交为“待评审”，才能由其他人批准'),
        { statusCode: 409 }
      );
    }
    assertNotSelfApproval(existing.submitted_by, '批准');
    // F-05：批准的是“某一版 S/O/D/AP 下的决定”，行已变化时必须重新提交
    if (existing.s != null && (existing.s !== row.s || existing.o !== row.o
        || existing.d !== row.d || existing.ap !== row.ap)) {
      throw Object.assign(
        new Error('该行的 S/O/D/AP 已变更，原决定不再对应当前风险；请重新提交评审'),
        { statusCode: 409 }
      );
    }
    body.approved_by = actorName();
    submittedBy = existing.submitted_by || '';
  } else {
    body.approved_by = '';
    submittedBy = actorName();
  }
  if (row.s >= 9 && body.decision !== 'TAKE_ACTION' && status !== '已批准') {
    throw new Error('S ≥ 9 的处置决定必须由质量工程师及以上人员批准');
  }
  const decisionText = status === '已批准' ? (body.decision || existing?.decision || '') : body.decision;
  const rationaleText = status === '已批准' ? (body.rationale || existing?.rationale || '') : (body.rationale || '');
  const reviewDue = status === '已批准' ? (body.review_due || existing?.review_due || '') : (body.review_due || '');
  DB.db.prepare(`INSERT INTO fmea_decision(
    row_id,decision,rationale,approved_by,review_due,status,approved_at,submitted_by,
    s,o,d,ap,decided_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(row_id) DO UPDATE SET
      decision=excluded.decision,rationale=excluded.rationale,
      approved_by=excluded.approved_by,review_due=excluded.review_due,
      status=excluded.status,approved_at=excluded.approved_at,
      submitted_by=excluded.submitted_by,
      s=excluded.s,o=excluded.o,d=excluded.d,ap=excluded.ap,decided_at=excluded.decided_at`).run(
    body.row_id, decisionText, rationaleText, body.approved_by || '',
    reviewDue, status, status === '已批准' ? DB.now() : null, submittedBy,
    row.s, row.o, row.d, row.ap, DB.now()
  );
  L.audit(actorName(), status === '已批准' ? '批准' : '提交',
    'fmea_decision', body.row_id, null, body, 'AP=H 处置决定');
  markFmeaDraft(row.fmea_id);
  return { ok: true };
});

route('POST', /^\/api\/fmea\/publish$/, (m, body) => DB.tx(() => {
  const type = String(body.fmea_type || 'PFMEA').toUpperCase();
  const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!header) throw new Error('未找到 FMEA');
  requirePermission('fmea.approve', '发布 FMEA');
  body.approved_by = actorName();
  body.published_by = actorName();
  const highMissing = all(`SELECT r.row_id,r.ap,d.decision,d.status,d.s,d.o,d.d,d.ap decision_ap
    FROM fmea_row r LEFT JOIN fmea_decision d ON d.row_id=r.row_id
    WHERE r.fmea_id=? AND r.ap='H'
      AND (d.row_id IS NULL OR d.decision IS NULL OR d.decision='PENDING'
        OR d.status<>'已批准' OR COALESCE(d.approved_by,'')=''
        OR d.s IS NULL OR d.s<>r.s OR d.o<>r.o OR d.d<>r.d OR d.ap IS NULL OR d.ap<>r.ap)`,
  header.fmea_id);
  if (highMissing.length) {
    throw new Error(`仍有 ${highMissing.length} 条高 AP 未完成批准决定（或决定基于旧 S/O/D）：${highMissing.map(r => r.row_id).join('、')}`);
  }
  // F-07：PC/DC 可以草稿阶段留空，但发布前必须补齐，避免未受控的“空控制”进入 CP
  const controlGaps = all(`SELECT r.row_id FROM fmea_row r
    LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
    WHERE r.fmea_id=? AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')
      AND (TRIM(COALESCE(r.pc_text,''))='' OR TRIM(COALESCE(r.dc_text,''))='')
    ORDER BY r.row_id`, header.fmea_id);
  if (controlGaps.length) {
    throw Object.assign(
      new Error(`仍有 ${controlGaps.length} 条分析行缺少现行预防/探测控制：${controlGaps.slice(0, 12).map(row => row.row_id).join('、')}${controlGaps.length > 12 ? ' 等' : ''}`),
      { statusCode: 409, details: { rows: controlGaps.map(row => row.row_id) } }
    );
  }
  const activeNodes = all(
    "SELECT * FROM fmea_node WHERE fmea_id=? AND node_type='STRUCTURE' AND COALESCE(status,'生效')<>'作废'",
    header.fmea_id
  );
  const childParents = new Set(activeNodes.map(node => node.parent_id).filter(Boolean));
  const leaves = activeNodes.filter(node => !childParents.has(node.node_id) && node.level !== 1);
  const gapFunctions = leaves.filter(node =>
    !q(`SELECT 1 FROM fmea_function WHERE node_id=? AND status='正式' LIMIT 1`, node.node_id)
  );
  if (gapFunctions.length) {
    throw new Error(`以下结构节点还没有正式功能：${gapFunctions.map(node => node.name).join('、')}`);
  }
  const gapRows = leaves.filter(node =>
    !q('SELECT 1 FROM fmea_row WHERE fmea_id=? AND focus_node_id=? LIMIT 1', header.fmea_id, node.node_id)
  );
  if (gapRows.length) {
    throw new Error(`以下结构节点还没有失效分析：${gapRows.map(node => node.name).join('、')}`);
  }
  const revMatch = /^r(\d+)$/i.exec(header.rev || 'r1');
  const nextRev = 'r' + ((revMatch ? +revMatch[1] : 1) + 1);
  DB.db.prepare(`UPDATE fmea_header SET
    status='已发布',rev=?,published_at=?,published_by=?,approved_by=? WHERE fmea_id=?`).run(
    nextRev, DB.now(), body.published_by || body.approved_by, body.approved_by, header.fmea_id
  );
  L.audit(body.approved_by, '发布', 'fmea_header', header.fmea_id,
    { status: header.status, rev: header.rev }, { status: '已发布', rev: nextRev }, 'FMEA 发布审批');
  return { ok: true, rev: nextRev, sync: syncProjectDeliverables(CUR) };
}));

route('POST', /^\/api\/fmea\/revise$/, (m, body) => DB.tx(() => {
  const type = String(body.fmea_type || 'PFMEA').toUpperCase();
  const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type);
  if (!header) throw new Error('未找到 FMEA');
  if (header.status !== '已发布') throw new Error('只有已发布 FMEA 可以发起修订');
  const reason = String(body.reason || '').trim();
  if (!reason) throw new Error('修订原因不能为空');
  DB.db.prepare(`UPDATE fmea_header SET status='草稿',published_at=NULL,published_by=NULL,
    approved_by='' WHERE fmea_id=?`).run(header.fmea_id);
  L.audit(body.user || actorName(), '发起修订', 'fmea_header', header.fmea_id,
    { status: header.status, rev: header.rev }, { status: '草稿', rev: header.rev }, reason);
  return { ok: true, status: '草稿', rev: header.rev };
}));

route('GET', /^\/api\/cp$/, (m, body, query) => {
  const plans = all(`SELECT * FROM control_plan WHERE project_id=?
    ORDER BY CASE stage WHEN 'PROTO' THEN 1 WHEN 'PILOT' THEN 2 WHEN 'SOP' THEN 3 ELSE 9 END`, CUR);
  if (!plans.length) throw new Error('当前项目还没有控制计划');
  const stage = String(query.get('stage') || '').toUpperCase();
  const cp = plans.find(plan => plan.stage === stage) || plans[0];
  const rows = all(`SELECT c.*, s.step_no, s.name step_name, s.step_type,
      COALESCE(pc.name, cm.name) char_name, COALESCE(pc.unit, cm.unit) unit,
      COALESCE(pc.char_kind, cm.char_kind) char_kind,
      COALESCE(pc.is_special, cm.is_special) is_special,
      COALESCE(pc.special_symbol, cm.special_symbol) special_symbol,
      COALESCE(pc.target, cm.target) char_target, COALESCE(pc.lsl, cm.lsl) char_lsl,
      COALESCE(pc.usl, cm.usl) char_usl, COALESCE(pc.tol_text, cm.tol_text) char_tol_text,
      g.name gauge_name, g.calibration_due, g.status gauge_status,
      (SELECT p.char_id FROM char_link l JOIN char_master p ON p.char_id=l.product_char_id
        WHERE l.process_char_id=c.char_id AND COALESCE(l.status,'生效')<>'作废'
        ORDER BY CASE l.strength WHEN '强' THEN 1 WHEN '中' THEN 2 ELSE 3 END LIMIT 1) product_char_id,
      (SELECT p.name FROM char_link l JOIN char_master p ON p.char_id=l.product_char_id
        WHERE l.process_char_id=c.char_id AND COALESCE(l.status,'生效')<>'作废'
        ORDER BY CASE l.strength WHEN '强' THEN 1 WHEN '中' THEN 2 ELSE 3 END LIMIT 1) product_char_name,
      (SELECT mon_id FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_id,
      (SELECT approval_status FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_status,
      (SELECT chart_type FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_chart_type,
      (SELECT subgroup_n FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_subgroup_n,
      (SELECT freq_value FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_freq_value,
      (SELECT freq_unit FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_freq_unit,
      (SELECT cpk_target FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_cpk_target,
      (SELECT status FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id ORDER BY created_at DESC,rowid DESC LIMIT 1) mon_active_status,
      (SELECT COUNT(*) FROM monitoring_item m WHERE m.cp_row_id=c.cp_row_id) mon_history_count,
      (SELECT COUNT(*) FROM spc_dataset ds JOIN monitoring_item m ON m.mon_id=ds.mon_id
        WHERE m.cp_row_id=c.cp_row_id) mon_data_count,
      NULL msa_pct,NULL msa_at
    FROM cp_row c LEFT JOIN process_step s ON s.step_id=c.step_id
    LEFT JOIN project_char pc ON pc.pchar_id=c.project_char_id
    LEFT JOIN char_master cm ON cm.char_id=c.char_id
    LEFT JOIN gauge g ON g.gauge_id=c.gauge_id
    WHERE c.cp_id=? AND COALESCE(c.status,'启用')='启用' ORDER BY COALESCE(s.step_no,'zzz'), c.seq`, cp.cp_id);
  // 工序上已有产品特性但本行没挂特性时，把工序名带出来，避免"产品特性"整列空白
  const msaPlans = DB.listMsaPlans(CUR);
  const today = DB.now().slice(0, 10);
  for (const r of rows) {
    if (!r.char_name) r.char_placeholder = r.step_name ? '（未关联特性）' : '';
    const plan = msaPlans.find(item => item.cp_row_id === r.cp_row_id
      && item.project_char_id === r.project_char_id && item.gauge_id === r.gauge_id
      && item.measure_tech === r.measure_tech && item.source_active !== 0);
    const study = plan?.study_id
      ? q('SELECT * FROM msa_study WHERE study_id=? AND project_id=? AND plan_id=?',
        plan.study_id, CUR, plan.plan_id)
      : null;
    r.msa_pct = study?.result_pct ?? null;
    r.msa_at = study?.studied_at || null;
    r.msa_judgment = study?.judgment || '';
    r.msa_status = study?.status || '';
    r.msa_plan_status = plan?.status || '';
    r.msa_source_status = plan?.source_status || '';
    r.msa_warning = !r.gauge_id || !study || study.judgment !== '接受' || study.status !== '已完成'
      || plan?.status !== '已完成' || plan?.source_status !== '有效'
      || !r.msa_at || r.msa_at < DB.now().slice(0, 10).replace(/^(\d{4})/, (year) => String(+year - 1))
      || !r.calibration_due || r.calibration_due < today
      || ['停用', '报废'].includes(r.gauge_status);
  }
  const chars = projectCharacterRows(CUR);
  const stoppedRows = q(`SELECT COUNT(*) c FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE p.project_id=? AND c.cp_id=? AND COALESCE(c.status,'启用')='停用'`, CUR, cp.cp_id).c;
  return {
    cp, plans, rows, stopped_rows: stoppedRows,
    steps: all("SELECT * FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废' ORDER BY step_no", CUR),
    chars: chars.items,
    projectChars: chars.items,
    dictionaryChars: chars.dictionary,
    gauges: all(`SELECT * FROM gauge WHERE COALESCE(status,'')<>'报废' ORDER BY gauge_id`),
  };
});

route('GET', /^\/api\/msa\/match$/, (m, body, query) => {
  const rowId = String(query.get('cp_row_id') || '').trim();
  const gaugeId = String(query.get('gauge_id') || '').trim();
  const row = q(`SELECT c.*,cp.project_id FROM cp_row c JOIN control_plan cp ON cp.cp_id=c.cp_id
    WHERE c.cp_row_id=? AND cp.project_id=?`, rowId, CUR);
  if (!row) throw new Error('控制计划行不存在');
  const plan = DB.listMsaPlans(CUR).find(item => item.cp_row_id === rowId
    && item.gauge_id === gaugeId && item.project_char_id === row.project_char_id
    && item.measure_tech === row.measure_tech && item.source_active !== 0) || null;
  const study = plan?.study_id
    ? q('SELECT * FROM msa_study WHERE study_id=? AND project_id=? AND plan_id=?',
      plan.study_id, CUR, plan.plan_id)
    : null;
  const gauge = q('SELECT calibration_due,status FROM gauge WHERE gauge_id=?', gaugeId);
  const today = DB.now().slice(0, 10);
  return {
    plan,
    study,
    calibration_due: gauge?.calibration_due || '',
    calibration_warning: !gauge?.calibration_due || gauge.calibration_due < today
      || ['停用', '报废'].includes(gauge.status),
  };
});

route('POST', /^\/api\/cp\/row$/, (m, body) => DB.tx(() => {
  const cp = body.cp_id
    ? q('SELECT * FROM control_plan WHERE cp_id=? AND project_id=?', body.cp_id, CUR)
    : q('SELECT * FROM control_plan WHERE project_id=? ORDER BY stage LIMIT 1', CUR);
  if (!cp) throw new Error('当前项目还没有控制计划');
  if (!body.step_id) throw new Error('请选择工序');
  requireCurrentProject("SELECT step_id FROM process_step WHERE step_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废' AND project_id=?", body.step_id);
  if (body.gauge_id && !q("SELECT 1 FROM gauge WHERE gauge_id=? AND COALESCE(status,'')<>'报废'", body.gauge_id)) {
    throw new Error('测量设备不存在或已报废');
  }
  // C-05：样本容量/频率在建行时同样校验，不能用 `|| 1` 吞掉 0、负数或小数
  if (body.sample_size !== undefined && body.sample_size !== ''
      && (!Number.isInteger(+body.sample_size) || +body.sample_size < 1 || +body.sample_size > 1000)) {
    throw new Error('样本容量必须为 1–1000 的整数');
  }
  if (body.freq_value !== undefined && body.freq_value !== ''
      && (!Number.isFinite(+body.freq_value) || +body.freq_value <= 0 || +body.freq_value > 100000)) {
    throw new Error('频率值必须为正数且不超过 100000');
  }
  if (body.is_spc && !body.gauge_id) throw new Error('纳入 SPC 前必须选择检具');
  let projectChar = null;
  if (body.project_char_id) {
    projectChar = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
      body.project_char_id, CUR);
  } else if (body.char_id) {
    projectChar = DB.ensureProjectChar(CUR, body.char_id);
  }
  if (body.project_char_id && !projectChar) throw new Error('项目特性不存在');
  // C-11：允许（并记录）控制计划行到 PFMEA 行的依据链接；无依据可由人工新建草稿，
  // 但高 AP/特殊特性行在批准前必须有有效 PFMEA 依据（见 validateCpForApproval）。
  let fmeaRow = null;
  if (body.fmea_row_id) {
    fmeaRow = q(`SELECT r.*,h.project_id FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE r.row_id=? AND h.project_id=? AND h.fmea_type='PFMEA'`, body.fmea_row_id, CUR);
    if (!fmeaRow) throw new Error('PFMEA 依据行不存在或不属于当前项目');
    if (fmeaRow.step_id && fmeaRow.step_id !== body.step_id) {
      throw new Error('PFMEA 依据行的工序与控制计划行不一致');
    }
  }
  const seq = (q('SELECT MAX(seq) m FROM cp_row WHERE cp_id=?', cp.cp_id).m || 0) + 1;
  const id = 'CP-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100);
  const projectCharId = projectChar ? projectChar.pchar_id : null;
  const charId = projectChar ? projectChar.char_id : (body.char_id || null);
  const autoSpec = projectChar ? (projectChar.tol_text
    || (projectChar.lsl != null && projectChar.usl != null
      ? `${projectChar.lsl} ~ ${projectChar.usl} ${projectChar.unit || ''}` : '')) : '';
  DB.db.prepare(`INSERT INTO cp_row(cp_row_id,cp_id,seq,step_id,char_id,project_char_id,fmea_row_id,spec_text,measure_tech,
      gauge_id,sample_size,freq_value,freq_unit,freq_trigger,control_method,reaction_plan,is_spc,override_flag,override_reason,upstream_ver)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, cp.cp_id, seq, body.step_id, charId, projectCharId, fmeaRow ? fmeaRow.row_id : null,
      body.spec_text || autoSpec, body.measure_tech || '', body.gauge_id || '',
      body.sample_size === undefined || body.sample_size === '' ? 1 : +body.sample_size,
      body.freq_value === undefined || body.freq_value === '' ? 2 : +body.freq_value,
      body.freq_unit || 'h',
      body.freq_trigger || '首件 + 巡检', body.control_method || '',
      body.reaction_plan || '', body.is_spc ? 1 : 0, 0, null, fmeaRow ? '人工关联PFMEA' : '人工新增');
  if (fmeaRow) {
    DB.db.prepare('INSERT OR IGNORE INTO cp_fmea_link(cp_row_id,fmea_row_id) VALUES(?,?)')
      .run(id, fmeaRow.row_id);
  }
  L.audit(actorName(),'新增', 'cp_row', id, null, body, '新增控制计划行');
  markCpDraft(cp.cp_id);
  return { ok: true, cp_row_id: id, fmea_row_id: fmeaRow ? fmeaRow.row_id : null,
    sync: syncProjectDeliverables(CUR) };
}));

route('DELETE', /^\/api\/cp\/row\/([^/]+)$/, (m) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const row = requireCurrentProject(`SELECT c.* FROM cp_row c
    JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE c.cp_row_id=? AND p.project_id=?`, id);
  if (!row) throw new Error('行不存在');
  const monitors = all('SELECT * FROM monitoring_item WHERE cp_row_id=? ORDER BY created_at DESC,rowid DESC', id);
  if (monitors.some(monitor => monitor.status === '启用')) {
    throw new Error('该控制计划行仍有关联的启用 SPC 监控；请在 SPC 页面停用监控后再移除');
  }
  if (q('SELECT 1 FROM cp_fmea_link WHERE cp_row_id=? LIMIT 1', id)
      || q('SELECT 1 FROM cp_stage_link WHERE target_cp_row_id=? OR source_cp_row_id=? LIMIT 1', id, id)) {
    throw new Error('该控制计划行已进入FMEA、MSA或阶段继承链；请标记来源变更并保留追溯记录，不能删除');
  }
  if (monitors.length || q('SELECT 1 FROM msa_plan_item WHERE cp_row_id=? LIMIT 1', id)) {
    DB.db.prepare("UPDATE cp_row SET status='停用',is_spc=0 WHERE cp_row_id=?").run(id);
    L.audit(actorName(),'停用', 'cp_row', id, row, { status: '停用' },
      '控制计划行已有测量/监控历史，保留记录并从当前维护表隐藏');
    markCpDraft(row.cp_id);
    return { ok: true, deleted: false, status: '停用', sync: syncProjectDeliverables(CUR) };
  }
  DB.tx(() => {
    DB.db.prepare('DELETE FROM cp_row WHERE cp_row_id=?').run(id);
  });
  L.audit(actorName(),'删除', 'cp_row', id, row, null, '删除控制计划行');
  markCpDraft(row.cp_id);
  return { ok: true, sync: syncProjectDeliverables(CUR) };
}));

route('POST', /^\/api\/cp\/generate$/, (m, body) => {
  const cp = body.cp_id
    ? q('SELECT * FROM control_plan WHERE cp_id=? AND project_id=?', body.cp_id, CUR)
    : q('SELECT * FROM control_plan WHERE project_id=? ORDER BY stage LIMIT 1', CUR);
  if (!cp) throw new Error('当前项目还没有控制计划');
  const result = L.cpGenerate(cp.cp_id);
  return { ...result, sync: syncProjectDeliverables(CUR) };
});

route('PATCH', /^\/api\/cp\/row\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = m[1];
  const old = requireCurrentProject(`SELECT c.* FROM cp_row c
    JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE c.cp_row_id=? AND p.project_id=?`, id);
  if (!old) throw new Error('控制计划行不存在');
  if ((body.gauge_id !== undefined || body.is_spc !== undefined)
      && q("SELECT 1 FROM monitoring_item WHERE cp_row_id=? AND approval_status='已批准'", id)) {
    throw new Error('该行已有批准的 SPC 监控项，不能直接改检具或 SPC 状态');
  }
  const allowed = ['sample_size', 'freq_value', 'freq_unit', 'freq_trigger', 'reaction_plan',
    'gauge_id', 'measure_tech', 'control_method', 'is_spc'];
  if (body.gauge_id && !q('SELECT 1 FROM gauge WHERE gauge_id=?', body.gauge_id)) throw new Error('检具不存在');
  if (body.sample_size !== undefined && (!Number.isInteger(+body.sample_size) || +body.sample_size < 1 || +body.sample_size > 1000)) {
    throw new Error('样本容量必须为 1–1000 的整数');
  }
  if (body.freq_value !== undefined && (!Number.isFinite(+body.freq_value) || +body.freq_value <= 0 || +body.freq_value > 100000)) {
    throw new Error('频率值必须为正数且不超过 100000');
  }
  if (body.is_spc && !body.gauge_id && !old.gauge_id) throw new Error('纳入 SPC 前必须选择检具');
  // 覆盖标记只能由服务端在显式“手工覆盖”动作中写入；普通编辑不再永久脱离自动同步
  const explicitOverride = body.action === 'override' || body.override === true;
  const clearOverride = body.action === 'clear-override';
  if (explicitOverride && !String(body.override_reason || '').trim()) {
    throw new Error('手工覆盖自动同步必须填写覆盖原因');
  }
  // C-01：覆盖标记可撤销；撤销后该行重新接受自动同步
  if (clearOverride) {
    DB.db.prepare(`UPDATE cp_row SET override_flag=0,override_reason='',override_fields_json='[]'
      WHERE cp_row_id=? AND cp_id IN (SELECT cp_id FROM control_plan WHERE project_id=?)`)
      .run(id, CUR);
    L.audit(actorName(), '撤销覆盖', 'cp_row', id, old, { override_flag: 0 },
      body.override_reason || '撤销人工覆盖，恢复自动同步');
    return { ok: true, cleared: true, override_flag: 0, note: '已撤销人工覆盖，本行重新接受自动同步' };
  }
  const sets = [], vals = [];
  for (const f of allowed) if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(body[f]); }
  if (!sets.length && !explicitOverride) return { ok: true };
  if (explicitOverride) {
    const overrideFields = new Set(JSON.parse(old.override_fields_json || '[]'));
    allowed.filter(field => body[field] !== undefined).forEach(field => overrideFields.add(field));
    sets.push('override_flag=?'); vals.push(1);
    sets.push('override_reason=?'); vals.push(String(body.override_reason).trim());
    sets.push('override_fields_json=?'); vals.push(JSON.stringify([...overrideFields]));
  }
  // C-07：只有影响抽样/检具/SPC 纳入的修改才降级；文字描述类修改保留已批准状态
  const samplingFields = ['sample_size', 'freq_value', 'freq_unit', 'freq_trigger', 'gauge_id', 'is_spc'];
  const textFields = ['measure_tech', 'control_method', 'reaction_plan'];
  const changedFields = allowed.filter(field => body[field] !== undefined
    && String(body[field] ?? '') !== String(old[field] ?? ''));
  const changedSampling = changedFields.some(field => samplingFields.includes(field));
  const changedText = changedFields.some(field => textFields.includes(field));
  vals.push(id);
  DB.db.prepare(`UPDATE cp_row SET ${sets.join(',')} WHERE cp_row_id=?
    AND cp_id IN (SELECT cp_id FROM control_plan WHERE project_id=?)`).run(...vals, CUR);
  L.audit(actorName(),'修改', 'cp_row', id, old, body, body.override_reason || 'CP 行编辑');
  if (changedSampling) markCpDraft(old.cp_id);
  const sync = syncProjectDeliverables(CUR);
  return {
    ok: true,
    changed_fields: changedFields,
    downgraded: changedSampling,
    note: changedSampling
      ? '抽样/检具/SPC 纳入发生变化，控制计划已降为草稿待复核'
      : changedText ? '仅更新控制方法/测量技术文字，控制计划批准状态保留；仍建议在下次评审时复核' : '',
    sync,
  };
}));

route('PATCH', /^\/api\/cp\/row\/([^/]+)\/characteristic$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const old = q(`SELECT c.*, p.project_id FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE c.cp_row_id=? AND p.project_id=?`, id, CUR);
  if (!old) throw new Error('控制计划行不存在');
  let characteristic = null;
  if (body.project_char_id) {
    characteristic = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
      body.project_char_id, CUR);
  } else if (body.char_id) {
    characteristic = DB.ensureProjectChar(CUR, String(body.char_id).trim());
  }
  if (!characteristic) throw new Error('项目特性不存在');
  const charId = characteristic.char_id;
  const projectCharId = characteristic.pchar_id;
  const spec = characteristic.tol_text
    || (characteristic.lsl != null && characteristic.usl != null
      ? `${characteristic.lsl} – ${characteristic.usl} ${characteristic.unit || ''}` : '');
  const fields = new Set(JSON.parse(old.override_fields_json || '[]'));
  fields.add('char_id');
  fields.add('spec_text');
  DB.db.prepare(`UPDATE cp_row SET char_id=?,project_char_id=?,spec_text=?,override_flag=1,override_fields_json=?
    WHERE cp_row_id=? AND cp_id IN (SELECT cp_id FROM control_plan WHERE project_id=?)`)
    .run(charId, projectCharId, spec, JSON.stringify([...fields]), id, CUR);
  // Q-09：控制计划行重挂特性后，SPC 监控项必须以 cp_row.project_char_id 为准，
  // 旧特性快照不能继续用于 Cpk；监控项回到待审核，避免用错规范直接判定能力。
  const monitored = DB.db.prepare(`UPDATE monitoring_item SET
    char_id=?,project_char_id=?,approval_status='待审核',approved_by='',approved_at=NULL,
    review_note='控制计划行特性已重映射，需重新审核监控配置'
    WHERE cp_row_id=?`).run(charId, projectCharId, id);
  L.audit(body.user || actorName(), '关联', 'cp_row', id, old,
    { char_id: charId, project_char_id: projectCharId, spec_text: spec,
      monitoring_items: Number(monitored.changes || 0) },
    body.reason || '人工关联控制计划特性');
  markCpDraft(old.cp_id);
  const sync = syncProjectDeliverables(CUR);
  return {
    ok: true,
    sync,
    char_id: charId,
    project_char_id: projectCharId,
    monitoring_items: Number(monitored.changes || 0),
    char_name: characteristic.name,
    char_kind: characteristic.char_kind,
  };
}));

route('GET', /^\/api\/cp\/([^/]+)\/revisions$/, (m) => {
  const id = decodePart(m[1]);
  if (!q('SELECT 1 FROM control_plan WHERE cp_id=? AND project_id=?', id, CUR)) throw new Error('控制计划不存在');
  const list = all(`SELECT * FROM cp_revision WHERE project_id=? AND cp_id=?
    ORDER BY changed_at DESC,rowid DESC`, CUR, id).map(row => {
    let count = 0;
    try { count = JSON.parse(row.rows_json || '[]').length; } catch (e) { count = 0; }
    return {
      rev_id: row.rev_id, rev: row.rev, status: row.status, changed_by: row.changed_by,
      changed_at: row.changed_at, note: row.note, row_count: count,
    };
  });
  return { list };
});
route('GET', /^\/api\/cp\/([^/]+)\/revisions\/([^/]+)$/, (m) => {
  const id = decodePart(m[1]);
  const row = q('SELECT * FROM cp_revision WHERE project_id=? AND cp_id=? AND rev_id=?',
    CUR, id, decodePart(m[2]));
  if (!row) throw new Error('控制计划版本不存在');
  const parse = text => { try { return JSON.parse(text || 'null'); } catch (e) { return null; } };
  return {
    rev_id: row.rev_id, rev: row.rev, status: row.status, changed_by: row.changed_by,
    changed_at: row.changed_at, note: row.note,
    header: parse(row.header_json), rows: parse(row.rows_json) || [],
  };
});
route('PATCH', /^\/api\/cp\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM control_plan WHERE cp_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('控制计划不存在');
  if (body.status && !['草稿', '待审核', '已批准', '已冻结'].includes(body.status)) throw new Error('控制计划状态无效');
  if (body.safe_launch_applicability !== undefined
      && !['未判定', '要求', '不要求'].includes(body.safe_launch_applicability)) {
    throw new Error('安全投产适用性必须为要求、不要求或未判定');
  }
  if (body.safe_launch_status !== undefined
      && !['未开始', '计划', '执行中', '已退出', '不要求'].includes(body.safe_launch_status)) {
    throw new Error('安全投产状态无效');
  }
  // 状态机守卫：控制计划只能按 草稿→待审核→已批准→已冻结（变更时回到草稿）迁移
  if (body.status && old.status && body.status !== old.status) {
    const allowedFrom = { '草稿': ['待审核'], '待审核': ['已批准', '草稿'], '已批准': ['已冻结', '草稿'], '已冻结': ['草稿'] };
    if (allowedFrom[old.status] && !allowedFrom[old.status].includes(body.status)) {
      throw Object.assign(new Error(`控制计划不能从「${old.status}」直接变更为「${body.status}」`), { statusCode: 409 });
    }
  }
  const changed = Object.keys(body).some(field => ![
    'user', 'approved_by', 'status', 'safe_launch_status', 'safe_launch_exited_by', 'safe_launch_exited_at',
  ].includes(field)
    && Object.hasOwn(old, field) && String(body[field] ?? '') !== String(old[field] ?? ''));
  if (changed && ['已批准', '已冻结'].includes(old.status)) {
    // 降级前留存已批准版本，否则旧版内容永久丢失
    snapshotCpRevision(id, '降为草稿前的已批准版本');
    body = { ...body, status: '草稿', approved_by: '', effective_date: '' };
  }
  if (body.status === '已批准' && old.status !== '已批准') {
    requirePermission('cp.approve', '批准控制计划');
    assertNotSelfApproval(old.prepared_by, '批准');
    validateCpForApproval(id);
    body = { ...body, approved_by: actorName() };
    const match = /^r(\d+)$/i.exec(old.rev || 'r1');
    body = { ...body, rev: `r${(match ? +match[1] : 1) + 1}` };
  }
  const allowed = ['rev', 'part_no', 'part_name', 'customer', 'plant', 'prepared_by',
    'approved_by', 'status', 'effective_date', 'safe_launch_applicability', 'safe_launch_status',
    'safe_launch_note', 'safe_launch_entry_criteria', 'safe_launch_exit_criteria',
    'safe_launch_exited_by', 'safe_launch_exited_at'];
  const next = { ...old, ...body };
  if (old.stage === 'SOP' && body.status === '已批准') {
    if (next.safe_launch_applicability === '未判定') {
      throw new Error('批准量产控制计划前，必须确认安全投产是否适用');
    }
    if (next.safe_launch_applicability === '要求'
        && (!String(next.safe_launch_entry_criteria || '').trim()
          || !String(next.safe_launch_exit_criteria || '').trim())) {
      throw new Error('适用安全投产时，批准前必须定义进入条件和退出准则');
    }
    if (next.safe_launch_applicability === '不要求'
        && !String(next.safe_launch_note || '').trim()) {
      throw new Error('安全投产不适用时必须记录顾客/项目依据');
    }
  }
  if (body.safe_launch_status === '已退出') {
    const exitDate = String(body.safe_launch_exited_at || old.safe_launch_exited_at || '');
    const entryDate = String(old.effective_date || next.effective_date || '');
    const exitReason = String(body.safe_launch_exit_reason || old.safe_launch_exit_reason || '').trim();
    if (next.safe_launch_applicability !== '要求'
        || !String(body.safe_launch_exited_by || old.safe_launch_exited_by || '').trim()
        || !/^\d{4}-\d{2}-\d{2}$/.test(exitDate)
        || !Number.isFinite(Date.parse(exitDate))
        || exitDate > DB.now().slice(0, 10)) {
      throw new Error('退出安全投产需记录适用性、批准人和退出日期');
    }
    // C-10：退出日期不能早于控制计划生效（进入安全投产）日期，且必须写明退出原因
    if (entryDate && /^\d{4}-\d{2}-\d{2}$/.test(entryDate) && exitDate < entryDate) {
      throw new Error(`安全投产退出日期不能早于生效日期 ${entryDate}`);
    }
    if (exitReason.length < 4) {
      throw new Error('退出安全投产必须填写退出原因（至少 4 个字）');
    }
  }
  const sets = [], values = [];
  for (const field of allowed) {
    if (body[field] !== undefined) { sets.push(`${field}=?`); values.push(body[field]); }
  }
  if (!sets.length) return { ok: true };
  if (body.status === '已批准' && !String(body.approved_by || old.approved_by || '').trim()) {
    throw new Error('批准控制计划必须填写批准人');
  }
  values.push(id);
  DB.db.prepare(`UPDATE control_plan SET ${sets.join(',')} WHERE cp_id=? AND project_id=?`).run(...values, CUR);
  const revision = body.status === '已批准' && old.status !== '已批准'
    ? snapshotCpRevision(id, String(body.note || '批准后版本')) : null;
  L.audit(actorName(), '修改', 'control_plan', id, old, body, '维护控制计划表头');
  return { ok: true, status: body.status || old.status, revision, sync: syncProjectDeliverables(CUR) };
}));

route('POST', /^\/api\/cp\/([^/]+)\/monitor$/, (m, body) => DB.tx(() => {
  const rowId = decodeURIComponent(m[1]);
  const row = q(`SELECT c.*, p.project_id FROM cp_row c
    JOIN control_plan p ON p.cp_id=c.cp_id WHERE c.cp_row_id=? AND p.project_id=?`, rowId, CUR);
  if (!row) throw new Error('控制计划行不存在');
  if (!row.char_id) throw new Error('请先为控制计划行关联产品特性或过程特性');
  let projectChar = null;
  if (body.project_char_id) {
    projectChar = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
      body.project_char_id, CUR);
  } else if (row.project_char_id) {
    projectChar = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
      row.project_char_id, CUR);
  } else {
    projectChar = DB.ensureProjectChar(CUR, row.char_id);
  }
  if (!projectChar) throw new Error('控制计划行关联的项目特性不存在');
  const charId = projectChar.char_id;
  const projectCharId = projectChar.pchar_id;
  const gaugeId = String(body.gauge_id || row.gauge_id || '').trim();
  if (!gaugeId) throw new Error('纳入 SPC 前必须选择测量设备');
  const gauge = q("SELECT * FROM gauge WHERE gauge_id=? AND COALESCE(status,'')<>'报废'", gaugeId);
  if (!gauge) throw new Error('所选测量设备不存在或已报废');
  const chartType = ['Xbar-R', 'Xbar-S', 'I-MR', 'P', 'C'].includes(body.chart_type)
    ? body.chart_type : 'Xbar-R';
  const subgroup = chartType === 'P' ? 2 : ['I-MR', 'C'].includes(chartType) ? 1 : (+body.subgroup_n || 5);
  if (['Xbar-R', 'Xbar-S'].includes(chartType)
      && (!Number.isInteger(subgroup) || subgroup < 2 || subgroup > 10)) {
    throw new Error('Xbar 控制图子组大小必须为 2–10');
  }
  const freqValue = body.freq_value !== undefined && +body.freq_value > 0
    ? +body.freq_value : (+row.freq_value || 2);
  const freqUnit = body.freq_unit || row.freq_unit || 'h';
  const target = Number.isFinite(+body.cpk_target) ? +body.cpk_target : DB.DEFAULT_CPK_TARGET;
  const revision = body.revise_monitor_id
    ? q('SELECT * FROM monitoring_item WHERE mon_id=? AND cp_row_id=?',
      String(body.revise_monitor_id), rowId)
    : null;
  if (body.revise_monitor_id && (!revision || revision.approval_status !== '已批准')) {
    throw new Error('只能修订当前控制计划行已批准的 SPC 监控项');
  }
  const existing = revision || q(`SELECT * FROM monitoring_item WHERE cp_row_id=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`, rowId);
  if (existing && existing.approval_status === '已批准' && !revision) {
    throw new Error('该控制计划行已有批准的监控项；如需变更，请先停用原监控项');
  }
  const monitorId = revision ? uniqueId('MON', `${rowId}-REV`)
    : existing && existing.approval_status !== '已批准' ? existing.mon_id : uniqueId('MON', rowId);
  // 监控项创建/修订一律进入待审核，批准必须走独立的 review 接口（禁止创建即自批）
  const approved = false;
  const revise = !!revision;
  const updateExisting = existing && existing.approval_status !== '已批准' && !revision;
  const sql = updateExisting
    ? `UPDATE monitoring_item SET char_id=?,project_char_id=?,chart_type=?,subgroup_n=?,freq_value=?,freq_unit=?,cpk_target=?,
       gauge_id=?,before_sort=?,status=?,approval_status=?,approved_by=?,approved_at=?,review_note=?
       WHERE mon_id=?`
    : `INSERT INTO monitoring_item(
       mon_id,cp_row_id,is_spc,char_id,project_char_id,chart_type,subgroup_n,freq_value,freq_unit,cpk_target,gauge_id,
       before_sort,status,approval_status,approved_by,approved_at,review_note,created_by,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const args = updateExisting
    ? [charId, projectCharId, chartType, subgroup, freqValue, freqUnit, target,
      gaugeId, body.before_sort === false ? 0 : 1, '启用',
      approved ? '已批准' : '待审核', approved ? body.approved_by : '',
      approved ? DB.now() : null, body.review_note || '', monitorId]
    : [monitorId, rowId, 1, charId, projectCharId, chartType, subgroup, freqValue,
      freqUnit, target, gaugeId, body.before_sort === false ? 0 : 1, '启用',
      approved ? '已批准' : '待审核', approved ? body.approved_by : '',
      approved ? DB.now() : null, body.review_note || '', actorName(), DB.now()];
  DB.db.prepare(sql).run(...args);
  // 写入成功后才降级控制计划；校验失败不应改变已批准/已冻结状态
  markCpDraft(row.cp_id);
  if (revision) {
    DB.db.prepare("UPDATE monitoring_item SET status='停用' WHERE mon_id=? AND cp_row_id=?")
      .run(revision.mon_id, rowId);
  }
  // C-04：CP 的样本容量/抽样频率是控制计划要求，监控项只读，不得用子组或 SPC 配置回写。
  DB.db.prepare(`UPDATE cp_row SET is_spc=1,gauge_id=?,project_char_id=?,char_id=?
    WHERE cp_row_id=?`).run(gaugeId, projectCharId, charId, rowId);
  if (approved) {
    recordApproval({
      projectId: CUR, actionType: 'MONITOR_APPROVE', objectType: 'monitoring_item',
      objectId: monitorId, title: `批准 SPC 监控项 ${monitorId}`,
      payload: { cp_row_id: rowId, gauge_id: gaugeId, chart_type: chartType, subgroup_n: subgroup, cpk_target: target },
      approvedBy: body.approved_by, requestedBy: body.user || actorName(), note: '质量工程师审核监控项',
    });
  }
  L.audit(actorName(), approved ? '批准' : '提交审核',
    'monitoring_item', monitorId, null, { cp_row_id: rowId, chart_type: chartType, subgroup_n: subgroup },
    revise ? `修订 SPC 监控项 ${revision.mon_id}；旧配置停用，新配置待审核`
      : approved ? '批准 SPC 监控项' : '提交 SPC 监控项审核');
  const sync = syncProjectDeliverables(CUR);
  return {
    ok: true, mon_id: monitorId, chart_type: chartType,
    approval_status: approved ? '已批准' : '待审核',
    revised_from: revision?.mon_id || null,
    sync,
  };
}));

route('PATCH', /^\/api\/monitoring\/([^/]+)\/review$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const monitor = q(`SELECT m.* FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
    JOIN control_plan p ON p.cp_id=c.cp_id WHERE m.mon_id=? AND p.project_id=?`, id, CUR);
  if (!monitor) throw new Error('监控项不存在');
  requirePermission('spc.review', '审核 SPC 监控项');
  const action = body.action === 'approve' ? 'approve' : body.action === 'reject' ? 'reject' : '';
  if (!action) throw new Error('审核动作必须为 approve 或 reject');
  assertNotSelfApproval(monitor.created_by, '批准');
  const status = action === 'approve' ? '已批准' : '已退回';
  DB.db.prepare(`UPDATE monitoring_item SET approval_status=?,approved_by=?,approved_at=?,review_note=?
    WHERE mon_id=?`).run(
    status, action === 'approve' ? actorName() : '', action === 'approve' ? DB.now() : null,
    body.review_note || '', id
  );
  L.audit(actorName(), action === 'approve' ? '批准' : '退回',
    'monitoring_item', id, monitor, { status }, body.review_note || '监控项审核');
  return { ok: true, approval_status: status, sync: syncProjectDeliverables(CUR) };
}));

route('DELETE', /^\/api\/monitoring\/([^/]+)$/, (m) => DB.tx(() => {
  const id = decodePart(m[1]);
  const monitor = q(`SELECT m.* FROM monitoring_item m
    JOIN cp_row c ON c.cp_row_id=m.cp_row_id JOIN control_plan p ON p.cp_id=c.cp_id
    WHERE m.mon_id=? AND p.project_id=?`, id, CUR);
  if (!monitor) throw new Error('SPC 监控项不存在');
  if (monitor.status === '启用') throw new Error('请先停用该监控项，再删除无数据的配置');
  if (q('SELECT 1 FROM spc_dataset WHERE mon_id=? LIMIT 1', id)) {
    throw new Error('该监控项已有 SPC 数据，请停用并保留历史记录，不能删除');
  }
  DB.db.prepare('DELETE FROM monitoring_item WHERE mon_id=? AND cp_row_id=?').run(id, monitor.cp_row_id);
  const active = q("SELECT 1 FROM monitoring_item WHERE cp_row_id=? AND status='启用' LIMIT 1", monitor.cp_row_id);
  if (!active) DB.db.prepare('UPDATE cp_row SET is_spc=0 WHERE cp_row_id=?').run(monitor.cp_row_id);
  L.audit(actorName(),'删除', 'monitoring_item', id, monitor, null,
    '监控项尚无SPC数据，允许删除配置');
  return { ok: true, sync: syncProjectDeliverables(CUR) };
}));

route('PATCH', /^\/api\/monitoring\/([^/]+)\/status$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const old = q(`SELECT m.* FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
    JOIN control_plan p ON p.cp_id=c.cp_id WHERE m.mon_id=? AND p.project_id=?`, id, CUR);
  if (!old) throw new Error('监控项不存在');
  const status = body.status === '启用' ? '启用' : body.status === '停用' ? '停用' : '';
  if (!status) throw new Error('状态必须为启用或停用');
  DB.db.prepare(`UPDATE monitoring_item SET status=? WHERE mon_id=?
    AND cp_row_id IN (SELECT c.cp_row_id FROM cp_row c
      JOIN control_plan p ON p.cp_id=c.cp_id WHERE p.project_id=?)`).run(status, id, CUR);
  if (status === '停用' && !q("SELECT 1 FROM monitoring_item WHERE cp_row_id=? AND status='启用' AND mon_id<>? LIMIT 1",
    old.cp_row_id, id)) {
    DB.db.prepare('UPDATE cp_row SET is_spc=0 WHERE cp_row_id=?').run(old.cp_row_id);
    const cpId = q('SELECT cp_id FROM cp_row WHERE cp_row_id=?', old.cp_row_id)?.cp_id;
    if (cpId) markCpDraft(cpId);
  }
  L.audit(body.user || actorName(), '修改', 'monitoring_item', id,
    old, { status }, body.note || '监控项状态变更');
  return { ok: true, status, sync: syncProjectDeliverables(CUR) };
}));

route('GET', /^\/api\/monitoring\/pending$/, () => ({
  list: all(`SELECT m.*, c.spec_text, COALESCE(pc.name,cm.name) char_name, p.stage
    FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
    JOIN control_plan p ON p.cp_id=c.cp_id
    LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(c.project_char_id,m.project_char_id)
    LEFT JOIN char_master cm ON cm.char_id=COALESCE(pc.char_id,c.char_id,m.char_id)
    WHERE p.project_id=? AND m.approval_status='待审核'
    ORDER BY m.created_at`, CUR),
}));

route('GET', /^\/api\/spc$/, () => {
  const incomplete = all(`SELECT m.mon_id,c.cp_row_id
    FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
    JOIN control_plan cp ON cp.cp_id=c.cp_id
    WHERE cp.project_id=? AND m.status='启用' AND m.approval_status='已批准'
      AND COALESCE(m.char_id,c.char_id,m.project_char_id,c.project_char_id) IS NULL
    ORDER BY m.mon_id`, CUR);
  const mons = all(`SELECT m.*, c.cp_row_id, c.spec_text,
      COALESCE(pc.name,cm.name) char_name,
      COALESCE(pc.lsl,cm.lsl) lsl, COALESCE(pc.usl,cm.usl) usl,
      COALESCE(pc.unit,cm.unit) unit, COALESCE(pc.target,cm.target) target,
      COALESCE(pc.tol_text,cm.tol_text) tol_text,
      COALESCE(pc.is_special,cm.is_special) is_special,
      COALESCE(pc.special_symbol,cm.special_symbol) special_symbol,
      COALESCE(c.project_char_id,m.project_char_id,pc.pchar_id) project_char_id,
      COALESCE(c.char_id,m.char_id,pc.char_id,cm.char_id) char_id,
      s.step_name, cp.stage cp_stage, g.code gauge_code, g.name gauge_name
      FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
      JOIN control_plan cp ON cp.cp_id=c.cp_id
      LEFT JOIN gauge g ON g.gauge_id=m.gauge_id
      LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(c.project_char_id,m.project_char_id)
      LEFT JOIN char_master cm ON cm.char_id=COALESCE(pc.char_id,c.char_id,m.char_id)
      LEFT JOIN (SELECT cp_row_id, (SELECT name FROM process_step s2 WHERE s2.step_id=c2.step_id) step_name
                 FROM cp_row c2) s ON s.cp_row_id=c.cp_row_id
      WHERE cp.project_id=? AND m.status='启用' AND m.approval_status='已批准'
        AND COALESCE(m.char_id,c.char_id,m.project_char_id,c.project_char_id) IS NOT NULL
      ORDER BY m.mon_id`, CUR);
  const out = mons.map(m => {
    const ds = q('SELECT * FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC LIMIT 1', m.mon_id);
    let stat = null;
    let chartOptions = {};
    if (ds) {
      try {
        const subs = JSON.parse(ds.data_json);
        chartOptions = spcChartOptions(subs, m, { lsl: m.lsl, usl: m.usl });
        stat = chartOptions[m.chart_type] || Object.values(chartOptions)[0] || null;
        stat.dataset_id = ds.dataset_id; stat.batch_no = ds.batch_no; stat.imported_at = ds.imported_at;
      } catch (e) { stat = null; }
    }
    return { ...m, stat, chartOptions };
  });
  return { items: out, incomplete };
});

route('GET', /^\/api\/spc\/([^/]+)$/, (m) => {
  const mon = q(`SELECT mi.* FROM monitoring_item mi
    JOIN cp_row r ON r.cp_row_id=mi.cp_row_id JOIN control_plan cp ON cp.cp_id=r.cp_id
    WHERE mi.mon_id=? AND cp.project_id=?`, m[1], CUR);
  if (!mon) throw new Error('监控项不存在');
  const datasets = all(
    'SELECT * FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC',
    mon.mon_id
  );
  const cpRow = q(`SELECT c.*,
      COALESCE(pc.name,cm.name) char_name,
      COALESCE(pc.lsl,cm.lsl) lsl, COALESCE(pc.usl,cm.usl) usl,
      COALESCE(pc.unit,cm.unit) unit, COALESCE(pc.target,cm.target) target,
      COALESCE(pc.tol_text,cm.tol_text) tol_text,
      COALESCE(pc.is_special,cm.is_special) is_special,
      COALESCE(pc.special_symbol,cm.special_symbol) special_symbol,
      COALESCE(c.project_char_id,pc.pchar_id) project_char_id
    FROM cp_row c
    LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(c.project_char_id,?)
    LEFT JOIN char_master cm ON cm.char_id=COALESCE(pc.char_id,c.char_id)
    WHERE c.cp_row_id=?`, mon.project_char_id || null, mon.cp_row_id);
  const items = all('SELECT dataset_id, batch_no, imported_at, imported_by, n_sub FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC', mon.mon_id);
  return { mon, cpRow, items, latest: datasets[0] || null,
    gauges: all("SELECT gauge_id,code,name,calibration_due,status FROM gauge WHERE COALESCE(status,'')<>'报废' ORDER BY gauge_id") };
});

route('GET', /^\/api\/spc\/([^/]+)\/datasets\/(\d+)$/, (m, body, qs) => {
  const mon = q(`SELECT mi.* FROM monitoring_item mi
    JOIN cp_row r ON r.cp_row_id=mi.cp_row_id JOIN control_plan cp ON cp.cp_id=r.cp_id
    WHERE mi.mon_id=? AND cp.project_id=?`, m[1], CUR);
  if (!mon) throw new Error('监控项不存在');
  const dataset = q('SELECT * FROM spc_dataset WHERE dataset_id=? AND mon_id=?', +m[2], m[1]);
  if (!dataset) throw new Error('SPC 数据集不存在');
  const cpRow = q(`SELECT c.*,
      COALESCE(pc.name,cm.name) char_name,
      COALESCE(pc.lsl,cm.lsl) lsl, COALESCE(pc.usl,cm.usl) usl,
      COALESCE(pc.unit,cm.unit) unit, COALESCE(pc.target,cm.target) target,
      COALESCE(pc.tol_text,cm.tol_text) tol_text,
      COALESCE(pc.is_special,cm.is_special) is_special,
      COALESCE(pc.special_symbol,cm.special_symbol) special_symbol,
      COALESCE(c.project_char_id,pc.pchar_id) project_char_id
    FROM cp_row c
    LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(c.project_char_id,?)
    LEFT JOIN char_master cm ON cm.char_id=COALESCE(pc.char_id,c.char_id)
    WHERE c.cp_row_id=?`, mon.project_char_id || null, mon.cp_row_id);
  const chartOptions = spcChartOptions(JSON.parse(dataset.data_json), mon,
    { lsl: cpRow.lsl, usl: cpRow.usl });
  const requestedChart = qs.get('chart') || mon.chart_type;
  const stat = chartOptions[requestedChart] || chartOptions[mon.chart_type] || Object.values(chartOptions)[0];
  if (!stat) throw new Error('当前数据无法计算所选控制图');
  return { dataset, stat, cpRow };
});

// Q-15：限制同时解析的 Excel 导入数量，避免大文件并发占满内存
let spcImportBusy = 0;

// Q-07：手工录入与 Excel 导入统一按“监控项 + 规范化数据内容”生成哈希，文件名/字节不参与
function spcDatasetHash(monId, subgroups) {
  const normalized = (Array.isArray(subgroups) ? subgroups : []).map(group => ({
    t: String(group.t == null ? '' : group.t).trim(),
    v: (Array.isArray(group.v) ? group.v : []).map(value => +value),
  }));
  return crypto.createHash('sha256')
    .update(JSON.stringify([String(monId), normalized])).digest('hex');
}

route('POST', /^\/api\/spc\/([^/]+)$/, (m, body) => {
  const mon = q(`SELECT mi.* FROM monitoring_item mi
    JOIN cp_row r ON r.cp_row_id=mi.cp_row_id JOIN control_plan cp ON cp.cp_id=r.cp_id
    WHERE mi.mon_id=? AND cp.project_id=?`, m[1], CUR);
  if (!mon) throw new Error('监控项不存在');
  if (mon.status !== '启用') throw new Error('该监控配置已停用，只能查看历史，不能导入数据');
  if (mon.approval_status !== '已批准') throw new Error('监控项尚未通过质量审核，不能导入数据');
  const subs = body.subgroups;
  if (!Array.isArray(subs) || subs.length < 5) throw new Error('至少需要 5 个子组');
  const expectedValues = String(mon.chart_type || '').toUpperCase() === 'P' ? 2
    : ['I-MR', 'C'].includes(String(mon.chart_type || '').toUpperCase()) ? 1 : mon.subgroup_n;
  for (const s of subs) {
    if (!Array.isArray(s.v) || s.v.length !== expectedValues) {
      throw new Error(`当前 ${mon.chart_type} 图每个子组必须有 ${expectedValues} 个数值`);
    }
    if (s.v.some(value => !Number.isFinite(+value))) throw new Error('子组数据中存在非数值');
  }
  const json = JSON.stringify(subs);
  const batchNo = String(body.batch_no || '').trim();
  if (batchNo && q('SELECT 1 FROM spc_dataset WHERE mon_id=? AND batch_no=?', mon.mon_id, batchNo)) {
    throw Object.assign(new Error(`批次号“${batchNo}”已存在，请换一个批次号或先核对历史数据`), { statusCode: 409 });
  }
  const fileHash = spcDatasetHash(mon.mon_id, subs);
  if (q('SELECT 1 FROM spc_dataset WHERE mon_id=? AND file_hash=?', mon.mon_id, fileHash)) {
    throw new Error('同一组 SPC 数据已导入，请勿重复提交');
  }
  const r = DB.db.prepare(`INSERT INTO spc_dataset(mon_id,batch_no,imported_at,imported_by,file_hash,data_json,n_sub)
    VALUES(?,?,?,?,?,?,?)`).run(mon.mon_id, batchNo || '批次-' + Date.now().toString().slice(-6),
    DB.now(), actorName(), fileHash, json, subs.length);
  L.audit(actorName(), '导入', 'spc_dataset', String(r.lastInsertRowid), null, { n: subs.length }, 'SPC 数据导入');
  return { ok: true, dataset_id: Number(r.lastInsertRowid) };
});

route('POST', /^\/api\/spc\/([^/]+)\/import$/, (m, body) => {
  const mon = q(`SELECT mi.* FROM monitoring_item mi
    JOIN cp_row r ON r.cp_row_id=mi.cp_row_id JOIN control_plan cp ON cp.cp_id=r.cp_id
    WHERE mi.mon_id=? AND cp.project_id=?`, m[1], CUR);
  if (!mon) throw new Error('监控项不存在');
  if (mon.status !== '启用') throw new Error('该监控配置已停用，只能查看历史，不能导入数据');
  if (mon.approval_status !== '已批准') throw new Error('监控项尚未通过质量审核，不能导入数据');
  if (!body.dataBase64) throw new Error('缺少 Excel 文件');
  // Q-15：并发导入设上限；解析完成后立即释放原始缓冲引用
  if (spcImportBusy >= 2) throw new Error('当前已有导入任务在处理，请稍后重试');
  let buffer = Buffer.from(body.dataBase64, 'base64');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('Excel 文件超过 12 MB');
  spcImportBusy += 1;
  try {
    const parsed = P.parseXlsx(buffer);
    buffer = null;
    const sheet = parsed.sheets[Math.min(+body.sheetIndex || 0, parsed.sheets.length - 1)];
    if (!sheet) throw new Error('未找到工作表');
    const subgroups = [];
    const skipped = [];
    const expectedValues = String(mon.chart_type || '').toUpperCase() === 'P' ? 2
      : ['I-MR', 'C'].includes(String(mon.chart_type || '').toUpperCase()) ? 1 : mon.subgroup_n;
    for (let row = 0; row <= sheet.maxRow; row += 1) {
      const values = [];
      let label = '';
      for (let column = 0; column <= sheet.maxCol; column += 1) {
        const cell = sheet.cells.get(`${row},${column}`);
        if (!cell) continue;
        const text = String(cell.v).trim();
        if (Number.isFinite(+text) && text !== '') values.push(+text);
        else if (!label) label = text;
      }
      if (values.length === expectedValues) {
        subgroups.push({ t: label || `导入-${subgroups.length + 1}`, v: values });
      } else if (values.length || label) {
        // Q-11：不再静默丢弃，返回行号与原因供页面定位
        skipped.push({ row: row + 1, reason: `数值个数 ${values.length}，应为 ${expectedValues}` });
      }
    }
    if (subgroups.length < 5) {
      throw Object.assign(
        new Error(`Excel 中可用子组不足 5 个；请确保每行恰好包含 ${expectedValues} 个数值`
          + (skipped.length ? `（已跳过 ${skipped.length} 行，首个问题在第 ${skipped[0].row} 行）` : '')),
        { statusCode: 400, details: { skipped: skipped.slice(0, 50) } }
      );
    }
    const batchNo = String(body.batch_no || '').trim();
    if (batchNo && q('SELECT 1 FROM spc_dataset WHERE mon_id=? AND batch_no=?', mon.mon_id, batchNo)) {
      throw Object.assign(new Error(`批次号“${batchNo}”已存在，请换一个批次号或先核对历史数据`), { statusCode: 409 });
    }
    const json = JSON.stringify(subgroups);
    const fileHash = spcDatasetHash(mon.mon_id, subgroups);
    if (q('SELECT 1 FROM spc_dataset WHERE mon_id=? AND file_hash=?', mon.mon_id, fileHash)) {
      throw new Error('同一组 SPC 数据已导入过（与手工录入或此前 Excel 内容相同）');
    }
    const result = DB.db.prepare(`INSERT INTO spc_dataset(
      mon_id,batch_no,imported_at,imported_by,file_hash,data_json,n_sub
    ) VALUES(?,?,?,?,?,?,?)`).run(
      mon.mon_id, batchNo || sheet.name + '-' + Date.now().toString().slice(-6),
      DB.now(), actorName(), fileHash, json, subgroups.length
    );
    L.audit(actorName(), '导入', 'spc_dataset', String(result.lastInsertRowid),
      null, { n: subgroups.length, skipped: skipped.length, source: 'xlsx' }, 'SPC Excel 导入');
    return {
      ok: true, dataset_id: Number(result.lastInsertRowid), count: subgroups.length,
      accepted: subgroups.length, skipped: skipped.slice(0, 50),
      warnings: parsed.warnings || [],
    };
  } finally {
    spcImportBusy = Math.max(0, spcImportBusy - 1);
  }
});

route('GET', /^\/api\/msa$/, () => {
  const today = DB.now().slice(0, 10);
  const plans = DB.listMsaPlans(CUR);
  // 检具台账是全厂共享主数据，但本项目页面只能看到“本项目用过或计划要用”的台，
  // 否则新建项目里会凭空出现一堆别的项目的设备
  const usedGaugeIds = new Set();
  for (const plan of plans) if (plan.gauge_id) usedGaugeIds.add(plan.gauge_id);
  for (const row of all(`SELECT DISTINCT c.gauge_id FROM cp_row c
      JOIN control_plan p ON p.cp_id=c.cp_id WHERE p.project_id=? AND c.gauge_id IS NOT NULL`, CUR)) {
    usedGaugeIds.add(row.gauge_id);
  }
  for (const row of all('SELECT DISTINCT gauge_id FROM msa_study WHERE project_id=? AND gauge_id IS NOT NULL', CUR)) {
    usedGaugeIds.add(row.gauge_id);
  }
  const markGauge = gauge => ({
    ...gauge,
    calibration_warning: !gauge.calibration_due || gauge.calibration_due < today
      || ['停用', '报废'].includes(gauge.status),
  });
  const allGauges = all('SELECT * FROM gauge ORDER BY gauge_id');
  const gauges = allGauges.filter(gauge => usedGaugeIds.has(gauge.gauge_id)).map(markGauge);
  // 本项目还没用过的台账检具：默认隐藏，前端可让用户显式展开（临时研究需要时选别台）
  const otherGauges = allGauges.filter(gauge => !usedGaugeIds.has(gauge.gauge_id)).map(markGauge);
  const realGaugeIds = new Set(gauges.map(gauge => gauge.gauge_id));
  const realGaugeCodes = new Set(gauges.flatMap(gauge => [gauge.gauge_id, gauge.code].filter(Boolean)));
  const planOnly = new Map();
  for (const plan of plans.filter(item => item.source_active !== 0)) {
    const key = plan.gauge_id || plan.gauge_code || plan.gauge_name;
    if (plan.gauge_id && realGaugeIds.has(plan.gauge_id)) continue;
    if ((plan.gauge_code && realGaugeCodes.has(plan.gauge_code))
        || (!plan.gauge_code && plan.gauge_name && gauges.some(gauge => gauge.name === plan.gauge_name))) continue;
    if (!key) continue;
    if (!planOnly.has(key)) {
      planOnly.set(key, {
        gauge_id: `PLAN-${DB.hash(key).slice(0, 12).toUpperCase()}`,
        code: plan.gauge_code || '未建台账',
        name: plan.gauge_name || plan.gauge_code || '未命名检具',
        model: '',
        range_text: '来自已批准 MSA 计划',
        resolution: null,
        calibration_due: '',
        owner_dept: '',
        status: '待建台账',
        planned_only: true,
        plan_ids: [],
        calibration_warning: true,
      });
    }
    planOnly.get(key).plan_ids.push(plan.plan_id);
  }
  return {
    gauges: [...gauges, ...planOnly.values()],
    other_gauges: otherGauges,
    plans,
    projectChars: projectCharacterRows(CUR).items,
    studies: all(`SELECT ms.*, COALESCE(pc.name,cm.name) char_name,
        COALESCE(pc.unit,cm.unit) char_unit, COALESCE(pc.target,cm.target) char_target,
        COALESCE(pc.lsl,cm.lsl) char_lsl, COALESCE(pc.usl,cm.usl) char_usl,
        COALESCE(ms.tolerance,ABS(COALESCE(pc.usl,cm.usl)-COALESCE(pc.lsl,cm.lsl))) effective_tolerance,
        p.source_active plan_source_active, p.source_status plan_source_status
      FROM msa_study ms
      LEFT JOIN project_char pc ON pc.pchar_id=ms.project_char_id
      LEFT JOIN char_master cm ON cm.char_id=ms.char_id
      LEFT JOIN msa_plan_item p ON p.plan_id=ms.plan_id AND p.project_id=ms.project_id
      WHERE ms.project_id=? ORDER BY ms.study_id DESC`, CUR).map(study => {
        const raw = JSON.parse(study.raw_json || 'null');
        const snapshot = JSON.parse(study.plan_snapshot_json || 'null');
        // M-13：来源计划已替代/待复核时，已完成研究标记“依据已失效”，PPAP 不得再引用
        const sourceInvalid = !!study.plan_id && (study.plan_source_active === 0
          || ['待复核', '来源已失效', '已替代'].includes(study.plan_source_status || ''));
        let partValues = null;
        try { partValues = JSON.parse(study.part_values_json || 'null'); } catch (e) { partValues = null; }
        return { ...study, part_values: Array.isArray(partValues) ? partValues : null,
          char_name: snapshot?.char_name_snapshot || snapshot?.char_name || snapshot?.project_char?.name || study.char_name,
          char_unit: snapshot?.char_unit_snapshot || snapshot?.project_char?.unit || study.char_unit,
          measure_tech: snapshot?.measure_tech || '',
          evidence_ref: raw?.external ? raw.evidence_ref : '', method: raw?.external ? raw.method : '',
          source_invalid: sourceInvalid,
          source_invalid_reason: sourceInvalid ? `来源计划${study.plan_source_status || '已失效'}` : '' };
      }),
  };
});

route('POST', /^\/api\/msa\/simulate$/, (m, body) => {
  const projectChar = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
    body.project_char_id, CUR);
  if (!projectChar) throw new Error('项目特性不存在');
  const gauge = q('SELECT * FROM gauge WHERE gauge_id=?', body.gauge_id);
  if (!gauge) throw new Error('检具不存在');
  if (!gauge.calibration_due || gauge.calibration_due < DB.now().slice(0, 10)) {
    throw new Error('检具校准已过期，不能用模拟数据代替有效测量系统研究');
  }
  const parts = Math.max(2, Math.min(10, +body.parts || 10));
  const ops = Math.max(2, Math.min(4, +body.operators || 3));
  const trials = Math.max(2, Math.min(5, +body.trials || 3));
  const result = simulateMsaStudy({
    projectChar, gauge, parts, ops, trials,
    targetPct: +body.target_pct || 10,
    tolerance: +body.tolerance || 0,
  });
  L.audit('陈-计量', '模拟', 'msa_study', projectChar.pchar_id, null, {
    gauge_id: gauge.gauge_id, target_pct: result.target_pct, actual_pct: result.actual_pct,
  }, '按量具分辨力和项目特性生成 MSA 模拟数据');
  return {
    ok: true,
    ...result,
    gauge: { ...gauge, effective_resolution: result.gauge_resolution },
    char: projectChar,
    parts, operators: ops, trials,
  };
});

route('PATCH', /^\/api\/msa\/plans\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM msa_plan_item WHERE plan_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('MSA 计划不存在');
  if (old.status === '已完成' && body.status !== '已完成') {
    throw new Error('已完成的 MSA 计划不能回退；如需重做，请新建复评计划');
  }
  if (old.source_active === 0 || old.source_status === '待复核') throw new Error('计划来源已变更或未批准，请先复核控制计划');
  if (old.study_id && ['parts', 'operators', 'trials', 'tolerance'].some(field => body[field] !== undefined
      && Number(body[field]) !== Number(old[field]))) {
    throw new Error('已有研究的计划不能修改研究设计，请修订来源后建立复评计划');
  }
  // M-03：允许“评审不通过 → 退回计划”，避免非接受研究把计划永久卡在“研究中”
  if (body.status !== undefined && body.status !== old.status) {
    if (!['计划', '研究中'].includes(body.status)) {
      throw new Error('计划状态只能手工在“计划/研究中”之间切换；完成请使用研究完成确认');
    }
    if (!(old.status === '研究中' && body.status === '计划')
        && !(old.status === '计划' && body.status === '研究中')) {
      throw new Error(`MSA 计划不能从“${old.status}”直接变为“${body.status}”`);
    }
    if (old.status === '研究中' && body.status === '计划') {
      if (String(body.note || '').trim().length < 4) {
        throw new Error('退回计划必须填写评审不通过或重做原因');
      }
      DB.db.prepare(`UPDATE msa_plan_item SET status='计划',study_id=NULL,completed_at=NULL,
        note=COALESCE(note,'') || ?, updated_at=? WHERE plan_id=? AND project_id=?`)
        .run(`\n[退回计划 ${DB.now()}] ${String(body.note).trim()}`, DB.now(), id, CUR);
      L.audit(actorName(), '退回', 'msa_plan_item', id, old,
        { status: '计划', note: body.note }, body.note);
      const plans = DB.ensureMsaPlans(CUR);
      return { ok: true, item: plans.find(plan => plan.plan_id === id) };
    }
    DB.db.prepare('UPDATE msa_plan_item SET status=?,updated_at=? WHERE plan_id=? AND project_id=?')
      .run(body.status, DB.now(), id, CUR);
    L.audit(actorName(), '修改', 'msa_plan_item', id, old, { status: body.status }, body.note || '计划状态调整');
    const plans = DB.ensureMsaPlans(CUR);
    return { ok: true, item: plans.find(plan => plan.plan_id === id) };
  }
  const fields = ['planned_date', 'owner', 'parts', 'operators', 'trials', 'tolerance', 'note'];
  const sets = [], values = [];
  for (const field of fields) {
    if (body[field] === undefined) continue;
    let value = body[field];
    if (field === 'tolerance') {
      value = +value;
      if (!Number.isFinite(value) || value <= 0) throw new Error('研究计划容差必须大于0');
    }
    if (['parts', 'operators', 'trials'].includes(field)) {
      value = +value;
      const limits = field === 'parts' ? [2, 10] : field === 'operators' ? [2, 4] : [2, 5];
      if (!Number.isInteger(value) || value < limits[0] || value > limits[1]) {
        throw new Error(`${field} 超出允许范围`);
      }
    }
    sets.push(`${field}=?`);
    values.push(value);
  }
  if (!sets.length) return { ok: true };
  sets.push('updated_at=?');
  values.push(DB.now(), id);
  DB.db.prepare(`UPDATE msa_plan_item SET ${sets.join(',')} WHERE plan_id=? AND project_id=?`).run(...values, CUR);
  const plans = DB.ensureMsaPlans(CUR);
  L.audit(body.user || '质量-陈', '修改', 'msa_plan_item', id, old, body, '维护 MSA 计划');
  return { ok: true, item: plans.find(plan => plan.plan_id === id) };
}));

function requireMsaPlan(planId, projectId) {
  const plan = DB.listMsaPlans(projectId).find(item => item.plan_id === planId);
  if (!plan) throw new Error('MSA 计划不存在');
  if (plan.status === '已完成') throw new Error('该 MSA 计划已完成，请新建复评研究');
  if (plan.source_active === 0 || plan.source_status !== '有效'
      || (plan.trigger_source !== 'P3-08' && !['已批准', '已冻结'].includes(plan.cp_status))) {
    throw new Error('MSA 计划来源已变更或未批准，请先复核来源文件');
  }
  return plan;
}

route('DELETE', /^\/api\/msa\/(\d+)$/, (m) => DB.tx(() => {
  const studyId = +m[1];
  const study = q('SELECT * FROM msa_study WHERE study_id=? AND project_id=?', studyId, CUR);
  if (!study) throw new Error('MSA 研究不存在');
  // M-05：已确认完成的研究是审核证据，不能物理删除；应走“作废”并保留记录
  if (study.status === '已完成') {
    throw Object.assign(
      new Error('该研究已确认完成，是 PPAP 审核证据，不能删除；如结论有误请使用“作废研究”并说明原因'),
      { statusCode: 409, details: { study_id: studyId } }
    );
  }
  const linkedPlans = all('SELECT plan_id,status,source_active FROM msa_plan_item WHERE project_id=? AND study_id=?',
    CUR, studyId);
  DB.db.prepare(`UPDATE msa_plan_item SET
    study_id=NULL,
    status=CASE WHEN source_active=1 THEN '计划' ELSE status END,
    completed_at=CASE WHEN source_active=1 THEN NULL ELSE completed_at END,
    updated_at=?
    WHERE project_id=? AND study_id=?`).run(DB.now(), CUR, studyId);
  DB.db.prepare('DELETE FROM msa_study WHERE study_id=? AND project_id=?').run(studyId, CUR);
  L.audit(actorName(), '删除', 'msa_study', String(studyId), study,
    { reset_plans: linkedPlans.map(plan => plan.plan_id) }, '删除 MSA 历史研究并重置关联计划');
  return { ok: true, deleted: studyId, reset_plans: linkedPlans.length };
}));

// M-05：作废已完成研究，保留记录与原始数据，计划退回“计划”状态
route('PATCH', /^\/api\/msa\/(\d+)\/void$/, (m, body) => DB.tx(() => {
  const studyId = +m[1];
  const study = q('SELECT * FROM msa_study WHERE study_id=? AND project_id=?', studyId, CUR);
  if (!study) throw new Error('MSA 研究不存在');
  if (study.status === '作废') return { ok: true, status: '作废' };
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw new Error('作废 MSA 研究必须填写原因');
  requirePermission('msa.void', '作废 MSA 研究');
  DB.db.prepare(`UPDATE msa_study SET status='作废',judgment='不接受' WHERE study_id=? AND project_id=?`)
    .run(studyId, CUR);
  const linked = all('SELECT plan_id,status,source_active FROM msa_plan_item WHERE project_id=? AND study_id=?',
    CUR, studyId);
  // 作废即撤销该研究对计划的占用，计划回到“计划”（来源状态另行提示）
  DB.db.prepare(`UPDATE msa_plan_item SET study_id=NULL,status='计划',completed_at=NULL,
    updated_at=? WHERE project_id=? AND study_id=?`).run(DB.now(), CUR, studyId);
  L.audit(actorName(), '作废', 'msa_study', String(studyId), study,
    { status: '作废', reason, reset_plans: linked.map(plan => plan.plan_id) }, reason);
  return { ok: true, status: '作废', reset_plans: linked.length };
}));

route('POST', /^\/api\/msa$/, (m, body) => DB.tx(() => {
  const plan = body.plan_id ? requireMsaPlan(body.plan_id, CUR) : null;
  if (plan && plan.study_type !== 'GRR') throw new Error('该计划不是GRR研究，请登记对应方法的外部研究报告');
  if (plan && ((body.gauge_id && body.gauge_id !== plan.gauge_id)
      || (body.project_char_id && body.project_char_id !== plan.project_char_id)
      || (body.parts !== undefined && +body.parts !== plan.parts)
      || (body.ops !== undefined && +body.ops !== plan.operators)
      || (body.trials !== undefined && +body.trials !== plan.trials)
      // M-07：计划公差为空时不能用“数字 !== null”判不一致；允许本次填写并写回计划。
      || (body.tolerance !== undefined && body.tolerance !== ''
        && +body.tolerance > 0 && plan.tolerance != null
        && +body.tolerance !== +plan.tolerance))) {
    throw new Error('MSA 研究的特性、量具和研究设计必须与计划一致，请先维护计划');
  }
  const gauge_id = plan?.gauge_id || body.gauge_id;
  const data = body.data;
  const parts = plan?.parts ?? (body.parts === undefined ? 10 : +body.parts);
  const ops = plan?.operators ?? (body.ops === undefined ? 3 : +body.ops);
  const trials = plan?.trials ?? (body.trials === undefined ? 3 : +body.trials);
  let projectChar = null;
  if (plan || body.project_char_id) {
    projectChar = q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?',
      plan?.project_char_id || body.project_char_id, CUR);
  } else if (body.char_id) {
    projectChar = DB.ensureProjectChar(CUR, body.char_id);
  }
  if (!projectChar) throw new Error('请选择当前项目的产品特性或过程特性');
  const rangeTolerance = projectChar.lsl != null && projectChar.usl != null
    ? Math.abs(projectChar.usl - projectChar.lsl) : 0;
  const enteredTolerance = body.tolerance !== undefined && body.tolerance !== '' && +body.tolerance > 0
    ? +body.tolerance : 0;
  const tolerance = plan && plan.tolerance != null ? +plan.tolerance
    : enteredTolerance > 0 ? enteredTolerance : rangeTolerance;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    if (plan && plan.tolerance == null) {
      throw new Error('该 MSA 计划尚未维护公差：请先在“公差”栏填写正数，或维护项目特性的 LSL/USL 后重新提交（本次填写会写回计划）');
    }
    throw new Error('容差必须大于 0；请先维护项目特性的规范上下限或手工填写容差');
  }
  if (plan && plan.tolerance == null) {
    // M-07：计划公差为空时，以本次研究的有效输入补全计划，用户无需先改来源控制计划。
    DB.db.prepare(`UPDATE msa_plan_item SET tolerance=?,updated_at=?
      WHERE plan_id=? AND project_id=?`).run(tolerance, DB.now(), plan.plan_id, CUR);
    plan.tolerance = tolerance;
  }
  if (!gauge_id) throw new Error('请选择检具');
  const gauge = q('SELECT * FROM gauge WHERE gauge_id=?', gauge_id);
  if (!gauge) throw new Error('检具不存在');
  if (['报废', '停用'].includes(gauge.status)) throw new Error('报废或停用检具不能进行 MSA 研究');
  if (!gauge.calibration_due || gauge.calibration_due < DB.now().slice(0, 10)) {
    throw new Error('检具校准无效或已过期，请先完成校准');
  }
  if (![2, 3, 4, 5, 6, 7, 8, 9, 10].includes(+parts) || ![2, 3, 4].includes(+ops) || ![2, 3, 4, 5].includes(+trials)) {
    throw new Error('当前支持 2–10 个零件、2–4 个评价人、2–5 次试验');
  }
  if (!Array.isArray(data) || data.length !== ops * trials) throw new Error('数据维度不匹配');
  if (data.some(row => !Array.isArray(row) || row.length !== +parts
    || row.some(value => value == null || (typeof value === 'string' && !value.trim())
      || !['string', 'number'].includes(typeof value) || !Number.isFinite(+value)))) {
    throw new Error(`每行必须包含 ${parts} 个有效数值`);
  }
  const readings = data.map(row => row.map(Number));
  // 模拟数据的“零件真实值”（每条测量链的中心值）；仅接受与当前研究维度一致的数组
  const partValues = Array.isArray(body.part_values) && body.part_values.length === +parts
    && body.part_values.every(value => Number.isFinite(+value))
    ? body.part_values.map(value => +value) : null;
  const res = DB.computeGRR(readings, parts, ops, trials, tolerance);
  const r = DB.db.prepare(`INSERT INTO msa_study(
    project_id,gauge_id,study_type,char_id,project_char_id,tolerance,
    result_pct,ev_pct,av_pct,pct_tol,ndc,judgment,studied_at,operator,raw_json,
    plan_id,status,plan_snapshot_json,part_values_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    CUR, gauge_id, 'GRR', projectChar.char_id, projectChar.pchar_id, tolerance,
    res.pctGRR, res.pctEV, res.pctAV, res.pctTol, res.ndc,
    res.judgment, DB.now().slice(0, 10), body.operator || '陈-计量', JSON.stringify(readings),
    plan ? plan.plan_id : null, '已计算',
    JSON.stringify(plan || { project_char: projectChar, gauge, parts, operators: ops, trials, tolerance }),
    partValues ? JSON.stringify(partValues) : null
  );
  if (plan) {
    DB.db.prepare(`UPDATE msa_plan_item SET
      study_id=?,status='研究中',parts=?,operators=?,trials=?,updated_at=?
      WHERE plan_id=? AND project_id=?`).run(r.lastInsertRowid, +parts, +ops, +trials, DB.now(), plan.plan_id, CUR);
  }
  L.audit('陈-计量', '新增', 'msa_study', String(r.lastInsertRowid), null, res, 'GR&R 研究');
  return {
    ...res, study_id: Number(r.lastInsertRowid), project_char_id: projectChar.pchar_id,
    char_id: projectChar.char_id, char_name: projectChar.name, tolerance,
    plan_id: plan ? plan.plan_id : null, status: '已计算', sync: null,
    part_values: partValues,
  };
}));

route('POST', /^\/api\/msa\/external$/, (m, body) => DB.tx(() => {
  const plan = requireMsaPlan(body.plan_id, CUR);
  const evidence = String(body.evidence_ref || '').trim();
  const method = String(body.method || '').trim();
  const operator = String(body.operator || '').trim();
  const studiedAt = String(body.studied_at || '').trim();
  if (!evidence || !method || !operator || !/^\d{4}-\d{2}-\d{2}$/.test(studiedAt)
      || !Number.isFinite(Date.parse(studiedAt)) || studiedAt > DB.now().slice(0, 10)) {
    throw new Error('请填写受控报告编号、实际研究方法、研究人和有效的研究日期');
  }
  if (!['接受', '条件接受', '不接受'].includes(body.judgment)) throw new Error('请选择报告的实际研究结论');
  const report = { external: true, evidence_ref: evidence, method, operator, studied_at: studiedAt };
  const inserted = DB.db.prepare(`INSERT INTO msa_study(
    project_id,gauge_id,study_type,char_id,project_char_id,tolerance,judgment,studied_at,
    operator,raw_json,plan_id,status,plan_snapshot_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'已计算',?)`).run(
    CUR, plan.gauge_id, plan.study_type, plan.char_id, plan.project_char_id, plan.tolerance,
    body.judgment, studiedAt, operator, JSON.stringify(report), plan.plan_id, JSON.stringify(plan));
  const studyId = Number(inserted.lastInsertRowid);
  DB.db.prepare(`UPDATE msa_plan_item SET study_id=?,status='研究中',updated_at=? WHERE plan_id=? AND project_id=?`)
    .run(studyId, DB.now(), plan.plan_id, CUR);
  L.audit(operator, '登记外部研究', 'msa_study', String(studyId), null, report, '受控外部报告引用，未生成GRR计算值');
  return { ok: true, study_id: studyId, status: '已计算', judgment: body.judgment, sync: null };
}));

route('PATCH', /^\/api\/msa\/(\d+)\/complete$/, (m, body) => DB.tx(() => {
  const study = q('SELECT * FROM msa_study WHERE study_id=? AND project_id=?', +m[1], CUR);
  if (!study) throw new Error('MSA 研究不存在');
  if (study.status === '已完成') return { ok: true, status: '已完成' };
  if (study.judgment !== '接受') {
    throw new Error('只有综合判定为“接受”的 MSA 研究才能确认完成');
  }
  const completedBy = String(body.completed_by || '').trim();
  if (!completedBy) throw new Error('请填写完成确认人');
  if (study.plan_id) {
    const plan = requireMsaPlan(study.plan_id, CUR);
    if (plan.study_id !== study.study_id) throw new Error('此研究已被后续研究替代，请确认计划当前研究');
  }
  DB.db.prepare(`UPDATE msa_study SET status='已完成',completed_by=?,completed_at=?
    WHERE study_id=? AND project_id=?`).run(completedBy, DB.now(), study.study_id, CUR);
  if (study.plan_id) {
    DB.db.prepare(`UPDATE msa_plan_item SET status='已完成',completed_at=?,updated_at=?
      WHERE plan_id=? AND project_id=?`).run(DB.now(), DB.now(), study.plan_id, CUR);
  }
  L.audit(completedBy, '完成', 'msa_study', String(study.study_id), study.status,
    { status: '已完成', judgment: study.judgment }, '确认 MSA 研究完成');
  return { ok: true, status: '已完成', completed_by: completedBy, sync: null };
}));

route('POST', /^\/api\/gauges$/, (m, body) => {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code || !name) throw new Error('检具编号和名称不能为空');
  const id = String(body.gauge_id || `G-${code}`).trim();
  if (q('SELECT 1 FROM gauge WHERE gauge_id=? OR code=?', id, code)) throw new Error('检具编号已存在');
  DB.db.prepare(`INSERT INTO gauge(
    gauge_id,code,name,model,range_text,calibration_due,owner_dept,status,resolution
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    id, code, name, body.model || '', body.range_text || '',
    body.calibration_due || '', body.owner_dept || '', body.status || '在用',
    body.resolution === '' || body.resolution == null ? null : +body.resolution
  );
  L.audit(body.user || actorName(), '新增', 'gauge', id, null, body, '新增检具');
  DB.ensureMsaPlans(CUR);
  return { ok: true, gauge_id: id };
});

route('PATCH', /^\/api\/gauges\/([^/]+)$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM gauge WHERE gauge_id=?', id);
  if (!old) throw new Error('检具不存在');
  const fields = ['code', 'name', 'model', 'range_text', 'calibration_due', 'owner_dept', 'status', 'resolution'];
  const sets = [];
  const values = [];
  for (const field of fields) {
    if (body[field] !== undefined) { sets.push(`${field}=?`); values.push(body[field]); }
  }
  if (body.code !== undefined && !String(body.code).trim()) throw new Error('检具编号不能为空');
  if (body.name !== undefined && !String(body.name).trim()) throw new Error('检具名称不能为空');
  // M-06：编辑时同样校验编号唯一，不能改成另一台检具的编号
  if (body.code !== undefined) {
    const duplicate = q('SELECT gauge_id FROM gauge WHERE gauge_id<>? AND (code=? OR gauge_id=?) LIMIT 1',
      id, String(body.code).trim(), String(body.code).trim());
    if (duplicate) {
      throw Object.assign(new Error(`检具编号 ${body.code} 已被 ${duplicate.gauge_id} 使用`), { statusCode: 409 });
    }
  }
  if (body.resolution !== undefined && body.resolution !== ''
      && (!Number.isFinite(+body.resolution) || +body.resolution <= 0)) {
    throw new Error('检具分辨力必须为正数');
  }
  if (body.resolution === '') {
    const index = fields.indexOf('resolution');
    if (index >= 0) {
      const setIndex = sets.findIndex(item => item === 'resolution=?');
      if (setIndex >= 0) values[setIndex] = null;
    }
  }
  if (!sets.length) return { ok: true };
  values.push(id);
  DB.db.prepare(`UPDATE gauge SET ${sets.join(',')} WHERE gauge_id=?`).run(...values);
  L.audit(body.user || actorName(), '修改', 'gauge', id, old, body, '维护检具台账');
  DB.ensureMsaPlans(CUR);
  // M-06：清空校准到期日会让检具在 MSA 页被判定预警，必须明确提示原因
  const warning = body.calibration_due !== undefined && !String(body.calibration_due || '').trim()
    ? '已清空校准到期日：该检具在 MSA 中会被视为校准无效，不能新建或完成研究'
    : '';
  return { ok: true, warning };
});

/** A-10：页面、预览、导出共用同一套“展示数据装配”。 */
function documentDisplayData(code, raw, projectId = CUR) {
  let data = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {};
  data = fillCharacteristicTypes(code, data);
  data = checklistData(code, data);
  const project = q('SELECT name,part_no FROM project WHERE project_id=?', projectId) || {};
  if (!String(data.proj || '').trim()) data.proj = project.name || '';
  if (!String(data.part_no || '').trim()) data.part_no = project.part_no || '';
  return data;
}

function buildProjectDocPreview(code, row) {
  const meta = DT.CATALOG.find(item => item.code === code) || {};
  const schema = docSchema(code, meta);
  let data = {};
  let savedCols = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch (e) { data = {}; }
  try { savedCols = JSON.parse(row.cols_json || '{}'); } catch (e) { savedCols = {}; }
  try { data = documentDisplayData(code, data); } catch (error) { /* 历史数据损坏时退回原始内容 */ }
  return {
    name: row.custom_name || meta.name || code,
    status: row.status || '未开始',
    version: row.version || 'V1.0',
    updated_at: row.updated_at || null,
    approved_by: row.approved_by || '',
    sections: schema.map(section => ({
      title: section.t,
      note: section.note || '',
      fields: section.fields.map(field => ({
        label: field.label,
        key: field.k,
        type: field.type,
        cols: field.type === 'table' && savedCols[field.k] ? savedCols[field.k] : (field.cols || []),
        value: field.type === 'table' ? (Array.isArray(data[field.k]) ? data[field.k] : []) : (data[field.k] ?? ''),
      })),
    })),
  };
}

function previewField(label, value, type = 'text') {
  return { label, value: value ?? '', type };
}

function previewTable(label, columns, rows) {
  return { label, type: 'table', columns, rows };
}

function buildFormRelatedPreview(code, meta, versionKey) {
  const doc = q('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', CUR, code) || {};
  const approved = q(`SELECT * FROM project_doc_revision
    WHERE project_id=? AND doc_code=? AND status='已批准' AND TRIM(COALESCE(approved_by,''))<>''
    ORDER BY COALESCE(approved_at,changed_at) DESC,rowid DESC LIMIT 1`, CUR, code);
  const selectedKey = versionKey === 'approved' && approved ? 'approved' : 'current';
  const selectedRow = selectedKey === 'approved' ? approved : doc;
  const selected = buildProjectDocPreview(code, selectedRow);
  const versions = [{
    key: 'current', label: '当前内容', status: doc.status || '未开始',
    version: doc.version || 'V1.0', updated_at: doc.updated_at || '',
  }];
  if (approved) versions.push({
    key: 'approved', label: '最新批准版本', status: approved.status || '已批准',
    version: approved.version || doc.version || 'V1.0',
    updated_at: approved.approved_at || approved.changed_at || '',
  });
  return {
    meta: {
      code, name: meta.name, phase: meta.phase, kind: meta.kind, owner: meta.owner || doc.owner || '',
      status: selected.status || doc.status || '未开始',
      version: selected.version || selectedRow.version || doc.version || 'V1.0',
      approved_by: selected.approved_by || selectedRow.approved_by || '',
      updated_at: selected.updated_at || selectedRow.approved_at || selectedRow.changed_at || '',
    },
    versions, selectedVersion: selectedKey,
    sections: selected.sections.map(section => ({
      title: section.title,
      note: section.note || '',
      fields: section.fields.map(field => field.type === 'table'
        ? previewTable(field.label, field.cols || [], Array.isArray(field.value) ? field.value : [])
        : previewField(field.label, field.value, field.type)),
    })),
  };
}

function modulePreviewMeta(code, meta, status, version, extra = {}) {
  return {
    code, name: meta.name, phase: meta.phase, kind: meta.kind, owner: meta.owner || '',
    status: status || '未开始', version: version || '', approved_by: extra.approved_by || '',
    updated_at: extra.updated_at || '', note: extra.note || '',
  };
}

function buildModuleRelatedPreview(code, meta) {
  if (meta.module === 'fmea') {
    const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, meta.arg);
    if (!header) return {
      meta: modulePreviewMeta(code, meta, '未开始', ''),
      versions: [{ key: 'current', label: '当前内容', status: '未开始', version: '' }],
      selectedVersion: 'current', sections: [],
    };
    const nodes = all(`SELECT * FROM fmea_node WHERE fmea_id=? AND COALESCE(status,'生效')<>'作废'
      ORDER BY node_type,seq`, header.fmea_id);
    const rows = all(`SELECT r.*,nf.name fe_name,nm.name fm_name,nc.name fc_name,
        d.decision,d.status decision_status
      FROM fmea_row r
      LEFT JOIN fmea_node nf ON nf.node_id=r.fe_id
      LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
      LEFT JOIN fmea_node nc ON nc.node_id=r.fc_id
      LEFT JOIN fmea_decision d ON d.row_id=r.row_id
      WHERE r.fmea_id=? ORDER BY r.seq`, header.fmea_id);
    return {
      meta: modulePreviewMeta(code, meta, header.status, header.rev, {
        approved_by: header.approved_by || '', updated_at: header.published_at || '',
      }),
      versions: [{ key: 'current', label: '当前模块内容', status: header.status,
        version: header.rev || '' }],
      selectedVersion: 'current',
      sections: [
        { title: 'FMEA 基本信息', fields: [
          previewField('FMEA 类型', header.fmea_type), previewField('标题', header.title),
          previewField('状态', header.status), previewField('版本', header.rev),
          previewField('AP 矩阵', header.ap_ver), previewField('批准人', header.approved_by),
        ] },
        { title: '结构节点', fields: [previewTable('结构', ['类型', '层级', '名称', '说明', '状态'],
          nodes.map(node => [node.node_type, node.level, node.name, node.desc, node.status]))] },
        { title: '失效分析', fields: [previewTable('分析行',
          ['失效影响 FE', '失效模式 FM', '失效原因 FC', 'S', 'O', 'D', 'AP', '预防控制', '探测控制', '决定'],
          rows.map(row => [row.fe_name, row.fm_name, row.fc_name, row.s, row.o, row.d, row.ap,
            row.pc_text, row.dc_text, row.decision || row.decision_status]))] },
      ],
    };
  }
  if (meta.module === 'pfd') {
    const mode = pfdMode(meta.arg);
    const steps = all(`SELECT * FROM process_step WHERE project_id=? AND pfd_mode=? AND COALESCE(status,'')<>'作废'
      ORDER BY seq`, CUR, mode);
    const status = !steps.length ? '未开始' : steps.every(step => step.status === '已发布') ? '已发布' : '进行中';
    return {
      meta: modulePreviewMeta(code, meta, status, steps[0]?.ver || ''),
      versions: [{ key: 'current', label: '当前模块内容', status, version: steps[0]?.ver || '' }],
      selectedVersion: 'current',
      sections: [{ title: '工序清单', fields: [previewTable('工艺流程',
        ['工序号', '名称', '类型', '设备', '工装', '输入', '输出', '状态'],
        steps.map(step => [step.step_no, step.name, step.step_type, step.equipment, step.fixture,
          step.input_desc, step.output_desc, step.status]))] }],
    };
  }
  if (meta.module === 'cp') {
    const plan = q('SELECT * FROM control_plan WHERE project_id=? AND stage=?', CUR, meta.arg);
    if (!plan) return {
      meta: modulePreviewMeta(code, meta, '未开始', ''),
      versions: [{ key: 'current', label: '当前内容', status: '未开始', version: '' }],
      selectedVersion: 'current', sections: [],
    };
    const rows = all(`SELECT c.*,s.step_no,s.name step_name,
        COALESCE(pc.name,cm.name) char_name,g.name gauge_name
      FROM cp_row c LEFT JOIN process_step s ON s.step_id=c.step_id
      LEFT JOIN project_char pc ON pc.pchar_id=c.project_char_id
      LEFT JOIN char_master cm ON cm.char_id=c.char_id
      LEFT JOIN gauge g ON g.gauge_id=c.gauge_id
      WHERE c.cp_id=? ORDER BY c.seq`, plan.cp_id);
    return {
      meta: modulePreviewMeta(code, meta, plan.status, plan.rev, {
        approved_by: plan.approved_by || '', updated_at: plan.effective_date || '',
      }),
      versions: [{ key: 'current', label: '当前模块内容', status: plan.status, version: plan.rev || '' }],
      selectedVersion: 'current',
      sections: [
        { title: '控制计划表头', fields: [
          previewField('阶段', plan.stage), previewField('零件号', plan.part_no),
          previewField('零件名称', plan.part_name), previewField('状态', plan.status),
          previewField('版本', plan.rev), previewField('批准人', plan.approved_by),
        ] },
        { title: '控制计划行', fields: [previewTable('控制计划',
          ['#', '工序', '特性', '规范/公差', '测量技术', '样本', '频率', '控制方法', '反应计划', '检具', 'SPC'],
          rows.map(row => [row.seq, [row.step_no, row.step_name].filter(Boolean).join(' '),
            row.char_name, row.spec_text, row.measure_tech, row.sample_size,
            [row.freq_value, row.freq_unit].filter(Boolean).join(' '), row.control_method,
            row.reaction_plan, row.gauge_name || row.gauge_id, row.is_spc ? '是' : '否']))] },
      ],
    };
  }
  if (meta.module === 'msa') {
    const plans = DB.listMsaPlans(CUR);
    const studies = all(`SELECT ms.*,COALESCE(pc.name,cm.name) char_name
      FROM msa_study ms LEFT JOIN project_char pc ON pc.pchar_id=ms.project_char_id
      LEFT JOIN char_master cm ON cm.char_id=ms.char_id
      WHERE ms.project_id=? ORDER BY ms.study_id DESC`, CUR);
    return {
      meta: modulePreviewMeta(code, meta, plans.length ? '进行中' : '未开始', ''),
      versions: [{ key: 'current', label: '当前模块内容', status: plans.length ? '进行中' : '未开始', version: '' }],
      selectedVersion: 'current',
      sections: [
        { title: 'MSA 计划', fields: [previewTable('计划',
          ['特性', '检具', '研究类型', '研究设计', '计划日期', '责任人', '来源', '状态'],
          plans.map(plan => [plan.char_name || plan.char_id, [plan.gauge_code, plan.gauge_name].filter(Boolean).join(' '),
            plan.study_type, [plan.parts, plan.operators, plan.trials].every(v => v != null)
              ? `${plan.parts}×${plan.operators}×${plan.trials}` : '', plan.planned_date,
            plan.owner, plan.trigger_source, [plan.status, plan.source_status].filter(Boolean).join(' / ')]))] },
        { title: 'MSA 研究', fields: [previewTable('研究记录',
          ['研究编号', '特性', '检具', '结果%', '判定', '状态', '研究日期'],
          studies.map(study => [study.study_id, study.char_name || study.char_id, study.gauge_id,
            study.result_pct, study.judgment, study.status, study.studied_at]))] },
      ],
    };
  }
  if (meta.module === 'spc') {
    const monitors = all(`SELECT m.*,c.spec_text,COALESCE(pc.name,cm.name) char_name,
        s.step_no,s.name step_name,cp.stage
      FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
      JOIN control_plan cp ON cp.cp_id=c.cp_id
      LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(m.project_char_id,c.project_char_id)
      LEFT JOIN char_master cm ON cm.char_id=COALESCE(m.char_id,c.char_id)
      LEFT JOIN process_step s ON s.step_id=c.step_id
      WHERE cp.project_id=? ORDER BY cp.stage,s.seq,m.created_at`, CUR);
    return {
      meta: modulePreviewMeta(code, meta, monitors.some(m => m.approval_status === '已批准') ? '已启用' : '进行中', ''),
      versions: [{ key: 'current', label: '当前模块内容', status: monitors.length ? '已配置' : '未开始', version: '' }],
      selectedVersion: 'current',
      sections: [{ title: 'SPC 监控项', fields: [previewTable('监控项',
        ['监控编号', '阶段', '工序', '特性', '规范', '控制图', '子组', '频次', 'Cpk目标', '状态'],
        monitors.map(monitor => [monitor.mon_id, monitor.stage,
          [monitor.step_no, monitor.step_name].filter(Boolean).join(' '), monitor.char_name,
          monitor.spec_text, monitor.chart_type, monitor.subgroup_n,
          [monitor.freq_value, monitor.freq_unit].filter(Boolean).join(' '),
          monitor.cpk_target, monitor.approval_status]))] }],
    };
  }
  if (meta.module === 'ppap') {
    const workflow = ppapWorkflowRows(CUR);
    return {
      meta: modulePreviewMeta(code, meta,
        workflow.length ? '进行中' : '未开始', ''),
      versions: [{ key: 'current', label: '当前模块内容', status: '进行中', version: '' }],
      selectedVersion: 'current',
      sections: [{ title: 'PPAP 18 项证据', fields: [previewTable('PPAP 要素',
        ['序号', '要素', '来源', '关联状态', 'PPAP状态'],
        workflow.map(item => [item.no, item.name, item.sourceLabel,
          item.linked_status, item.ppap_status]))] }],
    };
  }
  return {
    meta: modulePreviewMeta(code, meta, '活动', ''),
    versions: [{ key: 'current', label: '当前内容', status: '活动', version: '' }],
    selectedVersion: 'current', sections: [],
  };
}

function buildRelatedPreview(code, versionKey) {
  const meta = DT.CATALOG.find(item => item.code === code);
  if (!meta) throw new Error('关联交付物不存在');
  return meta.kind === 'form'
    ? buildFormRelatedPreview(code, meta, versionKey)
    : buildModuleRelatedPreview(code, meta);
}

/* B-02：AIAG PPAP 第 4 版提交等级清单（S=随 PSW 提交；未列出的要素由组织保留备查）。
   Level 4 默认仅 PSW，顾客指定的其他文件通过项目级 required_items 覆盖。 */
const PPAP_LEVEL_ITEMS = {
  1: [18],
  2: [1, 2, 3, 9, 10, 12, 13, 14, 17, 18],
  3: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  4: [18],
  5: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
};

function ppapRequiredItems(level, submission = {}) {
  let items = PPAP_LEVEL_ITEMS[level] || PPAP_LEVEL_ITEMS[3];
  if (level === 4) {
    let override = [];
    try {
      const parsed = JSON.parse(submission.required_items_json || '[]');
      if (Array.isArray(parsed)) override = parsed;
    } catch (error) { override = []; }
    const valid = override.map(Number).filter(no => Number.isInteger(no) && no >= 1 && no <= 18);
    if (valid.length) items = [...new Set([18, ...valid])].sort((a, b) => a - b);
  }
  return [...items];
}

function approvedPpapDeviation(projectId, elementNo) {
  const today = DB.now().slice(0, 10);
  return q(`SELECT * FROM ppap_deviation
    WHERE project_id=? AND element_no=? AND status='已批准'
      AND (valid_until IS NULL OR valid_until='' OR valid_until>=?)
    ORDER BY approved_at DESC,deviation_id DESC LIMIT 1`, projectId, elementNo, today);
}

function fmeaQualityIssues(projectId, fmeaType) {
  const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', projectId, fmeaType);
  if (!header) return { header: null, issues: [{ reason: `${fmeaType} 未创建` }] };
  if (header.status !== '已发布') {
    return { header, issues: [{ reason: `${fmeaType} 当前为${header.status}，未发布` }] };
  }
  const high = all(`SELECT r.row_id,r.s,r.o,r.d,r.ap,d.status,d.s AS ds,d.o AS do_,d.d AS dd,d.ap AS dap
    FROM fmea_row r LEFT JOIN fmea_decision d ON d.row_id=r.row_id
    WHERE r.fmea_id=? AND r.ap='H'`, header.fmea_id);
  const issues = high.filter(row => row.status !== '已批准'
    || row.ds == null || row.ds !== row.s || row.do_ !== row.o || row.dd !== row.d || row.dap !== row.ap)
    .map(row => ({ row_id: row.row_id, reason: `高 AP 行 ${row.row_id} 的处置决定未批准或基于旧 S/O/D` }));
  return { header, issues };
}

function spcMonitorCapability(projectId, monitor) {
  // Q-08：分选后数据不能用于能力放行（PPAP 要求分选前数据）
  if (monitor.before_sort === 0) {
    return { hasData: false, cpk: null, violations: 0, ok: false,
      reason: '监控项标记为含分选后数据，不能用于 PPAP 能力判定' };
  }
  const dataset = q('SELECT * FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC LIMIT 1', monitor.mon_id);
  if (!dataset) return { hasData: false, cpk: null, violations: 0, reason: '尚无 SPC 数据' };
  const row = q('SELECT * FROM cp_row WHERE cp_row_id=?', monitor.cp_row_id) || {};
  const pc = row.project_char_id
    ? q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?', row.project_char_id, projectId) : null;
  const cm = q('SELECT * FROM char_master WHERE char_id=?', row.char_id || '');
  const lsl = pc?.lsl ?? cm?.lsl ?? null;
  const usl = pc?.usl ?? cm?.usl ?? null;
  let stat = null;
  try {
    const options = spcChartOptions(JSON.parse(dataset.data_json || '[]'), monitor, { lsl, usl });
    stat = options[monitor.chart_type] || Object.values(options)[0] || null;
  } catch (error) { stat = null; }
  if (!stat) return { hasData: true, cpk: null, violations: 0, reason: '数据无法计算所选控制图' };
  const violations = Array.isArray(stat.violations) ? stat.violations.length : 0;
  const chartType = String(monitor.chart_type || '').toUpperCase();
  const attribute = chartType === 'P' || chartType === 'C';
  const target = Number.isFinite(+monitor.cpk_target) ? +monitor.cpk_target : DB.DEFAULT_CPK_TARGET;
  const capabilityOk = attribute ? true : stat.cpk != null && stat.cpk >= target;
  return {
    hasData: true, cpk: stat.cpk ?? null, violations, target, attribute,
    ok: capabilityOk && violations === 0,
    reason: !capabilityOk
      ? `Cpk ${stat.cpk == null ? '不可计算' : stat.cpk} < 目标 ${target}`
      : violations > 0 ? `控制图有 ${violations} 个判异信号` : '能力与稳定性满足要求',
  };
}

function ppapWorkflowRows(projectId) {
  const elements = all('SELECT * FROM ppap_element WHERE project_id=? ORDER BY element_no', projectId);
  const elementMap = new Map(elements.map(element => [element.element_no, element]));
  const docStatus = new Map(all('SELECT doc_code,status FROM project_doc WHERE project_id=?', projectId)
    .map(doc => [doc.doc_code, doc.status]));
  const completedDoc = status => ['已完成', '已批准', '系统模块'].includes(status);
  const plans = DB.listMsaPlans(projectId).filter(plan => plan.source_active !== 0);
  const monitors = all(`SELECT m.* FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
    JOIN control_plan cp ON cp.cp_id=r.cp_id
    WHERE cp.project_id=? AND m.status='启用' AND m.approval_status='已批准'`, projectId);
  return PPAP_WORKFLOW.map(mapping => {
    const element = elementMap.get(mapping.no) || {};
    let ready = false;
    let linkedStatus = '待关联';
    let detail = mapping.sourceLabel;
    if (mapping.sourceType === 'docs') {
      const docs = (mapping.sourceCodes || []).map(code => ({ code, status: docStatus.get(code) || '未创建' }));
      ready = docs.length > 0 && docs.every(doc => completedDoc(doc.status));
      linkedStatus = ready ? '已就绪' : docs.some(doc => doc.status !== '未创建') ? '进行中' : '待开始';
      detail = docs.map(doc => `${doc.code} ${doc.status}`).join('；');
    } else if (mapping.sourceType === 'fmea') {
      const quality = fmeaQualityIssues(projectId, mapping.fmeaType);
      const header = quality.header;
      ready = !!header && header.status === '已发布' && quality.issues.length === 0;
      linkedStatus = !header ? '未创建' : ready ? '已就绪' : header.status === '已发布' ? '质量门未通过' : header.status;
      detail = header
        ? `${mapping.fmeaType} ${header.rev} · ${header.status}${quality.issues.length
          ? `；${quality.issues.length} 项未闭环（${quality.issues[0].reason}）` : ''}`
        : `${mapping.fmeaType} 未创建`;
    } else if (mapping.sourceType === 'pfd') {
      const steps = all("SELECT status FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'", projectId);
      ready = steps.length > 0 && steps.every(step => step.status === '已发布');
      linkedStatus = ready ? '已就绪' : steps.length ? '进行中' : '未创建';
      detail = `${steps.length} 道有效工序，${steps.filter(step => step.status === '已发布').length} 道已发布`;
    } else if (mapping.sourceType === 'cp') {
      const cp = q('SELECT * FROM control_plan WHERE project_id=? AND stage=?', projectId, mapping.cpStage);
      ready = !!cp && ['已批准', '已冻结'].includes(cp.status);
      linkedStatus = cp ? (ready ? '已就绪' : cp.status) : '未创建';
      detail = cp ? `${mapping.cpStage} CP ${cp.rev} · ${cp.status}` : '控制计划未创建';
    } else if (mapping.sourceType === 'msa') {
      const completed = plans.filter(plan => plan.status === '已完成'
        && plan.source_status === '有效'
        && (plan.trigger_source === 'P3-08' || ['已批准', '已冻结'].includes(plan.cp_status)));
      const rejected = completed.filter(plan => {
        const study = plan.study_id
          ? q('SELECT judgment,status FROM msa_study WHERE study_id=? AND project_id=?',
            plan.study_id, projectId) : null;
        return !study || study.judgment !== '接受';
      });
      ready = plans.length > 0 && completed.length === plans.length && rejected.length === 0;
      linkedStatus = ready ? '已就绪' : plans.length ? '进行中' : '无计划';
      detail = `MSA 计划 ${plans.length} 项，完成 ${completed.length} 项`
        + (rejected.length ? `；${rejected.length} 项研究判定不接受或缺少结论` : '')
        + (plans.some(plan => plan.source_status !== '有效') ? '；存在来源待复核/已失效的计划' : '');
    } else if (mapping.sourceType === 'spc') {
      const checks = monitors.map(monitor => ({ monitor, check: spcMonitorCapability(projectId, monitor) }));
      const failed = checks.filter(item => !item.check.ok);
      ready = monitors.length > 0 && failed.length === 0;
      linkedStatus = ready ? '已就绪' : monitors.length ? '进行中' : '待开始';
      detail = `已批准监控 ${monitors.length} 项`
        + (failed.length ? `；${failed.length} 项能力/稳定性不满足（${failed[0].check.reason}）` : '；能力与稳定性满足');
    } else if (mapping.sourceType === 'gauge') {
      const gaugeRows = projectGauges(projectId);
      const valid = gaugeRows.filter(gauge => gauge.status !== '报废'
        && (!gauge.calibration_due || gauge.calibration_due >= DB.now().slice(0, 10)));
      ready = valid.length > 0;
      linkedStatus = ready ? '已登记' : '待登记';
      detail = `有效检具 ${valid.length}/${gaugeRows.length} 台`;
    } else {
      ready = element.status === '已完成';
      linkedStatus = element.status || '未完成';
      detail = element.evidence || mapping.sourceLabel;
    }
    // B-04：来源“存在”不等于“合格”。质量门不通过时只有书面偏差可放行。
    const deviation = approvedPpapDeviation(projectId, mapping.no);
    return {
      ...mapping,
      linked_ready: ready,
      linked_status: linkedStatus,
      link_detail: detail,
      ppap_status: element.status || '未完成',
      gate_ready: ready || !!deviation,
      gate_reason: ready ? '' : detail,
      deviation: deviation || null,
    };
  });
}

function ensurePpapSubmission(projectId) {
  const project = q('SELECT * FROM project WHERE project_id=?', projectId) || {};
  return q('SELECT * FROM ppap_submission WHERE project_id=?', projectId) || {
    project_id: projectId, level: 3, submission_reason: '',
    customer: project.customer || '', organization: project.name || '',
    part_revision: '', requested_by: project.owner || '', requested_at: '',
    approved_by: '', approved_at: '', status: '准备中', updated_at: '',
  };
}

function effectivePpapElements(projectId, workflow) {
  const rows = workflow || ppapWorkflowRows(projectId);
  const workflowMap = new Map(rows.map(item => [item.no, item]));
  return all('SELECT * FROM ppap_element WHERE project_id=? ORDER BY element_no', projectId).map(element => {
    const linked = workflowMap.get(element.element_no);
    const requiresSource = linked && linked.sourceType !== 'manual';
    return {
      ...element,
      stored_status: element.status,
      status: element.status === '已完成' && requiresSource && !linked.linked_ready ? '待复核' : element.status,
      link_warning: element.status === '已完成' && requiresSource && !linked.linked_ready
        ? '上游来源已变化或未就绪，需要重新确认' : '',
    };
  });
}

route('GET', /^\/api\/ppap\/submission$/, () => ({
  submission: ensurePpapSubmission(CUR),
}));

route('PATCH', /^\/api\/ppap\/submission$/, (m, body) => DB.tx(() => {
  const before = ensurePpapSubmission(CUR);
  const level = body.level === undefined ? +before.level : +body.level;
  if (![1, 2, 3, 4, 5].includes(level)) throw new Error('PPAP 提交等级必须为 1–5');
  const status = body.status || before.status || '准备中';
  if (!['准备中', '待批准', '已批准', '已提交', '顾客已批准', '需修订'].includes(status)) {
    throw new Error('PPAP 提交状态无效');
  }
  // 显式状态机：不允许越级，也不允许把已批准/已提交退回“准备中”而抹掉审批痕迹
  const PPAP_NEXT = {
    准备中: ['准备中', '待批准', '需修订'],
    待批准: ['待批准', '已批准', '需修订'],
    已批准: ['已批准', '已提交', '需修订'],
    已提交: ['已提交', '顾客已批准', '需修订'],
    顾客已批准: ['顾客已批准', '需修订'],
    需修订: ['需修订', '准备中', '待批准'],
  };
  if (!(PPAP_NEXT[before.status] || []).includes(status)) {
    throw Object.assign(
      new Error(`PPAP 提交状态不能从“${before.status}”直接变为“${status}”`),
      { statusCode: 409 }
    );
  }
  const requestedBy = String(body.requested_by || before.requested_by || actorName()).trim();
  let approvedBy = before.approved_by || '';
  if (status === '已批准' && before.status !== '已批准') {
    requirePermission('ppap.approve', '批准 PPAP 提交');
    assertNotSelfApproval(requestedBy, '批准');
    approvedBy = actorName();
  }
  // B-07：允许显式绑定已有基线；打包严格使用该基线
  if (body.baseline_id !== undefined && String(body.baseline_id).trim()) {
    const baseline = q('SELECT baseline_id FROM baseline WHERE baseline_id=? AND project_id=?',
      String(body.baseline_id).trim(), CUR);
    if (!baseline) throw new Error('所选基线不存在或不属于当前项目');
  }
  let requiredItemsJson = before.required_items_json || null;
  if (body.required_items !== undefined) {
    const items = Array.isArray(body.required_items) ? body.required_items.map(Number) : [];
    if (items.some(no => !Number.isInteger(no) || no < 1 || no > 18)) {
      throw new Error('顾客指定文件必须为 1–18 的 PPAP 要素序号');
    }
    requiredItemsJson = items.length ? JSON.stringify([...new Set(items)].sort((a, b) => a - b)) : null;
  }
  const now = DB.now();
  const baselineId = body.baseline_id !== undefined
    ? (String(body.baseline_id).trim() || null)
    : (before.baseline_id || null);
  DB.db.prepare(`INSERT INTO ppap_submission(
    project_id,level,submission_reason,customer,organization,part_revision,
    requested_by,requested_at,approved_by,approved_at,status,updated_at,required_items_json,baseline_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(project_id) DO UPDATE SET
    level=excluded.level,submission_reason=excluded.submission_reason,
    customer=excluded.customer,organization=excluded.organization,
    part_revision=excluded.part_revision,requested_by=excluded.requested_by,
    requested_at=excluded.requested_at,approved_by=excluded.approved_by,
    approved_at=excluded.approved_at,status=excluded.status,updated_at=excluded.updated_at,
    required_items_json=excluded.required_items_json,baseline_id=excluded.baseline_id`).run(
    CUR,
    level,
    body.submission_reason ?? before.submission_reason ?? '',
    body.customer ?? before.customer ?? '',
    body.organization ?? before.organization ?? '',
    body.part_revision ?? before.part_revision ?? '',
    requestedBy,
    body.requested_at ?? before.requested_at ?? '',
    approvedBy,
    approvedBy ? (body.approved_at ?? before.approved_at ?? now.slice(0, 10)) : '',
    status, now, requiredItemsJson, baselineId
  );
  const submission = ensurePpapSubmission(CUR);
  L.audit(actorName(), '修改', 'ppap_submission', CUR,
    before, submission, body.note || '维护 PPAP 提交信息');
  return { ok: true, submission };
}));

route('GET', /^\/api\/ppap$/, () => {
  const workflow = ppapWorkflowRows(CUR);
  const submission = ensurePpapSubmission(CUR);
  return {
  submission,
  elements: effectivePpapElements(CUR, workflow),
  packages: all('SELECT * FROM ppap_package WHERE project_id=? ORDER BY pkg_id DESC', CUR),
  baselines: all('SELECT * FROM baseline WHERE project_id=? ORDER BY frozen_at DESC', CUR),
  workflow,
  // B-02：各等级实际要求提交的要素清单，页面按此展示而不是只看“18 项”
  level_requirements: Object.fromEntries([1, 2, 3, 4, 5].map(level =>
    [level, ppapRequiredItems(level, level === +submission.level ? submission : {})])),
  deviations: all('SELECT * FROM ppap_deviation WHERE project_id=? ORDER BY deviation_id DESC', CUR),
  };
});

route('POST', /^\/api\/ppap\/deviations$/, (m, body) => DB.tx(() => {
  const elementNo = +body.element_no;
  if (!Number.isInteger(elementNo) || elementNo < 1 || elementNo > 18) {
    throw new Error('PPAP 要素序号必须为 1–18');
  }
  const reason = String(body.reason || '').trim();
  if (reason.length < 10) throw new Error('书面偏差必须说明原因（至少 10 字）');
  const validUntil = String(body.valid_until || '').trim();
  if (validUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)
      || !Number.isFinite(Date.parse(validUntil)) || validUntil < DB.now().slice(0, 10))) {
    throw new Error('偏差有效期必须为不早于今天的有效日期');
  }
  const element = q('SELECT * FROM ppap_element WHERE project_id=? AND element_no=?', CUR, elementNo);
  if (!element) throw new Error('PPAP 要素不存在');
  const inserted = DB.db.prepare(`INSERT INTO ppap_deviation(
    project_id,element_no,source_type,reason,object_ref,valid_until,
    requested_by,requested_at,status
  ) VALUES(?,?,?,?,?,?,?,?,'待批准')`).run(
    CUR, elementNo, String(body.source_type || ''), reason,
    String(body.object_ref || ''), validUntil, actorName(), DB.now()
  );
  L.audit(actorName(), '申请', 'ppap_deviation', String(inserted.lastInsertRowid),
    null, { element_no: elementNo, reason, valid_until: validUntil }, 'PPAP 书面偏差申请');
  return { ok: true, deviation_id: Number(inserted.lastInsertRowid), status: '待批准' };
}));

route('PATCH', /^\/api\/ppap\/deviations\/(\d+)$/, (m, body) => DB.tx(() => {
  const id = +m[1];
  const old = q('SELECT * FROM ppap_deviation WHERE deviation_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('偏差记录不存在');
  if (old.status !== '待批准') throw Object.assign(
    new Error(`该偏差已处于“${old.status}”状态，不能重复处理`), { statusCode: 409 });
  const action = body.action === 'approve' ? 'approve' : body.action === 'reject' ? 'reject' : '';
  if (!action) throw new Error('偏差处理动作必须为 approve 或 reject');
  requirePermission('ppap.approve', '审批 PPAP 偏差');
  assertNotSelfApproval(old.requested_by, '批准');
  const note = String(body.note || '').trim();
  if (action === 'reject' && !note) throw new Error('驳回偏差必须填写原因');
  const status = action === 'approve' ? '已批准' : '已驳回';
  DB.db.prepare(`UPDATE ppap_deviation SET status=?,approved_by=?,approved_at=?,note=?
    WHERE deviation_id=? AND project_id=?`).run(
    status, action === 'approve' ? actorName() : '', action === 'approve' ? DB.now() : null,
    note, id, CUR
  );
  L.audit(actorName(), action === 'approve' ? '批准' : '驳回', 'ppap_deviation', String(id),
    old, { status, note }, note || 'PPAP 偏差审批');
  return { ok: true, status };
}));

route('GET', /^\/api\/ppap\/evidence\/(\d+)$/, (m) => {
  const no = +m[1];
  const mapping = PPAP_WORKFLOW.find(item => item.no === no);
  if (!mapping) throw new Error('PPAP 要素不存在');
  const workflow = ppapWorkflowRows(CUR).find(item => item.no === no);
  const rawElement = q('SELECT * FROM ppap_element WHERE project_id=? AND element_no=?', CUR, no) || {};
  const element = effectivePpapElements(CUR, ppapWorkflowRows(CUR))
    .find(item => item.element_no === no) || rawElement;
  const artifacts = [];
  const projectDocs = [];
  if (mapping.sourceType === 'docs') {
    for (const code of mapping.sourceCodes || []) {
      const doc = q('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', CUR, code);
      if (!doc) continue;
      const meta = DT.CATALOG.find(item => item.code === code) || {};
      const sourceTemplate = q(`SELECT tpl_id,name,source,status FROM doc_template
        WHERE doc_code=? AND (project_id=? OR project_id IS NULL)
        ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`,
      code, CUR, CUR);
      projectDocs.push({
        code, name: doc.custom_name || meta.name || code, status: doc.status,
        version: doc.version, updated_at: doc.updated_at,
        approved_by: doc.approved_by || '', preview: buildProjectDocPreview(code, doc),
        template_id: sourceTemplate ? sourceTemplate.tpl_id : null,
        template_name: sourceTemplate ? sourceTemplate.name : '',
      });
      artifacts.push({
        type: 'project_doc', code, title: doc.custom_name || meta.name || code,
        status: doc.status, version: doc.version, action: 'open_doc',
      });
    }
  }
  let fmea = null;
  if (mapping.sourceType === 'fmea') {
    const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?',
      CUR, mapping.fmeaType);
    if (header) {
      const rows = all(`SELECT r.row_id,r.s,r.o,r.d,r.ap,r.pc_text,r.dc_text,
          fe.name fe_name,fm.name fm_name,fc.name fc_name,
          d.decision,d.status decision_status,d.approved_by
        FROM fmea_row r
        LEFT JOIN fmea_node fe ON fe.node_id=r.fe_id
        LEFT JOIN fmea_node fm ON fm.node_id=r.fm_id
        LEFT JOIN fmea_node fc ON fc.node_id=r.fc_id
        LEFT JOIN fmea_decision d ON d.row_id=r.row_id
        LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
        WHERE r.fmea_id=? AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')
        ORDER BY r.seq`, header.fmea_id);
      fmea = { header, rows, final_version: header.status === '已发布' };
      artifacts.push({
        type: 'fmea', id: header.fmea_id, title: `${mapping.fmeaType} ${header.rev}`,
        status: header.status, version: header.rev, action: 'open_fmea',
      });
    }
  }
  let pfd = null;
  if (mapping.sourceType === 'pfd') {
    const steps = all(`SELECT step_id,step_no,name,step_type,status,ver,equipment,fixture,input_desc,output_desc
      FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废' ORDER BY seq`, CUR).map(step => {
      const linkedIds = all(`SELECT char_id,process_char_id FROM fmea_row r
        JOIN fmea_header h ON h.fmea_id=r.fmea_id
        WHERE h.project_id=? AND r.step_id=?`, CUR, step.step_id)
        .flatMap(row => [row.char_id, row.process_char_id]).filter(Boolean);
      all(`SELECT c.char_id FROM cp_row c JOIN control_plan cp ON cp.cp_id=c.cp_id
        WHERE cp.project_id=? AND c.step_id=? AND c.char_id IS NOT NULL`, CUR, step.step_id)
        .forEach(row => linkedIds.push(row.char_id));
      const processIds = linkedIds.filter(id => {
        const char = q('SELECT char_kind FROM char_master WHERE char_id=?', id);
        return char && char.char_kind === 'PROCESS';
      });
      for (const processId of processIds) {
        all(`SELECT product_char_id FROM char_link
          WHERE process_char_id=? AND COALESCE(status,'生效')<>'作废'`, processId)
          .forEach(row => linkedIds.push(row.product_char_id));
      }
      const uniqueIds = [...new Set(linkedIds)];
      const specialCharacteristics = uniqueIds.length
        ? all(`SELECT char_id,name,char_kind,special_symbol,is_special FROM char_master
            WHERE char_id IN (${uniqueIds.map(() => '?').join(',')}) AND is_special=1
            ORDER BY char_kind DESC,name`, ...uniqueIds)
        : [];
      return {
        ...step,
        special_process: step.step_type === '特殊过程',
        special_characteristics: specialCharacteristics,
        critical: step.step_type === '特殊过程' || specialCharacteristics.length > 0,
      };
    });
    pfd = {
      steps,
      all_published: steps.length > 0 && steps.every(step => step.status === '已发布'),
      special_process_count: steps.filter(step => step.special_process).length,
      special_char_step_count: steps.filter(step => step.special_characteristics.length > 0).length,
    };
    artifacts.push({
      type: 'pfd', title: '过程流程图 PFD',
      status: pfd.all_published ? '已发布' : '进行中',
      version: steps[0] ? steps[0].ver : '', action: 'open_pfd',
    });
  }
  let cp = null;
  if (mapping.sourceType === 'cp') {
    const header = q('SELECT * FROM control_plan WHERE project_id=? AND stage=?', CUR, mapping.cpStage);
    if (header) {
      const rows = all(`SELECT c.*,pc.name char_name,g.name gauge_name
        FROM cp_row c LEFT JOIN project_char pc ON pc.pchar_id=c.project_char_id
        LEFT JOIN gauge g ON g.gauge_id=c.gauge_id
        WHERE c.cp_id=? ORDER BY c.seq`, header.cp_id);
      cp = { header, rows };
      artifacts.push({
        type: 'cp', id: header.cp_id, title: `${mapping.cpStage} 控制计划`,
        status: header.status, version: header.rev, action: 'open_cp',
      });
    }
  }
  let msa = null;
  if (mapping.sourceType === 'msa') {
    const plans = DB.listMsaPlans(CUR).filter(plan => plan.source_active !== 0);
    const studyIds = plans.map(plan => plan.study_id).filter(Number.isInteger);
    const studies = studyIds.length ? all(`SELECT ms.*,pc.name char_name
      FROM msa_study ms LEFT JOIN project_char pc ON pc.pchar_id=ms.project_char_id
      WHERE ms.project_id=? AND ms.study_id IN (${studyIds.map(() => '?').join(',')})
      ORDER BY ms.study_id DESC`, CUR, ...studyIds) : [];
    msa = { plans, studies };
    for (const plan of plans) artifacts.push({
      type: 'msa_plan', id: plan.plan_id,
      title: `${plan.char_name || plan.char_id} / ${plan.gauge_id}`,
      status: plan.status, version: plan.study_result == null ? '' : `${fmtNumber(plan.study_result)}%`,
      action: 'open_msa',
    });
  }
  let spc = null;
  if (mapping.sourceType === 'spc') {
    const monitors = all(`SELECT m.*,pc.name char_name,pc.lsl,pc.usl
      FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
      JOIN control_plan cp ON cp.cp_id=c.cp_id
      LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(m.project_char_id,c.project_char_id)
      WHERE cp.project_id=? AND m.approval_status='已批准' ORDER BY m.mon_id`, CUR);
    spc = monitors.map(monitor => {
      const dataset = q('SELECT * FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC LIMIT 1', monitor.mon_id);
      let stat = null;
      if (dataset) {
        try {
          stat = L.spcCompute(JSON.parse(dataset.data_json), { lsl: monitor.lsl, usl: monitor.usl },
            { chartType: monitor.chart_type });
        } catch (e) { stat = null; }
      }
      return { ...monitor, dataset, stat };
    });
    for (const monitor of spc) artifacts.push({
      type: 'spc_monitor', id: monitor.mon_id, title: monitor.char_name || monitor.mon_id,
      status: monitor.stat ? '有数据' : '无数据',
      version: monitor.stat && monitor.stat.cpk != null ? `Cpk ${fmtNumber(monitor.stat.cpk)}` : '',
      action: 'open_spc',
    });
  }
  if (mapping.sourceType === 'gauge') {
    const gauges = projectGauges(CUR);
    for (const gauge of gauges) artifacts.push({
      type: 'gauge', id: gauge.gauge_id, title: `${gauge.code} ${gauge.name}`,
      status: gauge.calibration_due && gauge.calibration_due < DB.now().slice(0, 10) ? '校准过期' : '有效',
      version: gauge.range_text || '', action: 'open_msa',
    });
  }
  const customTemplates = all(`SELECT tpl_id,name,source,filename,status,pct,created_at,updated_at
    FROM doc_template WHERE project_id=? AND doc_code=? ORDER BY created_at DESC`,
  CUR, `PPAP-${no}`);
  return {
    no,
    element,
    workflow,
    mapping,
    projectDocs,
    fmea,
    pfd,
    cp,
    msa,
    spc,
    artifacts,
    customTemplates,
    templateCode: `PPAP-${no}`,
  };
});

route('PATCH', /^\/api\/ppap\/(\d+)$/, (m, body) => {
  const element = q('SELECT * FROM ppap_element WHERE project_id=? AND element_no=?', CUR, +m[1]);
  if (!element) throw new Error('PPAP 要素不存在');
  // B-13：适用性/顾客豁免独立于完成状态，记录依据后才能排除
  if (body.applicability !== undefined) {
    if (!['适用', '不适用'].includes(body.applicability)) throw new Error('适用性必须为“适用”或“不适用”');
    const waiver = String(body.waiver_ref !== undefined ? body.waiver_ref : element.waiver_ref || '').trim();
    if (body.applicability === '不适用' && !waiver) {
      throw new Error('标记不适用必须填写顾客书面豁免/依据');
    }
    DB.db.prepare('UPDATE ppap_element SET applicability=?,waiver_ref=? WHERE project_id=? AND element_no=?')
      .run(body.applicability, waiver || null, CUR, +m[1]);
    L.audit(actorName(), '修改', 'ppap_element', m[1], element,
      { applicability: body.applicability, waiver_ref: waiver }, 'PPAP 要素适用性');
  }
  if (body.status === undefined && body.applicability !== undefined) return { ok: true };
  const status = ['已完成', '待确认', '未完成'].includes(body.status) ? body.status : '未完成';
  if (status !== '未完成' && !String(body.evidence || '').trim()) {
    throw new Error('填写证据引用后才能标记待确认/完成');
  }
  if (status === '已完成') {
    // B-09：完成必须由质量角色确认，流程是先“待确认”再“已完成”
    requirePermission('ppap.approve', '确认 PPAP 要素完成');
    if (element.status !== '待确认' && element.status !== '已完成') {
      throw Object.assign(new Error('证据先保存为“待确认”，再由质量角色确认完成'), { statusCode: 409 });
    }
  }
  if (status === '已完成') {
    const mapping = PPAP_WORKFLOW.find(item => item.no === +m[1]);
    if (mapping && mapping.sourceType === 'docs') {
      const missing = (mapping.sourceCodes || []).filter(code => {
        const doc = q('SELECT status FROM project_doc WHERE project_id=? AND doc_code=?', CUR, code);
        return !doc || !['已批准', '已完成', '系统模块'].includes(doc.status);
      });
      if (missing.length) throw new Error(`以下引用文件尚未批准：${missing.join('、')}`);
    }
    if (mapping && mapping.sourceType === 'fmea') {
      const header = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, mapping.fmeaType);
      if (!header || header.status !== '已发布') throw new Error(`${mapping.fmeaType} 尚未发布最终版`);
    }
    if (mapping && mapping.sourceType === 'pfd') {
      const steps = all("SELECT status FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'", CUR);
      if (!steps.length || steps.some(step => step.status !== '已发布')) throw new Error('PFD 仍有未发布工序');
    }
    if (mapping && mapping.sourceType === 'cp') {
      const cp = q('SELECT * FROM control_plan WHERE project_id=? AND stage=?', CUR, mapping.cpStage);
      if (!cp || !['已批准', '已冻结'].includes(cp.status)) throw new Error('生产控制计划尚未批准或生效');
    }
    if (mapping && mapping.sourceType === 'msa') {
      const plans = DB.listMsaPlans(CUR).filter(plan => plan.source_active !== 0);
      if (!plans.length || plans.some(plan => plan.status !== '已完成'
          || plan.source_status !== '有效'
          || (plan.trigger_source !== 'P3-08' && !['已批准', '已冻结'].includes(plan.cp_status)))) {
        throw new Error('当前测量系统的 MSA 计划尚未全部完成或来源待复核');
      }
    }
    if (mapping && mapping.sourceType === 'spc') {
      const monitors = all(`SELECT m.mon_id FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
        JOIN control_plan cp ON cp.cp_id=r.cp_id
        WHERE cp.project_id=? AND m.status='启用' AND m.approval_status='已批准'`, CUR);
      const missingData = monitors.filter(monitor =>
        !q('SELECT 1 FROM spc_dataset WHERE mon_id=? LIMIT 1', monitor.mon_id));
      if (!monitors.length || missingData.length) throw new Error('SPC 监控项尚未全部形成有效数据');
    }
    if (mapping && mapping.sourceType === 'gauge') {
      const invalid = projectGauges(CUR).filter(gauge => ['报废', '停用'].includes(gauge.status)
        || !gauge.calibration_due || gauge.calibration_due < DB.now().slice(0, 10));
      if (invalid.length) throw new Error(`存在校准过期或报废检具：${invalid.map(item => item.gauge_id).join('、')}`);
    }
    // B-04：MSA/SPC/FMEA 的质量门（判定、Cpk、失控、高 AP 闭环），偏差批准可放行
    if (mapping && ['fmea', 'msa', 'spc'].includes(mapping.sourceType)) {
      const gate = ppapWorkflowRows(CUR).find(item => item.no === +m[1]);
      if (gate && !gate.gate_ready) {
        throw Object.assign(
          new Error(`PPAP 要素「${element.name}」质量门未通过：${gate.gate_reason}；如顾客同意，请先登记并批准书面偏差`),
          { statusCode: 409, details: { element_no: +m[1], reason: gate.gate_reason } }
        );
      }
    }
  }
  DB.db.prepare(`UPDATE ppap_element SET status=?, evidence=?, note=?,
    confirmed_by=CASE WHEN ?='已完成' THEN ? ELSE confirmed_by END,
    confirmed_at=CASE WHEN ?='已完成' THEN ? ELSE confirmed_at END
    WHERE project_id=? AND element_no=?`).run(
    status, body.evidence || '', body.note || '',
    status, status === '已完成' ? actorName() : '', status, status === '已完成' ? DB.now() : '',
    CUR, +m[1]
  );
  L.audit(actorName(), '修改', 'ppap_element', m[1], element,
    { status, evidence: body.evidence || '', note: body.note || '' }, status === '待确认' ? 'PPAP 证据提交待确认' : 'PPAP 要素更新');
  return { ok: true, status };
});

route('POST', /^\/api\/ppap\/package$/, (m, body) => {
  const submission = ensurePpapSubmission(CUR);
  const level = [1, 2, 3, 4, 5].includes(+body.level) ? +body.level : +submission.level || 3;
  const els = all('SELECT * FROM ppap_element WHERE project_id=? ORDER BY element_no', CUR);
  if (!els.length) throw new Error('PPAP 要素未初始化');
  const requiredNos = ppapRequiredItems(level, submission);
  // B-13：不适用（顾客书面豁免）的要素不进入必须提交清单
  const applicableNos = els.filter(element => (element.applicability || '适用') !== '不适用')
    .map(element => element.element_no);
  const requiredApplicable = requiredNos.filter(no => applicableNos.includes(no));
  const workflowMap = new Map(ppapWorkflowRows(CUR).map(item => [item.no, item]));
  const missing = els.filter(element => {
    if (!requiredApplicable.includes(element.element_no)) return false;
    const linked = workflowMap.get(element.element_no);
    // B-04：有来源的要素必须同时满足“来源可用 + 质量门”（偏差批准的要素 gate_ready 已计入）
    const sourceReady = !linked || linked.sourceType === 'manual' || linked.gate_ready;
    return element.status !== '已完成' || !sourceReady;
  });
  if (missing.length) {
    throw new Error(`仍有 ${missing.length} 项 PPAP 要素未完成或质量门未通过：`
      + missing.map(e => `${e.element_no} ${e.name}`).join('、'));
  }
  // 受控输出：打包只能使用“提交记录绑定的那份基线”。
  // 从未绑定时，在打包前冻结一份 PPAP 提交基线并写回提交记录，保证清单与证据包同源。
  let bl = submission.baseline_id
    ? q('SELECT * FROM baseline WHERE baseline_id=? AND project_id=?', submission.baseline_id, CUR)
    : null;
  if (!bl) {
    const ver = 'PPAP-' + DB.now().replace(/[^0-9]/g, '').slice(0, 14);
    const frozen = DB.freezeBaseline(
      CUR, `PPAP 提交基线（Level ${level}）`, ver, actorName(), 'PPAP 打包自动绑定'
    );
    DB.db.prepare(`INSERT INTO ppap_submission(project_id,level,baseline_id,updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET baseline_id=excluded.baseline_id,updated_at=excluded.updated_at`)
      .run(CUR, level, frozen.id, DB.now());
    bl = q('SELECT * FROM baseline WHERE baseline_id=?', frozen.id);
  }
  if (!bl) throw new Error('无法建立 PPAP 提交基线，打包中止');
  const files = [];
  const addFile = (name, content) => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    files.push({
      name,
      buffer,
      size: buffer.length,
      hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
  };
  const packageDeviations = requiredApplicable.map(no => ({
    element_no: no,
    deviation: approvedPpapDeviation(CUR, no),
  })).filter(item => item.deviation);
  addFile('README.txt', [
    `项目：${CUR}`,
    `提交等级：Level ${level}`,
    `要求提交要素：${requiredApplicable.join('、')}`,
    `不适用要素：${els.filter(element => element.applicability === '不适用')
      .map(element => `${element.element_no}（${element.waiver_ref || '无依据'}）`).join('、') || '无'}`,
    `提交基线：${bl.baseline_id} ${bl.version}（${bl.tag}）`,
    `生成时间：${DB.now()}`,
    '本包的清单与证据对象均取自上述基线快照，不使用打包时的实时状态。',
    packageDeviations.length
      ? `本次使用的书面偏差：${packageDeviations.map(item =>
        `要素 ${item.element_no}（${item.deviation.deviation_id}，批准人 ${item.deviation.approved_by}）`).join('；')}`
      : '本次未使用书面偏差。',
  ].join('\n'));
  const baselineItems = all('SELECT * FROM baseline_item WHERE baseline_id=? ORDER BY object_type,object_id', bl.baseline_id);
  // 清单也取基线快照（B-03）：包里的 18 项状态必须与基线中的 PPAP_ELEMENT 完全一致
  const snapshotElements = baselineItems
    .filter(item => item.object_type === 'PPAP_ELEMENT')
    .map(item => { try { return JSON.parse(item.snapshot); } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => +a.element_no - +b.element_no);
  const checklistElements = snapshotElements.length ? snapshotElements : els;
  const checklistSource = snapshotElements.length ? 'baseline' : 'live';
  checklistElements.forEach(element => {
    addFile(
      `checklist/${String(element.element_no).padStart(2, '0')}_${element.name.replace(/[\\\\/:*?"<>|]/g, '_')}.txt`,
      [
        `要素：${element.element_no} ${element.name}`,
        `状态：${element.status}`,
        `必需：${element.required ? '是' : '否'}`,
        `证据：${element.evidence || '—'}`,
        `备注：${element.note || '—'}`,
      ].join('\n')
    );
  });
  baselineItems.forEach(item => {
    addFile(
      `baseline/${item.object_type}/${String(item.object_id).replace(/[\\\\/:*?"<>|]/g, '_')}.json`,
      item.snapshot || '{}'
    );
  });
  const manifest = {
    level,
    required_items: requiredApplicable,
    baseline: { id: bl.baseline_id, tag: bl.tag, version: bl.version, hash: bl.hash },
    checklist_source: checklistSource,
    deviations: packageDeviations.map(item => ({
      element_no: item.element_no, deviation_id: item.deviation.deviation_id,
      reason: item.deviation.reason, approved_by: item.deviation.approved_by,
      approved_at: item.deviation.approved_at, valid_until: item.deviation.valid_until,
    })),
    generated_at: DB.now(),
    files: files.map(file => ({
      name: file.name, size: file.size, hash: file.hash,
    })),
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const zipBuffer = EX.zip([
    ...files.map(file => ({ name: file.name, data: file.buffer })),
    { name: 'manifest.json', data: manifestBuffer },
  ]);
  const manifestHash = crypto.createHash('sha256').update(manifestBuffer).digest('hex');
  const zipHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  const fileName = `PPAP-${idPart(CUR)}-${Date.now()}.zip`;
  const filePath = path.join(PACKAGE_DIR, fileName);
  fs.writeFileSync(filePath, zipBuffer);
  // B-12：打包完成后立即回读校验，避免文件丢失/损坏直到下载时才暴露
  const written = fs.readFileSync(filePath);
  const writtenHash = crypto.createHash('sha256').update(written).digest('hex');
  if (writtenHash !== zipHash || written.length !== zipBuffer.length) {
    try { fs.unlinkSync(filePath); } catch (error) { /* 清理失败不掩盖原始错误 */ }
    throw new Error('PPAP ZIP 写入后校验失败，打包中止');
  }
  const r = DB.db.prepare(`INSERT INTO ppap_package(
    project_id,level,baseline_id,created_at,manifest,pkg_hash,zip_path,zip_hash,file_count
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    CUR, level, bl.baseline_id, DB.now(), JSON.stringify(manifest), manifestHash,
    fileName, zipHash, files.length + 1
  );
  recordExport({
    objectType: 'ppap_package', objectId: String(r.lastInsertRowid), format: 'zip',
    fileName, buffer: zipBuffer, baselineId: bl.baseline_id, version: bl.version,
  });
  L.audit(actorName(), '导出', 'ppap_package', String(r.lastInsertRowid), null,
    { level, baselineId: bl.baseline_id, checklistSource, manifestHash, zipHash,
      fileCount: files.length + 1 }, 'PPAP 打包');
  return {
    ok: true, pkg_id: Number(r.lastInsertRowid), hash: manifestHash,
    zip_hash: zipHash, files: files.length + 1, baseline: bl.baseline_id,
    download: `/api/ppap/packages/${r.lastInsertRowid}/download`,
  };
});

route('GET', /^\/api\/apqp$/, () => ({
  phases: all('SELECT * FROM apqp_phase WHERE project_id=? ORDER BY phase', CUR),
  tasks: all('SELECT * FROM apqp_task WHERE project_id=? ORDER BY phase, task_id', CUR),
}));

route('PATCH', /^\/api\/apqp\/task\/(\d+)$/, (m, body) => {
  DB.db.prepare('UPDATE apqp_task SET status=? WHERE task_id=?').run(body.status || '未开始', +m[1]);
  // 阶段状态自动推进
  const t = q('SELECT * FROM apqp_task WHERE task_id=?', +m[1]);
  const agg = all('SELECT status FROM apqp_task WHERE project_id=? AND phase=?', CUR, t.phase);
  const done = agg.filter(x => x.status === '已完成').length;
  const st = done === agg.length ? '已完成' : done === 0 ? '未开始' : '进行中';
  DB.db.prepare('UPDATE apqp_phase SET status=? WHERE project_id=? AND phase=?').run(st, CUR, t.phase);
  // S-06：项目阶段只由 Gate 结论派生，任务完成度不再直接改写 project.phase，
  // 否则同一事实会出现“任务推进到阶段 4、Gate 2 却被驳回”的矛盾。
  L.audit('项目组', '修改', 'apqp_task', String(+m[1]), null, body, 'APQP 任务状态');
  return { ok: true, phase_status: st };
});

route('GET', /^\/api\/baselines$/, () => ({
  list: all(`SELECT b.*, (SELECT COUNT(*) FROM baseline_item i WHERE i.baseline_id=b.baseline_id) items,
      (SELECT COUNT(DISTINCT object_type) FROM baseline_item i WHERE i.baseline_id=b.baseline_id) object_types
             FROM baseline b WHERE b.project_id=? ORDER BY b.frozen_at DESC`, CUR),
}));

route('POST', /^\/api\/baselines$/, (m, body) => {
  const hasBaseline = q('SELECT COUNT(*) c FROM baseline WHERE project_id=?', CUR).c > 0;
  // 已有基线后的冻结属于“变更批准”动作，必须由质量角色执行，且批准人取会话身份
  if (hasBaseline) requirePermission('baseline.freeze', '冻结新基线');
  const frozenBy = actorName();
  const v = body.version || 'V1.' + Date.now().toString().slice(-3);
  const r = DB.freezeBaseline(
    CUR, body.tag || '手动冻结', v, frozenBy, body.note || '',
    Array.isArray(body.scopes) && body.scopes.length ? body.scopes : null
  );
  let approvalId = null;
  if (hasBaseline) {
    approvalId = recordApproval({
      projectId: CUR, actionType: 'BASELINE_CHANGE', objectType: 'baseline',
      objectId: r.id, title: `批准新基线：${body.tag || v}`,
      payload: { version: v, hash: r.hash, scopes: body.scopes || [] },
      approvedBy: frozenBy, requestedBy: frozenBy,
      note: body.note || '基线后活动变更批准',
    });
  }
  L.audit(frozenBy, '冻结', 'baseline', r.id, null,
    { version: v, hash: r.hash, approvalId }, body.note || '基线冻结');
  return { ...r, approval_id: approvalId };
});

route('GET', /^\/api\/baselines\/diff$/, (m, body, query) => {
  const a = query.get('a'), b = query.get('b');
  const A = q('SELECT * FROM baseline WHERE baseline_id=?', a);
  const B = q('SELECT * FROM baseline WHERE baseline_id=?', b);
  if (!A || !B) throw new Error('基线不存在');
  return { a: A, b: B, diff: L.baselineDiff(a, b) };
});

route('GET', /^\/api\/baselines\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const baseline = q('SELECT * FROM baseline WHERE baseline_id=? AND project_id=?', id, CUR);
  if (!baseline) throw new Error('基线不存在');
  const items = all(`SELECT item_id,object_type,object_id,object_hash
    FROM baseline_item WHERE baseline_id=? ORDER BY object_type,object_id`, id);
  return { baseline, items };
});

route('GET', /^\/api\/baselines\/([^/]+)\/items\/([^/]+)\/(.+)$/, (m) => {
  const baselineId = decodeURIComponent(m[1]);
  const objectType = decodeURIComponent(m[2]);
  const objectId = decodeURIComponent(m[3]);
  const item = q(`SELECT * FROM baseline_item
    WHERE baseline_id=? AND object_type=? AND object_id=?`, baselineId, objectType, objectId);
  if (!item) throw new Error('基线对象不存在');
  return { ...item, snapshot: JSON.parse(item.snapshot || '{}') };
});

/* ---------------------------------------------------------------- 自定义模板 */
const P = require('./lib/parse');
const INF = require('./lib/infer');

function schemaPct(schema) {
  if (!schema) return 0;
  if (schema.kind === 'grid') {
    let total = 0, filled = 0;
    for (const row of schema.rows) for (const c of row) {
      if (!c || c.covered || c.header) continue;
      if (c.input || c.label) continue;
      total += 1;
      if (String(c.v || '').trim()) filled += 1;
    }
    return total ? Math.round((filled / total) * 100) : 0;
  }
  if (schema.kind === 'doc') {
    let total = 0, filled = 0;
    for (const b of schema.blocks) {
      if (b.type === 'field') { total += 1; if (String(b.value || '').trim()) filled += 1; }
      else if (b.type === 'table') {
        for (const r of b.rows) for (const c of r) { total += 1; if (String(c || '').trim()) filled += 1; }
      }
    }
    return total ? Math.round((filled / total) * 100) : 0;
  }
  return 0;
}

/** 生成交付物编号：交付物 P{阶段}-{序号}，检查表 A-{全局序号} */
function nextDocCode(phase, isChecklist) {
  if (isChecklist) {
    let max = 0;
    for (const d of require('./lib/doctpl').CATALOG) {
      const m = /^A-(\d+)$/.exec(d.code || '');
      if (m) max = Math.max(max, +m[1]);
    }
    for (const t of all("SELECT doc_code FROM doc_template WHERE doc_code LIKE 'A-%'")) {
      const m = /^A-(\d+)$/.exec(t.doc_code || '');
      if (m) max = Math.max(max, +m[1]);
    }
    return 'A-' + String(max + 1).padStart(2, '0');
  }
  const p = Math.max(0, Math.min(5, +phase || 0));
  let max = 0;
  for (const d of require('./lib/doctpl').CATALOG) {
    const m = new RegExp('^P' + p + '-(\\d+)$').exec(d.code || '');
    if (m) max = Math.max(max, +m[1]);
  }
  for (const t of all(`SELECT doc_code FROM doc_template WHERE doc_code LIKE 'P${p}-%'`)) {
    const m = new RegExp('^P' + p + '-(\\d+)$').exec(t.doc_code || '');
    if (m) max = Math.max(max, +m[1]);
  }
  return 'P' + p + '-' + String(max + 1).padStart(2, '0');
}

route('POST', /^\/api\/docs\/new$/, (m, body) => {
  requirePermission('doc.manage', '新建交付物');
  const name = String(body.name || '').trim();
  if (!name) throw new Error('名称不能为空');
  const phase = Math.max(0, Math.min(5, +body.phase || 0));
  const isChecklist = !!body.isChecklist || /检查表/.test(name);
  const code = body.doc_code || nextDocCode(phase, isChecklist);
  if (q('SELECT 1 FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR)) throw new Error('编号冲突，请重试');
  const id = 'TPL-' + Date.now().toString(36).toUpperCase();
  const DT = require('./lib/doctpl');
  const schema = isChecklist ? DT.GENERIC() : DT.GENERIC();
  DB.db.prepare(`INSERT INTO doc_template(tpl_id,name,phase,source,filename,schema_json,status,pct,created_at,created_by,updated_at,doc_code)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, phase, 'custom', '', JSON.stringify(schema), '未开始', 0, DB.now(), actorName(), DB.now(), code);
  DB.db.prepare(`INSERT INTO project_doc(doc_code,project_id,status,owner,data_json,updated_at,updated_by,version)
    VALUES(?,?,?,?,?,?,?,?)`).run(code, CUR, '未开始', actorName(), '{}', DB.now(), actorName(), 1);
  L.audit(actorName(), '新增', 'doc_template', id, null, { name, code }, '新建交付物');
  return { ok: true, tpl_id: id, doc_code: code };
});

route('PATCH', /^\/api\/docs\/([^/]+)\/meta$/, (m, body) => {
  const code = decodeURIComponent(m[1]);
  requirePermission('doc.manage', '交付物改名 / 隐藏');
  const exists = q('SELECT 1 FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  if (!exists) {
    DB.db.prepare('INSERT INTO project_doc(doc_code,project_id,status,owner,data_json,updated_at,updated_by,version) VALUES(?,?,?,?,?,?,?,?)')
      .run(code, CUR, '未开始', '', '{}', DB.now(), actorName(), 1);
  }
  if (body.custom_name !== undefined) {
    DB.db.prepare('UPDATE project_doc SET custom_name=? WHERE doc_code=? AND project_id=?').run(String(body.custom_name).trim() || null, code, CUR);
  }
  if (body.hidden !== undefined) {
    DB.db.prepare('UPDATE project_doc SET hidden=? WHERE doc_code=? AND project_id=?').run(body.hidden ? 1 : 0, code, CUR);
  }
  L.audit(actorName(),'修改', 'project_doc', code, null, body, '交付物改名/删除');
  return { ok: true };
});

route('POST', /^\/api\/templates$/, (m, body) => {
  const { name, phase, filename, dataBase64 } = body;
  if (!dataBase64) throw new Error('缺少文件内容');
  const buf = Buffer.from(dataBase64, 'base64');
  if (buf.length > 12 * 1024 * 1024) throw new Error('文件超过 12 MB');
  if (buf.length < 100) throw new Error('文件为空或损坏');

  let parsed, schema, source;
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) throw new Error('仅支持 .xlsx / .docx（不支持旧版 .xls / .doc）');

  let xlsxErr = null, docxErr = null;
  try { parsed = P.parseXlsx(buf); source = 'xlsx'; schema = INF.inferFromXlsx(parsed); }
  catch (e) { xlsxErr = e.message; }
  if (!schema) {
    try { parsed = P.parseDocx(buf); source = 'docx'; schema = INF.inferFromDocx(parsed); }
    catch (e) { docxErr = e.message; }
  }
  if (!schema) throw new Error(`无法解析：${xlsxErr || ''} ${docxErr || ''}`.trim());

  const id = 'TPL-' + Date.now().toString(36).toUpperCase();
  const pct = schemaPct(schema);
  const docCode = nextDocCode((phase !== undefined && phase !== null && phase !== '' ? +phase : 1), /检查表/.test(name || filename || ''));
  const finalCode = body.doc_code || docCode;
  // A-05：一个交付物编号只能绑定一个模板，避免同一编号多个模板各自维护
  const bound = q(`SELECT tpl_id,name FROM doc_template WHERE doc_code=? AND (project_id=? OR project_id IS NULL)
    ORDER BY updated_at DESC,rowid DESC LIMIT 1`, finalCode, CUR);
  if (bound) {
    throw Object.assign(
      new Error(`编号 ${finalCode} 已绑定模板“${bound.name}”（${bound.tpl_id}）；请先解除绑定或使用其他编号`),
      { statusCode: 409, details: { bound_tpl_id: bound.tpl_id } }
    );
  }
  if (!body.doc_code && q('SELECT 1 FROM project_doc WHERE doc_code=? AND project_id=?', finalCode, CUR)) {
    throw new Error('交付物编号已存在：' + finalCode);
  }
  const safeName = path.basename(filename || `template.${source}`)
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
  const sourcePath = `${id}-${safeName}`;
  fs.writeFileSync(path.join(TEMPLATE_DIR, sourcePath), buf);
  DB.db.prepare(`INSERT INTO doc_template(
    tpl_id,name,phase,source,filename,schema_json,status,pct,created_at,created_by,updated_at,project_id,doc_code,source_path
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, name || filename || '未命名模板',
    (phase !== undefined && phase !== null && phase !== '' ? +phase : 1),
    source, filename || '', JSON.stringify(schema), '草稿', pct,
    DB.now(), actorName(), DB.now(), CUR, finalCode, sourcePath
  );
  L.audit(actorName(), '上传', 'doc_template', id, null,
    { name, phase, source, stats: schema.stats, warnings: parsed.warnings || [], original_preserved: true },
    '导入自定义模板');
  return {
    tpl_id: id, source, stats: schema.stats, pct, original_preserved: true,
    // A-12：解析截断/日期还原/多工作表等必须在结果中明示
    warnings: parsed.warnings || [],
  };
});

route('GET', /^\/api\/templates$/, () => ({
  list: all(`SELECT tpl_id,name,phase,source,filename,status,pct,created_at,created_by,
      project_id,doc_code,mapping_status,approved_by,approved_at,
      CASE WHEN source_path IS NOT NULL AND source_path<>'' THEN 1 ELSE 0 END original_preserved
    FROM doc_template WHERE project_id=? OR project_id IS NULL
    ORDER BY created_at DESC`, CUR),
}));

route('GET', /^\/api\/templates\/([^/]+)$/, (m) => {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', m[1], CUR);
  if (!row) throw new Error('模板不存在');
  let schema = {};
  try { schema = JSON.parse(row.schema_json || '{}'); } catch (e) { schema = {}; }
  return { meta: row, schema };
});

route('PUT', /^\/api\/templates\/([^/]+)$/, (m, body) => DB.tx(() => {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', m[1], CUR);
  if (!row) throw new Error('模板不存在');
  const schema = body.schema;
  if (!schema) throw new Error('缺少内容');
  const pct = schemaPct(schema);
  // A-13：映射批准后修改结构必须重新批准，避免已批准映射指向不存在的单元格
  const mappingReset = row.mapping_status === '已批准';
  const nextStatus = body.status || (pct >= 100 ? '已完成' : pct > 0 ? '草稿' : '未开始');
  const now = DB.now();
  DB.db.prepare(`UPDATE doc_template SET schema_json=?, pct=?, status=?, updated_at=?,
    mapping_status=CASE WHEN ? THEN '待重新批准' ELSE mapping_status END WHERE tpl_id=?`)
    .run(JSON.stringify(schema), pct, nextStatus, now, mappingReset ? 1 : 0, m[1]);
  // A-05：绑定交付物时把模板内容写入同一份交付物数据，导出/基线/审批都读同一来源
  const mirror = row.doc_code
    ? q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', row.doc_code, CUR) : null;
  if (mirror) {
    let data = {};
    try { data = JSON.parse(mirror.data_json || '{}'); } catch (error) { data = {}; }
    data.template_schema = schema;
    data.template_tpl_id = row.tpl_id;
    data.template_pct = pct;
    const mirrorStatus = ['待审核', '已批准'].includes(row.status) ? row.status : nextStatus;
    const dataJson = JSON.stringify(data);
    DB.db.prepare(`UPDATE project_doc SET status=?,data_json=?,cols_json=COALESCE(?,cols_json),
      updated_at=?,updated_by=?,lock_token=? WHERE doc_code=? AND project_id=?`).run(
      mirrorStatus, dataJson, mirror.cols_json || null, now, actorName(),
      crypto.randomUUID(), row.doc_code, CUR
    );
    if (mirror.data_json !== dataJson) {
      DB.db.prepare(`INSERT INTO project_doc_revision(
        rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,change_note
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        uniqueId('REV', `${row.doc_code}-tpl`), row.doc_code, CUR, mirror.version || 'V1.0',
        mirrorStatus, dataJson, mirror.cols_json || null, actorName(), now, `模板内容同步（${row.tpl_id}）`
      );
    }
  }
  L.audit(actorName(), '修改', 'doc_template', m[1], null,
    { pct, mapping_reapproval_required: mappingReset, mirrored_doc: row.doc_code || '' }, '编辑自定义模板');
  return { ok: true, pct, status: nextStatus, mapping_status: mappingReset ? '待重新批准' : (row.mapping_status || '') };
}));

// A-05：模板提交/批准与交付物同一审批链，两边状态同步
route('POST', /^\/api\/templates\/([^/]+)\/submit$/, (m, body) => {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', m[1], CUR);
  if (!row) throw new Error('模板不存在');
  if (!['草稿', '未开始', '已退回'].includes(row.status)) throw new Error('只有草稿模板可以提交审核');
  const now = DB.now();
  DB.db.prepare(`UPDATE doc_template SET status='待审核',submitted_by=?,submitted_at=?,rejected_reason=NULL
    WHERE tpl_id=?`).run(actorName(), now, row.tpl_id);
  if (row.doc_code) {
    DB.db.prepare(`UPDATE project_doc SET status='待审核',submitted_by=?,submitted_at=?,rejected_reason=NULL,
      lock_token=? WHERE doc_code=? AND project_id=?`).run(
      actorName(), now, crypto.randomUUID(), row.doc_code, CUR);
  }
  L.audit(actorName(), '提交审核', 'doc_template', row.tpl_id, { status: row.status },
    { status: '待审核' }, body.note || '提交自定义模板审核');
  return { ok: true, status: '待审核' };
});

route('POST', /^\/api\/templates\/([^/]+)\/approve$/, (m, body) => DB.tx(() => {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', m[1], CUR);
  if (!row) throw new Error('模板不存在');
  if (row.status !== '待审核') {
    throw Object.assign(new Error('只有待审核模板可以批准'), { statusCode: 409 });
  }
  requirePermission('template.approve', '批准模板');
  assertNotSelfApproval(row.submitted_by, '批准');
  const approver = actorName();
  const now = DB.now();
  DB.db.prepare(`UPDATE doc_template SET status='已批准',approved_by=?,approved_at=?,updated_at=?
    WHERE tpl_id=?`).run(approver, now, now, row.tpl_id);
  if (row.doc_code) {
    const doc = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', row.doc_code, CUR);
    if (doc) {
      const match = /^V?(\d+)\.(\d+)$/i.exec(doc.version || 'V1.0');
      const version = match ? `V${match[1]}.${+match[2] + 1}` : 'V1.1';
      DB.db.prepare(`UPDATE project_doc SET status='已批准',approved_by=?,approved_at=?,version=?,
        published_version=?,lock_token=? WHERE doc_code=? AND project_id=?`).run(
        approver, now, version, version, crypto.randomUUID(), row.doc_code, CUR);
    }
  }
  L.audit(approver, '批准', 'doc_template', row.tpl_id, { status: row.status },
    { status: '已批准', doc_code: row.doc_code || '' }, body.note || '模板审批');
  return { ok: true, status: '已批准' };
}));

route('POST', /^\/api\/templates\/([^/]+)\/reject$/, (m, body) => {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', m[1], CUR);
  if (!row) throw new Error('模板不存在');
  if (row.status !== '待审核') {
    throw Object.assign(new Error('只有待审核模板可以退回'), { statusCode: 409 });
  }
  requirePermission('template.approve', '退回模板');
  const reason = String(body.reason || '').trim();
  if (!reason) throw new Error('退回原因不能为空');
  DB.db.prepare(`UPDATE doc_template SET status='草稿',rejected_reason=? WHERE tpl_id=?`)
    .run(reason, row.tpl_id);
  if (row.doc_code) {
    DB.db.prepare(`UPDATE project_doc SET status='草稿',rejected_reason=?,approved_by='',approved_at=NULL,
      lock_token=? WHERE doc_code=? AND project_id=?`).run(
      reason, crypto.randomUUID(), row.doc_code, CUR);
  }
  L.audit(actorName(), '退回', 'doc_template', row.tpl_id, { status: row.status },
    { status: '草稿', reason }, reason);
  return { ok: true, status: '草稿', reason };
});

// A-18：按交付物编号定位绑定模板，供深链与导出分流
route('GET', /^\/api\/templates\/by-code\/([^/]+)$/, (m) => {
  const code = decodePart(m[1]);
  const row = q(`SELECT tpl_id,name,status,doc_code FROM doc_template
    WHERE doc_code=? AND (project_id=? OR project_id IS NULL)
    ORDER BY updated_at DESC,rowid DESC LIMIT 1`, code, CUR);
  if (!row) throw Object.assign(new Error(`未找到编号 ${code} 的交付物或模板`), { statusCode: 404 });
  return { tpl_id: row.tpl_id, name: row.name, status: row.status, doc_code: row.doc_code };
});

route('DELETE', /^\/api\/templates\/([^/]+)$/, (m) => {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', m[1], CUR);
  if (!row) throw new Error('模板不存在');
  if (row.project_id == null) throw new Error('全局模板不可由项目页面删除');
  DB.db.prepare('DELETE FROM doc_template WHERE tpl_id=?').run(m[1]);
  if (row.source_path) {
    const sourceFile = path.join(TEMPLATE_DIR, path.basename(row.source_path));
    if (fs.existsSync(sourceFile)) fs.unlinkSync(sourceFile);
  }
  L.audit(actorName(),'删除', 'doc_template', m[1], null, null, '删除自定义模板');
  return { ok: true };
});

route('PATCH', /^\/api\/templates\/([^/]+)\/mapping$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', id, CUR);
  if (!row) throw new Error('模板不存在');
  const mapping = Array.isArray(body.mapping) ? body.mapping : [];
  if (!mapping.length) throw new Error('映射配置不能为空');
  const allowedPrefixes = ['project.', 'doc.', 'fmea.', 'cp.', 'spc.', 'msa.', 'ppap.'];
  let schema = {};
  try { schema = JSON.parse(row.schema_json || '{}'); } catch (e) { throw new Error('模板结构损坏'); }
  // A-13：字段映射只对 XLSX 网格有效；DOCX 模板不开放映射入口
  if (schema.kind !== 'grid') throw new Error('仅 XLSX 网格模板支持字段映射；Word 模板请直接维护内容');
  for (const item of mapping) {
    if (!Number.isInteger(+item.r) || !Number.isInteger(+item.c) || +item.r < 1 || +item.c < 1) {
      throw new Error('映射行号/列号必须从 1 开始的整数');
    }
    if (!allowedPrefixes.some(prefix => String(item.path || '').startsWith(prefix))) {
      throw new Error('不支持的字段路径：' + (item.path || ''));
    }
    if (!Array.isArray(schema.rows) || !schema.rows[+item.r - 1] || !schema.rows[+item.r - 1][+item.c - 1]) {
      throw new Error(`映射单元格超出范围：R${item.r}C${item.c}`);
    }
  }
  requirePermission('template.approve', '批准模板字段映射');
  const approver = actorName();
  const approvalId = recordApproval({
    projectId: CUR, actionType: 'TEMPLATE_MAPPING', objectType: 'doc_template',
    objectId: id, title: `批准模板映射：${row.name}`, payload: { mapping },
    approvedBy: approver, requestedBy: row.created_by || approver,
    note: body.note || '模板字段映射变更',
  });
  DB.db.prepare(`UPDATE doc_template SET
    mapping_json=?,mapping_status='已批准',approved_by=?,approved_at=?,updated_at=?
    WHERE tpl_id=?`).run(
    JSON.stringify(mapping), approver, DB.now(), DB.now(), id
  );
  L.audit(approver, '批准', 'doc_template_mapping', id,
    row.mapping_json, { mapping, approvalId }, '模板字段映射');
  return { ok: true, mapping_status: '已批准', approval_id: approvalId };
});

route('POST', /^\/api\/templates\/([^/]+)\/apply$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', id, CUR);
  if (!row) throw new Error('模板不存在');
  if (row.mapping_status !== '已批准') throw new Error('模板映射尚未批准');
  let schema;
  let mapping;
  try {
    schema = JSON.parse(row.schema_json || '{}');
    mapping = JSON.parse(row.mapping_json || '[]');
  } catch (e) {
    throw new Error('模板映射数据损坏');
  }
  const project = q('SELECT * FROM project WHERE project_id=?', CUR) || {};
  const docCode = body.doc_code || row.doc_code;
  const doc = docCode ? q('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', CUR, docCode) || {} : {};
  const pfmea = q("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='PFMEA'", CUR) || {};
  // A-13：CP 取该交付物对应阶段；无法判断时取最新批准的阶段，而不是任意第一个
  const docMeta = DT.CATALOG.find(item => item.code === docCode) || {};
  const docStage = ({ 'P2-05': 'PROTO', 'P3-06b': 'PILOT' })[docCode]
    || (docMeta.phase <= 2 ? 'PROTO' : docMeta.phase === 3 ? 'PILOT' : 'SOP');
  const cp = q('SELECT * FROM control_plan WHERE project_id=? AND stage=?', CUR, docStage)
    || q('SELECT * FROM control_plan WHERE project_id=? ORDER BY stage LIMIT 1', CUR) || {};
  const apCounts = all(`SELECT r.ap, COUNT(*) count FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id WHERE h.project_id=?
    GROUP BY r.ap`, CUR).reduce((out, item) => {
    out[item.ap] = item.count;
    return out;
  }, {});
  const context = {
    project,
    doc,
    fmea: {
      high: apCounts.H || 0,
      medium: apCounts.M || 0,
      low: apCounts.L || 0,
      id: pfmea.fmea_id || '',
      status: pfmea.status || '',
      rev: pfmea.rev || '',
    },
    cp: {
      stage: cp.stage || '',
      rev: cp.rev || '',
      status: cp.status || '',
      row_count: cp.cp_id ? q('SELECT COUNT(*) c FROM cp_row WHERE cp_id=?', cp.cp_id).c : 0,
    },
    spc: {
      monitoring_count: q(`SELECT COUNT(*) c FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
        JOIN control_plan p ON p.cp_id=r.cp_id WHERE p.project_id=?`, CUR).c,
    },
    msa: {
      study_count: q('SELECT COUNT(*) c FROM msa_study WHERE project_id=?', CUR).c,
    },
    ppap: {
      done: q("SELECT COUNT(*) c FROM ppap_element WHERE project_id=? AND status='已完成'", CUR).c,
      total: q('SELECT COUNT(*) c FROM ppap_element WHERE project_id=?', CUR).c,
    },
  };
  const resolvePath = (path) => path.split('.').reduce((value, key) => value == null ? value : value[key], context);
  if (schema.kind !== 'grid' || !Array.isArray(schema.rows)) throw new Error('当前仅支持 XLSX 网格模板映射');
  const changes = [];
  for (const item of mapping) {
    const r = +item.r - 1;
    const c = +item.c - 1;
    if (!schema.rows[r] || !schema.rows[r][c]) throw new Error(`映射单元格超出范围：R${item.r}C${item.c}`);
    const value = resolvePath(item.path);
    if (value === undefined || value === null) continue;
    const next = String(value);
    const current = schema.rows[r][c].v == null ? '' : String(schema.rows[r][c].v);
    if (current === next) continue;
    changes.push({ r: +item.r, c: +item.c, path: item.path, from: current, to: next });
  }
  // A-13：覆盖人工填写前先给出差异清单，确认后才写入
  const overwritten = changes.filter(change => change.from !== '');
  if (overwritten.length && body.confirm_overwrite !== true) {
    throw Object.assign(
      new Error(`映射将覆盖 ${overwritten.length} 个已填写单元格；请确认覆盖范围后重试`),
      { statusCode: 409, details: { changes } }
    );
  }
  for (const change of changes) {
    schema.rows[change.r - 1][change.c - 1].v = change.to;
  }
  DB.db.prepare('UPDATE doc_template SET schema_json=?,pct=?,updated_at=? WHERE tpl_id=?').run(
    JSON.stringify(schema), schemaPct(schema), DB.now(), id
  );
  L.audit(body.user || actorName(), '映射填充', 'doc_template', id, null,
    { doc_code: docCode, mappings: mapping.length, changes: changes.length, cp_stage: cp.stage || '' },
    '按业务字段填充客户模板');
  return { ok: true, pct: schemaPct(schema), changes };
});

// 审计流只展示本项目事件（全局事件 project_id IS NULL 仍可见），不能再取全库
route('GET', /^\/api\/audit$/, () => ({
  list: all('SELECT * FROM audit_event WHERE project_id=? OR project_id IS NULL ORDER BY event_id DESC LIMIT 200', CUR),
}));
route('GET', /^\/api\/exports$/, () => ({
  list: all('SELECT * FROM export_event WHERE project_id=? ORDER BY exported_at DESC LIMIT 200', CUR),
}));
// 备份与重算只给系统管理员：这些接口直接读写数据库文件，不属于岗位权限点
route('GET', /^\/api\/admin\/backups$/, () => ({
  list: fs.readdirSync(BACKUP_DIR)
    .filter(name => /^qms-.*\.db$/.test(name))
    .map(name => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return {
        name, size: stat.size, created_at: stat.mtime.toISOString(),
        has_attachments: fs.existsSync(path.join(BACKUP_DIR, name.replace(/\.db$/, '') + '-attachments')),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at)),
}), { roles: ['admin'] });
// S-15：把同步从“启动隐式写入”改为显式重算，并由管理员在系统页触发
route('POST', /^\/api\/admin\/resync$/, (m, body) => DB.tx(() => {
  const summary = syncProjectDeliverables(CUR, { reconcile: body.reconcile === true });
  L.audit(actorName(), '重算', 'deliverable_sync', CUR, null,
    { created: summary.created, updated: summary.updated, conflicts: summary.conflicts },
    body.note || '手动重算交付物同步');
  return { ok: true, summary };
}), { roles: ['admin'] });

/* ---------------------------------------------------------------- 账号与权限 */
// 角色目录：供账号管理页下拉选择（含部门、项目范围、是否副总板块）
route('GET', /^\/api\/admin\/roles$/, () => {
  const allPoints = Object.keys(PM.PERMISSIONS);
  const rolePerms = {};
  Object.keys(PM.ROLES).forEach(role => {
    const def = PM.ROLES[role];
    rolePerms[role] = def.permissions.includes('*')
      ? allPoints : PM.permissionsFor({ role, flags: '' });
  });
  return {
    list: Object.entries(PM.ROLES).map(([key, def]) => ({
      role: key, name: def.name, department: def.department,
      scope: def.scope, board: def.board || '', legacy: !!def.legacy,
      permission_count: rolePerms[key].length,
      // 角色默认权限点，前端用来预填勾选清单
      permissions: rolePerms[key],
    })),
    permissions: PM.PERMISSIONS,
    owner_roles: PM.OWNER_ROLE_MAP,
    // 权限点按模块分组，供账号管理页做成勾选清单
    groups: PM.PERMISSION_GROUPS,
    // 管理员重置口令时使用的统一初始口令（可由 QMS_DEFAULT_PASSWORD 覆盖）
    default_password: DEFAULT_PASSWORD,
  };
}, { roles: ['admin'] });

function userRow(row) {
  return {
    user_id: row.user_id, username: row.username, display_name: row.display_name,
    role: row.role, role_name: ROLE_NAMES[row.role] || row.role,
    department: row.department || '', position: row.position || '',
    vp_scope: row.vp_scope || '', flags: row.flags || '',
    // 账号级权限：null = 按角色默认；数组 = 管理员逐项勾选的结果
    perms: (() => { try { return row.perms_json ? JSON.parse(row.perms_json) : null; } catch { return null; } })(),
    status: row.status, must_change_password: !!row.must_change_password,
    created_at: row.created_at || '',
  };
}

route('GET', /^\/api\/admin\/users$/, () => ({
  list: all(`SELECT * FROM auth_user ORDER BY
    CASE status WHEN '启用' THEN 0 ELSE 1 END, department, username`).map(userRow),
}), { roles: ['admin'] });

route('POST', /^\/api\/admin\/users$/, (m, body) => DB.tx(() => {
  const username = String(body.username || '').trim();
  const displayName = String(body.display_name || '').trim();
  const role = String(body.role || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{1,31}$/.test(username)) throw new Error('登录名需以字母开头，2-32 位字母/数字/下划线');
  if (!displayName) throw new Error('请填写姓名');
  if (!PM.ROLES[role]) throw new Error('角色不存在：' + role);
  if (q('SELECT 1 FROM auth_user WHERE username=?', username)) throw new Error('登录名已存在');
  const password = String(body.password || '').trim() || DEFAULT_PASSWORD;
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`初始口令至少 ${PASSWORD_MIN_LENGTH} 位`);
  const id = uniqueId('USR', username);
  const salt = crypto.randomBytes(16).toString('hex');
  DB.db.prepare(`INSERT INTO auth_user(user_id,username,display_name,role,password_salt,password_hash,
    status,created_at,department,position,flags,vp_scope,must_change_password)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, username, displayName, role, salt, DB.passwordDigest(password, salt), '启用', DB.now(),
    String(body.department || PM.ROLES[role].department || '').trim(),
    String(body.position || '').trim(), String(body.flags || '').trim(),
    String(body.vp_scope || '').trim(), body.must_change_password === false ? 0 : 1,
  );
  L.audit(actorName(), '新增账号', 'auth_user', id, null,
    { username, role, department: body.department || '' }, `新增账号 ${displayName}`);
  return {
    ok: true, user_id: id, username,
    // 统一初始口令，管理员直接转交；首次登录强制改密
    initial_password: password,
  };
}), { roles: ['admin'] });

route('PATCH', /^\/api\/admin\/users\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM auth_user WHERE user_id=?', id);
  if (!old) throw new Error('账号不存在');
  const next = {
    display_name: body.display_name !== undefined ? String(body.display_name).trim() : old.display_name,
    role: body.role !== undefined ? String(body.role).trim() : old.role,
    department: body.department !== undefined ? String(body.department).trim() : old.department,
    position: body.position !== undefined ? String(body.position).trim() : old.position,
    flags: body.flags !== undefined ? String(body.flags).trim() : old.flags,
    vp_scope: body.vp_scope !== undefined ? String(body.vp_scope).trim() : old.vp_scope,
    status: body.status !== undefined ? String(body.status).trim() : old.status,
  };
  if (!next.display_name) throw new Error('姓名不能为空');
  if (!PM.ROLES[next.role]) throw new Error('角色不存在：' + next.role);
  if (!['启用', '停用'].includes(next.status)) throw new Error('状态只能是启用或停用');
  // 不允许把自己降级或停用，避免失去唯一的最高权限账号
  if (id === sessionUser().user_id && (next.role !== old.role || next.status !== '启用')) {
    throw new Error('不能修改自己的角色或停用自己的账号');
  }
  if (old.role === 'admin' && (next.role !== 'admin' || next.status !== '启用')) {
    const admins = q("SELECT COUNT(*) c FROM auth_user WHERE role='admin' AND status='启用'").c;
    if (admins <= 1) throw new Error('系统至少需要保留一个启用的管理员账号');
  }
  // 账号级权限勾选：不传表示保持原样；传空数组表示“按角色默认”
  let permsJson = old.perms_json;
  if (body.perms !== undefined) {
    if (body.perms === null) permsJson = null;
    else {
      if (!Array.isArray(body.perms)) throw new Error('权限必须是数组');
      const unknown = body.perms.filter(point => !PM.PERMISSIONS[point]);
      if (unknown.length) throw new Error('未知权限点：' + unknown.join('、'));
      permsJson = body.perms.length ? JSON.stringify([...new Set(body.perms)]) : null;
    }
  }
  DB.db.prepare(`UPDATE auth_user SET display_name=?,role=?,department=?,position=?,flags=?,vp_scope=?,status=?,
    perms_json=? WHERE user_id=?`).run(next.display_name, next.role, next.department, next.position,
    next.flags, next.vp_scope, next.status, permsJson, id);
  // 停用后立即失效其会话
  if (next.status !== '启用') DB.db.prepare('DELETE FROM auth_session WHERE user_id=?').run(id);
  // 审计要能看出权限变化：把本次写入的 perms_json 带进改后快照
  L.audit(actorName(), '修改账号', 'auth_user', id, userRow(old),
    userRow({ ...old, ...next, perms_json: permsJson }), `账号 ${old.username} 权限/资料调整`);
  return { ok: true, user: userRow(q('SELECT * FROM auth_user WHERE user_id=?', id)) };
}), { roles: ['admin'] });

route('POST', /^\/api\/admin\/users\/([^/]+)\/reset-password$/, (m, body) => DB.tx(() => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM auth_user WHERE user_id=?', id);
  if (!old) throw new Error('账号不存在');
  // 口令策略由管理员在系统设置里统一规定（默认 123456），重置后强制首次登录改密
  const password = String(body.password || '').trim() || DEFAULT_PASSWORD;
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`新口令至少 ${PASSWORD_MIN_LENGTH} 位`);
  const salt = crypto.randomBytes(16).toString('hex');
  DB.db.prepare(`UPDATE auth_user SET password_salt=?,password_hash=?,must_change_password=1
    WHERE user_id=?`).run(salt, DB.passwordDigest(password, salt), id);
  DB.db.prepare('DELETE FROM auth_session WHERE user_id=?').run(id);
  L.audit(actorName(), '重置口令', 'auth_user', id, null, null, `重置 ${old.username} 的登录口令`);
  return { ok: true, username: old.username, initial_password: password };
}), { roles: ['admin'] });

route('POST', /^\/api\/admin\/backup$/, (m, body) => {
  DB.db.exec('PRAGMA wal_checkpoint(FULL)');
  const timestamp = DB.now().replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6}).*/, '$1-$2');
  const name = `qms-${timestamp}.db`;
  const target = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DB_FILE, target);
  let check;
  try {
    check = new DatabaseSync(target);
    check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project'").get();
  } catch (error) {
    try { fs.unlinkSync(target); } catch (e) { /* ignore cleanup failure */ }
    throw new Error(`备份校验失败：${error.message}`);
  } finally {
    try { check?.close(); } catch (e) { /* ignore close failure */ }
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  // 附件（包装图片 / 工程图 / CAD）不能只靠库里的路径：随备份一起复制一份。
  // 不用 fs.cpSync：本机 Node 24 在含中文文件名的目录上会直接崩进程（0xC0000409）
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) count += copyTree(source, target);
      else { fs.copyFileSync(source, target); count += 1; }
    }
    return count;
  };
  const attachTarget = path.join(BACKUP_DIR, name.replace(/\.db$/, '') + '-attachments');
  const attachmentCount = fs.existsSync(ATTACHMENT_DIR) ? copyTree(ATTACHMENT_DIR, attachTarget) : 0;
  // 只保留最近 10 份备份（db + 对应附件目录），否则目录只增不减
  const keep = 10;
  const oldBackups = fs.readdirSync(BACKUP_DIR).filter(f => /^qms-.*\.db$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(keep);
  for (const item of oldBackups) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, item.f));
      fs.rmSync(path.join(BACKUP_DIR, item.f.replace(/\.db$/, '') + '-attachments'),
        { recursive: true, force: true });
    } catch (e) { /* 文件被占用时下次再清 */ }
  }
  L.audit(body.user || '管理员', '备份', 'database', name, null, { hash, attachments: attachmentCount },
    `数据库全量备份（含附件 ${attachmentCount} 个）`);
  return { ok: true, name, hash, size: fs.statSync(target).size, attachments: attachmentCount };
}, { roles: ['admin'] });

/* ---------------------------------------------------------------- 示意图 → 结构树 */
const OCR = require('./lib/ocr');
const TREE = require('./lib/tree');

route('GET', /^\/api\/ocr\/status$/, () => {
  return {
    engine: 'RapidOCR', fallback: 'Windows.Media.Ocr',
    language: 'zh-Hans-CN', available: true,
  };
});

route('POST', /^\/api\/dfmea\/ocr$/, async (m, body) => {
  const b64 = body.imageBase64 || '';
  if (!b64) throw new Error('缺少图片');
  const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error('图片超过 8 MB');
  const tmp = path.join(__dirname, 'data', `_ocr_${crypto.randomUUID()}.png`);
  fs.writeFileSync(tmp, buf);
  try {
    const words = await OCR.runOCR(tmp);
    const labels = OCR.labelsFromWords(words);
    return { labels, wordCount: words.length, raw: words.map(w => w.t).join('') };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  }
});

route('POST', /^\/api\/dfmea\/tree$/, (m, body) => {
  const labels = Array.isArray(body.labels) ? body.labels : [];
  if (!labels.length) throw new Error('没有可用的结构标签');
  const proj = q('SELECT * FROM project WHERE project_id=?', CUR) || {};
  return { tree: TREE.buildTree(body.product || proj.part_no || proj.name, labels) };
});

route('POST', /^\/api\/dfmea\/apply$/, (m, body) => {
  const h = q("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='DFMEA'", CUR);
  if (!h) throw new Error('当前项目还没有 DFMEA');
  const tree = body.tree;
  if (!tree || !Array.isArray(tree.nodes)) throw new Error('结构树为空');

  const result = DB.tx(() => {
    const oldRoots = all(`SELECT node_id FROM fmea_node
      WHERE fmea_id=? AND parent_id IS NULL AND desc LIKE '%由示意图生成%'
        AND COALESCE(status,'生效')<>'作废'`, h.fmea_id);
    let removed = 0;
    const collect = (id, acc) => {
      acc.push(id);
      for (const child of all('SELECT node_id FROM fmea_node WHERE parent_id=?', id)) collect(child.node_id, acc);
      return acc;
    };
    for (const root of oldRoots) {
      for (const id of collect(root.node_id, [])) {
        DB.db.prepare("UPDATE fmea_node SET status='作废' WHERE node_id=?").run(id);
        removed += 1;
      }
    }
    const stamp = Date.now().toString(36).toUpperCase();
    let seq = (q('SELECT MAX(seq) m FROM fmea_node WHERE fmea_id=?', h.fmea_id).m || 0) + 1;
    const ins = DB.db.prepare(`INSERT INTO fmea_node(
      node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc,level,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const rootId = `N-${stamp}-0`;
    ins.run(rootId, h.fmea_id, null, 'STRUCTURE', null, seq++, tree.product,
      null, '产品总成（由示意图生成）', 1, '生效');
    let n = 1;
    for (const group of tree.nodes) {
      const groupId = `N-${stamp}-${n++}`;
      ins.run(groupId, h.fmea_id, rootId, 'STRUCTURE', null, seq++,
        group.name, null, '由示意图识别生成的结构分组；设计功能待分析', 2, '生效');
      for (const child of (group.children || [])) {
        const childId = `N-${stamp}-${n++}`;
        ins.run(childId, h.fmea_id, groupId, 'STRUCTURE', null, seq++,
          child.name, null, '由示意图 OCR 识别生成的结构节点；设计功能待定义', 3, '生效');
      }
    }
    return { removed, n, seq, rootId };
  });

  // 保存示意图与标签，供追溯
  if (body.imageBase64) {
    const b64 = String(body.imageBase64).replace(/^data:image\/\w+;base64,/, '');
    const exists = q('SELECT 1 FROM fmea_image WHERE fmea_id=?', h.fmea_id);
    if (exists) {
      DB.db.prepare('UPDATE fmea_image SET data=?,labels_json=?,created_at=? WHERE fmea_id=?')
        .run(b64, JSON.stringify(body.labels || []), DB.now(), h.fmea_id);
    } else {
      DB.db.prepare('INSERT INTO fmea_image VALUES(?,?,?,?)')
        .run(h.fmea_id, b64, JSON.stringify(body.labels || []), DB.now());
    }
  }

  markFmeaDraft(h.fmea_id);
  L.audit(body.user || actorName(), '新增', 'fmea_node', h.fmea_id, null,
    { from: 'image', nodes: result.n, replaced: result.removed }, '由示意图生成结构树');
  return { ok: true, added: result.n, removed: result.removed, rootId: result.rootId };
});

route('POST', /^\/api\/fmea\/row-from-text$/, (m, body) => {
  const h = q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, body.fmea_type || 'DFMEA');
  if (!h) throw new Error('未找到 FMEA');
  const focus = body.focus_node_id;
  if (!focus) throw new Error('请先选择结构节点');
  const focusNode = q(`SELECT * FROM fmea_node
    WHERE node_id=? AND fmea_id=? AND COALESCE(status,'生效')<>'作废'`, focus, h.fmea_id);
  if (!focusNode) throw new Error('结构节点不存在');
  if (body.func_id && !q(`SELECT 1 FROM fmea_function
    WHERE func_id=? AND node_id=? AND status='正式'`, body.func_id, focus)) {
    throw new Error('所选功能不属于当前结构节点或尚未采用');
  }

  const stamp = Date.now().toString(36).toUpperCase();
  let seq = (q('SELECT MAX(seq) m FROM fmea_node WHERE fmea_id=?', h.fmea_id).m || 0) + 1;

  const findOrCreate = (name, subtype, parentId) => {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const hit = q(`SELECT node_id FROM fmea_node
      WHERE fmea_id=? AND node_subtype=? AND name=? AND (parent_id IS ? OR parent_id=?)
        AND COALESCE(status,'生效')<>'作废'`,
      h.fmea_id, subtype, clean, parentId, parentId);
    if (hit) return hit.node_id;
    const id = `N-${stamp}-${Math.floor(Math.random() * 900 + 100)}`;
    DB.db.prepare('INSERT INTO fmea_node(node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, h.fmea_id, parentId || null, 'FAILURE', subtype, seq++, clean, null, null);
    return id;
  };

  const feId = findOrCreate(body.effect, 'FE', focus);
  const fmId = findOrCreate(body.mode, 'FM', feId || focus);
  const fcId = findOrCreate(body.cause, 'FC', fmId || focus);
  if (!feId || !fmId || !fcId) throw new Error('失效影响/模式/原因不能为空');

  const s = Math.min(10, Math.max(1, +body.s || 8));
  const o = Math.min(10, Math.max(1, +body.o || 5));
  const d = Math.min(10, Math.max(1, +body.d || 5));
  const productCharId = body.char_id ? DB.ensureProjectChar(CUR, body.char_id).char_id : null;
  const processCharId = body.process_char_id ? DB.ensureProjectChar(CUR, body.process_char_id).char_id : null;
  if (body.upstream_row_id && !q(`SELECT 1 FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
    WHERE r.row_id=? AND h.project_id=?`, body.upstream_row_id, CUR)) {
    throw new Error('上游 FMEA 行不存在或不属于当前项目');
  }
  const ap = DB.apLookup(s, o, d);
  const prefix = 'FR-' + (h.fmea_type === 'DFMEA' ? 'DF-' : 'PF-');
  const existingIds = all('SELECT row_id FROM fmea_row WHERE row_id LIKE ?', prefix + '%')
    .map(row => Number((row.row_id.match(/(\d+)$/) || [])[1]) || 0);
  const rowId = prefix + String(Math.max(0, ...existingIds) + 1).padStart(5, '0');
  const duplicate = q(`SELECT row_id FROM fmea_row
    WHERE fmea_id=? AND fe_id=? AND fm_id=? AND fc_id=? LIMIT 1`,
    h.fmea_id, feId, fmId, fcId);
  if (duplicate) throw new Error(`相同 FE/FM/FC 已存在：${duplicate.row_id}`);
  const rowSeq = (q('SELECT MAX(seq) m FROM fmea_row WHERE fmea_id=?', h.fmea_id).m || 0) + 1;
  DB.db.prepare(`INSERT INTO fmea_row(
    row_id,fmea_id,focus_node_id,fe_id,fm_id,fc_id,char_id,process_char_id,step_id,s,o,d,ap,
    pc_text,dc_text,effect_ref,seq,func_id,upstream_row_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(rowId, h.fmea_id, focus, feId, fmId, fcId, productCharId, processCharId, body.step_id || null,
      s, o, d, ap, body.pc_text, body.dc_text, body.func_id || null, rowSeq,
      body.func_id || null, body.upstream_row_id || null);
  DB.db.prepare("UPDATE fmea_header SET status='草稿' WHERE fmea_id=?").run(h.fmea_id);
  L.audit(body.user || actorName(), '新增', 'fmea_row', rowId, null, { from: 'ai', s, o, d, ap }, '由 AI 建议生成分析行');
  return { ok: true, row_id: rowId, ap };
});

/* ---------------------------------------------------------------- 七类失效模式展开（手册 P47-51） */
const FM7 = [
  { cat: '遗漏', hint: '过程功能丧失 / 操作未执行' },
  { cat: '太多', hint: '超出预期：多了、厚了、长了、高了' },
  { cat: '太少', hint: '部分功能丧失：少了、薄了、短了、低了' },
  { cat: '不完全', hint: '操作不完整：局部缺失、只做一半' },
  { cat: '不一致', hint: '间歇 / 不稳定：波动、时好时坏' },
  { cat: '太快', hint: '动作过快：速率超限导致质量不足' },
  { cat: '太慢', hint: '动作过慢：节拍不足、时间过长导致劣化' },
];

route('POST', /^\/api\/ai\/failures-7x$/, async (m, body) => {
  const node = String(body.node || '').trim();
  const func = String(body.func || '').trim();
  if (!node) throw new Error('缺少结构节点');
  const product = body.product || (q('SELECT name FROM project WHERE project_id=?', CUR) || {}).name || '产品';
  const key = getSetting('ai_key', '');
  const model = getSetting('ai_model', '');
  const base = getSetting('ai_base_url', 'https://api.openai.com/v1').replace(/\/+$/, '');

  let items = [];
  let source = 'local';
  if (key && model) {
    const sys = '你是汽车零部件质量工程专家，精通 AIAG-VDA FMEA 手册的"七种失效模式"方法。'
      + '只输出 JSON。对给定功能，必须按 7 类各给 1 条失效：遗漏、太多、太少、不完全、不一致、太快、太慢。'
      + '每条包含 cat(类别)、mode(失效模式，技术术语，不是顾客症状)、effect(对最终用户/整车的影响)、'
      + 'cause(按设备/人员/材料/环境的具体成因)、pc(现行预防控制)、dc(现行探测控制)、s(1-10 严重度)。';
    const user = `产品：${product}\n过程步骤：${node}\n该步骤的功能：${func || '（未填写，请按工序名推断）'}\n\n`
      + '输出 JSON：{"failures":[{"cat":"遗漏","mode":"","effect":"","cause":"","pc":"","dc":"","s":8}, ... 共 7 条]}\n'
      + '要求：7 类必须齐全且顺序为上列顺序；mode 必须是技术描述（如"膜厚低于下限"），不要写"不良""异常"；'
      + '如果某一类对这道工序确实不适用，仍要给出该类的条目，但 mode 结尾加"（不适用，可删除）"。';
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(25000),
      });
      const txt = await resp.text();
      if (resp.ok) {
        const data = JSON.parse(txt);
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const mm = String(content || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').match(/\{[\s\S]*\}/);
        if (mm) {
          const parsed = JSON.parse(mm[0]);
          if (Array.isArray(parsed.failures) && parsed.failures.length) {
            items = parsed.failures.slice(0, 7);
            source = 'ai';
          }
        }
      }
    } catch (e) { /* 回落到本地模板 */ }
  }

  // 本地模板：按 7 类拼装（AI 不可用时的保底）
  if (!items.length) {
    const f = func || node;
    items = FM7.map(x => ({
      cat: x.cat,
      mode: `${x.cat}：${f}（${x.hint}）`,
      effect: '（待补充：对最终用户/整车的影响）',
      cause: '（待补充：按设备/人员/材料/环境分析）',
      pc: '', dc: '', s: 8,
    }));
  }

  const saved = [];
  let seq = (q('SELECT MAX(seq) m FROM fmea_function WHERE node_id=?', body.node_id).m || 0);
  for (const it of items) {
    const mode = String(it.mode || '').trim();
    if (!mode) continue;
    const dup = q(`SELECT cand_id FROM fmea_failure_cand WHERE node_id=? AND func_id IS ? AND mode=? AND status='候选'`,
      body.node_id || null, body.func_id || null, mode);
    if (dup) { saved.push(dup.cand_id); continue; }
    const id = 'FC-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 9000 + 1000);
    DB.db.prepare(`INSERT INTO fmea_failure_cand(cand_id,node_id,func_id,effect,mode,cause,s,status,source,created_at,pc,dc,cat)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, body.node_id || null, body.func_id || null,
        String(it.effect || '').trim(), mode, String(it.cause || '').trim(),
        Math.min(10, Math.max(1, +it.s || 8)), '候选', source, DB.now(),
        String(it.pc || '').trim(), String(it.dc || '').trim(), String(it.cat || '').trim());
    saved.push(id);
  }
  L.audit('AI', '生成', 'fmea_failure_cand', body.node_id || '-', null, { mode: '7x', count: saved.length, source }, '七类失效展开');
  return { ok: true, count: saved.length, source, items };
});

/* ---------------------------------------------------------------- AI 辅助（外部接口） */
function netErr(e) {
  const c = e && e.cause;
  const code = (c && (c.code || c.errno)) || '';
  const msg = String((e && e.message) || '').toLowerCase();
  if (/接口返回\s*(401|403)|authentication fails|invalid.*api key|unauthorized/i.test(msg)) {
    return 'AI Key 无效或无权限，请在 AI 设置中更新有效 Key';
  }
  if (/接口返回\s*429|rate limit|quota/i.test(msg)) {
    return 'AI 调用额度不足或请求过于频繁，请检查服务商额度';
  }
  if (/接口返回\s*404|model.*not.*found/i.test(msg)) {
    return 'AI 接口路径或模型名不正确，请检查 Base URL 和模型配置';
  }
  if ((e && e.name === 'AbortError') || msg.includes('timeout')) {
    return '请求超时：目标地址不可达（国内网络访问 api.openai.com 常被阻断，需换服务商或走代理）';
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT') {
    return '连接超时：该地址从本机无法访问（api.openai.com 在国内网络常被阻断，建议换 DeepSeek / 通义等国内服务商，或配置代理）';
  }
  if (code === 'ENOTFOUND') return '域名解析失败：Base URL 拼写错误或 DNS 不通';
  if (code === 'ECONNREFUSED') return '连接被拒绝：端口错误，或本地代理/模型服务未启动';
  if (code === 'ECONNRESET') return '连接被重置：可能被防火墙或中间设备阻断';
  if (/certificate|cert/i.test(String((c && c.message) || '')) || code === 'CERT_HAS_EXPIRED') return 'TLS 证书校验失败';
  if (msg.includes('fetch failed')) return `网络不可达（${code || '原因未知'}）`;
  return (e && e.message) || '未知错误';
}
function getSetting(k, dft) {
  const r = q('SELECT v FROM app_setting WHERE k=?', k);
  return r ? r.v : dft;
}
function setSetting(k, v) {
  DB.db.prepare('INSERT INTO app_setting(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}

route('POST', /^\/api\/ai\/test$/, async (m, body) => {
  const savedBase = String(getSetting('ai_base_url', '')).replace(/\/+$/, '');
  const base = String(body.base_url || savedBase).replace(/\/+$/, '');
  // 只在请求地址与已保存地址一致时带上已保存的 Key，避免被指向任意服务器
  const key = String(body.api_key || (base === savedBase ? getSetting('ai_key', '') : ''));
  const model = String(body.model || getSetting('ai_model', ''));
  if (!base) return { ok: false, message: '未填写 Base URL' };
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/models', {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(12000),
    });
    const ms = Date.now() - t0;
    const txt = await r.text();
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, ms, message: '网络可达，但 Key 无效或无权限' };
    if (r.status === 404) return { ok: false, status: r.status, ms, message: '网络可达，但路径不对：Base URL 应填到 /v1 为止（不要带 /chat/completions）' };
    if (!r.ok) return { ok: false, status: r.status, ms, message: `接口返回 ${r.status}：${txt.slice(0, 120)}` };
    let hasModel = null, ids = [];
    try {
      const j = JSON.parse(txt);
      ids = (j.data || []).map(x => x.id);
      if (ids.length) hasModel = ids.includes(model);
    } catch (e) { /* 有的服务不返回模型列表 */ }
    return {
      ok: true, status: r.status, ms,
      message: '连接成功' + (hasModel === false ? `，但模型列表里没有「${model}」` : ''),
      models: ids.slice(0, 8),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: netErr(e) };
  }
}, { roles: ['admin'] });

route('GET', /^\/api\/ai\/config$/, () => ({
  base_url: getSetting('ai_base_url', 'https://api.openai.com/v1'),
  model: getSetting('ai_model', 'gpt-4o-mini'),
  hasKey: !!getSetting('ai_key', ''),
  configured: !!(getSetting('ai_key', '') && getSetting('ai_model', '')),
}), { roles: ['admin'] });

route('POST', /^\/api\/ai\/config$/, (m, body) => {
  if (body.base_url !== undefined) setSetting('ai_base_url', body.base_url);
  if (body.model !== undefined) setSetting('ai_model', body.model);
  if (body.api_key) setSetting('ai_key', body.api_key);
  if (body.clear_key) setSetting('ai_key', '');
  L.audit('管理员', '修改', 'app_setting', 'ai', null, { model: body.model }, 'AI 接口配置');
  return { ok: true };
}, { roles: ['admin'] });

const GENERIC_FAILURE_MODES = new Set([
  '尺寸偏差', '功能失效', '功能异常', '不良', '异常', '不合格', '产品不合格', '过程异常',
]);
const PLACEHOLDER_RE = /待补充|待分析|未知|N\/A|NA/i;
const FUNCTION_VERBS = [
  '形成', '加工', '划线', '切割', '涂覆', '涂布', '焊接', '装配', '压入', '安装', '连接',
  '传输', '输送', '定位', '固定', '控制', '保持', '维持', '检验', '测量', '检测', '清洁', '清洗',
  '加热', '冷却', '固化', '烘干', '包装', '标识', '打印', '分选', '移除', '提供', '完成',
  '支撑', '隔离', '承载', '保护', '切断', '导通',
  '按', '将', '使', '实现', '建立', '执行', '启动', '停止',
];

function normalizeAiJson(content) {
  const text = String(content || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 返回内容中没有 JSON');
  return JSON.parse(match[0]);
}

async function requestAiJson({ base, key, model, system, user, timeoutMs = 40000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`接口返回 ${response.status}：${text.slice(0, 180)}`);
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('接口返回不是 JSON'); }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口没有返回分析内容');
    return normalizeAiJson(content);
  } finally {
    clearTimeout(timer);
  }
}

function aiContextForNode(nodeId) {
  const node = q(`SELECT n.*,h.fmea_type,h.project_id,p.name project_name,p.part_no
    FROM fmea_node n JOIN fmea_header h ON h.fmea_id=n.fmea_id
    JOIN project p ON p.project_id=h.project_id
    WHERE n.node_id=? AND h.project_id=?`, nodeId, CUR);
  if (!node) throw new Error('结构节点不存在');
  const normalizedName = String(node.name || '')
    .replace(/^\s*(?:OP|PS|工序)?\s*\d+\s*[-_：:]?\s*/i, '').trim();
  const step = node.fmea_type === 'PFMEA' ? q(`SELECT * FROM process_step
    WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'
      AND (name=? OR name LIKE ? OR ? LIKE '%'||name||'%')
    ORDER BY CASE WHEN name=? THEN 0 ELSE 1 END,seq LIMIT 1`,
  node.project_id, normalizedName, `%${normalizedName}%`, normalizedName, normalizedName) : null;
  const charRows = step
    ? all(`SELECT DISTINCT cm.char_id,cm.name,cm.char_kind,cm.unit,cm.tol_text,cm.special_symbol
        FROM char_master cm WHERE cm.char_id IN (
          SELECT r.char_id FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
            WHERE h.project_id=? AND r.step_id=? AND r.char_id IS NOT NULL
          UNION SELECT r.process_char_id FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
            WHERE h.project_id=? AND r.step_id=? AND r.process_char_id IS NOT NULL
          UNION SELECT c.char_id FROM cp_row c JOIN control_plan cp ON cp.cp_id=c.cp_id
            WHERE cp.project_id=? AND c.step_id=? AND c.char_id IS NOT NULL
        ) ORDER BY cm.char_kind DESC,cm.char_id`,
      node.project_id, step.step_id, node.project_id, step.step_id, node.project_id, step.step_id)
    : node.fmea_type === 'DFMEA'
      ? all(`SELECT DISTINCT cm.char_id,cm.name,cm.char_kind,cm.unit,cm.tol_text,cm.special_symbol
        FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
        JOIN char_master cm ON cm.char_id=r.char_id
        WHERE h.project_id=? AND h.fmea_type='DFMEA' AND r.focus_node_id=?
          AND cm.char_kind='PRODUCT' ORDER BY cm.char_id`,
      node.project_id, nodeId)
      : all(`SELECT DISTINCT cm.char_id,cm.name,cm.char_kind,cm.unit,cm.tol_text,cm.special_symbol
        FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
        JOIN char_master cm ON cm.char_id IN (r.char_id,r.process_char_id)
        WHERE h.project_id=? AND h.fmea_type='PFMEA' AND r.focus_node_id=?
        ORDER BY cm.char_kind DESC,cm.char_id`, node.project_id, nodeId);
  const functions = all(`SELECT * FROM fmea_function WHERE node_id=? ORDER BY seq`, nodeId);
  const ancestors = [];
  let parentId = node.parent_id;
  while (parentId) {
    const parent = q('SELECT node_id,name FROM fmea_node WHERE node_id=?', parentId);
    if (!parent) break;
    ancestors.unshift(parent.name);
    parentId = (q('SELECT parent_id FROM fmea_node WHERE node_id=?', parentId) || {}).parent_id;
  }
  const charText = charRows.length
    ? charRows.map(c => `${c.char_kind === 'PRODUCT' ? '产品特性' : '过程特性'}:${c.name}${c.tol_text ? '(' + c.tol_text + ')' : ''}`).join('；')
    : '尚未维护可量化特性';
  const contextText = [
    `产品/项目：${node.project_name}${node.part_no ? ' / ' + node.part_no : ''}`,
    `FMEA类型：${node.fmea_type}`,
    ancestors.length ? `结构路径：${ancestors.join(' / ')} / ${node.name}` : '',
    `结构节点：${node.name}${node.desc ? '；说明：' + node.desc : ''}`,
    step ? `过程步骤：${step.step_no || ''} ${step.name}；类型：${step.step_type || '—'}；设备：${step.equipment || '—'}；输入：${step.input_desc || '—'}；输出：${step.output_desc || '—'}` : '',
    `相关要求/特性：${charText}`,
    functions.length ? `已有功能（不得重复）：${functions.map(f => f.text).join('；')}` : '',
  ].filter(Boolean).join('\n');
  return { node, step, charRows, functions, contextText };
}

function normalizedFunctionText(value) {
  return String(value || '').replace(/^\s*\d+[.、)]\s*/, '').replace(/[\s，。；：、,.!?！？]/g, '').trim();
}

function isValidStandardFunction(text) {
  const clean = String(text || '').trim();
  if (clean.length < 5 || clean.length > 60) return false;
  if (PLACEHOLDER_RE.test(clean) || /失效|不良|异常|缺陷|故障/.test(clean)) return false;
  if (/^保持.+工艺参数.+可测量结果/.test(clean)) return false;
  if (/^使.+满足下道工序接收准则$/.test(clean)) return false;
  return FUNCTION_VERBS.some(verb => clean.includes(verb));
}

function normalizeFailureCandidate(failure, functionText) {
  if (!failure || typeof failure !== 'object') return null;
  const mode = String(failure.mode || '').trim();
  const effect = String(failure.effect || '').trim();
  const cause = String(failure.cause || '').trim();
  const pc = String(failure.pc || '').trim();
  const dc = String(failure.dc || '').trim();
  if (!mode || !effect || !cause || !pc || !dc) return null;
  if ([mode, effect, cause, pc, dc].some(value => PLACEHOLDER_RE.test(value))) return null;
  if (GENERIC_FAILURE_MODES.has(mode) || mode.length < 4) return null;
  if (normalizedFunctionText(mode) === normalizedFunctionText(functionText)) return null;
  return {
    effect, mode, cause,
    s: Math.min(10, Math.max(1, +failure.s || 8)),
    pc, dc, cat: String(failure.cat || '').trim(),
  };
}

function normalizeFunctionBundle(items, excludedTexts, limit) {
  const excluded = new Set(excludedTexts.map(normalizedFunctionText));
  const result = [];
  for (const raw of items || []) {
    if (result.length >= limit) break;
    const item = typeof raw === 'string' ? { text: raw, failures: [] } : raw;
    const text = String(item?.text || '').trim();
    if (!isValidStandardFunction(text)) continue;
    const key = normalizedFunctionText(text);
    if (excluded.has(key)) continue;
    const failures = (Array.isArray(item.failures) ? item.failures : [])
      .map(failure => normalizeFailureCandidate(failure, text)).filter(Boolean);
    const uniqueFailures = [];
    const seenModes = new Set();
    for (const failure of failures) {
      const modeKey = normalizedFunctionText(failure.mode);
      if (seenModes.has(modeKey)) continue;
      seenModes.add(modeKey);
      uniqueFailures.push(failure);
    }
    excluded.add(key);
    result.push({
      text,
      rationale: String(item.rationale || '由用户口语描述与当前过程上下文归纳').trim(),
      failures: uniqueFailures.slice(0, 4),
    });
  }
  return result;
}

function normalizeFailureList(items, functionText, excludedModes, limit = 3) {
  const excluded = new Set(excludedModes.map(normalizedFunctionText));
  const result = [];
  for (const raw of items || []) {
    if (result.length >= limit) break;
    const failure = normalizeFailureCandidate(raw, functionText);
    if (!failure) continue;
    const key = normalizedFunctionText(failure.mode);
    if (excluded.has(key)) continue;
    excluded.add(key);
    result.push(failure);
  }
  return result;
}

function localFunctionBundles(context, draft, excluded, limit) {
  const stepName = context.step?.name || context.node.name;
  const output = context.step?.output_desc || context.charRows.find(c => c.char_kind === 'PRODUCT')?.name || '规定输出';
  const input = context.step?.input_desc || '规定输入';
  const equipment = context.step?.equipment || '过程设备';
  const characteristics = context.charRows.map(c => c.name).filter(Boolean).slice(0, 3);
  const numericText = [draft, context.node.desc, stepName, output].filter(Boolean).join(' ').match(
    /(?:槽深|厚度|宽度|温度|压力|功率|速度|阻值|位置偏差|切槽深度|时间)\s*[^\s，。；]{0,20}(?:μm|um|mm|℃|W|V|%|s|min|N)/gi
  ) || [];
  const parenthetical = (String(output).match(/[（(]([^）)]{2,32})[）)]/) || [])[1] || '';
  const requirement = [...new Set([...numericText, parenthetical, ...characteristics])].filter(Boolean).slice(0, 3).join('、') || '规定状态';
  const inputParts = String(input).split(/[、,，;；]/).map(value => value.trim()).filter(Boolean);
  const material = inputParts[0] || '来料';
  const parameterHint = inputParts[1] || '关键参数';
  const outputCore = String(output).replace(/[（(][^）)]*[）)]/g, '').replace(/^带/, '').trim() || output;
  const outputSubject = outputCore.replace(/的?(基片|半成品|成品|零件|组件)$/, '').trim() || outputCore;
  const function1 = /激光|划线|刻划/.test(stepName + draft)
    ? `在${material}上形成${requirement}的${outputSubject}`
    : `在${material}上形成满足${requirement}的${outputSubject}`;
  const function2 = `控制${equipment}的${parameterHint}以稳定${requirement}`;
  const function3 = `确认${outputSubject}达到${requirement}并隔离不符合品`;
  const localItems = [
    {
      text: function1,
      rationale: `从“${draft || stepName}”中提取动作与输出，按过程步骤功能口径改写`,
      failures: [
        {
          effect: `${outputSubject}无法满足下道工序接收要求`, mode: `${stepName}操作遗漏，${outputSubject}未形成`,
          cause: `操作人员未按${equipment}作业步骤启动或执行`, s: 8,
          pc: `${equipment}程序联锁并锁定作业参数`, dc: `首件确认并逐班核对过程记录`,
        },
        {
          effect: `${outputSubject}无法满足${requirement}`, mode: `${outputSubject}的${requirement}超出规定范围`,
          cause: `${equipment}参数漂移或工装定位不稳定`, s: 8,
          pc: `锁定设备参数并按周期点检工装`, dc: `首件测量并按频次抽检`,
        },
      ],
    },
    {
      text: function2,
      rationale: `结合工序设备、输入输出和项目特性${requirement}归纳可测量过程功能`,
      failures: [
        {
          effect: `下道工序输入波动并可能造成返工或分选`, mode: `${equipment}的${parameterHint}超出控制范围`,
          cause: `${equipment}参数设定错误或校准失效`, s: 7,
          pc: `参数权限锁定并执行开机点检`, dc: `在线监控关键参数并超限报警`,
        },
        {
          effect: `${requirement}批次间不一致`, mode: `${stepName}形成的${outputSubject}批次间不一致`,
          cause: `${equipment}状态变化或${input}批次差异`, s: 7,
          pc: `来料确认、设备预防维护和参数窗口验证`, dc: `SPC监控并按规定频次抽检`,
        },
      ],
    },
    {
      text: function3,
      rationale: '按过程工作要素和过程步骤的输入输出关系归纳功能',
      failures: [
        {
          effect: `装配或后续加工无法正常进行`, mode: `${outputSubject}未达到${requirement}`,
          cause: `${input}状态变化且${equipment}未自动补偿`, s: 8,
          pc: `来料验收并验证${equipment}工艺窗口`, dc: `首件及过程抽检确认${requirement}`,
        },
        {
          effect: `产品在客户端出现功能波动`, mode: `${outputSubject}的${requirement}不稳定`,
          cause: `${equipment}维护不当或操作参数未固化`, s: 8,
          pc: `制定设备维护周期并固化参数`, dc: `过程审核与成品性能验证`,
        },
      ],
    },
    {
      text: `检验${outputSubject}的${requirement}并隔离不符合状态`,
      rationale: '把描述中的质量条件和输出要求转换为过程步骤功能',
      failures: [
        {
          effect: `不符合状态流入下道工序，造成返工或装配失败`,
          mode: `${outputSubject}的${requirement}未检验，不符合状态被放行`,
          cause: `检验人员漏做首件或使用了失效的${equipment}检测程序`, s: 8,
          pc: `首件确认权限锁定并执行检验程序版本校验`,
          dc: `首件全项确认并对不符合品进行红色隔离`,
        },
        {
          effect: `客户收到功能不稳定的产品`,
          mode: `${output}的判定结果与实际状态不一致`,
          cause: `量具未校准或检验人员误读${equipment}结果`, s: 8,
          pc: `按周期校准量具并培训判定准则`,
          dc: `标准件校验和双人复核关键判定`,
        },
      ],
    },
    {
      text: `维持${equipment}的${parameterHint}在${requirement}工艺窗口内`,
      rationale: '按过程工作要素功能及其过程特性归纳设备控制要求',
      failures: [
        {
          effect: `${output}过程能力下降并出现批次波动`,
          mode: `${equipment}的${parameterHint}超出${requirement}工艺窗口`,
          cause: `设备校准漂移或参数权限被未授权修改`, s: 7,
          pc: `参数权限锁定并执行设备日点检`,
          dc: `在线监控和超限自动停机`,
        },
        {
          effect: `下道工序接收特性不稳定`,
          mode: `${equipment}未能覆盖${input}的正常批次差异`,
          cause: `设备维护不足或工装磨损`, s: 7,
          pc: `按周期实施预防维护并更换易损件`,
          dc: `首件测量、巡检和SPC趋势监控`,
        },
      ],
    },
    {
      text: `在${outputSubject}上形成可识别且可追溯的批次状态`,
      rationale: '补充输出标识和可追溯性，覆盖教材中的过程输出要求',
      failures: [
        {
          effect: `发生质量问题时无法定位批次和责任工序`,
          mode: `${outputSubject}缺少批次标识或标识信息错误`,
          cause: `标签打印程序错误或人工贴标位置错误`, s: 6,
          pc: `标签模板锁定并设置批次信息自动生成`,
          dc: `首件标签确认和每批标签扫码校验`,
        },
        {
          effect: `混淆不同状态产品并造成错误流转`,
          mode: `${outputSubject}合格与待处理状态未清晰区分`,
          cause: `区域标识缺失或转运人员未执行状态隔离`, s: 7,
          pc: `划分状态区域并使用颜色标识工装`,
          dc: `每班现场巡查并核对流转卡`,
        },
      ],
    },
    {
      text: `记录${stepName}过程和${requirement}结果以保持可追溯`,
      rationale: '补充过程结果记录和可追溯性功能，确保功能要求有证据',
      failures: [
        {
          effect: `质量异常无法追溯到具体批次和加工条件`,
          mode: `${stepName}过程记录缺失或${requirement}结果未记录`,
          cause: `操作人员漏填记录或设备数据未自动采集`, s: 6,
          pc: `设备自动采集关键参数并设置必填记录项`,
          dc: `每班核对记录完整性并抽查原始数据`,
        },
        {
          effect: `发生偏差时无法及时启动隔离和纠正`,
          mode: `${stepName}异常记录与实际处置状态不一致`,
          cause: `异常未闭环或记录人员误填处理结果`, s: 7,
          pc: `异常处置权限分级并设置关闭条件`,
          dc: `班组长每日复核异常记录和隔离清单`,
        },
      ],
    },
  ];
  return normalizeFunctionBundle(localItems, excluded, limit);
}

function localDfmeaFunctionBundles(context, draft, excluded, limit) {
  const item = context.node.name || '当前结构件';
  const sourceText = `${item} ${draft || ''} ${context.node.desc || ''}`;
  const draftRequirements = [...new Set(String(draft || '').match(/阻值|方阻|绝缘|耐压|耐湿|载荷|强度|尺寸|接口|连接/g) || [])];
  const requirement = [...new Set([
    ...context.charRows.map(row => row.name).filter(Boolean).slice(0, 2),
    ...draftRequirements,
  ])].join('、') || '图纸及性能要求';
  const functionRequirement = draftRequirements.includes('阻值') || draftRequirements.includes('方阻') ? '阻值'
    : draftRequirements.includes('绝缘') || draftRequirements.includes('耐压') ? '绝缘'
      : draftRequirements.includes('强度') || draftRequirements.includes('载荷') ? '强度'
        : draftRequirements.includes('尺寸') ? '尺寸'
          : context.charRows.map(row => row.name).filter(Boolean)[0] || '图纸性能';
  let texts;
  if (/基体|基片|陶瓷|芯体|骨架/.test(sourceText)) {
    texts = [
      `支撑电阻膜层并满足${functionRequirement}结构要求`,
      `隔离电阻膜层与导电基体并满足${functionRequirement}绝缘要求`,
      `保持基体尺寸并满足${functionRequirement}`,
    ];
  } else if (/电阻膜|膜层|电阻层|薄膜/.test(sourceText)) {
    texts = [
      `形成导电通路并满足方阻及${functionRequirement}`,
      `保持膜层附着并满足${functionRequirement}附着力要求`,
      `隔离相邻导电区域并满足${functionRequirement}绝缘间距要求`,
    ];
  } else if (/切槽|螺旋槽|调阻槽|沟槽/.test(sourceText)) {
    texts = [
      `切断指定导电路径并满足${functionRequirement}要求`,
      `控制切槽深度并满足${functionRequirement}基体剩余厚度要求`,
      `保持切槽位置并满足${functionRequirement}位置公差要求`,
    ];
  } else if (/引线|电极|端子|端帽|焊点/.test(sourceText)) {
    texts = [
      `连接元件与外部电路并满足接触电阻要求`,
      `固定端部并满足连接强度要求`,
      `传导工作电流并满足额定电气要求`,
    ];
  } else if (/涂层|清漆|包封|塑封|外壳|保护层/.test(sourceText)) {
    texts = [
      `隔离元件与外部环境并满足绝缘耐压要求`,
      `覆盖规定区域并满足涂层厚度要求`,
      `保护内部结构并满足耐湿热要求`,
    ];
  } else {
    texts = [
      `支撑${item}并满足${functionRequirement}设计要求`,
      `连接${item}与相邻部件并满足${functionRequirement}接口要求`,
      `保护${item}并满足${functionRequirement}可靠性要求`,
    ];
  }
  const modePairs = [
    [`${item}关键尺寸超出图纸公差`, `${item}在规定载荷下出现裂纹或永久变形`],
    [`${item}功能特性超出设计限值`, `${item}在环境试验后出现性能衰减`],
    [`${item}与相邻结构的接口位置超差`, `${item}材料或结构未达到规定耐久要求`],
  ];
  const localItems = texts.map((text, index) => ({
    text,
    rationale: `依据 DFMEA 结构件「${item}」及用户描述归纳；需结合图纸和验证要求确认`,
    failures: modePairs[index].map((mode, failureIndex) => ({
      effect: `产品无法满足${requirement}，可能影响下游装配或使用性能`,
      mode,
      cause: failureIndex
        ? `${item}材料选型或结构强度设计未覆盖实际载荷/环境`
        : `${item}尺寸、公差或基准方案设计不合理`,
      s: 8,
      pc: '设计规范定义材料、基准、公差及载荷边界，并进行设计评审',
      dc: failureIndex
        ? 'DVP&R 执行对应机械/环境可靠性试验并评审结果'
        : '设计评审校核尺寸链，并通过样件测量验证',
    })),
  }));
  return normalizeFunctionBundle(localItems, excluded, limit);
}

route('POST', /^\/api\/ai\/function$/, async (m, body) => {
  const node = String(body.node || '').trim();
  if (!node) throw new Error('缺少结构节点');
  if (!body.node_id) throw new Error('缺少结构节点 ID，无法保存功能候选');
  const draft = String(body.draft || '').trim();
  const context = aiContextForNode(body.node_id);
  const existingFunctions = context.functions;
  const usedCount = existingFunctions.length;
  const remaining = Math.max(0, 15 - usedCount);
  if (remaining === 0) {
    return {
      source: 'limit',
      limitReached: true,
      used: usedCount,
      remaining: 0,
      functions: [],
      items: [],
      saved: [],
      note: '该结构节点已有 15 条功能，达到系统上限。请先采用、合并或删除不再使用的功能。',
    };
  }
  const wanted = Math.min(3, remaining);
  const isDfmea = context.node.fmea_type === 'DFMEA';
  const excluded = existingFunctions.map(item => item.text);
  const key = getSetting('ai_key', '');
  const model = getSetting('ai_model', '');
  const base = getSetting('ai_base_url', 'https://api.openai.com/v1').replace(/\/+$/, '');
  const bundles = [];
  let usedAi = false;
  let usedLocal = false;
  let fallbackNote = '';
  if (key && model) {
    const system = isDfmea ? `你是 AIAG-VDA DFMEA 设计功能分析和失效分析专家。
1. 分析对象是当前产品结构、子系统或零件的设计意图，不是工序、设备、人员或 4M 过程要素。
2. 功能使用现在时动作动词 + 对象 + 可判断的性能/接口/环境要求；结合图纸、产品特性与用户描述，避免把零件名称改写成空泛功能。
3. 口语描述若包含多个独立设计目的，可以拆分；不得自行编造项目未提供的尺寸、公差或性能数值。
4. 本次只输出功能候选，不输出 FE/FM/FC、PC/DC 或失效候选；用户采用功能后系统会单独调用失效分析。
5. 不要输出失效链字段，避免在功能候选阶段消耗失效分析算力。
6. 严禁“尺寸偏差”“功能失效”“不良”“异常”“不合格”等空泛模式；不得编造已有控制或测试结论。
7. 只输出 JSON。`
      : `你是 AIAG-VDA PFMEA 第三版功能分析和失效分析专家。必须遵守教材第3章、第4章：
1. 功能描述的是过程项、过程步骤或过程工作要素的预期用途，不是操作方法复述。
2. 功能使用现在时、基本形式动作动词 + 对象；对象应包含可判断或测量的产品特性/要求。每条尽量 8-35 个汉字。
3. 口语描述若包含多个动作，要拆成多条功能；不得原样照抄长句，不得写“保持工艺参数并输出可测量结果”这类空泛套话。
4. 必须利用工序名称、设备、输入、输出和相关产品/过程特性，候选之间必须有实质区别。
5. 本次只输出功能候选，不输出 FE/FM/FC、PC/DC 或失效候选；用户采用功能后系统会单独调用失效分析。
6. 只输出 JSON，不解释。`;
    for (let attempt = 0; attempt < 2 && bundles.length < wanted; attempt += 1) {
      const missing = wanted - bundles.length;
      const excludedNow = [...excluded, ...bundles.map(item => item.text)];
      const user = `用户大白话描述：
${draft || '（未填写，请根据当前结构节点、设备、输入输出和特性推断）'}

当前结构上下文：
${body.context ? body.context + '\n' : ''}${context.contextText}

已经存在、禁止重复的功能：
${excludedNow.length ? excludedNow.join('\n') : '无'}

请输出 ${missing} 条新的、标准口径的${isDfmea ? '设计' : '过程'}功能候选。这里只输出功能，不生成失效分析；失效分析会在用户采用某条功能后单独执行。
JSON 格式：
{"functions":[{"text":"标准功能","rationale":"一句话说明如何从大白话和上下文归纳"}]}`;
      try {
        const parsed = await requestAiJson({ base, key, model, system, user });
        const normalized = normalizeFunctionBundle(parsed.functions || [], excludedNow, missing);
        if (normalized.length) {
          bundles.push(...normalized);
          usedAi = true;
        }
      } catch (e) {
        fallbackNote = 'AI 分析未完成，已补充本地候选：' + netErr(e);
        break;
      }
    }
  }
  if (bundles.length < wanted) {
    const localFn = isDfmea ? localDfmeaFunctionBundles : localFunctionBundles;
    const local = localFn(context, draft, [...excluded, ...bundles.map(item => item.text)], wanted - bundles.length);
    if (local.length) {
      bundles.push(...local);
      usedLocal = true;
    }
  }
  if (!bundles.length) throw new Error(fallbackNote || `未能生成符合 ${isDfmea ? 'DFMEA 设计' : 'PFMEA 过程'}功能分析口径的候选`);
  const source = usedAi && usedLocal ? 'mixed' : usedAi ? 'ai' : 'local';
  let functionSeq = (q('SELECT MAX(seq) m FROM fmea_function WHERE node_id=?', body.node_id).m || 0);
  const saved = DB.tx(() => {
    const out = [];
    for (const bundle of bundles) {
      const functionId = 'FN-' + crypto.randomUUID();
      DB.db.prepare(`INSERT INTO fmea_function(
        func_id,node_id,text,status,source,seq,created_at,rationale
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        functionId, body.node_id, bundle.text, '候选',
        source === 'ai' ? 'ai' : 'local', ++functionSeq, DB.now(), bundle.rationale
      );
      out.push({
        func_id: functionId, text: bundle.text, rationale: bundle.rationale,
        failures: [], failure_ids: [],
      });
    }
    return out;
  });
  L.audit(source === 'ai' ? 'AI' : '本地规则', '生成', 'fmea_function', body.node_id,
    null, { count: saved.length, source, max: 15 }, '按功能口径批量生成功能候选');
  return {
    source,
    functions: saved.map(item => item.text),
    items: saved,
    saved,
    used: usedCount + saved.length,
    remaining: remaining - saved.length,
    limitReached: usedCount + saved.length >= 15,
    note: fallbackNote || (source === 'ai'
      ? `已保存 ${saved.length} 条新功能候选；采用功能后再生成失效分析。当前已用 ${usedCount + saved.length}/15。`
      : `外部 AI 不可用，已按${isDfmea ? '设计结构' : '工序'}上下文规则生成 ${saved.length} 条功能候选。当前已用 ${usedCount + saved.length}/15。`),
  };
});

route('POST', /^\/api\/ai\/suggest$/, async (m, body) => {
  const node = String(body.node || '').trim();
  if (!node) throw new Error('缺少结构节点');
  if (!body.node_id || !body.func_id) throw new Error('缺少结构节点或功能 ID，无法保存失效候选');
  const functionRow = q(`SELECT * FROM fmea_function
    WHERE func_id=? AND node_id=? AND status='正式'`, body.func_id, body.node_id);
  if (!functionRow) throw new Error('功能不属于当前结构节点');
  const functionText = String(body.func || functionRow.text || '').trim();
  const context = aiContextForNode(body.node_id);
  const isDfmea = context.node.fmea_type === 'DFMEA';
  const existingModes = all(`SELECT mode FROM fmea_failure_cand
    WHERE node_id=? AND func_id=?`, body.node_id, body.func_id).map(row => row.mode).filter(Boolean);
  const key = getSetting('ai_key', '');
  const model = getSetting('ai_model', '');
  const base = getSetting('ai_base_url', 'https://api.openai.com/v1').replace(/\/+$/, '');
  let list = [];
  let usedAi = false;
  let usedLocal = false;
  let fallbackNote = '';
  const stepName = context.step?.name || context.node.name;
  const output = context.step?.output_desc || context.charRows.find(c => c.char_kind === 'PRODUCT')?.name || '过程输出';
  const input = context.step?.input_desc || '过程输入';
  const equipment = context.step?.equipment || '过程设备';
  const numericText = [functionText, context.node.desc, output].filter(Boolean).join(' ').match(
    /(?:槽深|厚度|宽度|温度|压力|功率|速度|阻值|位置偏差|切槽深度|时间)\s*[^\s，。；]{0,20}(?:μm|um|mm|℃|W|V|%|s|min|N)/gi
  ) || [];
  const requirement = [...new Set([
    ...context.charRows.map(c => c.name).filter(Boolean),
    ...numericText,
  ])].slice(0, 3).join('、') || '规定状态';
  const localFailures = () => isDfmea ? [
    {
      effect: `产品无法满足${requirement}，影响整机性能或下游装配`,
      mode: `${context.node.name}关键尺寸超出图纸公差`,
      cause: `${context.node.name}尺寸、公差或基准方案设计不合理`,
      s: 8, pc: '设计规范定义材料、基准和公差边界，并进行设计评审',
      dc: '设计评审校核尺寸链，并通过样件测量验证',
    },
    {
      effect: `产品在使用寿命内无法持续满足${requirement}`,
      mode: `${context.node.name}在规定载荷或环境后出现裂纹/性能衰减`,
      cause: `${context.node.name}材料选型或结构强度设计未覆盖实际工况`,
      s: 8, pc: '按实际载荷和环境条件完成材料与结构设计校核',
      dc: 'DVP&R 执行对应机械/环境可靠性试验并评审结果',
    },
    {
      effect: `上层组件无法正确装配或实现预期功能`,
      mode: `${context.node.name}与相邻结构接口位置或配合关系不符合设计要求`,
      cause: '接口基准定义不完整或尺寸链分析遗漏关键公差',
      s: 8, pc: '建立接口控制要求并评审关键尺寸链',
      dc: '通过样件装配验证及接口尺寸测量确认',
    },
  ] : [
    {
      effect: `${output}无法满足下道工序接收条件，可能导致停线或分选`,
      mode: `${stepName}操作遗漏，${output}未按功能要求形成`,
      cause: `操作人员未按${equipment}作业顺序执行或漏放${input}`,
      s: 8, pc: `${equipment}启动联锁并执行作业前确认`, dc: `首件确认并逐班核对过程记录`,
    },
    {
      effect: `${requirement}不合格，造成返工、报废或后续装配困难`,
      mode: `${output}的${requirement}超出规定要求`,
      cause: `${equipment}参数漂移、工装定位偏差或${input}状态变化`,
      s: 8, pc: `锁定设备参数并按规定周期点检工装`, dc: `首件测量并按频次抽检${requirement}`,
    },
    {
      effect: `批次间质量波动，客户端出现功能不稳定或装配偏差`,
      mode: `${stepName}形成的${output}在批次间不一致`,
      cause: `${equipment}维护状态变化或作业参数未固化`,
      s: 7, pc: `执行设备预防维护并固化工艺参数权限`, dc: `过程审核、SPC监控和成品抽检`,
    },
    {
      effect: `下道工位无法抓取、定位或继续加工`,
      mode: `${stepName}执行顺序或加工位置错误`,
      cause: `工装防错失效或操作人员使用错误程序`,
      s: 8, pc: `程序版本校验并设置工装防错`, dc: `首件位置确认和防错功能每班验证`,
    },
    {
      effect: `${output}在后工序搬运或装配时发生破损`,
      mode: `${stepName}在${output}边缘形成微裂纹或崩边`,
      cause: `${equipment}夹持力过大或工装接触面磨损`,
      s: 8, pc: `限制夹持力并定期检查工装接触面`,
      dc: `首件外观检查并按频次抽检边缘缺陷`,
    },
    {
      effect: `后工序无法按设计位置继续加工`,
      mode: `${stepName}加工区域相对${output}发生位置偏移`,
      cause: `定位基准错误、CCD偏移或工装未压紧`,
      s: 8, pc: `锁定定位基准并每班校验视觉定位`,
      dc: `首件位置测量和巡检确认加工区域`,
    },
    {
      effect: `${requirement}在后续工序出现波动或污染`,
      mode: `${stepName}在${output}表面残留颗粒或异物`,
      cause: `${equipment}清洁不足或环境洁净度下降`,
      s: 7, pc: `设置设备清洁周期并控制作业环境`,
      dc: `首件清洁度检查和班次环境点检`,
    },
    {
      effect: `${output}未获得足够的加工能量，功能要求无法实现`,
      mode: `${stepName}的有效加工能量或作用时间不足`,
      cause: `${equipment}功率衰减或工艺时间参数设置偏低`,
      s: 8, pc: `锁定功率和时间参数并执行能量点检`,
      dc: `过程参数在线监控和首件功能验证`,
    },
  ];
  if (key && model) {
    const system = isDfmea ? `你是 AIAG-VDA DFMEA 设计失效分析专家。只分析当前结构件设计功能，不分析工序或4M过程要素：
1. FE 描述对上层功能、整机或顾客的影响；FM 描述当前设计结构件功能如何未实现或退化；FC 指向材料、几何、公差、接口或设计假设等设计原因。
2. PC/DC 是设计预防控制和设计验证控制，如设计规范、评审、计算/仿真、DVP&R 验证；不得给出设备点检、首件、巡检等过程控制。
3. 失效模式必须具体到当前结构件和失效表现，禁止“尺寸偏差”“功能失效”“不良”“异常”“不合格”等空泛词；不得编造数值、已有控制或试验结论。
4. 只输出 JSON：{"failures":[{"effect":"","mode":"","cause":"","s":8,"pc":"","dc":""}]}`
      : `你是 AIAG-VDA PFMEA 教材第4章失效分析专家。必须围绕给定的一条功能建立完整失效链：
1. FE 是过程项功能的反面，写清对下道工序、工厂或最终用户的具体影响。
2. FM 是当前过程步骤功能的反面，必须具体写“什么对象发生了什么”，可使用遗漏、过多、过少、不完整、不一致、过快、过慢、位置错误等形态。
3. FC 是过程工作要素功能的反面，必须落到具体人员、设备、材料、环境或方法的4M原因。
4. PC 写防止FC发生的具体现行控制；DC 写检出FM/FC的具体方法和频次。
5. 严禁“尺寸偏差”“功能失效”“不良”“异常”“不合格”等空泛词，禁止占位符和空字段。
6. 只输出JSON：{"failures":[{"effect":"","mode":"","cause":"","s":8,"pc":"","dc":""}]}`;
    for (let attempt = 0; attempt < 2 && list.length < 3; attempt += 1) {
      const missing = 3 - list.length;
      const excludedNow = [...existingModes, ...list.map(item => item.mode)];
      const user = `当前功能：${functionText}

结构${isDfmea ? '及设计特性' : '、工序及过程特性'}上下文：
${context.contextText}

已有失效模式（不得重复）：
${excludedNow.length ? excludedNow.join('\n') : '无'}

请针对“当前功能”再给出 ${missing} 条新的、具体的失效链。不要对其他功能或整个零件泛泛分析。`;
      try {
        const parsed = await requestAiJson({ base, key, model, system, user });
        const normalized = normalizeFailureList(parsed.failures || [], functionText, excludedNow, missing);
        if (normalized.length) {
          list.push(...normalized);
          usedAi = true;
        }
      } catch (e) {
        fallbackNote = 'AI 分析未完成，已补充本地失效候选：' + netErr(e);
        break;
      }
    }
  }
  if (list.length < 3) {
    const local = normalizeFailureList(localFailures(), functionText, [...existingModes, ...list.map(item => item.mode)], 3 - list.length);
    if (local.length) {
      list.push(...local);
      usedLocal = true;
    }
  }
  const source = usedAi && usedLocal ? 'mixed' : usedAi ? 'ai' : 'local';
  const saved = [];
  for (const failure of list) {
    const id = 'FC-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100);
    DB.db.prepare(`INSERT INTO fmea_failure_cand(
      cand_id,node_id,func_id,effect,mode,cause,s,status,source,created_at,pc,dc,cat
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, body.node_id, body.func_id, failure.effect, failure.mode, failure.cause,
        failure.s, '候选', source, DB.now(), failure.pc, failure.dc, failure.cat || '');
    saved.push({ cand_id: id, mode: failure.mode, existed: false });
  }
  L.audit(source === 'ai' ? 'AI' : '本地规则', '生成', 'fmea_failure_cand',
    body.node_id, null, { count: saved.length, source, func_id: body.func_id }, '按指定功能生成失效链');
  return {
    source,
    failures: list,
    saved,
    note: fallbackNote || (source === 'ai'
      ? `已围绕当前功能生成 ${saved.length} 条新的具体失效候选。`
      : `外部 AI 不可用，已围绕当前功能和过程上下文生成 ${saved.length} 条新候选。`),
  };
});


route('GET', /^\/api\/dfmea\/image$/, () => {
  const h = q("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='DFMEA'", CUR);
  if (!h) return { image: null };
  const row = q('SELECT * FROM fmea_image WHERE fmea_id=?', h.fmea_id);
  return row ? { image: row.data, labels: JSON.parse(row.labels_json || '[]'), at: row.created_at } : { image: null };
});

const ST = require('./lib/structure');

function gateAutoChecks(phase) {
  const docDone = code => {
    const row = q('SELECT status FROM project_doc WHERE project_id=? AND doc_code=?', CUR, code);
    return !!row && ['已批准', '已完成', '系统模块'].includes(row.status);
  };
  const fmea = type => q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', CUR, type) || {};
  const cpPlans = all('SELECT * FROM control_plan WHERE project_id=?', CUR);
  if (phase === 0) {
    return [
      docDone('P0-01') && docDone('P0-02'),
      docDone('P0-10'),
      docDone('P0-05'),
    ];
  }
  if (phase === 1) {
    return [
      docDone('P1-07') && docDone('P1-08') && docDone('P1-11'),
      docDone('P1-09') && docDone('P1-10') && docDone('P1-13'),
      docDone('P1-12') && docDone('P1-17'),
      docDone('P1-15') && docDone('P1-16'),
    ];
  }
  if (phase === 2) {
    const dfmea = fmea('DFMEA');
    const highMissing = q(`SELECT COUNT(*) c FROM fmea_row r
      LEFT JOIN fmea_decision d ON d.row_id=r.row_id
      WHERE r.fmea_id=? AND r.ap='H'
        AND (d.row_id IS NULL OR d.status<>'已批准' OR COALESCE(d.approved_by,'')='')`,
      dfmea.fmea_id || '').c;
    return [
      dfmea.status === '已发布' && highMissing === 0,
      docDone('P2-02') && docDone('P2-03') && docDone('P2-04'),
      docDone('P2-05') && docDone('P2-06') && docDone('P2-07') && docDone('P2-08'),
      docDone('P2-10') && docDone('P2-11') && docDone('P2-12') && docDone('P2-13'),
    ];
  }
  if (phase === 3) {
    const activeSteps = all("SELECT status FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'", CUR);
    const pfmea = fmea('PFMEA');
    return [
      docDone('P3-03'),
      activeSteps.length > 0 && activeSteps.every(step => step.status === '已发布'),
      pfmea.status === '已发布' && all(
        "SELECT node_id FROM fmea_node WHERE fmea_id=? AND level=3 AND COALESCE(status,'生效')<>'作废'",
        pfmea.fmea_id || ''
      ).length > 0,
      cpPlans.some(cp => cp.stage === 'PILOT' && ['已批准', '已冻结'].includes(cp.status))
        && docDone('P3-07') && docDone('P3-08') && docDone('P3-09'),
    ];
  }
  if (phase === 4) {
    const ppapDone = q("SELECT COUNT(*) c FROM ppap_element WHERE project_id=? AND status='已完成'", CUR).c;
    const ppapTotal = q('SELECT COUNT(*) c FROM ppap_element WHERE project_id=?', CUR).c;
    const msaPlans = DB.listMsaPlans(CUR).filter(plan => plan.source_active !== 0);
    const msaBad = msaPlans.filter(plan => plan.status !== '已完成' || plan.source_status !== '有效'
      || plan.study_judgment !== '接受' || plan.study_status !== '已完成').length;
    const cpProduction = cpPlans.find(cp => cp.stage === 'SOP');
    const safeLaunchReady = !!cpProduction
      && cpProduction.safe_launch_applicability !== '未判定'
      && (cpProduction.safe_launch_applicability === '不要求'
        ? !!String(cpProduction.safe_launch_note || '').trim()
        : ['计划', '执行中', '已退出'].includes(cpProduction.safe_launch_status));
    const spcItems = all(`SELECT m.mon_id FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
      JOIN control_plan p ON p.cp_id=r.cp_id WHERE p.project_id=? AND m.approval_status='已批准'`, CUR);
    let cpkOk = spcItems.length > 0;
    for (const item of spcItems) {
      const dataset = q('SELECT data_json FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC LIMIT 1', item.mon_id);
      if (!dataset) { cpkOk = false; break; }
      const monitor = q('SELECT * FROM monitoring_item WHERE mon_id=?', item.mon_id);
      const cpRow = q(`SELECT c.*,COALESCE(pc.lsl,cm.lsl) lsl,COALESCE(pc.usl,cm.usl) usl
        FROM cp_row c
        LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(?,c.project_char_id)
        LEFT JOIN char_master cm ON cm.char_id=COALESCE(c.char_id,pc.char_id)
        WHERE c.cp_row_id=?`, monitor.project_char_id || null, monitor.cp_row_id);
      const stat = L.spcCompute(JSON.parse(dataset.data_json), { lsl: cpRow.lsl, usl: cpRow.usl },
        { chartType: monitor.chart_type });
      if (stat.cpk == null || stat.cpk < 1.67) { cpkOk = false; break; }
    }
    return [
      docDone('P4-01'),
      msaPlans.length > 0 && msaBad === 0,
      cpkOk && docDone('P4-05') && docDone('P4-06'),
      ppapTotal > 0 && ppapDone === ppapTotal
        && !!cpProduction && ['已批准', '已冻结'].includes(cpProduction.status)
        && cpProduction.effective_date <= DB.now().slice(0, 10) && safeLaunchReady,
    ];
  }
  const productionCp = cpPlans.find(cp => cp.stage === 'SOP');
  return [
    docDone('P5-01')
      && (!productionCp || productionCp.safe_launch_applicability !== '要求'
        || productionCp.safe_launch_status === '已退出'),
    docDone('P5-02') && docDone('P5-03'),
    docDone('P5-04'),
  ];
}

route('GET', /^\/api\/structure$/, () => ({
  tabs: ST.PHASE_TABS,
  modules: ST.MODULES,
  gates: ST.GATES.map(g => ({ no: g.no, name: g.name, count: g.criteria.length })),
  globalReqs: DT.GLOBAL_REQS,
}));

route('GET', /^\/api\/closed-loop$/, (m, body, query) => {
  const type = String(query.get('type') || 'DFMEA').toUpperCase() === 'PFMEA' ? 'PFMEA' : 'DFMEA';
  if (type === 'DFMEA') {
    const header = q("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='DFMEA'", CUR);
    if (!header) throw new Error('未找到 DFMEA');
    const rows = all(`SELECT r.row_id,r.char_id,nm.name fm_name,nf.name fe_name,c.name char_name
      FROM fmea_row r
      LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
      LEFT JOIN fmea_node nf ON nf.node_id=r.fe_id
      LEFT JOIN char_master c ON c.char_id=r.char_id
      WHERE r.fmea_id=? ORDER BY r.seq`, header.fmea_id);
    const dvpDoc = q("SELECT * FROM project_doc WHERE project_id=? AND doc_code='P2-03'", CUR) || {};
    let data = {};
    try { data = JSON.parse(dvpDoc.data_json || '{}'); } catch (e) { data = {}; }
    const dvpRows = Array.isArray(data.dvp) ? data.dvp : [];
    const items = rows.map(row => {
      const needle = [row.char_id, row.char_name].filter(Boolean).map(String);
      const matches = dvpRows.filter(dvp =>
        needle.some(value => value && dvp.some(cell => String(cell || '').includes(value)))
      );
      return {
        row_id: row.row_id,
        char_id: row.char_id,
        char_name: row.char_name || row.fm_name,
        failure_effect: row.fe_name,
        failure_mode: row.fm_name,
        dvp_count: matches.length,
        covered: matches.length > 0,
        dvp: matches,
      };
    });
    return {
      type,
      items,
      summary: {
        total: items.length,
        covered: items.filter(item => item.covered).length,
        missing: items.filter(item => !item.covered).length,
      },
      source: { doc_code: 'P2-03', status: dvpDoc.status || '未开始' },
    };
  }
  const stage = String(query.get('stage') || 'SOP').toUpperCase();
  const plan = q('SELECT * FROM control_plan WHERE project_id=? AND stage=?', CUR, stage);
  if (!plan) throw new Error('未找到 ' + stage + ' 控制计划');
  const header = q("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='PFMEA'", CUR);
  if (!header) throw new Error('未找到 PFMEA');
  const items = all(`SELECT r.row_id,r.step_id,r.char_id,nm.name fm_name,nf.name fe_name,
      s.step_no,s.name step_name,
      c.cp_row_id,c.seq cp_seq,c.control_method,c.reaction_plan
    FROM fmea_row r
    LEFT JOIN fmea_node nm ON nm.node_id=r.fm_id
    LEFT JOIN fmea_node nf ON nf.node_id=r.fe_id
    LEFT JOIN process_step s ON s.step_id=r.step_id
    LEFT JOIN cp_row c ON c.cp_id=? AND (c.fmea_row_id=r.row_id
      OR (c.step_id=r.step_id AND COALESCE(c.char_id,'')=COALESCE(r.char_id,'')))
    WHERE r.fmea_id=? ORDER BY r.seq`, plan.cp_id, header.fmea_id).map(row => ({
    ...row,
    covered: !!row.cp_row_id,
  }));
  return {
    type,
    stage,
    items,
    summary: {
      total: items.length,
      covered: items.filter(item => item.covered).length,
      missing: items.filter(item => !item.covered).length,
    },
    source: { cp_id: plan.cp_id, status: plan.status },
  };
});

route('GET', /^\/api\/gates$/, () => {
  const status = L.gateStatus(CUR);
  return {
    currentPhase: status.currentPhase,
    derivedPhase: status.derivedPhase,
    criteriaVersion: status.criteriaVersion,
    gates: status.gates.map(gate => ({ ...gate, autoChecks: gateAutoChecks(gate.no) })),
  };
});

route('POST', /^\/api\/gates\/(\d+)$/, (m, body) => {
  const phase = +m[1];
  const gate = ST.GATES.find(g => g.no === phase);
  if (!gate) throw new Error('Gate 不存在');
  if (phase > 0) {
    const previous = q('SELECT decision FROM gate_review WHERE project_id=? AND phase=?', CUR, phase - 1);
    const previousVersion = q('SELECT criteria_version FROM gate_review WHERE project_id=? AND phase=?', CUR, phase - 1);
    if (!previous || previous.decision !== '通过' || previousVersion?.criteria_version !== ST.GATE_CRITERIA_VERSION) {
      throw new Error(`Gate ${phase - 1} 尚未按当前评审要求通过，不能评审 Gate ${phase}`);
    }
  }
  const checks = Array.isArray(body.checks) ? body.checks : gate.criteria.map(() => 0);
  const decision = body.decision || '待评审';
  if (!['通过', '驳回', '待评审'].includes(decision)) throw new Error('Gate评审结论无效');
  if (checks.length !== gate.criteria.length || checks.some(value => ![0, 1, false, true].includes(value))) {
    throw new Error('Gate检查项数据与当前评审要求不匹配，请刷新页面后重试');
  }
  if (decision === '通过' && checks.some(c => !c)) throw new Error('存在未满足的检查项，不能判定为通过');
  const actions = Array.isArray(body.actions) ? body.actions : [];
  if (decision !== '通过') for (const [index, checked] of checks.entries()) {
    if (checked) continue;
    const action = actions[index] || {};
    if (!String(action.action || '').trim() || !String(action.owner || '').trim()
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(action.due || ''))
        || !Number.isFinite(Date.parse(action.due)) || action.due < DB.now().slice(0, 10)) {
      throw new Error(`未满足的检查项“${gate.criteria[index]}”必须填写措施、责任人和有效计划日期`);
    }
  }
  // S-08：通过/驳回都必须留下评审结论；“通过”不能再无意见一键提交
  if (['通过', '驳回'].includes(decision) && String(body.comment || '').trim().length < 4) {
    throw new Error(`${decision} Gate 必须填写不少于 4 个字的评审意见`);
  }
  // 评审人取自会话身份，请求体无法指定（S-03）
  const reviewer = actorName();
  if (!reviewer || reviewer === '系统') throw new Error('Gate评审必须记录评审人');
  // 通过/驳回属于受控结论，需质量及以上角色；仅保存“待评审”进度时放宽
  if (decision !== '待评审') requirePermission('gate.decide', 'Gate 评审结论');
  const exists = q('SELECT 1 FROM gate_review WHERE project_id=? AND phase=?', CUR, phase);
  if (exists) {
    DB.db.prepare(`UPDATE gate_review SET decision=?,reviewer=?,comment=?,reviewed_at=?,checks_json=?,
      criteria_version=?,actions_json=? WHERE project_id=? AND phase=?`)
      .run(decision, reviewer, String(body.comment || '').trim(), DB.now(), JSON.stringify(checks),
        ST.GATE_CRITERIA_VERSION, JSON.stringify(actions), CUR, phase);
  } else {
    DB.db.prepare(`INSERT INTO gate_review(
      project_id,phase,decision,reviewer,comment,reviewed_at,checks_json,criteria_version,actions_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(CUR, phase, decision, reviewer, String(body.comment || '').trim(), DB.now(),
        JSON.stringify(checks), ST.GATE_CRITERIA_VERSION, JSON.stringify(actions));
  }
  // S-06：阶段由 Gate 结论派生（连续通过的 Gate 数），不在这里“只增不减”。
  // 驳回/重开/检查表升级都会让阶段回退到真实状态。
  const status = L.gateStatus(CUR);
  const proj = q('SELECT phase FROM project WHERE project_id=?', CUR);
  if (proj && proj.phase !== status.derivedPhase) {
    DB.db.prepare('UPDATE project SET phase=? WHERE project_id=?').run(status.derivedPhase, CUR);
  }
  L.audit(reviewer, '评审', 'gate_review', String(phase), null,
    { decision, checks, actions, derived_phase: status.derivedPhase }, '门径评审');
  return {
    ok: true, criteria_version: ST.GATE_CRITERIA_VERSION,
    derived_phase: status.derivedPhase,
  };
});

// S-08：撤回已作出的 Gate 结论（需质量角色、必须写原因），阶段随派生结果回退
route('POST', /^\/api\/gates\/(\d+)\/withdraw$/, (m, body) => DB.tx(() => {
  const phase = +m[1];
  const gate = ST.GATES.find(g => g.no === phase);
  if (!gate) throw new Error('Gate 不存在');
  const row = q('SELECT * FROM gate_review WHERE project_id=? AND phase=?', CUR, phase);
  if (!row) throw new Error('该 Gate 尚未评审');
  if (!['通过', '驳回'].includes(row.decision)) throw new Error('当前 Gate 没有可撤回的结论');
  requirePermission('gate.decide', '撤回 Gate 评审');
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw new Error('撤回 Gate 评审必须填写原因');
  const reviewer = actorName();
  DB.db.prepare(`UPDATE gate_review SET decision='待评审',reviewer=?,reviewed_at=?,
    comment=COALESCE(comment,'') || ? WHERE project_id=? AND phase=?`).run(
    reviewer, DB.now(), `\n[撤回 ${DB.now()} ${reviewer}] ${reason}`, CUR, phase
  );
  const status = L.gateStatus(CUR);
  const proj = q('SELECT phase FROM project WHERE project_id=?', CUR);
  if (proj && proj.phase !== status.derivedPhase) {
    DB.db.prepare('UPDATE project SET phase=? WHERE project_id=?').run(status.derivedPhase, CUR);
  }
  L.audit(reviewer, '撤回', 'gate_review', String(phase), row,
    { decision: '待评审', reason, derived_phase: status.derivedPhase }, reason);
  return { ok: true, decision: '待评审', derived_phase: status.derivedPhase };
}));

route('GET', /^\/api\/alerts$/, () => L.alerts(CUR));
route('GET', /^\/api\/cockpit$/, () => L.cockpit(CUR));

function analyzeImpact(sourceType, sourceId) {
  const type = String(sourceType || '').toUpperCase();
  const found = new Map();
  const add = (objectType, objectId, distance, path) => {
    if (!objectId) return;
    const key = `${objectType}:${objectId}`;
    const previous = found.get(key);
    if (!previous || distance < previous.distance) {
      found.set(key, { objectType, objectId, distance, path });
    }
  };
  const addMonitor = (cpRowId, distance, path) => {
    all('SELECT * FROM monitoring_item WHERE cp_row_id=?', cpRowId)
      .forEach(monitor => {
        add('MONITORING_ITEM', monitor.mon_id, distance, `${path} → MONITORING_ITEM:${monitor.mon_id}`);
        all('SELECT * FROM spc_dataset WHERE mon_id=?', monitor.mon_id)
          .forEach(dataset => add('SPC_DATASET', String(dataset.dataset_id), distance + 1,
            `${path} → MONITORING_ITEM:${monitor.mon_id} → SPC_DATASET:${dataset.dataset_id}`));
      });
  };
  const addCp = (cpRow, distance, path) => {
    add('CP_ROW', cpRow.cp_row_id, distance, `${path} → CP_ROW:${cpRow.cp_row_id}`);
    if (cpRow.step_id) add('STEP', cpRow.step_id, distance + 1, `${path} → CP_ROW:${cpRow.cp_row_id} → STEP:${cpRow.step_id}`);
    if (cpRow.char_id) add('CHAR', cpRow.char_id, distance + 1, `${path} → CP_ROW:${cpRow.cp_row_id} → CHAR:${cpRow.char_id}`);
    addMonitor(cpRow.cp_row_id, distance + 1, `${path} → CP_ROW:${cpRow.cp_row_id}`);
  };

  if (type === 'CHAR') {
    const char = q('SELECT * FROM char_master WHERE char_id=?', sourceId);
    if (!char) throw new Error('影响分析源特性不存在');
    add('CHAR', sourceId, 0, `CHAR:${sourceId}`);
    const links = char.char_kind === 'PRODUCT'
      ? all('SELECT * FROM char_link WHERE product_char_id=? AND status<>\'作废\'', sourceId)
      : all('SELECT * FROM char_link WHERE process_char_id=? AND status<>\'作废\'', sourceId);
    const linkedIds = links.map(link =>
      char.char_kind === 'PRODUCT' ? link.process_char_id : link.product_char_id
    );
    links.forEach(link => {
      const other = char.char_kind === 'PRODUCT' ? link.process_char_id : link.product_char_id;
      add('CHAR_LINK', String(link.link_id), 1, `CHAR:${sourceId} → CHAR_LINK:${link.link_id}`);
      add('CHAR', other, 1, `CHAR:${sourceId} → CHAR_LINK:${link.link_id} → CHAR:${other}`);
    });
    const charIds = [sourceId, ...linkedIds];
    const fmeaRows = all(`SELECT r.* FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE h.project_id=? AND r.char_id IN (${charIds.map(() => '?').join(',')})`, CUR, ...charIds);
    fmeaRows.forEach(row => {
      add('FMEA_ROW', row.row_id, 1, `CHAR:${sourceId} → FMEA_ROW:${row.row_id}`);
      if (row.step_id) add('STEP', row.step_id, 2, `CHAR:${sourceId} → FMEA_ROW:${row.row_id} → STEP:${row.step_id}`);
    });
    const cpRows = all(`SELECT c.* FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
      WHERE p.project_id=? AND c.char_id IN (${charIds.map(() => '?').join(',')})`, CUR, ...charIds);
    cpRows.forEach(row => addCp(row, 2, `CHAR:${sourceId}`));
    fmeaRows.filter(row => row.step_id).forEach(row =>
      all('SELECT * FROM cp_row WHERE step_id=?', row.step_id)
        .forEach(cpRow => addCp(cpRow, 2, `CHAR:${sourceId} → FMEA_ROW:${row.row_id}`))
    );
  } else if (type === 'FMEA_ROW') {
    const row = q(`SELECT r.* FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE r.row_id=? AND h.project_id=?`, sourceId, CUR);
    if (!row) throw new Error('影响分析源 FMEA 行不存在');
    add('FMEA_ROW', row.row_id, 0, `FMEA_ROW:${row.row_id}`);
    if (row.char_id) add('CHAR', row.char_id, 1, `FMEA_ROW:${row.row_id} → CHAR:${row.char_id}`);
    if (row.step_id) add('STEP', row.step_id, 1, `FMEA_ROW:${row.row_id} → STEP:${row.step_id}`);
    all('SELECT * FROM cp_row WHERE fmea_row_id=?', row.row_id)
      .forEach(cpRow => addCp(cpRow, 1, `FMEA_ROW:${row.row_id}`));
  } else if (type === 'CP_ROW') {
    const row = q(`SELECT c.* FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
      WHERE c.cp_row_id=? AND p.project_id=?`, sourceId, CUR);
    if (!row) throw new Error('影响分析源 CP 行不存在');
    addCp(row, 0, `CP_ROW:${sourceId}`);
    if (row.fmea_row_id) {
      const fmeaRow = q('SELECT * FROM fmea_row WHERE row_id=?', row.fmea_row_id);
      if (fmeaRow) add('FMEA_ROW', fmeaRow.row_id, 1, `CP_ROW:${sourceId} → FMEA_ROW:${fmeaRow.row_id}`);
    }
  } else if (type === 'STEP') {
    const step = q('SELECT * FROM process_step WHERE step_id=? AND project_id=?', sourceId, CUR);
    if (!step) throw new Error('影响分析源工序不存在');
    add('STEP', sourceId, 0, `STEP:${sourceId}`);
    all('SELECT * FROM fmea_row WHERE step_id=?', sourceId).forEach(row => {
      add('FMEA_ROW', row.row_id, 1, `STEP:${sourceId} → FMEA_ROW:${row.row_id}`);
      if (row.char_id) add('CHAR', row.char_id, 2, `STEP:${sourceId} → FMEA_ROW:${row.row_id} → CHAR:${row.char_id}`);
    });
    all('SELECT * FROM cp_row WHERE step_id=?', sourceId).forEach(row => addCp(row, 1, `STEP:${sourceId}`));
  } else {
    throw new Error('支持的影响分析类型：CHAR、FMEA_ROW、CP_ROW、STEP');
  }
  const items = [...found.values()];
  return {
    source: { type, id: sourceId },
    items,
    summary: {
      total: items.length,
      direct: items.filter(item => item.distance === 1).length,
      indirect: items.filter(item => item.distance > 1).length,
    },
  };
}

/* E-01：ECR 可执行变更项的字段白名单。只允许修改项目内业务字段，
   不允许通过变更单改状态机字段（status/approved_by/基线等）。 */
const ECR_CHANGE_FIELDS = {
  project_char: {
    table: 'project_char', id: 'pchar_id',
    fields: ['name', 'description', 'unit', 'target', 'lsl', 'usl', 'tol_text'],
    lookup: (id, projectId) => q('SELECT * FROM project_char WHERE pchar_id=? AND project_id=?', id, projectId),
  },
  cp_row: {
    table: 'cp_row', id: 'cp_row_id',
    fields: ['spec_text', 'measure_tech', 'sample_size', 'freq_value', 'freq_unit', 'control_method', 'reaction_plan'],
    lookup: (id, projectId) => q(`SELECT c.* FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
      WHERE c.cp_row_id=? AND p.project_id=?`, id, projectId),
  },
  fmea_row: {
    table: 'fmea_row', id: 'row_id',
    fields: ['s', 'o', 'd', 'pc_text', 'dc_text'],
    lookup: (id, projectId) => q(`SELECT r.* FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      WHERE r.row_id=? AND h.project_id=?`, id, projectId),
  },
  process_step: {
    table: 'process_step', id: 'step_id',
    fields: ['name', 'equipment', 'fixture', 'input_desc', 'output_desc'],
    lookup: (id, projectId) => q('SELECT * FROM process_step WHERE step_id=? AND project_id=?', id, projectId),
  },
};

function sameChangeValue(left, right) {
  const normalize = value => value == null ? '' : String(value).trim();
  const a = normalize(left), b = normalize(right);
  if (a === b) return true;
  if (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b)) return +a === +b;
  return false;
}

function applyEcrChanges(projectId, changeItems) {
  const applied = [];
  for (const item of changeItems) {
    const type = String(item.object_type || '').trim();
    const def = ECR_CHANGE_FIELDS[type];
    if (!def) {
      throw Object.assign(new Error(`变更对象类型“${type}”不支持自动实施；请人工执行并登记验证证据`),
        { statusCode: 409 });
    }
    const field = String(item.field_name || '').trim();
    if (!def.fields.includes(field)) {
      throw Object.assign(new Error(`字段“${type}.${field}”不在允许自动变更的白名单内`), { statusCode: 409 });
    }
    const row = def.lookup(String(item.object_id || ''), projectId);
    if (!row) {
      throw Object.assign(new Error(`变更对象 ${type}:${item.object_id} 不存在或不属于当前项目`),
        { statusCode: 409 });
    }
    if (!sameChangeValue(row[field], item.old_value)) {
      throw Object.assign(
        new Error(`变更对象 ${type}:${item.object_id} 的 ${field} 当前值已不是变更单记录的旧值（当前 ${row[field] ?? '空'}，记录 ${item.old_value ?? '空'}）；请重新发起变更`),
        { statusCode: 409 }
      );
    }
    if (sameChangeValue(row[field], item.new_value)) continue;
    const value = item.new_value === undefined ? null : item.new_value;
    DB.db.prepare(`UPDATE ${def.table} SET ${field}=? WHERE ${def.id}=?`).run(value, row[def.id]);
    applied.push({
      object_type: type, object_id: String(item.object_id), field,
      old_value: row[field] ?? null, new_value: value,
    });
    if (type === 'fmea_row' && ['s', 'o', 'd'].includes(field)) {
      const updated = q('SELECT * FROM fmea_row WHERE row_id=?', row.row_id);
      // AP 必须由后端按矩阵重算，变更单不能自带 AP
      if (updated.s >= 1 && updated.s <= 10 && updated.o >= 1 && updated.o <= 10
          && updated.d >= 1 && updated.d <= 10) {
        updated.ap = DB.apLookup(updated.s, updated.o, updated.d);
        DB.db.prepare('UPDATE fmea_row SET ap=? WHERE row_id=?').run(updated.ap, row.row_id);
      }
      const decision = q('SELECT * FROM fmea_decision WHERE row_id=?', row.row_id);
      if (decision && decision.status === '已批准'
          && (decision.s !== updated.s || decision.o !== updated.o
            || decision.d !== updated.d || decision.ap !== updated.ap)) {
        DB.db.prepare(`UPDATE fmea_decision SET status='待评审',approved_by='',approved_at=NULL
          WHERE row_id=?`).run(row.row_id);
      }
    }
  }
  return applied;
}

route('GET', /^\/api\/ecr$/, () => ({
  list: all(`SELECT e.*,
    (SELECT COUNT(*) FROM change_item i JOIN change_request r ON r.cr_id=i.cr_id
      WHERE r.source_type='ECR' AND r.source_id=e.ecr_id) items
    FROM ecr e WHERE e.project_id=? ORDER BY e.created_at DESC`, CUR),
}));
route('POST', /^\/api\/ecr$/, (m, body) => {
  const title = String(body.title || '').trim();
  const reason = String(body.reason || '').trim();
  if (!title) throw new Error('变更内容不能为空');
  if (!reason) throw new Error('变更原因不能为空');
  const changes = Array.isArray(body.changes) ? body.changes : [];
  for (const change of changes) {
    const type = String(change.object_type || '').trim();
    const def = ECR_CHANGE_FIELDS[type];
    if (!def || !def.fields.includes(String(change.field_name || '').trim())) {
      throw new Error(`变更项字段无效：${type || '未指定类型'}.${change.field_name || '未指定字段'}`);
    }
    if (!def.lookup(String(change.object_id || ''), CUR)) {
      throw new Error(`变更对象 ${type}:${change.object_id} 不存在或不属于当前项目`);
    }
  }
  const id = 'ECR-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-5);
  const latestBaseline = q('SELECT baseline_id FROM baseline WHERE project_id=? ORDER BY frozen_at DESC LIMIT 1', CUR);
  let scope = String(body.scope || '').trim();
  let impact = null;
  if (body.source_type && body.source_id) {
    impact = analyzeImpact(body.source_type, body.source_id);
    scope = `${impact.summary.total} 个对象：直接 ${impact.summary.direct} / 间接 ${impact.summary.indirect}`;
  }
  const impactAnalysis = String(body.impact_analysis || '').trim();
  DB.tx(() => {
    DB.db.prepare(`INSERT INTO ecr(
      ecr_id,project_id,title,reason,scope,status,requested_by,created_at,approved_by,baseline_id,
      impact_analysis
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, CUR, title, reason, scope, '待审批',
      actorName(), DB.now(), '', latestBaseline ? latestBaseline.baseline_id : '', impactAnalysis
    );
    if (impact || changes.length || body.payload) {
      const crId = 'CR-' + id;
      DB.db.prepare(`INSERT INTO change_request(
        cr_id,project_id,base_baseline,title,reason,status,requested_by,created_at,
        source_type,source_id,payload_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        crId, CUR, latestBaseline ? latestBaseline.baseline_id : '', title, reason,
        '评审中', actorName(), DB.now(),
        'ECR', id, JSON.stringify({ ...(body.payload || {}), changes })
      );
      const ins = DB.db.prepare(`INSERT INTO change_item(
        cr_id,object_type,object_id,change_type,distance,note,field_name,old_value,new_value
      ) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const item of impact?.items || []) {
        ins.run(crId, item.objectType, item.objectId, 'MODIFY', item.distance, item.path, null, null, null);
      }
      for (const change of changes) {
        ins.run(crId, String(change.object_type), String(change.object_id), 'FIELD', 0,
          String(change.note || ''), String(change.field_name),
          change.old_value == null ? null : String(change.old_value),
          change.new_value == null ? null : String(change.new_value));
      }
    }
  });
  L.audit(actorName(), '新增', 'ecr', id, null,
    { title, reason, scope, changes: changes.length }, '发起工程变更');
  return { ok: true, ecr_id: id, scope, impact, changes: changes.length };
});
route('GET', /^\/api\/ecr\/([^/]+)\/impact$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const ecr = q('SELECT * FROM ecr WHERE ecr_id=? AND project_id=?', id, CUR);
  if (!ecr) throw new Error('变更单不存在');
  const request = q("SELECT * FROM change_request WHERE source_type='ECR' AND source_id=?", id);
  const items = request
    ? all('SELECT * FROM change_item WHERE cr_id=? ORDER BY distance,object_type,object_id', request.cr_id)
    : [];
  const branchBaseline = ecr.branch_baseline_id
    ? q('SELECT baseline_id,tag,version,hash,frozen_at FROM baseline WHERE baseline_id=? AND project_id=?',
      ecr.branch_baseline_id, CUR)
    : null;
  const parentBaseline = ecr.parent_baseline_id
    ? q('SELECT baseline_id,tag,version,hash,frozen_at FROM baseline WHERE baseline_id=? AND project_id=?',
      ecr.parent_baseline_id, CUR)
    : null;
  return { ecr, request, items, branchBaseline, parentBaseline };
});
route('PATCH', /^\/api\/ecr\/([^/]+)$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM ecr WHERE ecr_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('变更单不存在');
  const allowed = ['待审批', '已批准', '已驳回', '已实施', '已关闭'];
  const status = allowed.includes(body.status) ? body.status : old.status;
  // 显式状态机：实施只能由 /apply 产生，关闭必须先实施
  const ECR_NEXT = {
    待审批: ['待审批', '已批准', '已驳回'],
    已驳回: ['已驳回', '待审批'],
    已批准: ['已批准', '已驳回'],
    已实施: ['已实施', '已关闭'],
    已关闭: ['已关闭'],
  };
  if (!(ECR_NEXT[old.status] || []).includes(status)) {
    throw Object.assign(
      new Error(`变更单状态不能从“${old.status}”直接变为“${status}”；实施请使用“实施”操作`),
      { statusCode: 409 }
    );
  }
  const request = q("SELECT * FROM change_request WHERE source_type='ECR' AND source_id=?", id);
  const changeItems = request
    ? all('SELECT * FROM change_item WHERE cr_id=? ORDER BY ci_id', request.cr_id) : [];
  let approvedBy = old.approved_by || '';
  if (status === '已批准' && old.status !== '已批准') {
    requirePermission('ecr.approve', '批准工程变更');
    assertNotSelfApproval(old.requested_by, '批准');
    // E-03：批准前必须有影响分析（结构化变更项/受影响对象，或书面影响分析）
    const hasImpact = changeItems.length > 0
      || String(body.impact_analysis || old.impact_analysis || '').trim().length >= 10;
    if (!hasImpact) {
      throw Object.assign(
        new Error('批准变更前必须完成影响分析：请登记受影响对象，或填写不少于 10 字的影响分析'),
        { statusCode: 409 }
      );
    }
    approvedBy = actorName();
  }
  if (status === '已驳回' && !String(body.note || '').trim()) {
    throw new Error('驳回变更必须填写原因');
  }
  // E-03：关闭前必须已实施、有变更后基线、全部结构化变更项已执行，并有验证结论
  if (status === '已关闭' && old.status !== '已关闭') {
    if (!old.branch_baseline_id) {
      throw Object.assign(new Error('关闭变更前必须完成实施并生成变更后基线'), { statusCode: 409 });
    }
    const pending = changeItems.filter(item => item.change_type === 'FIELD' && !item.applied_at);
    if (pending.length) {
      throw Object.assign(
        new Error(`仍有 ${pending.length} 项结构化变更未执行：${pending.map(item =>
          `${item.object_type}:${item.object_id}.${item.field_name}`).join('、')}`),
        { statusCode: 409 }
      );
    }
    if (String(body.verification || old.verification || '').trim().length < 4) {
      throw Object.assign(
        new Error('关闭变更前必须填写验证结论（验证证据/结果）'),
        { statusCode: 409 }
      );
    }
  }
  const impactAnalysis = String(body.impact_analysis || old.impact_analysis || '').trim();
  const verification = String(body.verification || old.verification || '').trim();
  DB.tx(() => {
    DB.db.prepare(`UPDATE ecr SET status=?, approved_by=?,
      impact_analysis=COALESCE(NULLIF(?,''),impact_analysis),
      verification=COALESCE(NULLIF(?,''),verification) WHERE ecr_id=?`)
      .run(status, approvedBy, impactAnalysis, verification, id);
    if (request) {
      DB.db.prepare(`UPDATE change_request SET
        status=?,approved_by=?,applied_at=? WHERE cr_id=?`).run(
        status === '已实施' || status === '已关闭' ? status : status === '已批准' ? '已批准' : '评审中',
        approvedBy || request.approved_by || '',
        status === '已实施' ? DB.now() : request.applied_at,
        request.cr_id
      );
    }
  });
  L.audit(actorName(), '审批', 'ecr', id, old,
    { status, impact_analysis: impactAnalysis, verification }, body.note || '变更审批');
  return { ok: true, status, changes: changeItems.length };
});

route('POST', /^\/api\/ecr\/([^/]+)\/apply$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const ecr = q('SELECT * FROM ecr WHERE ecr_id=? AND project_id=?', id, CUR);
  if (!ecr) throw new Error('变更单不存在');
  if (ecr.status === '已实施' && ecr.branch_baseline_id) {
    return { ok: true, status: '已实施', branch_baseline_id: ecr.branch_baseline_id, idempotent: true };
  }
  if (ecr.status !== '已批准') throw new Error('只有已批准变更可以实施');
  // 批准人是已记录的事实，不能被“实施人”覆盖
  const approvedBy = String(ecr.approved_by || '').trim();
  if (!approvedBy) throw Object.assign(
    new Error('变更批准人缺失，无法实施；请重新审批'), { statusCode: 409 }
  );
  const implementedBy = actorName();
  const request = q("SELECT * FROM change_request WHERE source_type='ECR' AND source_id=?", id);
  const changeItems = request
    ? all(`SELECT * FROM change_item WHERE cr_id=? AND change_type='FIELD' ORDER BY ci_id`, request.cr_id) : [];
  const branch = DB.tx(() => {
    // E-01：真正逐项执行结构化变更；旧值不一致时整单回滚，避免“实施”变成空操作。
    const applied = applyEcrChanges(CUR, changeItems);
    if (request) {
      const mark = DB.db.prepare(`UPDATE change_item SET applied_at=?,applied_by=?,applied_result=?
        WHERE ci_id=? AND cr_id=?`);
      for (const item of applied) {
        const link = changeItems.find(row => row.object_type === item.object_type
          && row.object_id === item.object_id && row.field_name === item.field);
        if (link) mark.run(DB.now(), implementedBy, '已执行', link.ci_id, request.cr_id);
      }
      DB.db.prepare(`UPDATE change_request SET status='已实施',applied_at=?,
        approved_by=COALESCE(NULLIF(approved_by,''),?) WHERE cr_id=?`)
        .run(DB.now(), approvedBy, request.cr_id);
    }
    // 下游同步放在冻结基线之前：变更后的 CP/SPC/MSA 状态必须进入“变更后基线”。
    syncProjectDeliverables(CUR);
    DB.db.prepare("UPDATE ecr SET status='已实施' WHERE ecr_id=?").run(id);
    const baseline = DB.freezeBaseline(CUR, `ECR ${id} 实施快照`, `ECR-${id}`,
      implementedBy, `变更后基线；基于原基线 ${ecr.baseline_id || '未指定'}；批准人 ${approvedBy}；已执行 ${applied.length} 项结构化变更`);
    DB.db.prepare('UPDATE ecr SET branch_baseline_id=?,parent_baseline_id=? WHERE ecr_id=? AND project_id=?')
      .run(baseline.id, ecr.baseline_id || null, id, CUR);
    return { ...baseline, applied };
  });
  L.audit(implementedBy, '实施', 'ecr', id, { status: ecr.status },
    { status: '已实施', branch_baseline_id: branch.id, hash: branch.hash,
      applied_changes: branch.applied },
    body.note || '变更实施并生成变更后基线');
  return {
    ok: true, status: '已实施', branch_baseline_id: branch.id, hash: branch.hash,
    applied_changes: branch.applied.length,
  };
});

route('GET', /^\/api\/approvals$/, () => ({
  list: all('SELECT * FROM activity_approval WHERE project_id=? ORDER BY requested_at DESC', CUR),
}));

route('POST', /^\/api\/approvals$/, (m, body) => {
  const id = uniqueId('APR', CUR);
  if (!String(body.action_type || '').trim()) throw new Error('审批动作类型不能为空');
  DB.db.prepare(`INSERT INTO activity_approval(
    approval_id,project_id,action_type,object_type,object_id,title,payload_json,status,
    requested_by,requested_at,approved_by,approved_at,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, CUR, body.action_type, body.object_type || '', body.object_id || '',
    body.title || body.action_type, JSON.stringify(body.payload || {}), '待审批',
    actorName(), DB.now(), '', null, body.note || ''
  );
  L.audit(actorName(), '申请', 'activity_approval', id, null, {
    action_type: body.action_type, object_type: body.object_type, object_id: body.object_id,
  }, '发起活动审批');
  return { ok: true, approval_id: id };
});

route('PATCH', /^\/api\/approvals\/([^/]+)$/, (m, body) => {
  const id = decodeURIComponent(m[1]);
  const old = q('SELECT * FROM activity_approval WHERE approval_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('审批记录不存在');
  const status = body.status === '已批准' ? '已批准' : body.status === '已驳回' ? '已驳回' : '';
  if (!status) throw new Error('审批状态必须为已批准或已驳回');
  if (old.status !== '待审批') {
    throw Object.assign(new Error(`该审批已处于“${old.status}”状态，不能重复处理`), { statusCode: 409 });
  }
  requirePermission('activity.approve', '审批活动');
  assertNotSelfApproval(old.requested_by, '批准');
  const approver = actorName();
  DB.db.prepare(`UPDATE activity_approval SET
    status=?,approved_by=?,approved_at=?,note=COALESCE(NULLIF(?,''),note) WHERE approval_id=?`).run(
    status, approver, DB.now(), body.note || '', id
  );
  L.audit(approver, status, 'activity_approval', id,
    old, { status }, body.note || '活动审批');
  return { ok: true, status };
});

/* ---------------------------------------------------------------- APQP 交付物 */
/* A-19：自动保存快照与人工填写的变更原因必须区分。
   只有真实人工原因才允许提交/批准已发布过的新版本。 */
const AUTO_SAVE_NOTE = '自动保存快照';
const PENDING_CHANGE_NOTE = '变更原因待补充';
function submissionChangeNote(note) {
  const value = String(note || '').trim();
  if (!value || value === PENDING_CHANGE_NOTE || value === '保存交付物') return false;
  if (value === AUTO_SAVE_NOTE || value.startsWith(AUTO_SAVE_NOTE)) return false;
  return true;
}

function docPct(schema, data, code = '') {
  let total = 0, filled = 0;
  for (const sec of schema) {
    for (const f of sec.fields) {
      if (code.startsWith('A-') && f.type === 'table' && f.k === 'items') {
        const rows = Array.isArray(data.items) ? data.items : [];
        total += Math.max(rows.length, 1);
        for (const row of rows) {
          const answer = String(row[2] || '').trim().toUpperCase();
          const no = answer === '否';
          const na = ['不适用', 'NA', 'N/A'].includes(answer);
          const actionComplete = !no || (!!String(row[4] || '').trim()
            && !!String(row[5] || '').trim()
            && /^\d{4}-\d{2}-\d{2}$/.test(String(row[6] || '')));
          if (['是', '否'].includes(answer) || na) {
            if (actionComplete && (!na || String(row[4] || '').trim())) filled += 1;
          }
        }
        continue;
      }
      const v = data[f.k];
      if (f.type === 'table') {
        // A-09：表格按行计分、按单元格比例给分；只填一格不能把整表算满
        const rows = Array.isArray(v)
          ? v.filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''))
          : [];
        if (!rows.length) { total += 1; continue; }
        total += rows.length;
        for (const row of rows) {
          const width = Math.max(1, row.length);
          const nonEmpty = row.filter(cell => String(cell ?? '').trim() !== '').length;
          filled += nonEmpty / width;
        }
        continue;
      }
      total += 1;
      if (v != null && String(v).trim() !== '') filled += 1;
    }
  }
  return total ? Math.round((filled / total) * 100) : 0;
}

/* 审批前的“必填”校验（A-06）：
   不要求 100% 填满（大量字段是“项目适用时”）——但文件身份字段必须齐全，
   且除基本信息/签署外不能整本就是空白，避免 0% 内容也能生成受控版本。
   编制/日期由提交、批准记录本身佐证，不强制重复填写。 */
const IDENTITY_KEYS = ['proj', 'part_no'];
function approvalGaps(schema, data) {
  const gaps = [];
  for (const sec of schema || []) {
    for (const field of sec.fields || []) {
      if (field.type === 'table') continue;
      if (sec.t !== '基本信息' || !IDENTITY_KEYS.includes(field.k)) continue;
      const value = data[field.k];
      if (value == null || String(value).trim() === '') gaps.push(`${sec.t}·${field.label}`);
    }
  }
  const contentSections = (schema || []).filter(sec => sec.t !== '基本信息' && sec.t !== '签署');
  if (contentSections.length) {
    const hasContent = contentSections.some(sec => (sec.fields || []).some(field => {
      const value = data[field.k];
      if (field.type === 'table') {
        return Array.isArray(value) && value.some(row =>
          Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''));
      }
      return value != null && String(value).trim() !== '';
    }));
    if (!hasContent) gaps.push('正文内容（基本信息与签署之外全部为空）');
  }
  return gaps;
}

function checklistData(code, data) {
  const questions = DT.CHECKLIST_QUESTIONS[code];
  if (!questions) return data;
  if (Array.isArray(data.items) && data.items.length) {
    return {
      ...data,
      items: data.items.map(row => {
        const values = Array.isArray(row) ? [...row] : [];
        while (values.length < 9) values.push('');
        return values;
      }),
    };
  }
  return {
    ...data,
    items: questions.map((question, index) => [index + 1, question, '', '', '', '', '', '', '']),
  };
}

function validateChecklistData(code, data) {
  const questions = DT.CHECKLIST_QUESTIONS[code];
  if (!questions) return;
  const rows = Array.isArray(data.items) ? data.items : [];
  if (rows.length < questions.length) throw new Error('检查表标准问题不能删除');
  for (const [index, question] of questions.entries()) {
    const row = rows[index] || [];
    const answer = String(row[2] || '').trim().toUpperCase();
    if (!['是', '否', '不适用', 'NA', 'N/A'].includes(answer)) {
      throw new Error(`第 ${index + 1} 项“${question}”必须选择是、否或不适用`);
    }
    if (answer === '否') {
      const due = String(row[6] || '').trim();
      if (!String(row[4] || '').trim() || !String(row[5] || '').trim()
          || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due))) {
        throw new Error(`第 ${index + 1} 项为否，必须填写措施、责任人和计划完成日期`);
      }
    }
    if (['不适用', 'NA', 'N/A'].includes(answer) && !String(row[4] || '').trim()) {
      throw new Error(`第 ${index + 1} 项不适用时必须填写理由`);
    }
  }
}

function effectiveDocStatus(code, row, data) {
  const status = row?.status || '未开始';
  if (code === 'P5-04' && status === '已完成'
      && !(Array.isArray(data?.lessons) && data.lessons.some(entry =>
        Array.isArray(entry) && entry.some(value => String(value || '').trim())))) {
    return '草稿';
  }
  return status;
}

function programMetricRows(projectId) {
  const docs = all('SELECT * FROM project_doc WHERE project_id=? AND COALESCE(hidden,0)=0', projectId);
  const docMap = new Map(docs.map(row => [row.doc_code, row]));
  const plans = all('SELECT * FROM control_plan WHERE project_id=?', projectId);
  const tasks = all('SELECT * FROM apqp_task WHERE project_id=?', projectId);
  const msaPlans = DB.listMsaPlans(projectId).filter(plan => plan.source_active !== 0);
  const monitors = all(`SELECT m.* FROM monitoring_item m JOIN cp_row r ON r.cp_row_id=m.cp_row_id
    JOIN control_plan cp ON cp.cp_id=r.cp_id
    WHERE cp.project_id=? AND m.status='启用' AND m.approval_status='已批准'`, projectId);
  const ppapWorkflow = ppapWorkflowRows(projectId);
  const ppapElements = effectivePpapElements(projectId, ppapWorkflow)
    .filter(item => item.required !== 0);
  const workflowByPpapNo = new Map(ppapWorkflow.map(item => [item.no, item]));
  const fmeaHeader = type => q('SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?', projectId, type);
  const metricFor = meta => {
    const row = docMap.get(meta.code);
    let data = {};
    try { data = JSON.parse(row?.data_json || '{}'); } catch {}
    let status = effectiveDocStatus(meta.code, row, data);
    let detail = '';
    let health;
    if (meta.module === 'pfd') {
      const steps = all("SELECT status FROM process_step WHERE project_id=? AND pfd_mode=? AND COALESCE(status,'')<>'作废'",
        projectId, pfdMode(meta.arg));
      const published = steps.filter(step => step.status === '已发布').length;
      status = !steps.length ? '未开始' : published === steps.length ? '已发布' : '进行中';
      detail = `${steps.length} 道有效工序，${published} 道已发布`;
    } else if (meta.module === 'fmea') {
      const header = fmeaHeader(meta.arg);
      status = header?.status || '未开始';
      detail = header ? `${header.rev || 'r1'} · ${header.status}` : '尚未创建分析';
    } else if (meta.module === 'cp') {
      const cp = plans.find(item => item.stage === meta.arg);
      status = cp?.status || '未开始';
      detail = cp ? `${cp.rev || 'r1'} · ${cp.status}` : '尚未建立控制计划';
    } else if (meta.module === 'msa') {
      const complete = msaPlans.filter(plan => plan.status === '已完成'
        && plan.study_judgment === '接受' && plan.study_status === '已完成'
        && plan.source_status === '有效').length;
      status = !msaPlans.length ? '未开始' : complete === msaPlans.length ? '已完成' : '进行中';
      detail = `有效计划 ${msaPlans.length} 项，已完成并接受 ${complete} 项`;
    } else if (meta.module === 'spc') {
      const withData = monitors.filter(monitor =>
        q('SELECT 1 FROM spc_dataset WHERE mon_id=? LIMIT 1', monitor.mon_id)).length;
      status = !monitors.length ? '未开始' : withData === monitors.length ? '已完成' : '进行中';
      detail = `已批准监控 ${monitors.length} 项，有生产数据 ${withData} 项`;
    } else if (meta.module === 'ppap') {
      const ready = ppapElements.filter(item => item.status === '已完成'
        && (!workflowByPpapNo.get(item.element_no)?.sourceType
          || workflowByPpapNo.get(item.element_no)?.linked_ready)).length;
      status = !ppapElements.length ? '未开始' : ready === ppapElements.length ? '已完成' : '进行中';
      detail = `适用项 ${ppapElements.length} 项，证据就绪 ${ready} 项`;
    } else if (meta.kind === 'form') {
      const schema = docSchema(meta.code, meta);
      detail = row ? `完成度 ${docPct(schema, data, meta.code)}%` : '尚未填写';
    }
    if (['已批准', '已完成', '已发布', '已冻结'].includes(status)) health = 'green';
    else if (['草稿', '待审核', '进行中', '已退回'].includes(status)) health = 'yellow';
    else health = 'red';
    const exactTasks = tasks.filter(task => String(task.deliverable || '').trim() === meta.code);
    const overdue = exactTasks.some(task => task.status !== '已完成' && task.due && task.due < DB.now().slice(0, 10));
    if (overdue && health !== 'green') health = 'red';
    if (exactTasks.length) {
      const completed = exactTasks.filter(task => task.status === '已完成').length;
      detail += `${detail ? '；' : ''}任务 ${completed}/${exactTasks.length}`;
    }
    return {
      code: meta.code,
      name: row?.custom_name || meta.name,
      phase: meta.phase,
      owner: meta.owner || '',
      kind: meta.kind,
      module: meta.module || null,
      arg: meta.arg || null,
      status,
      health,
      overdue,
      detail,
    };
  };
  return DT.CATALOG.filter(item => item.group !== 'input').map(metricFor);
}

function summarizeProgramMetrics(projectId, items) {
  const summary = {
    total: items.length,
    red: items.filter(item => item.health === 'red').length,
    yellow: items.filter(item => item.health === 'yellow').length,
    green: items.filter(item => item.health === 'green').length,
    overdue: items.filter(item => item.overdue).length,
  };
  const chars = all(`SELECT char_kind,is_special FROM project_char
    WHERE project_id=? AND COALESCE(status,'生效')<>'作废'`, projectId);
  summary.specialProductChars = chars.filter(item => item.is_special && item.char_kind === 'PRODUCT').length;
  summary.specialProcessChars = chars.filter(item => item.is_special && item.char_kind === 'PROCESS').length;
  return summary;
}

route('GET', /^\/api\/program-metrics$/, () => {
  const items = programMetricRows(CUR);
  return { items, summary: summarizeProgramMetrics(CUR, items) };
});

function docSchema(code, meta) {
  if (meta && meta.kind === 'module') return null;
  if (DT.T[code]) return DT.T[code];
  if (meta && meta.group === 'checklist') return DT.T.CHK_1;
  return DT.GENERIC();
}

route('GET', /^\/api\/docs$/, () => {
  const rows = all('SELECT * FROM project_doc WHERE project_id=?', CUR);
  const map = new Map(rows.map(r => [r.doc_code, r]));
  const phases = DT.PHASES.map(p => ({ no: p.no, name: p.name, short: p.short, docs: [] }));
  const byNo = new Map(phases.map(p => [p.no, p]));

  for (const d of DT.CATALOG) {
    const r = map.get(d.code) || {};
    const schema = DT.T[d.code] || DT.GENERIC();
    let data = {};
    try { data = JSON.parse(r.data_json || '{}'); } catch (e) { data = {}; }
    const isModule = d.kind === 'module';
    let status = isModule ? (r.status || '系统模块') : effectiveDocStatus(d.code, r, data);
    let pfdPublished = 0;
    let pfdTotal = 0;
    if (d.module === 'pfd') {
      const mode = d.arg === 'INITIAL' ? 'INITIAL' : 'PROCESS';
      const steps = all(`SELECT status FROM process_step
        WHERE project_id=? AND pfd_mode=? AND COALESCE(status,'')<>'作废'`, CUR, mode);
      pfdTotal = steps.length;
      pfdPublished = steps.filter(step => step.status === '已发布').length;
      status = !pfdTotal ? '未开始' : pfdPublished === pfdTotal ? '已发布' : '进行中';
    }
    const doc = {
      code: d.code, name: d.name, group: d.group, kind: d.kind,
      fmt: d.fmt || (isModule ? 'module' : 'none'),
      owner: d.owner, desc: d.desc,
      module: d.module || null, arg: d.arg || null,
      up: d.up || [], down: d.down || [],
      status, updated_at: r.updated_at || null, updated_by: r.updated_by || null,
      pct: isModule
        ? (d.module === 'pfd' && !['已发布', '未开始'].includes(status)
          ? Math.round((pfdPublished / Math.max(1, pfdTotal)) * 100)
          : (status === '未开始' ? 0 : 100))
        : d.module === 'pfd'
          ? (status === '未开始' ? 0
            : status === '已发布' ? 100 : Math.round((pfdPublished / Math.max(1, pfdTotal)) * 100))
        : (d.kind === 'none' ? (status === '已完成' ? 100 : 0) : docPct(schema, data, d.code)),
    };
    const ph = byNo.get(d.phase);
    if (ph) ph.docs.push(doc);
  }

  // 用户上传的自定义模板
  const tpls = all(`SELECT * FROM doc_template
    WHERE project_id=? OR project_id IS NULL ORDER BY created_at DESC`, CUR);
  for (const t of tpls) {
    if (t.doc_code && DT.CATALOG.some(item => item.code === t.doc_code)) {
      continue;
    }
    const ph = byNo.get(Math.max(0, Math.min(5, t.phase == null ? 1 : t.phase))) || phases[1];
    ph.docs.push({
      code: t.doc_code || t.tpl_id, tplId: t.tpl_id, name: t.name,
      group: /检查表/.test(t.name || '') ? 'checklist' : 'output', kind: 'form', fmt: 'tpl',
      owner: t.created_by, desc: `自定义模板 · ${String(t.source).toUpperCase()}${t.filename ? ' · ' + t.filename : ''}`,
      status: t.status, updated_at: t.updated_at, pct: t.pct, isTpl: true, up: [], down: [],
    });
  }


  // 应用改名 / 隐藏 / 模板绑定
  const metaRows = new Map(all('SELECT doc_code, custom_name, hidden FROM project_doc WHERE project_id=?', CUR).map(r => [r.doc_code, r]));
  const tplByCode = new Map(all(`SELECT doc_code, tpl_id, name, status, pct FROM doc_template
    WHERE doc_code IS NOT NULL AND (project_id=? OR project_id IS NULL)
    ORDER BY updated_at ASC,rowid ASC`, CUR)
    .map(r => [r.doc_code, r]));
  for (const p of phases) {
    p.docs = p.docs.filter(x => {
      const o = metaRows.get(x.code);
      if (o && o.hidden) return false;
      if (o && o.custom_name) x.name = o.custom_name;
      const tpl = tplByCode.get(x.code);
      if (tpl) {
        // A-05：绑定模板的交付物状态与完成度以模板为准，避免两套口径
        x.tplId = tpl.tpl_id;
        x.tpl_status = tpl.status;
        x.status = tpl.status;
        x.pct = tpl.pct;
      }
      return true;
    });
  }

  // A-16 / S-13：完成度只统计“表单类交付物且已批准/已完成”；
  // 系统模块只是导航入口，活动项只是勾选记录，都不能冒充“受控文件已完成”。
  const countable = doc => doc.kind === 'form' && doc.group !== 'input';
  for (const p of phases) {
    p.outputs = p.docs.filter(d => d.group === 'output' || d.group === 'activity' || d.group === 'checklist');
    p.total = p.docs.filter(countable).length;
    p.done = p.docs.filter(d => countable(d) && ['已完成', '已批准'].includes(d.status)).length;
    p.pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  }
  const allDocs = phases.flatMap(p => p.docs);
  const formDocs = allDocs.filter(countable);
  return {
    phases,
    summary: {
      total: allDocs.length,
      formTotal: formDocs.length,
      done: formDocs.filter(d => ['已完成', '已批准'].includes(d.status)).length,
      drafting: formDocs.filter(d => ['草稿', '待审核'].includes(d.status)).length,
      form: allDocs.filter(d => d.fmt !== 'module' && d.fmt !== 'none').length,
      module: allDocs.filter(d => d.fmt === 'module').length,
      input: allDocs.filter(d => d.group === 'input').length,
      activity: allDocs.filter(d => d.group === 'activity').length,
      checklist: allDocs.filter(d => d.group === 'checklist').length,
    },
  };
});

/* ---------------------------------------------------------------- 交付物附件
 * 包装图片（P3-02）、工程图预览与 CAD 源文件（P2-06）。
 * 元数据进 doc_attachment，二进制落 ATTACHMENT_DIR；不写 public/，统一经鉴权路由回传。
 */
const ATTACHMENT_CATEGORIES = {
  packaging: {
    label: '包装图片',
    maxBytes: 8 * 1024 * 1024,
    types: {
      png: 'image/png', jpeg: 'image/jpeg', pdf: 'application/pdf',
    },
  },
  'drawing-preview': {
    label: '图纸预览',
    maxBytes: 8 * 1024 * 1024,
    types: {
      png: 'image/png', jpeg: 'image/jpeg', pdf: 'application/pdf',
    },
  },
  'drawing-source': {
    label: 'CAD 源文件',
    maxBytes: 20 * 1024 * 1024,
    types: {
      dwg: 'application/acad', dxf: 'image/vnd.dxf', step: 'application/step',
      stp: 'application/step', igs: 'model/iges', iges: 'model/iges', zip: 'application/zip',
    },
  },
};

function attachmentCategory(value) {
  const key = String(value || '').trim();
  const def = ATTACHMENT_CATEGORIES[key];
  if (!def) throw new Error('附件类型无效');
  return { key, ...def };
}

/** 只按文件头判类型，不信任扩展名与客户端声明的 MIME */
function sniffBinary(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  // ASCII CAD 文件（DXF / STEP / IGES）：按内容首行识别
  const head = buf.slice(0, 2048).toString('latin1');
  if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(head) || /^AutoCAD Binary DXF/i.test(head)) return 'dxf';
  if (/^\s*ISO-10303-21\s*;/i.test(head)) return 'step';
  if (/^\s*(?:IGES|S\s{6,}\d)|\bIGES\b/i.test(head) && /^.{0,80}(?:IGES|START)/is.test(head)) return 'iges';
  if (/^AC10\d{2}/.test(head)) return 'dwg';
  return null;
}

function attachmentSafeName(name, fallbackExt) {
  const base = path.basename(String(name || `attachment.${fallbackExt}`))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 120);
  return base || `attachment.${fallbackExt}`;
}

function attachmentDocStatus(code, projectId = CUR) {
  const row = q('SELECT status FROM project_doc WHERE doc_code=? AND project_id=?', code, projectId);
  return row ? (row.status || '未开始') : '未开始';
}

function assertAttachmentEditable(code) {
  const status = attachmentDocStatus(code);
  if (['待审核', '已批准', '已完成'].includes(status)) {
    throw Object.assign(
      new Error(`交付物当前为“${status}”，不能增删附件；请先发起修订`),
      { statusCode: 409, details: { doc_code: code, status } },
    );
  }
}

function attachmentRows(code, category, { includeVoided = false } = {}) {
  const filters = ['project_id=?', 'doc_code=?'];
  const values = [CUR, code];
  if (category) { filters.push('category=?'); values.push(category); }
  if (!includeVoided) filters.push("COALESCE(status,'有效')='有效'");
  return all(`SELECT attachment_id,project_id,doc_code,category,caption,group_label,file_name,mime,
      size,sha256,sort_order,status,created_by,created_at,voided_by,voided_at
    FROM doc_attachment WHERE ${filters.join(' AND ')}
    ORDER BY sort_order, created_at, attachment_id`, ...values).map(row => {
    // <img src> / <embed src> / <a download> 不经过前端 api()，不会自动带项目参数；
    // 缺少 ?p= 时服务端按默认项目解析，非默认项目的附件会一律 404（表现为预览空白/无法识别）。
    const fileUrl = `/api/attachments/${encodeURIComponent(row.attachment_id)}/file`
      + `?p=${encodeURIComponent(CUR)}`;
    return {
      ...row,
      url: fileUrl,
      download_url: `${fileUrl}&download=1`,
      is_pdf: row.mime === 'application/pdf',
      is_image: ['image/png', 'image/jpeg'].includes(row.mime),
    };
  });
}

route('GET', /^\/api\/attachments$/, (m, body, query) => {
  const code = String(query.get('doc') || '').trim();
  if (!code) throw new Error('请指定交付物编号');
  const category = query.get('category') ? attachmentCategory(query.get('category')).key : '';
  return {
    list: attachmentRows(code, category, { includeVoided: query.get('include_voided') === '1' }),
    doc_status: attachmentDocStatus(code),
    categories: Object.entries(ATTACHMENT_CATEGORIES).map(([key, def]) => ({
      key, label: def.label, max_bytes: def.maxBytes, types: Object.keys(def.types),
    })),
  };
});

route('POST', /^\/api\/attachments$/, (m, body) => DB.tx(() => {
  const code = String(body.doc_code || '').trim();
  if (!code) throw new Error('请指定交付物编号');
  const meta = DT.CATALOG.find(item => item.code === code);
  if (!meta) throw new Error('交付物不存在：' + code);
  assertDocEditable(code);
  assertAttachmentEditable(code);
  const category = attachmentCategory(body.category);
  const raw = String(body.dataBase64 || '');
  if (!raw) throw new Error('缺少文件内容');
  const buf = Buffer.from(raw.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) throw new Error('文件为空');
  if (buf.length > category.maxBytes) {
    throw new Error(`文件超过 ${Math.round(category.maxBytes / 1024 / 1024)} MB`);
  }
  const sniffed = sniffBinary(buf);
  if (!sniffed || !category.types[sniffed]) {
    throw new Error(`${category.label}只接受 ${Object.keys(category.types).map(t => t.toUpperCase()).join(' / ')}，当前文件类型不符`);
  }
  const existing = attachmentRows(code, category.key, { includeVoided: true });
  if (existing.length >= 40) throw new Error('单个交付物的附件已达上限 40 个，请先作废旧附件');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (existing.some(item => item.sha256 === sha256 && item.status !== '作废')) {
    throw new Error('相同文件已存在，无需重复上传');
  }
  const id = uniqueId('ATT', `${code}-${category.key}`);
  const safeName = attachmentSafeName(body.file_name, sniffed);
  const projectDir = path.join(ATTACHMENT_DIR, String(CUR).replace(/[^A-Za-z0-9._-]/g, '_'));
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  const storedName = `${id}-${safeName}`;
  fs.writeFileSync(path.join(projectDir, storedName), buf);
  const sortOrder = existing.reduce((max, item) => Math.max(max, Number(item.sort_order) || 0), 0) + 10;
  DB.db.prepare(`INSERT INTO doc_attachment(
    attachment_id,project_id,doc_code,category,caption,group_label,
    file_name,mime,size,sha256,storage_path,sort_order,status,created_by,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, CUR, code, category.key, String(body.caption || '').trim().slice(0, 200),
    String(body.group_label || '').trim().slice(0, 40), safeName, category.types[sniffed],
    buf.length, sha256, path.join(projectDir, storedName), sortOrder, '有效', actorName(), DB.now(),
  );
  L.audit(actorName(), '上传附件', 'doc_attachment', id, null,
    { doc_code: code, category: category.key, file_name: safeName, size: buf.length, sha256 },
    `${meta.name} · ${category.label}`);
  return { ok: true, item: attachmentRows(code, category.key, { includeVoided: true })
    .find(item => item.attachment_id === id) };
}));

route('PATCH', /^\/api\/attachments\/([^/]+)$/, (m, body) => DB.tx(() => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM doc_attachment WHERE attachment_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('附件不存在');
  assertDocEditable(old.doc_code);
  assertAttachmentEditable(old.doc_code);
  const next = {
    caption: body.caption !== undefined ? String(body.caption).trim().slice(0, 200) : old.caption,
    group_label: body.group_label !== undefined ? String(body.group_label).trim().slice(0, 40) : old.group_label,
    sort_order: body.sort_order !== undefined && Number.isFinite(+body.sort_order) ? +body.sort_order : old.sort_order,
  };
  DB.db.prepare('UPDATE doc_attachment SET caption=?,group_label=?,sort_order=? WHERE attachment_id=? AND project_id=?')
    .run(next.caption, next.group_label, next.sort_order, id, CUR);
  L.audit(actorName(), '修改附件', 'doc_attachment', id, old, next, '附件说明/分类调整');
  return { ok: true, item: attachmentRows(old.doc_code, old.category, { includeVoided: true })
    .find(item => item.attachment_id === id) };
}));

route('POST', /^\/api\/attachments\/([^/]+)\/void$/, (m, body) => DB.tx(() => {
  const id = decodePart(m[1]);
  const old = q('SELECT * FROM doc_attachment WHERE attachment_id=? AND project_id=?', id, CUR);
  if (!old) throw new Error('附件不存在');
  if (old.status === '作废') return { ok: true, status: '作废' };
  assertDocEditable(old.doc_code);
  assertAttachmentEditable(old.doc_code);
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw new Error('作废附件必须填写不少于 4 个字的原因');
  DB.db.prepare(`UPDATE doc_attachment SET status='作废',voided_by=?,voided_at=? WHERE attachment_id=? AND project_id=?`)
    .run(actorName(), DB.now(), id, CUR);
  L.audit(actorName(), '作废附件', 'doc_attachment', id, old,
    { status: '作废', reason }, reason);
  return { ok: true, status: '作废' };
}));

route('GET', /^\/api\/attachments\/([^/]+)\/file$/, (m, body, query) => {
  const id = decodePart(m[1]);
  const row = q('SELECT * FROM doc_attachment WHERE attachment_id=? AND project_id=?', id, CUR);
  if (!row) throw Object.assign(new Error('附件不存在或不属于当前项目'), { statusCode: 404 });
  if (!row.storage_path || !fs.existsSync(row.storage_path)) {
    throw Object.assign(new Error('附件文件已丢失，请重新上传'), { statusCode: 410 });
  }
  return {
    __binary: true,
    file: row.storage_path,
    mime: row.mime || 'application/octet-stream',
    filename: row.file_name || 'attachment',
    download: query.get('download') === '1',
  };
});

route('GET', /^\/api\/docs\/([^/]+)$/, (m) => {
  const code = m[1];
  const meta = DT.CATALOG.find(d => d.code === code);
  if (!meta) throw new Error('交付物不存在：' + code);
  const schema = docSchema(code, meta);
  if (!schema) throw new Error(meta.desc || '该交付物由系统模块承载，请进入对应模块');  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR) || {};
  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch (e) { data = {}; }
  data = fillCharacteristicTypes(code, data);
  data = checklistData(code, data);
  let savedCols = {};
  try { savedCols = JSON.parse(row.cols_json || '{}'); } catch {}
  const latestChange = q(`SELECT change_note,changed_by,changed_at FROM project_doc_revision
    WHERE project_id=? AND doc_code=? AND data_json=? ORDER BY rowid DESC LIMIT 1`,
  CUR, code, row.data_json || '{}');
  const project = q('SELECT name,part_no FROM project WHERE project_id=?', CUR) || {};
  data = { ...data };
  if (!String(data.proj || '').trim()) data.proj = project.name || '';
  if (!String(data.part_no || '').trim()) data.part_no = project.part_no || '';
  // 补齐表格默认行
  const view = schema.map(sec => ({
    t: sec.t, note: sec.note,
    fields: sec.fields.map(f => {
      const cols = f.type === 'table' && DT.CHECKLIST_QUESTIONS[code]
        ? f.cols
        : f.type === 'table' && savedCols[f.k] ? savedCols[f.k] : f.cols;
      return {
        ...f,
        protected_cols: f.type === 'table'
          ? (DT.T[code] || []).flatMap(section => section.fields || []).find(field => field.k === f.k)?.cols?.length || 0
          : undefined,
        cols,
        guide: FG.forField(code, sec.t, f),
        col_guides: f.type === 'table'
          ? (cols || []).map((label, index) => FG.forColumn(code, sec.t, f, label, index))
          : [],
        value: f.type === 'table'
          ? (Array.isArray(data[f.k]) && data[f.k].length ? data[f.k] : [Array((f.cols || []).length).fill('')])
          : (data[f.k] ?? ''),
      };
    }),
  }));
  // 编制归属与当前账号的可编辑/可审批随详情下发：前端据此提示与隐藏按钮
  const ownerRoles = [...PM.rolesForOwner(meta.owner)].map(role => ROLE_NAMES[role] || role);
  const sessionUserRow = requestContext.getStore()?.user;
  const canEdit = !!sessionUserRow && PM.canEditDoc(sessionUserRow.role, sessionUserRow.flags, meta.owner);
  const boardOk = !!sessionUserRow && PM.boardAllows(sessionUserRow.role, meta.owner);
  return {
    meta: {
      ...meta, ownerRoles,
      can_edit: canEdit,
      can_approve: boardOk && !!sessionUserRow && PM.canUser(sessionUserRow, 'doc.approve'),
      can_complete: boardOk && !!sessionUserRow && PM.canUser(sessionUserRow, 'doc.complete'),
    },
    phaseName: (DT.PHASES[meta.phase] || {}).name || '未归类阶段', sections: view, data,
    status: effectiveDocStatus(code, row, data), updated_at: row.updated_at, version: row.version || 'V1.0',
    lock_token: row.lock_token || '', published_version: row.published_version || '',
    change_note: latestChange?.change_note || '', changed_by: latestChange?.changed_by || '',
    changed_at: latestChange?.changed_at || null,
    pct: docPct(schema, data, code),
  };
});

route('PUT', /^\/api\/docs\/([^/]+)$/, (m, body) => DB.tx(() => {
  const code = m[1];
  const meta = DT.CATALOG.find(d => d.code === code);
  if (!meta) throw new Error('交付物不存在');
  // 交付物按目录 owner 归属授权：只有对应岗位可编制（admin 兜底）
  assertDocEditable(code);
  const schema = docSchema(code, meta);
  if (!schema) throw new Error(meta.desc || '该交付物由系统模块承载，请进入对应模块');
  const old = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR) || {};
  // A-03 乐观锁：客户端带回打开时的令牌，与库不一致说明其他会话已保存过
  const baseLockToken = String(body.base_lock_token || '').trim();
  if (old.doc_code && baseLockToken && old.lock_token && baseLockToken !== old.lock_token) {
    throw Object.assign(
      new Error('该交付物已被其他会话修改，本次保存未写入；请刷新后重新编辑'),
      { statusCode: 409 }
    );
  }
  const previous = JSON.parse(old.data_json || '{}');
  const data = fillCharacteristicTypes(code, normalizeDocumentRows(body.data || {}, schema, previous));
  validateDocumentColumns(code, body.cols || JSON.parse(old.cols_json || '{}'));
  const pct = docPct(schema || [], data, code);
  // 活动/检查表类条目（kind='none'）允许直接勾选完成；正式交付物必须走 submit / approve / complete
  const activityMark = meta.kind === 'none' && !!body.activity_mark;
  // 保存接口只能在“未开始/草稿”之间切换；待审核、已批准、已完成必须走专用接口
  for (const gated of ['待审核', '已批准', '已完成']) {
    if (body.status !== gated || old.status === gated) continue;
    if (gated === '已完成' && activityMark) continue;
    throw Object.assign(
      new Error(`${gated}状态不能通过保存接口设置，请使用“提交审核 / 批准 / 标记完成”操作`),
      { statusCode: 409 }
    );
  }
  const settableStatus = activityMark ? ['未开始', '草稿', '已完成'] : ['未开始', '草稿'];
  let status;
  if (settableStatus.includes(body.status)) status = body.status;
  else status = old.doc_code ? (old.status || '未开始') : (pct > 0 ? '草稿' : '未开始');
  const colsJson = body.cols ? JSON.stringify(body.cols) : null;
  const version = body.version || old.version || 'V1.0';
  const lockToken = crypto.randomUUID();
  const newDataJson = JSON.stringify(data);
  const contentChanged = !!old.doc_code && (
    old.data_json !== newDataJson || (colsJson && old.cols_json !== colsJson)
  );
  const changeNote = String(body.change_note || '').trim();
  if (contentChanged && old.published_version
      && ['待审核', '已批准', '已完成'].includes(old.status) && !changeNote) {
    throw new Error('修改已批准交付物必须填写本次内容变更原因');
  }
  const pendingChangeReason = PENDING_CHANGE_NOTE;
  const latestRevision = old.doc_code ? q(`SELECT data_json,change_note FROM project_doc_revision
    WHERE project_id=? AND doc_code=? ORDER BY rowid DESC LIMIT 1`, CUR, code) : null;
  const changeNoteNeedsUpdate = !!changeNote && latestRevision?.data_json === newDataJson
    && [pendingChangeReason, AUTO_SAVE_NOTE].includes(latestRevision.change_note);
  if (contentChanged && ['待审核', '已批准', '已完成'].includes(old.status)) {
    status = '草稿';
  }
  const savedAt = DB.now();
  if (old.doc_code) {
    DB.db.prepare(`UPDATE project_doc SET
      status=?,data_json=?,updated_at=?,updated_by=?,version=?,cols_json=COALESCE(?,cols_json),
      approved_by=?,approved_at=?,rejected_reason=NULL,lock_token=?
      WHERE doc_code=? AND project_id=?`).run(
      status, newDataJson, savedAt, actorName(), version,
      colsJson, status === '已批准' ? (old.approved_by || '') : '',
      status === '已批准' ? (old.approved_at || savedAt) : null, lockToken, code, CUR
    );
  } else {
    DB.db.prepare(`INSERT INTO project_doc(
      doc_code,project_id,status,owner,data_json,updated_at,updated_by,version,cols_json,lock_token
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(code, CUR, status, meta.owner, newDataJson, savedAt, actorName(), version, colsJson, lockToken);
  }
  const changed = !old.doc_code || contentChanged
    || (colsJson && old.cols_json !== colsJson) || old.status !== status || old.version !== version
    || changeNoteNeedsUpdate;
  if (changed) {
    DB.db.prepare(`INSERT INTO project_doc_revision(
      rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,
      change_note,approved_by,approved_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uniqueId('REV', `${code}-${version}`), code, CUR, version, status,
      newDataJson, colsJson || old.cols_json || null, actorName(),
      DB.now(), contentChanged
        // A-19：不写“变更原因待补充”这类占位；自动快照有独立标记，提交前必须补真实原因
        ? (changeNote || (old.published_version ? AUTO_SAVE_NOTE : '首次编制'))
        : changeNote || body.change_note || AUTO_SAVE_NOTE,
      status === '已批准' ? (old.approved_by || null) : null,
      status === '已批准' ? (old.approved_at || DB.now()) : null
    );
  }
  L.audit(actorName(), '修改', 'project_doc', code, old,
    { status, pct, version }, body.change_note || '编辑 APQP 交付物');
  const sync = syncProjectDeliverables(CUR);
  return { ok: true, status, pct, version, updated_at: savedAt, lock_token: lockToken, sync };
}));

route('POST', /^\/api\/docs\/(?!batch\/)([^/]+)\/submit$/, (m, body) => {
  const code = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  if (!row) throw new Error('交付物不存在');
  assertDocEditable(code);
  if (!['草稿', '未开始', '已退回'].includes(row.status)) throw new Error('只有草稿可以提交审核');
  const latestContent = q(`SELECT change_note FROM project_doc_revision
    WHERE project_id=? AND doc_code=? AND data_json=? ORDER BY rowid DESC LIMIT 1`,
  CUR, code, row.data_json);
  if (row.published_version && !submissionChangeNote(latestContent?.change_note)) {
    throw new Error('提交前必须填写本次内容变更原因');
  }
  if (DT.CHECKLIST_QUESTIONS[code]) {
    validateChecklistData(code, checklistData(code, JSON.parse(row.data_json || '{}')));
  }
  // 提交同样轮换乐观锁令牌：提交前发出的在途保存不能再把文档拉回草稿
  DB.db.prepare(`UPDATE project_doc SET
    status='待审核',submitted_by=?,submitted_at=?,rejected_reason=NULL,lock_token=?
    WHERE doc_code=? AND project_id=?`).run(
    actorName(), DB.now(), crypto.randomUUID(), code, CUR
  );
  L.audit(actorName(), '提交审核', 'project_doc', code,
    { status: row.status }, { status: '待审核' }, body.note || '提交交付物审核');
  return { ok: true, status: '待审核' };
});

route('POST', /^\/api\/docs\/([^/]+)\/approve$/, (m, body) => DB.tx(() => {
  const code = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  if (!row) throw new Error('交付物不存在');
  if (row.status !== '待审核') {
    throw Object.assign(new Error('只有待审核交付物可以批准'), { statusCode: 409 });
  }
  requirePermission('doc.approve', '批准交付物');
  assertDocApprovable(code);
  assertNotSelfApproval(row.submitted_by || row.updated_by, '批准');
  const approver = actorName();
  const docMeta = DT.CATALOG.find(item => item.code === code);
  const approveSchema = docSchema(code, docMeta);
  if (approveSchema && docMeta && docMeta.kind !== 'none') {
    let approveData = {};
    try { approveData = JSON.parse(row.data_json || '{}'); } catch (e) { approveData = {}; }
    // 与页面一致：项目名称/零件号取自项目主数据，纸质表单里不需要重复录入
    const projIdentity = q('SELECT name,part_no FROM project WHERE project_id=?', CUR) || {};
    if (!String(approveData.proj || '').trim()) approveData.proj = projIdentity.name || '';
    if (!String(approveData.part_no || '').trim()) approveData.part_no = projIdentity.part_no || '';
    const approveFilled = fillCharacteristicTypes(code,
      normalizeDocumentRows(approveData, approveSchema));
    const gaps = approvalGaps(approveSchema, approveFilled);
    if (gaps.length) {
      throw Object.assign(
        new Error(`交付物缺少必需内容，不能批准：${gaps.slice(0, 6).join('、')}`),
        { statusCode: 409, details: { missing: gaps } }
      );
    }
  }
  const latestContent = q(`SELECT change_note FROM project_doc_revision
    WHERE project_id=? AND doc_code=? AND data_json=? ORDER BY rowid DESC LIMIT 1`,
  CUR, code, row.data_json);
  if (row.published_version && !submissionChangeNote(latestContent?.change_note)) {
    throw new Error('批准前必须补齐本次内容变更原因');
  }
  if (DT.CHECKLIST_QUESTIONS[code]) {
    validateChecklistData(code, checklistData(code, JSON.parse(row.data_json || '{}')));
  }
  validateDocumentColumns(code, JSON.parse(row.cols_json || '{}'));
  const data = fillCharacteristicTypes(code, normalizeDocumentRows(JSON.parse(row.data_json || '{}'), docSchema(code,
    DT.CATALOG.find(item => item.code === code))));
  if (code === 'P1-16') {
    const items = programMetricRows(CUR).map(item => item.code === 'P1-16'
      ? { ...item, status: '已批准', health: 'green', overdue: false }
      : item);
    data._programMetricsSnapshot = {
      captured_at: DB.now(),
      approved_by: approver,
      items,
      summary: summarizeProgramMetrics(CUR, items),
    };
  }
  const oldVersion = row.version || 'V1.0';
  const match = /^V?(\d+)\.(\d+)$/i.exec(oldVersion);
  const version = match ? `V${match[1]}.${+match[2] + 1}` : 'V1.1';
  // 批准即更换乐观锁令牌：审批前发出的在途保存会得到 409，不能再把状态改回草稿
  DB.db.prepare(`UPDATE project_doc SET
    status='已批准',approved_by=?,approved_at=?,version=?,published_version=?,data_json=?,lock_token=?
    WHERE doc_code=? AND project_id=?`).run(
    approver, DB.now(), version, version, JSON.stringify(data), crypto.randomUUID(), code, CUR
  );
  DB.db.prepare(`INSERT INTO project_doc_revision(
    rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,
    change_note,approved_by,approved_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uniqueId('REV', `${code}-${version}`), code, CUR, version, '已批准',
    JSON.stringify(data), row.cols_json, approver, DB.now(),
    body.note || '审核批准', approver, DB.now()
  );
  L.audit(approver, '批准', 'project_doc', code,
    { status: row.status, version: oldVersion }, { status: '已批准', version },
    body.note || '交付物审批');
  const beforeSteps = code === 'P1-10'
    ? q("SELECT COUNT(*) n FROM process_step WHERE project_id=? AND pfd_mode='INITIAL'", CUR).n : 0;
  const sync = syncProjectDeliverables(CUR);
  const pfdSync = code === 'P1-10' ? {
    added: q("SELECT COUNT(*) n FROM process_step WHERE project_id=? AND pfd_mode='INITIAL'", CUR).n - beforeSteps,
    skipped: DS.list(CUR).items.filter(item => item.source.docCode === 'P1-10'
      && ['review_required', 'conflict'].includes(item.state)).length,
  } : null;
  return { ok: true, status: '已批准', version, sync, ...(pfdSync ? { pfd_sync: pfdSync } : {}) };
}));

route('POST', /^\/api\/docs\/([^/]+)\/reject$/, (m, body) => {
  const code = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  if (!row) throw new Error('交付物不存在');
  if (row.status !== '待审核') {
    throw Object.assign(new Error('只有待审核交付物可以退回'), { statusCode: 409 });
  }
  requirePermission('doc.approve', '退回交付物');
  assertDocApprovable(code);
  const reason = String(body.reason || '').trim();
  if (!reason) throw new Error('退回原因不能为空');
  DB.db.prepare(`UPDATE project_doc SET
    status='草稿',rejected_reason=?,approved_by='',approved_at=NULL,lock_token=?
    WHERE doc_code=? AND project_id=?`).run(reason, crypto.randomUUID(), code, CUR);
  // A-08：退回也是一次受控历史事件，必须留下快照与原因，便于事后追溯
  DB.db.prepare(`INSERT INTO project_doc_revision(
    rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,change_note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    uniqueId('REV', `${code}-reject`), code, CUR, row.version || 'V1.0', '已退回',
    row.data_json || '{}', row.cols_json || '{}', actorName(), DB.now(), `退回：${reason}`
  );
  L.audit(actorName(), '退回', 'project_doc', code,
    { status: row.status }, { status: '草稿', reason }, reason);
  return { ok: true, status: '草稿', reason };
});

// 已批准 → 已完成：A-02 的“完成”入口，保存接口不承担该迁移
route('POST', /^\/api\/docs\/([^/]+)\/complete$/, (m, body) => {
  const code = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  if (!row) throw new Error('交付物不存在');
  if (row.status !== '已批准') {
    throw Object.assign(new Error('只有已批准交付物可以标记完成'), { statusCode: 409 });
  }
  requirePermission('doc.complete', '标记交付物完成');
  assertDocApprovable(code);
  DB.db.prepare(`UPDATE project_doc SET status='已完成',lock_token=? WHERE doc_code=? AND project_id=?`)
    .run(crypto.randomUUID(), code, CUR);
  L.audit(actorName(), '完成', 'project_doc', code,
    { status: row.status }, { status: '已完成' }, body.note || '交付物编制与交付完成');
  return { ok: true, status: '已完成' };
});

route('POST', /^\/api\/docs\/([^/]+)\/revise$/, (m, body) => DB.tx(() => {
  const code = decodeURIComponent(m[1]);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  if (!row) throw new Error('交付物不存在');
  // 修订会清空批准人，必须与保存同口径：只有归属岗位可发起（admin 兜底）
  assertDocEditable(code);
  if (!['已批准', '已完成'].includes(row.status)) throw new Error('只有已批准或已完成交付物可以发起修订');
  const reason = String(body.reason || '').trim();
  if (!reason) throw new Error('修订原因不能为空');
  const now = DB.now();
  DB.db.prepare(`UPDATE project_doc SET status='草稿',approved_by='',approved_at=NULL,
    rejected_reason=NULL,updated_at=?,updated_by=?,lock_token=? WHERE doc_code=? AND project_id=?`).run(
    now, actorName(), crypto.randomUUID(), code, CUR);
  DB.db.prepare(`INSERT INTO project_doc_revision(
    rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,change_note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    `REV-REVISE-${crypto.randomUUID()}`, code, CUR, row.version || 'V1.0', '草稿',
    row.data_json || '{}', row.cols_json || '{}', actorName(), now, reason);
  L.audit(actorName(), '发起修订', 'project_doc', code,
    { status: row.status }, { status: '草稿' }, reason);
  return { ok: true, status: '草稿', reason };
}));

route('GET', /^\/api\/docs\/([^/]+)\/revisions$/, (m) => {
  const code = decodeURIComponent(m[1]);
  return {
    // 列表不返回整份 data_json，避免大交付物历史抽屉过重；快照按需单独读取
    list: all(`SELECT rev_id,doc_code,project_id,version,status,changed_by,changed_at,change_note,
        approved_by,approved_at,LENGTH(data_json) data_size
      FROM project_doc_revision WHERE project_id=? AND doc_code=? ORDER BY changed_at DESC,rowid DESC`,
    CUR, code),
  };
});

// A-08：查看某一版快照（含表格数据），用于历史回溯与对比
route('GET', /^\/api\/docs\/([^/]+)\/revisions\/([^/]+)$/, (m) => {
  const code = decodeURIComponent(m[1]);
  const revId = decodePart(m[2]);
  const revision = q(`SELECT * FROM project_doc_revision WHERE project_id=? AND doc_code=? AND rev_id=?`,
    CUR, code, revId);
  if (!revision) throw new Error('历史版本不存在');
  let data = {};
  let cols = {};
  try { data = JSON.parse(revision.data_json || '{}'); } catch (error) { data = {}; }
  try { cols = JSON.parse(revision.cols_json || '{}'); } catch (error) { cols = {}; }
  return {
    revision: {
      rev_id: revision.rev_id, version: revision.version, status: revision.status,
      changed_by: revision.changed_by, changed_at: revision.changed_at,
      change_note: revision.change_note, approved_by: revision.approved_by,
      approved_at: revision.approved_at,
    },
    data, cols,
  };
});

// A-08：从历史快照恢复为草稿（保留当前内容为“恢复前”快照，可再次回退）
route('POST', /^\/api\/docs\/([^/]+)\/restore\/([^/]+)$/, (m) => DB.tx(() => {
  const code = decodeURIComponent(m[1]);
  const revId = decodePart(m[2]);
  // 恢复会用旧内容覆盖当前稿并回到草稿：先校验归属，避免用 404/400 泄漏版本是否存在
  assertDocEditable(code);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
  const revision = q(`SELECT * FROM project_doc_revision WHERE project_id=? AND doc_code=? AND rev_id=?`,
    CUR, code, revId);
  if (!row || !revision) throw new Error('交付物或历史版本不存在');
  if (revId === 'pre-restore' || !String(revId).trim()) {
    throw Object.assign(new Error('该版本不能作为恢复目标'), { statusCode: 409 });
  }
  const note = `恢复自历史版本 ${revision.version || ''}（${revision.changed_at || ''}）`;
  DB.db.prepare(`INSERT INTO project_doc_revision(
    rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,change_note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    `REV-RESTORE-${crypto.randomUUID()}`, code, CUR, row.version || 'V1.0', '恢复前',
    row.data_json || '{}', row.cols_json || '{}', actorName(), DB.now(), note
  );
  DB.db.prepare(`UPDATE project_doc SET data_json=?,cols_json=COALESCE(?,cols_json),status='草稿',
    approved_by='',approved_at=NULL,rejected_reason=NULL,updated_at=?,updated_by=?,lock_token=?
    WHERE doc_code=? AND project_id=?`).run(
    revision.data_json || '{}', revision.cols_json || null, DB.now(), actorName(),
    crypto.randomUUID(), code, CUR
  );
  L.audit(actorName(), '恢复', 'project_doc', code,
    { status: row.status, version: row.version },
    { status: '草稿', restored_from: revision.rev_id, version: revision.version },
    note);
  return { ok: true, status: '草稿', restored_from: revision.rev_id, note };
}));

// A-20：单份交付物导出与批量导出共用同一构建函数，保证内容一致
function buildProjectDocExport(code, fmt = 'docx', options = {}) {
  const meta = DT.CATALOG.find(d => d.code === code);
  if (!meta) throw new Error(`交付物 ${code} 不在标准目录中`);
  const schema = docSchema(code, meta);
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR) || {};
  const draftMode = !!options.draftMode;
  let source = row;
  let sourceStatus = row.status || '未开始';
  let uncontrolled = !['已批准', '已完成'].includes(sourceStatus);
  let sourceNote = '';
  if (!draftMode && uncontrolled) {
    const approvedRev = q(`SELECT * FROM project_doc_revision
      WHERE project_id=? AND doc_code=? AND status='已批准'
      ORDER BY rowid DESC LIMIT 1`, CUR, code);
    if (approvedRev) {
      source = {
        ...row,
        data_json: approvedRev.data_json,
        cols_json: approvedRev.cols_json || row.cols_json,
        version: approvedRev.version,
        approved_by: approvedRev.approved_by,
        approved_at: approvedRev.approved_at,
      };
      sourceStatus = '已批准';
      uncontrolled = false;
      sourceNote = `当前记录为${row.status || '草稿'}，已按最近批准版本 ${approvedRev.version} 导出`;
    } else {
      sourceNote = '尚无批准版本，导出当前草稿（非受控文件）';
    }
  } else if (draftMode) {
    uncontrolled = true;
    sourceNote = '按当前编辑内容导出（非受控文件）';
  }
  let data = {};
  let savedCols = {};
  try { data = JSON.parse(source.data_json || '{}'); } catch (error) { data = {}; }
  try { savedCols = JSON.parse(source.cols_json || '{}'); } catch (error) { savedCols = {}; }
  try { data = documentDisplayData(code, data); } catch (error) { /* 历史数据损坏时退回原始内容 */ }
  const project = q('SELECT * FROM project WHERE project_id=?', CUR);
  const payload = {
    code, title: meta.name,
    subtitle: [
      project.name, project.part_no, code,
      uncontrolled ? `【草稿·非受控】${sourceStatus}` : `${sourceStatus}`,
      sourceNote,
    ].filter(Boolean).join(' ｜ '),
    author: uncontrolled ? (row.updated_by || project.owner) : (source.approved_by || row.updated_by || project.owner),
    version: uncontrolled ? `${source.version || row.version || 'V1.0'}(草稿)` : (source.version || row.version || 'V1.0'),
    generatedAt: DB.now(),
    sections: schema.map(sec => ({
      t: sec.t, note: sec.note,
      fields: sec.fields.map(f => ({
        k: f.k, label: f.label, type: f.type,
        cols: (f.type === 'table' && savedCols[f.k]) ? savedCols[f.k] : f.cols,
        value: f.type === 'table' ? '' : (data[f.k] ?? ''),
        rows: f.type === 'table' ? (data[f.k] || []) : undefined,
      })),
    })),
  };
  // 附件（包装图片 / 工程图预览）随交付物一起导出：Word 嵌图，Excel 出清单
  const attachmentSection = buildDocAttachmentSection(code, fmt);
  if (attachmentSection) payload.sections.push(attachmentSection);
  const buf = fmt === 'xlsx' ? EX.buildXlsx(payload) : EX.buildDocx(payload);
  const fname = `${code}_${meta.name}${uncontrolled ? '_草稿' : ''}.${fmt}`;
  return { buf, fname, uncontrolled, version: uncontrolled ? `${source.version || 'V1.0'}(草稿)` : (source.version || 'V1.0') };
}

/**
 * 交付物附件的导出节：
 * - Word：每张图片一个 type:'image' 字段（读取文件得到 Buffer），说明写在 label 前缀
 * - Excel：只列清单（说明/分类/文件名/大小/上传时间），并注明图片见 Word 版
 */
function buildDocAttachmentSection(code, fmt) {
  const categories = code === 'P3-02' ? ['packaging']
    : code === 'P2-06' ? ['drawing-preview'] : [];
  if (!categories.length) return null;
  const rows = categories.flatMap(category => attachmentRows(code, category));
  if (!rows.length) return null;
  const title = code === 'P3-02' ? '包装图片与标识' : '图纸预览';
  const cleanCaption = item => item.caption || item.group_label || item.file_name;
  if (fmt === 'xlsx') {
    return {
      t: title,
      note: '图片内容请见 Word 版导出；本页仅列附件清单。',
      fields: [{
        label: '附件清单', type: 'table',
        cols: ['说明', '分类', '文件名', '大小(KB)', '上传时间'],
        rows: rows.map(item => [
          item.caption || '', item.group_label || '', item.file_name || '',
          Math.max(1, Math.round((item.size || 0) / 1024)), item.created_at || '',
        ]),
      }],
    };
  }
  const fields = [];
  for (const item of rows) {
    if (!item.is_image) continue; // Word 只嵌位图；PDF/CAD 源文件在清单里列出文件名
    const file = q('SELECT storage_path FROM doc_attachment WHERE attachment_id=? AND project_id=?',
      item.attachment_id, CUR);
    if (!file || !file.storage_path || !fs.existsSync(file.storage_path)) continue;
    fields.push({
      type: 'image',
      label: cleanCaption(item),
      data: fs.readFileSync(file.storage_path),
      maxWidthInches: 5.9,
      maxHeightInches: 3.2,
    });
  }
  fields.push({
    label: '附件清单', type: 'table',
    cols: ['说明', '分类', '文件名', '类型'],
    rows: rows.map(item => [
      item.caption || '', item.group_label || '', item.file_name || '',
      item.is_pdf ? 'PDF' : item.is_image ? '图片' : 'CAD 源文件',
    ]),
  });
  return { t: title, note: '附件随交付物归档；图片按原比例排版，PDF/CAD 源文件以清单列出。', fields };
}

function buildTemplateExport(tplId, fmt = 'docx') {
  const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', tplId, CUR);
  if (!row) throw new Error('模板不存在');
  const schema = JSON.parse(row.schema_json || '{}');
  const wantXlsx = String(fmt || '').toLowerCase() === 'xlsx';
  const useXlsx = schema.kind === 'grid' ? wantXlsx : false;
  let buf, ext;
  if (useXlsx) {
    buf = EX.buildXlsxFromGrid(schema, { name: row.name });
    ext = 'xlsx';
  } else if (row.source === 'docx' && row.source_path) {
    const sourceFile = path.join(TEMPLATE_DIR, path.basename(row.source_path));
    if (!fs.existsSync(sourceFile)) throw new Error('Word 原模板文件已丢失，无法保留原版式导出');
    buf = EX.patchDocxFromSource(fs.readFileSync(sourceFile), schema, {
      name: row.name, generatedAt: DB.now(),
    });
    ext = 'docx';
  } else {
    buf = EX.buildDocxFromBlocks(schema, { name: row.name, generatedAt: DB.now() });
    ext = 'docx';
  }
  const approved = row.status === '已批准';
  const fname = approved ? `${row.name}.${ext}` : `${row.name}_${row.status || '草稿'}.${ext}`;
  return { buf, fname, ext, row };
}

// A-20：批量提交草稿交付物
route('POST', /^\/api\/docs\/batch\/submit$/, (m, body) => DB.tx(() => {
  const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(code => String(code).trim()).filter(Boolean))];
  if (!codes.length) throw new Error('请选择要提交的交付物');
  const submitted = [];
  const skipped = [];
  for (const code of codes) {
    const meta = DT.CATALOG.find(item => item.code === code);
    const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR);
    if (!meta || !docSchema(code, meta)) { skipped.push({ code, reason: '不是表单类交付物' }); continue; }
    if (!row) { skipped.push({ code, reason: '交付物尚未创建' }); continue; }
    if (!['草稿', '未开始', '已退回'].includes(row.status)) {
      skipped.push({ code, reason: `当前状态为${row.status}` });
      continue;
    }
    const latestContent = q(`SELECT change_note FROM project_doc_revision
      WHERE project_id=? AND doc_code=? AND data_json=? ORDER BY rowid DESC LIMIT 1`,
    CUR, code, row.data_json);
    if (row.published_version && !submissionChangeNote(latestContent?.change_note)) {
      skipped.push({ code, reason: '缺少本次内容变更原因' });
      continue;
    }
    if (DT.CHECKLIST_QUESTIONS[code]) {
      try { validateChecklistData(code, checklistData(code, JSON.parse(row.data_json || '{}'))); }
      catch (error) { skipped.push({ code, reason: error.message }); continue; }
    }
    DB.db.prepare(`UPDATE project_doc SET status='待审核',submitted_by=?,submitted_at=?,
      rejected_reason=NULL,lock_token=? WHERE doc_code=? AND project_id=?`).run(
      actorName(), DB.now(), crypto.randomUUID(), code, CUR);
    L.audit(actorName(), '提交审核', 'project_doc', code,
      { status: row.status }, { status: '待审核' }, '批量提交审核');
    submitted.push(code);
  }
  return { ok: true, submitted, skipped };
}));

// A-20：批量导出为 ZIP；每份文件按单份导出规则（默认取批准版本）
route('POST', /^\/api\/docs\/batch\/export$/, (m, body) => {
  const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(code => String(code).trim()).filter(Boolean))];
  if (!codes.length) throw new Error('请选择要导出的交付物');
  const fmt = String(body.fmt || 'docx').toLowerCase() === 'xlsx' ? 'xlsx' : 'docx';
  const files = [];
  const skipped = [];
  for (const code of codes) {
    try {
      const meta = DT.CATALOG.find(item => item.code === code);
      let built;
      if (meta && docSchema(code, meta)) {
        built = buildProjectDocExport(code, fmt, { draftMode: body.draft === true });
        recordExport({
          objectType: 'project_doc', objectId: code, format: fmt,
          fileName: built.fname, buffer: built.buf, version: built.version,
        });
      } else {
        const bound = q(`SELECT tpl_id FROM doc_template WHERE doc_code=? AND (project_id=? OR project_id IS NULL)
          ORDER BY updated_at DESC,rowid DESC LIMIT 1`, code, CUR);
        if (!bound) throw new Error('不是可导出的交付物');
        const tpl = buildTemplateExport(bound.tpl_id, fmt);
        built = { buf: tpl.buf, fname: tpl.fname, version: `模板·${tpl.row.status || '草稿'}` };
        recordExport({
          objectType: 'doc_template', objectId: tpl.row.tpl_id, format: tpl.ext,
          fileName: tpl.fname, buffer: tpl.buf, version: built.version,
        });
      }
      files.push({ name: built.fname, data: built.buf });
    } catch (error) {
      skipped.push({ code, reason: error.message });
    }
  }
  if (!files.length) throw new Error(`没有可导出的交付物${skipped.length ? `：${skipped.map(item => `${item.code} ${item.reason}`).join('；')}` : ''}`);
  const zip = EX.zip(files);
  const fileName = `APQP-交付物-${DB.now().replace(/[-: ]/g, '').slice(0, 12)}.zip`;
  recordExport({
    objectType: 'project_doc_batch', objectId: CUR, format: 'zip',
    fileName, buffer: zip, version: `${files.length} 份`,
  });
  L.audit(actorName(), '导出', 'project_doc', CUR, null,
    { count: files.length, skipped: skipped.length }, '批量导出交付物');
  return { ok: true, fileName, files: files.length, skipped, dataBase64: zip.toString('base64') };
});

route('GET', /^\/api\/docs\/([^/]+)\/preview$/, (m) => {
  const code = m[1];
  const meta = DT.CATALOG.find(d => d.code === code);
  const schema = docSchema(code, meta);
  if (!schema) throw new Error(meta.desc || '该交付物由系统模块承载，请进入对应模块');
  const row = q('SELECT * FROM project_doc WHERE doc_code=? AND project_id=?', code, CUR) || {};
  let data = {};
  let savedCols = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch (e) { data = {}; }
  try { savedCols = JSON.parse(row.cols_json || '{}'); } catch (e) { savedCols = {}; }
  try { data = documentDisplayData(code, data); } catch (error) { /* 历史数据损坏时退回原始内容 */ }
  const project = q('SELECT * FROM project WHERE project_id=?', CUR);
  return {
    code, name: meta.name, status: row.status,
    subtitle: `${project.name} ｜ ${project.part_no} ｜ ${code}`,
    sections: schema.map(sec => ({
      t: sec.t, note: sec.note,
      fields: sec.fields.map(f => ({
        k: f.k, label: f.label, type: f.type, cols: (f.type === 'table' && savedCols[f.k]) ? savedCols[f.k] : f.cols,
        value: f.type === 'table' ? (data[f.k] || []) : (data[f.k] ?? ''),
      })),
    })),
  };
});

// S-15：启动默认不再全量写入同步（会掩盖真实状态漂移、拖慢启动）。
// 需要时用 QMS_STARTUP_SYNC=1 显式启用，或在系统页执行“重算交付物同步”。
const startupSyncEnabled = String(process.env.QMS_STARTUP_SYNC || '') === '1';
if (startupSyncEnabled) {
  for (const project of all('SELECT project_id FROM project')) {
    try {
      // 启动同步只刷新引用与同步记录，不触发规范降级（规范变更由具体写接口在同一事务内穿透）
      syncProjectDeliverables(project.project_id, { reconcile: false });
    } catch (error) {
      console.error('[deliverable sync]', project.project_id, error.message);
    }
  }
} else {
  const pending = all(`SELECT p.project_id,
      (SELECT COUNT(*) FROM project_doc d WHERE d.project_id=p.project_id) docs,
      (SELECT COUNT(*) FROM deliverable_sync_item s WHERE s.project_id=p.project_id) sync_items
    FROM project p`);
  console.log(`[启动] 已跳过自动同步（${pending.length} 个项目；QMS_STARTUP_SYNC=1 或 POST /api/admin/resync 可重算）`);
}

/* ---------------------------------------------------------------- 启动 */
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = decodePart(u.pathname);
  const qs = new URLSearchParams(u.query || {});
  const wantP = qs.get('p');
  const user = authUserFromRequest(req);
  let requestProject = DEFAULT_PROJECT;
  let projectDenied = false;
  if (wantP) {
    const projectExists = q('SELECT 1 FROM project WHERE project_id=?', wantP);
    if (projectExists && (!user || canAccessProject(user, wantP))) requestProject = wantP;
    else if (projectExists && user && !canAccessProject(user, wantP)) projectDenied = true;
  }
  requestContext.enterWith({ projectId: requestProject, user });

  if (projectDenied && p.startsWith('/api/')) {
    return json(res, 403, { error: '当前账号不是该项目的成员，不能访问该项目数据' });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      pruneLoginAttempts();
      const attemptKey = loginAttemptKey(req, username);
      const attempt = LOGIN_ATTEMPTS.get(attemptKey);
      if (attempt && attempt.until > Date.now()) {
        return json(res, 429, { error: `尝试次数过多，请 ${Math.ceil((attempt.until - Date.now()) / 60000)} 分钟后再试` });
      }
      const account = q('SELECT * FROM auth_user WHERE username=? AND status=?', username, '启用');
      // 用户不存在时也做一次同样耗时的校验，避免通过响应时间判断账号是否存在
      const valid = account
        ? DB.verifyPassword(password, account.password_salt, account.password_hash)
        : (DB.verifyPassword(password, DUMMY_SALT, DUMMY_HASH), false);
      if (!valid) {
        const count = (attempt?.count || 0) + 1;
        LOGIN_ATTEMPTS.set(attemptKey, {
          count, last: Date.now(), until: count >= 5 ? Date.now() + 5 * 60000 : 0,
        });
        return json(res, 401, { error: '用户名或密码错误' });
      }
      LOGIN_ATTEMPTS.delete(attemptKey);
      DB.db.prepare('DELETE FROM auth_session WHERE expires_at<?').run(DB.now());
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS + 8 * 3600e3)
        .toISOString().replace('T', ' ').slice(0, 19);
      DB.db.prepare('INSERT INTO auth_session(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
        .run(hashSession(token), account.user_id, DB.now(), expiresAt);
      setSessionCookie(res, token);
      return json(res, 200, { ok: true, user: publicUser(account) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (p === '/api/auth/me' && req.method === 'GET') {
    return user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: '请先登录' });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req).qms_session;
    if (token) DB.db.prepare('DELETE FROM auth_session WHERE token_hash=?').run(hashSession(token));
    setSessionCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/change-password' && req.method === 'POST') {
    if (!user) return json(res, 401, { error: '请先登录' });
    try {
      const body = await readBody(req);
      const current = String(body.current_password || '');
      const next = String(body.new_password || '');
      const account = q('SELECT * FROM auth_user WHERE user_id=?', user.user_id);
      if (!account || !DB.verifyPassword(current, account.password_salt, account.password_hash)) {
        return json(res, 400, { error: '当前口令不正确' });
      }
      if (next.length < PASSWORD_MIN_LENGTH) {
        return json(res, 400, { error: `新口令至少 ${PASSWORD_MIN_LENGTH} 位` });
      }
      if (WEAK_PASSWORDS.includes(next)) {
        return json(res, 400, { error: '不能使用系统已知的默认口令' });
      }
      if (next === current) return json(res, 400, { error: '新口令不能与当前口令相同' });
      const salt = crypto.randomBytes(16).toString('hex');
      DB.db.prepare(`UPDATE auth_user SET password_salt=?,password_hash=?,
        must_change_password=0 WHERE user_id=?`).run(salt, DB.passwordDigest(next, salt), user.user_id);
      // 其他设备的会话立即失效，仅保留当前会话
      const token = parseCookies(req).qms_session;
      DB.db.prepare('DELETE FROM auth_session WHERE user_id=? AND token_hash<>?')
        .run(user.user_id, hashSession(token || ''));
      L.audit(user.display_name, '修改口令', 'auth_user', user.user_id, null, null, '用户修改本人登录口令');
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message || '口令修改失败' });
    }
  }
  if (p.startsWith('/api/')) {
    if (!user) return json(res, 401, { error: '请先登录' });
    // 一次性口令必须先改密：否则口令一直明文留在 initial-credentials 文件里
    if (user.must_change_password && p !== '/api/auth/change-password') {
      return json(res, 403, { error: '首次登录必须先修改口令', must_change_password: true });
    }
    if (req.method !== 'GET' && user.role === 'auditor') {
      return json(res, 403, { error: '当前账号没有执行此操作的权限' });
    }
    if (p.startsWith('/api/admin/') && user.role !== 'admin') {
      return json(res, 403, { error: '只有系统管理员可以执行此操作' });
    }
  }

  // ---- PPAP ZIP 下载
  const mPkg = p.match(/^\/api\/ppap\/packages\/(\d+)\/download$/);
  if (mPkg && req.method === 'GET') {
    try {
      const pkg = q('SELECT * FROM ppap_package WHERE pkg_id=? AND project_id=?', +mPkg[1], CUR);
      if (!pkg || !pkg.zip_path) throw new Error('PPAP 文件包不存在');
      const filePath = path.join(PACKAGE_DIR, path.basename(pkg.zip_path));
      if (!fs.existsSync(filePath)) throw new Error('PPAP ZIP 文件已丢失');
      const buffer = fs.readFileSync(filePath);
      const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (pkg.zip_hash && actualHash !== pkg.zip_hash) throw new Error('PPAP ZIP 哈希校验失败');
      const bl = pkg.baseline_id
        ? q('SELECT version FROM baseline WHERE baseline_id=?', pkg.baseline_id) : null;
      recordExport({
        objectType: 'ppap_package', objectId: String(pkg.pkg_id), format: 'zip',
        fileName: pkg.zip_path, buffer, baselineId: pkg.baseline_id,
        version: bl ? bl.version : '',
      });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="PPAP-${pkg.pkg_id}.zip"; filename*=UTF-8''${encodeURIComponent(pkg.zip_path)}`,
        'Content-Length': buffer.length,
      });
      return res.end(buffer);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ---- 自定义模板导出
  const mTpl = p.match(/^\/api\/templates\/([^/]+)\/export$/);
  if (mTpl && req.method === 'GET') {
    try {
      const row = q('SELECT * FROM doc_template WHERE tpl_id=? AND (project_id=? OR project_id IS NULL)', mTpl[1], CUR);
      if (!row) throw new Error('模板不存在');
      const schema = JSON.parse(row.schema_json || '{}');
      const wantXlsx = String(u.query.fmt || '').toLowerCase() === 'xlsx';
      const useXlsx = schema.kind === 'grid' ? wantXlsx !== false && true : false;
      let buf, ext;
      if (useXlsx) {
        buf = EX.buildXlsxFromGrid(schema, { name: row.name });
        ext = 'xlsx';
      } else if (row.source === 'docx' && row.source_path) {
        const sourceFile = path.join(TEMPLATE_DIR, path.basename(row.source_path));
        if (!fs.existsSync(sourceFile)) throw new Error('Word 原模板文件已丢失，无法保留原版式导出');
        buf = EX.patchDocxFromSource(fs.readFileSync(sourceFile), schema, {
          name: row.name, generatedAt: DB.now(),
        });
        ext = 'docx';
      } else {
        buf = EX.buildDocxFromBlocks(schema, { name: row.name, generatedAt: DB.now() });
        ext = 'docx';
      }
      // 模板本身只有版式、无项目数据，但仍标注模板状态，避免把草稿模板当成受控版式下发
      const tplApproved = row.status === '已批准';
      const fname = tplApproved ? `${row.name}.${ext}` : `${row.name}_${row.status || '草稿'}.${ext}`;
      recordExport({
        objectType: 'doc_template', objectId: row.tpl_id, format: ext, fileName: fname,
        buffer: buf, version: `模板·${row.status || '草稿'}`,
      });
      res.writeHead(200, {
        'Content-Type': ext === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${row.tpl_id}.${ext}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Content-Length': buf.length,
      });
      return res.end(buf);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ---- 交付物导出（二进制）
  const mExp = p.match(/^\/api\/docs\/([^/]+)\/export$/);
  if (mExp && req.method === 'GET') {
    try {
      const code = mExp[1];
      const fmt = String(u.query.fmt || 'docx').toLowerCase() === 'xlsx' ? 'xlsx' : 'docx';
      const meta = DT.CATALOG.find(d => d.code === code);
      if (!meta) {
        // A-18：自定义编号的导出统一分流到绑定模板，不再抛“交付物不存在”
        const bound = q(`SELECT tpl_id FROM doc_template WHERE doc_code=? AND (project_id=? OR project_id IS NULL)
          ORDER BY updated_at DESC,rowid DESC LIMIT 1`, code, CUR);
        if (!bound) throw new Error(`交付物 ${code} 不在标准目录中，也没有绑定模板`);
        res.writeHead(302, { Location: `/api/templates/${encodeURIComponent(bound.tpl_id)}/export?fmt=${fmt}` });
        return res.end();
      }
      // 受控输出：默认导出“最近一次批准的内容”；只有显式 ?v=draft 才导出当前编辑内容
      const draftMode = ['draft', 'current', '1', 'true'].includes(String(u.query.v || '').toLowerCase());
      const built = buildProjectDocExport(code, fmt, { draftMode });
      const { buf, fname } = built;
      // 导出内容不是从基线读取的，因此不挂“最近基线”；只记录真实来源版本
      recordExport({
        objectType: 'project_doc', objectId: code, format: fmt, fileName: fname,
        buffer: buf, version: built.version,
      });
      res.writeHead(200, {
        'Content-Type': fmt === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${code}.${fmt}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Content-Length': buf.length,
      });
      return res.end(buf);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ---- 独立质量工具导出（二进制）
  const mToolExp = p.match(/^\/api\/quality-tools\/(fmea|cp|spc|msa|ppap)\/export$/);
  if (mToolExp && req.method === 'GET') {
    try {
      const tool = mToolExp[1];
      const fmt = String(u.query.fmt || 'docx').toLowerCase() === 'xlsx' ? 'xlsx' : 'docx';
      const payload = buildQualityToolExport(tool, new URLSearchParams(u.query));
      // D-08：未批准/未发布的工具输出必须明确标注“非受控”，不能以受控文件形态流出
      const control = payload.control || {};
      if (!control.controlled) {
        payload.subtitle = `【未受控 · ${control.status || '草稿'}】${payload.subtitle}`;
        payload.version = `${payload.version || ''}(未受控)`;
      }
      const buf = fmt === 'xlsx' && payload.standardWorkbook?.kind === 'msa-grr'
        ? EX.buildGridWorkbook(payload.standardWorkbook.sheets, {
          title: payload.standardWorkbook.title,
          author: payload.standardWorkbook.author,
        })
        : fmt === 'xlsx' && payload.standardWorkbook
          ? EX.buildHandbookXlsx(payload.standardWorkbook)
        : fmt === 'xlsx' ? EX.buildXlsx(payload)
          : EX.buildDocx(payload.docxSections
            ? { ...payload, title: payload.standardWorkbook.title, sections: payload.docxSections }
            : payload);
      const fname = `${payload.title}_${String(payload.generatedAt).slice(0, 10).replace(/[^\d-]/g, '')}.${fmt}`;
      const objectId = u.query.mon_id || u.query.stage || u.query.type || tool;
      // 导出记录写真实对象、真实版本（受控与否都已标注），便于事后追溯“当时导出的是哪一版”
      recordExport({
        objectType: control.objectType || 'quality_tool',
        objectId: control.objectId || `${tool}:${objectId}`,
        format: fmt, fileName: fname, buffer: buf,
        // 未受控导出必须把标注写进记录版本，否则事后无法区分“当时导出的是草稿还是批准版”
        version: control.controlled
          ? (control.version || payload.version || '')
          : (payload.version || `${control.version || ''}(未受控)`),
      });
      res.writeHead(200, {
        'Content-Type': fmt === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${tool}.${fmt}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Content-Length': buf.length,
      });
      return res.end(buf);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }


  if (p.startsWith('/api/')) {
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.pattern);
        if (!m) continue;
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
        // 身份不可由客户端指定：所有“经办人/审批人”字段统一改写为当前会话用户
        if (user && body && typeof body === 'object' && !Array.isArray(body)) {
          for (const key of ACTOR_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(body, key)) body[key] = user.display_name;
          }
          // user 是各接口“经办人”列的通用来源，缺省时也必须是会话用户，
          // 否则会落入代码里的演示姓名（张工艺/质量经理 王 等）
          body.user = user.display_name;
        }
        if (Array.isArray(r.roles) && !r.roles.includes(user.role)) {
          return json(res, 403, { error: '当前账号没有执行此操作的权限' });
        }
        // 模块写守卫：按岗位授权，读接口不受限（所有角色可查看全部页面）
        if (!['GET', 'HEAD'].includes(req.method)) {
          const guard = WRITE_GUARDS.find(entry => entry[0].test(p));
          if (guard && !moduleGuardAllows(user, guard)) {
            return json(res, 403, {
              error: `当前账号（${ROLE_NAMES[user.role] || user.role}）没有该模块的编辑权限：${PM.PERMISSIONS[guard[1]] || guard[1]}`,
            });
          }
        }
        const out = await r.fn(m, body, qs);
        // 附件下载等二进制路由：返回 {__binary, file, mime, filename}
        if (out && out.__binary) {
          const buffer = fs.readFileSync(out.file);
          const disposition = out.download ? 'attachment' : 'inline';
          res.writeHead(200, {
            'Content-Type': out.mime,
            'Content-Length': buffer.length,
            'Content-Disposition': `${disposition}; filename="${encodeURIComponent(out.filename)}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
            'Cache-Control': 'no-store',
          });
          return res.end(buffer);
        }
        return json(res, 200, out ?? { ok: true });
      }
      return json(res, 404, { error: '接口不存在: ' + p });
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      // SQLite / 文件系统异常都会带 code（ERR_SQLITE_ERROR、ENOENT…），消息里含表名、列名或路径；
      // 业务校验错误由我们自己抛普通 Error（无 code）。只原样回传后者。
      const safeToShow = e && (e.statusCode || !e.code);
      return json(res, e.statusCode || 400, {
        error: safeToShow ? (e.message || '请求失败') : '操作失败，请查看服务端日志或联系管理员',
        ...(e.details ? { details: e.details } : {}),
      });
    }
  }

  // 静态资源
  let file = path.join(PUB, p === '/' ? 'index.html' : p);
  // 必须比较到路径分隔符：只比前缀会让同级的 public-backup 之类的目录也通过
  const inPub = file === PUB || file.startsWith(PUB + path.sep);
  if (!inPub) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUB, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '0.0.0.0 (LAN)' : HOST;
  console.log(`[QMS] http://${displayHost}:${PORT}  (pid ${process.pid})`);
});
