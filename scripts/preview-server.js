'use strict';
/**
 * 浏览器逐屏验收专用启动器：固定测试库与演示口令，不影响 data/qms.db。
 * 仅用于本地 UI 走查，不作为生产启动入口。
 */
const path = require('node:path');

process.env.PORT = process.env.PORT || '8850';
// 固定只监听本机：口令是已知值，绝不能因 HOST 环境变量被带到局域网
process.env.HOST = '127.0.0.1';
process.env.QMS_DB_PATH = path.join(__dirname, '..', 'data', 'ui-walkthrough.db');
// 口令可被环境变量覆盖；默认值只用于本机走查，且服务不会离开 127.0.0.1
process.env.QMS_ADMIN_PASSWORD = process.env.QMS_PREVIEW_ADMIN_PASSWORD || 'WalkAdmin2026!';
process.env.QMS_QUALITY_PASSWORD = process.env.QMS_PREVIEW_QUALITY_PASSWORD || 'WalkQuality2026!';
process.env.QMS_ENGINEER_PASSWORD = process.env.QMS_PREVIEW_ENGINEER_PASSWORD || 'WalkEngineer2026!';
process.env.QMS_AUDITOR_PASSWORD = process.env.QMS_PREVIEW_AUDITOR_PASSWORD || 'WalkAuditor2026!';

require('../server.js');
