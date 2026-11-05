'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const P = require('../lib/parse');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resistor-qms-security-'));
const DB_PATH = path.join(TMP, 'qms.db');
const PORT = 21000 + Math.floor(Math.random() * 500);
const API = `http://127.0.0.1:${PORT}/api`;

function makeZip(raw, method = 8) {
  const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const name = Buffer.from('xl/workbook.xml');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(8, 8);
  eocd.writeUInt16LE(8, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

async function main() {
  // 不使用系统已知默认口令：这些值已被服务端列入黑名单，复用会让弱口令测试看起来“正常”
  const PASSWORDS = {
    admin: 'Security-Admin-2026!', engineer: 'Security-Engineer-2026!',
    quality: 'Security-Quality-2026!', auditor: 'Security-Auditor-2026!',
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH, NODE_NO_WARNINGS: '1',
      QMS_ADMIN_PASSWORD: PASSWORDS.admin, QMS_ENGINEER_PASSWORD: PASSWORDS.engineer,
      QMS_QUALITY_PASSWORD: PASSWORDS.quality, QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      try {
        const probe = await fetch(`${API}/meta`);
        if (probe.status === 401) { ready = true; break; }
      } catch (e) { /* wait */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // 启动失败必须明确报出，否则后续请求会打到空白端口并给出误导性错误
    assert.ok(ready, '服务未启动（8 秒内 /api/meta 未返回 401）');
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORDS.admin }),
    });
    assert.equal(login.status, 200, `管理员登录应成功，实际 ${login.status}`);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie, '登录响应必须下发会话 Cookie');
    const cookie = setCookie.split(';')[0];
    const headers = { Cookie: cookie };

    const batch = Array.from({ length: 100 }, () => fetch(`${API}/meta?p=RES-CHIP-2026-01`, { headers }));
    const responses = await Promise.all(batch);
    assert.ok(responses.every(response => response.status === 200), '并发读取不应出现未授权或 5xx');

    const mixed = await Promise.all([
      ...Array.from({ length: 10 }, () => fetch(`${API}/fmea?type=DFMEA&p=RES-CHIP-2026-01`, { headers })),
      ...Array.from({ length: 10 }, () => fetch(`${API}/cp?p=RES-CHIP-2026-01`, { headers })),
      ...Array.from({ length: 10 }, () => fetch(`${API}/steps?p=RES-CHIP-2026-01`, { headers })),
    ]);
    assert.ok(mixed.every(response => response.status === 200), '并发读取业务页面不应失败');

    // 匹配具体信息：/ZIP/ 同时命中三种失败，会让“方式不支持”冒充“体积守卫生效”。
    // 33 MB 在解压阶段就会被 maxOutputLength 拦下，因此两种体积相关错误都算通过。
    assert.throws(
      () => P.readZip(makeZip(Buffer.alloc(33 * 1024 * 1024))),
      /条目过大|解压失败/,
      '超大解压条目必须被拒绝',
    );
    assert.throws(
      () => P.readZip(makeZip(Buffer.from('bad'), 99)),
      /不支持的 ZIP 压缩方式/,
      '未知压缩方式必须被拒绝',
    );
    /* ------------------------------------------- 复制项目不得绕过项目成员 */
    // 让 RES-CHIP-2026-02 只对 quality 开放，engineer 不在成员里
    const adminHeaders = { ...headers, 'Content-Type': 'application/json' };
    const memberSet = await fetch(`${API}/admin/projects/RES-CHIP-2026-02/members`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ user_ids: ['USR-QUALITY'] }),
    });
    assert.equal(memberSet.status, 200, '配置项目成员');

    const engineerLogin = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'engineer', password: PASSWORDS.engineer }),
    });
    const engineerCookie = engineerLogin.headers.get('set-cookie').split(';')[0];
    const engineerHeaders = { Cookie: engineerCookie, 'Content-Type': 'application/json' };

    const direct = await fetch(`${API}/docs/P2-06?p=RES-CHIP-2026-02`, { headers: engineerHeaders });
    assert.equal(direct.status, 403, '非成员直接访问应 403');

    const copyByEngineer = await fetch(`${API}/projects`, {
      method: 'POST', headers: engineerHeaders,
      body: JSON.stringify({ name: '越权复制', copy_from: 'RES-CHIP-2026-02' }),
    });
    assert.ok([403, 400].includes(copyByEngineer.status),
      `非管理员不能新建/复制项目，实际 ${copyByEngineer.status}`);
    assert.notEqual(copyByEngineer.status, 200, '复制无权访问的项目必须失败');

    // 管理员复制自己可访问的项目仍然可用（避免修复把功能一并禁掉）
    const copyByAdmin = await fetch(`${API}/projects`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        name: '管理员复制', project_id: 'SEC-COPY-OK', copy_from: 'RES-CHIP-2026-01',
        approved_by: '管理员',
      }),
    });
    assert.equal(copyByAdmin.status, 200, '管理员仍可复制可访问的项目');

    /* ------------------------------------------- 登录限流按 IP+用户名 */
    const firstAttempt = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost-user', password: 'wrong-password-1' }),
    });
    assert.equal(firstAttempt.status, 401, '不存在的账号应返回 401');
    for (let i = 0; i < 5; i += 1) {
      await fetch(`${API}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ghost-user', password: `wrong-password-${i}` }),
      });
    }
    const locked = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost-user', password: 'wrong-password-x' }),
    });
    assert.equal(locked.status, 429, '连续失败后应被限流');
    // 限流键含用户名：不能因为别人失败而锁死真实账号
    const otherUser = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORDS.admin }),
    });
    assert.equal(otherUser.status, 200, '其他账号不受影响');

    /* ------------------------------------------- 内部错误不回传 SQL 细节 */
    const badRequests = [
      `${API}/docs/__no_such_doc__?p=RES-CHIP-2026-01`,
      `${API}/cp?p=RES-CHIP-2026-01&stage=__bad__`,
    ];
    for (const url of badRequests) {
      const response = await fetch(url, { headers });
      const text = await response.text();
      assert.doesNotMatch(text, /SQLITE_|no such (table|column)|\.js:\d+|\/Users\/|C:\\\\/,
        `错误响应不得泄漏内部细节：${url}`);
    }

    process.stdout.write('Security tests passed: 并发读 + ZIP 防护 + 复制越权 + 登录限流 + 错误脱敏\n');
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

if (require.main !== module) module.exports = { makeZip };

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
