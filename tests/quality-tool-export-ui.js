'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

assert.match(app, /function exportQualityTool\(/, '质量工具需要统一导出入口');
for (const tool of ['fmea', 'cp', 'spc', 'msa', 'ppap']) {
  assert.match(app, new RegExp(`data-quality-export="${tool}"[^>]+data-export-fmt="docx"`),
    `${tool} 需要 Word 导出按钮`);
  assert.match(app, new RegExp(`data-quality-export="${tool}"[^>]+data-export-fmt="xlsx"`),
    `${tool} 需要 Excel 导出按钮`);
}
assert.match(app, /id="msaStudySelect"/, 'MSA 必须提供当前导出研究选择');
assert.match(app, /id="ppapSubmissionEdit"/, 'PPAP 必须提供提交信息维护入口');
assert.match(app, /id="spcDataManage"/, 'SPC 数据录入与历史必须独立于主工作区');
assert.match(app, /class="qt-toolbar"/, '质量工具必须使用统一工具栏结构');
assert.match(app, /const msaPlanView = plan =>/, 'MSA 计划状态必须由统一视图派生');
assert.match(app, /const currentPlans = plans\.filter/, 'MSA 计划表只能显示当前计划');
assert.match(app, /data-delete-study/, 'MSA 历史研究必须提供删除入口');

console.log('quality-tool-export-ui: ok');
