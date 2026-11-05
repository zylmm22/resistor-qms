'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.QMS_BASE_URL || 'http://127.0.0.1:8848';
const PROJECT = process.env.QMS_PROJECT || 'SIM-APQP-20261102-01';
const PORT = 9400 + Math.floor(Math.random() * 300);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-dialog-e2e-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForUrl(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (e) { /* Chrome 仍在启动 */ }
    await sleep(100);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1440,1000',
    `${BASE}/?p=${encodeURIComponent(PROJECT)}#doc/P1-11`,
  ], { stdio: 'ignore', windowsHide: true });

  let socket;
  try {
    await waitForUrl(`http://127.0.0.1:${PORT}/json/version`);
    let pageTarget;
    for (let attempt = 0; attempt < 80 && !pageTarget; attempt += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      pageTarget = targets.find(target => target.type === 'page' && target.url.includes(BASE));
      if (!pageTarget) await sleep(100);
    }
    if (!pageTarget) throw new Error('未找到 QMS 浏览器页面');

    socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const javascriptDialogs = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Page.javascriptDialogOpening') javascriptDialogs.push(message.params);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    };
    const waitFor = async (expression, label) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = await evaluate(`Boolean(${expression})`).catch(() => false);
        if (ready) return;
        await sleep(100);
      }
      throw new Error(`等待超时：${label}`);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    const nativeDialogGuard = `
      window.__nativePopupCalls = [];
      for (const name of ['prompt', 'confirm', 'alert']) {
        window[name] = function(...args) {
          window.__nativePopupCalls.push({ name, text: String(args[0] || '') });
          if (name === 'confirm') return false;
          if (name === 'prompt') return null;
        };
      }`;
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: nativeDialogGuard,
    });
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(100);
    await send('Page.navigate', { url: `${BASE}/?p=${encodeURIComponent(PROJECT)}#doc/P1-11` });
    await waitFor(`document.querySelector('#loginUsername')`, '登录页');
    await evaluate(nativeDialogGuard);
    await evaluate(`(() => {
      document.querySelector('#loginUsername').value = 'admin';
      document.querySelector('#loginPassword').value = 'admin123';
      document.querySelector('.login-card').requestSubmit();
      return true;
    })()`);
    await waitFor(`document.querySelector('#docRevise')`, 'P1-11 发起修订按钮');

    await evaluate(`document.querySelector('#docRevise').click()`);
    await waitFor(`document.querySelector('#appDialogBackdrop')`, '发起修订窗口');
    assert.equal(await evaluate(`document.querySelector('#appDialogTitle').textContent`), '发起修订');
    assert.equal(await evaluate(`document.querySelectorAll('#appDialogBackdrop').length`), 1);
    assert.equal(await evaluate(`window.__nativePopupCalls.length`), 0, '不得调用浏览器原生弹窗');
    if (process.env.QMS_E2E_SCREENSHOT) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.resolve(process.env.QMS_E2E_SCREENSHOT), Buffer.from(screenshot.data, 'base64'));
    }

    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('#appDialogBackdrop')`, 'Esc 关闭窗口');

    await evaluate(`(() => {
      window.__originalFetch = window.fetch;
      window.__revisePayload = null;
      window.fetch = function(input, init) {
        if (String(input).includes('/api/docs/P1-11/revise') && init?.method === 'POST') {
          window.__revisePayload = JSON.parse(init.body);
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return window.__originalFetch.call(this, input, init);
      };
      document.querySelector('#docRevise').click();
      return true;
    })()`);
    await waitFor(`document.querySelector('#appDialogBackdrop textarea')`, '修订原因表单');
    await evaluate(`(() => {
      const input = document.querySelector('#appDialogBackdrop textarea');
      input.value = '浏览器 E2E：验证统一修订窗口';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#appDialogBackdrop form').requestSubmit();
      return true;
    })()`);
    await waitFor(`window.__revisePayload`, '修订请求载荷');
    assert.deepEqual(await evaluate(`window.__revisePayload`), {
      reason: '浏览器 E2E：验证统一修订窗口',
      user: '张工艺',
    });
    assert.equal(await evaluate(`Boolean(document.querySelector('#appDialogBackdrop'))`), false);

    await evaluate(`(() => {
      window.__multiDialogResult = null;
      showFormDialog({
        title: '多字段窗口验证',
        fields: [
          { key: 'name', label: '名称', required: true },
          { key: 'status', label: '状态', type: 'select', options: ['在用', '停用'] },
        ],
        confirmText: '保存',
      }).then(value => { window.__multiDialogResult = value; });
      return true;
    })()`);
    await waitFor(`document.querySelector('#appDialogBackdrop input[name="name"]')`, '多字段窗口');
    await evaluate(`(() => {
      document.querySelector('#appDialogBackdrop input[name="name"]').value = '测试设备';
      document.querySelector('#appDialogBackdrop select[name="status"]').value = '停用';
      document.querySelector('#appDialogBackdrop form').requestSubmit();
      return true;
    })()`);
    await waitFor(`window.__multiDialogResult`, '多字段窗口返回值');
    assert.deepEqual(await evaluate(`window.__multiDialogResult`), { name: '测试设备', status: '停用' });

    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await evaluate(`(() => {
      window.__mobileDialogResult = null;
      showFormDialog({
        title: '移动端窗口验证',
        description: '检查窄屏下标题、长文本和操作按钮不会溢出。',
        fields: [{ key: 'note', label: '说明', type: 'textarea', value: '移动端长文本内容', required: true }],
        confirmText: '保存',
      }).then(value => { window.__mobileDialogResult = value; });
      return true;
    })()`);
    await waitFor(`document.querySelector('#appDialogBackdrop')`, '移动端窗口');
    assert.equal(await evaluate(`(() => {
      const rect = document.querySelector('.app-dialog').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    })()`), true, '移动端窗口必须完整落在视口内');
    await evaluate(`document.querySelector('#appDialogBackdrop [data-dialog-cancel]').click()`);
    await waitFor(`window.__mobileDialogResult === null && !document.querySelector('#appDialogBackdrop')`, '关闭移动端窗口');
    await send('Emulation.clearDeviceMetricsOverride');

    await evaluate(`(() => {
      window.__confirmDialogResult = null;
      showConfirmDialog('确认窗口验证', '仅验证窗口交互，不执行删除。', { danger: true })
        .then(value => { window.__confirmDialogResult = value; });
      return true;
    })()`);
    await waitFor(`document.querySelector('#appDialogBackdrop')`, '确认窗口');
    await evaluate(`document.querySelector('#appDialogBackdrop [data-dialog-cancel]').click()`);
    await waitFor(`window.__confirmDialogResult === false`, '取消确认窗口');
    assert.equal(await evaluate(`window.__nativePopupCalls.length`), 0);
    assert.equal(javascriptDialogs.length, 0, '浏览器不得收到原生 JavaScript 对话框事件');

    console.log('dialog-browser-e2e: 发起修订、Esc 取消、多字段提交、确认取消均通过');
  } finally {
    try { socket?.close(); } catch (e) { /* 忽略关闭错误 */ }
    chrome.kill();
    await sleep(300);
    const safePrefix = path.join(os.tmpdir(), 'qms-dialog-e2e-');
    const resolved = path.resolve(PROFILE);
    if (resolved.startsWith(safePrefix)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
