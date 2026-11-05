'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

const nativeDialogs = [...app.matchAll(/\b(?:window\.)?(?:prompt|confirm|alert)\s*\(/g)];
assert.equal(nativeDialogs.length, 0, '前端不得使用浏览器原生 prompt / confirm / alert');
assert.match(app, /function showFormDialog\(/, '必须提供统一的应用内表单对话框');
assert.match(app, /function showConfirmDialog\(/, '必须提供统一的应用内确认对话框');
assert.match(css, /\.app-dialog-backdrop\s*\{/, '统一对话框需要独立遮罩样式');
assert.match(css, /\.app-dialog\s*\{/, '统一对话框需要独立窗口样式');

console.log('dialog-ui: ok');
