'use strict';

const assert = require('node:assert/strict');
const Guide = require('../lib/field-guide');

const project = Guide.forField('P0-01', '基本信息', {
  k: 'proj', label: '项目名称', type: 'text',
});
assert.equal(project.required, '必填/自动引用');
assert.match(project.guidance, /项目主数据/);
assert.match(project.example, /RMLE/);

const table = Guide.forField('P1-09', '初始 BOM', {
  k: 'bom', label: '物料', type: 'table',
});
assert.equal(table.required, '至少一行（适用时）');

const name = Guide.forColumn('P1-09', '初始 BOM', { k: 'bom' }, '名称', 2);
assert.equal(name.label, '名称');
assert.equal(name.example, '合金带');
assert.equal(name.columnKey, 'bom');
assert.equal(name.index, 2);

const supplier = Guide.forColumn('P1-09', '初始 BOM', { k: 'bom' }, '供应商', 5);
assert.match(supplier.guidance, /供应商全称/);

// 用目录里真实存在的列断言：联系方式已不在 P0-01 表格中，测一个不存在的列会永远通过
const DT = require('../lib/doctpl');
const memberColumns = DT.T['P0-01'].flatMap(section => section.fields || [])
  .find(field => field.k === 'members').cols;
assert.ok(memberColumns.includes('成员姓名'), 'P0-01 跨职能团队应包含“成员姓名”列');
const owner = Guide.forColumn('P0-01', '项目团队与参与方', { k: 'members' }, '成员姓名', 1);
assert.ok(owner.guidance && owner.guidance.length > 0, '真实列必须有填写说明');
assert.equal(owner.missing.includes('待确认'), true);

const feature = Guide.forColumn('P1-07', '设计目标', { k: 'targets' }, '特性', 0);
const target = Guide.forColumn('P1-07', '设计目标', { k: 'targets' }, '目标值', 1);
const tolerance = Guide.forColumn('P1-07', '设计目标', { k: 'targets' }, '公差', 2);
assert.match(feature.guidance, /特性编号/);
assert.match(target.guidance, /目标值和单位/);
assert.match(tolerance.guidance, /上下限/);
assert.equal(new Set([feature.guidance, target.guidance, tolerance.guidance]).size, 3,
  'Different table headers must receive different filling guidance');

console.log('field-guide: scalar fields, table columns, examples and missing-data rules passed');
