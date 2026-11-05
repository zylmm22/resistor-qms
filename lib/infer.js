'use strict';
/**
 * 模板推断：把解析出的 Excel/Word 内容转成「可在线编辑的表单结构」，
 * 并按单元格内容自动生成填写说明（规则引擎，非模型生成）。
 */

/* ------------------------------------------------------------------ 说明规则 */
const RULES = [
  [/(日期|时间|年月日)/, '按 YYYY-MM-DD 填写；涉及周期的可写区间'],
  [/(编号|编码|单号|图号|料号|批号)/, '按受控编号规则填写，须唯一、可追溯'],
  [/(版本|版次|版号|rev)/i, '填写受控版本号，如 V1.0；升版需记录变更'],
  [/(样本|容量|数量|件数|次数|个数)/, '填写整数，不写单位（单位见表头或说明）'],
  [/(比例|百分比|率|%)/, '填写百分比数值，如 98.5，不带 % 号'],
  [/(责任人|负责人|编制|审核|批准|担当|操作者|评价人)/, '填写姓名；不接受“工艺”“质量”等部门代称'],
  [/(判定|结论|是否合格|合格性)/, '按判定准则填写：合格 / 不合格，或 通过 / 不通过'],
  [/(备注|说明|补充|其他)/, '只写必要补充，避免与正文重复；无内容填“—”'],
  [/(工序|工步|工位|步骤)/, '填写工序号 + 工序名称，须与 PFD 完全一致'],
  [/(特性|规格|公差|标准值|目标值)/, '填写特性名称与规格公差；建议同时标注特性编号'],
  [/(参数|设定值|温度|压力|功率|速度|频率|真空度|粘度)/, '填写设定值与公差，必须注明单位'],
  [/(设备|工装|夹具|检具|量具|仪器)/, '填写编号 + 名称，须与设备/检具台账一致'],
  [/(材料|物料|零件|部件|原材料)/, '填写物料编码 + 名称，须与 BOM 一致'],
  [/(客户|顾客)/, '填写客户全称或客户代码，与项目立项信息一致'],
  [/(工厂|厂区|车间|产线|线体)/, '填写工厂/产线全称或代码，与产能规划一致'],
  [/(部门)/, '填写责任部门全称，不用简称'],
  [/(阶段|里程碑|节点)/, '填写 APQP 阶段（P1–P5）或具体日期节点'],
  [/(原因|机理|失效)/, '描述直接原因，避免因果倒置；一句话说清“为什么会这样”'],
  [/(措施|对策|行动)/, '填写可执行动作（谁、做什么、做到什么程度），不写“加强管理”'],
  [/(签名|签字|盖章)/, '由审批流自动写入，无需手工填写'],
  [/(数量|用量|库存)/, '填写数字，单位与表头保持一致'],
];

const DEFAULT_HINT = '按模板要求填写，内容须与上游文件（DFMEA / PFD / 控制计划）保持一致';

function hintFor(label) {
  const t = String(label || '').trim();
  if (!t) return DEFAULT_HINT;
  for (const [re, h] of RULES) if (re.test(t)) return h;
  if (t.length <= 4) return '按列名含义填写，保持与同类行一致的颗粒度';
  return DEFAULT_HINT;
}

const CODE_HINT = '填写本行对应的编号；若上级文件已有编号，直接引用，不要新编';

/** 占位符视为空：只要不含文字/数字/汉字，就当作未填写（＿、___、—、□、○ 等） */
const isBlank = v => {
  const t = String(v == null ? '' : v).trim();
  if (!t) return true;
  return !/[\u4e00-\u9fa5A-Za-z0-9]/.test(t);
};

/* ------------------------------------------------------------------ Excel */
function inferFromXlsx(parsed, opts = {}) {
  // 未指定时，选「内容最多」的工作表（通常是真正的表单，而不是说明页）
  let idx = opts.sheetIndex;
  if (idx == null) {
    let best = 0, bestN = -1;
    parsed.sheets.forEach((s, i) => { if (s.cells.size > bestN) { bestN = s.cells.size; best = i; } });
    idx = best;
  }
  const sh = parsed.sheets[Math.min(idx, parsed.sheets.length - 1)];
  const cellAt = (r, c) => sh.cells.get(r + ',' + c) || null;

  // 计算实际使用范围
  let maxR = 0, maxC = 0;
  for (const k of sh.cells.keys()) {
    const [r, c] = k.split(',').map(Number);
    maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
  }

  // 合并信息索引
  const cover = new Map();   // "r,c" → anchor key
  const anchor = new Map();  // "r,c" → {cs, rs}
  for (const m of sh.merges) {
    maxR = Math.max(maxR, m.r2); maxC = Math.max(maxC, m.c2);
    for (let r = m.r1; r <= m.r2; r++) {
      for (let c = m.c1; c <= m.c2; c++) {
        if (r === m.r1 && c === m.c1) anchor.set(r + ',' + c, { cs: m.c2 - m.c1 + 1, rs: m.r2 - m.r1 + 1 });
        else cover.set(r + ',' + c, m.r1 + ',' + m.c1);
      }
    }
  }

  // 列宽
  const cols = [];
  for (let c = 0; c <= maxC; c++) {
    const w = sh.colWidths[c];
    cols.push({ w: w ? Math.min(60, Math.max(8, Math.round(w))) : 14 });
  }

  // 行内容快照
  const grid = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) {
      const k = r + ',' + c;
      if (cover.has(k)) { row.push({ covered: true }); continue; }
      const cell = cellAt(r, c);
      const a = anchor.get(k);
      row.push({
        v: cell ? cell.v : '',
        bold: cell ? cell.bold : false,
        cs: a ? a.cs : 1,
        rs: a ? a.rs : 1,
      });
    }
    grid.push(row);
  }

  /* ---- 表头识别 ---- */
  // 覆盖单元格（被合并盖住）应继承锚点单元格的空白状态，否则空白合并区会被误认为连续内容
  const runHasContent = (r, c) => {
    const cell = grid[r][c];
    if (cell.covered) {
      const key = cover.get(r + ',' + c);
      if (!key) return false;
      const [ar, ac] = key.split(',').map(Number);
      return !isBlank(grid[ar][ac].v);
    }
    return !isBlank(cell.v);
  };
  const longestRun = r => {
    let best = 0, cur = 0;
    for (let c = 0; c <= maxC; c++) {
      if (runHasContent(r, c)) { cur += 1; best = Math.max(best, cur); } else cur = 0;
    }
    return best;
  };
  const nonBlank = r => grid[r].reduce((n, c) => n + (c.covered ? 0 : (isBlank(c.v) ? 0 : 1)), 0);

  const isHeaderRow = r => {
    if (nonBlank(r) < 3) return false;
    // 必须是「连续」的多列，而不是“标签—空—标签—空”的信息块
    if (longestRun(r) < Math.min(3, nonBlank(r))) return false;
    if (r + 1 > maxR) return false;
    if (nonBlank(r + 1) === 0) return false;
    // 下一行更像列头（列数更多）→ 当前行是分组表头，跳过
    if (nonBlank(r + 1) > nonBlank(r) && longestRun(r + 1) >= longestRun(r)) return false;
    const texts = grid[r].filter(c => !c.covered && !isBlank(c.v));
    // 列名应当简短（中文列名常带括号与斜杠，放宽到 18 字）
    if (texts.some(c => c.v.length > 18)) return false;
    // 混用粗体/非粗体，说明是「标签 + 值」而不是列头
    const boldN = texts.filter(c => c.bold).length;
    if (boldN > 0 && boldN < texts.length) return false;
    return true;
  };

  const tables = [];
  const headerRows = new Set();
  for (let r = 0; r <= maxR; r++) {
    if (headerRows.has(r) || !isHeaderRow(r)) continue;
    const headers = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = grid[r][c];
      if (cell.covered || isBlank(cell.v)) { headers.push(''); continue; }
      headers.push(cell.v || '');
    }
    let r2 = r + 1;
    while (r2 <= maxR) {
      const any = grid[r2].some(c => !c.covered && c.v && String(c.v).trim());
      if (!any) break;
      r2++;
    }
    const colsInTable = headers.filter(h => h).length;
    if (colsInTable < 2) continue;
    // 跳过：只有表头没有数据行、且后面紧跟另一个表头的伪表
    tables.push({ r1: r, r2: r2 - 1, headers });
    headerRows.add(r);
    r = r2 - 1;
  }

  const inTable = (r) => tables.find(t => r >= t.r1 && r <= t.r2) || null;

  /* ---- 单元格标注 ---- */
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const cells = grid[r];
    const tr = tables.find(t => t.r1 === r);
    const tbl = inTable(r);
    const isHeader = tr != null;
    for (let c = 0; c <= maxC; c++) {
      const cell = cells[c];
      if (cell.covered) continue;
      const v = cell.v || '';
      if (isHeader && !isBlank(v)) { cell.header = true; cell.hint = hintFor(v); continue; }
      if (tbl && isBlank(v)) { cell.hint = hintFor(tbl.headers[c] || ''); cell.input = true; continue; }
      if (!tbl && !isBlank(v) && v.length <= 12) {
        // 跳过表格上方两行（多为分组表头），避免把列名误判为字段标签
        const nearTable = tables.some(t => r >= t.r1 - 2 && r <= t.r2);
        if (nearTable) continue;
        // 标签单元格可能是横向合并的，取值要看它跨过的列数
        const vc = c + (cell.cs || 1);
        const right = vc <= maxC ? cells[vc] : null;
        if (right && !right.covered && !right.label &&
            (isBlank(right.v) || String(right.v).length > v.length)) {
          cell.label = true;
          cell.hint = hintFor(v);
          right.hint = hintFor(v);
          right.input = true;
          right.fieldOf = v;
        }
      }
    }
    rows.push(cells);
  }
  // 保留最后内容后的两行空白，避免客户空表单的待填写行被全部裁掉。
  let lastContent = -1;
  rows.forEach((row, index) => {
    if (row.some(cell => !cell.covered && String(cell.v || '').trim())) lastContent = index;
  });
  if (lastContent >= 0) {
    const desiredLength = Math.max(rows.length, lastContent + 3);
    rows.splice(Math.min(rows.length, desiredLength));
    while (rows.length < desiredLength) {
      rows.push(Array.from({ length: maxC + 1 }, () => ({
        v: '', bold: false, cs: 1, rs: 1,
      })));
    }
  }

  /* ---- 说明汇总 ---- */
  const instructions = [];
  tables.forEach((t, i) => {
    const heads = t.headers.map((h, idx) => (h ? `${h}：${hintFor(h)}` : '')).filter(Boolean);
    instructions.push({
      scope: `表格 ${i + 1}（第 ${t.r1 + 1}–${t.r2 + 1} 行）`,
      kind: 'table',
      items: heads,
    });
  });
  const fields = [];
  rows.forEach((row, r) => row.forEach((c, ci) => {
    if (c && c.label) fields.push({ label: c.v, hint: c.hint });
  }));
  if (fields.length) instructions.push({ scope: '单项字段', kind: 'field', items: fields.map(f => `${f.label}：${f.hint}`) });

  return {
    kind: 'grid',
    source: 'xlsx',
    sheetName: sh.name,
    sheetIndex: idx,
    sheetNames: parsed.sheets.map(s => s.name),
    cols,
    rows,
    tables: tables.map(t => ({ r1: t.r1, r2: t.r2, headers: t.headers })),
    instructions,
    stats: { rows: rows.length, cols: cols.length, tables: tables.length, fields: fields.length },
  };
}

/* ------------------------------------------------------------------ Word */
function inferFromDocx(parsed) {
  const blocks = [];
  const instructions = [];
  let tableNo = 0;

  for (const b of parsed.blocks) {
    if (b.type === 'text') {
      const t = b.text.trim();
      const m = /^(.{1,14})[：:]\s*(.*)$/.exec(t);
      if (m && m[2].length <= 6) {
        blocks.push({
          type: 'field', label: m[1], value: m[2], hint: hintFor(m[1]),
          sourceIndex: b.sourceIndex, originalText: t,
        });
      } else {
        blocks.push({ type: 'text', text: t, sourceIndex: b.sourceIndex });
      }
      continue;
    }
    tableNo += 1;
    const [head, ...body] = b.rows;
    const cols = head.length >= 2 ? head.map(h => ({ label: h, hint: hintFor(h) })) : null;
    if (!cols) {
      const n = Math.max(...b.rows.map(r => r.length));
      blocks.push({
        type: 'table',
        cols: Array.from({ length: n }, (_, i) => ({ label: '列 ' + (i + 1), hint: DEFAULT_HINT })),
        rows: b.rows.map(r => Array.from({ length: n }, (_, i) => r[i] || '')),
        sourceIndex: b.sourceIndex,
        sourceRowIndexes: b.sourceRowIndexes || [],
      });
    } else {
      blocks.push({
        type: 'table',
        cols,
        rows: body.length ? body.map(r => Array.from({ length: cols.length }, (_, i) => r[i] || ''))
          : [Array(cols.length).fill('')],
        sourceIndex: b.sourceIndex,
        sourceRowIndexes: b.sourceRowIndexes || [],
      });
      instructions.push({
        scope: `表格 ${tableNo}`, kind: 'table',
        items: cols.map(c => `${c.label}：${c.hint}`),
      });
    }
  }

  return {
    kind: 'doc',
    source: 'docx',
    blocks,
    instructions,
    stats: { blocks: blocks.length, tables: blocks.filter(b => b.type === 'table').length },
  };
}

module.exports = { inferFromXlsx, inferFromDocx, hintFor };
