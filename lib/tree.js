'use strict';
/**
 * 将图纸识别出的标签归并为 DFMEA 结构节点。
 * 功能和失效分析属于后续设计分析，不从零件名称自动推断。
 */

const CATS = [
  { key: 'BODY', name: '电阻芯体', test: /瓷|基体|棒|管|骨架|磁芯|基片|晶片/ },
  { key: 'FILM', name: '电阻膜层', test: /膜|镀|喷涂|电阻层/ },
  { key: 'PROTECT', name: '保护层', test: /清漆|缓冲|涂层|漆|包封|塑封|外壳|壳体|保护|阻燃|涂装/ },
  { key: 'TERMINAL', name: '引出端', test: /引线|帽|电极|端子|焊|引脚|镀锡|镍层|银层|锡层/ },
  { key: 'FEATURE', name: '结构特征', test: /槽|螺纹|标识|打标|色环|缺口|孔/ },
];

function catOf(label) {
  for (const c of CATS) if (c.test.test(label)) return c;
  return { key: 'OTHER', name: '其他零件', test: /$^/ };
}

/**
 * @param {string} productName 产品名称（项目名）
 * @param {string[]} labels 图纸标签
 */
function buildTree(productName, labels) {
  const groups = new Map();
  const other = [];
  for (const raw of labels) {
    const name = String(raw).trim();
    if (!name) continue;
    const c = catOf(name);
    if (c.key === 'OTHER') { other.push(name); continue; }
    if (!groups.has(c.key)) groups.set(c.key, { key: c.key, name: c.name, children: [] });
    groups.get(c.key).children.push({ name, kind: 'part' });
  }

  // 组内排序：基体 → 膜 → 槽（特征并到芯体组，若芯体组不存在则单独成组）
  const order = ['BODY', 'FILM', 'FEATURE', 'PROTECT', 'TERMINAL'];
  const nodes = [];
  for (const k of order) {
    const g = groups.get(k);
    if (!g) continue;
    if (k === 'FEATURE') {
      const host = groups.get('BODY') || groups.get('FILM');
      if (host) {
        // 特征挂到芯体组，但保留其自身语义
        for (const ch of g.children) host.children.push(ch);
        continue;
      }
    }
    nodes.push({ name: g.name, kind: 'group', children: g.children });
  }
  if (other.length) {
    nodes.push({ name: '其他零件', kind: 'group',
      children: other.map(name => ({ name, kind: 'part' })) });
  }

  // 只有一个子节点、且名称是包含关系时压平（「电阻膜层 → 膜层」没必要两级；
  // 但「引出端 → 引线帽」要保留，因为引出端是有意义的子系统）
  const flat = nodes.map(g => {
    if (g.children && g.children.length === 1) {
      const c = g.children[0];
      if (g.name.includes(c.name) || c.name.includes(g.name)) {
        return { name: c.name, kind: 'node', children: [] };
      }
    }
    return g;
  });

  return {
    product: productName || '产品总成',
    nodeCount: 1 + flat.reduce((s, n) => s + 1 + (n.children ? n.children.length : 0), 0),
    nodes: flat,
    unknown: labels.filter(l => catOf(l).key === 'OTHER'),
  };
}

module.exports = { buildTree, catOf };
