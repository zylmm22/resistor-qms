'use strict';
/**
 * 文件解析：ZIP 读取 + XML 解析 + XLSX / DOCX 提取。
 * 仅依赖 Node 内置 zlib。
 */
const zlib = require('node:zlib');
const MAX_ENTRY_SIZE = 32 * 1024 * 1024;
const MAX_TOTAL_SIZE = 128 * 1024 * 1024;

/* ------------------------------------------------------------------ ZIP 读 */
function readZip(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / Office 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let totalSize = 0;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // 本地头：跳过文件名与扩展区
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE + 1 });
      } catch (e) {
        throw new Error(`ZIP 条目解压失败：${name}`);
      }
    } else throw new Error(`不支持的 ZIP 压缩方式：${name}`);
    if (data.length > MAX_ENTRY_SIZE) throw new Error(`ZIP 条目过大：${name}`);
    totalSize += data.length;
    if (totalSize > MAX_TOTAL_SIZE) throw new Error('ZIP 解压后总大小超过 128 MB');
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const zipText = (files, name) => {
  const b = files.get(name);
  return b ? b.toString('utf8') : '';
};

/* ------------------------------------------------------------------ XML */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescape(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[g] != null ? ENT[g] : m;
  });
}

/** 容错 XML 解析 → 简单树 */
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].children.push({ name: '#text', text: unescape(text), children: [] });
    }
    // 结束标记缺失时 indexOf 返回 -1，i 会退回起点造成死循环（整个进程卡住），必须显式报错
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end < 0) throw new Error('XML 注释未闭合');
      i = end + 3; continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) throw new Error('XML CDATA 未闭合');
      const txt = src.slice(lt + 9, end);
      stack[stack.length - 1].children.push({ name: '#text', text: txt, children: [] });
      i = end + 3; continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    let raw = src.slice(lt + 1, gt);
    if (raw[0] === '?' || raw[0] === '!') { i = gt + 1; continue; }
    if (raw[0] === '/') {
      if (stack.length > 1) stack.pop();
      i = gt + 1; continue;
    }
    const selfClose = raw.endsWith('/');
    if (selfClose) raw = raw.slice(0, -1);
    const sp = raw.search(/[\s]/);
    const name = sp < 0 ? raw : raw.slice(0, sp);
    const attrs = {};
    if (sp >= 0) {
      const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let m;
      while ((m = re.exec(raw.slice(sp)))) attrs[m[1]] = unescape(m[2]);
    }
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

const kids = (node, name) => (node.children || []).filter(c => c.name === name);
const all = (node, name, out = []) => {
  for (const c of node.children || []) {
    if (c.name === name) out.push(c);
    all(c, name, out);
  }
  return out;
};
const textOf = node => {
  let s = '';
  for (const c of node.children || []) {
    if (c.name === '#text') s += c.text;
    else if (c.name !== 'w:tab' && c.name !== 'w:br') s += textOf(c);
  }
  return s;
};
const first = (node, name) => (node.children || []).find(c => c.name === name) || null;

/* ------------------------------------------------------------------ 工具 */
const colToNum = ref => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const numToCol = i => {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
};

/* ------------------------------------------------------------------ XLSX */
function parseXlsx(buf) {
  const files = readZip(buf);
  const wbXml = parseXml(zipText(files, 'xl/workbook.xml'));
  const sheetNodes = all(wbXml, 'sheet');
  const rels = parseXml(zipText(files, 'xl/_rels/workbook.xml.rels'));
  const relMap = {};
  for (const r of all(rels, 'Relationship')) {
    relMap[r.attrs.Id] = r.attrs.Target;
  }
  // 共享字符串
  const shared = [];
  const ssXml = zipText(files, 'xl/sharedStrings.xml');
  if (ssXml) {
    const ss = parseXml(ssXml);
    for (const si of all(ss, 'si')) shared.push(textOf(si));
  }
  // 样式：粗体判定 + 数字格式（A-12：日期单元格不能被压成序列号）
  const boldFonts = new Set();
  const xfFont = [];
  const xfNumFmt = [];
  const dateFormats = new Set();
  const stXml = zipText(files, 'xl/styles.xml');
  if (stXml) {
    const st = parseXml(stXml);
    const fontsNode = all(st, 'fonts')[0];
    if (fontsNode) {
      kids(fontsNode, 'font').forEach((f, idx) => { if (kids(f, 'b').length) boldFonts.add(idx); });
    }
    const numFmtsNode = all(st, 'numFmts')[0];
    if (numFmtsNode) {
      for (const fmt of kids(numFmtsNode, 'numFmt')) {
        const code = String(fmt.attrs.formatCode || '');
        // 排除纯时间/百分比“0.00”类干扰，识别含 y/m/d/h/s 的日期格式
        if (/[ymdhs]/i.test(code.replace(/\[[^\]]*\]/g, '')) && !/^[#0.,%]+$/.test(code)) {
          dateFormats.add(parseInt(fmt.attrs.numFmtId || '0', 10));
        }
      }
    }
    for (const builtin of [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]) dateFormats.add(builtin);
    const cellXfs = all(st, 'cellXfs')[0];
    if (cellXfs) {
      kids(cellXfs, 'xf').forEach(xf => {
        xfFont.push(parseInt(xf.attrs.fontId || '0', 10));
        xfNumFmt.push(parseInt(xf.attrs.numFmtId || '0', 10));
      });
    }
  }
  const isDateStyle = sIdx => dateFormats.has(xfNumFmt[sIdx] != null ? xfNumFmt[sIdx] : 0);
  const excelDate = serial => {
    const millis = Math.round(serial * 86400000);
    const date = new Date(Date.UTC(1899, 11, 30) + millis);
    const iso = date.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  };

  const sheets = [];
  const warnings = [];
  for (let si = 0; si < sheetNodes.length; si++) {
    const s = sheetNodes[si];
    const rid = s.attrs['r:id'] || s.attrs.id;
    let target = relMap[rid] || `worksheets/sheet${si + 1}.xml`;
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\/?xl\//, '');
    const xml = zipText(files, target) || zipText(files, `xl/worksheets/sheet${si + 1}.xml`);
    if (!xml) continue;

    const doc = parseXml(xml);
    const one = (n) => all(doc, n)[0] || null;
    const dim = one('dimension');
    let maxCol = 0, maxRow = 0;
    if (dim && dim.attrs.ref && dim.attrs.ref.includes(':')) {
      const [a, b] = dim.attrs.ref.split(':');
      maxCol = colToNum(b); maxRow = parseInt((b.match(/\d+/) || ['0'])[0], 10);
    }

    const colWidths = {};
    const colsNode = one('cols');
    if (colsNode) {
      for (const c of kids(colsNode, 'col')) {
        const min = parseInt(c.attrs.min, 10), max = parseInt(c.attrs.max, 10);
        const w = parseFloat(c.attrs.width || '0');
        for (let k = min; k <= Math.min(max, min + 60); k++) if (w > 0) colWidths[k - 1] = w;
      }
    }

    const cells = new Map(); // "r,c" → {v, bold, style}
    let dateCells = 0;
    const sheetData = one('sheetData');
    let lastRow = 0;
    if (sheetData) {
      for (const row of kids(sheetData, 'row')) {
        const rIdx = parseInt(row.attrs.r, 10) - 1;
        lastRow = Math.max(lastRow, rIdx);
        for (const c of kids(row, 'c')) {
          const ref = c.attrs.r || '';
          const cd = colToNum(ref);
          if (cd > maxCol) maxCol = cd;
          const t = c.attrs.t;
          let v = '';
          if (t === 's') {
            const idx = parseInt(textOf(first(c, 'v') || { children: [] }), 10);
            v = shared[idx] || '';
          } else if (t === 'inlineStr') {
            v = textOf(first(c, 'is') || { children: [] });
          } else if (t === 'str') {
            v = textOf(first(c, 'v') || { children: [] });
          } else {
            const vn = first(c, 'v');
            v = vn ? textOf(vn) : '';
            const sIdxRaw = parseInt(c.attrs.s || '0', 10);
            if (v !== '' && isDateStyle(sIdxRaw) && Number.isFinite(+v)) {
              // A-12：按日期格式还原，而不是留下 45123 之类的序列号
              v = excelDate(+v);
              dateCells += 1;
            } else if (v !== '' && !isNaN(+v)) v = String(+v);
          }
          const sIdx = parseInt(c.attrs.s || '0', 10);
          const bold = boldFonts.has(xfFont[sIdx] != null ? xfFont[sIdx] : 0);
          if (String(v).trim() !== '') cells.set(rIdx + ',' + cd, { v: String(v), bold });
        }
      }
    }

    // 合并单元格
    const merges = [];
    const mcNode = one('mergeCells');
    if (mcNode) {
      for (const m of kids(mcNode, 'mergeCell')) {
        const ref = m.attrs.ref || '';
        const [a, b] = ref.split(':');
        if (!a || !b) continue;
        const c1 = colToNum(a), r1 = parseInt(a.replace(/[A-Z]+/g, ''), 10) - 1;
        const c2 = colToNum(b), r2 = parseInt(b.replace(/[A-Z]+/g, ''), 10) - 1;
        merges.push({ r1, c1, r2, c2 });
        maxCol = Math.max(maxCol, c2); maxRow = Math.max(maxRow, r2);
      }
    }

    // dimension 给出的是 1-based 行号，lastRow/merge 是 0-based 索引；统一换算成“行数/列数”
    const rawRows = Math.max(maxRow, lastRow + 1, ...merges.map(item => item.r2 + 1));
    const rawCols = Math.max(maxCol + 1, ...merges.map(item => item.c2 + 1));
    if (rawRows > 400) warnings.push(`工作表「${s.attrs.name || si + 1}」共 ${rawRows} 行，仅保留前 400 行`);
    if (rawCols > 40) warnings.push(`工作表「${s.attrs.name || si + 1}」共 ${rawCols} 列，仅保留前 40 列`);
    if (dateCells) warnings.push(`工作表「${s.attrs.name || si + 1}」有 ${dateCells} 个日期单元格已按日期格式还原`);
    sheets.push({
      name: s.attrs.name || 'Sheet' + (si + 1),
      // maxRow/maxCol 为包含式索引（供 row<=maxRow、column<=maxCol 循环使用）
      maxRow: Math.min(rawRows, 400) - 1,
      maxCol: Math.min(rawCols, 40) - 1,
      cells, merges, colWidths,
    });
  }
  if (!sheets.length) throw new Error('未找到工作表');
  if (sheets.length > 1) {
    warnings.push(`工作簿共 ${sheets.length} 个工作表，当前解析全部工作表，请在导入时选择需要的工作表`);
  }
  return { type: 'xlsx', sheets, sheetCount: sheets.length, warnings };
}

/* ------------------------------------------------------------------ DOCX */
function parseDocx(buf) {
  const files = readZip(buf);
  const xml = zipText(files, 'word/document.xml');
  if (!xml) throw new Error('不是有效的 Word 文档（缺少 word/document.xml）');
  const doc = parseXml(xml);
  const body = all(doc, 'w:body')[0];
  if (!body) throw new Error('文档结构异常');

  const blocks = [];
  for (let bodyIndex = 0; bodyIndex < body.children.length; bodyIndex += 1) {
    const node = body.children[bodyIndex];
    if (node.name === 'w:p') {
      const t = textOf(node).trim();
      if (t) blocks.push({ type: 'text', text: t, sourceIndex: bodyIndex });
    } else if (node.name === 'w:tbl') {
      const rows = [];
      const sourceRowIndexes = [];
      for (let rowIndex = 0; rowIndex < kids(node, 'w:tr').length; rowIndex += 1) {
        const tr = kids(node, 'w:tr')[rowIndex];
        const cells = [];
        for (const tc of kids(tr, 'w:tc')) {
          const txt = kids(tc, 'w:p').map(p => textOf(p).trim()).filter(Boolean).join('\n');
          cells.push(txt);
        }
        if (cells.some(c => c !== '')) {
          rows.push(cells);
          sourceRowIndexes.push(rowIndex);
        }
      }
      if (rows.length) blocks.push({ type: 'table', rows, sourceIndex: bodyIndex, sourceRowIndexes });
    }
  }
  return { type: 'docx', blocks };
}

module.exports = { readZip, parseXml, parseXlsx, parseDocx, kids, all, textOf, first, colToNum, numToCol };
