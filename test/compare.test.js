'use strict';

const assert = require('assert');
const { compareAnalyses } = require('../src/compare');
const { analyze } = require('../src/analysis');

function conflict(id, zoneA, zoneB, opts = {}) {
  const type = opts.type || 'spatial';
  return {
    id,
    conflictType: type,
    zones: [
      { id: zoneA, name: `区域${zoneA}`, layer: '土建' },
      { id: zoneB, name: `区域${zoneB}`, layer: '市政' },
    ],
    sharedResources: opts.resources || [],
    overlapStart: opts.start || '2026-10-01T00:00:00.000Z',
    overlapEnd: opts.end || '2026-11-01T00:00:00.000Z',
    overlapDays: opts.days !== undefined ? opts.days : 31,
    areaM2: opts.area !== undefined ? opts.area : 1000,
    geometry: type === 'resource' ? null : { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    suggestions: [],
  };
}

function record(id, conflicts) {
  return {
    id,
    name: `分析 ${id}`,
    savedAt: '2026-09-22T00:00:00.000Z',
    params: {},
    result: { conflictCount: conflicts.length, conflicts },
  };
}

// 1. 按区域对匹配，不依赖冲突编号：同一对区域在两次分析中编号不同仍应匹配为持续
let cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b')]),
  record('B', [conflict('conflict-7', 'a', 'b')])
);
assert.strictEqual(cmp.summary.ongoing, 1, '编号不同但区域对相同应判为持续');
assert.strictEqual(cmp.summary.added, 0);
assert.strictEqual(cmp.summary.resolved, 0);
assert.strictEqual(cmp.summary.changed, 0);
assert.strictEqual(cmp.summary.matched, 1);
assert.strictEqual(cmp.ongoing[0].before.conflictId, 'conflict-1');
assert.strictEqual(cmp.ongoing[0].after.conflictId, 'conflict-7');

// 2. 区域对匹配与区域内顺序无关
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b')]),
  record('B', [{
    ...conflict('conflict-1', 'b', 'a'),
    zones: [
      { id: 'b', name: '区域b', layer: '市政' },
      { id: 'a', name: '区域a', layer: '土建' },
    ],
  }])
);
assert.strictEqual(cmp.summary.ongoing, 1, '区域内顺序不同仍应匹配');

// 3. 新增：对比侧多出一对区域（区域集合部分不同 → 提示但不报错）
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b')]),
  record('B', [conflict('conflict-1', 'a', 'b'), conflict('conflict-2', 'a', 'c', { type: 'resource', resources: ['塔吊'] })])
);
assert.strictEqual(cmp.summary.ongoing, 1);
assert.strictEqual(cmp.summary.added, 1);
assert.strictEqual(cmp.added[0].before, null);
assert.strictEqual(cmp.added[0].after.conflictType, 'resource');
assert.deepStrictEqual(cmp.added[0].zones.map((z) => z.id).sort(), ['a', 'c']);
assert.strictEqual(cmp.zoneSets.differ, true, '区域集合不一致应给出提示');
assert.strictEqual(cmp.zoneSets.onlyInTarget.length, 1);
assert.strictEqual(cmp.zoneSets.onlyInTarget[0].id, 'c');
assert.ok(cmp.zoneSets.warning.includes('新增/已解决'), '提示应说明新增/已解决口径');

// 4. 已解决：基准侧多出一对区域
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b'), conflict('conflict-2', 'b', 'c')]),
  record('B', [conflict('conflict-1', 'a', 'b')])
);
assert.strictEqual(cmp.summary.resolved, 1);
assert.strictEqual(cmp.resolved[0].after, null);
assert.deepStrictEqual(cmp.resolved[0].zones.map((z) => z.id).sort(), ['b', 'c']);
assert.strictEqual(cmp.zoneSets.onlyInBase.length, 1);
assert.strictEqual(cmp.zoneSets.onlyInBase[0].id, 'c');

// 5. 属性变化：冲突类型变化
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b', { type: 'spatial' })]),
  record('B', [conflict('conflict-1', 'a', 'b', { type: 'both', resources: ['塔吊'] })])
);
assert.strictEqual(cmp.summary.changed, 1);
assert.strictEqual(cmp.summary.ongoing, 0);
const typeChange = cmp.changed[0].changes.find((ch) => ch.field === 'conflictType');
assert.ok(typeChange, '应报告冲突类型变化');
assert.strictEqual(typeChange.from, 'spatial');
assert.strictEqual(typeChange.to, 'both');
// 类型从 spatial → both 时共享资源也从 [] 变为 ['塔吊']，应一并报告
const resChange = cmp.changed[0].changes.find((ch) => ch.field === 'sharedResources');
assert.ok(resChange, '共享资源变化应一并报告');
assert.deepStrictEqual(resChange.added, ['塔吊']);
assert.deepStrictEqual(resChange.removed, []);

// 6. 属性变化：重叠起止与天数变化
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b')]),
  record('B', [conflict('conflict-1', 'a', 'b', {
    start: '2026-10-05T00:00:00.000Z', end: '2026-11-03T00:00:00.000Z', days: 29,
  })])
);
assert.strictEqual(cmp.summary.changed, 1);
const overlapChange = cmp.changed[0].changes.find((ch) => ch.field === 'overlap');
assert.ok(overlapChange, '应报告重叠时段变化');
assert.strictEqual(overlapChange.from.days, 31);
assert.strictEqual(overlapChange.to.days, 29);
assert.strictEqual(overlapChange.to.start, '2026-10-05T00:00:00.000Z');

// 7. 属性变化：共享资源增删（资源顺序不同不应误判）
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b', { type: 'both', resources: ['塔吊', '泵车'] })]),
  record('B', [conflict('conflict-1', 'a', 'b', { type: 'both', resources: ['泵车', '塔吊'] })])
);
assert.strictEqual(cmp.summary.ongoing, 1, '共享资源仅顺序不同应判为持续');
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b', { type: 'both', resources: ['塔吊', '泵车'] })]),
  record('B', [conflict('conflict-1', 'a', 'b', { type: 'both', resources: ['塔吊', '吊车'] })])
);
assert.strictEqual(cmp.summary.changed, 1);
const resDiff = cmp.changed[0].changes.find((ch) => ch.field === 'sharedResources');
assert.deepStrictEqual(resDiff.added, ['吊车']);
assert.deepStrictEqual(resDiff.removed, ['泵车']);

// 8. 完全一致：全部持续，无差异
cmp = compareAnalyses(
  record('A', [conflict('conflict-1', 'a', 'b'), conflict('conflict-2', 'b', 'c', { type: 'resource', resources: ['塔吊'] })]),
  record('B', [conflict('conflict-1', 'a', 'b'), conflict('conflict-2', 'b', 'c', { type: 'resource', resources: ['塔吊'] })])
);
assert.strictEqual(cmp.summary.ongoing, 2);
assert.strictEqual(cmp.summary.added + cmp.summary.resolved + cmp.summary.changed, 0);
assert.strictEqual(cmp.zoneSets.differ, false);
assert.strictEqual(cmp.zoneSets.warning, null);

// 9. 区域集合完全不相交 → 抛出 422 业务错误
assert.throws(
  () => compareAnalyses(
    record('A', [conflict('conflict-1', 'a', 'b')]),
    record('B', [conflict('conflict-1', 'x', 'y')])
  ),
  (err) => err.status === 422 && /没有交集/.test(err.message),
  '区域无交集应抛出 422 且消息可理解'
);

// 10. 记录缺少冲突清单 → 抛出 422
assert.throws(
  () => compareAnalyses({ id: 'A', result: {} }, record('B', [])),
  (err) => err.status === 422 && /冲突清单/.test(err.message)
);
assert.throws(
  () => compareAnalyses(null, record('B', [])),
  (err) => err.status === 422
);

// 11. 一侧无冲突：全部判为新增 / 已解决，不触发区域集合校验
cmp = compareAnalyses(record('A', []), record('B', [conflict('conflict-1', 'a', 'b')]));
assert.strictEqual(cmp.summary.added, 1);
assert.strictEqual(cmp.summary.resolved, 0);
cmp = compareAnalyses(record('A', [conflict('conflict-1', 'a', 'b')]), record('B', []));
assert.strictEqual(cmp.summary.resolved, 1);
assert.strictEqual(cmp.summary.added, 0);
cmp = compareAnalyses(record('A', []), record('B', []));
assert.strictEqual(cmp.summary.matched, 0);
assert.strictEqual(cmp.summary.added + cmp.summary.resolved, 0);

// 12. 快照字段：共享资源排序、面积/几何保留（前端地图定位依赖）
cmp = compareAnalyses(
  record('A', []),
  record('B', [conflict('conflict-1', 'a', 'b', { type: 'both', resources: ['泵车', '塔吊'], area: 1234.5 })])
);
assert.deepStrictEqual(cmp.added[0].after.sharedResources, ['泵车', '塔吊'].sort());
assert.strictEqual(cmp.added[0].after.areaM2, 1234.5);
assert.ok(cmp.added[0].after.geometry, '几何应保留用于地图定位');

// 13. 真实链路：analyze() 输出（conflict-N 编号随排序变化）→ 对比
function square(lon1, lat1, lon2, lat2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
}
const zonesV1 = [
  { id: 'z1', name: '一区', layer: '土建', start: '2026-10-01T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z', resources: ['塔吊'], geometry: square(121.470, 31.228, 121.474, 31.231) },
  { id: 'z2', name: '二区', layer: '市政', start: '2026-10-20T00:00:00.000Z', end: '2026-11-30T00:00:00.000Z', resources: ['塔吊'], geometry: square(121.472, 31.229, 121.476, 31.232) },
  // z3 只与 z1 空间相交（东侧边界不触及 z2），与 z2 无共享资源
  { id: 'z3', name: '三区', layer: '临建', start: '2026-10-05T00:00:00.000Z', end: '2026-10-25T00:00:00.000Z', resources: [], geometry: square(121.4702, 31.2282, 121.4718, 31.2300) },
];
// V2：z1/z2 均增配泵车（z1∩z2 共享资源变化 → 属性变化）；z3 工期挪到 z1 完工后（z1∩z3 应消失 → 已解决）
const zonesV2 = [
  { ...zonesV1[0], resources: ['塔吊', '泵车'] },
  { ...zonesV1[1], resources: ['塔吊', '泵车'] },
  { ...zonesV1[2], start: '2026-11-16T00:00:00.000Z', end: '2026-12-05T00:00:00.000Z' },
];
const r1 = analyze(zonesV1);
const r2 = analyze(zonesV2);
assert.strictEqual(r1.conflictCount, 2, 'V1 应有 z1∩z2 与 z1∩z3 两处冲突');
assert.strictEqual(r2.conflictCount, 1, 'V2 应只剩 z1∩z2 一处冲突');
cmp = compareAnalyses(record('V1', r1.conflicts), record('V2', r2.conflicts));
assert.strictEqual(cmp.summary.resolved, 1, 'z1∩z3 工期错开后应判为已解决');
assert.deepStrictEqual(cmp.resolved[0].zones.map((z) => z.id).sort(), ['z1', 'z3']);
assert.strictEqual(cmp.summary.changed, 1, 'z1∩z2 共享资源增加泵车应判为属性变化');
assert.deepStrictEqual(cmp.changed[0].zones.map((z) => z.id).sort(), ['z1', 'z2']);
const realResDiff = cmp.changed[0].changes.find((ch) => ch.field === 'sharedResources');
assert.ok(realResDiff, '真实链路下应报告共享资源变化');
assert.deepStrictEqual(realResDiff.added, ['泵车']);
assert.strictEqual(cmp.summary.added, 0);
// z3 仅在基准侧的冲突中出现 → 区域集合差异提示
assert.strictEqual(cmp.zoneSets.differ, true);
assert.deepStrictEqual(cmp.zoneSets.onlyInBase.map((z) => z.id), ['z3']);

console.log('✅ 全部测试通过');
