'use strict';

/**
 * 交付物附件（包装图片 / 工程图）验收：
 *   - 上传 PNG / PDF / DXF 成功，列表返回元数据与访问 URL；
 *   - 魔数不符、超出大小、类型不符被拒绝；
 *   - 重复文件被拒绝；
 *   - 作废后列表不显示、记录与文件保留；
 *   - 跨项目访问 404；
 *   - 已批准交付物不允许增删附件；
 *   - 文件回传的 Content-Type 与字节数正确；
 *   - P3-02 / P2-06 的 Word 导出包含图片（<w:drawing> + media/img-N.png）。
 *
 * 运行：node tests/attachment-api.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const EX = require('../lib/export');
const P = require('../lib/parse');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-attach-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 8891 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'ATT-ACC';
const OTHER_PROJECT = 'RES-CHIP-2026-01';
const PASSWORDS = {
  admin: 'Attach-Admin-2026!', quality: 'Attach-Quality-2026!',
  engineer: 'Attach-Engineer-2026!', auditor: 'Attach-Auditor-2026!',
};
const cookies = {};
let child = null;
let checks = 0;

async function api(method, url, options = {}) {
  const { as = 'admin', body } = options;
  let target = url.startsWith('/api/') ? url.slice(4) : url;
  if (target !== '/projects' && target !== '/auth/login' && !target.includes('p=')) {
    target += (target.includes('?') ? '&' : '?') + 'p=' + encodeURIComponent(PROJECT);
  }
  const response = await fetch(`${BASE}/api${target}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies[as] ? { Cookie: cookies[as] } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; }
  return { status: response.status, json, buffer, headers: response.headers };
}

async function ok(promise, label) {
  const response = await promise;
  const payload = response.json;
  if (response.status !== 200 || !payload) {
    throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function login(username, password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `登录失败 ${username}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/meta`);
      if (response.status === 401 || response.ok) return;
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未启动');
}

/** 最小的合法 PNG（1×1），直接给 base64，不带 data URL 前缀 */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}
/** 第二个不同的 PNG：在文件尾部追加 IEND 之后的私有块，保证 sha256 不同 */
function secondPng() {
  const base = tinyPng();
  return Buffer.concat([base, Buffer.from('\nPADDING-2\n', 'latin1')]);
}
function tinyPdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
}
function tinyDxf() {
  return Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n', 'latin1');
}

async function main() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: PASSWORDS.admin, QMS_QUALITY_PASSWORD: PASSWORDS.quality,
      QMS_ENGINEER_PASSWORD: PASSWORDS.engineer, QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await waitForServer();
    for (const role of ['admin', 'quality', 'engineer', 'auditor']) {
      cookies[role] = await login(role, PASSWORDS[role]);
    }
    await ok(api('POST', '/projects', {
      body: { project_id: PROJECT, name: '附件验收项目', family_id: 'FM' },
    }), '新建项目');

    /* ------------------------------------------- 上传三类附件 */
    const png = await ok(api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', caption: '外箱唛头正面',
        group_label: '外箱', file_name: 'carton.png',
        dataBase64: tinyPng().toString('base64'),
      },
    }), '上传 PNG');
    assert.ok(png.item && png.item.attachment_id, '返回附件记录');
    assert.equal(png.item.mime, 'image/png', '按魔数识别 PNG');
    assert.equal(png.item.is_image, true, '标记为图片');
    // 访问 URL 必须自带项目参数：<img src> / <embed src> 不经过前端 api()，
    // 少了 ?p= 服务端会按默认项目解析，非默认项目的附件一律 404（曾导致“上传成功但预览空白”）
    assert.match(png.item.url, /\/api\/attachments\/.+\/file\?p=ATT-ACC$/, '返回带项目参数的访问 URL');
    assert.match(png.item.download_url, /\/file\?p=ATT-ACC&download=1$/, '下载 URL 同样带项目参数');
    checks += 5;

    const pdf = await ok(api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', caption: '标签样式', group_label: '标签',
        file_name: 'label.pdf', dataBase64: tinyPdf().toString('base64'),
      },
    }), '上传 PDF');
    assert.equal(pdf.item.mime, 'application/pdf', '按魔数识别 PDF');
    assert.equal(pdf.item.is_pdf, true, '标记为 PDF');
    checks += 2;

    const dxf = await ok(api('POST', '/attachments', {
      body: {
        doc_code: 'P2-06', category: 'drawing-source', caption: '二维图源文件',
        file_name: 'part.dxf', dataBase64: tinyDxf().toString('base64'),
      },
    }), '上传 DXF');
    assert.equal(dxf.item.mime, 'image/vnd.dxf', '按内容识别 DXF');
    assert.equal(dxf.item.is_image, false, 'CAD 源文件不是图片');
    checks += 2;

    const preview = await ok(api('POST', '/attachments', {
      body: {
        doc_code: 'P2-06', category: 'drawing-preview', caption: '总装图首页',
        file_name: 'drawing.png', dataBase64: secondPng().toString('base64'),
      },
    }), '上传图纸预览');
    assert.equal(preview.item.category, 'drawing-preview');
    checks += 1;

    /* ------------------------------------------- 校验拒绝 */
    const badMagic = await api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', file_name: 'fake.png',
        dataBase64: Buffer.from('this is not an image at all, just text padding........').toString('base64'),
      },
    });
    assert.equal(badMagic.status, 400, '魔数不符应拒绝');
    assert.match(String(badMagic.json.error), /类型不符|只接受/, '错误提示应说明类型');
    checks += 2;

    const wrongCategory = await api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', file_name: 'part.dxf',
        dataBase64: tinyDxf().toString('base64'),
      },
    });
    assert.equal(wrongCategory.status, 400, '包装图片不接受 CAD 源文件');
    checks += 1;

    const tooBig = await api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', file_name: 'big.png',
        dataBase64: Buffer.concat([tinyPng(), Buffer.alloc(8 * 1024 * 1024 + 16)]).toString('base64'),
      },
    });
    assert.equal(tooBig.status, 400, '超过 8 MB 应拒绝');
    checks += 1;

    const duplicate = await api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', file_name: 'carton-copy.png',
        dataBase64: tinyPng().toString('base64'),
      },
    });
    assert.equal(duplicate.status, 400, '相同文件应拒绝重复上传');
    assert.match(String(duplicate.json.error), /已存在/, '重复文件提示');
    checks += 2;

    const badCategory = await api('GET', '/attachments?doc=P3-02&category=nope');
    assert.equal(badCategory.status, 400, '未知附件类型应拒绝');
    checks += 1;

    /* ------------------------------------------- 列表与文件回传 */
    const listed = await ok(api('GET', '/attachments?doc=P3-02&category=packaging'), '读取包装附件');
    assert.equal(listed.list.length, 2, '包装附件应为 2 条');
    assert.ok(listed.categories.length >= 3, '返回可选附件类型');
    checks += 2;

    const fileResponse = await api('GET', `/attachments/${encodeURIComponent(png.item.attachment_id)}/file`);
    assert.equal(fileResponse.status, 200, '文件回传 200');
    assert.equal(fileResponse.headers.get('content-type'), 'image/png', 'Content-Type 正确');
    assert.deepEqual(fileResponse.buffer, tinyPng(), '回传字节与上传一致');
    assert.match(String(fileResponse.headers.get('content-disposition')), /inline/, '预览默认 inline');
    checks += 3;

    const downloadResponse = await api('GET', `/attachments/${encodeURIComponent(png.item.attachment_id)}/file?download=1`);
    assert.match(String(downloadResponse.headers.get('content-disposition')), /attachment/, '下载标记 attachment');
    checks += 1;

    // 浏览器直接拿 API 返回的 url 去请求（不经 api() 补 p），必须一次成功
    const direct = await fetch(`${BASE}${png.item.url}`, { headers: { Cookie: cookies.admin } });
    assert.equal(direct.status, 200, 'API 返回的 url 可直接用于 <img src>');
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), tinyPng(), '直连 url 字节一致');
    // 反过来：不带 p 的旧式 url 会落到默认项目 → 404（这正是曾经的缺陷）
    const legacyUrl = `${BASE}/api/attachments/${encodeURIComponent(png.item.attachment_id)}/file`;
    const legacy = await fetch(legacyUrl, { headers: { Cookie: cookies.admin } });
    assert.equal(legacy.status, 404, '缺少项目参数的附件 URL 在非默认项目下 404');
    checks += 3;

    /* ------------------------------------------- 说明/分类编辑 */
    const patched = await ok(api('PATCH', `/attachments/${encodeURIComponent(png.item.attachment_id)}`, {
      body: { caption: '外箱唛头（正面）', group_label: '外箱' },
    }), '编辑附件说明');
    assert.equal(patched.item.caption, '外箱唛头（正面）');
    checks += 1;

    /* ------------------------------------------- 作废保留 */
    const voided = await ok(api('POST', `/attachments/${encodeURIComponent(pdf.item.attachment_id)}/void`, {
      body: { reason: '标签样式已改版，旧图作废' },
    }), '作废附件');
    assert.equal(voided.status, '作废');
    const afterVoid = await ok(api('GET', '/attachments?doc=P3-02&category=packaging'), '作废后列表');
    assert.equal(afterVoid.list.length, 1, '默认列表不显示作废附件');
    const withVoided = await ok(api('GET', '/attachments?doc=P3-02&category=packaging&include_voided=1'), '含作废列表');
    assert.equal(withVoided.list.length, 2, 'include_voided=1 仍能看到记录');
    const voidedFile = await api('GET', `/attachments/${encodeURIComponent(pdf.item.attachment_id)}/file`);
    assert.equal(voidedFile.status, 200, '作废后文件仍保留可追溯');
    checks += 4;

    const noReason = await api('POST', `/attachments/${encodeURIComponent(preview.item.attachment_id)}/void`, {
      body: { reason: '短' },
    });
    assert.equal(noReason.status, 400, '作废原因不足 4 字应拒绝');
    checks += 1;

    /* ------------------------------------------- 项目隔离 */
    const otherProject = await api('GET', `/attachments?doc=P3-02&p=${encodeURIComponent(OTHER_PROJECT)}`);
    assert.equal(otherProject.status, 200);
    assert.equal((otherProject.json.list || []).length, 0, '其他项目看不到本项目附件');
    const crossFile = await api('GET', `/attachments/${encodeURIComponent(png.item.attachment_id)}/file?p=${encodeURIComponent(OTHER_PROJECT)}`);
    assert.equal(crossFile.status, 404, '跨项目读取附件应 404');
    checks += 3;

    /* ------------------------------------------- 锁定状态 */
    // 交付物状态必须走 submit 接口，不能通过保存接口直接设置
    await ok(api('POST', '/docs/P3-02/submit', {
      body: { change_note: '附件验收：提交以验证锁定状态' },
    }), '提交 P3-02');
    const lockedUpload = await api('POST', '/attachments', {
      body: {
        doc_code: 'P3-02', category: 'packaging', file_name: 'late.png',
        dataBase64: Buffer.concat([tinyPng(), Buffer.from('late')]).toString('base64'),
      },
    });
    assert.equal(lockedUpload.status, 409, '待审核交付物不允许上传附件');
    assert.match(String(lockedUpload.json.error), /发起修订/, '提示先发起修订');
    checks += 2;

    /* ------------------------------------------- 导出含图片 */
    const p3Export = await fetch(`${BASE}/api/docs/P3-02/export?fmt=docx&p=${encodeURIComponent(PROJECT)}`, {
      headers: { Cookie: cookies.admin },
    });
    assert.equal(p3Export.status, 200, 'P3-02 Word 导出成功');
    const p3Zip = P.readZip(Buffer.from(await p3Export.arrayBuffer()));
    const documentXml = p3Zip.get('word/document.xml').toString('utf8');
    assert.match(documentXml, /<w:drawing>/, 'P3-02 导出包含图片');
    assert.ok([...p3Zip.keys()].some(name => /word\/media\/img-\d+\.png$/.test(name)),
      '导出包含 PNG 媒体文件');
    assert.match(documentXml, /外箱唛头（正面）/, '导出包含图片说明');
    checks += 3;

    const p2Export = await fetch(`${BASE}/api/docs/P2-06/export?fmt=docx&p=${encodeURIComponent(PROJECT)}`, {
      headers: { Cookie: cookies.admin },
    });
    assert.equal(p2Export.status, 200, 'P2-06 Word 导出成功');
    const p2Zip = P.readZip(Buffer.from(await p2Export.arrayBuffer()));
    assert.match(p2Zip.get('word/document.xml').toString('utf8'), /图纸预览/, 'P2-06 导出包含图纸预览节');
    checks += 2;

    /* ------------------------------------------- 导出图片尺寸 */
    const fitted = EX.fitImageInches({ width: 1200, height: 3200 }, { maxWidth: 5.9, maxHeight: 3.2 });
    assert.ok(fitted.widthInches <= 5.9 + 1e-9 && fitted.heightInches <= 3.2 + 1e-9, '等比缩放在限制内');
    assert.ok(Math.abs((fitted.widthInches / fitted.heightInches) - (1200 / 3200)) < 0.01, '保持宽高比');
    const size = EX.rasterSize(tinyPng());
    assert.deepEqual([size.width, size.height, size.ext], [1, 1, 'png'], 'PNG 尺寸识别');
    checks += 3;

    /* ------------------------------------------- 备份包含附件 */
    // 中文文件名：备份复制曾因平台 cpSync 崩溃，这里留一个回归样本
    await ok(api('POST', '/attachments', {
      body: {
        doc_code: 'P2-06', category: 'drawing-preview', caption: '中文名图纸预览',
        file_name: '总装图.png',
        dataBase64: Buffer.concat([tinyPng(), Buffer.from('cn')]).toString('base64'),
      },
    }), '上传中文名附件');
    const backup = await ok(api('POST', '/admin/backup', { body: {} }), '创建备份');
    assert.ok(backup.attachments >= 1, `备份应复制附件文件（实际 ${backup.attachments}）`);
    const backupDir = path.join(TEMP, 'backups', backup.name.replace(/\.db$/, '') + '-attachments');
    assert.ok(fs.existsSync(backupDir), '备份目录下应有 -attachments 文件夹');
    const backupList = await ok(api('GET', '/admin/backups', {}), '读取备份列表');
    assert.equal(backupList.list.find(item => item.name === backup.name)?.has_attachments, true,
      '备份列表应标记含附件');
    checks += 3;

    console.log(`attachment-api: 上传/校验/作废/隔离/导出 通过（${checks} checks）`);
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 400));
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
    if (stderr && /Error/.test(stderr)) console.error(stderr.slice(0, 600));
  }
}

main().catch(error => {
  console.error('附件验收失败：');
  console.error(error);
  process.exitCode = 1;
});
