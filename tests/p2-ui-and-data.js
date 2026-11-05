'use strict';

/**
 * P2-2 / P2-4 / P2-5 / P2-6 修订验收测试。
 *
 * 静态断言（与 dialog-ui / spc-subgroup-ui 同风格）：
 *   Q-04 控制图 y 轴刻度、tooltip、判异点标注、I-MR 对齐、批次标签
 *   Q-12 判异截断提示、动态图例、Cpk 空值中性、R̄/S̄ 动态、子组数<25 提示
 *   Q-13 录入格式与实际图型同口径
 *   S-08 Gate 二次确认、评审意见、撤回评审
 *   S-09 项目切换会话级重置
 *   S-10 角色只读展示
 *   S-11 pushState/popstate 与未知路由提示
 *   S-12 0/0 PPAP 不显示“可提交”
 *   S-17/S-18 宽表滚动、吸顶表头、focus-visible、reduced-motion
 *   C-08 按服务端实际动作提示停用/删除
 *   C-12 抽样要求与 SPC 配置列语义
 *   M-08 KPI 颜色取后端 judgment
 *   M-09 建立台账不再 setTimeout 预填
 *
 * 单元/集成：
 *   A-11 DOCX 表格新增/删除行
 *   A-12 XLSX 解析警告（多工作表/截断）
 *   D-01 新增特性抽屉来源列表
 *   D-04/D-05 特性创建与项目引入同事务、特殊符号保留
 *
 * 运行：node tests/p2-ui-and-data.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const EX = require('../lib/export');
const P = require('../lib/parse');

let checks = 0;

/* ------------------------------------------------------------ 静态断言 */
/** 按标记切片；标记缺失时直接报出是哪一个，避免后续断言给出误导性失败 */
function sliceBy(mark, startMarker, endMarker) {
  const from = app.indexOf(startMarker);
  const to = endMarker ? app.indexOf(endMarker, from + 1) : app.length;
  assert.ok(from >= 0, `未找到代码标记（起点）：${startMarker}`);
  assert.ok(to > from, `未找到代码标记（终点）：${endMarker}`);
  return app.slice(from, to);
}
const blocks = {
  addChar: sliceBy('addChar', 'async function addChar(kind)', 'function openQuickCharacter'),
  controlChart: sliceBy('controlChart', 'function controlChart(stat, char)', 'function spcHistogram'),
  spcView: sliceBy('spcView', 'const chartTypeUpper = String(activeChartType', "$('#viewSub').textContent = `${activeChartType}"),
};

assert.match(blocks.controlChart, /const yTicks = Array\.from\(\{ length: 5 \}/, 'Q-04：控制图应绘制 y 轴刻度');
assert.match(blocks.controlChart, /<circle[^>]*><title>/, 'Q-04：tooltip 必须嵌入每个圆点');
assert.match(blocks.controlChart, /violationMap\.get\(i\)/, 'Q-04：规则判异点需要独立标注');
assert.match(blocks.controlChart, /secondaryOffset/, 'Q-04：I-MR 的 MR 子图必须按 x(i+1) 对齐');
assert.match(blocks.controlChart, /stat\.labels/, 'Q-04：x 轴应优先显示批次/时间标签');
checks += 5;

assert.match(app, /还有 \$\{shownStat\.violations\.length - 12\} 条判异未显示/, 'Q-12：判异清单截断需提示剩余条数');
assert.match(app, /chartTypeUpper === 'P' \? '不良率'/, 'Q-12：图例需按图型动态生成');
assert.match(app, /cpkUnavailable/, 'Q-12：Cpk 为 null 时使用中性显示');
assert.match(app, /const secondaryLabel = /, 'Q-12：R̄/S̄ 标签需按图型切换');
assert.match(app, /subgroupCount < 25/, 'Q-12：子组数少于 25 需提示仅供参考');
checks += 5;

assert.match(blocks.spcView, /const chartTypeUpper = String\(activeChartType/, 'Q-13：录入格式必须使用当前分析图型');
assert.doesNotMatch(blocks.spcView, /configuredTypeUpper/, 'Q-13：不得再用配置图型计算 expectedValues');
checks += 2;

assert.match(app, /data-gate-withdraw/, 'S-08：Gate 需提供撤回评审入口');
assert.match(app, /确认\$\{dec\} Gate/, 'S-08：通过/驳回前需要二次确认');
assert.match(app, /评审意见：\$\{comment\}/, 'S-08：通过前必须记录评审意见');
assert.match(server, /通过\/驳回都必须留下评审结论/, 'S-08：服务端应强制评审意见');
assert.match(server, /gates\\\/\(\\d\+\)\\\/withdraw|\/withdraw\$/, 'S-08：服务端应提供撤回接口');
checks += 5;

assert.match(app, /S-09：项目切换视为会话级重置/, 'S-09：切换项目需说明会话级重置');
assert.match(app, /state\.docCode = null;[\s\S]*state\.spcId = null;[\s\S]*state\.apqpPhase = null;/, 'S-09：切换项目需清理文档/SPC/阶段选中态');
assert.doesNotMatch(app, /尚未启用登录级越权拦截/, 'S-10：不得保留自认缺陷提示');
assert.match(app, /角色由登录账号决定/, 'S-10：角色下拉应为只读展示');
checks += 4;

assert.match(app, /history\.pushState/, 'S-11：普通导航应 pushState');
assert.match(app, /window\.addEventListener\('popstate'/, 'S-11：需要 popstate 分发');
assert.match(app, /页面不存在：/, 'S-11：未知哈希需要明确提示');
assert.match(app, /suppressRouteHistory/, 'S-11：回放历史时不得重复入栈');
checks += 4;

assert.match(app, /d\.ppapTotal === 0 \? '未开始'/, 'S-12：0/0 时 PPAP 应显示未开始');
assert.match(app, /d\.ppapTotal \? \(d\.ppapDone \/ d\.ppapTotal\) \* 100 : 0/, 'S-12：0/0 时进度条应为 0 而非 NaN');
checks += 2;

assert.match(css, /table\.t thead th\{position:sticky/, 'S-17：表头需要吸顶');
assert.match(css, /@media \(max-width:900px\)[\s\S]*\.card-b\{overflow-x:auto\}/, 'S-17：小屏宽表需要独立横向滚动');
assert.match(css, /:focus-visible\{/, 'S-18：需要键盘焦点样式');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'S-18：需要减少动态效果降级');
checks += 4;

assert.match(app, /result\.deleted === false[\s\S]*已停用并保留历史追溯/, 'C-08：停用/删除提示必须取服务端实际动作');
assert.match(app, /已停用 \$\{d\.stopped_rows\} 行/, 'C-08：停用行需在控制计划页可见');
assert.match(app, /样本（CP 要求）/, 'C-12：样本容量列需标明是 CP 要求');
assert.match(app, /频率（CP 要求）/, 'C-12：频率列需标明是 CP 要求');
assert.match(app, /SPC 配置/, 'C-12：SPC 子组配置需独立列名');
checks += 5;

// 浏览器走查：检具编号色块宽度曾随右侧状态文字变化（grid 自动排布把状态挤进第 1 列）
assert.match(css, /\.msa-gauge-code\{grid-column:1;grid-row:1\/3;align-self:center;justify-self:start/,
  'M-UI：检具编号色块必须固定在第 1 列、按自身文字定宽');
assert.match(css, /\.msa-gauge-main>b,\.msa-gauge-main>small\{grid-column:2;min-width:0\}/,
  'M-UI：检具名称/状态必须固定在第 2 列，不能回填到色块列');
assert.match(css, /\.msa-setup-grid \.field\{margin-bottom:8px;min-width:0\}/,
  'M-UI：研究设计网格字段必须允许收缩，长选项不得撑宽整列');
assert.match(css, /\.msa-gauge-main\{display:grid;grid-template-columns:auto minmax\(0,1fr\)/,
  'M-UI：检具行第二列必须可收缩，长状态文字用省略号截断');
checks += 4;

/* ------------------------------- 附件图册 / 工程图页 / MSA 交互 */
assert.match(app, /function openAttachmentGallery\(/, '附件：交付物图册组件存在');
assert.match(app, /function openImageViewer\(/, '附件：全屏查看器存在');
assert.match(app, /stage\.addEventListener\('wheel'[\s\S]{0,200}zoomAt\(/, '附件：查看器需支持滚轮缩放');
assert.match(app, /stage\.addEventListener\('pointermove'[\s\S]{0,160}offsetX/, '附件：查看器需支持拖动平移');
assert.match(app, /openImageViewer\(items, \+\w+\.dataset/, '附件：点击缩略图打开查看器');
assert.match(app, /const isDrawing = code === 'P2-06'/, '工程图：P2-06 使用专用布局');
assert.match(app, /drawingSections\.filter|d\.sections\.filter\(sec => sec\.t !== '基本信息'\)/, '工程图：不显示基本信息');
assert.match(app, /drawingHistory/, '工程图：变更履历内嵌页面');
assert.match(app, /drawingUploadSource/, '工程图：提供 CAD 源文件上传');
assert.match(app, /packingGallery/, '包装：P3-02 增加包装图片区');
// 浏览器直连附件：url 必须带项目参数，否则非默认项目的图片/PDF 一律 404（上传成功但预览空白）
assert.match(server, /const fileUrl = `\/api\/attachments\/\$\{encodeURIComponent\(row\.attachment_id\)\}\/file`\s*\n\s*\+ `\?p=\$\{encodeURIComponent\(CUR\)\}`/,
  '附件：访问 URL 必须自带项目参数');
assert.match(app, /function markBrokenImage\(/, '附件：图片加载失败需有可读提示');
assert.match(app, /data-drawing-thumb-img|drawing-cover img/, '工程图：预览/缩略图需处理加载失败');
assert.match(app, /data-packing-img/, '包装：图册缩略图需处理加载失败');
assert.match(css, /\.attach-file-badge\.bad\{/, '附件：加载失败样式存在');
assert.match(server, /function buildDocAttachmentSection/, '导出：交付物附件随 Word/Excel 导出');
assert.match(server, /attachments\\\/\(\[\^\/\]\+\)\\\/void|\/void\$/, '附件：提供作废接口');
assert.match(css, /\.img-viewer\{position:fixed/, '附件：查看器样式存在');
assert.match(css, /\.attach-grid\{display:grid/, '附件：图册网格样式存在');

// MSA：研究身份变化必须统一清空并二次确认
assert.match(app, /const switchContext = async \(reason, apply\)/, 'MSA：研究条件变化统一处理');
assert.match(app, /\$\('#mGauge'\)\.onchange = async/, 'MSA：检具变化需有处理器');
assert.match(app, /研究条件已变化/, 'MSA：切换条件前需确认清空');
assert.match(app, /const gridFilledCount = \(\)/, 'MSA：需要统计已录入数据点');
assert.match(app, /该检具对应计划 .* 正在研究中|正在研究中/, 'MSA：研究中计划给出明确提示');
assert.match(app, /study\.status !== '作废' && !study\.source_invalid/, 'MSA：作废/失效研究不出现在导出下拉');
assert.match(app, /该计划尚未维护公差/, 'MSA：计划缺公差时允许补填');
assert.match(app, /await vMsa\(\);\s*\n\s*if \(\$\('#mResult'\)\)/, 'MSA：计算后刷新计划表与历史');
checks += 28;

/* ------------------------------- 人员权限（2026-11-05 组织架构） */
assert.match(app, /function vUsers\(/, '权限：提供账号与权限页');
assert.match(app, /function openUserDrawer\(/, '权限：账号新增/编辑抽屉存在');
assert.match(app, /perm: 'user\.manage'/, '权限：账号页仅管理员可见');
assert.match(app, /d\.meta\.can_edit/, '权限：交付物按钮按当前账号归属隐藏');
// 账号权限：逐项勾选 + 单一账号表（旧版按部门拆表，窄屏各自横滚看起来错乱）
assert.match(app, /id="ufPermGroups"/, '账号：提供权限勾选清单');
assert.match(app, /data-perm-point=/, '账号：权限点可逐项勾选');
assert.match(app, /id="ufCustomPerms"/, '账号：可切换按角色默认/自定义');
assert.match(app, /id="userSearch"/, '账号：提供搜索框');
assert.match(css, /\.perm-group-items\{display:grid/, '账号：权限清单网格样式存在');
assert.match(css, /\.user-table-wrap\{overflow:auto/, '账号：账号表单一容器内滚动');
assert.match(server, /requirePermission\('doc\.approve'/, '权限：交付物批准改按权限点');
assert.match(server, /assertDocApprovable\(code\)/, '权限：副总审批受分管板块约束');
// MSA 拆成「台账与校准」（企管部）与「研究设计与数据」（质量部）两个页签
assert.match(app, /data-msa-tab="ledger"/, 'MSA：台账页签存在');
assert.match(app, /data-msa-tab="study"/, 'MSA：研究页签存在');
assert.match(app, /const canEditGauge = userCan\('msa\.gauge\.edit'\)/, 'MSA：台账页按 msa.gauge.edit 授权');
assert.match(app, /const canStudy = userCan\('msa\.edit'\)/, 'MSA：研究页按 msa.edit 授权');
assert.match(app, /data-msa-panel="ledger"/, 'MSA：台账面板独立渲染');
assert.match(css, /\.msa-tabs\{display:flex/, 'MSA：页签样式存在');
checks += 12;

assert.match(app, /latest\.judgment === '接受' \? 'ok'/, 'M-08：MSA KPI 颜色必须取判定结论');
assert.doesNotMatch(app, /data-create-gauge-from-plan="[\s\S]{0,600}setTimeout\(\(\) => \{\s*if \(\$\('#gCode'\)/, 'M-09：建立台账不得 setTimeout 预填');
assert.match(blocks.addChar, /const sourceList = /, 'D-01：新增特性抽屉必须自建来源列表');
assert.match(server, /documentDisplayData/, 'A-10：预览/导出应共用展示数据装配');
assert.match(server, /filled \+= nonEmpty \/ width/, 'A-09：表格完成度按行/单元格比例计分');
checks += 5;

/* ------------------------------------------------- A-11 DOCX 表格增删行 */
const tableXml = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>标题</w:t></w:r></w:p></w:tc></w:tr>'
  + '<w:tr><w:tc><w:p><w:r><w:t>旧1</w:t></w:r></w:p></w:tc></w:tr>'
  + '<w:tr><w:tc><w:p><w:r><w:t>旧2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
const added = EX.patchTable(tableXml, {
  cols: [{ label: '列A' }], rows: [['新1'], ['新2'], ['新3']], sourceRowIndexes: [0, 1, 2],
});
assert.equal((added.match(/<w:tr>/g) || []).length, 4, 'A-11：新增行必须写入导出表格');
assert.match(added, /新3/, 'A-11：新增行内容应出现');
assert.doesNotMatch(added, /旧2/, 'A-11：被覆盖的源行内容应替换');

const removed = EX.patchTable(tableXml, {
  cols: [{ label: '列A' }], rows: [['新1']], sourceRowIndexes: [0, 1, 2],
});
assert.equal((removed.match(/<w:tr>/g) || []).length, 2, 'A-11：删除的行必须从源 DOCX 移除');
assert.doesNotMatch(removed, /旧2/, 'A-11：删除行内容不得残留');
checks += 4;

/* --------------------------------------------- A-12 XLSX 解析警告 */
const cells = {};
for (let row = 1; row <= 401; row += 1) cells[`A${row}`] = row === 1 ? '序号' : `行${row}`;
const workbook = EX.buildGridWorkbook([
  { name: '明细', cells },
  { name: '其它', cells: { A1: '说明' } },
], { title: '解析警告测试' });
const parsed = P.parseXlsx(workbook);
assert.ok(Array.isArray(parsed.warnings), 'A-12：解析结果必须返回 warnings');
assert.ok(parsed.warnings.some(item => /400 行/.test(item)), 'A-12：超出行上限必须提示截断');
assert.ok(parsed.warnings.some(item => /2 个工作表/.test(item)), 'A-12：多工作表必须提示');
assert.equal(parsed.sheets[0].maxRow + 1, 400, 'A-12：截断后的行数仍为 400');
checks += 3;

/* --------------------------------------- D-04 / D-05 集成：创建+引入、符号保留 */
async function integration() {
  const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p2-'));
  const PORT = 25100 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}/api`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), QMS_DB_PATH: path.join(TEMP, 'qms.db'),
      QMS_ADMIN_PASSWORD: 'P2-Admin-2026', QMS_QUALITY_PASSWORD: 'P2-Quality-2026',
      QMS_ENGINEER_PASSWORD: 'P2-Engineer-2026', QMS_AUDITOR_PASSWORD: 'P2-Auditor-2026',
      NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const wait = async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
        if (response.status === 401 || response.ok) return;
      } catch (error) { /* not ready */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('服务未启动\n' + log);
  };
  let cookie = '';
  const call = async (method, url, body) => {
    const response = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (url.startsWith('/auth/login')) {
      cookie = response.headers.get('set-cookie').split(';')[0];
    }
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  };
  try {
    await wait();
    const login = await call('POST', '/auth/login', { username: 'admin', password: 'P2-Admin-2026' });
    assert.equal(login.status, 200, '登录应成功');
    const meta = await call('GET', '/meta?p=RES-CHIP-2026-01');
    const familyId = meta.json.project.family_id;
    const created = await call('POST', '/chars?p=RES-CHIP-2026-01', {
      name: 'P2 快速特性', char_kind: 'PRODUCT', family_id: familyId,
      target: 10, lsl: 9, usl: 11, unit: 'mm', special_symbol: 'CC/SC',
      import_project: true,
    });
    assert.equal(created.status, 200, `D-04：创建特性 HTTP ${JSON.stringify(created.json)}`);
    assert.ok(created.json.item?.pchar_id, 'D-04：同一事务应返回项目特性');
    assert.equal(created.json.item.special_symbol, 'CC/SC', 'D-05：多符号原文应保留');
    const patched = await call('PATCH', `/chars/${created.json.char_id}?p=RES-CHIP-2026-01`, {
      name: 'P2 快速特性', special_symbol: 'CC/SC', tol_text: '10±1 mm',
    });
    assert.equal(patched.status, 200, 'D-05：修改特性 HTTP');
    const detail = await call('GET', `/chars/${created.json.char_id}?p=RES-CHIP-2026-01`);
    assert.equal(detail.json.char.is_special, 1, 'D-05：有符号时 is_special 应为真');
    assert.equal(detail.json.char.special_symbol, 'CC/SC', 'D-05：符号不得被布尔化');
    checks += 6;
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}

integration()
  .then(() => console.log(`p2-ui-and-data: ok (${checks} checks)`))
  .catch(error => {
    console.error('P2 UI/数据验收失败：');
    console.error(error);
    process.exitCode = 1;
  });
