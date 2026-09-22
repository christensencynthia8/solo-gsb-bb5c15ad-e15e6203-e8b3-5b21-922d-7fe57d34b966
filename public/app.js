/* 临时施工区域冲突分析台 - 前端逻辑 */
'use strict';

// ---------- 状态 ----------
const state = {
  zones: [],
  layers: [],
  selectedLayers: new Set(),
  lastResult: null,
  typeFilter: 'all',
  lastPrecheck: null,   // 最近一次质量预检结果
  selectedClusterId: null, // 当前选中的冲突协调集群（null = 全量视图）
  compareResult: null,  // 最近一次分析对比结果
  compareFilter: 'all', // 对比结果分类筛选
};

// 冲突类型展示配置
const CONFLICT_TYPES = {
  spatial: { label: '空间冲突', color: '#d0000b' },
  resource: { label: '资源冲突', color: '#e8590c' },
  both: { label: '空间+资源冲突', color: '#9c36b5' },
};
function typeLabel(t) {
  return (CONFLICT_TYPES[t] || {}).label || t || '空间冲突';
}

// 关键区域（集群割点）地图样式：金色虚线描边 + 菱形标记
const CRITICAL_STYLE = { color: '#f59f00', weight: 3.5, dashArray: '8 4', fillColor: '#f59f00', fillOpacity: 0.22 };
const DIMMED_STYLE = { color: '#bbb', weight: 1, fillColor: '#bbb', fillOpacity: 0.05 };

// 对比结果分类展示配置（新增 / 已解决 / 持续 / 属性变化）
const CMP_CATEGORIES = {
  added: { label: '新增', color: '#d0000b' },
  resolved: { label: '已解决', color: '#2f9e44' },
  ongoing: { label: '持续', color: '#1971c2' },
  changed: { label: '属性变化', color: '#e8590c' },
};

// ---------- 地图 ----------
const map = L.map('map').setView([31.23, 121.47], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const zonesLayer = L.layerGroup().addTo(map);
const conflictsLayer = L.layerGroup().addTo(map);
const criticalMarkersLayer = L.layerGroup().addTo(map);
const compareLayer = L.layerGroup().addTo(map); // 对比结果几何（按分类着色）
const zoneGeoLayers = new Map(); // zoneId -> Leaflet 图层（便于按集群切换样式）

const LAYER_COLORS = ['#2b8a3e', '#1971c2', '#e8590c', '#9c36b5', '#c2255c', '#0b7285', '#5f3dc4', '#a61e4d'];
function layerColor(layer) {
  const idx = Math.max(0, state.layers.indexOf(layer));
  return LAYER_COLORS[idx % LAYER_COLORS.length];
}

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);

function fmtArea(m2) {
  return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} 公顷` : `${m2.toLocaleString('zh-CN')} m²`;
}
function fmtDate(iso) {
  return iso ? iso.slice(0, 10) : '-';
}
function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- 区域渲染 ----------
function renderZones() {
  $('zoneCount').textContent = state.zones.length;
  const list = $('zoneList');
  list.innerHTML = '';

  zonesLayer.clearLayers();
  zoneGeoLayers.clear();
  const bounds = [];

  for (const z of state.zones) {
    const li = document.createElement('li');
    const resTags = (z.resources || []).length
      ? `<div class="meta">资源：${z.resources.map(escapeHtml).join('、')}</div>`
      : '';
    li.innerHTML = `
      <span>
        <span class="badge" style="background:${layerColor(z.layer)};color:#fff">${escapeHtml(z.layer)}</span>
        <strong>${escapeHtml(z.name)}</strong>
        <div class="meta">${fmtDate(z.start)} ~ ${fmtDate(z.end)}</div>
        ${resTags}
      </span>`;
    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = '删除';
    del.onclick = () => deleteZone(z.id);
    li.appendChild(del);
    list.appendChild(li);

    const popupHtml =
      `<b>${escapeHtml(z.name)}</b><br>图层：${escapeHtml(z.layer)}<br>${fmtDate(z.start)} ~ ${fmtDate(z.end)}` +
      ((z.resources || []).length ? `<br>资源：${z.resources.map(escapeHtml).join('、')}` : '');
    const geo = L.geoJSON(
      { type: 'Feature', geometry: z.geometry, properties: z },
      {
        style: { color: layerColor(z.layer), weight: 2, fillOpacity: 0.15 },
        onEachFeature: (f, l) => l.bindPopup(popupHtml),
      }
    );
    geo._defaultPopupHtml = popupHtml; // 恢复全量视图时还原弹窗内容
    geo.addTo(zonesLayer);
    zoneGeoLayers.set(z.id, geo);
    try { bounds.push(geo.getBounds()); } catch { /* ignore */ }
  }

  if (bounds.length) {
    const b = bounds.reduce((acc, cur) => acc.extend(cur));
    map.fitBounds(b.pad(0.1));
  }

  // 区域库变化后重新套用集群样式（如集群中的区域被删除，退回全量视图）
  if (state.selectedClusterId && state.lastResult) {
    const stillExists = (state.lastResult.clusters || []).some((cl) => cl.id === state.selectedClusterId)
      && clusterZoneIds(state.selectedClusterId).every((id) => zoneGeoLayers.has(id));
    if (stillExists) {
      applyClusterZoneStyles(state.selectedClusterId);
    } else {
      resetClusterView();
    }
  }
}

function renderLayerFilters() {
  const box = $('layerFilters');
  box.innerHTML = '';
  if (!state.layers.length) {
    box.innerHTML = '<em>暂无图层</em>';
    return;
  }
  for (const layer of state.layers) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedLayers.has(layer);
    cb.onchange = () => {
      cb.checked ? state.selectedLayers.add(layer) : state.selectedLayers.delete(layer);
    };
    const swatch = document.createElement('span');
    swatch.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:2px;background:${layerColor(layer)}`;
    label.append(cb, swatch, document.createTextNode(` ${layer}`));
    box.appendChild(label);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 数据加载 ----------
async function refreshZones() {
  const [{ zones }, { layers }] = await Promise.all([api('/api/zones'), api('/api/layers')]);
  state.zones = zones;
  state.layers = layers;
  layers.forEach((l) => state.selectedLayers.add(l)); // 新图层默认勾选
  renderZones();
  renderLayerFilters();
}

// ---------- 质量预检与规范化导入 ----------
async function runPrecheck(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    showMsg($('importMsg'), 'JSON 解析失败，请检查格式', false);
    return;
  }
  try {
    const result = await api('/api/zones/precheck', { method: 'POST', body: JSON.stringify(data) });
    state.lastPrecheck = result;
    renderPrecheck(result);
    $('precheckModal').hidden = false;
    if (result.summary.blocked === 0) {
      showMsg($('importMsg'), `预检完成：${result.summary.passed} 个要素全部可导入（${result.summary.withWarnings} 个含可自动修复的警告）`, true);
    } else {
      showMsg($('importMsg'), `预检完成：${result.summary.passed} 个可导入，${result.summary.blocked} 个存在错误需处理`, false);
    }
  } catch (err) {
    showMsg($('importMsg'), err.message, false);
  }
}

const QC_STATUS = {
  pass: { label: '通过', cls: 'pass' },
  warning: { label: '可导入（已规范化）', cls: 'warn' },
  error: { label: '错误，不可导入', cls: 'err' },
};

function renderPrecheck(result) {
  const s = result.summary;
  $('precheckSummary').innerHTML = `
    <span class="qc-stat total">共 ${s.total} 个要素</span>
    <span class="qc-stat pass">✓ 通过 ${s.passed}</span>
    <span class="qc-stat warn">⚠ 警告 ${s.warningCount} 条（涉及 ${s.withWarnings} 个要素，自动修复 ${s.fixedWarningCount} 处）</span>
    <span class="qc-stat err">✕ 错误 ${s.errorCount} 条（涉及 ${s.blocked} 个要素）</span>`;

  const list = $('precheckReportList');
  list.innerHTML = '';
  result.reports.forEach((r) => {
    const card = document.createElement('div');
    card.className = `qc-item qc-${r.status}`;
    const st = QC_STATUS[r.status];

    const head = document.createElement('div');
    head.className = 'qc-item-head';
    const canImport = r.status !== 'error';
    head.innerHTML = `
      <label class="qc-pick">
        <input type="checkbox" data-index="${r.index}" ${canImport ? '' : 'disabled'} ${canImport ? 'checked' : ''} />
      </label>
      <span class="qc-status qc-badge-${r.status}">${st.label}</span>
      <strong>#${r.index + 1} ${escapeHtml(r.name)}</strong>
      <code class="qc-path">${escapeHtml(r.sourcePath)}</code>`;
    card.appendChild(head);

    const issues = [...r.errors, ...r.warnings];
    if (issues.length) {
      const ul = document.createElement('ul');
      ul.className = 'qc-issues';
      for (const it of issues) {
        const li = document.createElement('li');
        const tag = it.severity === 'error'
          ? '<span class="qc-tag qc-tag-err">错误</span>'
          : `<span class="qc-tag qc-tag-warn">警告${it.fixed ? '·已修复' : ''}</span>`;
        li.innerHTML = `${tag} ${escapeHtml(it.message)} <code class="qc-path">${escapeHtml(it.path)}</code>`;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    if (canImport && r.normalized) {
      const det = document.createElement('details');
      const p = r.normalized.properties;
      det.innerHTML = `<summary>规范化预览</summary>
        <div class="qc-preview">
          <div>start：<code>${escapeHtml(p.start)}</code></div>
          <div>end：<code>${escapeHtml(p.end)}</code></div>
          <div>layer：<code>${escapeHtml(p.layer)}</code></div>
          <div>resources：<code>${escapeHtml((p.resources || []).join('、') || '（无）')}</code></div>
          <div>geometry：${r.normalized.geometry.type}，${countPositions(r.normalized.geometry)} 个位置（已显式闭合、去除重复点）</div>
        </div>`;
      card.appendChild(det);
    }

    list.appendChild(card);
  });

  syncSelectAll();
}

function countPositions(geometry) {
  let n = 0;
  (function walk(c) {
    if (typeof c[0] === 'number') { n += 1; } else { c.forEach(walk); }
  })(geometry.coordinates);
  return n;
}

/** 当前弹窗中勾选的要素原始索引 */
function selectedIndexes() {
  return [...document.querySelectorAll('#precheckReportList input[type=checkbox]:checked')]
    .map((cb) => Number(cb.dataset.index));
}

function syncSelectAll() {
  const cb = $('selectAllPassed');
  const enabled = [...document.querySelectorAll('#precheckReportList input[type=checkbox]:not(:disabled)')];
  const checked = [...document.querySelectorAll('#precheckReportList input[type=checkbox]:checked')];
  cb.checked = enabled.length > 0 && enabled.length === checked.length;
}

async function commitImport() {
  const result = state.lastPrecheck;
  if (!result) return;
  const indexes = selectedIndexes();
  if (!indexes.length) {
    alert('请至少勾选一个无错误的要素');
    return;
  }
  try {
    // 以预检返回的规范化集合为提交内容，服务端会再次复检
    const selectedSet = new Set(indexes);
    const selectedReports = result.reports
      .filter((r) => selectedSet.has(r.index) && r.normalized);
    const fixedInSelection = selectedReports.reduce(
      (n, r) => n + r.warnings.filter((w) => w.fixed).length, 0
    );
    const geojson = {
      type: 'FeatureCollection',
      features: selectedReports.map((r) => r.normalized),
    };
    const res = await api('/api/zones/commit', {
      method: 'POST',
      body: JSON.stringify({ geojson }),
    });
    $('precheckModal').hidden = true;
    showMsg($('importMsg'),
      `已导入 ${res.imported} 个区域` + (fixedInSelection ? `（导入前自动规范化 ${fixedInSelection} 处）` : ''),
      true);
    $('geojsonInput').value = '';
    state.lastPrecheck = null;
    await refreshZones();
  } catch (err) {
    alert(`导入失败：${err.message}`);
  }
}

function downloadNormalized() {
  const result = state.lastPrecheck;
  if (!result) return;
  const indexes = selectedIndexes();
  const selectedSet = new Set(indexes);
  // 勾选了要素时只下载勾选项；无勾选则下载全部通过项
  const features = indexes.length
    ? result.reports.filter((r) => selectedSet.has(r.index) && r.normalized).map((r) => r.normalized)
    : result.normalized.features;
  if (!features.length) {
    alert('没有可下载的规范化要素（均存在错误）');
    return;
  }
  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      generatedAt: result.generatedAt,
      source: 'quality-precheck',
      total: result.summary.total,
      passed: features.length,
      blocked: result.summary.blocked,
      warningsFixed: result.summary.fixedWarningCount,
    },
    features,
  };
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `normalized-${new Date().toISOString().slice(0, 10)}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteZone(id) {
  await api(`/api/zones/${id}`, { method: 'DELETE' });
  await refreshZones();
}

// ---------- 分析 ----------
async function runAnalysis() {
  const layers = state.layers.filter((l) => state.selectedLayers.has(l));
  const body = {
    layers,
    start: $('rangeStart').value || undefined,
    end: $('rangeEnd').value || undefined,
  };
  try {
    const result = await api('/api/analyze', { method: 'POST', body: JSON.stringify(body) });
    clearCompare(); // 新分析上下文下旧对比结果失效
    state.lastResult = result;
    resetClusterView();
    renderConflicts(result);
  } catch (err) {
    alert(`分析失败：${err.message}`);
  }
}

// ---------- 冲突协调集群 ----------

function getCluster(id) {
  return (state.lastResult?.clusters || []).find((cl) => cl.id === id) || null;
}

function clusterZoneIds(id) {
  const cl = getCluster(id);
  return cl ? cl.zoneIds : [];
}

function renderClusters(result) {
  const box = $('clusterList');
  box.innerHTML = '';
  const clusters = result.clusters || [];
  $('clusterSummary').textContent = clusters.length
    ? `${clusters.length} 个集群 · ${result.conflictCount} 处冲突`
    : result.conflicts.length
      ? '0 个集群（冲突未形成多区域连通分量）'
      : '0 个集群';

  if (!clusters.length) {
    box.innerHTML = '<em>本次分析没有形成含两个及以上区域的冲突集群。</em>';
    return;
  }

  for (const cl of clusters) {
    const card = document.createElement('div');
    card.className = 'cluster-item' + (cl.id === state.selectedClusterId ? ' active' : '');
    card.onclick = () => selectCluster(cl.id === state.selectedClusterId ? null : cl.id);

    const t = cl.conflictCountByType || {};
    const criticalSet = new Set(cl.criticalZones);
    const zoneTags = cl.zones
      .map((z) => `<span class="cluster-zone${criticalSet.has(z.id) ? ' critical' : ''}" title="${criticalSet.has(z.id) ? '关键区域：移除后集群将分裂' : ''}">${criticalSet.has(z.id) ? '◆ ' : ''}${escapeHtml(z.name)}</span>`)
      .join(' ');
    card.innerHTML = `
      <div class="cluster-title">
        <strong>${escapeHtml(cl.id.replace('cluster-', '集群 '))}</strong>
        <span class="cluster-metric">${cl.conflictCount} 处冲突 · ${cl.zoneIds.length} 个区域 · 累计重叠 ${cl.totalOverlapDays} 天</span>
      </div>
      <div class="cluster-types">
        <span class="ct-tag spatial">空间 ${t.spatial || 0}</span>
        <span class="ct-tag resource">资源 ${t.resource || 0}</span>
        <span class="ct-tag both">空间+资源 ${t.both || 0}</span>
        ${cl.criticalZones.length ? `<span class="ct-tag critical">◆ 关键区域 ${cl.criticalZones.length}</span>` : '<span class="ct-tag none">无关键区域</span>'}
      </div>
      <div class="cluster-zones">${zoneTags}</div>`;
    box.appendChild(card);
  }
}

function selectCluster(id) {
  clearCompare(); // 回到单次分析的集群视图时退出对比上下文
  state.selectedClusterId = id;
  renderClusters(state.lastResult);
  renderConflicts(state.lastResult);
  if (id) {
    applyClusterZoneStyles(id);
    fitCluster(id);
  } else {
    resetClusterView();
  }
}

function resetClusterView() {
  state.selectedClusterId = null;
  criticalMarkersLayer.clearLayers();
  for (const [zoneId, geo] of zoneGeoLayers) {
    const z = state.zones.find((zz) => zz.id === zoneId);
    const color = z ? layerColor(z.layer) : '#666';
    geo.setStyle({ color, weight: 2, fillColor: color, fillOpacity: 0.15, dashArray: null });
    if (geo._defaultPopupHtml !== undefined) geo.setPopupContent(geo._defaultPopupHtml);
  }
  $('resetClusterBtn').hidden = true;
  $('clusterScope').hidden = true;
}

/** 按集群过滤区域样式：集群内区域保留图层色并加粗，关键区域金色虚线，其余区域淡出 */
function applyClusterZoneStyles(id) {
  const cl = getCluster(id);
  $('resetClusterBtn').hidden = !cl;
  criticalMarkersLayer.clearLayers();
  if (!cl) {
    $('clusterScope').hidden = true;
    return;
  }
  $('clusterScope').hidden = false;
  $('clusterScope').textContent =
    `已按 ${cl.id.replace('cluster-', '集群 ')} 过滤（${cl.conflictCount} 处冲突）`;

  const memberIds = new Set(cl.zoneIds);
  const criticalSet = new Set(cl.criticalZones);
  for (const [zoneId, geo] of zoneGeoLayers) {
    const z = state.zones.find((zz) => zz.id === zoneId);
    const color = z ? layerColor(z.layer) : '#666';
    if (criticalSet.has(zoneId)) {
      geo.setStyle(CRITICAL_STYLE);
      geo.setPopupContent(
        `◆ <b>关键区域：${escapeHtml(z?.name || zoneId)}</b><br>移除该区域将导致「${cl.id.replace('cluster-', '集群 ')}」分裂` +
        (z ? `<br>图层：${escapeHtml(z.layer)}<br>${fmtDate(z.start)} ~ ${fmtDate(z.end)}` : '')
      );
      addCriticalMarker(geo);
    } else if (memberIds.has(zoneId)) {
      geo.setStyle({ color, weight: 3, fillColor: color, fillOpacity: 0.2, dashArray: null });
    } else {
      geo.setStyle(DIMMED_STYLE);
    }
  }
}

/** 在关键区域质心放置金色菱形标记（使用区域几何质心，不依赖额外坐标字段） */
function addCriticalMarker(geo) {
  try {
    const center = geo.getBounds().getCenter();
    const icon = L.divIcon({
      className: 'critical-marker',
      html: '◆',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    L.marker(center, { icon, interactive: false, keyboard: false }).addTo(criticalMarkersLayer);
  } catch { /* ignore */ }
}

/** 地图视角缩放到集群内区域（区域不在当前区域库时不调整视角） */
function fitCluster(id) {
  const cl = getCluster(id);
  if (!cl) return;
  const bounds = [];
  for (const zoneId of cl.zoneIds) {
    const geo = zoneGeoLayers.get(zoneId);
    if (geo) { try { bounds.push(geo.getBounds()); } catch { /* ignore */ } }
  }
  if (bounds.length) {
    map.fitBounds(bounds.reduce((acc, cur) => acc.extend(cur)).pad(0.15));
  }
}

function renderConflicts(result) {
  const counts = result.conflictCountByType || {
    spatial: result.conflicts.filter((c) => c.conflictType === 'spatial').length,
    resource: result.conflicts.filter((c) => c.conflictType === 'resource').length,
    both: result.conflicts.filter((c) => c.conflictType === 'both').length,
  };
  $('conflictSummary').textContent =
    `${result.conflictCount} 处冲突（空间 ${counts.spatial} / 资源 ${counts.resource} / 空间+资源 ${counts.both}）` +
    ` · 重叠面积共 ${fmtArea(result.totalConflictAreaM2)}`;

  renderClusters(result);
  const selectedCluster = state.selectedClusterId ? getCluster(state.selectedClusterId) : null;
  if (selectedCluster) {
    $('resetClusterBtn').hidden = false;
    $('clusterScope').hidden = false;
    $('clusterScope').textContent =
      `已按 ${selectedCluster.id.replace('cluster-', '集群 ')} 过滤（${selectedCluster.conflictCount} 处冲突）`;
  }

  conflictsLayer.clearLayers();
  const list = $('conflictList');
  list.innerHTML = '';

  // 先按选中集群过滤冲突，再按冲突类型筛选
  let visible = result.conflicts;
  if (selectedCluster) {
    const idSet = new Set(selectedCluster.conflictIds);
    visible = visible.filter((c) => idSet.has(c.id));
  }
  const filtered = state.typeFilter === 'all'
    ? visible
    : visible.filter((c) => c.conflictType === state.typeFilter);

  if (!result.conflicts.length) {
    list.innerHTML = '<em>未发现时空重叠或共享资源冲突。</em>';
    return;
  }
  if (selectedCluster && !visible.length) {
    list.innerHTML = '<em>该集群下没有冲突。</em>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<em>当前筛选条件下没有冲突，请切换筛选条件或恢复全量视图。</em>';
    return;
  }

  const clusterOfConflict = new Map();
  (result.clusters || []).forEach((cl) => cl.conflictIds.forEach((cid) => clusterOfConflict.set(cid, cl)));

  filtered.forEach((c) => {
    const idx = result.conflicts.indexOf(c); // 保持完整结果中的编号稳定
    const typeInfo = CONFLICT_TYPES[c.conflictType] || CONFLICT_TYPES.spatial;
    const ownerCluster = clusterOfConflict.get(c.id);

    // 地图高亮相交区域（纯资源冲突无空间相交，不上图）
    let geo = null;
    if (c.geometry) {
      geo = L.geoJSON(
        { type: 'Feature', geometry: c.geometry, properties: c },
        { style: { color: typeInfo.color, weight: 2, fillColor: typeInfo.color, fillOpacity: 0.45 } }
      );
      geo.bindPopup(
        `<b>冲突 ${idx + 1}（${typeLabel(c.conflictType)}）</b><br>` +
        `${escapeHtml(c.zones.map((z) => z.name).join(' ∩ '))}<br>` +
        `重叠面积：${fmtArea(c.areaM2)}<br>重叠期：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays} 天）` +
        ((c.sharedResources || []).length ? `<br>共享资源：${c.sharedResources.map(escapeHtml).join('、')}` : '')
      );
      geo.addTo(conflictsLayer);
    }

    // 列表项
    const item = document.createElement('div');
    item.className = 'conflict-item';
    item.style.borderLeftColor = typeInfo.color;
    const zoneTags = c.zones
      .map((z) => `<span class="tag">${escapeHtml(z.name)}（${escapeHtml(z.layer)}）</span>`)
      .join(' ');
    const resTags = (c.sharedResources || []).length
      ? `<br>共享资源：${c.sharedResources.map((r) => `<span class="tag resource">${escapeHtml(r)}</span>`).join(' ')}`
      : '';
    const areaLine = c.geometry ? `重叠面积 ${fmtArea(c.areaM2)}` : '无空间相交（仅资源冲突）';
    const clusterLine = ownerCluster
      ? `<span class="tag cluster-tag" title="所属冲突协调集群">🔗 ${escapeHtml(ownerCluster.id.replace('cluster-', '集群 '))}</span>`
      : '';
    const suggestions = c.suggestions.map((s) => `<li>${escapeHtml(s.text)}</li>`).join('');
    item.innerHTML = `
      <h3>
        <span class="type-badge" style="background:${typeInfo.color}">${typeLabel(c.conflictType)}</span>
        #${idx + 1} ${areaLine}
      </h3>
      <div class="stats">
        ${zoneTags}${resTags}<br>
        重叠时段：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays} 天）
        ${clusterLine ? `<br>${clusterLine}` : ''}
      </div>
      <details>
        <summary>错峰建议（${c.suggestions.length} 条）</summary>
        <ul class="suggestions">${suggestions}</ul>
      </details>`;
    if (geo) {
      item.onclick = () => {
        map.fitBounds(geo.getBounds().pad(0.3));
        geo.openPopup();
      };
    } else {
      item.classList.add('no-geometry');
    }
    list.appendChild(item);
  });
}

// ---------- 已保存分析 ----------
async function refreshAnalyses() {
  const { analyses } = await api('/api/analyses');
  syncCompareOptions(analyses);
  const list = $('analysisList');
  list.innerHTML = '';
  if (!analyses.length) {
    list.innerHTML = '<li><em>暂无已保存分析</em></li>';
    return;
  }
  for (const a of analyses) {
    const li = document.createElement('li');
    const typeInfo = a.conflictCountByType
      ? `（空间 ${a.conflictCountByType.spatial} / 资源 ${a.conflictCountByType.resource} / 空间+资源 ${a.conflictCountByType.both}）`
      : '';
    const clusterInfo = a.clusterCount ? ` · ${a.clusterCount} 个协调集群` : '';
    li.innerHTML = `
      <span>
        <strong>${escapeHtml(a.name)}</strong>
        <div class="meta">${new Date(a.savedAt).toLocaleString('zh-CN')} · ${a.conflictCount} 处冲突${typeInfo}${clusterInfo} · ${fmtArea(a.totalConflictAreaM2)}</div>
      </span>`;
    const btns = document.createElement('span');
    btns.className = 'row';
    btns.style.marginBottom = '0';

    const view = document.createElement('button');
    view.className = 'small';
    view.textContent = '查看';
    view.onclick = async () => {
      const record = await api(`/api/analyses/${a.id}`);
      clearCompare(); // 查看单条分析时退出对比上下文
      state.lastResult = record.result;
      resetClusterView();
      renderConflicts(record.result);
    };

    const exp = document.createElement('button');
    exp.className = 'small';
    exp.textContent = '导出';
    exp.onclick = () => { window.location.href = `/api/analyses/${a.id}/export`; };

    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = '删除';
    del.onclick = async () => {
      await api(`/api/analyses/${a.id}`, { method: 'DELETE' });
      clearCompare(true); // 被删分析可能正参与对比，关闭对比并恢复单次分析视图
      await refreshAnalyses();
    };

    btns.append(view, exp, del);
    li.appendChild(btns);
    list.appendChild(li);
  }
}

// ---------- 分析对比 ----------

/** 同步对比下拉框选项；尽量保留原选择，默认基准=最早一条、对比=最新一条 */
function syncCompareOptions(analyses) {
  const base = $('compareBase');
  const target = $('compareTarget');
  const prevBase = base.value;
  const prevTarget = target.value;
  for (const sel of [base, target]) {
    sel.innerHTML = '';
    for (const a of analyses) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name}（${new Date(a.savedAt).toLocaleString('zh-CN')}）`;
      sel.appendChild(opt);
    }
  }
  base.value = analyses.some((a) => a.id === prevBase)
    ? prevBase
    : (analyses[0] ? analyses[0].id : '');
  target.value = analyses.some((a) => a.id === prevTarget)
    ? prevTarget
    : (analyses[analyses.length - 1] ? analyses[analyses.length - 1].id : '');
  $('compareBtn').disabled = analyses.length < 2;
}

/**
 * 退出对比上下文：清空对比图层与卡片。
 * restore=true 且当前有单次分析结果时，恢复其在地图上的呈现。
 */
function clearCompare(restore = false) {
  const had = state.compareResult !== null;
  state.compareResult = null;
  compareLayer.clearLayers();
  $('compareCard').hidden = true;
  const msg = $('compareMsg');
  msg.textContent = '';
  msg.className = 'msg';
  if (restore && had && state.lastResult) renderConflicts(state.lastResult);
}

async function runCompare() {
  const baseId = $('compareBase').value;
  const targetId = $('compareTarget').value;
  if (!baseId || !targetId) {
    showMsg($('compareMsg'), '请先保存至少两条分析，再选择进行对比', false);
    return;
  }
  if (baseId === targetId) {
    showMsg($('compareMsg'), '基准与对比不能是同一条分析，请选择两条不同的分析', false);
    return;
  }
  try {
    const result = await api('/api/analyses/compare', {
      method: 'POST',
      body: JSON.stringify({ baseId, targetId }),
    });
    state.compareFilter = 'all';
    $('compareFilter').value = 'all';
    renderCompare(result);
    const s = result.summary;
    showMsg($('compareMsg'),
      `对比完成：新增 ${s.added} · 已解决 ${s.resolved} · 持续 ${s.ongoing} · 属性变化 ${s.changed}`,
      true);
    $('compareCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showMsg($('compareMsg'), err.message, false);
  }
}

/** 单条快照的一行式描述（对比详情用） */
function snapshotLine(snap) {
  const res = snap.sharedResources.length ? snap.sharedResources.join('、') : '无';
  const area = snap.geometry ? fmtArea(snap.areaM2) : '无空间相交';
  return `${typeLabel(snap.conflictType)} · ${fmtDate(snap.overlapStart)} ~ ${fmtDate(snap.overlapEnd)}` +
    `（${snap.overlapDays} 天）· 共享资源 ${res} · ${area}`;
}

/** 字段级变化的可读描述 */
function changeLine(ch) {
  if (ch.field === 'conflictType') {
    return `冲突类型：${typeLabel(ch.from)} → ${typeLabel(ch.to)}`;
  }
  if (ch.field === 'overlap') {
    return `重叠时段：${fmtDate(ch.from.start)} ~ ${fmtDate(ch.from.end)}（${ch.from.days} 天）→ ` +
      `${fmtDate(ch.to.start)} ~ ${fmtDate(ch.to.end)}（${ch.to.days} 天）`;
  }
  if (ch.field === 'sharedResources') {
    const parts = [];
    if (ch.added.length) parts.push(`新增「${ch.added.join('」「')}」`);
    if (ch.removed.length) parts.push(`移除「${ch.removed.join('」「')}」`);
    return `共享资源：${parts.join('，')}`;
  }
  return ch.field;
}

function renderCompare(result) {
  state.compareResult = result;
  $('compareCard').hidden = false;
  const s = result.summary;
  $('compareSummary').textContent =
    `新增 ${s.added} · 已解决 ${s.resolved} · 持续 ${s.ongoing} · 属性变化 ${s.changed}`;
  $('compareMeta').innerHTML =
    `基准（旧）：<strong>${escapeHtml(result.base.name)}</strong>（${s.baseConflicts} 处冲突）→ ` +
    `对比（新）：<strong>${escapeHtml(result.target.name)}</strong>（${s.targetConflicts} 处冲突）；` +
    `按区域对匹配 ${s.matched} 对。` +
    (result.zoneSets.warning ? `<br><span class="compare-warn">⚠ ${escapeHtml(result.zoneSets.warning)}</span>` : '');

  // 地图：对比几何取代单次分析冲突几何（关闭对比时恢复）
  conflictsLayer.clearLayers();
  compareLayer.clearLayers();

  const entries = [
    ...result.added.map((e) => ({ cat: 'added', e })),
    ...result.resolved.map((e) => ({ cat: 'resolved', e })),
    ...result.changed.map((e) => ({ cat: 'changed', e })),
    ...result.ongoing.map((e) => ({ cat: 'ongoing', e })),
  ];

  // 全部分类的几何都上图（按分类着色；已解决用虚线表示"曾经的"冲突），筛选只影响列表
  const geos = new Map(); // entry -> Leaflet 图层（点击列表定位用）
  for (const { cat, e } of entries) {
    const geometry = (e.after && e.after.geometry) || (e.before && e.before.geometry);
    if (!geometry) continue; // 纯资源冲突无空间相交，不上图
    const info = CMP_CATEGORIES[cat];
    const geo = L.geoJSON(
      { type: 'Feature', geometry },
      {
        style: {
          color: info.color, weight: 2, fillColor: info.color, fillOpacity: 0.4,
          dashArray: cat === 'resolved' ? '6 4' : null,
        },
      }
    );
    const names = e.zones.map((z) => z.name).join(' ∩ ');
    const snap = e.after || e.before;
    geo.bindPopup(
      `<b>[${info.label}] ${escapeHtml(names)}</b><br>` +
      `类型：${typeLabel(snap.conflictType)}<br>` +
      `重叠期：${fmtDate(snap.overlapStart)} ~ ${fmtDate(snap.overlapEnd)}（${snap.overlapDays} 天）` +
      (snap.sharedResources.length ? `<br>共享资源：${snap.sharedResources.map(escapeHtml).join('、')}` : '')
    );
    geo.addTo(compareLayer);
    geos.set(e, geo);
  }

  const list = $('compareList');
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<em>两条分析的冲突清单一致（或均为空），没有差异。</em>';
    return;
  }
  const visible = entries.filter((x) => state.compareFilter === 'all' || x.cat === state.compareFilter);
  if (!visible.length) {
    list.innerHTML = '<em>当前分类下没有条目，请切换分类筛选。</em>';
    return;
  }
  for (const { cat, e } of visible) {
    list.appendChild(buildCompareItem(cat, e, geos.get(e)));
  }
}

function buildCompareItem(cat, e, geo) {
  const info = CMP_CATEGORIES[cat];
  const snap = e.after || e.before; // 展示主快照：新增/持续/变化取新，已解决取旧
  const item = document.createElement('div');
  item.className = 'conflict-item compare-item';
  item.style.borderLeftColor = info.color;

  const names = e.zones.map((z) => escapeHtml(z.name)).join(' ∩ ');
  const typeLine = e.before && e.after && e.before.conflictType !== e.after.conflictType
    ? `${typeLabel(e.before.conflictType)} → ${typeLabel(e.after.conflictType)}`
    : typeLabel(snap.conflictType);
  const areaLine = snap.geometry ? `重叠面积 ${fmtArea(snap.areaM2)}` : '无空间相交（仅资源冲突）';
  const resLine = snap.sharedResources.length
    ? `共享资源：${snap.sharedResources.map((r) => `<span class="tag resource">${escapeHtml(r)}</span>`).join(' ')}`
    : '共享资源：无';
  const changesHtml = e.changes.length
    ? `<ul class="cmp-changes">${e.changes.map((ch) => `<li>${escapeHtml(changeLine(ch))}</li>`).join('')}</ul>`
    : '';

  item.innerHTML = `
    <h3>
      <span class="type-badge" style="background:${info.color}">${info.label}</span>
      ${names}
    </h3>
    <div class="stats">
      类型：${typeLine} · ${areaLine}<br>
      重叠时段：${fmtDate(snap.overlapStart)} ~ ${fmtDate(snap.overlapEnd)}（${snap.overlapDays} 天）<br>
      ${resLine}
      ${changesHtml}
    </div>
    <details>
      <summary>对比详情</summary>
      <div class="cmp-detail">
        <div><strong>基准（旧）</strong>：${e.before ? escapeHtml(snapshotLine(e.before)) : '无此冲突'}</div>
        <div><strong>对比（新）</strong>：${e.after ? escapeHtml(snapshotLine(e.after)) : '无此冲突'}</div>
      </div>
    </details>`;
  if (geo) {
    item.onclick = () => {
      map.fitBounds(geo.getBounds().pad(0.3));
      geo.openPopup();
    };
  } else {
    item.classList.add('no-geometry');
  }
  return item;
}

// ---------- 事件绑定 ----------
$('precheckBtn').onclick = () => runPrecheck($('geojsonInput').value.trim());

$('fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('geojsonInput').value = reader.result; };
  reader.readAsText(file);
};

$('loadSampleBtn').onclick = async () => {
  const res = await fetch('/sample.geojson');
  $('geojsonInput').value = JSON.stringify(await res.json(), null, 2);
};

$('loadIssuesSampleBtn').onclick = async () => {
  const res = await fetch('/sample-issues.geojson');
  $('geojsonInput').value = JSON.stringify(await res.json(), null, 2);
};

// 预检结果弹窗
$('precheckCloseBtn').onclick = () => { $('precheckModal').hidden = true; };
$('precheckModal').onclick = (e) => {
  if (e.target.id === 'precheckModal') $('precheckModal').hidden = true;
};
$('commitImportBtn').onclick = commitImport;
$('downloadNormalizedBtn').onclick = downloadNormalized;
$('selectAllPassed').onchange = (e) => {
  document.querySelectorAll('#precheckReportList input[type=checkbox]:not(:disabled)')
    .forEach((cb) => { cb.checked = e.target.checked; });
};
document.addEventListener('change', (e) => {
  if (e.target.matches('#precheckReportList input[type=checkbox]')) syncSelectAll();
});

$('clearBtn').onclick = async () => {
  if (!confirm('确定清空全部已导入区域？')) return;
  await api('/api/zones', { method: 'DELETE' });
  state.selectedLayers.clear();
  conflictsLayer.clearLayers();
  criticalMarkersLayer.clearLayers();
  clearCompare();
  state.lastResult = null;
  state.selectedClusterId = null;
  $('conflictList').innerHTML = '<em>运行分析后在此展示，按重叠面积降序排列。</em>';
  $('conflictSummary').textContent = '未运行';
  $('clusterSummary').textContent = '未运行';
  $('clusterList').innerHTML = '<em>运行分析后在此展示协调集群（仅含两个及以上区域的连通分量）。</em>';
  $('resetClusterBtn').hidden = true;
  $('clusterScope').hidden = true;
  $('typeFilter').value = 'all';
  state.typeFilter = 'all';
  await refreshZones();
};

$('analyzeBtn').onclick = runAnalysis;

$('resetClusterBtn').onclick = () => {
  if (state.lastResult) selectCluster(null);
};

$('typeFilter').onchange = (e) => {
  state.typeFilter = e.target.value;
  clearCompare(); // 切换单次分析筛选时退出对比上下文
  if (state.lastResult) renderConflicts(state.lastResult);
};

// ---------- 分析对比事件 ----------
$('compareBtn').onclick = runCompare;

$('compareFilter').onchange = (e) => {
  state.compareFilter = e.target.value;
  if (state.compareResult) renderCompare(state.compareResult);
};

$('closeCompareBtn').onclick = () => clearCompare(true);

$('saveAnalysisBtn').onclick = async () => {
  if (!state.lastResult) {
    alert('请先运行一次分析');
    return;
  }
  try {
    await api('/api/analyses', {
      method: 'POST',
      body: JSON.stringify({
        name: $('analysisName').value || undefined,
        params: state.lastResult.params,
        result: state.lastResult,
      }),
    });
    $('analysisName').value = '';
    await refreshAnalyses();
  } catch (err) {
    alert(`保存失败：${err.message}`);
  }
};

// ---------- 启动 ----------
(async function init() {
  try {
    await Promise.all([refreshZones(), refreshAnalyses()]);
  } catch (err) {
    console.error('初始化失败', err);
  }
})();
