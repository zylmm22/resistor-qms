'use strict';
/**
 * 导出引擎：手写 ZIP + OOXML，产出真正能被 Word / Excel 打开的文件。
 * 不依赖任何第三方库。
 */

/* ------------------------------------------------------------------ ZIP */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** files: [{name, data:Buffer}] → Buffer(未压缩 ZIP) */
function zip(files) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);          // UTF-8 标志
    local.writeUInt16LE(0, 8);               // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ 通用 */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const CN_FONT = '微软雅黑';

function valueOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

/* ------------------------------------------------------------------ DOCX */
function docxRuns(text, { bold = false, size = 21, color = '1F2937' } = {}) {
  const lines = String(text == null ? '' : text).split('\n');
  return lines.map((ln, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r><w:rPr><w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(ln)}</w:t></w:r>`).join('');
}

function docxPara(text, opt = {}) {
  const { align = 'left', spaceBefore = 0, spaceAfter = 80, indent = 0 } = opt;
  return `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="300" w:lineRule="auto"/>${indent ? `<w:ind w:left="${indent}"/>` : ''}</w:pPr>${docxRuns(text, opt)}</w:p>`;
}

function docxTable(cols, rows, totalWidth = 9000) {
  const n = Math.max(1, cols.length);
  const w = Math.floor(totalWidth / n);
  const border = `<w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="C9D2DF"/><w:left w:val="single" w:sz="4" w:color="C9D2DF"/>
    <w:bottom w:val="single" w:sz="4" w:color="C9D2DF"/><w:right w:val="single" w:sz="4" w:color="C9D2DF"/>
    <w:insideH w:val="single" w:sz="4" w:color="C9D2DF"/><w:insideV w:val="single" w:sz="4" w:color="C9D2DF"/></w:tblBorders>`;
  const cell = (txt, header) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EDF2F9"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>
    <w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/></w:pPr>
    ${docxRuns(txt, { bold: header, size: header ? 18 : 18, color: header ? '1F3864' : '1F2937' })}</w:p></w:tc>`;

  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cols.map(c => cell(c, true)).join('')}</w:tr>`;
  const body = (rows && rows.length ? rows : [Array(n).fill('')])
    .map(r => `<w:tr>${Array.from({ length: n }, (_, i) => cell(r[i] == null ? '' : r[i], false)).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/>${border}<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>
    <w:tblGrid>${Array.from({ length: n }, () => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl>
    <w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>`;
}

function docxImage(relId, { widthInches = 5.9, heightInches = 3.2, title = 'SPC 控制图', docPrId = 1 } = {}) {
  const cx = Math.round(widthInches * 914400);
  const cy = Math.round(heightInches * 914400);
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="80"/></w:pPr>
<w:r><w:drawing>
<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="${esc(title)} ${docPrId}"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${esc(title)} ${docPrId}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** PNG/JPEG 宽高比（读文件头，避免额外依赖） */
function rasterSize(buf) {
  if (!buf || !buf.length) return null;
  // PNG：IHDR 紧跟在 8 字节签名之后
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: 'png', contentType: 'image/png' };
  }
  // JPEG：扫描 SOF0/SOF1/SOF2 段
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7),
          ext: 'jpeg', contentType: 'image/jpeg',
        };
      }
      offset += 2 + (length > 0 ? length : 2);
    }
  }
  return null;
}

/** 在给定的最大宽高内等比缩放，按 100 DPI 换算英寸 */
function fitImageInches(size, { maxWidth = 5.9, maxHeight = 3.2 } = {}) {
  const widthPx = size?.width || 0;
  const heightPx = size?.height || 0;
  if (!widthPx || !heightPx) return { widthInches: maxWidth, heightInches: maxHeight };
  const ratio = Math.min(maxWidth / (widthPx / 100), maxHeight / (heightPx / 100));
  return {
    widthInches: Math.max(0.5, (widthPx / 100) * ratio),
    heightInches: Math.max(0.4, (heightPx / 100) * ratio),
  };
}

function docxSectionTitle(text) {
  return `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="2D6CDF"/></w:pBdr>
<w:shd w:val="clear" w:color="auto" w:fill="F3F7FC"/><w:spacing w:before="180" w:after="90"/><w:ind w:left="120" w:right="120"/></w:pPr>
${docxRuns(text, { bold: true, size: 24, color: '1F3864' })}</w:p>`;
}

function buildDocx(doc) {
  const body = [];
  const imageParts = [];
  body.push(docxPara(doc.title, { align: 'center', bold: true, size: 36, spaceAfter: 60, color: '1F3864' }));
  if (doc.subtitle) body.push(docxPara(doc.subtitle, { align: 'center', size: 18, color: '6B7280', spaceAfter: 200 }));

  for (const sec of doc.sections) {
    body.push(docxSectionTitle(sec.t));
    if (sec.note) body.push(docxPara(sec.note, { size: 17, color: '6B7280', spaceAfter: 80 }));
    for (const f of sec.fields) {
      if (f.type === 'table') {
        body.push(docxPara(f.label, { size: 18, spaceAfter: 60, color: '374151' }));
        body.push(docxTable(f.cols || [], f.rows || []));
      } else if (f.type === 'image' && (f.value || f.data)) {
        const index = imageParts.length + 1;
        const relId = `rIdImg${index}`;
        // 二进制图片（PNG/JPEG）优先按文件头推断类型与宽高比；没有 data 时退回内联 SVG（SPC 控制图）
        const raster = f.data ? rasterSize(f.data) : null;
        if (raster) {
          const fitted = f.widthInches && f.heightInches
            ? { widthInches: f.widthInches, heightInches: f.heightInches }
            : fitImageInches(raster, {
              maxWidth: f.maxWidthInches || 5.9, maxHeight: f.maxHeightInches || 3.2,
            });
          imageParts.push({
            name: `word/media/img-${index}.${raster.ext}`,
            data: f.data, ext: raster.ext, contentType: raster.contentType,
          });
          body.push(docxPara(f.label, { size: 18, spaceAfter: 60, color: '374151' }));
          body.push(docxImage(relId, { ...fitted, title: f.label || '图片', docPrId: index }));
        } else {
          imageParts.push({ name: `word/media/spc-chart-${index}.svg`, data: String(f.value), ext: 'svg', contentType: 'image/svg+xml' });
          body.push(docxPara(f.label, { size: 18, spaceAfter: 60, color: '374151' }));
          body.push(docxImage(relId, {
            widthInches: f.widthInches || 5.9,
            heightInches: f.heightInches || 3.2,
            title: f.label || 'SPC 控制图',
            docPrId: index,
          }));
        }
      } else {
        body.push(`<w:p><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr>
          ${docxRuns(f.label + '：', { bold: true, size: 19, color: '374151' })}
          ${docxRuns((f.value === '' || f.value == null) ? '—' : f.value, { size: 19 })}</w:p>`);
      }
    }
  }

  body.push(`<w:p><w:pPr><w:spacing w:before="240"/><w:pBdr><w:top w:val="single" w:sz="6" w:color="D0D7E2"/></w:pBdr></w:pPr></w:p>`);
  body.push(docxPara(`生成时间：${doc.generatedAt}　｜　文件编号：${doc.code}　｜　版本：${doc.version || 'V1.0'}`, { size: 16, color: '9CA3AF' }));

  const landscape = doc.page?.orientation === 'landscape';
  const pageWidth = landscape ? 16838 : 11906;
  const pageHeight = landscape ? 11906 : 16838;
  const pageMargins = landscape ? '1134' : '1418';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${pageMargins}" w:right="${pageMargins}" w:bottom="${pageMargins}" w:left="${pageMargins}" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

  // 只声明实际用到的图片扩展名，避免 Word 因未知默认类型报错
  const imageExts = [...new Set(imageParts.map(part => part.ext || 'svg'))];
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="svg" ContentType="image/svg+xml"/>
${imageExts.filter(ext => ext !== 'svg').map(ext =>
    `<Default Extension="${ext}" ContentType="${ext === 'png' ? 'image/png' : 'image/jpeg'}"/>`).join('')}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${imageParts.map((part, index) => `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${part.name.replace(/^word\//, '')}"/>`).join('')}
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/><w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(doc.title)}</dc:title><dc:creator>${esc(doc.author || '质量工程部')}</dc:creator>
<cp:lastModifiedBy>${esc(doc.author || '质量工程部')}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles },
    ...imageParts,
    { name: 'docProps/core.xml', data: core },
  ]);
}

/* ------------------------------------------------------------------ XLSX */
function xlsxCell(ref, val, style) {
  if (val == null || val === '') return `<c r="${ref}"${style ? ` s="${style}"` : ''}/>`;
  if (typeof val === 'object' && val.formula) {
    const cached = typeof val.value === 'number' && Number.isFinite(val.value)
      ? `<v>${val.value}</v>`
      : (val.value == null || val.value === '' ? '' : `<v>${esc(val.value)}</v>`);
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><f>${esc(val.formula)}</f>${cached}</c>`;
  }
  if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${val}</v></c>`;
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
}

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function buildXlsx(doc) {
  const COLS = Math.max(6, ...doc.sections.map(s => Math.max(...s.fields.map(f => (f.cols ? f.cols.length : 2)))));
  const widths = Array.from({ length: COLS }, (_, i) => (i === 0 ? 26 : 20));
  const rows = [];
  let r = 0;

  // 估算换行后所需行高（中文按 2 个字符宽计）
  const visualLen = s => {
    let n = 0;
    for (const ch of String(s)) n += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    return n;
  };
  const heightFor = (cells) => {
    let maxLines = 1;
    cells.forEach((v, i) => {
      const w = (widths[i] || 20) - 1;
      const lines = Math.ceil(visualLen(v) / Math.max(4, w)) || 1;
      maxLines = Math.max(maxLines, lines);
    });
    return Math.max(18, maxLines * 15 + 5);
  };

  const push = (cells, style, opts = {}) => {
    r += 1;
    const h = opts.height || heightFor(cells);
    rows.push(`<row r="${r}"${style ? ` s="${style}"` : ''} customHeight="1" ht="${h}">` +
      cells.map((v, i) => xlsxCell(colName(i) + r, v, style)).join('') + '</row>');
    return r;
  };
  const blank = (h = 14) => { r += 1; rows.push(`<row r="${r}" customHeight="1" ht="${h}"/>`); };

  const merges = [];
  const mergeRow = (style, text) => {
    push([text], style, { height: style === 1 ? 34 : 20 });
    merges.push(`A${r}:${colName(COLS - 1)}${r}`);
  };

  mergeRow(1, doc.title);
  if (doc.subtitle) mergeRow(2, doc.subtitle);
  blank();

  for (const sec of doc.sections) {
    push([sec.t], 3, { height: 24 });
    if (sec.note) push([sec.note], 4);
    for (const f of sec.fields) {
      if (f.type === 'table') {
        push([f.label], 4);
        push(f.cols || [], 5, { height: 26 });
        const body = (f.rows && f.rows.length ? f.rows : [Array((f.cols || []).length).fill('')]);
        for (const row of body) {
          push(Array.from({ length: (f.cols || []).length }, (_, i) => (row[i] == null ? '' : row[i])), 6);
        }
        blank();
      } else {
        const v = (f.value === '' || f.value == null) ? '—' : f.value;
        push([f.label, v], 6);
      }
    }
    blank();
  }
  push([`生成时间：${doc.generatedAt}　｜　文件编号：${doc.code}　｜　版本：${doc.version || 'V1.0'}`], 4);
  merges.push(`A${r}:${colName(COLS - 1)}${r}`);

  const colsXml = widths.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');

  const page = doc.page || {};
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<cols>${colsXml}</cols>
<sheetData>${rows.join('')}</sheetData>
<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>
<pageMargins left="${page.left ?? 0.3}" right="${page.right ?? 0.3}" top="${page.top ?? 0.4}" bottom="${page.bottom ?? 0.4}" header="0.2" footer="0.2"/>
<pageSetup paperSize="${page.paperSize || 8}" orientation="${page.orientation || 'landscape'}" fitToWidth="1" fitToHeight="${page.fitToHeight ?? 0}"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="10"/><name val="${CN_FONT}"/><color rgb="FF1F2937"/></font>
<font><b/><sz val="16"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
<font><sz val="9"/><name val="${CN_FONT}"/><color rgb="FF6B7280"/></font>
<font><b/><sz val="11"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
<font><b/><sz val="10"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDF2F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFC9D2DF"/></left><right style="thin"><color rgb="FFC9D2DF"/></right>
<top style="thin"><color rgb="FFC9D2DF"/></top><bottom style="thin"><color rgb="FFC9D2DF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const name = esc((doc.title || 'Sheet1').slice(0, 28));
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(doc.title)}</dc:title>
<dc:creator>${esc(doc.author || '质量工程部')}</dc:creator></cp:coreProperties>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: core },
  ]);
}

function buildSpcControlChartSvg(stat, meta = {}) {
  if (!stat || !Array.isArray(stat.series) || !stat.series.length) return '';
  const numbers = stat.series.map(Number).filter(Number.isFinite);
  const limits = [
    ...(stat.seriesUcl || []).map(Number),
    ...(stat.seriesLcl || []).map(Number),
    Number(stat.center), Number(stat.ucl), Number(stat.lcl),
  ].filter(Number.isFinite);
  const allValues = [...numbers, ...limits];
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span = Math.max(1e-9, rawMax - rawMin);
  const min = rawMin - span * 0.12;
  const max = rawMax + span * 0.12;
  // 坐标轴刻度：小数位随量程自适应，同时给整数部分留出空间，避免刻度标签互相重叠
  const magnitude = Math.max(Math.abs(rawMax), Math.abs(rawMin), 1e-12);
  const spanDigits = span >= 1000 ? 0 : span >= 10 ? 1 : span >= 0.1 ? 2 : span >= 0.001 ? 4 : 6;
  const roomForDecimals = Math.max(0, 12 - (Math.floor(Math.log10(magnitude)) + 1));
  const digits = Math.min(spanDigits, Math.max(2, roomForDecimals));
  const fmt = value => {
    if (!Number.isFinite(Number(value))) return '—';
    const number = Math.abs(Number(value)) < 0.5 * 10 ** -digits ? 0 : Number(value);
    const text = number.toFixed(digits);
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  };
  const violationSet = new Set((stat.violations || []).map(item => +item.i));
  const title = meta.title || `${stat.chartType || 'SPC'} 控制图`;
  const subtitle = meta.subtitle || '';

  const panel = (values, options) => {
    const plotX = 62, plotY = 46, plotW = 1038, plotH = options.height - 74;
    const array = values.map(Number);
    const local = [
      ...array.filter(Number.isFinite),
      ...(options.uclValues || []).map(Number),
      ...(options.lclValues || []).map(Number),
      Number(options.center), Number(options.ucl), Number(options.lcl),
    ].filter(Number.isFinite);
    const lo = Math.min(...local), hi = Math.max(...local);
    const pad = Math.max(1e-9, hi - lo) * 0.12;
    const yMin = local.length ? lo - pad : min;
    const yMax = local.length ? hi + pad : max;
    const xAt = index => plotX + (array.length <= 1 ? plotW / 2 : index * plotW / (array.length - 1));
    const yAt = value => plotY + plotH - ((Number(value) - yMin) / Math.max(1e-9, yMax - yMin)) * plotH;
    const uclValues = options.uclValues || array.map(() => options.ucl);
    const lclValues = options.lclValues || array.map(() => options.lcl);
    const band = array.map((_, index) => `${xAt(index)},${yAt(uclValues[index])}`)
      .concat(array.map((_, index) => `${xAt(array.length - 1 - index)},${yAt(lclValues[array.length - 1 - index])}`))
      .join(' ');
    const seriesLine = array.map((value, index) => `${xAt(index)},${yAt(value)}`).join(' ');
    const grid = Array.from({ length: 5 }, (_, index) => {
      const y = plotY + plotH * index / 4;
      const value = yMax - (yMax - yMin) * index / 4;
      return `<line x1="${plotX}" y1="${y}" x2="${plotX + plotW}" y2="${y}" stroke="#E6ECF3" stroke-width="1"/>
        <text x="${plotX - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#748094">${fmt(value)}</text>`;
    }).join('');
    const labelIndexes = [...new Set([0, Math.floor((array.length - 1) / 2), array.length - 1])].filter(index => index >= 0);
    const xLabels = labelIndexes.map(index =>
      `<text x="${xAt(index)}" y="${plotY + plotH + 20}" text-anchor="middle" font-size="10.5" fill="#748094">${esc((options.labels || [])[index] ?? index + 1)}</text>`).join('');
    return `<g>
      <rect x="16" y="12" width="1128" height="${options.height}" rx="12" fill="#FFFFFF" stroke="#DCE5F0"/>
      <text x="30" y="35" font-size="14" font-weight="700" fill="#1F3864">${esc(options.title)}</text>
      <text x="1118" y="34" text-anchor="end" font-size="10.5" fill="#748094">UCL ${fmt(options.ucl)}　CL ${fmt(options.center)}　LCL ${fmt(options.lcl)}</text>
      <rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" rx="6" fill="#F8FAFD" stroke="#DCE5F0"/>
      <polygon points="${band}" fill="#E8F0FC" opacity="0.75"/>
      ${grid}
      <line x1="${plotX}" y1="${yAt(options.ucl)}" x2="${plotX + plotW}" y2="${yAt(options.ucl)}" stroke="#E07A5F" stroke-width="1.7" stroke-dasharray="7 5"/>
      <line x1="${plotX}" y1="${yAt(options.center)}" x2="${plotX + plotW}" y2="${yAt(options.center)}" stroke="#2D6CDF" stroke-width="1.8" stroke-dasharray="5 4"/>
      <line x1="${plotX}" y1="${yAt(options.lcl)}" x2="${plotX + plotW}" y2="${yAt(options.lcl)}" stroke="#D49A28" stroke-width="1.7" stroke-dasharray="7 5"/>
      <polyline points="${seriesLine}" fill="none" stroke="#2D6CDF" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${array.map((value, index) => `<circle cx="${xAt(index)}" cy="${yAt(value)}" r="${violationSet.has(index) ? 5.8 : 3.8}" fill="${violationSet.has(index) ? '#DC2626' : '#FFFFFF'}" stroke="${violationSet.has(index) ? '#991B1B' : '#2D6CDF'}" stroke-width="2"/>`).join('')}
      ${options.uclValues ? `<polyline points="${options.uclValues.map((value, index) => `${xAt(index)},${yAt(value)}`).join(' ')}" fill="none" stroke="#E07A5F" stroke-width="1.5" stroke-dasharray="7 5"/>` : ''}
      ${options.lclValues ? `<polyline points="${options.lclValues.map((value, index) => `${xAt(index)},${yAt(value)}`).join(' ')}" fill="none" stroke="#D49A28" stroke-width="1.5" stroke-dasharray="7 5"/>` : ''}
      ${xLabels}
    </g>`;
  };

  const secondarySpec = stat.secondary || (Array.isArray(stat.range) && stat.range.length ? {
    title: String(stat.chartType || '').includes('S') ? '标准差控制图（S）' : '极差控制图（R）',
    values: stat.range, labels: stat.labels, center: stat.Rb, ucl: stat.uclR, lcl: stat.lclR,
  } : null);
  const secondary = secondarySpec && Array.isArray(secondarySpec.values) && secondarySpec.values.length
    ? panel(secondarySpec.values, {
      title: secondarySpec.title || '极差控制图', height: 230, labels: secondarySpec.labels,
      center: secondarySpec.center, ucl: secondarySpec.ucl, lcl: secondarySpec.lcl,
    }) : '';
  const mainHeight = secondary ? 300 : 430;
  const main = panel(stat.series, {
    title: `${stat.chartType || 'SPC'} 主控制图`, height: mainHeight, labels: stat.labels,
    center: stat.center, ucl: stat.ucl, lcl: stat.lcl,
    uclValues: stat.seriesUcl, lclValues: stat.seriesLcl,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="${secondary ? 660 : 560}" viewBox="0 0 1160 ${secondary ? 660 : 560}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F3F7FC"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs>
  <rect width="1160" height="${secondary ? 660 : 560}" rx="16" fill="url(#bg)"/>
  <rect x="22" y="18" width="6" height="32" rx="3" fill="#2D6CDF"/>
  <text x="40" y="38" font-family="Microsoft YaHei,Arial,sans-serif" font-size="20" font-weight="700" fill="#1F3864">${esc(title)}</text>
  <text x="40" y="56" font-family="Microsoft YaHei,Arial,sans-serif" font-size="11" fill="#64748B">${esc(subtitle)}</text>
  <text x="1138" y="34" text-anchor="end" font-family="Microsoft YaHei,Arial,sans-serif" font-size="11" fill="#64748B">判异点 ${(stat.violations || []).length}　Cp ${fmt(stat.cp)}　Cpk ${fmt(stat.cpk)}　Ppk ${fmt(stat.ppk)}</text>
  <g transform="translate(0 54)" font-family="Microsoft YaHei,Arial,sans-serif">${main}</g>
  ${secondary ? `<g transform="translate(0 424)" font-family="Microsoft YaHei,Arial,sans-serif">${secondary}</g>` : ''}
</svg>`;
}

function spcChartXml(spec, data = {}) {
  const sheetName = String(data.sheetName || 'SPC控制图').replace(/'/g, "''");
  const start = data.dataStartRow;
  const end = data.dataEndRow;
  const categories = data.categories || [];
  const axisId = 100000 + (data.chartIndex || 0) * 10;
  const categoryAxis = axisId + 1;
  const valueAxis = axisId + 2;
  const catFormula = `'${sheetName}'!$A$${start}:$A$${end}`;
  const numericCategories = categories.length > 0 && categories.every(value => Number.isFinite(Number(value)));
  const catPoints = categories.slice(0, end - start + 1).map((value, index) =>
    `<c:pt idx="${index}"><c:v>${numericCategories ? Number(value) : esc(value)}</c:v></c:pt>`).join('');
  const categoryRef = numericCategories
    ? `<c:numRef><c:f>${esc(catFormula)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${categories.length}"/>${catPoints}</c:numCache></c:numRef>`
    : `<c:strRef><c:f>${esc(catFormula)}</c:f><c:strCache><c:ptCount val="${categories.length}"/>${catPoints}</c:strCache></c:strRef>`;
  const series = (spec.series || []).map((item, index) => {
    const column = colName(item.column);
    const formula = `'${sheetName}'!$${column}$${start}:$${column}$${end}`;
    const values = (item.values || []).slice(0, end - start + 1);
    const points = values.map((value, pointIndex) => {
      const num = Number(value);
      return value !== '' && value != null && Number.isFinite(num)
        ? `<c:pt idx="${pointIndex}"><c:v>${num}</c:v></c:pt>` : '';
    }).join('');
    const lineFill = item.markerOnly
      ? '<a:ln><a:noFill/></a:ln>'
      : `<a:ln w="${item.width || 24000}" cap="rnd"><a:solidFill><a:srgbClr val="${item.color || '2D6CDF'}"/></a:solidFill>${item.dash ? `<a:prstDash val="${item.dash}"/>` : ''}<a:round/></a:ln>`;
    const marker = item.marker || item.markerOnly
      ? `<c:marker><c:symbol val="circle"/><c:size val="${item.markerOnly ? 7 : 5}"/><c:spPr><a:solidFill><a:srgbClr val="${item.color || '2D6CDF'}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>`
      : '<c:marker><c:symbol val="none"/></c:marker>';
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${esc(item.name)}</c:v></c:tx>
      <c:spPr>${lineFill}</c:spPr>${marker}
      <c:cat>${categoryRef}</c:cat>
      <c:val><c:numRef><c:f>${esc(formula)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache></c:numRef></c:val><c:smooth val="0"/>
    </c:ser>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:roundedCorners val="1"/><c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1200" b="1"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill><a:latin typeface="Microsoft YaHei"/></a:rPr><a:t>${esc(spec.title || '')}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>
<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}
<c:marker val="1"/><c:axId val="${categoryAxis}"/><c:axId val="${valueAxis}"/></c:lineChart>
<c:catAx><c:axId val="${categoryAxis}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>
<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valueAxis}"/><c:crosses val="min"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>
<c:valAx><c:axId val="${valueAxis}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>
<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E6ECF3"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>
<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${categoryAxis}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>
<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="DCE5F0"/></a:solidFill></a:ln></c:spPr>
</c:chartSpace>`;
}

function buildHandbookXlsx(doc) {
  const sheetName = String(doc.sheetName || doc.title || 'Sheet1').replace(/[\\/?*[\]:]/g, '').slice(0, 31);
  const native = doc.nativeChart || null;
  const columns = doc.columns || [];
  const COLS = Math.max(1, columns.length);
  const widths = doc.widths?.length === COLS
    ? doc.widths
    : Array.from({ length: COLS }, (_, index) => (index === 0 ? 6 : 18));
  const rows = [];
  const merges = [];
  let rowNumber = 0;
  const push = (cells, style, height = 24, mergesForRow = []) => {
    rowNumber += 1;
    rows.push(`<row r="${rowNumber}" ht="${height}" customHeight="1">${cells.map((value, index) =>
      xlsxCell(colName(index) + rowNumber, value, style)).join('')}</row>`);
    for (const merge of mergesForRow) {
      merges.push(`${merge.start}${rowNumber}:${merge.end}${rowNumber}`);
    }
    return rowNumber;
  };

  push([doc.title], 1, 34, [{ start: 'A', end: colName(COLS - 1) }]);
  if (doc.subtitle) {
    push([doc.subtitle], 2, 24, [{ start: 'A', end: colName(COLS - 1) }]);
  }
  push([`生成时间：${doc.generatedAt}　｜　文件编号：${doc.code || ''}　｜　版本：${doc.version || 'V1.0'}`],
    2, 22, [{ start: 'A', end: colName(COLS - 1) }]);
  rowNumber += 1;
  rows.push(`<row r="${rowNumber}" ht="10" customHeight="1"/>`);

  const groupsPerRow = 3;
  const boundaries = Array.from({ length: groupsPerRow + 1 }, (_, index) =>
    Math.floor(COLS * index / groupsPerRow));
  for (const metaRow of doc.metaRows || []) {
    const cells = [];
    const rowMerges = [];
    metaRow.slice(0, groupsPerRow).forEach((item, groupIndex) => {
      const start = boundaries[groupIndex];
      const end = boundaries[groupIndex + 1] - 1;
      const labelEnd = Math.min(end, start + 1);
      cells[start] = item.label;
      cells[labelEnd + 1] = item.value;
      rowMerges.push({ start: colName(start), end: colName(labelEnd) });
      if (labelEnd + 1 <= end) {
        rowMerges.push({ start: colName(labelEnd + 1), end: colName(end) });
      }
    });
    const current = push(cells, 6, 24, rowMerges);
    for (let index = 0; index < COLS; index += 1) {
      if (cells[index] == null) continue;
      rows[rows.length - 1] = rows[rows.length - 1].replace(
        xlsxCell(colName(index) + current, '', 6),
        xlsxCell(colName(index) + current, cells[index], index === boundaries.findIndex(value => value === index) ? 8 : 6)
      );
    }
  }

  if (doc.groups?.length) {
    const cells = [];
    const rowMerges = [];
    let column = 0;
    for (const group of doc.groups) {
      cells[column] = group.label;
      if (group.span > 1) rowMerges.push({ start: colName(column), end: colName(column + group.span - 1) });
      column += group.span;
    }
    push(cells, 7, 26, rowMerges);
  }
  const headerRow = push(columns, 5, 46);
  const dataStart = rowNumber + 1;
  const centerCols = new Set(doc.centerCols || []);
  for (const row of doc.rows || []) {
    const normalized = columns.map((_, index) => row[index] == null ? '' : row[index]);
    rowNumber += 1;
    rows.push(`<row r="${rowNumber}" ht="62" customHeight="1">${normalized.map((value, index) =>
      xlsxCell(colName(index) + rowNumber, value, centerCols.has(index) ? 9 : 6)).join('')}</row>`);
  }
  for (const note of doc.notes || []) {
    push([note], 4, 34, [{ start: 'A', end: colName(COLS - 1) }]);
  }

  const colsXml = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : '';
  const handbookPage = doc.page || {};
  const formSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="70">
<pane xSplit="2" ySplit="${headerRow}" topLeftCell="${colName(2)}${dataStart}" activePane="bottomRight" state="frozen"/>
</sheetView></sheetViews>
<cols>${colsXml}</cols>
<sheetData>${rows.join('')}</sheetData>
${mergeXml}
<pageMargins left="${handbookPage.left ?? 0.25}" right="${handbookPage.right ?? 0.25}" top="${handbookPage.top ?? 0.4}" bottom="${handbookPage.bottom ?? 0.4}" header="0.2" footer="0.2"/>
<pageSetup paperSize="${handbookPage.paperSize || 8}" orientation="${handbookPage.orientation || 'landscape'}" fitToWidth="1" fitToHeight="${handbookPage.fitToHeight ?? 0}"/>
</worksheet>`;

  const guideRows = [
    ['标准依据', doc.source || 'AIAG / VDA 公开标准结构'],
    ['表单名称', sheetName],
    ['项目', doc.projectName || ''],
    ['文件编号', doc.code || ''],
    ['版本', doc.version || 'V1.0'],
    ['生成时间', doc.generatedAt || ''],
    ...(doc.sourceNotes || []).map((item, index) => [`说明 ${index + 1}`, item]),
  ];
  const guideSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="110" customWidth="1"/></cols>
<sheetData>${guideRows.map((row, index) =>
    `<row r="${index + 1}" ht="${index === 0 ? 28 : 24}" customHeight="1">${row.map((value, column) =>
      xlsxCell(colName(column) + (index + 1), value, column === 0 ? 8 : 6)).join('')}</row>`).join('')}</sheetData>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
</worksheet>`;

  const nativeColumns = native?.headers?.length || 0;
  const nativeChartCount = native?.charts?.length || 0;
  const chartAnchors = nativeChartCount >= 2
    ? [{ from: 5, to: 22 }, { from: 23, to: 40 }]
    : nativeChartCount === 1 ? [{ from: 5, to: 24 }] : [];
  const dataHeaderRow = nativeChartCount >= 2 ? 43 : nativeChartCount === 1 ? 27 : 0;
  const dataEndRow = dataHeaderRow + (native?.rows?.length || 0);
  const lastNativeColumn = Math.max(0, nativeColumns - 1);
  const chartSheetRows = native ? [
    `<row r="1" ht="34" customHeight="1">${xlsxCell('A1', native.title || 'SPC 控制图', 1)}</row>`,
    `<row r="2" ht="24" customHeight="1">${xlsxCell('A2', native.subtitle || '', 2)}</row>`,
    '<row r="3" ht="12" customHeight="1"/>',
    `<row r="${dataHeaderRow}" ht="42" customHeight="1">${native.headers.map((value, index) =>
      xlsxCell(colName(index) + dataHeaderRow, value, 5)).join('')}</row>`,
    ...native.rows.map((row, index) => `<row r="${dataHeaderRow + index + 1}" ht="22" customHeight="1">${row.map((value, column) =>
      xlsxCell(colName(column) + (dataHeaderRow + index + 1), value, column === 0 ? 8 : 9)).join('')}</row>`),
  ].join('') : '';
  const chartSheet = native ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="75">
<pane xSplit="1" ySplit="${dataHeaderRow}" topLeftCell="B${dataHeaderRow + 1}" activePane="bottomRight" state="frozen"/>
</sheetView></sheetViews>
<cols>${Array.from({ length: nativeColumns }, (_, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 16 : index === lastNativeColumn - 7 ? 28 : 11}" customWidth="1"/>`).join('')}</cols>
<sheetData>${chartSheetRows}</sheetData>
<mergeCells count="2"><mergeCell ref="A1:${colName(lastNativeColumn)}1"/><mergeCell ref="A2:${colName(lastNativeColumn)}2"/></mergeCells>
<pageMargins left="0.2" right="0.2" top="0.25" bottom="0.25" header="0.15" footer="0.15"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"/>
<drawing r:id="rId1"/>
</worksheet>` : '';

  const chartDrawing = native ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${chartAnchors.map((anchor, index) => `<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.from}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${lastNativeColumn}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.to}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 1}" name="SPC Chart ${index + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId${index + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
</xdr:twoCellAnchor>`).join('')}
</xdr:wsDr>` : '';

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4">
<numFmt numFmtId="164" formatCode="0.00&quot;%&quot;"/>
<numFmt numFmtId="165" formatCode="0.00000"/>
<numFmt numFmtId="166" formatCode="0.000"/>
<numFmt numFmtId="167" formatCode="0.0000"/>
</numFmts>
<fonts count="7">
<font><sz val="9"/><color rgb="FF1F2937"/><name val="${CN_FONT}"/></font>
<font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="${CN_FONT}"/></font>
<font><sz val="9"/><color rgb="FF4B5563"/><name val="${CN_FONT}"/></font>
<font><b/><sz val="10"/><color rgb="FF1F3864"/><name val="${CN_FONT}"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="${CN_FONT}"/></font>
<font><sz val="9"/><color rgb="FF7C5A00"/><name val="${CN_FONT}"/></font>
<font><b/><sz val="9"/><color rgb="FF1F3864"/><name val="${CN_FONT}"/></font>
</fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB7C3D3"/></left><right style="thin"><color rgb="FFB7C3D3"/></right>
<top style="thin"><color rgb="FFB7C3D3"/></top><bottom style="thin"><color rgb="FFB7C3D3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
${native ? `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
${native.charts.map((_, index) => `<Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')}` : ''}
${!native ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ''}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
${native ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    : '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'}
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${native ? '<sheet name="SPC控制图" sheetId="1" r:id="rId1"/>'
    : `<sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/>`}</sheets>
${native ? `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'SPC控制图'!$A$1:$${colName(lastNativeColumn)}$${dataEndRow}</definedName></definedNames>` : ''}
</workbook>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(doc.title)}</dc:title>
<dc:creator>${esc(doc.author || '质量工程部')}</dc:creator></cp:coreProperties>`;
  const common = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
  ];
  if (native) {
    return zip([
      ...common,
      { name: 'xl/worksheets/sheet1.xml', data: chartSheet },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>` },
      { name: 'xl/drawings/drawing1.xml', data: chartDrawing },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${native.charts.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${index + 1}.xml"/>`).join('')}
</Relationships>` },
      ...native.charts.map((chart, index) => ({
        name: `xl/charts/chart${index + 1}.xml`,
        data: spcChartXml(chart, {
          sheetName: 'SPC控制图',
          dataStartRow: dataHeaderRow + 1,
          dataEndRow,
          categories: native.rows.map(row => row[0]),
          chartIndex: index,
        }),
      })),
      { name: 'xl/styles.xml', data: styles },
      { name: 'docProps/core.xml', data: core },
    ]);
  }
  return zip([
    ...common,
    { name: 'xl/worksheets/sheet1.xml', data: formSheet },
    { name: 'xl/worksheets/sheet2.xml', data: guideSheet },
    { name: 'xl/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: core },
  ]);
}

function buildGridWorkbook(sheets, meta = {}) {
  const normalized = sheets.map((sheet, index) => {
    const cells = sheet.cells || {};
    const refs = Object.keys(cells).filter(ref => /^[A-Z]+\d+$/.test(ref));
    const columns = refs.map(ref => ref.match(/^([A-Z]+)/)[1]);
    const rows = refs.map(ref => +ref.match(/(\d+)$/)[1]);
    const maxCol = Math.max(1, ...columns.map(column => {
      let value = 0;
      for (const char of column) value = value * 26 + char.charCodeAt(0) - 64;
      return value;
    }));
    const maxRow = Math.max(1, ...rows);
    const byRow = new Map();
    for (const ref of refs) {
      const row = +ref.match(/(\d+)$/)[1];
      if (!byRow.has(row)) byRow.set(row, []);
      byRow.get(row).push(ref);
    }
    const rowXml = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, rowRefs]) => {
      const sorted = rowRefs.sort((a, b) => {
        const ac = a.match(/^([A-Z]+)/)[1];
        const bc = b.match(/^([A-Z]+)/)[1];
        const value = column => [...column].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
        return value(ac) - value(bc);
      });
      return `<row r="${row}" ht="${sheet.heights?.[row] || 24}" customHeight="1">${sorted.map(ref => {
        const cell = cells[ref] && typeof cells[ref] === 'object' && !Array.isArray(cells[ref])
          ? cells[ref] : { value: cells[ref] };
        return xlsxCell(ref, cell.formula ? cell : cell.value, cell.style || 6);
      }).join('')}</row>`;
    }).join('');
    const widths = sheet.widths?.length === maxCol
      ? sheet.widths
      : Array.from({ length: maxCol }, (_, column) => column === 0 ? 18 : 16);
    const colsXml = widths.map((width, column) =>
      `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`).join('');
    const merges = sheet.merges || [];
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
      : '';
    const freeze = sheet.freeze
      ? `<pane xSplit="${sheet.freeze.xSplit || 0}" ySplit="${sheet.freeze.ySplit || 0}" topLeftCell="${sheet.freeze.topLeftCell || 'A1'}" activePane="bottomRight" state="frozen"/>`
      : '';
    const name = String(sheet.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, '').slice(0, 31);
    const page = sheet.page || {};
    return {
      name,
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="${sheet.zoomScale || 85}">${freeze}</sheetView></sheetViews>
<cols>${colsXml}</cols><sheetData>${rowXml}</sheetData>${mergeXml}
<pageMargins left="${page.left ?? 0.25}" right="${page.right ?? 0.25}" top="${page.top ?? 0.35}" bottom="${page.bottom ?? 0.35}" header="0.2" footer="0.2"/>
<pageSetup paperSize="${page.paperSize || 9}" orientation="${page.orientation || 'portrait'}" fitToWidth="1" fitToHeight="${page.fitToHeight ?? 1}"/>
</worksheet>`,
    };
  });

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4">
<numFmt numFmtId="164" formatCode="0.00&quot;%&quot;"/>
<numFmt numFmtId="165" formatCode="0.00000"/>
<numFmt numFmtId="166" formatCode="0.000"/>
<numFmt numFmtId="167" formatCode="0.0000"/>
</numFmts>
<fonts count="7">
<font><sz val="9"/><name val="${CN_FONT}"/><color rgb="FF1F2937"/></font>
<font><b/><sz val="15"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
<font><b/><sz val="10"/><name val="${CN_FONT}"/><color rgb="FFFFFFFF"/></font>
<font><sz val="9"/><name val="${CN_FONT}"/><color rgb="FF5B6574"/></font>
<font><b/><sz val="10"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
<font><b/><sz val="11"/><name val="${CN_FONT}"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="9"/><name val="${CN_FONT}"/><color rgb="FF9A3412"/></font>
</fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF64748B"/></left><right style="thin"><color rgb="FF64748B"/></right>
<top style="thin"><color rgb="FF64748B"/></top><bottom style="thin"><color rgb="FF64748B"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${normalized.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${normalized.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}
<Relationship Id="rId${normalized.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${normalized.map((sheet, index) =>
    `<sheet name="${esc(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(meta.title || '质量工具导出')}</dc:title>
<dc:creator>${esc(meta.author || '质量工程部')}</dc:creator></cp:coreProperties>`;
  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    ...normalized.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml })),
    { name: 'xl/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: core },
  ]);
}

/* ------------------------------------------------------------------ 自定义模板导出 */
function buildXlsxFromGrid(schema, meta) {
  const COLS = schema.cols.length;
  const widths = schema.cols.map(c => Math.min(60, Math.max(8, c.w || 14)));
  const rowsXml = [];
  const merges = [];

  const vlen = s => {
    let n = 0;
    for (const ch of String(s == null ? '' : s)) n += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    return n;
  };

  schema.rows.forEach((row, ri) => {
    const rn = ri + 1;
    const cells = [];
    let lines = 1;
    row.forEach((cell, ci) => {
      if (!cell || cell.covered) return;
      const ref = colName(ci) + rn;
      const style = cell.header ? 5 : (cell.bold ? 3 : 6);
      cells.push(xlsxCell(ref, cell.v || '', style));
      const cap = Math.max(6, (widths[ci] || 14) - 1);
      lines = Math.max(lines, Math.ceil(vlen(cell.v) / cap));
      if ((cell.cs || 1) > 1 || (cell.rs || 1) > 1) {
        merges.push(`${ref}:${colName(ci + (cell.cs || 1) - 1)}${rn + (cell.rs || 1) - 1}`);
        if ((cell.cs || 1) > 1) {
          const spanW = widths.slice(ci, ci + (cell.cs || 1)).reduce((a, b) => a + b, 0);
          lines = Math.max(lines, Math.ceil(vlen(cell.v) / Math.max(6, spanW - 1)));
        }
      }
    });
    const ht = Math.min(120, Math.max(20, lines * 15 + 5));
    rowsXml.push(`<row r="${rn}" customHeight="1" ht="${ht}">${cells.join('')}</row>`);
  });

  const colsXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<cols>${colsXml}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
${mergeXml}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="10"/><name val="${CN_FONT}"/><color rgb="FF1F2937"/></font>
<font><b/><sz val="14"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
<font><sz val="9"/><name val="${CN_FONT}"/><color rgb="FF6B7280"/></font>
<font><b/><sz val="10"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
<font><b/><sz val="11"/><name val="${CN_FONT}"/><color rgb="FF1F3864"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDF2F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFC9D2DF"/></left><right style="thin"><color rgb="FFC9D2DF"/></right>
<top style="thin"><color rgb="FFC9D2DF"/></top><bottom style="thin"><color rgb="FFC9D2DF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const name = esc((schema.sheetName || meta.name || 'Sheet1').slice(0, 28));
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: styles },
  ]);
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] || match;
  });
}

function textTagMatches(fragment) {
  const out = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match;
  while ((match = re.exec(fragment))) {
    out.push({
      start: match.index,
      end: re.lastIndex,
      openEnd: match.index + match[0].indexOf('>') + 1,
      closeStart: re.lastIndex - '</w:t>'.length,
      text: decodeXml(match[1]),
    });
  }
  return out;
}

function replaceTextMatches(fragment, matches, replacementIndex, value) {
  const encoded = escapeXml(value);
  let out = fragment;
  for (let i = matches.length - 1; i >= replacementIndex; i -= 1) {
    const match = matches[i];
    const next = i === replacementIndex ? encoded : '';
    out = out.slice(0, match.openEnd) + next + out.slice(match.closeStart);
  }
  return out;
}

function replaceContainerText(fragment, value) {
  const matches = textTagMatches(fragment);
  if (matches.length) return replaceTextMatches(fragment, matches, 0, value);
  const text = escapeXml(value);
  const paragraphEnd = fragment.indexOf('</w:p>');
  const run = `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  if (paragraphEnd >= 0) return fragment.slice(0, paragraphEnd) + run + fragment.slice(paragraphEnd);
  return fragment;
}

function replaceFieldText(fragment, value) {
  const matches = textTagMatches(fragment);
  if (!matches.length) return replaceContainerText(fragment, value);
  const full = matches.map(match => match.text).join('');
  const prefixMatch = /^(\s*[\s\S]{1,24}?[：:]\s*)/.exec(full);
  if (!prefixMatch) return replaceTextMatches(fragment, matches, 0, value);
  const prefixLength = prefixMatch[1].length;
  let consumed = 0;
  for (let i = 0; i < matches.length; i += 1) {
    const end = consumed + matches[i].text.length;
    if (prefixLength <= end) {
      const localPrefix = matches[i].text.slice(0, Math.max(0, prefixLength - consumed));
      return replaceTextMatches(fragment, matches, i, localPrefix + value);
    }
    consumed = end;
  }
  return replaceTextMatches(fragment, matches, matches.length - 1, value);
}

function scanTopLevelBlocks(xml) {
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
  if (!bodyMatch) return [];
  const bodyStart = bodyMatch.index + bodyMatch[0].indexOf('>') + 1;
  const content = bodyMatch[1];
  const re = /<\/?w:(p|tbl)\b[^>]*>/g;
  const stack = [];
  const blocks = [];
  let start = 0;
  let match;
  while ((match = re.exec(content))) {
    const tag = match[0];
    const name = match[1];
    const closing = /^<\//.test(tag);
    const selfClosing = /\/>$/.test(tag);
    if (!closing) {
      if (!stack.length) start = bodyStart + match.index;
      if (!selfClosing) stack.push(name);
      else if (!stack.length) blocks.push({ type: name, start, end: bodyStart + re.lastIndex });
      continue;
    }
    if (!stack.length || stack[stack.length - 1] !== name) continue;
    stack.pop();
    if (!stack.length) blocks.push({ type: name, start, end: bodyStart + re.lastIndex });
  }
  return blocks;
}

function elementSpans(fragment, name) {
  const re = new RegExp(`<w:${name}\\b[^>]*>[\\s\\S]*?<\\/w:${name}>`, 'g');
  const out = [];
  let match;
  while ((match = re.exec(fragment))) out.push({ start: match.index, end: re.lastIndex, xml: match[0] });
  return out;
}

function replaceSpan(fragment, span, value) {
  return fragment.slice(0, span.start) + value + fragment.slice(span.end);
}

function patchTable(tableXml, block) {
  let rows = elementSpans(tableXml, 'tr');
  const sourceRows = Array.isArray(block.sourceRowIndexes) && block.sourceRowIndexes.length
    ? block.sourceRowIndexes
    : Array.from({ length: Math.min(rows.length, block.rows.length + 1) }, (_, i) => i);
  const valuesRows = Array.isArray(block.rows) ? block.rows : [];
  const headerIndex = sourceRows[0];
  const dataIndexes = sourceRows.slice(1);
  const applyRowValues = (rowXml, values) => {
    const cells = elementSpans(rowXml, 'tc');
    let out = rowXml;
    for (let column = Math.min(cells.length, values.length) - 1; column >= 0; column -= 1) {
      out = replaceSpan(out, cells[column], replaceContainerText(cells[column].xml, values[column]));
    }
    return out;
  };
  const patches = [];
  if (headerIndex != null && rows[headerIndex]) {
    patches.push({ row: headerIndex, values: (block.cols || []).map(col => col.label || '') });
  }
  valuesRows.forEach((values, index) => {
    const sourceRow = dataIndexes[index];
    if (sourceRow != null && rows[sourceRow]) patches.push({ row: sourceRow, values });
  });
  for (const patch of patches.slice().sort((a, b) => b.row - a.row)) {
    const row = rows[patch.row];
    if (!row) continue;
    const rowXml = applyRowValues(row.xml, patch.values);
    rows = elementSpans(
      tableXml.slice(0, row.start) + rowXml + tableXml.slice(row.end),
      'tr'
    );
    tableXml = tableXml.slice(0, row.start) + rowXml + tableXml.slice(row.end);
  }
  // A-11：在线删除的行必须从源 DOCX 移除，否则下载文件仍保留旧行
  if (dataIndexes.length > valuesRows.length) {
    const removeIndexes = dataIndexes.slice(valuesRows.length).slice().sort((a, b) => b - a);
    for (const rowIndex of removeIndexes) {
      const current = elementSpans(tableXml, 'tr')[rowIndex];
      if (current) tableXml = tableXml.slice(0, current.start) + tableXml.slice(current.end);
    }
  }
  // A-11：在线新增的行克隆最后一个数据行，替换文本后追加
  if (valuesRows.length > dataIndexes.length) {
    const currentRows = elementSpans(tableXml, 'tr');
    const templateIndex = Math.min(
      dataIndexes.length ? dataIndexes[dataIndexes.length - 1] : currentRows.length - 1,
      currentRows.length - 1
    );
    const templateRow = currentRows[templateIndex];
    if (templateRow) {
      const added = valuesRows.slice(dataIndexes.length)
        .map(values => applyRowValues(templateRow.xml, values)).join('');
      tableXml = tableXml.slice(0, templateRow.end) + added + tableXml.slice(templateRow.end);
    }
  }
  return tableXml;
}

function patchDocxFromSource(sourceBuffer, schema) {
  const P = require('./parse');
  const files = P.readZip(sourceBuffer);
  let documentXml = (files.get('word/document.xml') || Buffer.alloc(0)).toString('utf8');
  if (!documentXml) throw new Error('原 Word 模板缺少 word/document.xml');
  const topBlocks = scanTopLevelBlocks(documentXml);
  const patches = [];
  for (const block of schema.blocks || []) {
    if (!['field', 'table'].includes(block.type)) continue;
    let span = topBlocks[+block.sourceIndex];
    if (!span || span.type !== (block.type === 'table' ? 'tbl' : 'p')) {
      const expected = block.type === 'table' ? 'tbl' : 'p';
      span = topBlocks.find(item => item.type === expected && item.start > (patches.at(-1)?.start || -1));
    }
    if (!span) continue;
    patches.push({ ...span, block });
  }
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    const fragment = documentXml.slice(patch.start, patch.end);
    const updated = patch.block.type === 'table'
      ? patchTable(fragment, patch.block)
      : replaceFieldText(fragment, patch.block.value || '');
    documentXml = documentXml.slice(0, patch.start) + updated + documentXml.slice(patch.end);
  }
  files.set('word/document.xml', Buffer.from(documentXml, 'utf8'));
  return zip([...files.entries()].map(([name, data]) => ({ name, data })));
}

function buildDocxFromBlocks(schema, meta) {
  const body = [];
  body.push(docxPara(meta.name, { align: 'center', bold: true, size: 36, spaceAfter: 160, color: '1F3864' }));
  for (const b of schema.blocks) {
    if (b.type === 'text') {
      const isHead = b.text.length <= 20 && !/[。；，]/.test(b.text);
      body.push(docxPara(b.text, isHead
        ? { bold: true, size: 24, spaceBefore: 180, spaceAfter: 90, color: '1F3864' }
        : { size: 21, spaceAfter: 90 }));
    } else if (b.type === 'field') {
      body.push(`<w:p><w:pPr><w:spacing w:after="90" w:line="300" w:lineRule="auto"/></w:pPr>
        ${docxRuns(b.label + '：', { bold: true, size: 20, color: '374151' })}
        ${docxRuns(b.value && b.value !== '' ? b.value : '　　　　　　', { size: 20 })}</w:p>`);
    } else {
      body.push(docxTable(b.cols.map(c => c.label), b.rows));
    }
  }
  body.push(docxPara(`生成时间：${meta.generatedAt}　｜　模板：${meta.name}`, { size: 16, color: '9CA3AF' }));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418"/></w:sectPr>
</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/>
<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;
  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles },
  ]);
}

module.exports = {
  buildDocx, buildXlsx, buildHandbookXlsx, buildGridWorkbook, buildXlsxFromGrid, buildDocxFromBlocks,
  buildSpcControlChartSvg, patchDocxFromSource, patchTable, zip, crc32,
  // 附件导出与前端/测试共用：读图片头、等比缩放
  rasterSize, fitImageInches,
};
