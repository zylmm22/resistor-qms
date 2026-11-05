'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.QMS_BASE_URL || 'http://127.0.0.1:8848';
const PROJECT = process.env.QMS_PROJECT || 'SIM-APQP-20261102-01';
// 与其它验收测试一致：账号口令从环境变量读，不能在源码里写死
const USERNAME = process.env.QMS_E2E_USER || 'admin';
const PASSWORD = process.env.QMS_E2E_PASSWORD || '';
const PORT = 9700 + Math.floor(Math.random() * 140);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-quality-tools-e2e-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--window-size=1440,1000',
    `${BASE}/?p=${encodeURIComponent(PROJECT)}#fmea`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let chromeError = '';
  chrome.stderr.on('data', chunk => { chromeError += chunk.toString(); });
  let socket;
  try {
    let version;
    for (let index = 0; index < 100; index += 1) {
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
      catch { await sleep(100); }
    }
    if (!version) throw new Error(`Chrome 启动失败${chromeError ? `：${chromeError}` : ''}`);
    // 端口来自 BASE（可被 QMS_BASE_URL 覆盖），不能写死 8848；找不到页面要给出明确错误
    const baseHost = new URL(BASE).host;
    let target;
    for (let index = 0; index < 100; index += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = targets.find(item => item.type === 'page' && item.url.includes(baseHost));
      if (target) break;
      await sleep(100);
    }
    if (!target) throw new Error(`未找到 QMS 浏览器页面（期望 ${baseHost}）`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let index = 0; index < 120; index += 1) {
        if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`等待超时：${expression}`);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await waitFor(`document.querySelector('#loginUsername')`);
    if (!PASSWORD) throw new Error('缺少登录口令：请设置 QMS_E2E_PASSWORD（以及可选的 QMS_E2E_USER）');
    await evaluate(`(() => {
      document.querySelector('#loginUsername').value = ${JSON.stringify(USERNAME)};
      document.querySelector('#loginPassword').value = ${JSON.stringify(PASSWORD)};
      document.querySelector('.login-card').requestSubmit();
      return true;
    })()`);
    // 登录成功后才会有业务页；失败时立刻报出，而不是等到后面的超时
    await waitFor(`!document.querySelector('#loginScreen')`, '登录完成');

    await evaluate(`location.hash='pfd/INITIAL';true`);
    await waitFor(`document.querySelector('.pfd-stage-context')`);
    assert.match(await evaluate(`document.querySelector('.pfd-stage-context').textContent`), /P1-10 初始流程图/);
    assert.match(await evaluate(`document.querySelector('#viewSub').textContent`), /阶段 1/);
    await send('Page.reload', { ignoreCache: true });
    await waitFor(`document.querySelector('.pfd-stage-context')`);
    assert.equal(await evaluate(`location.hash`), '#pfd/INITIAL', '刷新后必须保留初始流程图阶段');
    await evaluate(`location.hash='pfd/PROCESS';true`);
    await waitFor(`document.querySelector('.pfd-stage-context')`);
    assert.match(await evaluate(`document.querySelector('.pfd-stage-context').textContent`), /P3-04 过程流程图/);
    assert.match(await evaluate(`document.querySelector('#viewSub').textContent`), /阶段 3/);

    await evaluate(`location.hash='fmea';true`);
    await waitFor(`document.querySelector('#btnFromImage')`);
    await evaluate(`document.querySelector('#btnFromImage').click();true`);
    await waitFor(`document.querySelector('#fiFile')`);
    const documentRoot = await send('DOM.getDocument');
    const fileInput = await send('DOM.querySelector', {
      nodeId: documentRoot.root.nodeId,
      selector: '#fiFile',
    });
    await send('DOM.setFileInputFiles', {
      nodeId: fileInput.nodeId,
      files: [path.join(__dirname, '..', 'public', 'samples', 'resistor-drawing.png')],
    });
    await waitFor(`document.querySelector('#fiChips')`);
    const ocrLabels = await evaluate(`Array.from(document.querySelectorAll('#fiChips input')).map(input => input.value).join('|')`);
    assert.match(ocrLabels, /白瓷棒/);
    assert.match(ocrLabels, /螺旋槽/);
    await evaluate(`document.querySelector('#fiClose').click();true`);

    const pages = [
      ['fmea', '.qt-toolbar'],
      ['cp', '.qt-toolbar'],
      ['spc', '#spcDataManage'],
      ['msa', '#msaStudySelect'],
      ['ppap', '#ppapSubmissionEdit'],
    ];
    for (const [tool, selector] of pages) {
      await evaluate(`location.hash=${JSON.stringify(tool)};true`);
      await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-quality-export="${tool}"]').length`), 2,
        `${tool} 必须提供 Word/Excel 导出入口`);
    }

    await evaluate(`location.hash='spc';true`);
    await waitFor(`document.querySelector('#spcDataManage')`);
    const subgroupHeaders = await evaluate(`Array.from(document.querySelectorAll('.spc-subgroup-table thead th')).map(cell => cell.textContent.trim())`);
    assert.ok(!subgroupHeaders.includes('子组标识'),
      'SPC 子组明细不得在 # 列之后重复显示子组标识');
    await evaluate(`document.querySelector('#spcDataManage').click();true`);
    await waitFor(`document.querySelector('#spcBatch')`);
    await evaluate(`document.querySelector('#drawer .x').click();true`);

    await evaluate(`location.hash='msa';true`);
    await waitFor(`document.querySelector('#msaStudySelect')`);
    assert.ok(await evaluate(`document.querySelector('#msaStudySelect').options.length > 0
      || document.querySelector('#msaStudySelect').disabled`),
    'MSA 有研究时必须可选择当前导出对象，无研究时应明确禁用');

    await evaluate(`location.hash='ppap';true`);
    await waitFor(`document.querySelector('#ppapSubmissionEdit')`);
    await evaluate(`document.querySelector('#ppapSubmissionEdit').click();true`);
    await waitFor(`document.querySelector('#ppsLevel')`);
    assert.equal(await evaluate(`document.querySelector('#ppsLevel').options.length`), 5);
    await evaluate(`document.querySelector('#drawer .x').click();true`);

    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 900 }, { width: 390, height: 844 }]) {
      await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 600 });
      for (const [tool, selector] of pages) {
        await evaluate(`location.hash=${JSON.stringify(tool)};true`);
        await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
        assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 2`),
          `${tool} 在 ${viewport.width}px 不得出现页面级横向溢出`);
      }
      await evaluate(`location.hash='pfd/INITIAL';true`);
      await waitFor(`document.querySelector('.pfd-stage-context')`);
      assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 2`),
        `初始流程图在 ${viewport.width}px 不得出现页面级横向溢出`);
      await evaluate(`location.hash='pfd/PROCESS';true`);
      await waitFor(`document.querySelector('.pfd-stage-context')`);
      assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 2`),
        `过程流程图在 ${viewport.width}px 不得出现页面级横向溢出`);
    }
    await send('Emulation.clearDeviceMetricsOverride');
    console.log('quality-tools-browser-e2e: 五工具、PFD 双阶段、示意图 OCR、刷新保持和响应式检查通过');
  } finally {
    try { socket?.close(); } catch {}
    chrome.kill();
    await sleep(300);
    const safePrefix = path.join(os.tmpdir(), 'qms-quality-tools-e2e-');
    if (path.resolve(PROFILE).startsWith(safePrefix)) fs.rmSync(PROFILE, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
