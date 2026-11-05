'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const OCR = require('../lib/ocr');

const flowWords = [
  ['预处理', 202, 76], ['镀膜', 636, 73], ['热处理', 1033, 73], ['压帽', 1467, 73],
  ['联线涂装', 180, 374], ['点焊', 639, 370], ['刻槽后处理', 990, 374], ['刻槽', 1467, 370],
  ['筛选', 220, 666],
].map(([t, x, y]) => ({ t, x, y, w: 100, h: 45 }));

assert.deepEqual(OCR.labelsFromWords(flowWords), [
  '预处理', '镀膜', '热处理', '压帽', '联线涂装', '点焊', '刻槽后处理', '刻槽', '筛选',
], '未知流程词不得被结构词典丢弃');

(async () => {
  const words = await OCR.runOCR(path.join(__dirname, '..', 'public', 'samples', 'resistor-drawing.png'));
  const labels = OCR.labelsFromWords(words);
  for (const expected of ['白瓷棒', '膜层', '清漆', '缓冲层', '塑封层', '引线帽', '螺旋槽']) {
    assert.ok(labels.includes(expected), `示意图 OCR 缺少结构词：${expected}`);
  }
  process.stdout.write('ocr: RapidOCR 示意图文字和结构词提取通过\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
