#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(ROOT, "data", "qms.db");
const BASE = process.env.QMS_BASE || "http://127.0.0.1:8848/api";
const USER = "模拟项目经理";
const APPROVER = "模拟质量经理";
const TODAY = "2026-11-02";
let cookie = "";
let projectId = "";

const reports = {
  formsSaved: [],
  approvals: [],
  approvalFailures: [],
  modules: {},
  relations: {},
  dataErrors: [],
};

async function rawRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const nextCookie = response.headers.get("set-cookie");
  if (nextCookie) cookie = nextCookie.split(";")[0];
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function withProject(route) {
  if (!projectId || route.startsWith("/auth/")) return route;
  return route + (route.includes("?") ? "&" : "?") + "p=" + encodeURIComponent(projectId);
}

async function api(route, options = {}) {
  return rawRequest(BASE + withProject(route), options);
}

function rowIds(rows) {
  return rows.map(() => crypto.randomUUID());
}

function tableRows(rows) {
  return { rows, ids: rowIds(rows) };
}

function textFrom(label, row) {
  if (/项目名称/.test(label)) return "APQP 全阶段关系模拟验证";
  if (/零件号|型号/.test(label)) return "SIM-RJ-0.25W-10K";
  if (/^编制|拟制/.test(label)) return USER;
  if (/^审核|会签|批准$/.test(label)) return APPROVER;
  if (/日期/.test(label)) return `2026-11-${String(5 + row).padStart(2, "0")}`;
  if (/有效期|期限|完成日期/.test(label)) return `2026-12-${String(10 + row).padStart(2, "0")}`;
  if (/计划开始/.test(label)) return `2026-11-${String(3 + row).padStart(2, "0")}`;
  if (/负责人|责任人|姓名|评审人|发起方/.test(label)) {
    return ["模拟项目经理", "模拟设计工程师", "模拟工艺工程师", "模拟质量工程师"][row % 4];
  }
  if (/供应商/.test(label)) return ["模拟合金材料供应商", "模拟陶瓷基体供应商"][row % 2];
  if (/材料|物料/.test(label)) return ["镍铬合金带", "氧化铝陶瓷基体"][row % 2];
  if (/设备|量具|检具/.test(label)) return ["激光调阻机", "数显电桥"][row % 2];
  if (/工序/.test(label)) return ["010 来料检验", "020 成膜", "030 激光调阻"][row % 3];
  if (/类型（产品\/过程）/.test(label)) return row % 2 ? "PROCESS" : "PRODUCT";
  if (/类型（纳入\/不纳入\/要求）/.test(label)) return "纳入";
  if (/研究类型/.test(label)) return "GRR";
  if (/策略（/.test(label)) return "降低";
  if (/维度（质量\/成本\/交付）/.test(label)) return ["质量", "成本", "交付"][row % 3];
  if (/结论（是\/否\/不适用）/.test(label)) return "是";
  if (/结论|判定/.test(label)) return ["接受", "符合要求", "通过"][row % 3];
  if (/状态/.test(label)) return ["进行中", "计划", "已完成"][row % 3];
  if (/优先级/.test(label)) return ["中", "高", "低"][row % 3];
  if (/合格率/.test(label)) return (98.2 + row * 0.2).toFixed(1);
  if (/目标 Cpk|Cpk/.test(label)) return "1.67";
  if (/目标值/.test(label)) return String(10 + row);
  if (/公差/.test(label)) return "±1%";
  if (/数量|样本量|容量/.test(label)) return String(10 + row);
  if (/频次|频率/.test(label)) return "每2小时";
  if (/版本/.test(label)) return "V1.0";
  if (/编号|编码/.test(label)) return `SIM-${String(row + 1).padStart(3, "0")}`;
  if (/名称|项目$/.test(label)) return `模拟项目${row + 1}`;
  if (/要求|准则/.test(label)) return "满足模拟项目接受准则";
  if (/原因|根因/.test(label)) return "模拟原因：关键参数存在波动";
  if (/措施|行动/.test(label)) return "模拟措施：固化参数并增加首件确认";
  if (/备注/.test(label)) return "关系模拟验证数据";
  return `${label}-模拟${row + 1}`;
}

function specificRows(code, key, columns) {
  if (code === "P1-10" && key === "steps") {
    return [
      ["010", "来料检验", "检验", "数显电桥", "电阻值"],
      ["020", "成膜", "特殊过程", "真空镀膜机", "膜层厚度"],
      ["030", "激光调阻", "制造", "激光调阻机", "阻值精度"],
    ];
  }
  if (code === "P1-11" && key === "chars") {
    return [
      ["SIM-CH-001", "阻值精度", "±1%", "CC", "顾客图纸", "激光调阻", "PRODUCT", "顾客", "SIM-DWG-001", "Rev.A"],
      ["SIM-CH-002", "调阻深度", "20±3 μm", "CC", "工程规范", "激光调阻", "PROCESS", "组织", "SIM-SPEC-002", "Rev.A"],
      ["SIM-CH-003", "外观", "无裂纹、无污染", "SC", "顾客输入", "终检", "PRODUCT", "顾客", "SIM-CSR-003", "Rev.A"],
    ];
  }
  if (code === "P2-11" && key === "chars") {
    return [
      ["SIM-CH-001", "阻值精度", "±1%", "CC", "P1-11 初始识别", "激光调阻", "PRODUCT", "CC", "CC", "模拟顾客确认"],
      ["SIM-CH-002", "调阻深度", "20±3 μm", "CC", "P1-11 初始识别", "激光调阻", "PROCESS", "-", "CC", "组织批准"],
      ["SIM-CH-003", "外观", "无裂纹、无污染", "SC", "P1-11 初始识别", "终检", "PRODUCT", "SC", "SC", "模拟顾客确认"],
    ];
  }
  if (code === "P1-09" && key === "bom") {
    return [
      ["1", "MAT-SIM-001", "镍铬合金带", "厚度0.1 mm，电阻率符合规范", "1", "模拟合金材料供应商"],
      ["1", "MAT-SIM-002", "氧化铝陶瓷基体", "96% Al2O3，厚度0.25 mm", "1", "模拟陶瓷基体供应商"],
      ["2", "MAT-SIM-003", "端电极浆料", "银钯体系，适用车规", "2", "模拟电子浆料供应商"],
    ];
  }
  if (code === "P2-03" && key === "dvp") {
    return [
      ["1", "阻值精度", "全温区阻值测试", "±1%", "10件，四探针法", "模拟设计工程师", "2026-12-10", "待验证", "待判定"],
      ["2", "温度系数", "TCR试验", "≤±50 ppm/℃", "5件，-55～125℃", "模拟质量工程师", "2026-12-15", "待验证", "待判定"],
    ];
  }
  if (code === "P3-08" && key === "plan") {
    return [
      ["阻值精度", "G-014", "数显电桥", "GRR", "10×3×3", "2026-12-12", "模拟计量工程师", "计划"],
      ["调阻深度", "G-045", "涂层测厚仪", "GRR", "10×3×3", "2026-12-13", "模拟计量工程师", "计划"],
    ];
  }
  if (code === "P3-09" && key === "plan") {
    return [
      ["阻值精度", "030 激光调阻", "50", "每2小时", "1.67", "Cpk≥1.33"],
      ["调阻深度", "030 激光调阻", "50", "每2小时", "1.67", "Cpk≥1.33"],
    ];
  }
  if (code === "P4-05" && key === "tests") {
    return [
      ["阻值精度", "常温", "±1%", "10.02 kΩ", "合格", "SIM-RPT-001"],
      ["温度系数", "-55～125℃", "≤±50 ppm/℃", "38 ppm/℃", "合格", "SIM-RPT-002"],
    ];
  }
  if (code === "P4-01" && key === "output") {
    return [
      ["020 成膜", "基体、靶材", "合格膜层", "2", "98.8", "边缘厚度偏差"],
      ["030 激光调阻", "成膜基体", "调阻半成品", "1", "99.2", "阻值轻微偏移"],
    ];
  }
  if (code === "P4-01" && key === "samples") {
    return [
      ["SIM-LOT-001", "030 激光调阻", "SIM-CH-001", "SIM-RPT-001", "合格", "试生产样品"],
      ["SIM-LOT-002", "030 激光调阻", "SIM-CH-002", "SIM-RPT-002", "合格", "过程参数样品"],
    ];
  }
  return null;
}

function genericRows(code, key, columns, count = 2) {
  return Array.from({ length: count }, (_, row) =>
    columns.map(label => textFrom(label, row)));
}

async function generateDocument(code) {
  const doc = await api(`/docs/${encodeURIComponent(code)}`);
  const data = JSON.parse(JSON.stringify(doc.data || {}));
  data._syncRows ||= {};
  const cols = {};
  for (const section of doc.sections || []) {
    for (const field of section.fields || []) {
      if (field.type === "table") {
        cols[field.k] = field.cols || [];
        const specific = specificRows(code, field.k, field.cols || []);
        const rows = data[field.k]?.some(row => Array.isArray(row) && row.some(Boolean))
          ? data[field.k] : (specific || genericRows(code, field.k, field.cols || []));
        data[field.k] = rows;
        const oldIds = data._syncRows[field.k] || [];
        data._syncRows[field.k] = oldIds.length === rows.length && new Set(oldIds).size === rows.length
          ? oldIds : rowIds(rows);
      } else if (field.type === "select") {
        const options = field.options || [];
        if (!data[field.k]) data[field.k] = options.find(Boolean) || "";
      } else if (!data[field.k]) {
        data[field.k] = field.type === "date" ? TODAY : textFrom(field.label, 0);
      }
    }
  }
  await api(`/docs/${encodeURIComponent(code)}`, {
    method: "PUT",
    body: {
      data, cols, status: "草稿", version: doc.version || "V1.0",
      user: USER, change_note: "模拟项目：按交付物模板生成 1–3 条验证数据",
    },
  });
  reports.formsSaved.push(code);
}

async function submitAndApprove(code) {
  try {
    await api(`/docs/${encodeURIComponent(code)}/submit`, {
      method: "POST", body: { user: USER, note: "模拟项目提交审核" },
    });
    await api(`/docs/${encodeURIComponent(code)}/approve`, {
      method: "POST", body: { approved_by: APPROVER, note: "模拟项目批准" },
    });
    reports.approvals.push(code);
  } catch (error) {
    reports.approvalFailures.push({ code, message: error.message });
  }
}

function repairDuplicateSteps(db) {
  const rows = db.prepare(`SELECT step_id,step_no,name FROM process_step
    WHERE project_id=? AND COALESCE(status,'')<>'作废' ORDER BY seq,rowid`).all(projectId);
  const keep = new Map();
  for (const row of rows) {
    const key = `${row.step_no}|${row.name}`;
    const keeper = keep.get(key);
    if (!keeper) {
      keep.set(key, row.step_id);
      continue;
    }
    db.prepare('UPDATE cp_row SET step_id=? WHERE step_id=?').run(keeper, row.step_id);
    db.prepare('UPDATE fmea_row SET step_id=? WHERE step_id=?').run(keeper, row.step_id);
    db.prepare('DELETE FROM process_step WHERE step_id=?').run(row.step_id);
  }
}

async function publishPfdSteps() {
  const steps = await api("/steps");
  for (const step of steps) {
    if (step.status === "已发布") continue;
    await api(`/steps/${encodeURIComponent(step.step_id)}`, {
      method: "PATCH", body: {
        input_desc: step.input_desc || "模拟输入：上道工序半成品及受控工艺参数",
        output_desc: step.output_desc || `模拟输出：${step.name}合格半成品`,
        equipment: step.equipment || "模拟生产设备",
        change_summary: "模拟项目：发布过程流程图工序",
        status: "已发布",
        user: USER,
      },
    });
  }
  reports.modules.stepsPublished = (await api("/steps")).filter(step => step.status === "已发布").length;
}

async function ensureCharacterSpecs() {
  const chars = (await api("/project-chars")).items;
  for (const char of chars) {
    const isResistance = char.name.includes("阻值");
    const isDepth = char.name.includes("调阻");
    if (!isResistance && !isDepth) continue;
    await api(`/project-chars/${encodeURIComponent(char.pchar_id)}`, {
      method: "PATCH", body: {
        unit: isResistance ? "kΩ" : "μm",
        target: isResistance ? 10 : 20,
        lsl: isResistance ? 9.9 : 17,
        usl: isResistance ? 10.1 : 23,
        tol_text: isResistance ? "9.9 ~ 10.1 kΩ" : "17 ~ 23 μm",
        source_type: "模拟验证",
        source_ref: char.char_id,
        user: USER,
        note: "模拟项目补齐规范上下限，用于 MSA/CP/SPC 联动验证",
      },
    });
  }
}

function createFmeaRows(db) {
  const result = {};
  for (const type of ["DFMEA", "PFMEA"]) {
    const header = db.prepare("SELECT * FROM fmea_header WHERE project_id=? AND fmea_type=?")
      .get(projectId, type);
    if (!header) continue;
    const root = db.prepare(`SELECT * FROM fmea_node WHERE fmea_id=? AND node_type='STRUCTURE'
      ORDER BY level,seq LIMIT 1`).get(header.fmea_id);
    const projectChars = db.prepare(`SELECT pchar_id,char_id,name FROM project_char WHERE project_id=?`).all(projectId);
    const productChar = projectChars.find(item => item.name.includes("阻值")) || projectChars[0];
    const processChar = projectChars.find(item => item.name.includes("调阻")) || projectChars[1] || productChar;
    const steps = db.prepare(`SELECT step_id,step_no,name FROM process_step WHERE project_id=? ORDER BY seq`).all(projectId);
    const step = steps.find(item => item.name.includes("调阻")) || steps[0];
    for (let index = 0; index < 2; index += 1) {
      const suffix = `${type}-${index + 1}`;
      const structureId = `SIM-N-${projectId}-${suffix}-S`;
      const feId = `SIM-N-${projectId}-${suffix}-FE`;
      const fmId = `SIM-N-${projectId}-${suffix}-FM`;
      const fcId = `SIM-N-${projectId}-${suffix}-FC`;
      const funcId = `SIM-F-${projectId}-${suffix}`;
      const rowId = `SIM-R-${projectId}-${suffix}`;
      db.prepare(`INSERT OR REPLACE INTO fmea_node(
        node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc,level,status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        structureId, header.fmea_id, root?.node_id || null, "STRUCTURE", null, 10 + index,
        type === "DFMEA" ? `模拟电阻元件${index + 1}` : `模拟工序要素${index + 1}`,
        type === "DFMEA" ? productChar?.char_id || null : processChar?.char_id || null,
        "模拟结构节点", 2, "生效",
      );
      db.prepare(`INSERT OR REPLACE INTO fmea_function(
        func_id,node_id,text,status,source,seq,created_at,rationale
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        funcId, structureId,
        index ? "保持调阻深度在 20±3 μm 并满足过程能力要求" : "提供规定阻值 10 kΩ 且偏差不超过 ±1%",
        "正式", "模拟验证", 1, TODAY, "模拟项目正式功能",
      );
      const failureLabels = index
        ? ["过程能力不足", "调阻深度超差", "激光功率波动"]
        : ["客户无法获得稳定阻值", "阻值超出规定范围", "膜层厚度波动"];
      for (const [nodeId, nodeType, name] of [
        [feId, "FE", failureLabels[0]], [fmId, "FM", failureLabels[1]], [fcId, "FC", failureLabels[2]],
      ]) {
        db.prepare(`INSERT OR REPLACE INTO fmea_node(
          node_id,fmea_id,parent_id,node_type,node_subtype,seq,name,char_id,desc,level,status
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          nodeId, header.fmea_id, structureId, "FAILURE", nodeType, 20 + index,
          name, null, "模拟失效节点", 3, "生效",
        );
      }
      const s = index ? 7 : 8;
      const o = 4;
      const d = 5;
      const ap = db.prepare("SELECT ap FROM ap_matrix WHERE s=? AND o=? AND d=?").get(s, o, d)?.ap || "L";
      db.prepare(`INSERT OR REPLACE INTO fmea_row(
        row_id,fmea_id,focus_node_id,fe_id,fm_id,fc_id,char_id,step_id,s,o,d,ap,pc_text,dc_text,
        effect_ref,seq,s_plant,s_ship,s_user,filter_code,func_id,upstream_row_id,process_char_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        rowId, header.fmea_id, structureId, feId, fmId, fcId,
        type === "DFMEA" ? productChar?.char_id || null : null,
        type === "PFMEA" ? step?.step_id || null : null,
        s, o, d, ap, "参数联锁与首件确认", "首件检验、巡检与异常隔离",
        "SIM-EFFECT", index + 1, s, s, s, "", funcId, null,
        type === "PFMEA" ? processChar?.char_id || null : null,
      );
      db.prepare(`INSERT INTO fmea_decision(
        row_id,decision,rationale,approved_by,review_due,status,approved_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(row_id) DO UPDATE SET decision=excluded.decision,rationale=excluded.rationale,
        approved_by=excluded.approved_by,review_due=excluded.review_due,status=excluded.status,
        approved_at=excluded.approved_at`).run(
        rowId, "TAKE_ACTION", "模拟项目：采用过程联锁并持续监视关键参数",
        APPROVER, "2027-03-01", "已批准", TODAY,
      );
    }
    db.prepare(`UPDATE fmea_header SET status='已发布',rev='r1',published_at=?,
      published_by=?,approved_by=? WHERE fmea_id=?`).run(TODAY, USER, APPROVER, header.fmea_id);
    result[type] = 2;
  }
  reports.modules.fmea = result;
}

async function seedControlPlans() {
  const projectChars = (await api("/project-chars")).items;
  const steps = await api("/steps");
  const charResistance = projectChars.find(item => item.name.includes("阻值")) || projectChars[0];
  const charDepth = projectChars.find(item => item.name.includes("调阻")) || projectChars[1] || charResistance;
  const stepTrim = steps.find(item => item.name.includes("调阻")) || steps[0];
  const stepFinal = steps.find(item => item.name.includes("终检")) || steps[steps.length - 1];
  const stages = ["PROTO", "PILOT", "SOP"];
  reports.modules.cp = {};
  for (const stage of stages) {
    const page = await api(`/cp?stage=${stage}`);
    if (!page.rows.length) {
      await api("/cp/row", { method: "POST", body: {
        cp_id: page.cp.cp_id, step_id: stepTrim.step_id,
        project_char_id: charResistance.pchar_id, gauge_id: "G-014",
        measure_tech: "四探针电阻测试", sample_size: 5, freq_value: 2, freq_unit: "h",
        control_method: "首件确认 + 参数联锁 + 巡检",
        reaction_plan: "停线、隔离、通知工艺、复调后首件确认",
        is_spc: stage === "PILOT",
      } });
      await api("/cp/row", { method: "POST", body: {
        cp_id: page.cp.cp_id, step_id: stepFinal?.step_id || stepTrim.step_id,
        project_char_id: charDepth.pchar_id, gauge_id: "G-045",
        measure_tech: "涂层测厚仪测量", sample_size: 3, freq_value: 4, freq_unit: "h",
        control_method: "首件测量与巡检",
        reaction_plan: "隔离批次并重新校准设备",
        is_spc: false,
      } });
    }
    await api(`/cp/${encodeURIComponent(page.cp.cp_id)}`, {
      method: "PATCH", body: {
        status: "已批准", approved_by: APPROVER, effective_date: TODAY,
        part_no: "SIM-RJ-0.25W-10K", part_name: "模拟车规精密电阻器",
        ...(stage === "SOP" ? {
          safe_launch_applicability: "不要求",
          safe_launch_note: "模拟项目：顾客项目输入未要求安全投产加强遏制",
          safe_launch_status: "不要求",
        } : {}),
      },
    });
    const current = await api(`/cp?stage=${stage}`);
    reports.modules.cp[stage] = current.rows.length;
  }
}

async function completeActiveMsaPlans() {
  await api("/deliverable-links/sync", { method: "POST", body: {} });
  const msa = await api("/msa");
  const activePlans = msa.plans.filter(plan => plan.source_active !== 0);
  const completed = new Set(reports.modules.msa?.completed || []);
  const failures = new Map((reports.modules.msa?.failures || [])
    .map(item => [item.plan_id, item.message]));
  for (const plan of activePlans) {
    if (plan.status === "已完成") continue;
    try {
      if ((plan.study_type || "GRR") === "GRR" && plan.gauge_id && plan.project_char_id) {
        const simulated = await api("/msa/simulate", { method: "POST", body: {
          gauge_id: plan.gauge_id, project_char_id: plan.project_char_id,
          parts: plan.parts || 10, operators: plan.operators || 3, trials: plan.trials || 3,
          tolerance: plan.tolerance || 1, target_pct: 5,
        } });
        const study = await api("/msa", { method: "POST", body: {
          plan_id: plan.plan_id, data: simulated.data, operator: "模拟计量工程师",
        } });
        if (study.judgment === "接受") {
          await api(`/msa/${study.study_id}/complete`, {
            method: "PATCH", body: { completed_by: APPROVER },
          });
          completed.add(plan.plan_id);
          failures.delete(plan.plan_id);
        }
      } else {
        const study = await api("/msa/external", { method: "POST", body: {
          plan_id: plan.plan_id, evidence_ref: `SIM-MSA-${plan.plan_id}`,
          method: "模拟受控研究报告", judgment: "接受", studied_at: TODAY,
          operator: "模拟计量工程师",
        } });
        await api(`/msa/${study.study_id}/complete`, {
          method: "PATCH", body: { completed_by: APPROVER },
        });
        completed.add(plan.plan_id);
        failures.delete(plan.plan_id);
      }
    } catch (error) {
      failures.set(plan.plan_id, error.message);
    }
  }
  reports.modules.msa = {
    plans: activePlans.length,
    completed: [...completed],
    failures: [...failures.entries()].map(([plan_id, message]) => ({ plan_id, message })),
  };
}

async function seedMsaAndSpc() {
  await completeActiveMsaPlans();
  const pilot = await api("/cp?stage=PILOT");
  const spcRow = pilot.rows.find(row => row.is_spc && row.project_char_id && row.gauge_id)
    || pilot.rows.find(row => row.project_char_id && row.gauge_id)
    || pilot.rows[0];
  if (!spcRow) throw new Error("没有可用于 SPC 的控制计划行");
  const chars = (await api("/project-chars")).items;
  const char = chars.find(item => item.pchar_id === spcRow.project_char_id)
    || chars.find(item => item.name.includes("阻值")) || chars[0];
  const monitor = await api(`/cp/${encodeURIComponent(spcRow.cp_row_id)}/monitor`, {
    method: "POST", body: {
      gauge_id: spcRow.gauge_id || "G-014", project_char_id: char.pchar_id,
      chart_type: "Xbar-R", subgroup_n: 3, freq_value: 2, freq_unit: "h",
      cpk_target: 1.67, approved_by: APPROVER, user: USER,
      review_note: "模拟项目监控配置批准",
    },
  });
  const target = Number(char.target) || 10;
  const spread = char.lsl != null && char.usl != null
    ? Math.abs(Number(char.usl) - Number(char.lsl)) * 0.08 : 0.04;
  const subgroups = Array.from({ length: 8 }, (_, index) => ({
    t: `SIM-${index + 1}`,
    v: [0, 1, 2].map(offset => +(target + (index - 3) * spread / 8 + (offset - 1) * spread / 20).toFixed(4)),
  }));
  let dataset;
  try {
    dataset = await api(`/spc/${encodeURIComponent(monitor.mon_id)}`, {
      method: "POST", body: { batch_no: "SIM-SPC-BATCH-001", subgroups },
    });
  } catch (error) {
    if (!/已导入|重复/.test(error.message)) throw error;
    const existing = await api(`/spc/${encodeURIComponent(monitor.mon_id)}`);
    const latest = existing.items[0];
    if (!latest) throw error;
    dataset = { dataset_id: latest.dataset_id };
  }
  reports.modules.spc = { monitor_id: monitor.mon_id, dataset_id: dataset.dataset_id, subgroups: subgroups.length };
}

async function seedPpap() {
  const results = [];
  for (let no = 1; no <= 18; no += 1) {
    try {
      await api(`/ppap/${no}`, { method: "PATCH", body: {
        status: "已完成", evidence: `SIM-PPAP-${String(no).padStart(2, "0")}`,
        note: "模拟项目证据引用",
      } });
      results.push({ no, status: "已完成" });
    } catch (error) {
      try {
        await api(`/ppap/${no}`, { method: "PATCH", body: {
          status: "未完成", evidence: `SIM-PPAP-${String(no).padStart(2, "0")}`,
          note: `模拟证据待上游复核：${error.message}`,
        } });
      } catch (ignored) {}
      results.push({ no, status: "待复核", message: error.message });
    }
  }
  reports.modules.ppap = results;
}

async function verifyProject() {
  const docs = await api("/docs");
  const steps = await api("/steps");
  const dfmea = await api("/fmea?type=DFMEA");
  const pfmea = await api("/fmea?type=PFMEA");
  const cps = {};
  for (const stage of ["PROTO", "PILOT", "SOP"]) {
    cps[stage] = (await api(`/cp?stage=${stage}`)).rows.length;
  }
  const msa = await api("/msa");
  const spc = await api("/spc");
  const ppap = await api("/ppap");
  const links = await api("/deliverable-links");
  const allForms = docs.phases.flatMap(phase => phase.docs)
    .filter(doc => doc.kind === "form" && !doc.tplId && !doc.isTpl);
  const formsWithData = allForms.filter(doc => {
    const found = docs.phases.flatMap(phase => phase.docs).find(item => item.code === doc.code);
    return found && (found.pct > 0 || ["草稿", "已批准"].includes(found.status));
  });
  reports.modules.steps = steps.length;
  reports.modules.dfmeaRows = dfmea.rows.length;
  reports.modules.pfmeaRows = pfmea.rows.length;
  reports.modules.msa = {
    ...reports.modules.msa,
    plans: msa.plans.length,
    active: msa.plans.filter(plan => plan.source_active !== 0).length,
    historical: msa.plans.filter(plan => plan.source_active === 0).length,
    studies: msa.studies.length,
  };
  reports.modules.spc = { ...reports.modules.spc, items: spc.items.length };
  reports.modules.ppapSummary = {
    total: ppap.elements.length,
    completed: ppap.elements.filter(item => item.status === "已完成").length,
  };
  reports.relations = {
    formsTotal: allForms.length,
    formsWithData: formsWithData.length,
    syncItems: links.items.length,
    summary: links.summary,
    cps,
  };
  const checks = [
    ["工序已生成", steps.length >= 3],
    ["PFD 工序已发布", steps.length >= 3 && steps.every(step => step.status === "已发布")],
    ["DFMEA 已填充", dfmea.rows.length >= 2],
    ["PFMEA 已填充", pfmea.rows.length >= 2],
    ["三阶段控制计划已填充", Object.values(cps).every(count => count >= 2)],
    ["MSA 计划已形成并完成", msa.plans.some(plan => plan.source_active !== 0)
      && msa.plans.filter(plan => plan.source_active !== 0).every(plan => plan.status === "已完成")],
    ["SPC 数据和监控已形成", spc.items.length >= 1],
    ["PPAP 18 项已初始化", ppap.elements.length === 18],
    ["PPAP 18 项已形成证据", ppap.elements.every(item => item.status === "已完成")],
    ["交付物关系已形成", links.items.length > 0],
    ["所有表单已有模拟内容或状态", formsWithData.length === allForms.length],
  ];
  reports.checks = checks.map(([name, ok]) => ({ name, ok }));
  if (checks.some(([, ok]) => !ok)) {
    throw new Error("模拟项目验收检查未全部通过：" + checks.filter(([, ok]) => !ok).map(([name]) => name).join("、"));
  }
}

async function main() {
  await rawRequest(BASE + "/auth/login", {
    method: "POST", body: { username: "admin", password: "admin123" },
  });
  const projects = await rawRequest(BASE + "/projects");
  const source = projects.list.find(item => item.project_id === "P-MVYSBPBA") || projects.list[0];
  const requestedProject = process.argv.find(arg => arg.startsWith("--project="))?.split("=")[1];
  if (requestedProject) {
    const existingProject = projects.list.find(item => item.project_id === requestedProject);
    if (!existingProject) throw new Error(`续跑项目不存在：${requestedProject}`);
    projectId = requestedProject;
    reports.project = existingProject;
  } else {
    const existing = new Set(projects.list.map(item => item.project_id));
    let sequence = 1;
    while (existing.has(`SIM-APQP-20261102-${String(sequence).padStart(2, "0")}`)) sequence += 1;
    projectId = `SIM-APQP-20261102-${String(sequence).padStart(2, "0")}`;
    const created = await rawRequest(BASE + "/projects", { method: "POST", body: {
      project_id: projectId,
      name: "APQP 全阶段交付物关系模拟验证",
      part_no: "SIM-RJ-0.25W-10K",
      customer: "模拟车规电子客户",
      family_id: source.family_id,
      series_id: source.series_id,
      owner: USER,
      start_date: TODAY,
      standard: "AIAG-VDA 2019",
    } });
    reports.project = created.project;
  }

  const docs = await api("/docs");
  const forms = docs.phases.flatMap(phase => phase.docs)
    .filter(doc => doc.kind === "form" && !doc.tplId && !doc.isTpl);
  for (const form of forms) await generateDocument(form.code);

  const approvalOrder = [
    "P0-01", "P0-02", "P0-05", "P0-10",
    "P1-I-01", "P1-I-06", "P1-07", "P1-08", "P1-09", "P1-10", "P1-11",
    "P1-12", "P1-13", "P1-15", "P1-16", "P1-17",
    "P2-02", "P2-03", "P2-04", "P2-06", "P2-07", "P2-08", "P2-09", "P2-10",
    "P2-11", "P2-12", "P2-13",
    "P3-02", "P3-03", "P3-05", "P3-07", "P3-08", "P3-09",
    "P4-01", "P4-05", "P4-06", "P4-08", "P5-04",
  ];
  for (const code of approvalOrder) await submitAndApprove(code);
  await api("/deliverable-links/sync", { method: "POST", body: {} });

  const db = new DatabaseSync(DB_PATH);
  try {
    repairDuplicateSteps(db);
    createFmeaRows(db);
  } finally {
    db.close();
  }
  await publishPfdSteps();
  await ensureCharacterSpecs();
  await seedControlPlans();
  await seedMsaAndSpc();
  await seedControlPlans();
  await api("/deliverable-links/sync", { method: "POST", body: {} });
  await completeActiveMsaPlans();
  await seedPpap();
  await verifyProject();

  const outDir = path.join(ROOT, "outputs", "simulation-validation");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${projectId}-validation.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(reports, null, 2), "utf8");
  const mdPath = path.join(outDir, `${projectId}-validation.md`);
  fs.writeFileSync(mdPath, [
    `# ${projectId} 模拟项目验证报告`,
    "",
    `- 项目：${reports.project.name}`,
    `- 零件号：${reports.project.part_no}`,
    `- 表单交付物：${reports.relations.formsTotal}`,
    `- 已填模拟数据表单：${reports.relations.formsWithData}`,
    `- 已批准交付物：${reports.approvals.length}`,
    `- 工序：${reports.modules.steps}`,
    `- DFMEA 行：${reports.modules.dfmeaRows}`,
    `- PFMEA 行：${reports.modules.pfmeaRows}`,
    `- CP 行：PROTO ${reports.relations.cps.PROTO} / PILOT ${reports.relations.cps.PILOT} / SOP ${reports.relations.cps.SOP}`,
    `- MSA 计划：有效 ${reports.modules.msa.active} / 历史版本 ${reports.modules.msa.historical}`,
    `- SPC 监控：${reports.modules.spc.items}`,
    `- PPAP：${reports.modules.ppapSummary.completed}/${reports.modules.ppapSummary.total} 完成`,
    `- 同步记录：${reports.relations.syncItems}`,
    "",
    "## 验收",
    ...reports.checks.map(item => `- ${item.ok ? "通过" : "失败"}：${item.name}`),
    "",
    "## 批准失败",
    ...(reports.approvalFailures.length
      ? reports.approvalFailures.map(item => `- ${item.code}：${item.message}`)
      : ["- 无"]),
  ].join("\n"), "utf8");
  console.log(JSON.stringify({
    ok: true, project_id: projectId, report: mdPath, json: jsonPath,
    forms: reports.relations.formsWithData, approvals: reports.approvals.length,
    checks: reports.checks,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
