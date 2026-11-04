/**
 * 全国行政区划数据构建脚本
 *
 * 输入：阿里云 DataV.GeoAtlas 公开 GeoJSON
 *   https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json   全国省级
 *   https://geo.datav.aliyun.com/areas_v3/bound/{省级adcode}_full.json  该省地级
 *   https://geo.datav.aliyun.com/areas_v3/bound/{地级adcode}_full.json  该市区县
 *
 * 输出：
 *   public/geo/index.json          全部行政区节点（adcode / 名称 / 父级 / 层级）
 *   public/geo/g/{adcode}.json     该行政区的"直接下级"边界集合（用于地图绘制）
 *
 * 设计要点：
 * - 每个视图只需下载一个文件，进入省只拉 ~100KB，进入市只拉 ~40KB
 * - 边界只做 Douglas-Peucker 简化与坐标精度截断，不修改形状
 * - 原始文件缓存到 tmpdata/cn/，重复执行不会重复下载
 *
 * 用法：node tools/build-national.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tmpdata', 'cn');
const OUT = path.join(ROOT, 'public', 'geo');
const GEO_OUT = path.join(OUT, 'g');
const API = 'https://geo.datav.aliyun.com/areas_v3/bound';

/** 各层级简化容差（度）与最小保留环面积（平方度） */
const TOL = {
  country: { tol: 0.012, minRingArea: 0.004 },
  province: { tol: 0.004, minRingArea: 0.0002 },
  city: { tol: 0.0025, minRingArea: 0.00008 },
};

const LEVEL_CODE = { country: 0, province: 1, city: 2, district: 3 };

/* ------------------------------ 几何处理 ------------------------------ */

function sqSegDist(p, a, b) {
  let x = a[0];
  let y = a[1];
  const dx = b[0] - x;
  const dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}

function simplify(points, tol) {
  if (points.length <= 4) return points;
  const sqTol = tol * tol;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxSq) {
        maxSq = d;
        index = i;
      }
    }
    if (maxSq > sqTol && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(s / 2);
}

const round = (v) => Math.round(v * 1e4) / 1e4;

function processRing(ring, tol) {
  const r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  if (r.length < 3) return null;
  const simplified = simplify(r, tol).map((p) => [round(p[0]), round(p[1])]);
  if (simplified.length < 3) return null;
  simplified.push(simplified[0]);
  return simplified;
}

function processGeometry(geom, tol, minRingArea) {
  if (!geom) return null;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const outPolys = [];
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || ringArea(outer) < minRingArea) continue;
    const outerRing = processRing(outer, tol);
    if (!outerRing) continue;
    const rings = [outerRing];
    for (let i = 1; i < poly.length; i++) {
      if (ringArea(poly[i]) < minRingArea / 4) continue;
      const hole = processRing(poly[i], tol);
      if (hole) rings.push(hole);
    }
    outPolys.push(rings);
  }
  if (!outPolys.length) return null;
  return outPolys.length === 1
    ? { type: 'Polygon', coordinates: outPolys[0] }
    : { type: 'MultiPolygon', coordinates: outPolys };
}

function bboxOf(features) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minLng) minLng = c[0];
      if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    } else c.forEach(walk);
  };
  features.forEach((f) => f && walk(f.geometry.coordinates));
  return [round(minLng), round(minLat), round(maxLng), round(maxLat)];
}

/* ------------------------------ 下载 ------------------------------ */

/**
 * 全局节流：DataV 有 IP 级限流（403 denied by rate limit），
 * 因此所有请求串行排队，并保证两次请求之间至少间隔 MIN_INTERVAL。
 */
const MIN_INTERVAL = 400;
let nextSlot = 0;
/** 全局熔断：一旦被限流，所有请求一起等待，避免继续触发 */
let blockedUntil = 0;

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, Math.max(blockedUntil, nextSlot) - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function fetchJson(adcode) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${adcode}_full.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      fs.unlinkSync(file);
    }
  }

  let backoff = 5000;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await throttle();
    try {
      const res = await fetch(`${API}/${adcode}_full.json`, {
        headers: { 'User-Agent': 'ChinaScenicMapPoC/1.0 (geo data build)' },
      });
      // 被限流：全局熔断一段时间后重试
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Math.max(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff,
          15000,
        );
        blockedUntil = Math.max(blockedUntil, Date.now() + wait);
        console.warn(`  限流 ${adcode}，全局暂停 ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, wait));
        backoff = Math.min(backoff * 2, 120000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      fs.writeFileSync(file, text);
      return json;
    } catch (err) {
      if (attempt === 12) throw new Error(`${adcode} 下载失败: ${err.message}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

/** 并发池 */
async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------ 主流程 ------------------------------ */

console.log('读取全国省级边界…');
const countryRaw = await fetchJson(100000);

const nodes = []; // [adcode, name, parentAdcode, levelCode]
const featuresByParent = new Map(); // parentAdcode -> GeoJSON features
const stats = { province: 0, city: 0, district: 0 };
/** 有下级的节点（需要生成 g/{adcode}.json） */
const parents = new Set([100000]);

/**
 * 层级以数据源自带的 level 字段为准，而不是"第几层"。
 * 直辖市（北京/上海/天津/重庆）的下级直接就是 district，
 * 海南/河南/湖北/新疆还有"省直辖县级行政区"，这些都不能按深度判断。
 */
function levelCodeOf(rawLevel) {
  if (rawLevel === 'province') return LEVEL_CODE.province;
  if (rawLevel === 'city') return LEVEL_CODE.city;
  return LEVEL_CODE.district;
}

function addNode(adcode, name, parent, levelCode) {
  nodes.push([adcode, name, parent, levelCode]);
}

addNode(100000, '中国', 0, 0);

/** 把原始 features 转成精简 GeoJSON features */
function buildFeatures(raw, level) {
  const { tol, minRingArea } = TOL[level];
  const out = [];
  for (const f of raw.features) {
    const p = f.properties ?? {};
    if (!p.adcode || !p.name) continue;
    const geometry = processGeometry(f.geometry, tol, minRingArea);
    if (!geometry) continue;
    out.push({
      type: 'Feature',
      properties: {
        adcode: p.adcode,
        name: p.name,
        level: p.level,
        center: p.center ?? p.centroid,
      },
      geometry,
    });
  }
  return out;
}

/**
 * 处理一批下级边界：生成精简 feature、登记节点、返回"还有下级"的节点。
 * level 只决定简化容差，节点层级以数据源自带的 properties.level 为准。
 */
function registerChildren(parentAdcode, raw, toleranceLevel) {
  const feats = buildFeatures(raw, toleranceLevel).filter((f) =>
    /^\d{6}$/.test(String(f.properties.adcode)),
  );
  if (!feats.length) return [];

  const propsByCode = new Map();
  for (const f of raw.features) {
    const p = f.properties;
    if (p?.adcode) propsByCode.set(p.adcode, p);
  }

  featuresByParent.set(parentAdcode, feats);
  parents.add(parentAdcode);

  const next = [];
  for (const f of feats) {
    const p = propsByCode.get(f.properties.adcode) ?? {};
    const levelCode = levelCodeOf(p.level);
    addNode(f.properties.adcode, f.properties.name, parentAdcode, levelCode);
    if ((p.childrenNum ?? 0) > 0 && levelCode !== LEVEL_CODE.district) {
      next.push({ adcode: f.properties.adcode, name: f.properties.name });
    }
  }
  return next;
}

/** 国家层面：省级多边形 */
const provinces = registerChildren(100000, countryRaw, 'country');
stats.province = provinces.length;
console.log(`省级 ${provinces.length} 个要素`);

/** 逐个省份下载下级边界（地级市 / 直辖市下辖区） */
let doneProvince = 0;
const secondLevel = [];
await pool(provinces, 2, async (prov) => {
  let raw;
  try {
    raw = await fetchJson(prov.adcode);
  } catch (err) {
    console.warn(`  ${prov.name} 跳过：${err.message}`);
    return;
  }
  const children = registerChildren(prov.adcode, raw, 'province');
  secondLevel.push(...children);
  doneProvince += 1;
  if (doneProvince % 10 === 0) console.log(`  已完成 ${doneProvince}/${provinces.length} 个省`);
});

console.log(`已处理 ${doneProvince} 个省，待抓取下级 ${secondLevel.length} 个`);

/** 逐个下级单元下载区县边界（无下级的市/直辖县会返回 404，属正常） */
let doneCity = 0;
const cityFailures = [];
await pool(secondLevel, 2, async (node) => {
  let raw;
  try {
    raw = await fetchJson(node.adcode);
  } catch (err) {
    // 该节点其实没有下级（如东莞、中山、儋州），记录下来但不影响结果
    cityFailures.push(`${node.name}(${node.adcode})`);
    return;
  }
  registerChildren(node.adcode, raw, 'city');
  doneCity += 1;
  if (doneCity % 50 === 0) console.log(`  已完成 ${doneCity}/${secondLevel.length} 个下级单元`);
});
console.log(`成功抓取 ${doneCity} 个下级的区县边界，无下级/404 ${cityFailures.length} 个`);

/* ------------------------------ 写出 ------------------------------ */

fs.mkdirSync(GEO_OUT, { recursive: true });
let totalBytes = 0;
for (const [parent, feats] of featuresByParent) {
  const collection = {
    type: 'FeatureCollection',
    metadata: {
      source: '阿里云 DataV.GeoAtlas',
      sourceUrl: `${API}/${parent === 100000 ? '100000' : parent}_full.json`,
      note: '真实行政区划边界，仅做 Douglas-Peucker 简化与坐标精度截断，未改动形状。',
    },
    bbox: bboxOf(feats),
    features: feats,
  };
  const file = path.join(GEO_OUT, `${parent}.json`);
  fs.writeFileSync(file, JSON.stringify(collection));
  totalBytes += fs.statSync(file).size;
}

nodes.sort((a, b) => a[0] - b[0]);
stats.province = nodes.filter((n) => n[3] === LEVEL_CODE.province).length;
stats.city = nodes.filter((n) => n[3] === LEVEL_CODE.city).length;
stats.district = nodes.filter((n) => n[3] === LEVEL_CODE.district).length;
fs.writeFileSync(
  path.join(OUT, 'index.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: '阿里云 DataV.GeoAtlas (https://geo.datav.aliyun.com/areas_v3/bound/)',
    note: 'nodes 格式：[adcode, 名称, 父级adcode, 层级(0国/1省/2市/3区县)]；g/{adcode}.json 为该节点的直接下级边界。',
    counts: { nodes: nodes.length, ...stats, geoFiles: featuresByParent.size },
    nodes,
  }),
);

console.log('\n===== 构建完成 =====');
console.log(`节点 ${nodes.length} 个：省 ${stats.province} / 市 ${stats.city} / 区县 ${stats.district}`);
console.log(`边界文件 ${featuresByParent.size} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`index.json ${(fs.statSync(path.join(OUT, 'index.json')).size / 1024).toFixed(0)} KB`);
