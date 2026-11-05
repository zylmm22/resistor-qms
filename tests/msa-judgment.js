'use strict';

/**
 * M-02（P1-4）GR&R 判定收敛单元测试。
 * 旧逻辑只在 %Overall<10% 分支检查 ndc，导致 ndc<5 仍判“条件接受”；
 * 新逻辑先判 ndc<5 → 不接受，并对 GRR=0 单独判接受。
 *
 * 运行：node tests/msa-judgment.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-msa-judgment-'));
process.env.QMS_DB_PATH = path.join(TEMP, 'qms.db');
const DB = require('../lib/db');

function dataset({ partStep, repeat, operatorShift }, parts = 10, ops = 3, trials = 3) {
  return Array.from({ length: ops * trials }, (_, row) => {
    const operator = Math.floor(row / trials);
    const trial = row % trials;
    return Array.from({ length: parts }, (_, part) =>
      +(10 + part * partStep + operator * operatorShift + trial * repeat).toFixed(6));
  });
}

try {
  const flat = DB.computeGRR(dataset({ partStep: 0, repeat: 0, operatorShift: 0 }), 10, 3, 3, 2);
  assert.equal(flat.GRR, 0, '无变差数据的 GRR 应为 0');
  assert.equal(flat.judgment, '接受', 'M-02：GRR=0 应单独判接受');
  assert.match(flat.reason, /GRR=0|未观测到变差/);

  const good = DB.computeGRR(dataset({ partStep: 0.9, repeat: 0.01, operatorShift: 0.01 }), 10, 3, 3, 8);
  assert.equal(good.judgment, '接受', '分辨能力充足且变差小应判接受');
  assert.ok(good.ndc >= 5, '接受结论要求 ndc≥5');

  // 旧逻辑下这个样例会判“条件接受”（综合变差 27.89% ≤30%，但 ndc=4）
  const weakNdc = DB.computeGRR(dataset({ partStep: 0.15, repeat: 0.1, operatorShift: 0.05 }), 10, 3, 3, 5);
  assert.ok(weakNdc.ndc < 5, '前置条件：ndc 应小于 5');
  assert.ok(weakNdc.pctOverall <= 30, '前置条件：综合变差应处于条件接受区间');
  assert.equal(weakNdc.judgment, '不接受',
    'M-02：ndc<5 即使综合变差在 10%–30% 区间也应判不接受');
  assert.match(weakNdc.reason, /ndc/);

  for (const partStep of [0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
    for (const repeat of [0.05, 0.1, 0.2, 0.3]) {
      for (const operatorShift of [0, 0.05, 0.1, 0.2]) {
        const result = DB.computeGRR(dataset({ partStep, repeat, operatorShift }), 10, 3, 3, 5);
        if (result.GRR > 0 && result.ndc < 5) {
          assert.equal(result.judgment, '不接受',
            `M-02：ndc=${result.ndc} 时不得判为${result.judgment}`);
          assert.match(result.reason, /ndc/);
        }
      }
    }
  }

  console.log('msa-judgment: M-02 ndc/GRR=0 judgment rules passed');
} finally {
  try { DB.db.close(); } catch {}
  fs.rmSync(TEMP, { recursive: true, force: true });
}
