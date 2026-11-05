'use strict';
/**
 * 浏览器逐屏验收专用启动器：固定测试库与演示口令，不影响 data/qms.db。
 * 仅用于本地 UI 走查，不作为生产启动入口。
 */
const path = require('node:path');

process.env.PORT = process.env.PORT || '8850';
process.env.HOST = '127.0.0.1';
process.env.QMS_DB_PATH = path.join(__dirname, '..', 'data', 'ui-walkthrough.db');
process.env.QMS_ADMIN_PASSWORD = 'WalkAdmin2026!';
process.env.QMS_QUALITY_PASSWORD = 'WalkQuality2026!';
process.env.QMS_ENGINEER_PASSWORD = 'WalkEngineer2026!';
process.env.QMS_AUDITOR_PASSWORD = 'WalkAuditor2026!';

require('../server.js');
