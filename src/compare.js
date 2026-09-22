'use strict';

/**
 * 分析对比（Compare）
 *
 * 对两条已保存分析的冲突清单按「区域对」匹配（不依赖冲突编号 conflict-N，
 * 编号随每次分析的排序结果变化，不能作为稳定标识）：
 * - 基准（旧）有、对比（新）无 → 已解决 resolved
 * - 对比（新）有、基准（旧）无 → 新增 added
 * - 两侧都有且属性一致 → 持续 ongoing
 * - 两侧都有但冲突类型 / 重叠起止与天数 / 共享资源有差异 → 属性变化 changed
 *
 * 区域集合校验：两侧冲突涉及的区域完全没有交集时抛出 422（多半是不同批次
 * 导入的区域，按区域对匹配没有意义）；部分不一致时正常对比并附 zoneSets 提示。
 */

const CONFLICT_TYPES = ['spatial', 'resource', 'both'];

/** 带 HTTP 状态码的业务错误，server 层据此返回可理解的响应 */
function compareError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * 区域对匹配键：两个区域 id 排序后拼接，与冲突编号、区域内顺序无关。
 * 结构异常（凑不齐两个区域 id）的记录加侧别前缀，保证不会跨侧误配。
 */
function pairKey(conflict, side) {
  const ids = [...new Set(
    (conflict.zones || []).map((z) => String(z.id || '')).filter(Boolean)
  )];
  if (ids.length < 2) return `#unpaired:${side}:${conflict.id}`;
  return ids.sort().join('|');
}

/** 从冲突记录中提取参与对比的属性快照 */
function snapshot(c) {
  return {
    conflictId: c.id,
    conflictType: CONFLICT_TYPES.includes(c.conflictType) ? c.conflictType : 'spatial',
    overlapStart: c.overlapStart || null,
    overlapEnd: c.overlapEnd || null,
    overlapDays: Number(c.overlapDays) || 0,
    sharedResources: Array.isArray(c.sharedResources) ? [...c.sharedResources].sort() : [],
    areaM2: Number(c.areaM2) || 0,
    geometry: c.geometry || null,
  };
}

/** 区域对展示信息（id / name / layer） */
function zoneSummaries(conflict) {
  return (conflict.zones || []).map((z) => ({
    id: String(z.id || ''),
    name: z.name || String(z.id || '?'),
    layer: z.layer || '',
  }));
}

/** 比较两个快照，返回字段级变化列表（无变化返回空数组） */
function diffSnapshots(before, after) {
  const changes = [];
  if (before.conflictType !== after.conflictType) {
    changes.push({ field: 'conflictType', from: before.conflictType, to: after.conflictType });
  }
  if (
    before.overlapStart !== after.overlapStart ||
    before.overlapEnd !== after.overlapEnd ||
    before.overlapDays !== after.overlapDays
  ) {
    changes.push({
      field: 'overlap',
      from: { start: before.overlapStart, end: before.overlapEnd, days: before.overlapDays },
      to: { start: after.overlapStart, end: after.overlapEnd, days: after.overlapDays },
    });
  }
  const addedRes = after.sharedResources.filter((r) => !before.sharedResources.includes(r));
  const removedRes = before.sharedResources.filter((r) => !after.sharedResources.includes(r));
  if (addedRes.length || removedRes.length) {
    changes.push({ field: 'sharedResources', added: addedRes, removed: removedRes });
  }
  return changes;
}

/** 收集冲突清单涉及的区域 id -> 名称 */
function collectZones(conflicts) {
  const map = new Map();
  for (const c of conflicts) {
    for (const z of c.zones || []) {
      const id = String(z.id || '');
      if (id && !map.has(id)) map.set(id, z.name || id);
    }
  }
  return map;
}

/** 按区域对建索引；analyze() 输出本就按区域对去重，异常重复时保留第一条保证确定性 */
function indexByPair(conflicts, side) {
  const map = new Map();
  for (const c of conflicts) {
    const key = pairKey(c, side);
    if (!map.has(key)) map.set(key, c);
  }
  return map;
}

function assertComparable(record, label) {
  if (!record || !record.result || !Array.isArray(record.result.conflicts)) {
    throw compareError(422, `${label}缺少有效的冲突清单（result.conflicts），无法参与对比`);
  }
}

/** 区域名称列表：超过 5 个时截断，避免提示信息过长 */
function nameList(zones) {
  const names = zones.slice(0, 5).map((z) => z.name);
  return zones.length > 5 ? `${names.join('、')} 等 ${zones.length} 个` : names.join('、');
}

/**
 * 对比两条已保存分析。
 * @param {Object} base 基准（旧）分析记录 {id, name, savedAt, result}
 * @param {Object} target 对比（新）分析记录
 * @returns 对比结果 {summary, zoneSets, added, resolved, ongoing, changed}
 */
function compareAnalyses(base, target) {
  assertComparable(base, '基准分析');
  assertComparable(target, '对比分析');

  const baseConflicts = base.result.conflicts;
  const targetConflicts = target.result.conflicts;

  // ---- 区域集合校验与差异提示 ----
  const baseZones = collectZones(baseConflicts);
  const targetZones = collectZones(targetConflicts);
  const sharedIds = [...baseZones.keys()].filter((id) => targetZones.has(id));
  if (baseZones.size && targetZones.size && !sharedIds.length) {
    throw compareError(
      422,
      `两条分析涉及的区域没有交集（基准 ${baseZones.size} 个、对比 ${targetZones.size} 个），` +
      '可能来自不同批次的区域导入，无法按区域对匹配冲突。请对同一批区域重新运行分析后再对比。'
    );
  }
  const onlyInBase = [...baseZones.keys()]
    .filter((id) => !targetZones.has(id))
    .map((id) => ({ id, name: baseZones.get(id) }));
  const onlyInTarget = [...targetZones.keys()]
    .filter((id) => !baseZones.has(id))
    .map((id) => ({ id, name: targetZones.get(id) }));
  const zoneSets = {
    shared: sharedIds.length,
    onlyInBase,
    onlyInTarget,
    differ: onlyInBase.length > 0 || onlyInTarget.length > 0,
    warning: null,
  };
  if (zoneSets.differ) {
    const parts = [];
    if (onlyInBase.length) parts.push(`仅基准分析涉及 ${nameList(onlyInBase)}`);
    if (onlyInTarget.length) parts.push(`仅对比分析涉及 ${nameList(onlyInTarget)}`);
    zoneSets.warning = `两条分析的区域集合不完全一致：${parts.join('；')}。相关冲突会按新增/已解决处理。`;
  }

  // ---- 按区域对匹配 ----
  const baseMap = indexByPair(baseConflicts, 'base');
  const targetMap = indexByPair(targetConflicts, 'target');

  const added = [];
  const resolved = [];
  const ongoing = [];
  const changed = [];

  for (const [key, b] of baseMap) {
    const t = targetMap.get(key);
    if (!t) {
      resolved.push({ key, zones: zoneSummaries(b), before: snapshot(b), after: null, changes: [] });
      continue;
    }
    const before = snapshot(b);
    const after = snapshot(t);
    const changes = diffSnapshots(before, after);
    const entry = { key, zones: zoneSummaries(t), before, after, changes };
    (changes.length ? changed : ongoing).push(entry);
  }
  for (const [key, t] of targetMap) {
    if (baseMap.has(key)) continue;
    added.push({ key, zones: zoneSummaries(t), before: null, after: snapshot(t), changes: [] });
  }

  // 分类内按区域对名称排序，保证展示稳定
  const byZoneNames = (x, y) => {
    const nx = x.zones.map((z) => z.name).join('∩');
    const ny = y.zones.map((z) => z.name).join('∩');
    return nx.localeCompare(ny, 'zh');
  };
  added.sort(byZoneNames);
  resolved.sort(byZoneNames);
  ongoing.sort(byZoneNames);
  changed.sort(byZoneNames);

  return {
    generatedAt: new Date().toISOString(),
    base: { id: base.id, name: base.name, savedAt: base.savedAt },
    target: { id: target.id, name: target.name, savedAt: target.savedAt },
    summary: {
      baseConflicts: baseConflicts.length,
      targetConflicts: targetConflicts.length,
      matched: ongoing.length + changed.length,
      added: added.length,
      resolved: resolved.length,
      ongoing: ongoing.length,
      changed: changed.length,
    },
    zoneSets,
    added,
    resolved,
    ongoing,
    changed,
  };
}

module.exports = { compareAnalyses };
