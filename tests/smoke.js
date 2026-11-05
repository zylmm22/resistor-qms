'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const EX = require('../lib/export');
const P = require('../lib/parse');
const L = require('../lib/logic');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resistor-qms-test-'));
const DB_PATH = path.join(TMP, 'qms.db');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
// 不使用系统已知默认口令（服务端把它们列入黑名单），每个测试库用独立口令
const SMOKE_PASSWORDS = {
  admin: 'Smoke-Admin-2026!', engineer: 'Smoke-Engineer-2026!',
  quality: 'Smoke-Quality-2026!', auditor: 'Smoke-Auditor-2026!',
};
let output = '';
let cookie = '';

function singleEntryZip(raw, method = 8, name = 'xl/workbook.xml') {
  const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(8, 8);
  eocd.writeUInt16LE(8, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // 测试显式配置口令：系统已不再内置已知默认口令，未配置时会生成一次性随机口令并写入文件
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH, NODE_NO_WARNINGS: '1',
      QMS_ADMIN_PASSWORD: SMOKE_PASSWORDS.admin, QMS_ENGINEER_PASSWORD: SMOKE_PASSWORDS.engineer,
      QMS_QUALITY_PASSWORD: SMOKE_PASSWORDS.quality, QMS_AUDITOR_PASSWORD: SMOKE_PASSWORDS.auditor,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${BASE}/meta?p=RES-CHIP-2026-01`);
      if (response.ok || response.status === 401) return;
    } catch (e) { /* 等待端口就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务器未启动');
}

// as：以指定账号的会话发起请求。审批链要求“提交人 ≠ 批准人”，
// 因此提交用当前账号，批准用另一个账号的 cookie。
async function request(url, options = {}) {
  const { as, ...fetchOptions } = options;
  const response = await fetch(BASE + url, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...((as || cookie) ? { Cookie: as || cookie } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && !as) cookie = setCookie.split(';')[0];
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function main() {
  assert.throws(() => P.readZip(singleEntryZip(Buffer.from('broken'), 99)), /不支持的 ZIP 压缩方式/);
  assert.throws(() => P.readZip(singleEntryZip(Buffer.alloc(33 * 1024 * 1024))), /ZIP 条目过大|解压失败/);
  // 未闭合的注释/CDATA 曾让解析器死循环卡住整个进程，必须抛错而不是挂起
  assert.throws(() => P.parseXml('<a><!-- never closed'), /XML 注释未闭合/);
  assert.throws(() => P.parseXml('<a><![CDATA[ never closed'), /XML CDATA 未闭合/);
  assert.equal(P.textOf(P.parseXml('<a><!-- ok --><b>x</b></a>')), 'x');
  const server = startServer();
  try {
    await waitForServer();
    const unauthenticated = await fetch(`${BASE}/meta?p=RES-CHIP-2026-01`);
    assert.equal(unauthenticated.status, 401, '未登录 API 必须拒绝访问');
    const login = await request('/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: SMOKE_PASSWORDS.admin },
    });
    assert.equal(login.user.role, 'admin');
    const auditorLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ username: 'auditor', password: SMOKE_PASSWORDS.auditor }),
    });
    // 不校验状态就直接 split，密码错/被限流时只会抛 null-deref，真正原因被掩盖
    assert.equal(auditorLogin.status, 200,
      `审核员应能登录（实际 ${auditorLogin.status}：${await auditorLogin.text()}）`);
    const auditorSetCookie = auditorLogin.headers.get('set-cookie');
    assert.ok(auditorSetCookie, '登录响应必须下发会话 Cookie');
    const auditorCookie = auditorSetCookie.split(';')[0];
    const auditorRead = await fetch(`${BASE}/meta?p=RES-CHIP-2026-01`, {
      headers: { Cookie: auditorCookie },
    });
    assert.equal(auditorRead.status, 200, '审核员可以读取项目数据');
    // 审批必须由“提交人之外”的质量角色执行：单独登录 quality 账号用于批准
    const qualityLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ username: 'quality', password: SMOKE_PASSWORDS.quality }),
    });
    assert.equal(qualityLogin.status, 200, '质量账号应能登录');
    const qualitySetCookie = qualityLogin.headers.get('set-cookie');
    assert.ok(qualitySetCookie, '登录响应必须下发会话 Cookie');
    const qualityCookie = qualitySetCookie.split(';')[0];
    const auditorWrite = await fetch(`${BASE}/projects?p=RES-CHIP-2026-01`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: auditorCookie },
      body: JSON.stringify({ name: 'should fail', project_id: 'AUDITOR-BLOCKED' }),
    });
    assert.equal(auditorWrite.status, 403, '审核员不能写入项目数据');
    const project = 'RES-CHIP-2026-01';
    const meta = await request(`/meta?p=${project}`);
    assert.equal(meta.project.project_id, project);
    assert.equal(meta.project.series_id, 'SR-RJ');
    assert.ok(meta.project.series_name);
    const families = await request(`/product-families?p=${project}`);
    const series = await request(`/product-series?family=FM&p=${project}`);
    assert.ok(families.list.some(item => item.family_id === 'FM'));
    assert.ok(series.list.some(item => item.series_id === 'SR-RJ'));
    assert.equal(families.list.find(item => item.family_id === 'FM').category, '通用类产品');
    assert.ok(families.list.some(item =>
      item.family_id === 'PF-LOW-OHM' && item.category === '特种类产品'));
    const thinFilmSeries = await request('/product-series?family=PF-CHIP-THIN&p=' + project);
    assert.ok(thinFilmSeries.list.some(item => item.code === 'RMV'),
      '产品手册中的 RMV 系列应进入片式薄膜电阻器目录');
    const samplingSeries = await request('/product-series?family=PF-LOW-OHM&p=' + project);
    assert.ok(samplingSeries.list.some(item => item.code.includes('RMLK7142DW')),
      '产品手册中的超低阻采样系列应进入特种产品目录');

    const scopedChar = await request(`/chars?p=${project}`, {
      method: 'POST',
      body: {
        name: 'RJ 系列专用阻值等级', char_kind: 'PRODUCT', target: 10, unit: 'kΩ',
        family_id: 'FM', series_id: 'SR-RJ', source_type: '内部',
      },
    });
    const rjDictionary = await request(`/project-chars?p=${project}`);
    const rxDictionary = await request(`/project-chars?p=RES-WIRE-2026-01`);
    assert.ok(rjDictionary.dictionary.some(item => item.char_id === scopedChar.char_id));
    assert.ok(!rxDictionary.dictionary.some(item => item.char_id === scopedChar.char_id),
      'RJ 系列专用特性不得出现在 RX 系列项目');
    const aiCharacter = await request(`/ai/character-name?p=${project}`, {
      method: 'POST',
      body: {
        char_kind: 'PROCESS',
        description: '划槽深度目标 21 微米，上下允许偏差 3 微米，太浅掰不断，太深伤基片',
      },
    });
    assert.equal(aiCharacter.name, '切槽深度');
    assert.equal(aiCharacter.target, 21);
    assert.equal(aiCharacter.lsl, 18);
    assert.equal(aiCharacter.usl, 24);
    assert.equal(aiCharacter.unit, 'μm');
    const describedChar = await request(`/chars?p=${project}`, {
      method: 'POST',
      body: {
        name: aiCharacter.name, description: aiCharacter.description,
        char_kind: 'PROCESS', unit: aiCharacter.unit, target: aiCharacter.target,
        lsl: aiCharacter.lsl, usl: aiCharacter.usl, tol_text: aiCharacter.tol_text,
        family_id: 'FM', series_id: 'SR-RJ', source_type: 'AI标准化测试',
      },
    });
    const describedImported = await request(`/project-chars/from-dictionary?p=${project}`, {
      method: 'POST', body: { char_id: describedChar.char_id },
    });
    assert.ok(describedImported.item.description.includes('划槽深度'));
    const charsAfterDescription = await request(`/chars?p=${project}`);
    assert.ok(charsAfterDescription.some(item =>
      item.char_id === describedChar.char_id && item.description.includes('划槽深度')));
    const traceProcessChar = await request(`/chars?p=${project}`, {
      method: 'POST',
      body: {
        name: '测试激光功率', char_kind: 'PROCESS', unit: 'W',
        family_id: 'FM', series_id: 'SR-RJ', source_type: '测试',
      },
    });
    await request(`/char-links?p=${project}`, {
      method: 'POST',
      body: {
        product_char_id: scopedChar.char_id, process_char_id: traceProcessChar.char_id,
        direction: '正相关', strength: '中', mechanism: '激光能量影响最终阻值',
        user: 'Tester',
      },
    });
    const trace = await request(`/chars/${traceProcessChar.char_id}?p=${project}`);
    assert.ok(trace.up.some(link => link.product_char_id === scopedChar.char_id));
    assert.ok(Array.isArray(trace.projectChars));
    assert.ok(Array.isArray(trace.fmeaRows));
    assert.ok(Array.isArray(trace.msaPlans));
    assert.equal(trace.fmeaRows.length, 0, '未建立 PFMEA 时穿透接口应返回空链路，由界面明确显示缺口');

    const blank = await request(`/projects?p=${project}`, {
      method: 'POST',
      body: {
        name: 'Blank Scoped Project', project_id: 'AUTO-EMPTY-001',
        family_id: 'FM', series_id: 'SR-RJ', owner: 'Tester', part_no: 'BLANK-001',
      },
    });
    assert.equal(blank.project_id, 'AUTO-EMPTY-001');
    const blankInitialCharDoc = await request('/docs/P1-11?p=AUTO-EMPTY-001');
    const blankInitialCharFields = blankInitialCharDoc.sections.flatMap(section => section.fields);
    assert.equal(blankInitialCharFields.find(field => field.k === 'proj').value, 'Blank Scoped Project');
    assert.equal(blankInitialCharFields.find(field => field.k === 'part_no').value, 'BLANK-001');
    await request('/docs/P1-07?p=AUTO-EMPTY-001', {
      method: 'PUT',
      body: { data: {
        proj: 'Blank Scoped Project', part_no: 'BLANK-001', author: 'Tester', date: '2026-11-01',
        targets: [['阻值', '1 kΩ', '±1%', '测试要求']], rationale: '初始依据',
      }, cols: {}, status: '草稿', change_note: '模拟项目：填写设计目标' },
    });
    await request('/docs/P1-07/submit?p=AUTO-EMPTY-001', { method: 'POST', body: { user: 'Tester' } });
    await request('/docs/P1-07/approve?p=AUTO-EMPTY-001', {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    const approvedTargetDoc = await request('/docs/P1-07?p=AUTO-EMPTY-001');
    const editedTargetData = { ...approvedTargetDoc.data, rationale: '修改后的依据' };
    const demotedDoc = await request('/docs/P1-07?p=AUTO-EMPTY-001', {
      method: 'PUT', body: {
        data: editedTargetData, cols: {}, status: '已批准',
        version: approvedTargetDoc.version, approved_by: 'Quality Manager', change_note: '模拟项目：修订目标依据',
      },
    });
    assert.equal(demotedDoc.status, '草稿', '已批准文档内容发生变化后需退回草稿重新提交');
    assert.equal((await request('/docs/P1-07?p=AUTO-EMPTY-001')).status, '草稿',
      '保存响应和回读状态必须一致，不能让用户误以为仍已批准');
    const blankChars = await request(`/project-chars?p=AUTO-EMPTY-001`);
    assert.equal(blankChars.items.length, 0, '空白项目不得自动灌入整个产品族特性字典');
    const blankCp = await request(`/cp?p=AUTO-EMPTY-001`);
    assert.equal(blankCp.projectChars.length, 0);
    const manualSeriesProject = await request(`/projects?p=${project}`, {
      method: 'POST',
      body: {
        name: 'Manual RXG Project', project_id: 'AUTO-MANUAL-RXG',
        family_id: 'FW', series_code: 'RXG', series_name: 'RXG 国军标线绕电阻器',
        part_no: 'RXG-5W-22R', owner: 'Tester',
      },
    });
    assert.equal(manualSeriesProject.project.series_id.startsWith('SR-MAN-FW-RXG'), true);
    const manualSeriesList = await request('/product-series?family=FW&p=' + project);
    assert.ok(manualSeriesList.list.some(item => item.code === 'RXG'
      && item.name === 'RXG 国军标线绕电阻器'));
    const legacyTypeChar = await request('/chars?p=AUTO-EMPTY-001', {
      method: 'POST', body: {
        name: '历史产品特性', char_kind: 'PRODUCT', family_id: 'FM', series_id: 'SR-RJ',
        source_type: 'E2E',
      },
    });
    const charCols = blankInitialCharDoc.sections.flatMap(section => section.fields)
      .find(field => field.k === 'chars').cols;
    await request('/docs/P1-11?p=AUTO-EMPTY-001', {
      method: 'PUT', body: {
        data: {
          proj: 'Blank Scoped Project', part_no: 'BLANK-001', author: 'Tester', date: '2026-11-01',
          chars: [[legacyTypeChar.char_id, '历史产品特性', 'CC', '旧图纸',
            '沿用已有明确字典分类', '', '组织', '旧图纸-1', 'Rev 1']],
        },
        cols: { chars: charCols }, status: '草稿', change_note: '模拟项目：补齐历史特性识别主体',
      },
    });
    const backfilledTypeDoc = await request('/docs/P1-11?p=AUTO-EMPTY-001');
    assert.equal(backfilledTypeDoc.data.chars[0][5], 'PRODUCT',
      '历史空类型应仅从同编号明确特性字典类型回填');
    await request('/docs/P1-11/submit?p=AUTO-EMPTY-001', { method: 'POST', body: { user: 'Tester' } });
    await request('/docs/P1-11/approve?p=AUTO-EMPTY-001', {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    const initialCharLinks = await request('/deliverable-links?doc=P1-11&p=AUTO-EMPTY-001');
    const initialCharCandidate = initialCharLinks.items.find(item =>
      item.ruleId === 'initial-special-characteristic');
    assert.ok(initialCharCandidate && initialCharCandidate.kind === 'candidate');
    assert.equal((await request('/project-chars?p=AUTO-EMPTY-001')).items.length, 0,
      'Initial special-characteristic recognition must not directly create a formal project characteristic');
    await request(`/deliverable-links/${initialCharCandidate.id}/resolve?p=AUTO-EMPTY-001`, {
      method: 'POST', body: { action: 'adopt' },
    });
    await request('/docs/P2-11/submit?p=AUTO-EMPTY-001', {
      method: 'POST', body: { user: 'Tester' },
    });
    await request('/docs/P2-11/approve?p=AUTO-EMPTY-001', {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    const typeLinkedChars = await request('/project-chars?p=AUTO-EMPTY-001');
    assert.ok(typeLinkedChars.items.some(item =>
      item.char_id === legacyTypeChar.char_id && item.char_kind === 'PRODUCT'),
    'P1-11批准必须把回填的显式类型联动到项目特性');

    const variableSubs = Array.from({ length: 10 }, (_, index) => ({
      t: `S${index + 1}`,
      v: [10 + index * 0.001, 10.002 + index * 0.001, 9.998 + index * 0.001,
        10.001 + index * 0.001, 9.999 + index * 0.001],
    }));
    assert.equal(L.spcCompute(variableSubs, { lsl: 9.9, usl: 10.1 }, { chartType: 'Xbar-R' }).chartType, 'Xbar-R');
    assert.equal(L.spcCompute(variableSubs, { lsl: 9.9, usl: 10.1 }, { chartType: 'Xbar-S' }).chartType, 'Xbar-S');
    assert.equal(L.spcCompute(variableSubs.map((row, index) => ({ t: row.t, v: [10 + index * 0.001] })),
      { lsl: 9.9, usl: 10.1 }, { chartType: 'I-MR' }).chartType, 'I-MR');
    assert.equal(L.spcCompute(Array.from({ length: 10 }, (_, index) => ({
      t: `P${index + 1}`, v: [5 + index, 500],
    })), null, { chartType: 'P' }).chartType, 'P');
    assert.equal(L.spcCompute(Array.from({ length: 10 }, (_, index) => ({
      t: `C${index + 1}`, v: [3 + index % 3],
    })), null, { chartType: 'C' }).chartType, 'C');

    const docs = await request(`/docs?p=${project}`);
    assert.equal(docs.summary.total, 68);
    const expectedFormTotal = require('../lib/doctpl').CATALOG
      .filter(item => item.kind === 'form' && item.group !== 'input').length;
    assert.equal(docs.summary.formTotal, expectedFormTotal, '完成度分母只统计表单类交付物');
    assert.ok(docs.summary.done >= 1, '已批准/已完成的表单应计入完成度');
    const moduleStatuses = docs.phases.flatMap(phase => phase.docs).filter(doc => doc.kind === 'module');
    assert.ok(moduleStatuses.every(doc => doc.status !== '已完成'),
      '系统模块只作为导航入口，不得冒充已完成表单');
    assert.ok(docs.summary.done < docs.summary.total, '模块/活动不进入完成度分子分母');
    const initialDoc = await request(`/docs/P1-11?p=${project}`);
    assert.equal(initialDoc.meta.name, '初始产品和过程特殊特性识别');
    assert.equal(typeof initialDoc.meta.name, 'string', '交付物标题应使用名称文本而非对象');
    assert.equal(initialDoc.sections.flatMap(section => section.fields)
      .find(field => field.k === 'proj').value, meta.project.name);
    const p1Special = docs.phases.flatMap(phase => phase.docs).find(doc => doc.code === 'P1-11');
    assert.ok(p1Special && p1Special.down.includes('P2-11') && p1Special.down.includes('P3-06'),
      'P1-11 应暴露到 DFMEA/PFMEA 下游关系');
    const initialFlow = docs.phases.flatMap(phase => phase.docs).find(doc => doc.code === 'P1-10');
    const processFlow = docs.phases.flatMap(phase => phase.docs).find(doc => doc.code === 'P3-04');
    assert.equal(initialFlow.module, 'pfd');
    assert.equal(initialFlow.arg, 'INITIAL');
    assert.equal(processFlow.module, 'pfd');
    assert.equal(processFlow.arg, 'PROCESS');
    await request(`/docs/P1-11?p=${project}`, {
      method: 'PUT',
      body: {
        data: {
          proj: meta.project.name,
          part_no: meta.project.part_no,
          author: 'Tester',
          date: '2026-10-31',
          chars: [
            ['CHR-D-SMOKE', 'Smoke product special characteristic', 'CC', 'P1-11', 'product requirement',
              'PRODUCT', '顾客', 'CSR-SMOKE-1', 'Rev A'],
            ['CHR-P-SMOKE', 'Smoke process temperature parameter', 'SC', 'P1-11', 'process requirement',
              'PROCESS', '组织', 'P1-10', 'V1.0'],
          ],
          note: 'Smoke linkage',
        },
        change_note: '模拟项目：识别产品与过程特殊特性',
      },
    });
    const draftChars = await request(`/project-chars?p=${project}`);
    assert.ok(!draftChars.items.some(item => item.char_id === 'CHR-D-SMOKE'), '读取不得将草稿特性作为正式来源');
    await request(`/docs/P1-11/submit?p=${project}`, { method: 'POST', body: { user: 'Tester' } });
    await request(`/docs/P1-11/approve?p=${project}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    const charCandidates = (await request(`/deliverable-links?doc=P1-11&p=${project}`)).items
      .filter(item => item.ruleId === 'initial-special-characteristic');
    assert.equal(charCandidates.length, 2);
    for (const candidate of charCandidates) {
      await request(`/deliverable-links/${candidate.id}/resolve?p=${project}`, {
        method: 'POST', body: { action: 'adopt' },
      });
    }
    await request(`/docs/P2-11/submit?p=${project}`, { method: 'POST', body: { user: 'Tester' } });
    await request(`/docs/P2-11/approve?p=${project}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    const syncedChars = await request(`/project-chars?p=${project}`);
    assert.ok(syncedChars.items.some(item =>
      item.char_id === 'CHR-D-SMOKE' && item.char_kind === 'PRODUCT' && item.source_type === 'P2-11'));
    assert.ok(syncedChars.items.some(item =>
      item.char_id === 'CHR-P-SMOKE' && item.char_kind === 'PROCESS' && item.source_type === 'P2-11'));

    const backfilledFmea = await request('/fmea?type=DFMEA&p=RES-CHIP-2026-02');
    assert.ok(backfilledFmea.header && backfilledFmea.header.fmea_id);
    assert.ok(backfilledFmea.nodes.length >= 1);

    const plans = await request(`/cp?p=${project}`);
    assert.equal(plans.plans.length, 3);
    assert.deepEqual(plans.plans.map(plan => plan.stage).sort(), ['PILOT', 'PROTO', 'SOP']);
    assert.ok(plans.projectChars.some(item => item.fmea_count > 0),
      '控制计划应存在来自当前项目 PFMEA 的使用记录');
    const foreignCpDelete = await fetch(`${BASE}/cp/row/${encodeURIComponent(plans.rows[0].cp_row_id)}?p=AUTO-EMPTY-001`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(foreignCpDelete.status, 400, '跨项目删除控制计划行必须被拒绝');

    const fmea = await request(`/fmea?type=DFMEA&p=${project}`);
    const structureNode = fmea.nodes.find(node => node.node_type === 'STRUCTURE');
    assert.ok(structureNode);
    const structurePreview = await request(`/dfmea/tree?p=${project}`, {
      method: 'POST',
      body: { product: '测试电阻', labels: ['陶瓷基体', '电阻膜层', '引出端'] },
    });
    assert.ok(structurePreview.tree.nodes.length > 0);
    assert.ok(structurePreview.tree.nodes.every(group => !('func' in group) && !('failures' in group)),
      '结构图预览只识别结构，不从零件名称推断功能或失效');
    assert.ok(structurePreview.tree.nodes.flatMap(group => group.children)
      .every(item => !('func' in item) && !('failures' in item)));
    await request(`/dfmea/apply?p=${project}`, {
      method: 'POST',
      body: { tree: structurePreview.tree, labels: ['陶瓷基体', '电阻膜层', '引出端'] },
    });
    const importedDfmea = await request(`/fmea?type=DFMEA&p=${project}`);
    const importedPart = importedDfmea.nodes.find(node => node.name === '陶瓷基体');
    assert.ok(importedPart);
    const importedFunctions = await request(`/fmea/functions?node=${encodeURIComponent(importedPart.node_id)}&p=${project}`);
    assert.equal(importedFunctions.list.length, 0, '导入结构不得自动生成正式功能');
    const addedStructure = await request(`/fmea/node?p=${project}`, {
      method: 'POST',
      body: { fmea_type: 'DFMEA', parent_id: structureNode.node_id, name: '结构树手工节点测试' },
    });
    assert.ok(addedStructure.node_id);
    const generatedFunctions = await request(`/ai/function?p=${project}`, {
      method: 'POST',
      body: {
        node: structureNode.name, node_id: structureNode.node_id,
        product: meta.project.name, draft: '承载电阻膜并保持绝缘',
      },
    });
    assert.equal(generatedFunctions.functions.length, 3);
    assert.ok(generatedFunctions.items.every(item => item.failures.length === 0),
      '生成功能候选时不得同步生成失效链');
    const functionCandidates = await request(
      `/fmea/functions?node=${encodeURIComponent(structureNode.node_id)}&p=${project}`
    );
    assert.equal(functionCandidates.list.filter(item => item.status === '候选').length, 3);
    assert.ok(functionCandidates.list.every(item => item.failure_candidate_count === 0));
    const pfmea = await request(`/fmea?type=PFMEA&p=${project}`);
    const processRoot = pfmea.nodes.find(node => node.node_type === 'STRUCTURE' && !node.parent_id);
    const processNodeResult = await request(`/fmea/node?p=${project}`, {
      method: 'POST',
      body: { fmea_type: 'PFMEA', parent_id: processRoot.node_id, name: '激光调阻', desc: '设备：激光调阻机；输入：稳定化基体；输出：调阻后基体' },
    });
    const processNode = { node_id: processNodeResult.node_id, name: '激光调阻' };
    const processFunctions = await request(`/ai/function?p=${project}`, {
      method: 'POST',
      body: {
        node: processNode.name, node_id: processNode.node_id,
        product: meta.project.name, draft: '按要求处理输入并确认输出符合规定',
      },
    });
    assert.equal(processFunctions.functions.length, 3);
    assert.ok(processFunctions.items.every(item => item.failures.length === 0));
    const adoptedFunction = functionCandidates.list.find(item => item.status === '候选');
    const preAdoptionFailure = await fetch(`${BASE}/ai/suggest?p=${project}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: cookie },
      body: JSON.stringify({
        node: structureNode.name, node_id: structureNode.node_id,
        func_id: adoptedFunction.func_id, func: adoptedFunction.text,
        product: meta.project.name,
      }),
    });
    assert.equal(preAdoptionFailure.status, 400, '未采用功能不得提前生成失效分析');
    const secondFunctionBatch = await request(`/ai/function?p=${project}`, {
      method: 'POST',
      body: {
        node: structureNode.name, node_id: structureNode.node_id,
        product: meta.project.name, draft: '形成电阻膜并保证绝缘和可测量阻值',
      },
    });
    assert.equal(secondFunctionBatch.functions.length, 3);
    assert.equal(new Set([...generatedFunctions.functions, ...secondFunctionBatch.functions]).size, 6,
      '连续生成必须排除已采用和已存在的功能');
    await request(`/fmea/functions/${encodeURIComponent(adoptedFunction.func_id)}?p=${project}`, {
      method: 'PATCH', body: { status: '正式', text: adoptedFunction.text },
    });
    const foreignFunctionMutation = await fetch(
      `${BASE}/fmea/functions/${encodeURIComponent(adoptedFunction.func_id)}?p=AUTO-EMPTY-001`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: cookie },
        body: JSON.stringify({ text: adoptedFunction.text }),
      },
    );
    assert.equal(foreignFunctionMutation.status, 400, '跨项目修改 FMEA 功能必须被拒绝');
    const generatedFailures = await request(`/ai/suggest?p=${project}`, {
      method: 'POST',
      body: {
        node: structureNode.name, node_id: structureNode.node_id,
        func_id: adoptedFunction.func_id, func: adoptedFunction.text,
        product: meta.project.name,
      },
    });
    assert.ok(generatedFailures.failures.length > 0 && generatedFailures.failures.length <= 3,
      '失效候选应只追加去重后的新失效模式');
    const failureCandidates = await request(
      `/fmea/failure-cands?node=${encodeURIComponent(structureNode.node_id)}&func=${encodeURIComponent(adoptedFunction.func_id)}&p=${project}`
    );
    assert.ok(failureCandidates.list.length >= 3,
      '采用功能后必须已有批次生成失效链，并可继续追加');
    assert.equal(new Set(failureCandidates.list.map(item => item.mode)).size, failureCandidates.list.length);
    const cachedFailures = await request(`/ai/suggest?p=${project}`, {
      method: 'POST',
      body: {
        node: structureNode.name, node_id: structureNode.node_id,
        func_id: adoptedFunction.func_id, func: adoptedFunction.text,
        product: meta.project.name,
      },
    });
    assert.notEqual(cachedFailures.source, 'cache', '再次生成应追加新候选');
    assert.ok(cachedFailures.failures.length <= 3);
    const failureCandidatesAfterMore = await request(
      `/fmea/failure-cands?node=${encodeURIComponent(structureNode.node_id)}&func=${encodeURIComponent(adoptedFunction.func_id)}&p=${project}`
    );
    assert.equal(new Set(failureCandidatesAfterMore.list.map(item => item.mode)).size,
      failureCandidatesAfterMore.list.length);
    const adoptedFailure = failureCandidatesAfterMore.list.find(item => item.status === '候选');
    assert.ok(adoptedFailure);
    const adoptedRow = await request(`/fmea/row-from-text?p=${project}`, {
      method: 'POST',
      body: {
        fmea_type: 'DFMEA', focus_node_id: structureNode.node_id, func_id: adoptedFunction.func_id,
        effect: adoptedFailure.effect || '功能未实现', mode: adoptedFailure.mode,
        cause: adoptedFailure.cause || '过程波动', pc_text: '', dc_text: '',
        s: adoptedFailure.s || 8, o: 5, d: 5,
      },
    });
    assert.ok(adoptedRow.row_id);
    await request(`/fmea/failure-cands/${encodeURIComponent(adoptedFailure.cand_id)}?p=${project}`, {
      method: 'PATCH', body: { status: '已采用', row_id: adoptedRow.row_id },
    });
    for (let index = 1; index <= 9; index += 1) {
      await request(`/fmea/functions?p=${project}`, {
        method: 'POST',
        body: {
          node_id: structureNode.node_id, status: '正式', source: 'manual',
          text: `激光划线功能测试补充${String(index).padStart(2, '0')}`,
        },
      });
    }
    const atLimit = await request(`/ai/function?p=${project}`, {
      method: 'POST',
      body: {
        node: structureNode.name, node_id: structureNode.node_id,
        product: meta.project.name, draft: '继续生成不重复功能',
      },
    });
    assert.equal(atLimit.limitReached, true);
    assert.equal(atLimit.used, 15);

    const copied = await request(`/projects?p=${project}`, {
      method: 'POST',
      body: {
        name: 'Automated Copy', project_id: 'AUTO-COPY-001', copy_from: project,
        approved_by: 'Quality Manager', owner: 'Tester', customer: 'Test', part_no: 'AUTO-COPY',
      },
    });
    assert.equal(copied.project_id, 'AUTO-COPY-001');
    const copiedCp = await request('/cp?p=AUTO-COPY-001');
    assert.equal(copiedCp.plans.length, 3);
    assert.ok(copiedCp.rows.length >= 5, '复制项目应带控制计划行');
    assert.ok(copiedCp.rows.filter(row => row.char_id).every(row => row.project_char_id),
      '复制项目的 CP 行必须映射到目标项目特性');

    await request('/projects?p=' + project, {
      method: 'POST', body: {
        name: 'Disposable Cascade Project', project_id: 'AUTO-DELETE-001',
        family_id: 'FM', series_id: 'SR-RJ', owner: 'Tester', part_no: 'AUTO-DELETE',
      },
    });
    await request('/projects/AUTO-DELETE-001?p=' + project, { method: 'DELETE' });
    const cascadeDb = new (require('node:sqlite').DatabaseSync)(DB_PATH, { readOnly: true });
    assert.equal(cascadeDb.prepare('SELECT COUNT(*) n FROM control_plan WHERE project_id=?')
      .get('AUTO-DELETE-001').n, 0, 'Deleting a project must remove its control plans');
    assert.equal(cascadeDb.prepare('SELECT COUNT(*) n FROM deliverable_sync_item WHERE project_id=?')
      .get('AUTO-DELETE-001').n, 0, 'Deleting a project must remove orphan deliverable sync items');
    cascadeDb.close();

    const projectChars = await request(`/project-chars?p=${project}`);
    assert.ok(projectChars.items.length >= 2);
    assert.ok(projectChars.items.some(item => item.fmea_count > 0),
      '项目特性列表应包含 PFMEA 实际引用产生的特性');
    assert.ok(projectChars.items.length < projectChars.dictionary.length,
      '项目特性不得自动灌入整个特性字典');
    assert.ok(projectChars.dictionary.length >= projectChars.items.length);
    const editableChar = projectChars.items.find(item => item.lsl != null && item.usl != null);
    const masterBefore = (await request(`/chars/${editableChar.char_id}?p=${project}`)).char;
    const updatedProjectChar = await request(`/project-chars/${encodeURIComponent(editableChar.pchar_id)}?p=${project}`, {
      method: 'PATCH',
      body: {
        target: editableChar.target, lsl: +editableChar.lsl - 0.01, usl: +editableChar.usl + 0.01,
        tol_text: `${+editableChar.lsl - 0.01} ~ ${+editableChar.usl + 0.01}`,
      },
    });
    assert.equal(updatedProjectChar.item.lsl, +editableChar.lsl - 0.01);
    const masterAfter = (await request(`/chars/${editableChar.char_id}?p=${project}`)).char;
    assert.equal(masterAfter.lsl, masterBefore.lsl, '项目参数不得回写共享特性字典');

    const targetProject = 'RES-CHIP-2026-02';
    await request(`/docs/P1-07?p=${targetProject}`, {
      method: 'PUT',
      body: {
        data: { proj: 'Smoke Test', part_no: 'SMOKE', author: 'Tester', date: '2026-10-30',
          targets: [['Resistance', '10', '+/-1%', 'Test']], rationale: 'Smoke test' },
        cols: {}, status: '草稿', user: 'Tester', change_note: '模拟项目：更新设计目标',
      },
    });
    await request(`/docs/P1-07/submit?p=${targetProject}`, { method: 'POST', body: { user: 'Tester' } });
    const approved = await request(`/docs/P1-07/approve?p=${targetProject}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    assert.equal(approved.status, '已批准');
    await request(`/docs/P1-10?p=${targetProject}`, {
      method: 'PUT',
      body: {
        data: {
          proj: 'Smoke Test', part_no: 'SMOKE', author: 'Tester', date: '2026-10-31',
          steps: [
            ['010', '初始来料检验', '检验', '检验台', '阻值'],
            ['020', '激光调阻', '制造', '激光调阻机', '阻值精度'],
          ],
          note: 'P1-10 to PFD',
        },
        cols: {}, status: '草稿', user: 'Tester', change_note: '模拟项目：更新初始流程图',
      },
    });
    await request(`/docs/P1-10/submit?p=${targetProject}`, { method: 'POST', body: { user: 'Tester' } });
    const approvedFlow = await request(`/docs/P1-10/approve?p=${targetProject}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    });
    assert.equal(approvedFlow.status, '已批准');
    assert.equal(approvedFlow.pfd_sync.added, 2);
    const syncedSteps = await request(`/steps?mode=INITIAL&p=${targetProject}`);
    assert.deepEqual(syncedSteps.filter(step => ['010', '020'].includes(step.step_no)).map(step => step.name),
      ['初始来料检验', '激光调阻']);
    const processStepsBefore = await request(`/steps?p=${targetProject}`);
    assert.ok(!processStepsBefore.some(step => step.name === '初始来料检验'),
      'P1-10 初始流程图不得混入 P3-04 过程流程图');
    const isolatedProcess = await request(`/steps?p=${targetProject}`, {
      method: 'POST',
      body: { mode: 'PROCESS', step_no: '710', name: '隔离验证过程工序', step_type: '工序' },
    });
    const crossStageChild = await request(`/steps?p=${targetProject}`, {
      method: 'POST',
      body: { mode: 'INITIAL', parent_step_id: isolatedProcess.step_id, name: '非法跨阶段工步' },
    }).catch(error => ({ error }));
    assert.ok(crossStageChild.error, '初始流程图不得把过程流程图工步作为父级');
    const processStepsAfter = await request(`/steps?p=${targetProject}`);
    assert.equal(processStepsAfter.filter(step => step.pfd_mode === 'PROCESS').length,
      processStepsBefore.length + 1);
    const pfdSync = await request(`/pfmea/from-pfd?p=${targetProject}`, {
      method: 'POST', body: { with4m: false },
    });
    assert.equal(pfdSync.steps, processStepsAfter.length, 'PFMEA 只能从过程流程图同步');
    const approvedFlowAgain = await request(`/docs/P1-10/approve?p=${targetProject}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' }, as: qualityCookie,
    }).catch(error => ({ error }));
    assert.ok(approvedFlowAgain.error, '已批准的 P1-10 不应重复批准');
    const revisions = await request(`/docs/P1-07/revisions?p=${targetProject}`);
    assert.ok(revisions.list.length >= 2);

    const cpRow = plans.rows.find(row => row.gauge_id && !row.mon_id);
    const monitor = await request(`/cp/${cpRow.cp_row_id}/monitor?p=${project}`, {
      method: 'POST',
      body: { chart_type: 'Xbar-R', subgroup_n: 3, cpk_target: 1.67, approved_by: 'Quality Engineer' },
    });
    // 监控项不得创建即自批（C-03）：创建后为待审核，须由质量角色单独审核
    assert.equal(monitor.approval_status, '待审核', '新建 SPC 监控项必须待审核');
    const reviewedMonitor = await request(`/monitoring/${monitor.mon_id}/review?p=${project}`, {
      method: 'PATCH', body: { action: 'approve', review_note: 'Smoke test 审核' }, as: qualityCookie,
    });
    assert.equal(reviewedMonitor.approval_status, '已批准');
    const emptySpc = await request(`/spc/${monitor.mon_id}?p=${project}`);
    assert.equal(emptySpc.items.length, 0);
    assert.equal(emptySpc.latest, null);
    const spc = await request(`/spc?p=${project}`);
    assert.ok(spc.items.some(item => item.mon_id === monitor.mon_id));

    const linked = await request(`/cp/row/${cpRow.cp_row_id}/characteristic?p=${project}`, {
      method: 'PATCH', body: { char_id: 'CHR-P-0047', reason: 'Smoke test', user: 'Tester' },
    });
    assert.equal(linked.char_id, 'CHR-P-0047');

    await request(`/gauges/${encodeURIComponent(cpRow.gauge_id)}?p=${project}`, {
      method: 'PATCH', body: { calibration_due: '2027-12-31', resolution: 0.0001, user: 'Tester' },
    });
    // 控制计划状态机：草稿→待审核→已批准，不允许跳步（A-02）
    await request(`/cp/${encodeURIComponent(plans.cp.cp_id)}?p=${project}`, {
      method: 'PATCH', body: { status: '待审核' },
    });
    await request(`/cp/${encodeURIComponent(plans.cp.cp_id)}?p=${project}`, {
      method: 'PATCH', body: { status: '已批准' }, as: qualityCookie,
    });
    const msaState = await request(`/msa?p=${project}`);
    assert.ok(msaState.plans.length >= 1, 'SPC 监控应自动生成 MSA 计划');
    const currentMsaPlans = msaState.plans.filter(item =>
      item.source_active !== 0 && item.source_status === '有效');
    const plan = currentMsaPlans.find(item => item.gauge_id === cpRow.gauge_id) || currentMsaPlans[0];
    assert.ok(plan, 'MSA research must select a plan from the current approved source version');
    const simulated = await request(`/msa/simulate?p=${project}`, {
      method: 'POST',
      body: {
        gauge_id: plan.gauge_id, project_char_id: plan.project_char_id,
        parts: 10, operators: 3, trials: 3, target_pct: 5,
      },
    });
    assert.equal(simulated.data.length, 9);
    assert.equal(simulated.data[0].length, 10);
    assert.ok(simulated.actual_pct < 30, '模拟数据应接近目标 GRR 区间');
    if (simulated.char.lsl != null && simulated.char.usl != null) {
      assert.ok(simulated.part_values.every(value => value >= simulated.char.lsl && value <= simulated.char.usl),
        '模拟零件真实值必须位于项目特性 LSL/USL 内');
      const bounded = await request(`/msa/simulate?p=${project}`, {
        method: 'POST',
        body: {
          gauge_id: plan.gauge_id, project_char_id: plan.project_char_id,
          parts: 10, operators: 3, trials: 3, target_pct: 5, tolerance: 15,
        },
      });
      assert.ok(bounded.part_values.every(value => value >= bounded.char.lsl && value <= bounded.char.usl),
        '手工容差不得把模拟零件真实值扩展到项目规格界限外');
    }
    const msa = await request(`/msa?p=${project}`, {
      method: 'POST',
      body: {
        gauge_id: plan.gauge_id, project_char_id: plan.project_char_id, plan_id: plan.plan_id,
        data: simulated.data, parts: 10, ops: 3, trials: 3, operator: 'Tester',
      },
    });
    assert.ok(Number.isInteger(msa.study_id));
    assert.equal(msa.project_char_id, plan.project_char_id);
    assert.equal(msa.plan_id, plan.plan_id);
    if (msa.judgment === '接受') {
      const completed = await request(`/msa/${msa.study_id}/complete?p=${project}`, {
        method: 'PATCH', body: { completed_by: 'Quality Manager' },
      });
      assert.equal(completed.status, '已完成');
      const completedState = await request(`/msa?p=${project}`);
      assert.equal(completedState.plans.find(item => item.plan_id === plan.plan_id).status, '已完成');
    }

    const sourceDocx = EX.buildDocxFromBlocks({
      blocks: [
        { type: 'field', label: '项目名称', value: '旧值', hint: '' },
        { type: 'text', text: '以下为测量记录' },
        { type: 'table', cols: [{ label: '项目' }, { label: '结果' }], rows: [['长度', '旧值']] },
      ],
    }, { name: 'Word 原版保留测试', generatedAt: '2026-10-30' });
    const uploaded = await request(`/templates?p=${project}`, {
      method: 'POST',
      body: {
        name: 'Word 原版保留测试', phase: 1, filename: 'preserve.docx',
        dataBase64: sourceDocx.toString('base64'), user: 'Tester', doc_code: 'PPAP-18',
      },
    });
    const template = await request(`/templates/${uploaded.tpl_id}?p=${project}`);
    assert.ok(template.meta.source_path, '上传 Word 后必须保存原文件');
    template.schema.blocks.find(block => block.type === 'field').value = '新值';
    template.schema.blocks.find(block => block.type === 'table').rows[0][1] = '合格';
    await request(`/templates/${uploaded.tpl_id}?p=${project}`, {
      method: 'PUT', body: { schema: template.schema, user: 'Tester' },
    });
    const exportedDocx = await request(`/templates/${uploaded.tpl_id}/export?fmt=docx&p=${project}`);
    const sourceParts = P.readZip(sourceDocx);
    const exportedParts = P.readZip(exportedDocx);
    assert.ok(exportedParts.get('word/styles.xml'));
    assert.deepEqual(
      Buffer.from(exportedParts.get('word/styles.xml')).toString('base64'),
      Buffer.from(sourceParts.get('word/styles.xml')).toString('base64'),
      'Word 导出必须保留原样式包'
    );
    const reparsed = P.parseDocx(exportedDocx);
    assert.ok(reparsed.blocks.some(block => block.type === 'text' && block.text.includes('新值')));
    assert.ok(reparsed.blocks.some(block => block.type === 'table'
      && block.rows.some(row => row.includes('合格'))));

    const toolExports = [
      `fmea/export?fmt=docx&type=DFMEA&p=${project}`,
      `fmea/export?fmt=xlsx&type=DFMEA&p=${project}`,
      `fmea/export?fmt=docx&type=PFMEA&p=${project}`,
      `fmea/export?fmt=xlsx&type=PFMEA&p=${project}`,
      `cp/export?fmt=docx&stage=${encodeURIComponent(plans.cp.stage)}&p=${project}`,
      `cp/export?fmt=xlsx&stage=${encodeURIComponent(plans.cp.stage)}&p=${project}`,
      `spc/export?fmt=docx&mon_id=${encodeURIComponent(monitor.mon_id)}&p=${project}`,
      `spc/export?fmt=xlsx&mon_id=${encodeURIComponent(monitor.mon_id)}&p=${project}`,
      `msa/export?fmt=docx&study_id=${msa.study_id}&p=${project}`,
      `msa/export?fmt=xlsx&study_id=${msa.study_id}&p=${project}`,
      `ppap/export?fmt=docx&submission_id=${encodeURIComponent(project)}&p=${project}`,
      `ppap/export?fmt=xlsx&submission_id=${encodeURIComponent(project)}&p=${project}`,
    ];
    for (const pathName of toolExports) {
      const exported = await request(`/quality-tools/${pathName}`);
      const parts = P.readZip(exported);
      if (pathName.includes('fmt=docx')) {
        assert.ok(parts.get('word/document.xml'), `${pathName} 必须生成有效 Word`);
        if (pathName.includes('/msa/export')) {
          const parsed = P.parseDocx(exported);
          assert.ok(parsed.blocks.some(block => block.type === 'text'
            && block.text.includes('研究概况')),
          'MSA Word 必须包含研究概况');
          assert.ok(parsed.blocks.some(block => block.type === 'text'
            && block.text.includes('评价者统计摘要')),
          'MSA Word 必须包含评价者统计摘要');
          assert.ok(parsed.blocks.some(block => block.type === 'text'
            && block.text.includes('测量系统分析结果')),
          'MSA Word 必须包含测量系统分析结果');
          assert.ok(parsed.blocks.some(block => block.type === 'text'
            && block.text.includes('结论')),
          'MSA Word 必须包含结论');
          const wordXml = parts.get('word/document.xml').toString('utf8');
          assert.ok(!wordXml.includes('070000000000000002') && !wordXml.includes('5722222222222222'),
            'MSA Word 不应暴露长浮点数');
        } else if (pathName.includes('/cp/export')) {
          const parsed = P.parseDocx(exported);
          assert.ok(parsed.blocks.some(block => block.type === 'table'
            && block.rows.some(row => row.includes('产品特性') && row.includes('过程特性'))),
          '控制计划 Word 必须使用 13 列标准表');
          assert.ok(parts.get('word/document.xml').toString('utf8').includes('w:orient="landscape"'),
            '控制计划 Word 必须使用横向页面');
        } else if (pathName.includes('/spc/export')) {
          const parsed = P.parseDocx(exported);
          assert.ok(parsed.blocks.some(block => block.type === 'text' && block.text.includes('监控概况'))
            && parsed.blocks.some(block => block.type === 'text' && block.text.includes('判异与反应')),
          'SPC Word 必须包含正式报告章节');
          const chart = parts.get('word/media/spc-chart-1.svg');
          assert.ok(chart && chart.toString('utf8').includes('<polyline'),
            'SPC Word 必须嵌入控制图矢量图');
          assert.ok(parts.get('word/document.xml').toString('utf8').includes('r:embed="rIdImg1"'),
            'SPC Word 控制图必须建立图片引用');
        } else if (pathName.includes('/ppap/export')) {
          const parsed = P.parseDocx(exported);
          assert.ok(parsed.blocks.some(block => block.type === 'text' && block.text.includes('PSW'))
            && parsed.blocks.some(block => block.type === 'text' && block.text.includes('18 项证据摘要')),
          'PPAP Word 必须包含 PSW 与 18 项证据摘要');
        }
      } else {
        assert.ok(parts.get('xl/workbook.xml'), `${pathName} 必须生成有效 Excel`);
        if (pathName.includes('/fmea/export')) {
          const parsed = P.parseXlsx(exported);
          const type = pathName.includes('type=DFMEA') ? 'DFMEA' : 'PFMEA';
          assert.ok(parsed.sheets.some(sheet => sheet.name === `${type}（AIAG-VDA 2019）`),
            `${type} Excel 必须使用 AIAG-VDA 2019 七步法表单页`);
          assert.ok(parsed.sheets.some(sheet => sheet.name === '说明'),
            `${type} Excel 必须包含标准依据说明页`);
          const xml = P.readZip(exported).get('xl/worksheets/sheet1.xml').toString('utf8');
          assert.ok(xml.includes('结构分析') && xml.includes('功能分析')
            && xml.includes('失效分析') && xml.includes('风险分析') && xml.includes('优化'),
          `${type} Excel 必须包含七步法分组`);
        } else if (pathName.includes('/cp/export')) {
          const parsed = P.parseXlsx(exported);
          assert.ok(parsed.sheets.some(sheet => sheet.name === '控制计划'),
            '控制计划 Excel 必须使用标准表单页');
          assert.ok(parsed.sheets.some(sheet => sheet.name === '说明'),
            '控制计划 Excel 必须包含标准依据说明页');
          const xml = P.readZip(exported).get('xl/worksheets/sheet1.xml').toString('utf8');
          assert.ok(xml.includes('产品特性') && xml.includes('过程特性')
            && xml.includes('特殊特性分类') && xml.includes('样本频率') && xml.includes('反应计划'),
          '控制计划 Excel 必须包含 13 列标准字段');
        } else if (pathName.includes('/msa/export')) {
          const parsed = P.parseXlsx(exported);
          assert.ok(parsed.sheets.some(sheet => sheet.name === 'GRR数据收集表'),
            'MSA Excel 必须包含 GRR 数据收集表');
          assert.ok(parsed.sheets.some(sheet => sheet.name === 'GRR报告'),
            'MSA Excel 必须包含 GRR 报告');
          const archive = P.readZip(exported);
          const dataXml = archive.get('xl/worksheets/sheet1.xml').toString('utf8');
          const reportXml = archive.get('xl/worksheets/sheet2.xml').toString('utf8');
          const stylesXml = archive.get('xl/styles.xml').toString('utf8');
          assert.ok(dataXml.includes('量具重复性和再现性数据收集表')
            && dataXml.includes('评价者 / 测量次数') && dataXml.includes('UCL'),
          'GRR 数据收集表缺少手册标准行');
          assert.ok(dataXml.includes('paperSize="9"') && dataXml.includes('orientation="portrait"')
            && dataXml.includes('fitToHeight="1"'), 'GRR 数据收集表必须按 A4 单页打印');
          assert.ok(reportXml.includes('量具重复性和再现性报告')
            && reportXml.includes('重复性 - 设备变差 EV')
            && reportXml.includes('重复性和再现性 GRR')
            && reportXml.includes('ndc'),
          'GRR 报告缺少手册标准分析项');
          assert.ok(reportXml.includes('paperSize="9"') && reportXml.includes('orientation="portrait"')
            && reportXml.includes('fitToHeight="1"'), 'GRR 报告必须按 A4 单页打印');
          assert.ok(stylesXml.includes('0.00000') && stylesXml.includes('0.0000')
            && stylesXml.includes('0.000') && stylesXml.includes('0.00&quot;%&quot;'),
          'GRR 报告必须包含手册要求的数值和百分比格式');
          assert.ok(!reportXml.includes('结论：%GRR') && !reportXml.includes('<c r="A16"'),
            'GRR 报告不应保留与公式结果重复的结论汇总行');
          assert.ok(reportXml.includes('IFERROR('), 'GRR 报告公式必须防止 #DIV/0!');
          assert.ok(reportXml.includes('&apos;GRR数据收集表&apos;!M'),
            'GRR 报告公式必须跨表引用项目研究数据，不能写死实际值');
          const cachedValue = ref => Number(
            (reportXml.match(new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?<v>([^<]+)</v>`)) || [])[1]
          );
          for (const ref of ['B9', 'B10', 'B11', 'B12', 'B13', 'E9', 'E10', 'E11', 'E12', 'E13']) {
            assert.ok(Number.isFinite(cachedValue(ref)) && cachedValue(ref) > 0,
              `GRR 报告 ${ref} 必须有有效预计算值`);
          }
        } else if (pathName.includes('/spc/export')) {
          const parsed = P.parseXlsx(exported);
          assert.deepEqual(parsed.sheets.map(sheet => sheet.name), ['SPC控制图'],
            'SPC Excel 只能保留一个控制图与子组数据合并的工作表');
          const xml = P.readZip(exported).get('xl/worksheets/sheet1.xml').toString('utf8');
          const archive = P.readZip(exported);
          const chart1 = archive.get('xl/charts/chart1.xml')?.toString('utf8') || '';
          const chart2 = archive.get('xl/charts/chart2.xml')?.toString('utf8') || '';
          assert.ok(archive.get('xl/drawings/drawing1.xml')
            && chart1.includes('<c:lineChart>') && chart2.includes('<c:lineChart>'),
          'SPC Excel 必须插入引用子组数据的原生折线控制图');
          assert.ok(chart1.includes("'SPC控制图'!$"),
            'SPC Excel 控制图必须引用同页子组数据区域');
          assert.ok(/<c r="A44"[^>]*><v>1<\/v><\/c>/.test(xml),
            'SPC Excel 子组序号必须从 1 开始连续编号');
          assert.ok(xml.includes('paperSize="9"') && xml.includes('orientation="landscape"')
            && xml.includes('fitToHeight="1"'), 'SPC Excel 必须按 A4 横向单页打印');
        } else if (pathName.includes('/ppap/export')) {
          const parsed = P.parseXlsx(exported);
          assert.ok(parsed.sheets.some(sheet => sheet.name === 'PPAP证据矩阵'),
            'PPAP Excel 必须使用证据矩阵');
          const xml = P.readZip(exported).get('xl/worksheets/sheet1.xml').toString('utf8');
          assert.ok(xml.includes('paperSize="9"') && xml.includes('orientation="landscape"')
            && xml.includes('fitToHeight="1"'), 'PPAP Excel 必须按 A4 横向单页打印');
        }
      }
    }

    const baseline = await request(`/baselines?p=${project}`, {
      method: 'POST',
      body: { tag: 'Automated Baseline', version: 'V9.8', approved_by: 'Quality Manager', user: 'Tester' },
    });
    assert.ok(baseline.count > 100);
    const baselineDetail = await request(`/baselines/${baseline.id}?p=${project}`);
    assert.ok(baselineDetail.items.some(item => item.object_type === 'PRODUCT_SERIES'
      && item.object_id === 'SR-RJ'), '冻结基线应包含项目引用的产品系列对象');
    const baselineList = await request(`/baselines?p=${project}`);
    assert.ok(baselineList.list[0].object_types >= 20);

    const ecr = await request(`/ecr?p=${project}`, {
      method: 'POST',
      body: { title: 'Smoke ECR', reason: 'Regression test', scope: 'Smoke scope', requested_by: 'Tester' },
    });
    const approvedEcr = await request(`/ecr/${ecr.ecr_id}?p=${project}`, {
      method: 'PATCH',
      body: {
        status: '已批准', approved_by: 'Quality Manager',
        impact_analysis: 'Smoke test: no structured change items; registration-only change',
      },
      as: qualityCookie,
    });
    assert.equal(approvedEcr.ok, true);
    await assert.rejects(request(`/ecr/${ecr.ecr_id}?p=${project}`, {
      method: 'PATCH', body: { status: '已实施', approved_by: 'Quality Manager' },
    }), /“实施”操作/);
    const appliedEcr = await request(`/ecr/${ecr.ecr_id}/apply?p=${project}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' },
    });
    assert.equal(appliedEcr.status, '已实施');
    assert.ok(appliedEcr.branch_baseline_id);
    const ecrState = (await request(`/ecr?p=${project}`)).list.find(item => item.ecr_id === ecr.ecr_id);
    assert.equal(ecrState.branch_baseline_id, appliedEcr.branch_baseline_id);
    const ecrBaseline = await request(`/baselines/${appliedEcr.branch_baseline_id}?p=${project}`);
    assert.equal(ecrBaseline.baseline.tag, `ECR ${ecr.ecr_id} 实施快照`);
    const appliedAgain = await request(`/ecr/${ecr.ecr_id}/apply?p=${project}`, {
      method: 'POST', body: { approved_by: 'Quality Manager' },
    });
    assert.equal(appliedAgain.branch_baseline_id, appliedEcr.branch_baseline_id);
    assert.equal((await request(`/baselines?p=${project}`)).list
      .filter(item => item.baseline_id === appliedEcr.branch_baseline_id).length, 1,
    '重复实施请求不可重复生成 ECR 基线');

    const ppapState = await request(`/ppap?p=${project}`);
    assert.equal(ppapState.workflow.length, 18);
    assert.ok(ppapState.workflow.every(item => item.phase && item.sourceLabel && item.rule));
    const fmeaEvidence = await request(`/ppap/evidence/6?p=${project}`);
    assert.equal(fmeaEvidence.templateCode, 'PPAP-6');
    assert.ok(fmeaEvidence.mapping.evidenceItems.length >= 3);
    assert.ok(fmeaEvidence.fmea && fmeaEvidence.fmea.rows.length >= 1);
    const apMatrix = await request(`/ap-matrix?p=${project}`);
    assert.equal(apMatrix.rows.length, 1000, 'AP 规则页应能展示完整 S/O/D 判定矩阵');
    assert.equal(apMatrix.summary.reduce((total, item) => total + item.count, 0), 1000);
    const backupList = await request(`/admin/backups?p=${project}`);
    assert.ok(Array.isArray(backupList.list), '数据库备份清单应可独立读取');
    const backup = await request(`/admin/backup?p=${project}`, {
      method: 'POST', body: { user: 'Tester' },
    });
    const backupFile = path.join(TMP, 'backups', backup.name);
    assert.ok(fs.existsSync(backupFile), '备份文件应实际生成');
    const backupDb = new (require('node:sqlite').DatabaseSync)(backupFile);
    assert.equal(
      backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'").get().name,
      'project',
      '备份文件必须可独立打开',
    );
    backupDb.close();
    const processDict = await request(`/process-dict?p=${project}`);
    assert.ok(processDict.list.length >= 1);
    await request(`/process-dict/${encodeURIComponent(processDict.list[0].dict_id)}?p=${project}`, {
      method: 'PATCH',
      body: { default_equipment: processDict.list[0].default_equipment || '' },
    });
    const createdDict = await request(`/process-dict?p=${project}`, {
      method: 'POST',
      body: {
        code: 'SMOKE-PD-001', name: 'Smoke dictionary operation',
        step_type: '工序', default_equipment: 'Smoke machine',
        effective_from: '2026-01-01',
      },
    });
    const duplicateDict = await fetch(`${BASE}/process-dict?p=${project}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: cookie },
      body: JSON.stringify({ code: 'SMOKE-PD-001', name: 'Duplicate' }),
    });
    assert.equal(duplicateDict.status, 400, '工序字典编号重复时应拒绝新增');
    const usedDict = await request(`/process-dict/${createdDict.dict_id}/use?p=${project}`, { method: 'POST' });
    const referencedStep = (await request(`/steps?p=${project}`)).find(step => step.step_id === usedDict.step_id);
    assert.equal(referencedStep.name, 'Smoke dictionary operation');
    await request(`/process-dict/${createdDict.dict_id}?p=${project}`, {
      method: 'PATCH', body: { name: 'Updated dictionary operation', default_equipment: 'Updated machine' },
    });
    const snapshotStep = (await request(`/steps?p=${project}`)).find(step => step.step_id === usedDict.step_id);
    assert.equal(snapshotStep.name, 'Smoke dictionary operation', '维护共享字典不得静默改写项目工序快照');
    await request(`/process-dict/${createdDict.dict_id}?p=${project}`, {
      method: 'PATCH', body: { status: '停用' },
    });
    assert.equal((await request(`/process-dict?p=${project}`)).list
      .find(item => item.dict_id === createdDict.dict_id).status, '停用');
    const inactiveUse = await fetch(`${BASE}/process-dict/${createdDict.dict_id}/use?p=${project}`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(inactiveUse.status, 400, '停用工序不得再被项目引用');
    const foreignMutation = await fetch(
      `${BASE}/steps/${encodeURIComponent(usedDict.step_id)}?p=AUTO-EMPTY-001`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: cookie },
        body: JSON.stringify({ name: 'cross-project mutation' }),
      },
    );
    assert.equal(foreignMutation.status, 400, '跨项目修改工序必须被拒绝');
    await request(`/steps?p=${project}`, {
      method: 'POST',
      body: {
        step_no: '999', name: 'Smoke special process', step_type: '特殊过程',
        equipment: 'Test equipment',
      },
    });
    const pfdEvidence = await request(`/ppap/evidence/5?p=${project}`);
    assert.ok(pfdEvidence.pfd && pfdEvidence.pfd.steps.length >= 5);
    assert.ok(pfdEvidence.pfd.steps.every(step =>
      typeof step.special_process === 'boolean'
      && Array.isArray(step.special_characteristics)
      && typeof step.critical === 'boolean'));
    assert.ok(pfdEvidence.pfd.special_process_count >= 1);
    assert.ok(pfdEvidence.pfd.special_char_step_count >= 1);
    const pswEvidence = await request(`/ppap/evidence/18?p=${project}`);
    assert.equal(pswEvidence.templateCode, 'PPAP-18');
    assert.ok(pswEvidence.mapping.evidenceItems.some(item => item.includes('PSW')));
    assert.ok(pswEvidence.customTemplates.some(template => template.tpl_id === uploaded.tpl_id));
    const designEvidence = await request(`/ppap/evidence/1?p=${project}`);
    assert.ok(designEvidence.projectDocs.length >= 1);
    assert.ok(designEvidence.projectDocs[0].preview.sections.length >= 1);
    const initialSubmission = await request(`/ppap/submission?p=${project}`);
    assert.equal(initialSubmission.submission.level, 3);
    // PPAP 提交状态机：准备中→待批准→已批准，批准须由质量角色执行（P0-1/P0-3）
    const preparedSubmission = await request(`/ppap/submission?p=${project}`, {
      method: 'PATCH',
      body: {
        level: 2, submission_reason: 'Smoke PPAP submission',
        customer: 'Smoke Customer', organization: 'Smoke Organization',
        part_revision: 'B', requested_by: 'Tester', status: '待批准', user: 'Tester',
      },
    });
    assert.equal(preparedSubmission.submission.status, '待批准');
    const savedSubmission = await request(`/ppap/submission?p=${project}`, {
      method: 'PATCH', body: { status: '已批准' }, as: qualityCookie,
    });
    assert.equal(savedSubmission.submission.level, 2);
    assert.equal(savedSubmission.submission.status, '已批准');
    assert.equal(savedSubmission.submission.part_revision, 'B');

    // B-09：证据先保存为“待确认”，再由质量角色确认完成
    await request(`/ppap/18?p=${project}`, {
      method: 'PATCH',
      body: { status: '待确认', evidence: 'AUTO-PSW-001', note: 'Smoke test' },
    });
    const confirmedPpap = await request(`/ppap/18?p=${project}`, {
      method: 'PATCH',
      body: { status: '已完成', evidence: 'AUTO-PSW-001', note: 'Smoke test' },
      as: qualityCookie,
    });
    assert.equal(confirmedPpap.status, '已完成');
    const pkg = await request(`/ppap/package?p=${project}`, { method: 'POST', body: { level: 1 } });
    assert.ok(pkg.files > 200);
    const zip = await request(`/ppap/packages/${pkg.pkg_id}/download?p=${project}`);
    assert.ok(Buffer.isBuffer(zip) && zip.length > 1000);
    assert.equal(crypto.createHash('sha256').update(zip).digest('hex'), pkg.zip_hash);
    // M-05：已完成研究保留为审核证据，通过“作废”而不是物理删除
    const voidedMsa = await request(`/msa/${msa.study_id}/void?p=${project}`, {
      method: 'PATCH', body: { reason: 'Smoke test cleanup' }, as: qualityCookie,
    });
    assert.equal(voidedMsa.status, '作废');
    const msaAfterDelete = await request(`/msa?p=${project}`);
    assert.ok(msaAfterDelete.studies.some(item =>
      item.study_id === msa.study_id && item.status === '作废'),
    '作废后 MSA 历史研究应保留记录并标记作废');
    const resetPlan = msaAfterDelete.plans.find(item => item.plan_id === msa.plan_id);
    if (resetPlan) {
      assert.equal(resetPlan.study_id, null, '作废研究后关联计划必须解除研究引用');
      if (resetPlan.source_active !== 0) assert.equal(resetPlan.status, '计划');
    }

    const loop = await request(`/closed-loop?type=PFMEA&stage=SOP&p=${project}`);
    assert.ok(loop.summary.total >= 4);
    const exportList = await request(`/exports?p=${project}`);
    assert.ok(exportList.list.length >= 1);

    const dbCheck = await fetch(`${BASE}/projects?p=${project}`, { headers: { Cookie: cookie } })
      .then(response => response.json());
    assert.ok(dbCheck.list.some(item => item.project_id === 'AUTO-COPY-001'));

    const steps = await request(`/steps?p=${project}`);
    const parentStep = steps.find(step => !step.parent_step_id && step.status !== '已发布');
    assert.ok(parentStep);
    const createdSubstep = await request(`/steps?p=${project}`, {
      method: 'POST',
      body: {
        parent_step_id: parentStep.step_id,
        name: 'Smoke child operation',
        step_type: '工序',
        input_desc: 'Child input',
        output_desc: 'Child output',
      },
    });
    const secondSubstep = await request(`/steps?p=${project}`, {
      method: 'POST',
      body: {
        parent_step_id: parentStep.step_id,
        name: 'Smoke second child operation',
        step_type: '检验',
      },
    });
    const stepsWithSubstep = await request(`/steps?p=${project}`);
    const childStep = stepsWithSubstep.find(step => step.step_id === createdSubstep.step_id);
    const secondChildStep = stepsWithSubstep.find(step => step.step_id === secondSubstep.step_id);
    assert.equal(childStep.parent_step_id, parentStep.step_id);
    assert.equal(childStep.step_no, `${String(parentStep.step_no).split('-')[0]}-1`);
    assert.equal(secondChildStep.step_no, `${String(parentStep.step_no).split('-')[0]}-2`);
    assert.ok(stepsWithSubstep.find(step => step.step_id === parentStep.step_id).child_count >= 2);
    let parentDeleteRejected = false;
    try {
      await request(`/steps/${encodeURIComponent(parentStep.step_id)}?p=${project}`, { method: 'DELETE' });
    } catch (error) {
      parentDeleteRejected = /工步/.test(error.message);
    }
    assert.equal(parentDeleteRejected, true);
    const reversed = stepsWithSubstep
      .filter(step => !step.parent_step_id)
      .map(step => step.step_id)
      .reverse();
    const reordered = await request(`/steps/reorder?p=${project}`, {
      method: 'POST', body: { step_ids: reversed },
    });
    const topAfterReorder = reordered.steps.filter(step => !step.parent_step_id);
    assert.equal(topAfterReorder[0].step_no, '010');
    assert.equal(topAfterReorder[1].step_no, '020');
    assert.deepEqual(topAfterReorder.map(step => step.step_id), reversed);
    const childAfterReorder = reordered.steps.find(step => step.step_id === childStep.step_id);
    const parentAfterReorder = reordered.steps.find(step => step.step_id === parentStep.step_id);
    assert.equal(childAfterReorder.step_no, `${parentAfterReorder.step_no}-1`);
    process.stdout.write('Smoke tests passed\n');
  } finally {
    server.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  if (output) process.stderr.write(output.slice(-4000) + '\n');
  process.exitCode = 1;
});
