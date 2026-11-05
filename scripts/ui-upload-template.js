'use strict';
// 浏览器走查辅助：向本地预览服务（scripts/preview-server.js）上传一个测试模板，验证上传/解析接口。
// 仅在本地测试库使用；口令默认取预览环境的走查口令，可用环境变量覆盖。
const EX = require('../lib/export');

const PORT = process.env.PORT || '8850';
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = process.env.QMS_PREVIEW_USER || 'admin';
const PASSWORD = process.env.QMS_PREVIEW_PASSWORD || 'WalkAdmin2026!';

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!login.ok) throw new Error('登录失败 ' + login.status);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const cells = {
    A1: '特性', B1: '目标', C1: '下限', D1: '上限',
    A2: '阻值精度', B2: '10', C2: '9.9', D2: '10.1',
  };
  const buffer = EX.buildGridWorkbook([{ name: 'Data', cells }], { title: 'UI-WALKTHROUGH' });
  const upload = await fetch(`${BASE}/api/templates?p=RES-CHIP-2026-01`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'UI 走查模板',
      phase: 3,
      filename: 'ui-walkthrough.xlsx',
      doc_code: 'P3-05',
      dataBase64: buffer.toString('base64'),
    }),
  });
  const json = await upload.json();
  console.log(JSON.stringify({ status: upload.status, ...json }, null, 1));
}

main().catch(error => { console.error(error); process.exit(1); });
