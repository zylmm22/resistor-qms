'use strict';
// 一次性清理历史演示姓名。只替换白名单里的演示值，不能按 `user: '...'` 整行删——
// app.js 里还有 `user: '管理员'` 这类真实请求字段，整行删除会静默改坏请求体。
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'public', 'app.js');
const before = fs.readFileSync(file, 'utf8');
const DEMO_NAMES = ['质量-陈', '张工艺', '质量经理 王'];
let source = before;
for (const name of DEMO_NAMES) {
  source = source.replace(new RegExp(`\\n\\s*(user|approved_by|published_by): '${name}',`, 'g'), '');
}
fs.writeFileSync(file, source);
console.log('stripped', before === source ? 'nothing' : 'demo actors');
