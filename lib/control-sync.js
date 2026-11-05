'use strict';

const DB = require('./db');
const DS = require('./deliverable-sync');
const approved = new Set(['已批准', '已冻结']);
const all = (sql, ...args) => DB.db.prepare(sql).all(...args);
const one = (sql, ...args) => DB.db.prepare(sql).get(...args);
const parse = (value, fallback = {}) => {
  try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; }
};
const id = (...parts) => DB.hash(parts).slice(0, 28);
const unique = values => [...new Set(values.filter(value => value != null && String(value).trim()))];
const source = (code, rowId, version, status = '已批准') => ({
  code, rowId, version: version || 'V1.0', status,
});

function init() {
  DS.init();
  DB.db.exec(`
    CREATE TABLE IF NOT EXISTS pfd_fmea_link(
      project_id TEXT NOT NULL, step_id TEXT NOT NULL, node_id TEXT NOT NULL,
      PRIMARY KEY(project_id,step_id), UNIQUE(node_id)
    );
    CREATE TABLE IF NOT EXISTS cp_fmea_link(
      cp_row_id TEXT NOT NULL, fmea_row_id TEXT NOT NULL,
      PRIMARY KEY(cp_row_id,fmea_row_id)
    );
    CREATE TABLE IF NOT EXISTS cp_stage_link(
      source_cp_row_id TEXT NOT NULL, target_cp_row_id TEXT NOT NULL, target_cp_id TEXT NOT NULL,
      PRIMARY KEY(source_cp_row_id,target_cp_id), UNIQUE(target_cp_row_id)
    );
  `);
}

function snapshot(projectId, code, objectId, version, value) {
  DB.db.prepare(`INSERT OR IGNORE INTO deliverable_sync_snapshot(
    project_id,source_code,object_id,version,snapshot_json,captured_at
  ) VALUES(?,?,?,?,?,?)`).run(projectId, code, objectId, version || 'V1.0', JSON.stringify(value), DB.now());
}

function publishedPfmea(projectId) {
  const header = one("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='PFMEA'", projectId);
  if (!header) return null;
  if (header.status === '已发布') {
    const rows = all(`SELECT r.* FROM fmea_row r LEFT JOIN fmea_node n ON n.node_id=r.focus_node_id
      WHERE r.fmea_id=? AND COALESCE(n.status,'生效')<>'作废' ORDER BY r.seq,r.row_id`, header.fmea_id);
    const chars = {};
    for (const charId of unique(rows.flatMap(row => [row.char_id, row.process_char_id]))) {
      chars[charId] = one('SELECT * FROM project_char WHERE project_id=? AND char_id=?', projectId, charId)
        || one('SELECT * FROM char_master WHERE char_id=?', charId) || null;
    }
    snapshot(projectId, 'P3-06', header.fmea_id, header.rev, { header, rows, chars });
  }
  const row = one(`SELECT * FROM deliverable_sync_snapshot
    WHERE project_id=? AND source_code='P3-06' AND object_id=? ORDER BY rowid DESC LIMIT 1`,
  projectId, header.fmea_id);
  return row ? parse(row.snapshot_json) : null;
}

function issue(projectId, ruleId, upstream, message, target = { type: 'reference', id: 'PFMEA' }) {
  return DS.syncFields(projectId, {
    ruleId, source: upstream, target, values: {}, kind: 'needs_confirmation', message,
  });
}

function invalidate(projectId, ruleId, rowIds) {
  const active = new Set(rowIds);
  for (const row of all('SELECT * FROM deliverable_sync_item WHERE project_id=? AND rule_id=?', projectId, ruleId)) {
    if (active.has(row.source_row_id) || row.state === 'source_missing') continue;
    DB.db.prepare(`UPDATE deliverable_sync_item SET state='source_missing',source_status='来源已失效',
      message='来源已从最新发布或批准版本移除；保留下游记录和历史分析，不级联删除',updated_at=?
      WHERE sync_id=? AND project_id=?`).run(DB.now(), row.sync_id, projectId);
  }
}

function fromPfd(projectId, { with4m = false } = {}) {
  const header = one("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type='PFMEA'", projectId);
  if (!header) throw new Error('当前项目还没有 PFMEA');
  return DB.tx(() => {
    const steps = all(`SELECT * FROM process_step WHERE project_id=? AND pfd_mode='PROCESS'
      AND COALESCE(status,'')<>'作废' ORDER BY seq,step_id`, projectId);
    const byId = new Map(steps.map(step => [step.step_id, step]));
    const result = {
      ok: true, steps: steps.length, nodes: 0, created_nodes: 0, replaced: 0, created: [], conflicts: 0,
      draft_steps: steps.filter(step => step.status !== '已发布').length,
      published_steps: steps.filter(step => step.status === '已发布').length,
    };
    const legacy = one(`SELECT node_id FROM fmea_node n
      WHERE fmea_id=? AND node_type='STRUCTURE' AND COALESCE(status,'生效')<>'作废'
        AND desc LIKE '%由工序流程图生成%'
        AND NOT EXISTS(SELECT 1 FROM pfd_fmea_link l WHERE l.node_id=n.node_id)
      LIMIT 1`, header.fmea_id);
    const visiting = new Set();
    const handled = new Set();
    const syncStep = step => {
      if (handled.has(step.step_id)) return;
      if (visiting.has(step.step_id)) throw new Error('PFD 工序父子关系存在循环');
      visiting.add(step.step_id);
      snapshot(projectId, 'P3-04', step.step_id, step.ver || 'V1.0', step);
      const upstream = source('P3-04', step.step_id, step.ver,
        step.status === '已发布' ? '已批准' : '草稿');
      const linked = one('SELECT node_id FROM pfd_fmea_link WHERE project_id=? AND step_id=?', projectId, step.step_id);
      if (legacy && !linked) {
        issue(projectId, `control:pfd-legacy:${header.fmea_id}`, upstream,
          '已有旧版生成结构缺少工序ID绑定；保留原结构、功能和失效分析，请先确认工序与节点映射');
        result.conflicts += 1;
      } else if (step.parent_step_id && !byId.has(step.parent_step_id)) {
        issue(projectId, `control:pfd-parent:${header.fmea_id}`, upstream,
          '所属工序尚未发布，未把工步错误挂到其他层级');
        result.conflicts += 1;
      } else {
        if (step.parent_step_id) syncStep(byId.get(step.parent_step_id));
        const parent = step.parent_step_id
          ? one('SELECT node_id FROM pfd_fmea_link WHERE project_id=? AND step_id=?', projectId, step.parent_step_id)
          : one("SELECT node_id FROM fmea_node WHERE fmea_id=? AND node_id=? AND COALESCE(status,'生效')<>'作废'",
            header.fmea_id, `N-${header.fmea_id}-ROOT`);
        const nodeId = linked?.node_id || `N-CS-${id(projectId, step.step_id)}`;
        const parentLevel = parent ? one('SELECT level FROM fmea_node WHERE node_id=?', parent.node_id)?.level || 1 : 0;
        const synced = DS.syncFields(projectId, {
          ruleId: `control:pfd-pfmea:${header.fmea_id}`, source: upstream,
          target: { type: 'fmea_node', id: nodeId, fmeaId: header.fmea_id },
          values: {
            name: `${step.step_no || ''} ${step.name || ''}`.trim(),
            desc: [step.step_type, step.equipment && `设备：${step.equipment}`,
              step.input_desc && `输入：${step.input_desc}`, step.output_desc && `输出：${step.output_desc}`]
              .filter(Boolean).join('；'),
            parent_id: parent?.node_id || null, level: parentLevel + 1,
          },
        });
        result.conflicts += synced.conflict;
        if (synced.created) result.created.push(nodeId);
        if (one('SELECT node_id FROM fmea_node WHERE node_id=? AND fmea_id=?', nodeId, header.fmea_id)) {
          DB.db.prepare('INSERT OR IGNORE INTO pfd_fmea_link(project_id,step_id,node_id) VALUES(?,?,?)')
            .run(projectId, step.step_id, nodeId);
          if (with4m) for (const kind of ['人', '机', '法', '环']) {
            const elementId = `N-CS-${id(projectId, step.step_id, kind)}`;
            const element = DS.syncFields(projectId, {
              ruleId: `control:pfd-4m:${header.fmea_id}`,
              source: source('P3-04', `${step.step_id}:${kind}`, step.ver,
                step.status === '已发布' ? '已批准' : '草稿'),
              target: { type: 'fmea_node', id: elementId, fmeaId: header.fmea_id },
              values: { name: kind, parent_id: nodeId, level: parentLevel + 2,
                desc: kind === '机' && step.equipment ? `设备：${step.equipment}` : `${step.name}的${kind}要素，待人工分析` },
            });
            if (element.created) result.created.push(elementId);
            result.conflicts += element.conflict;
          }
        }
      }
      visiting.delete(step.step_id);
      handled.add(step.step_id);
    };
    for (const step of steps) syncStep(step);
    const liveSteps = all("SELECT step_id FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'", projectId);
    invalidate(projectId, `control:pfd-pfmea:${header.fmea_id}`, liveSteps.map(step => step.step_id));
    result.created_nodes = result.created.length;
    result.nodes = one(`SELECT COUNT(*) n FROM fmea_node
      WHERE fmea_id=? AND node_type='STRUCTURE' AND COALESCE(status,'生效')<>'作废'`,
    header.fmea_id).n;
    return result;
  });
}

function emptyResult() {
  return { created: [], basic: [], kept: 0, overridden: [], conflicts: 0 };
}

function applyCp(projectId, cp, upstream, ruleId, targetId, values, result, basic = false, confirmation = false) {
  const old = one('SELECT * FROM cp_row WHERE cp_row_id=? AND cp_id=?', targetId, cp.cp_id);
  if (old?.override_flag) result.overridden.push(old.cp_row_id);
  const synced = DS.syncFields(projectId, {
    ruleId, source: upstream, target: { type: 'cp_row', id: targetId, cpId: cp.cp_id },
    values, requireConfirmation: confirmation,
  });
  result.conflicts += synced.conflict;
  if (synced.created) (basic ? result.basic : result.created).push(targetId);
  else if (old) result.kept += 1;
  return one('SELECT * FROM cp_row WHERE cp_row_id=? AND cp_id=?', targetId, cp.cp_id);
}

function generate(cpId) {
  const cp = one('SELECT * FROM control_plan WHERE cp_id=?', cpId);
  if (!cp) throw new Error('CP 不存在');
  return DB.tx(() => {
    const result = emptyResult();
    if (!['PILOT', 'SOP'].includes(cp.stage)) return result;
    const published = publishedPfmea(cp.project_id);
    const groups = new Map();
    for (const row of published?.rows || []) {
      if (!row.step_id || !one(`SELECT 1 FROM process_step
        WHERE step_id=? AND project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'`, row.step_id, cp.project_id)) continue;
      for (const charId of unique([row.char_id, row.process_char_id])) {
        const groupKey = `${row.step_id}|${charId}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { stepId: row.step_id, charId, rows: [] });
        groups.get(groupKey).rows.push(row);
      }
    }
    for (const [groupKey, group] of groups) {
      const rowIds = group.rows.map(row => row.row_id);
      const linked = all(`SELECT c.* FROM cp_row c
        WHERE c.cp_id=? AND c.step_id=? AND c.char_id=? AND (
          EXISTS(SELECT 1 FROM cp_fmea_link l WHERE l.cp_row_id=c.cp_row_id
            AND l.fmea_row_id IN (${rowIds.map(() => '?').join(',')}))
          OR c.fmea_row_id IN (${rowIds.map(() => '?').join(',')})
        ) ORDER BY c.seq,c.cp_row_id`, cpId, group.stepId, group.charId, ...rowIds, ...rowIds);
      const deterministicId = `CP-CS-${id(cpId, groupKey)}`;
      const old = linked[0] || one('SELECT * FROM cp_row WHERE cp_row_id=? AND cp_id=?', deterministicId, cpId);
      if (cp.stage === 'SOP' && !old) continue;
      if (cp.stage === 'SOP' && old
        && one('SELECT 1 FROM cp_stage_link WHERE target_cp_row_id=?', old.cp_row_id)
        && !one('SELECT 1 FROM deliverable_sync_item WHERE project_id=? AND rule_id=? AND source_row_id=?',
          cp.project_id, `control:pfmea-cp:${cpId}`, groupKey)) continue;
      const char = published.chars[group.charId];
      if (!char) {
        issue(cp.project_id, `control:pfmea-char:${cpId}`, source('P3-06', groupKey, published.header.rev),
          '已发布 PFMEA 的特性来源缺失，未用名称或通用规范猜测控制要求', { type: 'reference', id: cpId });
        result.conflicts += 1;
        continue;
      }
      // published.chars 可能只命中 project_char（该特性未进字典）；此时不能再走 ensureProjectChar，
      // 它要求先存在于 char_master，否则整批 CP 生成会抛错中止
      const projectChar = one('SELECT * FROM project_char WHERE project_id=? AND char_id=?', cp.project_id, group.charId)
        || (one('SELECT 1 FROM char_master WHERE char_id=?', group.charId)
          ? DB.ensureProjectChar(cp.project_id, group.charId) : null);
      const spec = char.tol_text || (char.lsl != null && char.usl != null
        ? `${char.lsl} – ${char.usl} ${char.unit || ''}`.trim() : '');
      const targetId = old?.cp_row_id || deterministicId;
      const collision = !old && one('SELECT 1 FROM cp_row WHERE cp_id=? AND step_id=? AND char_id=?',
        cpId, group.stepId, group.charId);
      const target = applyCp(cp.project_id, cp, source('P3-06', groupKey, published.header.rev),
        `control:pfmea-cp:${cpId}`, targetId, {
          step_id: group.stepId, char_id: group.charId, project_char_id: projectChar?.pchar_id || null,
          fmea_row_id: rowIds[0], spec_text: spec,
          measure_tech: unique(group.rows.map(row => row.dc_text)).join('；'),
          control_method: unique(group.rows.map(row => row.pc_text)).join('；'),
          upstream_ver: `${published.header.fmea_id} ${published.header.rev}`,
        }, result, false, !!collision);
      if (target) for (const rowId of rowIds) {
        DB.db.prepare('INSERT OR IGNORE INTO cp_fmea_link(cp_row_id,fmea_row_id) VALUES(?,?)').run(target.cp_row_id, rowId);
      }
    }
    if (published) invalidate(cp.project_id, `control:pfmea-cp:${cpId}`, [...groups.keys()]);
    if (cp.stage === 'PILOT') {
      const covered = new Set(all('SELECT step_id FROM cp_row WHERE cp_id=?', cpId).map(row => row.step_id));
      for (const group of groups.values()) covered.add(group.stepId);
      for (const step of all("SELECT * FROM process_step WHERE project_id=? AND pfd_mode='PROCESS' AND status='已发布' ORDER BY seq", cp.project_id)) {
        if (covered.has(step.step_id)) continue;
        const targetId = `CP-CS-${id(cpId, step.step_id, 'basic')}`;
        applyCp(cp.project_id, cp, source('P3-04', step.step_id, step.ver),
          `control:pfd-cp:${cpId}`, targetId,
          { step_id: step.step_id, upstream_ver: `PFD ${step.step_id} ${step.ver || ''}` }, result, true);
      }
      invalidate(cp.project_id, `control:pfd-cp:${cpId}`, all(`SELECT step_id FROM process_step
        WHERE project_id=? AND pfd_mode='PROCESS' AND COALESCE(status,'')<>'作废'`, cp.project_id).map(step => step.step_id));
    }
    return result;
  });
}

function inheritStages(projectId) {
  const result = emptyResult();
  const plans = all('SELECT * FROM control_plan WHERE project_id=?', projectId);
  for (const [from, to] of [['PROTO', 'PILOT'], ['PILOT', 'SOP']]) {
    const sourcePlan = plans.find(plan => plan.stage === from);
    const targetPlan = plans.find(plan => plan.stage === to);
    if (!sourcePlan || !targetPlan || !approved.has(sourcePlan.status)) continue;
    snapshot(projectId, `CP:${from}`, sourcePlan.cp_id, sourcePlan.rev, {
      header: sourcePlan, rows: all('SELECT * FROM cp_row WHERE cp_id=? ORDER BY seq,cp_row_id', sourcePlan.cp_id),
    });
    const saved = one(`SELECT snapshot_json FROM deliverable_sync_snapshot
      WHERE project_id=? AND source_code=? AND object_id=? AND version=?`,
    projectId, `CP:${from}`, sourcePlan.cp_id, sourcePlan.rev || 'V1.0');
    const rows = parse(saved.snapshot_json).rows;
    for (const row of rows) {
      const link = one('SELECT * FROM cp_stage_link WHERE source_cp_row_id=? AND target_cp_id=?', row.cp_row_id, targetPlan.cp_id);
      const targetId = link?.target_cp_row_id || `CP-CS-${id(targetPlan.cp_id, row.cp_row_id)}`;
      const old = one('SELECT * FROM cp_row WHERE cp_id=? AND cp_row_id=?', targetPlan.cp_id, targetId);
      const collision = !old && one(`SELECT 1 FROM cp_row WHERE cp_id=? AND step_id IS ?
        AND char_id IS ?`, targetPlan.cp_id, row.step_id, row.char_id);
      const values = {};
      for (const field of ['step_id', 'char_id', 'project_char_id', 'fmea_row_id', 'spec_text', 'measure_tech',
        'gauge_id', 'sample_size', 'freq_value', 'freq_unit', 'freq_trigger', 'control_method', 'reaction_plan', 'is_spc']) {
        values[field] = row[field];
      }
      values.upstream_ver = `${sourcePlan.cp_id} ${sourcePlan.rev}`;
      const target = applyCp(projectId, targetPlan, source(`CP:${from}`, row.cp_row_id, sourcePlan.rev),
        `control:cp-stage:${targetPlan.cp_id}`, targetId, values, result, false, !!collision);
      if (!target) continue;
      DB.db.prepare(`INSERT OR IGNORE INTO cp_stage_link(source_cp_row_id,target_cp_row_id,target_cp_id)
        VALUES(?,?,?)`).run(row.cp_row_id, target.cp_row_id, targetPlan.cp_id);
      for (const linked of all('SELECT fmea_row_id FROM cp_fmea_link WHERE cp_row_id=?', row.cp_row_id)) {
        DB.db.prepare('INSERT OR IGNORE INTO cp_fmea_link(cp_row_id,fmea_row_id) VALUES(?,?)')
          .run(target.cp_row_id, linked.fmea_row_id);
      }
    }
    invalidate(projectId, `control:cp-stage:${targetPlan.cp_id}`, rows.map(row => row.cp_row_id));
  }
  return result;
}

function syncProject(projectId) {
  if (!one('SELECT 1 FROM project WHERE project_id=?', projectId)) throw new Error('项目不存在');
  return DB.tx(() => {
    const pfd = one("SELECT 1 FROM fmea_header WHERE project_id=? AND fmea_type='PFMEA'", projectId)
      ? fromPfd(projectId) : { created: [], conflicts: 0 };
    const stages = inheritStages(projectId);
    const cp = emptyResult();
    for (const plan of all("SELECT * FROM control_plan WHERE project_id=? AND stage IN ('PILOT','SOP')", projectId)) {
      const result = generate(plan.cp_id);
      cp.created.push(...result.created);
      cp.basic.push(...result.basic);
      cp.kept += result.kept;
      cp.overridden.push(...result.overridden);
      cp.conflicts += result.conflicts;
    }
    return { pfd, cp, stages };
  });
}

module.exports = { init, syncProject, fromPfd, generate };
