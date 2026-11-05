'use strict';

const crypto = require('node:crypto');
const DB = require('./db');
const DT = require('./doctpl');

const EDITABLE = new Set(['未开始', '草稿', '已退回']);
const TABLES = {
  process_step: ['process_step', 'step_id'],
  project_char: ['project_char', 'pchar_id'],
  fmea_node: ['fmea_node', 'node_id'],
  apqp_task: ['apqp_task', 'task_id'],
  cp_row: ['cp_row', 'cp_row_id'],
};
const REFERENCES = {
  'P0-01': ['P0-10', 'P2-13', 'P4-08'],
  'P0-02': ['P1-07', 'P1-09', 'P1-10', 'P2-01'],
  'P0-05': ['P1-09', 'P2-10', 'A-10'],
  'P0-10': ['P1-16'],
  'P1-I-01': ['P1-07', 'P1-08', 'P1-11', 'P1-17'],
  'P1-I-02': ['P1-13', 'P1-16'],
  'P1-I-03': ['P1-07', 'P1-08', 'P1-17'],
  'P1-I-04': ['P1-09', 'P1-10', 'P2-02'],
  'P1-I-05': ['P1-08', 'P1-17', 'P2-01'],
  'P1-I-06': ['P1-07', 'P1-11', 'P2-06', 'P2-07', 'P4-04'],
  'P1-07': ['P2-01', 'P2-03', 'P2-06', 'P2-07', 'P2-11'],
  'P1-08': ['P1-11', 'P2-03'],
  'P1-09': ['P2-01', 'P2-08', 'P3-02', 'A-10'],
  'P1-10': ['P1-11', 'P2-02', 'P3-04'],
  'P1-11': ['P2-01', 'P2-05', 'P2-11', 'P3-06', 'P3-06b'],
  'P1-12': ['P2-01', 'P2-03', 'P4-05'],
  'P1-13': ['P2-10', 'P3-05', 'P4-01', 'P4-09'],
  'P1-14': ['P2-13'],
  'P1-15': ['P2-09', 'A-09'],
  'P1-16': ['P4-08'],
  'P1-17': ['P2-01', 'P2-03', 'P3-06'],
  'P5-04': ['P2-01', 'P3-06'],
  'P2-01': ['P2-03', 'P2-04', 'P2-11', 'P3-06', 'A-02'],
  'P2-02': ['P2-04', 'P3-04', 'P3-06'],
  'P2-03': ['P2-04', 'P4-05', 'P4-04'],
  'P2-04': ['P2-09', 'P2-13'],
  'P2-05': ['P3-06', 'P3-06b'],
  'P2-06': ['P2-01', 'P2-03', 'P2-11', 'P2-12', 'P4-05', 'P4-04', 'A-03'],
  'P2-07': ['P2-03', 'P3-06', 'P3-06b', 'P4-05', 'A-03'],
  'P2-08': ['P3-06', 'P3-06b', 'P4-05', 'A-03'],
  'P2-09': ['P2-01', 'P3-04', 'P3-06', 'P3-06b', 'P4-04', 'A-09'],
  'P2-10': ['P3-04', 'P3-05', 'P3-07', 'A-04'],
  'P2-11': ['P2-01', 'P2-05', 'P3-04', 'P3-06', 'P3-06b', 'P3-08', 'P3-09', 'P4-05'],
  'P2-12': ['P3-08', 'P3-06b', 'A-04'],
  'P2-13': ['P3-03', 'P4-08'],
  'P3-02': ['P4-06', 'A-10'],
  'P3-03': ['P4-08', 'A-05'],
  'P3-04': ['P3-05', 'P3-06', 'P3-06b', 'P3-07', 'A-07'],
  'P3-05': ['P3-04', 'P3-06', 'P4-01', 'A-06'],
  'P3-06': ['P3-06b', 'P4-04', 'A-08'],
  'P3-06b': ['P3-07', 'P3-08', 'P3-09', 'P4-01', 'P4-07', 'A-11'],
  'P3-07': ['P4-01', 'P4-09'],
  'P3-08': ['P4-02'],
  'P3-09': ['P4-03'],
  'P3-10': ['P4-08', 'P4-09'],
  'P4-01': ['P4-03', 'P4-05', 'P4-04'],
  'P4-02': ['P4-03', 'P4-04', 'P4-09', 'P5-01'],
  'P4-03': ['P4-04', 'P5-01'],
  'P4-04': ['P4-08', 'P4-09', 'P5-01'],
  'P4-05': ['P4-04', 'P4-08'],
  'P4-06': ['P4-08', 'P4-09'],
  'P4-07': ['P4-03', 'P4-04', 'P4-09', 'A-11'],
  'P4-08': ['P4-09'],
  'P4-09': ['P5-01'],
  'P5-01': ['P3-06', 'P4-07', 'P5-04'],
  'P5-02': ['P1-I-01', 'P2-01', 'P3-06', 'P5-04'],
  'P5-03': ['P1-I-02', 'P1-13', 'P5-04'],
  'P5-04': ['P1-I-03', 'P1-I-05', 'P1-17'],
  'A-01': ['P1-17'],
  'A-02': ['P2-04', 'P2-13'],
  'A-03': ['P2-04', 'P2-13'],
  'A-04': ['P2-13', 'P4-09'],
  'A-05': ['P3-03', 'P4-08'],
  'A-06': ['P3-05'],
  'A-07': ['P3-04'],
  'A-08': ['P3-06'],
  'A-09': ['P2-09'],
  'A-10': ['P2-08', 'P3-02'],
  'A-11': ['P4-07', 'P4-08'],
};
const stamp = () => new Date().toISOString();
const json = value => JSON.stringify(value === undefined ? null : value);
const parse = (value, fallback = {}) => {
  try { return JSON.parse(value || 'null') ?? fallback; } catch (error) { return fallback; }
};
const same = (a, b) => json(a) === json(b);
const key = (...parts) => crypto.createHash('sha256').update(json(parts)).digest('hex').slice(0, 28);
const text = value => value == null ? '' : String(value).trim();
const query = (sql, ...args) => DB.db.prepare(sql).get(...args);
const all = (sql, ...args) => DB.db.prepare(sql).all(...args);

/**
 * 解析 P2-11「规格/公差」文本中的常见数值写法（D-03）。
 * 只在字典/项目特性没有显式数值时补全，绝不覆盖已正式确认的数值。
 * 支持：10±0.1、10 +/- 0.1、10 +0.1/-0.2、9.9~10.1、10 mm。
 */
function parseSpecification(value) {
  const raw = text(value);
  if (!raw) return {};
  const unitMatch = raw.match(/(mm|cm|μm|um|nm|℃|°C|%|kΩ|kohm|Ω|V|A|W|MPa|N|s|min|h|kg|mg|g|HV|HRC)\s*$/i);
  const unit = unitMatch ? unitMatch[1] : '';
  const body = (unitMatch ? raw.slice(0, raw.length - unitMatch[0].length) : raw).trim();
  const num = '([+-]?\\d+(?:\\.\\d+)?)';
  const round = number => +number.toFixed(10);
  let match = body.match(new RegExp(`^${num}\\s*(?:±|\\+\\s*\\/\\s*-)\\s*${num}$`));
  if (match) {
    const target = round(+match[1]);
    const tolerance = Math.abs(round(+match[2]));
    return { target, lsl: round(target - tolerance), usl: round(target + tolerance), unit };
  }
  match = body.match(new RegExp(`^${num}\\s*\\+\\s*${num}\\s*\\/\\s*-\\s*${num}$`));
  if (match) {
    const target = round(+match[1]);
    const upper = Math.abs(round(+match[2]));
    const lower = Math.abs(round(+match[3]));
    return { target, lsl: round(target - lower), usl: round(target + upper), unit };
  }
  match = body.match(new RegExp(`^${num}\\s*(?:~|～|–|—|至|\\s-\\s)\\s*${num}$`));
  if (match) {
    const first = round(+match[1]);
    const second = round(+match[2]);
    return { lsl: Math.min(first, second), usl: Math.max(first, second), unit };
  }
  match = body.match(new RegExp(`^${num}$`));
  if (match) return { target: round(+match[1]), unit };
  return { unit };
}

function specificationNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = +value;
  return Number.isFinite(number) ? number : null;
}

/** 规范文本的数值指纹：上下限优先，其次目标值；不可解析时返回 ''。 */
function specificationFingerprint(parsed) {
  if (!parsed) return '';
  if (parsed.lsl != null && parsed.usl != null) return `L${parsed.lsl}|U${parsed.usl}`;
  if (parsed.target != null) return `T${parsed.target}`;
  return '';
}

/** 显式同步元数据 > P2-11 文本解析值 > 已确认的项目特性 > 特性字典。 */
function specificationValue(meta, parsed, existing, master, field) {
  for (const source of [meta, parsed, existing, master]) {
    if (!source) continue;
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

function init() {
  DB.db.exec(`
    CREATE TABLE IF NOT EXISTS deliverable_sync_item(
      sync_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, rule_id TEXT NOT NULL,
      source_code TEXT NOT NULL, source_row_id TEXT NOT NULL, source_version TEXT,
      source_status TEXT, target_json TEXT NOT NULL, values_json TEXT NOT NULL,
      last_json TEXT, protected_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL, kind TEXT NOT NULL, message TEXT, payload_json TEXT,
      managed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliverable_sync_project
      ON deliverable_sync_item(project_id,source_code,state);
    CREATE TABLE IF NOT EXISTS deliverable_sync_snapshot(
      project_id TEXT NOT NULL, source_code TEXT NOT NULL, object_id TEXT NOT NULL,
      version TEXT NOT NULL, snapshot_json TEXT NOT NULL, captured_at TEXT NOT NULL,
      PRIMARY KEY(project_id,source_code,object_id,version)
    );
    CREATE TABLE IF NOT EXISTS deliverable_field_mapping(
      mapping_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_code TEXT NOT NULL,
      target_code TEXT NOT NULL, mapping_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
}

function documentMappingOptions(projectId, sourceCode, targetCode) {
  const sourceMeta = DT.CATALOG.find(item => item.code === sourceCode && item.kind === 'form');
  const targetMeta = DT.CATALOG.find(item => item.code === targetCode && item.kind === 'form');
  if (!sourceMeta || !targetMeta) throw new Error('手动字段联动仅支持表单类交付物');
  const sourceDoc = query('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', projectId, sourceCode);
  const sourceRevision = query(`SELECT * FROM project_doc_revision WHERE project_id=? AND doc_code=?
    AND status='已批准' AND TRIM(COALESCE(approved_by,''))<>''
    ORDER BY COALESCE(approved_at,changed_at) DESC,rowid DESC LIMIT 1`, projectId, sourceCode);
  const sourceData = parse(sourceRevision?.data_json || sourceDoc?.data_json);
  const targetDoc = query('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', projectId, targetCode);
  const targetData = parse(targetDoc?.data_json);
  const mappingId = 'DM-' + key(projectId, sourceCode, targetCode);
  const saved = query('SELECT mapping_json FROM deliverable_field_mapping WHERE mapping_id=? AND project_id=?',
    mappingId, projectId);
  const savedColumns = parse(targetDoc?.cols_json);
  const tables = (code, data) => (DT.T[code] || []).flatMap(section => section.fields || [])
    .filter(field => field.type === 'table').map(field => {
      const rows = Array.isArray(data[field.k]) ? data[field.k] : [];
      return {
        key: field.k, label: field.label,
        columns: (code === targetCode && savedColumns[field.k] || field.cols || [])
          .map((label, index) => {
            const sample = rows.map(row => text(row?.[index])).find(Boolean) || '';
            return { index, label, sample: sample.length > 32 ? `${sample.slice(0, 32)}…` : sample };
          }),
        rows: rows.length,
      };
    });
  return {
    source: { code: sourceCode, name: sourceMeta.name,
      version: sourceRevision?.version || sourceDoc?.version || 'V1.0',
      status: sourceDoc?.status || '未开始', approved: !!sourceRevision },
    target: { code: targetCode, name: targetMeta.name, status: targetDoc?.status || '未开始' },
    sourceTables: tables(sourceCode, sourceData), targetTables: tables(targetCode, targetData),
    mapping: parse(saved?.mapping_json, null),
  };
}

function configureFieldMapping(projectId, options) {
  const { sourceCode, targetCode, sourceTable, targetTable, sourceKey, targetKey, fields } = options || {};
  const available = documentMappingOptions(projectId, sourceCode, targetCode);
  const from = available.sourceTables.find(table => table.key === sourceTable);
  const to = available.targetTables.find(table => table.key === targetTable);
  if (!from || !to) throw new Error('请选择有效的上游和下游表格');
  if (!Array.isArray(fields) || !fields.length) throw new Error('至少配置一组字段映射');
  const originalTargetColumnCount = to.columns.length;
  const mappings = fields.map(field => {
    const sourceIndex = Number(field.sourceIndex);
    const targetLabel = text(field.targetLabel);
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= from.columns.length || !targetLabel) {
      throw new Error('字段映射选择无效');
    }
    let targetIndex = to.columns.find(column => column.label === targetLabel)?.index;
    if (targetIndex === undefined) {
      if (available.target.status !== '草稿' && available.target.status !== '未开始') {
        throw new Error('下游交付物已提交或批准；请先修订为草稿，再新增目标列');
      }
      targetIndex = to.columns.length;
      to.columns.push({ index: targetIndex, label: targetLabel });
    }
    const relevance = ['高', '中', '低'].includes(field.relevance) ? field.relevance : '中';
    return { sourceIndex, targetIndex, sourceLabel: from.columns[sourceIndex].label, targetLabel, relevance };
  });
  if (new Set(mappings.map(mapping => mapping.targetIndex)).size !== mappings.length) {
    throw new Error('同一目标列不能重复映射');
  }
  if (new Set(mappings.map(mapping => mapping.sourceIndex)).size !== mappings.length) {
    throw new Error('同一上游字段只能映射一个下游字段，请删除重复映射');
  }
  const resolvedSourceKey = sourceKey == null ? mappings[0].sourceIndex : +sourceKey;
  const resolvedTargetKey = targetKey == null ? mappings[0].targetIndex : +targetKey;
  if (!Number.isInteger(resolvedSourceKey) || resolvedSourceKey < 0 || resolvedSourceKey >= from.columns.length
      || !Number.isInteger(resolvedTargetKey) || resolvedTargetKey < 0 || resolvedTargetKey >= to.columns.length) {
    throw new Error('匹配字段必须选择现有列');
  }
  const sourceColumn = from.columns[resolvedSourceKey];
  const targetColumn = to.columns[resolvedTargetKey];
  if (mappings.some(mapping => mapping.targetIndex === resolvedTargetKey
      && mapping.sourceIndex !== resolvedSourceKey)) {
    throw new Error('匹配键列不能同时作为被填充字段');
  }
  const mappingId = 'DM-' + key(projectId, sourceCode, targetCode);
  const config = { sourceTable, targetTable, sourceKey: resolvedSourceKey, targetKey: resolvedTargetKey,
    sourceKeyLabel: sourceColumn.label, targetKeyLabel: targetColumn.label, fields: mappings };
  const targetDoc = query('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', projectId, targetCode);
  const targetData = parse(targetDoc?.data_json);
  targetData[targetTable] ||= [];
  targetData._syncRows = { ...(targetData._row_ids || {}), ...(targetData._syncRows || {}) };
  const oldIds = targetData._syncRows[targetTable] || [];
  const idCounts = new Map();
  for (const id of oldIds) if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  let rowsUpdated = false;
  targetData._syncRows[targetTable] = targetData[targetTable].map((row, index) => {
    const id = oldIds[index];
    if (id && idCounts.get(id) === 1) return id;
    rowsUpdated = true;
    return crypto.randomUUID();
  });
  let previewChanged = false;
  let previewRows = 0;
  let previewFields = 0;
  if (['草稿', '未开始'].includes(available.target.status)) {
    const sourceDoc = query('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', projectId, sourceCode);
    const sourceRows = parse(sourceDoc?.data_json)[sourceTable];
    const sourceKeyCounts = new Map();
    if (Array.isArray(sourceRows)) {
      for (const row of sourceRows) {
        const value = text(row?.[resolvedSourceKey]);
        if (value) sourceKeyCounts.set(value, (sourceKeyCounts.get(value) || 0) + 1);
      }
    }
    for (const sourceRow of Array.isArray(sourceRows) ? sourceRows : []) {
      const matchValue = text(sourceRow?.[resolvedSourceKey]);
      if (!matchValue || sourceKeyCounts.get(matchValue) !== 1) continue;
      let targetIndex = targetData[targetTable]
        .findIndex(row => text(row?.[resolvedTargetKey]) === matchValue);
      if (targetIndex < 0) {
        targetIndex = targetData[targetTable]
          .findIndex(row => !Array.isArray(row) || row.every(value => !text(value)));
      }
      if (targetIndex < 0) {
        targetData[targetTable].push(Array(to.columns.length).fill(''));
        targetData._syncRows[targetTable].push(crypto.randomUUID());
        targetIndex = targetData[targetTable].length - 1;
      }
      const targetRow = targetData[targetTable][targetIndex];
      while (targetRow.length < to.columns.length) targetRow.push('');
      let rowChanged = false;
      if (!text(targetRow[resolvedTargetKey])) {
        targetRow[resolvedTargetKey] = matchValue;
        rowChanged = true;
        previewFields += 1;
      }
      for (const field of mappings) {
        const value = text(sourceRow?.[field.sourceIndex]);
        if (value && !text(targetRow[field.targetIndex])) {
          targetRow[field.targetIndex] = value;
          rowChanged = true;
          previewFields += 1;
        }
      }
      if (rowChanged) {
        previewChanged = true;
        previewRows += 1;
      }
    }
  }
  const targetChanged = to.columns.length !== originalTargetColumnCount
    || rowsUpdated || previewChanged;
  if (targetChanged) {
    targetData[targetTable] = targetData[targetTable].map(row => {
      const result = Array.isArray(row) ? [...row] : [];
      while (result.length < to.columns.length) result.push('');
      return result;
    });
    const cols = parse(targetDoc?.cols_json);
    cols[targetTable] = to.columns.map(column => column.label);
    const now = stamp();
    const revisionId = `REV-MAP-${key(projectId, targetCode, now)}`;
    const owner = DT.CATALOG.find(item => item.code === targetCode)?.owner || '';
    if (targetDoc) {
      DB.db.prepare(`UPDATE project_doc SET data_json=?,cols_json=?,status='草稿',approved_by='',approved_at=NULL,
        updated_at=?,updated_by=? WHERE project_id=? AND doc_code=?`).run(JSON.stringify(targetData), JSON.stringify(cols), now,
        '系统-字段联动', projectId, targetCode);
    } else {
      DB.db.prepare(`INSERT INTO project_doc(doc_code,project_id,status,owner,data_json,cols_json,updated_at,updated_by,version)
        VALUES(?,?,'草稿',?,?,?,?,?,'V1.0')`).run(targetCode, projectId, owner,
        JSON.stringify(targetData), JSON.stringify(cols), now, '系统-字段联动');
    }
    const version = targetDoc?.version || 'V1.0';
    DB.db.prepare(`INSERT INTO project_doc_revision(
      rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,change_note
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(revisionId, targetCode, projectId, version, '草稿',
      JSON.stringify(targetData), JSON.stringify(cols), '系统-字段联动', now,
      `配置上游字段联动${to.columns.length ? `，目标列：${to.columns.map(column => column.label).join('、')}` : ''}` +
      `${previewRows ? `；按当前上游草稿预填 ${previewRows} 行 ${previewFields} 个字段` : ''}`);
  }
  DB.db.prepare(`INSERT INTO deliverable_field_mapping(mapping_id,project_id,source_code,target_code,mapping_json,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(mapping_id) DO UPDATE SET
    mapping_json=excluded.mapping_json,updated_at=excluded.updated_at`)
    .run(mappingId, projectId, sourceCode, targetCode, json(config), stamp());
  return { mappingId, config, source: available.source, target: available.target,
    preview: { rows: previewRows, fields: previewFields, changed: previewChanged } };
}

function project(projectId) {
  const row = query('SELECT * FROM project WHERE project_id=?', projectId);
  if (!row) throw new Error('项目不存在');
  return row;
}

function characteristicIssue(proj, charId, charKind) {
  const master = charId && query('SELECT * FROM char_master WHERE char_id=?', charId);
  if (!master) return '';
  if (master.status === '作废') return '来源特性字典已作废，不能引入项目';
  if (charKind && master.char_kind && master.char_kind !== charKind) {
    return '来源的产品/过程类型与同编号特性字典不一致，请确认正确特性编号或显式类型';
  }
  if ((master.family_id && master.family_id !== proj.family_id)
    || (master.series_id && master.series_id !== proj.series_id)) {
    return '相同特性编号属于其他产品族或产品系列，未自动复用；请确认正确字典编号或适用范围';
  }
  return '';
}

function rowsMeta(data, tableKey) {
  return data._syncRows?.[tableKey] || data._row_ids?.[tableKey] || [];
}

function targetRecord(projectId, target) {
  if (target.type === 'doc') {
    const record = query('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?', projectId, target.id);
    if (!record) return { exists: false, status: '未开始', values: {} };
    const data = parse(record.data_json);
    if (!target.tableKey) return { exists: true, status: record.status, values: data, record, data };
    const ids = rowsMeta(data, target.tableKey);
    const index = ids.indexOf(target.rowId);
    const row = index >= 0 && Array.isArray(data[target.tableKey]) ? data[target.tableKey][index] : null;
    return { exists: Array.isArray(row), status: record.status, values: row || {}, record, data, index };
  }
  const def = TABLES[target.type];
  if (!def) return { exists: false, status: '', values: {} };
  let record;
  if (target.type === 'cp_row') {
    record = query(`SELECT r.*,p.status parent_status FROM cp_row r
      JOIN control_plan p ON p.cp_id=r.cp_id WHERE r.cp_row_id=? AND p.project_id=?`, target.id, projectId);
  } else if (target.type === 'fmea_node') {
    record = query(`SELECT n.*,h.status parent_status FROM fmea_node n
      JOIN fmea_header h ON h.fmea_id=n.fmea_id WHERE n.node_id=? AND h.project_id=?`, target.id, projectId);
  } else {
    record = query(`SELECT * FROM ${def[0]} WHERE ${def[1]}=? AND project_id=?`, target.id, projectId);
  }
  let parentStatus = record?.parent_status;
  if (!record && target.type === 'cp_row') {
    parentStatus = query('SELECT status FROM control_plan WHERE cp_id=? AND project_id=?', target.cpId, projectId)?.status;
  }
  if (!record && target.type === 'fmea_node') {
    parentStatus = query('SELECT status FROM fmea_header WHERE fmea_id=? AND project_id=?', target.fmeaId, projectId)?.status;
  }
  return {
    exists: !!record,
    status: parentStatus || record?.status || '草稿',
    values: record || {},
    record,
  };
}

function locked(target, record) {
  if (target.type === 'project_char' || target.type === 'apqp_task') return false;
  if (target.type === 'fmea_node' && record.status === '候选') return false;
  return !EDITABLE.has(record.status);
}

function createTarget(projectId, target, values) {
  const proj = project(projectId);
  if (target.type === 'doc') {
    let record = targetRecord(projectId, { type: 'doc', id: target.id });
    if (!record.exists) {
      DB.db.prepare(`INSERT INTO project_doc(doc_code,project_id,status,owner,data_json,version)
        VALUES(?,?,'草稿',?,'{}','V1.0')`).run(target.id, projectId,
      DT.CATALOG.find(item => item.code === target.id)?.owner || proj.owner || '');
      record = targetRecord(projectId, { type: 'doc', id: target.id });
    }
    if (locked(target, record)) throw new Error('下游交付物已批准或正在审核，请先退回草稿后再采用');
    if (target.tableKey) {
      const data = record.data;
      data._syncRows = { ...(data._syncRows || data._row_ids || {}) };
      const table = Array.isArray(data[target.tableKey]) ? data[target.tableKey] : [];
      const ids = [...(data._syncRows[target.tableKey] || [])];
      while (ids.length < table.length) ids.push(null);
      const width = target.width || Math.max(0, ...Object.keys(values).map(Number)) + 1;
      const row = Array(width).fill('');
      table.push(row);
      ids.push(target.rowId);
      data[target.tableKey] = table;
      data._syncRows[target.tableKey] = ids;
      data._syncMeta = { ...(data._syncMeta || {}) };
      data._syncMeta[target.tableKey] = { ...(data._syncMeta[target.tableKey] || {}),
        [target.rowId]: target.sourceMeta || {} };
      saveDoc(projectId, target.id, data);
    }
    return;
  }
  if (target.type === 'process_step') {
    DB.db.prepare(`INSERT INTO process_step(step_id,project_id,step_no,name,step_type,seq,
      equipment,fixture,input_desc,output_desc,status,ver,pfd_mode,change_summary)
      VALUES(?,?,?,?,?,?,?,?,?,?,'草稿','V1.0',?,?)`).run(
      target.id, projectId, '', '', '', (query('SELECT MAX(seq) n FROM process_step WHERE project_id=? AND pfd_mode=?',
        projectId, target.mode || 'PROCESS')?.n || 0) + 1,
      '', '', '', '', target.mode || 'PROCESS', '已批准交付物同步');
  } else if (target.type === 'project_char') {
    const issue = characteristicIssue(proj, values.char_id, values.char_kind);
    if (issue) throw new Error(issue);
    const master = query('SELECT * FROM char_master WHERE char_id=?', values.char_id);
    if (!master) {
      DB.db.prepare(`INSERT INTO char_master(char_id,char_kind,name,description,is_special,
        special_symbol,source_type,source_ref,family_id,series_id,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,'生效')`).run(
        values.char_id, values.char_kind, values.name, values.description || '', values.is_special || 0,
        values.special_symbol || '', values.source_type || '', values.source_ref || '',
        proj.family_id || null, proj.series_id || null);
    }
    DB.db.prepare(`INSERT INTO project_char(pchar_id,project_id,char_id,name,char_kind,
      status,created_at,updated_at) VALUES(?,?,?,?,?,'生效',?,?)`).run(
      target.id, projectId, values.char_id, '', values.char_kind, stamp(), stamp());
  } else if (target.type === 'fmea_node') {
    const header = query('SELECT * FROM fmea_header WHERE fmea_id=? AND project_id=?', target.fmeaId, projectId);
    if (!header || !EDITABLE.has(header.status)) throw new Error('DFMEA 已发布，请先转为草稿后再采用结构候选');
    DB.db.prepare(`INSERT INTO fmea_node(node_id,fmea_id,parent_id,node_type,seq,name,desc,level,status)
      VALUES(?,?,NULL,'STRUCTURE',?,?,?,1,'生效')`).run(
      target.id, target.fmeaId,
      (query('SELECT MAX(seq) n FROM fmea_node WHERE fmea_id=?', target.fmeaId)?.n || 0) + 1, '', '');
  } else if (target.type === 'apqp_task') {
    const inserted = DB.db.prepare(`INSERT INTO apqp_task(project_id,phase,name,owner,due,status,deliverable,weight)
      VALUES(?,?,?,? ,?,'未开始',?,1)`).run(
      projectId, values.phase, values.name, '', '', values.deliverable || '');
    target.id = Number(inserted.lastInsertRowid);
  } else if (target.type === 'cp_row') {
    const header = query('SELECT * FROM control_plan WHERE cp_id=? AND project_id=?', target.cpId, projectId);
    if (!header || !EDITABLE.has(header.status)) throw new Error('控制计划已批准或不存在，请先确认目标并退回草稿');
    DB.db.prepare('INSERT INTO cp_row(cp_row_id,cp_id,seq) VALUES(?,?,?)').run(
      target.id, target.cpId, (query('SELECT MAX(seq) n FROM cp_row WHERE cp_id=?', target.cpId)?.n || 0) + 1);
  } else {
    throw new Error('下游记录不存在，不能自动建立该类型记录');
  }
}

function saveDoc(projectId, code, data) {
  DB.db.prepare(`UPDATE project_doc SET data_json=?,status=CASE WHEN status='未开始' THEN '草稿' ELSE status END,
    updated_at=?,updated_by='系统-交付物联动' WHERE project_id=? AND doc_code=?`)
    .run(json(data), stamp(), projectId, code);
}

function writeValues(projectId, target, values) {
  if (!Object.keys(values).length) return;
  const current = targetRecord(projectId, target);
  if (!current.exists || locked(target, current)) throw new Error('下游已批准、正在审核或记录已删除，请先退回草稿并确认目标');
  if (target.type === 'doc') {
    if (target.tableKey) {
      for (const [field, value] of Object.entries(values)) {
        if (!/^\d+$/.test(field)) throw new Error('表格同步字段必须为列索引');
        current.data[target.tableKey][current.index][+field] = value;
      }
    } else {
      for (const [field, value] of Object.entries(values)) {
        if (['__proto__', 'constructor', 'prototype', '_syncRows', '_syncMeta'].includes(field)) throw new Error('无效同步字段');
        current.data[field] = value;
      }
    }
    saveDoc(projectId, target.id, current.data);
  } else {
    const [table, idField] = TABLES[target.type];
    const columns = new Set(all(`PRAGMA table_info(${table})`).map(column => column.name));
    const fields = Object.keys(values);
    for (const field of fields) {
      if (!columns.has(field) || [idField, 'project_id', 'cp_id', 'fmea_id', 'status'].includes(field)) {
        throw new Error(`不允许同步字段：${field}`);
      }
    }
    DB.db.prepare(`UPDATE ${table} SET ${fields.map(field => `${field}=?`).join(',')} WHERE ${idField}=?`)
      .run(...fields.map(field => values[field]), target.id);
  }
}

function saveItem(row) {
  const old = query('SELECT * FROM deliverable_sync_item WHERE sync_id=?', row.sync_id);
  if (old && Object.keys(row).every(field => field === 'updated_at' || same(row[field], old[field]))) return;
  const fields = Object.keys(row);
  DB.db.prepare(`INSERT INTO deliverable_sync_item(${fields.join(',')})
    VALUES(${fields.map(() => '?').join(',')})
    ON CONFLICT(sync_id) DO UPDATE SET ${fields.filter(field => field !== 'sync_id').map(field => `${field}=excluded.${field}`).join(',')}`)
    .run(...fields.map(field => row[field]));
}

const SOURCE_NAMES = {
  PROJECT: '项目基本信息',
  MSA_PLAN: 'MSA计划',
  'CP:PROTO': '原型阶段控制计划',
  'CP:PILOT': '试生产控制计划',
  'CP:SOP': '生产控制计划',
};
const TARGET_NAMES = {
  reference: '受控引用',
  process_step: '工序',
  project_char: '项目特性',
  fmea_node: 'FMEA结构',
  apqp_task: 'APQP任务',
  cp_row: '控制计划行',
};
const FIELD_NAMES = {
  project_name: '项目名称', part_no: '零件号', customer: '顾客', owner: '负责人',
  material_code: '物料编码', specification: '规格', supplier: '供应商',
  step_no: '工序号', step_type: '工序类型', equipment: '设备 / 检具', fixture: '工装',
  input_desc: '输入', output_desc: '输出 / 关键特性',
  char_id: '特性编号', char_kind: '特性类型', name: '名称', desc: '说明',
  is_special: '特殊特性', special_symbol: '特殊特性符号', tol_text: '规范',
  spec_text: '规范', measure_tech: '测量技术', sample_size: '样本量',
  freq_value: '频率', freq_unit: '频率单位', freq_trigger: '频率触发条件',
  control_method: '控制方法', reaction_plan: '反应计划', is_spc: '纳入SPC',
  phase: '阶段', due: '完成日期', deliverable: '交付物',
  target: '目标值', unit: '单位', lsl: '下限', usl: '上限',
};
const TABLE_FIELD_NAMES = {
  process_step: { name: '工序名称', seq: '工序顺序' },
  project_char: { char_id: '特性编号', name: '特性名称', char_kind: '特性类型' },
  fmea_node: { name: '结构名称', desc: '结构说明', level: '结构层级' },
  apqp_task: { name: '任务名称' },
  cp_row: { char_id: '特性编号', spec_text: '规范', measure_tech: '测量技术',
    control_method: '控制方法', reaction_plan: '反应计划' },
};
const INTERNAL_FIELDS = new Set([
  'project_id', 'family_id', 'series_id', 'source_document', 'approved_revision',
  'version', 'revision', 'source_ref', 'source_type', 'step_id', 'parent_id',
  'parent_step_id', 'project_char_id', 'pchar_id', 'row_id', 'fmea_row_id',
  'fmea_id', 'node_id', 'func_id', 'cp_id', 'cp_row_id', 'plan_id', 'study_id',
  'source_row_id', 'source_id', 'sync_id', 'object_id', 'target_id',
]);

function documentName(projectId, code) {
  const meta = DT.CATALOG.find(item => item.code === code);
  const custom = query('SELECT custom_name FROM project_doc WHERE project_id=? AND doc_code=?',
    projectId, code)?.custom_name;
  if (meta || custom) return { name: custom || meta.name, code: meta ? code : '' };
  const template = query(`SELECT name FROM doc_template WHERE doc_code=?
    AND (project_id=? OR project_id IS NULL)
    ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END LIMIT 1`, code, projectId, projectId);
  return template ? { name: template.name, code: '' } : null;
}

function sourceDisplay(projectId, code) {
  const doc = documentName(projectId, code);
  if (doc) return doc;
  return { name: SOURCE_NAMES[code] || '其他来源', code: '' };
}

function targetDisplayName(projectId, target) {
  if (target.type === 'doc') return documentName(projectId, target.id)?.name || '交付物';
  if (target.type === 'reference') {
    return documentName(projectId, target.id)?.name || TARGET_NAMES[target.id] || '受控引用';
  }
  if (TARGET_NAMES[target.type]) return TARGET_NAMES[target.type];
  return '关联对象';
}

function targetSchema(target) {
  const meta = DT.CATALOG.find(item => item.code === target.id);
  const sections = DT.T[target.id] || (meta?.group === 'checklist' ? DT.T.CHK_1 : DT.GENERIC());
  return sections.flatMap(section => section.fields || []);
}

function processStepLabel(projectId, stepId) {
  const step = query('SELECT step_no,name FROM process_step WHERE project_id=? AND step_id=?',
    projectId, stepId);
  return step ? [step.step_no, step.name].filter(Boolean).join(' ') : '';
}

function characteristicLabel(projectId, id) {
  const projectChar = query(`SELECT pc.char_id,COALESCE(NULLIF(pc.name,''),cm.name) name
    FROM project_char pc LEFT JOIN char_master cm ON cm.char_id=pc.char_id
    WHERE pc.project_id=? AND pc.pchar_id=?`, projectId, id);
  const master = projectChar || query('SELECT char_id,name FROM char_master WHERE char_id=?', id);
  return master ? [master.char_id, master.name].filter(Boolean).join(' ') : '';
}

function gaugeLabel(id) {
  const gauge = query('SELECT code,name FROM gauge WHERE gauge_id=?', id);
  return gauge ? [gauge.code, gauge.name].filter(Boolean).join(' ') : '';
}

function failureRowLabel(projectId, rowId) {
  const row = query(`SELECT fe.name fe_name,fm.name fm_name,fc.name fc_name FROM fmea_row r
    JOIN fmea_header h ON h.fmea_id=r.fmea_id
    LEFT JOIN fmea_node fe ON fe.node_id=r.fe_id
    LEFT JOIN fmea_node fm ON fm.node_id=r.fm_id
    LEFT JOIN fmea_node fc ON fc.node_id=r.fc_id
    WHERE h.project_id=? AND r.row_id=?`, projectId, rowId);
  return row ? [row.fe_name, row.fm_name, row.fc_name].filter(Boolean).join(' / ') : '';
}

function opaqueValue(value) {
  const textValue = String(value || '');
  return /^[0-9a-f]{24,}$/i.test(textValue)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(textValue)
    || /^(?:DS-|REV-|PS-DS-|PC-DS-|N-DS-|N-CS-|CP-CS-)/i.test(textValue);
}

function opaqueUnknownValue(value) {
  const textValue = String(value || '');
  return opaqueValue(value) || /^[a-z]{2,}(?:-[a-z0-9]{2,}){2,}$/i.test(textValue);
}

function displayValue(value, field, projectId) {
  if (value == null || value === '') return value;
  if (field === 'step_id') return processStepLabel(projectId, value) || '已关联工序';
  if (field === 'project_char_id' || field === 'pchar_id') return characteristicLabel(projectId, value) || '已关联特性';
  if (field === 'gauge_id') return gaugeLabel(value) || '已关联测量设备';
  if (field === 'fmea_row_id') return failureRowLabel(projectId, value) || '已关联FMEA分析行';
  if (Array.isArray(value)) {
    return value.map(item => Array.isArray(item)
      ? item.map(cell => displayValue(cell, '', projectId)).filter(cell => cell != null && cell !== '').join(' · ')
      : displayValue(item, '', projectId)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') return '相关内容已关联';
  if (opaqueValue(value)) return '相关对象已关联';
  return value;
}

function displayFieldLabel(target, record, field, incoming) {
  if (field === 'step_id') return incoming.step_no ? '' : '工序';
  if (field === 'project_char_id' || field === 'pchar_id') return '特性';
  if (field === 'gauge_id') return '测量设备';
  if (field === 'fmea_row_id') return 'FMEA分析';
  if (INTERNAL_FIELDS.has(field) || field.startsWith('_')) return '';
  if (target.type === 'doc') {
    const definition = targetSchema(target).find(item => item.k === target.tableKey);
    if (target.tableKey && /^\d+$/.test(field)) {
      const columns = parse(record.record?.cols_json, {})[target.tableKey] || definition?.cols || [];
      return columns[+field] || '其他关联内容';
    }
    const fieldDefinition = targetSchema(target).find(item => item.k === field);
    return fieldDefinition?.label || FIELD_NAMES[field] || '其他关联内容';
  }
  return TABLE_FIELD_NAMES[target.type]?.[field] || FIELD_NAMES[field] || '其他关联内容';
}

function displayRelation(row, target, record, incoming, previous, current) {
  const source = sourceDisplay(row.project_id, row.source_code);
  const version = /^(?:v|r)\d+(?:\.\d+)*$/i.test(row.source_version || '')
    ? row.source_version : '';
  const relationLabel = row.kind === 'reference' ? '只读引用'
    : row.kind === 'candidate' ? '待采用候选'
      : row.kind === 'needs_confirmation' ? '待确认'
        : '字段同步';
  const fields = [];
  for (const field of Object.keys(incoming)) {
    const label = displayFieldLabel(target, record, field, incoming);
    if (!label) continue;
    const safeUnknown = label === '其他关联内容';
    const safeValue = value => safeUnknown && value != null && opaqueUnknownValue(value)
      ? '相关对象已关联' : displayValue(value, field, row.project_id);
    fields.push({
      label,
      previousValue: safeValue(previous[field] ?? null),
      currentValue: safeValue(current?.[field] ?? null),
      incomingValue: safeValue(incoming[field]),
    });
  }
  const stepLabel = incoming.step_id ? processStepLabel(row.project_id, incoming.step_id) : '';
  const stepName = stepLabel.startsWith(`${incoming.step_no || ''} `)
    ? stepLabel.slice(String(incoming.step_no).length + 1) : stepLabel;
  const summary = row.source_code === 'PROJECT' ? '项目基本信息只读引用'
    : row.rule_id === 'initial-special-characteristic' && row.kind === 'reference'
      ? '该特性已在P2-11正式确认；保留初始识别作为来源证据'
    : row.rule_id?.startsWith('catalog-reference:') ? '目录追溯关系，不同步业务字段'
      : row.source_code === 'P3-04' && incoming.step_no
        ? `工序 ${incoming.step_no}${stepName ? ` · ${stepName}` : ''}`
        : row.kind === 'reference' ? '受控引用，不修改目标内容'
          : row.kind === 'candidate' ? '上游内容作为候选，采用后写入目标草稿'
            : '';
  return {
    kind: row.kind === 'reference' ? 'reference' : row.kind === 'candidate' ? 'candidate'
      : row.kind === 'needs_confirmation' ? 'needs_confirmation' : 'field',
    relationLabel,
    sourceName: source.name,
    sourceCode: source.code,
    version,
    targetName: targetDisplayName(row.project_id, target),
    summary,
    fields,
  };
}

function itemView(row) {
  const target = parse(row.target_json);
  const record = targetRecord(row.project_id, target);
  const incoming = parse(row.values_json);
  const previous = parse(row.last_json);
  const current = row.kind === 'reference' ? null
    : Object.fromEntries(Object.keys(incoming).map(field => [field, record.values[field] ?? null]));
  const display = displayRelation(row, target, record, incoming, previous, current);
  return {
    id: row.sync_id, ruleId: row.rule_id, state: row.state, kind: row.kind,
    source: { docCode: row.source_code, rowId: row.source_row_id, objectId: row.source_row_id, version: row.source_version },
    target: { ...target, field: Object.keys(incoming).join(', ') },
    source_status: row.source_status, target_status: record.status,
    previousValue: row.kind === 'reference' ? null : previous, currentValue: current, incomingValue: incoming,
    message: row.message || '', updated_at: row.updated_at,
    details: parse(row.payload_json).details || [],
    display,
  };
}

function manualFieldMappings(projectId, docCode) {
  return all(`SELECT * FROM deliverable_field_mapping WHERE project_id=?
    AND (source_code=? OR target_code=?) ORDER BY source_code,target_code`, projectId, docCode, docCode)
    .map(row => ({ sourceCode: row.source_code, targetCode: row.target_code,
      ...parse(row.mapping_json), updatedAt: row.updated_at }));
}

function catalogItemStatus(projectId, item) {
  if (item.kind === 'form') {
    return query('SELECT status FROM project_doc WHERE project_id=? AND doc_code=?',
      projectId, item.code)?.status || '未开始';
  }
  if (item.kind !== 'module') return '活动';
  if (item.module === 'fmea') {
    return query('SELECT status FROM fmea_header WHERE project_id=? AND fmea_type=?',
      projectId, item.arg)?.status || '未开始';
  }
  if (item.module === 'cp') {
    return query('SELECT status FROM control_plan WHERE project_id=? AND stage=?',
      projectId, item.arg)?.status || '未开始';
  }
  if (item.module === 'pfd') {
    const mode = String(item.arg || 'PROCESS').toUpperCase() === 'INITIAL' ? 'INITIAL' : 'PROCESS';
    const steps = all("SELECT status FROM process_step WHERE project_id=? AND pfd_mode=? AND COALESCE(status,'')<>'作废'",
      projectId, mode);
    if (!steps.length) return '未开始';
    return steps.every(step => step.status === '已发布') ? '已发布' : '进行中';
  }
  if (item.module === 'spc') {
    const monitors = all(`SELECT m.approval_status FROM monitoring_item m
      JOIN cp_row r ON r.cp_row_id=m.cp_row_id JOIN control_plan cp ON cp.cp_id=r.cp_id
      WHERE cp.project_id=? AND m.status='启用'`, projectId);
    if (!monitors.length) return '未开始';
    return monitors.some(monitor => monitor.approval_status === '已批准') ? '已启用' : '待批准';
  }
  if (item.module === 'msa') {
    const plans = all('SELECT status FROM msa_plan_item WHERE project_id=?', projectId);
    if (!plans.length) return '未开始';
    return plans.every(plan => plan.status === '已完成') ? '已完成' : '进行中';
  }
  if (item.module === 'ppap') {
    const elements = all('SELECT status FROM ppap_element WHERE project_id=?', projectId);
    if (!elements.length) return '未开始';
    return elements.every(element => element.status === '已完成') ? '已完成' : '进行中';
  }
  return '系统模块';
}

function documentRelations(projectId, docCode) {
  const current = DT.CATALOG.find(item => item.code === docCode);
  if (!current) return { items: [], mappings: manualFieldMappings(projectId, docCode) };
  const pairs = new Map();
  const statuses = new Map();
  const status = item => {
    if (!statuses.has(item.code)) statuses.set(item.code, catalogItemStatus(projectId, item));
    return statuses.get(item.code);
  };
  const add = (sourceCode, targetCode, direction) => {
    const source = DT.CATALOG.find(item => item.code === sourceCode);
    const target = DT.CATALOG.find(item => item.code === targetCode);
    if (!source || !target) return;
    pairs.set(`${sourceCode}:${targetCode}`, {
      sourceCode, sourceName: source.name, targetCode, targetName: target.name, direction,
      label: `${source.name} → ${target.name}`,
      sourceKind: source.kind, sourceModule: source.module || '', sourceArg: source.arg || '',
      sourcePhase: source.phase, sourceStatus: status(source),
      targetKind: target.kind, targetModule: target.module || '', targetArg: target.arg || '',
      targetPhase: target.phase, targetStatus: status(target),
    });
  };
  for (const source of DT.CATALOG) {
    for (const target of DT.CATALOG.filter(item => item.up?.includes(source.code))) {
      if (target.code === docCode) add(source.code, target.code, '上游');
      if (source.code === docCode) add(source.code, target.code, '下游');
    }
    for (const targetCode of new Set([...(source.down || []), ...(REFERENCES[source.code] || [])])) {
      if (targetCode === docCode) add(source.code, targetCode, '上游');
      if (source.code === docCode) add(source.code, targetCode, '下游');
    }
  }
  for (const source of current.up || []) add(source, docCode, '上游');
  return {
    items: [...pairs.values()].sort((a, b) => a.direction.localeCompare(b.direction, 'zh')),
    mappings: manualFieldMappings(projectId, docCode),
  };
}

function syncFields(projectId, options) {
  const proj = project(projectId);
  const source = options.source;
  if (!source?.code || !source.rowId || !source.version || !options.ruleId) throw new Error('同步来源标识不完整');
  const id = 'DS-' + key(projectId, options.ruleId, source.code, source.rowId);
  const old = query('SELECT * FROM deliverable_sync_item WHERE sync_id=? AND project_id=?', id, projectId);
  const oldTarget = old ? parse(old.target_json) : {};
  const target = { ...options.target };
  if (target.type === 'apqp_task' && oldTarget.type === 'apqp_task') target.id = oldTarget.id;
  const incoming = options.values || {};
  const last = old ? parse(old.last_json) : {};
  const protectedFields = new Set(old ? parse(old.protected_json, []) : []);
  const keptValues = old ? parse(old.payload_json).keptValues || {} : {};
  let record = targetRecord(projectId, target);
  if (target.type === 'cp_row' && record.exists) {
    const parsedOverrides = parse(record.values.override_fields_json, []);
    const overrides = Array.isArray(parsedOverrides) ? parsedOverrides : [];
    for (const field of overrides) protectedFields.add(field);
    if (record.values.override_flag && !overrides.length) {
      for (const field of Object.keys(incoming)) protectedFields.add(field);
    }
  }
  const wasMissing = !record.exists;
  let state = 'synced', message = options.message || '', created = 0, updated = 0;
  const details = [];
  let kind = options.kind || 'field';
  const charIssue = target.type === 'project_char' ? characteristicIssue(proj, incoming.char_id, incoming.char_kind) : '';
  if (charIssue) {
    kind = 'needs_confirmation';
    message = charIssue;
  }
  if (kind === 'reference') {
    state = 'read_only';
    message ||= '受控上游引用；未推断或改写下游业务字段';
  } else if (kind === 'needs_confirmation') {
    state = 'review_required';
  } else if (!record.exists && old?.state === 'kept' && same(parse(old.values_json), incoming)) {
    state = 'kept';
    message = old.message;
  } else if (!record.exists && old && parse(old.payload_json).established) {
    state = 'conflict';
    message = '已同步的下游行被删除或失去稳定ID，请确认后重新建立，未自动匹配其他行';
  } else if (!record.exists && (kind === 'candidate' || options.requireConfirmation)) {
    state = 'review_required';
    message ||= '根据已批准来源生成候选，采用后建立下游草稿';
  } else {
    if (!record.exists) {
      const parent = target.type === 'doc' ? targetRecord(projectId, { type: 'doc', id: target.id }) : null;
      const header = target.type === 'fmea_node'
        ? query('SELECT status FROM fmea_header WHERE fmea_id=? AND project_id=?', target.fmeaId, projectId)
        : target.type === 'cp_row' ? query('SELECT status FROM control_plan WHERE cp_id=? AND project_id=?', target.cpId, projectId) : null;
      if ((parent?.exists && locked(target, parent)) || (header && !EDITABLE.has(header.status))) {
        state = 'review_required';
        message = '下游已批准或正在审核，仅记录待复核差异，请先退回草稿';
      } else {
        createTarget(projectId, target, incoming);
        created = 1;
        record = targetRecord(projectId, target);
      }
    }
    if (record.exists && kind !== 'reference') {
      const changes = {};
      for (const [field, value] of Object.entries(incoming)) {
        const current = record.values[field] ?? null;
        if (same(current, value)) {
          last[field] = value;
          continue;
        }
        if (protectedFields.has(field) && Object.hasOwn(keptValues, field) && same(keptValues[field], value)) {
          if (state === 'synced') state = 'kept';
          continue;
        }
        const changedByUser = !created && (protectedFields.has(field)
          || (Object.hasOwn(last, field) ? !same(current, last[field]) : current !== null && current !== ''));
        const status = locked(target, record) ? 'review_required' : changedByUser ? 'conflict' : 'synced';
        details.push({ field, previousValue: last[field] ?? null, currentValue: current, incomingValue: value, state: status });
        if (status !== 'synced') {
          if (status === 'review_required' || state !== 'review_required') state = status;
        } else {
          changes[field] = value;
          last[field] = value;
        }
      }
      if (Object.keys(changes).length) {
        writeValues(projectId, target, changes);
        updated = 1;
      }
      if (state === 'synced' && protectedFields.size) state = 'kept';
      if (state === 'conflict') message = '下游存在人工修改，已保留；请选择采用上游或保留当前值';
      if (state === 'review_required') message = '下游已批准或正在审核，仅记录待复核差异，请先退回草稿';
    }
  }
  const row = {
    sync_id: id, project_id: projectId, rule_id: options.ruleId,
    source_code: source.code, source_row_id: source.rowId, source_version: String(source.version),
    source_status: source.status || '已批准', target_json: json(target), values_json: json(incoming),
    last_json: json(last), protected_json: json([...protectedFields]), state, kind, message,
    payload_json: json({ details, sourceReference: source.reference || null, keptValues,
      established: record.exists || (old && parse(old.payload_json).established) || false }),
    managed: options.managed ? 1 : 0,
    updated_at: stamp(),
  };
  saveItem(row);
  return { ...itemView(row), created, updated, conflict: ['conflict', 'review_required'].includes(state) ? 1 : 0,
    wasMissing };
}

function list(projectId, docCode) {
  const rows = all(`SELECT * FROM deliverable_sync_item WHERE project_id=?
    ${docCode ? 'AND (source_code=? OR json_extract(target_json,\'$.id\')=?)' : ''}
    ORDER BY updated_at DESC,sync_id`, projectId, ...(docCode ? [docCode, docCode] : []));
  const items = rows.map(itemView).filter(item =>
    !(docCode && String(item.ruleId || '').startsWith('project-reference:')));
  const summary = {};
  for (const item of items) summary[item.state] = (summary[item.state] || 0) + 1;
  return { items, summary };
}

function resolve(projectId, id, action) {
  if (!['adopt', 'keep'].includes(action)) throw new Error('处理动作必须为 adopt 或 keep');
  return DB.tx(() => {
    const row = query('SELECT * FROM deliverable_sync_item WHERE sync_id=? AND project_id=?', id, projectId);
    if (!row) throw new Error('关联差异不存在');
    if (row.state === 'source_missing') throw new Error('来源已失效，不能继续采用');
    if (row.managed && /^P\d-/.test(row.source_code) && !['P2-01', 'P3-04'].includes(row.source_code)) {
      const sourceDoc = query('SELECT hidden FROM project_doc WHERE project_id=? AND doc_code=?', projectId, row.source_code);
      const latest = query(`SELECT rev_id,version FROM project_doc_revision WHERE project_id=? AND doc_code=?
        AND status='已批准' AND TRIM(COALESCE(approved_by,''))<>''
        ORDER BY COALESCE(approved_at,changed_at) DESC,rowid DESC LIMIT 1`, projectId, row.source_code);
      if (!sourceDoc || sourceDoc.hidden) throw new Error('来源已失效，不能继续采用');
      const reference = parse(row.payload_json).sourceReference;
      if (!latest || latest.version !== row.source_version || (reference && reference !== latest.rev_id)) {
        throw new Error('来源批准版本已变化，请重新同步后处理');
      }
    }
    if (row.kind === 'reference') return { ok: true, item: itemView(row) };
    if (row.kind === 'needs_confirmation' && action === 'adopt') {
      throw new Error('请先在来源表单补齐稳定行ID或显式产品/过程类型，再重新批准；系统不会按名称或行号猜测匹配');
    }
    const target = parse(row.target_json);
    if (target.type === 'reference' && action === 'adopt') throw new Error('该项仅为来源引用，没有可写入的下游字段');
    const incoming = parse(row.values_json);
    let record = targetRecord(projectId, target);
    const payload = parse(row.payload_json);
    payload.keptValues ||= {};
    if (action === 'adopt') {
      const parent = target.type === 'doc' ? targetRecord(projectId, { type: 'doc', id: target.id }) : record;
      if (parent.exists && locked(target, parent)) throw new Error('下游已批准或正在审核，请先退回草稿后再采用');
      if (!record.exists) createTarget(projectId, target, incoming);
      writeValues(projectId, target, incoming);
      if (target.type === 'cp_row') {
        const parsedOverrides = parse(record.values.override_fields_json, []);
        const overrides = (Array.isArray(parsedOverrides) ? parsedOverrides : [])
          .filter(field => !Object.hasOwn(incoming, field));
        DB.db.prepare(`UPDATE cp_row SET override_fields_json=?,override_flag=?
          WHERE cp_row_id=? AND cp_id IN (SELECT cp_id FROM control_plan WHERE project_id=?)`)
          .run(json(overrides), overrides.length ? 1 : 0, target.id, projectId);
      }
      row.last_json = json(incoming);
      row.protected_json = json(parse(row.protected_json, []).filter(field => !Object.hasOwn(incoming, field)));
      for (const field of Object.keys(incoming)) delete payload.keptValues[field];
      payload.details = [];
      payload.established = true;
      row.state = 'synced';
      row.message = '已采用上游批准版本';
      row.target_json = json(target);
    } else {
      const fields = Object.keys(incoming).filter(field => !same(record.values[field] ?? null, incoming[field]));
      row.last_json = json(Object.fromEntries(Object.keys(incoming).map(field => [field, record.values[field] ?? null])));
      row.protected_json = json([...new Set([...parse(row.protected_json, []), ...fields])]);
      for (const field of fields) payload.keptValues[field] = incoming[field];
      row.state = 'kept';
      row.message = '已确认保留下游人工值；上游再次变化仍会提示复核';
    }
    row.payload_json = json(payload);
    row.updated_at = stamp();
    saveItem(row);
    return { ok: true, item: itemView(row) };
  });
}

function approvedDocs(projectId) {
  const docs = [];
  for (const doc of all("SELECT * FROM project_doc WHERE project_id=? AND COALESCE(hidden,0)=0", projectId)) {
    const rev = query(`SELECT * FROM project_doc_revision WHERE project_id=? AND doc_code=?
      AND status='已批准' AND TRIM(COALESCE(approved_by,''))<>''
      ORDER BY COALESCE(approved_at,changed_at) DESC,rowid DESC LIMIT 1`, projectId, doc.doc_code);
    if (!rev) continue;
    docs.push({ code: doc.doc_code, version: rev.version, data: parse(rev.data_json), revision: rev.rev_id });
    DB.db.prepare(`INSERT OR IGNORE INTO deliverable_sync_snapshot
      (project_id,source_code,object_id,version,snapshot_json,captured_at) VALUES(?,?,?,?,?,?)`)
      .run(projectId, doc.doc_code, rev.rev_id, rev.version, rev.data_json || '{}', stamp());
  }
  return docs;
}

function syncProject(projectId) {
  return DB.tx(() => {
    const proj = project(projectId);
    const touched = new Set();
    const summary = { created: 0, updated: 0, conflicts: 0, references: 0, invalidated: 0, issues: 0 };
    const emit = options => {
      const result = syncFields(projectId, { ...options, managed: true });
      touched.add(result.id);
      summary.created += result.created;
      summary.updated += result.updated;
      summary.conflicts += result.conflict;
      if (result.kind === 'reference') summary.references += 1;
      if (result.kind === 'needs_confirmation') summary.issues += 1;
      return result;
    };
    const source = (doc, rowId) => ({ code: doc.code, rowId, version: doc.version, status: '已批准', reference: doc.revision });
    const formRows = (doc, tableKey, callback) => {
      const ids = rowsMeta(doc.data, tableKey);
      const counts = new Map();
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      for (const [index, row] of (Array.isArray(doc.data[tableKey]) ? doc.data[tableKey] : []).entries()) {
        if (!Array.isArray(row) || !row.some(value => text(value))) continue;
        const rowId = ids[index];
        if (typeof rowId !== 'string' || !rowId.trim() || counts.get(rowId) !== 1) {
          emit({
            ruleId: `legacy:${tableKey}`, source: source(doc, `legacy:${key(row, index)}`),
            target: { type: 'reference', id: doc.code }, values: {}, kind: 'needs_confirmation',
            message: '历史来源行缺少唯一稳定ID或ID重复；请保存来源表单并重新批准后同步，不按名称或行号匹配',
          });
          continue;
        }
        callback(row, rowId);
      }
    };
    const docRow = (doc, ruleId, rowId, targetCode, tableKey, values, width, kind = 'field', message = '', targetRowId = null) => emit({
      ruleId, source: source(doc, rowId), kind, values,
      target: { type: 'doc', id: targetCode, tableKey, rowId: targetRowId || `DSR-${key(ruleId, rowId)}`, width,
        sourceMeta: { source_code: doc.code, source_row_id: rowId, source_version: doc.version,
          ...(doc.code === 'P2-01' ? { fmea_row_id: rowId } : {}), candidate: kind === 'candidate' } },
      message,
    });
    const publicFields = { project_id: proj.project_id, project_name: proj.name || '', part_no: proj.part_no || '',
      customer: proj.customer || '', family_id: proj.family_id || null, series_id: proj.series_id || null,
      owner: proj.owner || '' };
    for (const form of DT.CATALOG.filter(item => item.kind === 'form')) emit({
      ruleId: `project-reference:${form.code}`,
      source: { code: 'PROJECT', rowId: projectId, version: key(publicFields), status: '项目主数据' },
      target: { type: 'reference', id: form.code }, values: publicFields, kind: 'reference',
      message: '项目主数据只读引用，不复制为交付物字段；表单仅预填项目名称和零件号空值',
    });
    const docs = approvedDocs(projectId);
    const formalChars = new Map();
    for (const doc of docs.filter(item => item.code === 'P2-11')) {
      const rowIds = rowsMeta(doc.data, 'chars');
      const counts = new Map();
      for (const rowId of rowIds) counts.set(rowId, (counts.get(rowId) || 0) + 1);
      for (const [index, row] of (doc.data.chars || []).entries()) {
        const rowId = rowIds[index];
        const explicit = doc.data._syncMeta?.chars?.[rowId]?.char_kind || row?.[6];
        const charKind = ['PRODUCT', '产品', '产品特性'].includes(explicit) ? 'PRODUCT'
          : ['PROCESS', '过程', '过程特性'].includes(explicit) ? 'PROCESS' : null;
        const customerClass = text(row?.[7]);
        const organizationClass = text(row?.[8]);
        if (Array.isArray(row) && rowId && counts.get(rowId) === 1 && text(row[0]) && text(row[1])
          && charKind && !(customerClass && organizationClass && customerClass !== organizationClass && !text(row[9]))
          && !characteristicIssue(proj, text(row[0]), charKind)) {
          formalChars.set(text(row[0]), { row, rowId });
        }
      }
    }
    for (const doc of docs) {
      if (doc.code === 'P1-10') formRows(doc, 'steps', (row, rowId) => {
        if (!text(row[0]) || !text(row[1])) return;
        const targetId = `PS-DS-${key(projectId, rowId)}`;
        const old = query('SELECT sync_id FROM deliverable_sync_item WHERE project_id=? AND rule_id=? AND source_row_id=?',
          projectId, 'initial-flow', rowId);
        const collision = !old && query(`SELECT step_id FROM process_step
          WHERE project_id=? AND pfd_mode='INITIAL' AND step_no=? AND COALESCE(status,'')<>'作废'`,
        projectId, text(row[0]));
        emit({ ruleId: 'initial-flow', source: source(doc, rowId), target: { type: 'process_step', id: targetId, mode: 'INITIAL' },
          values: { step_no: text(row[0]), name: text(row[1]), step_type: text(row[2]), equipment: text(row[3]),
            output_desc: text(row[4]) ? `关键特性：${text(row[4])}` : '' },
          requireConfirmation: !!collision,
          message: collision ? '存在相同工序号的历史工序，未按编号猜测绑定；请确认是否另建草稿或调整来源工序号' : '' });
      });
      if (doc.code === 'P1-11') formRows(doc, 'chars', (row, rowId) => {
        const explicit = doc.data._syncMeta?.chars?.[rowId]?.char_kind || row[5];
        const identificationOwner = text(row[6]);
        const charKind = ['PRODUCT', '产品', '产品特性'].includes(explicit) ? 'PRODUCT'
          : ['PROCESS', '过程', '过程特性'].includes(explicit) ? 'PROCESS' : null;
        const charId = text(row[0]);
        const values = {
          0: charId, 1: text(row[1]), 2: '', 3: text(row[2]),
          4: [`初始识别（识别主体：${identificationOwner || '待确认'}）`, text(row[3]), text(row[7]),
            text(row[8]) && `来源版本：${text(row[8])}`]
            .filter(Boolean).join('；'),
          5: '', 6: charKind || '', 7: identificationOwner === '顾客' ? text(row[2]) : '',
          8: identificationOwner === '组织' ? text(row[2]) : '', 9: '',
        };
        const issue = !charId || !text(row[1]) || !charKind
          ? '请补齐特性编号、名称及产品/过程类型；不根据编号前缀或名称猜测'
          : !['顾客', '组织'].includes(identificationOwner)
            ? '请明确特性识别主体是顾客还是组织'
            : characteristicIssue(proj, charId, charKind);
        const formal = formalChars.get(charId);
        if (!issue && formal) {
          emit({ ruleId: 'initial-special-characteristic', source: source(doc, rowId),
            target: { type: 'doc', id: 'P2-11', tableKey: 'chars', rowId: formal.rowId },
            values: Object.fromEntries(formal.row.map((value, index) => [index, value])),
            kind: 'reference', message: '该特性已在P2-11正式确认；保留初始识别作为来源证据' });
          return;
        }
        docRow(doc, 'initial-special-characteristic', rowId, 'P2-11', 'chars', values, 10,
          issue ? 'needs_confirmation' : 'candidate',
          issue || '初始识别候选；请在P2-11确认规格、保证工序及正式分类后批准');
      });
      if (doc.code === 'P2-11') formRows(doc, 'chars', (row, rowId) => {
        const explicit = doc.data._syncMeta?.chars?.[rowId]?.char_kind || row[6];
        const charKind = ['PRODUCT', '产品', '产品特性'].includes(explicit) ? 'PRODUCT'
          : ['PROCESS', '过程', '过程特性'].includes(explicit) ? 'PROCESS' : null;
        const charId = text(row[0]);
        if (!charId || !text(row[1]) || !charKind) {
          emit({ ruleId: 'special-characteristic', source: source(doc, rowId), target: { type: 'reference', id: 'project_char' },
            values: {}, kind: 'needs_confirmation', message: '请显式填写特性编号、名称及产品/过程类型；不根据编号前缀或名称猜测' });
          return;
        }
        const current = query('SELECT * FROM project_char WHERE project_id=? AND char_id=?', projectId, charId);
        const master = query('SELECT * FROM char_master WHERE char_id=?', charId);
        const special = text(row[3]);
        const sourceRef = text(row[4]);
        const formalCustomerClass = text(row[7]);
        const organizationClass = text(row[8]);
        const classificationAgreement = text(row[9]);
        if (formalCustomerClass && organizationClass
            && formalCustomerClass !== organizationClass && !classificationAgreement) {
          emit({ ruleId: 'special-characteristic', source: source(doc, rowId),
            target: { type: 'reference', id: 'project_char' }, values: { char_id: charId }, kind: 'needs_confirmation',
            message: '顾客分类与组织分类不同；需记录顾客同意/相关矩阵依据后再正式确认' });
          return;
        }
        // D-03：lsl/usl/target/unit/tol_text 作为一个整体穿透，避免只同步文本导致
        // CP/SPC/MSA 读到空规范。_syncMeta 可显式携带数值字段（API 兼容扩展）。
        const meta = doc.data._syncMeta?.chars?.[rowId] || {};
        const parsed = parseSpecification(row[2]);
        const unit = text(specificationValue(meta, parsed, current, master, 'unit'));
        const target = specificationNumber(specificationValue(meta, parsed, current, master, 'target'));
        const lsl = specificationNumber(specificationValue(meta, parsed, current, master, 'lsl'));
        const usl = specificationNumber(specificationValue(meta, parsed, current, master, 'usl'));
        const tolText = text(row[2]) || text(current?.tol_text) || text(master?.tol_text)
          || (lsl != null && usl != null ? `${lsl} ~ ${usl} ${unit}`.trim() : '');
        const values = { char_id: charId, name: text(row[1]), char_kind: charKind, is_special: special ? 1 : 0,
          special_symbol: special, source_type: doc.code, source_ref: sourceRef || `${doc.code}:${rowId}`,
          unit, target, lsl, usl, tol_text: tolText };
        values.description = [
          sourceRef && `识别依据：${sourceRef}`,
          formalCustomerClass && `顾客分类：${formalCustomerClass}`,
          organizationClass && `组织分类/对照：${organizationClass}`,
          classificationAgreement && `顾客同意依据：${classificationAgreement}`,
        ].filter(Boolean).join('；');
        emit({ ruleId: 'special-characteristic', source: source(doc, rowId),
          target: { type: 'project_char', id: current?.pchar_id || `PC-DS-${key(projectId, charId)}` }, values });
      });
      if (doc.code === 'P1-08') formRows(doc, 'tests', (row, rowId) => {
        docRow(doc, 'reliability-dvp', rowId, 'P2-03', 'dvp',
          { 2: text(row[0]), 3: text(row[3]), 4: [text(row[1]) && `条件：${text(row[1])}`,
            text(row[2]) && `样本量：${text(row[2])}`].filter(Boolean).join('；') }, 9, 'candidate');
      });
      if (doc.code === 'P1-12') formRows(doc, 'plan', (row, rowId) => {
        docRow(doc, 'assurance-dvp', rowId, 'P2-03', 'dvp',
          { 2: text(row[1]), 3: text(row[2]), 5: text(row[3]) }, 9, 'candidate');
      });
      if (doc.code === 'P1-09') formRows(doc, 'bom', (row, rowId) => {
        const header = query("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='DFMEA'", projectId);
        if (header && text(row[2])) emit({ ruleId: 'bom-dfmea', source: source(doc, rowId), kind: 'candidate',
          target: { type: 'fmea_node', id: `N-DS-${key(projectId, rowId)}`, fmeaId: header.fmea_id },
          values: { name: text(row[2]), desc: `BOM物料：${text(row[1])}；规格：${text(row[3])}；用量：${text(row[4])}；供应商：${text(row[5])}` },
          message: '初始BOM结构候选；仅引用零件/物料，不生成设计功能、失效或推断父子结构' });
        for (const target of ['P2-08', 'P3-02']) emit({ ruleId: `bom-reference:${target}`, source: source(doc, rowId),
          target: { type: 'doc', id: target }, kind: 'reference',
          values: { material_code: text(row[1]), name: text(row[2]), specification: text(row[3]), supplier: text(row[5]) } });
      });
      if (doc.code === 'P2-03') formRows(doc, 'dvp', (row, rowId) => {
        docRow(doc, 'dvp-production-test', rowId, 'P4-05', 'tests',
          { 0: text(row[2]), 1: text(row[4]), 2: text(row[3]) }, 6);
      });
      if (doc.code === 'P3-02') formRows(doc, 'pack', (row, rowId) => {
        docRow(doc, 'packaging-evaluation', rowId, 'P4-06', 'items',
          { 0: text(row[0]), 2: [`材料：${text(row[1])}`, `数量：${text(row[2])}`,
            `标识：${text(row[3])}`, `防护：${text(row[4])}`].join('；') }, 5);
      });
      if (doc.code === 'P0-10') formRows(doc, 'plan', (row, rowId) => {
        const phase = Number(row[0]);
        if (!Number.isInteger(phase) || phase < 0 || phase > 5 || !text(row[1])) {
          emit({ ruleId: 'project-task', source: source(doc, rowId), target: { type: 'reference', id: 'apqp_task' },
            values: {}, kind: 'needs_confirmation', message: '任务必须显式填写0–5阶段编号和名称，未推断所属阶段' });
          return;
        }
        emit({ ruleId: 'project-task', source: source(doc, rowId),
          target: { type: 'apqp_task', id: `task:${key(projectId, rowId)}` },
          values: { phase, name: text(row[1]), due: text(row[3]), owner: text(row[4]), deliverable: text(row[5]) },
          message: text(row[2]) ? `计划开始：${text(row[2])}；当前任务表仅有完成日期字段，开始日期保留来源证据` : '' });
      });
      const meta = DT.CATALOG.find(item => item.code === doc.code);
      const downstream = new Set([...(meta?.down || []), ...(REFERENCES[doc.code] || [])]);
      for (const item of DT.CATALOG) if (item.up?.includes(doc.code)) downstream.add(item.code);
      for (const code of downstream) emit({ ruleId: `catalog-reference:${code}`, source: source(doc, 'document'),
        target: { type: 'doc', id: code }, kind: 'reference',
        values: { source_document: doc.code, approved_revision: doc.revision, version: doc.version } });
    }
    const approvedByCode = new Map(docs.map(doc => [doc.code, doc]));
    for (const mapping of all('SELECT * FROM deliverable_field_mapping WHERE project_id=?', projectId)) {
      const doc = approvedByCode.get(mapping.source_code);
      if (!doc) continue;
      const config = parse(mapping.mapping_json);
      const sourceRows = Array.isArray(doc.data[config.sourceTable]) ? doc.data[config.sourceTable] : [];
      const sourceIds = rowsMeta(doc.data, config.sourceTable);
      const target = query('SELECT * FROM project_doc WHERE project_id=? AND doc_code=?',
        projectId, mapping.target_code);
      const targetData = parse(target?.data_json);
      const targetRows = Array.isArray(targetData[config.targetTable]) ? targetData[config.targetTable] : [];
      const targetIds = rowsMeta(targetData, config.targetTable);
      const sourceKeyCounts = new Map();
      for (const row of sourceRows) {
        const value = text(row?.[config.sourceKey]);
        if (value) sourceKeyCounts.set(value, (sourceKeyCounts.get(value) || 0) + 1);
      }
      const targetKeyCounts = new Map();
      for (const row of targetRows) {
        const value = text(row?.[config.targetKey]);
        if (value) targetKeyCounts.set(value, (targetKeyCounts.get(value) || 0) + 1);
      }
      formRows(doc, config.sourceTable, (row, rowId) => {
        const matchValue = text(row[config.sourceKey]);
        if (!matchValue || sourceKeyCounts.get(matchValue) !== 1) {
          emit({ ruleId: `manual-field-map:${mapping.mapping_id}`, source: source(doc, rowId),
            target: { type: 'reference', id: mapping.target_code }, values: {}, kind: 'needs_confirmation',
            message: '上游匹配键为空或不唯一；请整理匹配键后重新批准来源' });
          return;
        }
        if (targetKeyCounts.get(matchValue) > 1) {
          emit({ ruleId: `manual-field-map:${mapping.mapping_id}`, source: source(doc, rowId),
            target: { type: 'reference', id: mapping.target_code }, values: {}, kind: 'needs_confirmation',
            message: '下游存在多个相同匹配键，未选择或覆盖任何行；请先人工消除重复' });
          return;
        }
        const index = targetRows.findIndex(item => text(item?.[config.targetKey]) === matchValue);
        const targetRowId = index < 0 ? `DSR-${key(mapping.mapping_id, rowId)}` : targetIds[index];
        if (index >= 0 && (!targetRowId || targetIds.filter(id => id === targetRowId).length !== 1)) {
          emit({ ruleId: `manual-field-map:${mapping.mapping_id}`, source: source(doc, rowId),
            target: { type: 'reference', id: mapping.target_code }, values: {}, kind: 'needs_confirmation',
            message: '匹配到的下游表格行缺少唯一稳定ID；请保存下游文档后重新同步' });
          return;
        }
        const values = Object.fromEntries([
          ...config.fields.map(field => [String(field.targetIndex), text(row[field.sourceIndex])]),
          [String(config.targetKey), matchValue],
        ]);
        docRow(doc, `manual-field-map:${mapping.mapping_id}`, rowId, mapping.target_code,
          config.targetTable, values, Math.max(...Object.keys(values).map(Number)) + 1,
          'field', `按${config.sourceKeyLabel}=${matchValue}匹配并填充下游字段`, targetRowId);
      });
    }
    syncPublishedModules(projectId, emit, docRow);
    for (const item of all('SELECT * FROM deliverable_sync_item WHERE project_id=? AND managed=1', projectId)) {
      if (touched.has(item.sync_id) || item.state === 'source_missing') continue;
      item.state = 'source_missing';
      item.message = '来源行已从最新批准版本移除或来源已失效；保留下游内容，不级联删除';
      item.updated_at = stamp();
      saveItem(item);
      summary.invalidated += 1;
    }
    return summary;
  });
}

function syncPublishedModules(projectId, emit, docRow) {
  for (const step of all("SELECT * FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND status='已发布'", projectId)) {
    DB.db.prepare(`INSERT OR IGNORE INTO deliverable_sync_snapshot
      (project_id,source_code,object_id,version,snapshot_json,captured_at) VALUES(?,?,?,?,?,?)`)
      .run(projectId, 'P3-04', step.step_id, step.ver || 'V1.0', json(step), stamp());
  }
  const published = all(`SELECT s.* FROM deliverable_sync_snapshot s
    JOIN process_step p ON p.step_id=s.object_id AND p.project_id=s.project_id
    WHERE s.project_id=? AND s.source_code='P3-04' AND p.pfd_mode='PROCESS' AND COALESCE(p.status,'')<>'作废'
      AND s.rowid=(SELECT MAX(s2.rowid) FROM deliverable_sync_snapshot s2
        WHERE s2.project_id=s.project_id AND s2.source_code=s.source_code AND s2.object_id=s.object_id)`, projectId);
  for (const snapshot of published) {
    const step = parse(snapshot.snapshot_json);
    docRow({ code: 'P3-04', version: snapshot.version, revision: snapshot.object_id },
      'pfd-sop', step.step_id, 'P3-07', 'steps',
      { 0: step.step_no || '', 1: step.name || '', 2: step.output_desc || '' }, 4);
    for (const targetCode of REFERENCES['P3-04']) emit({
      ruleId: `module-reference:${targetCode}`, source: { code: 'P3-04', rowId: step.step_id, version: snapshot.version, status: '已发布' },
      target: { type: 'doc', id: targetCode }, kind: 'reference',
      values: { step_id: step.step_id, step_no: step.step_no, version: snapshot.version },
    });
  }
  const header = query("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='DFMEA'", projectId);
  if (!header) return;
  if (header.status === '已发布') {
    const rows = all(`SELECT r.*,f.text function_text,c.name char_name,n.name focus_name
      FROM fmea_row r LEFT JOIN fmea_function f ON f.func_id=r.func_id
      LEFT JOIN char_master c ON c.char_id=r.char_id LEFT JOIN fmea_node n ON n.node_id=r.focus_node_id
      WHERE r.fmea_id=? AND COALESCE(n.status,'生效')<>'作废' ORDER BY r.seq`, header.fmea_id);
    DB.db.prepare(`INSERT OR IGNORE INTO deliverable_sync_snapshot
      (project_id,source_code,object_id,version,snapshot_json,captured_at) VALUES(?,?,?,?,?,?)`)
      .run(projectId, 'P2-01', header.fmea_id, header.rev, json(rows), stamp());
  }
  const snapshot = query(`SELECT * FROM deliverable_sync_snapshot
    WHERE project_id=? AND source_code='P2-01' AND object_id=? ORDER BY rowid DESC LIMIT 1`, projectId, header.fmea_id);
  if (!snapshot) return;
  for (const row of parse(snapshot.snapshot_json, [])) {
    const rowId = row.row_id;
    docRow({ code: 'P2-01', version: snapshot.version, revision: header.fmea_id },
      'dfmea-dvp', rowId, 'P2-03', 'dvp', { 1: row.char_name || row.function_text || row.focus_name || '' }, 9, 'candidate');
  }
  for (const targetCode of REFERENCES['P2-01']) emit({
    ruleId: `module-reference:${targetCode}`, source: { code: 'P2-01', rowId: header.fmea_id, version: snapshot.version, status: '已发布' },
    target: { type: 'doc', id: targetCode }, kind: 'reference',
    values: { fmea_id: header.fmea_id, version: snapshot.version },
  });
}

function syncMsaPlanDocument(projectId, plans) {
  const values = { plan: plans.map(plan => [
    plan.char_name || plan.char_id || '', plan.gauge_code || plan.gauge_id || '', plan.gauge_name || '',
    plan.study_type === 'ATTRIBUTE' ? '属性/外部研究' : (plan.study_type || 'GRR'),
    plan.study_type === 'ATTRIBUTE' ? '按适用方法' : `${plan.parts}×${plan.operators}×${plan.trials}`,
    plan.planned_date || '', plan.owner || '', plan.status || '计划',
  ]) };
  return syncFields(projectId, {
    ruleId: 'msa-plan-view', source: { code: 'MSA_PLAN', rowId: 'plans', version: key(values), status: '实体派生' },
    target: { type: 'doc', id: 'P3-08' }, values,
    message: 'MSA计划实体的派生视图；不覆盖签署及其他表单字段',
  });
}

module.exports = {
  init, syncProject, syncFields, syncMsaPlanDocument, list, resolve,
  documentMappingOptions, configureFieldMapping, manualFieldMappings, documentRelations,
  parseSpecification, specificationFingerprint,
};
