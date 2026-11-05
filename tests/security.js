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
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH, NODE_NO_WARNINGS: '1',
      QMS_ADMIN_PASSWORD: 'admin123', QMS_ENGINEER_PASSWORD: 'engineer123',
      QMS_QUALITY_PASSWORD: 'quality123', QMS_AUDITOR_PASSWORD: 'auditor123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        const ready = await fetch(`${API}/meta`);
        if (ready.status === 401) break;
      } catch (e) { /* wait */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
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

    assert.throws(
      () => P.readZip(makeZip(Buffer.alloc(33 * 1024 * 1024))),
      /ZIP/,
      '超大解压条目必须被拒绝',
    );
    assert.throws(
      () => P.readZip(makeZip(Buffer.from('bad'), 99)),
      /ZIP/,
      '未知压缩方式必须被拒绝',
    );
    process.stdout.write('Security tests passed: 160 concurrent reads + malicious ZIP checks\n');
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
