/**
 * 全国景点数据构建
 *
 * 数据来源：
 *   1. Wikidata（CC0）——有中文维基百科条目的景点类实体，含坐标、类别
 *      https://query.wikidata.org/
 *   2. OpenStreetMap（ODbL）——tools/extract-osm-pbf.mjs 从 Geofabrik 全量 PBF 里提取的 tourism=* POI
 *   3. data-src/curated.json —— 人工核对的景点（含介绍文字）
 *
 * 归属判定：用本项目的真实区县边界做 point-in-polygon，
 * 而不是照抄数据源自带的行政区字段，保证"景点落在哪个区"与地图上看到的一致。
 *
 * 输出：
 *   public/data/attractions/{省adcode}.json   该省景点明细
 *   public/data/attractions/summary.json      各省 / 各区县景点数量
 *
 * 用法：node tools/build-attractions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGeoIndex } from './lib/geo-index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GEO_DIR = path.join(ROOT, 'public', 'geo');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'attractions');
const CURATED = path.join(ROOT, 'data-src', 'curated.json');

/* ------------------------------ 行政区索引 ------------------------------ */

const geo = createGeoIndex(GEO_DIR);
const { nodes, chainOf, locate } = geo;
console.log(`参与归属判定的最细一级行政区：${geo.polygonCount} 个`);

/* ------------------------------ 类别映射 ------------------------------ */

const CLASS_MAP = {
  Q33506: '博物馆',
  Q22698: '园林公园',
  Q8502: '自然风光',
  Q23397: '自然风光',
  Q839954: '历史文化',
  Q16970: '历史文化',
  Q44539: '历史文化',
  Q23413: '历史文化',
  Q570116: null,
  Q1674170: null,
  Q1049203: null,
  Q1134590: null,
  Q15848826: '自然风光',
  Q2087181: '自然风光',
};

const CLASS_PRIORITY = {
  Q33506: 6, Q1134590: 7, Q570116: 7, Q839954: 5, Q16970: 5, Q44539: 5,
  Q22698: 4, Q8502: 3, Q23397: 3, Q23413: 4, Q1049203: 6, Q1674170: 5,
};

const KEYWORD_RULES = [
  { re: /博物馆|纪念馆|美术馆|展览馆|科技馆|艺术馆|陈列馆/, category: '博物馆' },
  { re: /植物园|动物园|公园|园林|花园|湿地公园/, category: '园林公园' },
  { re: /寺|庙|宫|塔|古镇|古城|遗址|陵|祠|石窟|城墙|故居|书院|教堂|关隘|楼阁/, category: '历史文化' },
  { re: /湖|山|峰|峡|江|河|瀑布|洞|岛|湿地|森林|草原|冰川|沙滩|温泉|沟|池|泉/, category: '自然风光' },
];

function categorize(name, classQid) {
  const mapped = CLASS_MAP[classQid];
  if (mapped) return mapped;
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(name)) return rule.category;
  }
  return '历史文化';
}

/* ------------------------------ 抓取 Wikidata ------------------------------ */

const SPARQL = `
SELECT DISTINCT ?item ?itemLabel ?coord ?cls WHERE {
  VALUES ?cls { wd:Q570116 wd:Q33506 wd:Q22698 wd:Q8502 wd:Q23397 wd:Q839954 wd:Q23413 wd:Q16970 wd:Q44539 wd:Q1674170 wd:Q1049203 wd:Q1134590 wd:Q15848826 wd:Q2087181 }
  ?item wdt:P31 ?cls ; wdt:P625 ?coord ; wdt:P17 wd:Q148 .
  ?article schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
}`;

async function fetchWikidata() {
  const cacheFile = path.join(ROOT, 'tmpdata', 'wikidata-attractions.json');
  if (fs.existsSync(cacheFile)) {
    console.log('使用缓存的 Wikidata 数据');
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  console.log('请求 Wikidata…');
  const res = await fetch('https://query.wikidata.org/sparql?format=json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'User-Agent': 'ChinaScenicMapPoC/1.0 (educational demo)',
    },
    body: new URLSearchParams({ query: SPARQL }),
  });
  if (!res.ok) throw new Error(`Wikidata 请求失败: HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.results.bindings;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(rows));
  return rows;
}

const rows = await fetchWikidata();
console.log(`Wikidata 返回 ${rows.length} 行`);

/* ------------------------------ 生成景点 ------------------------------ */

/** 去掉地址开头重复的行政区名（"杭州市西湖区灵隐路" → "灵隐路"） */
function stripAdminPrefix(address, names) {
  let out = (address ?? '').trim();
  for (const name of names) {
    if (name && out.startsWith(name)) out = out.slice(name.length);
  }
  return out.trim();
}

const curated = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
const curatedByName = new Map(curated.map((item) => [item.name, item]));

const byQid = new Map();
for (const row of rows) {
  const qid = row.item.value.split('/').pop();
  const coord = row.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
  if (!coord) continue;
  const lng = Number(coord[1]);
  const lat = Number(coord[2]);
  const cls = row.cls.value.split('/').pop();
  const name = (row.itemLabel?.value ?? '').trim();

  const existing = byQid.get(qid);
  if (existing) {
    // 同一实体可能命中多个类别，保留更"像景点"的那个
    if ((CLASS_PRIORITY[cls] ?? 0) > (CLASS_PRIORITY[existing.cls] ?? 0)) existing.cls = cls;
    continue;
  }
  byQid.set(qid, { qid, name, lng, lat, cls });
}
console.log(`去重后 ${byQid.size} 个实体`);

/** 明显不是景点、或对游客无意义的 POI 名称（酒店、停车场、出入口等） */
const NOISE_PATTERN =
  /酒店|宾馆|饭店|餐厅|客栈|民宿|公寓|停车场|售票|出入口|游客中心|服务中心|管理处|管委会|派出所|公共厕所|垃圾|工地|小区|写字楼|办公|银行|加油站|收费站|服务区|医院|学校$|幼儿园|小学|中学/;

const items = [];
const usedDistricts = new Map();
let outside = 0;
let badName = 0;

for (const entry of byQid.values()) {
  const name = entry.name;
  if (!name || name.length < 2 || name.length > 32) {
    badName += 1;
    continue;
  }
  if (NOISE_PATTERN.test(name)) {
    badName += 1;
    continue;
  }
  if (/^[A-Za-z0-9\s.,'()-]+$/.test(name)) {
    // 只有外文名的条目对中文用户价值低，跳过
    badName += 1;
    continue;
  }
  const districtAdcode = locate(entry.lng, entry.lat);
  if (!districtAdcode) {
    outside += 1;
    continue;
  }

  const chain = chainOf(districtAdcode);
  // chain = [全国, 省, 市?, 区县]，省要从下标 1 取
  const provinceNode = nodes.get(chain[1] ?? chain[0]);
  const districtNode = nodes.get(districtAdcode);
  const cityNode = chain.length > 2 ? nodes.get(chain[chain.length - 2]) : null;
  const category = categorize(name, entry.cls);
  const curatedMatch = curatedByName.get(name);

  const item = {
    id: curatedMatch?.id ?? `wd-${entry.qid.toLowerCase()}`,
    name,
    province: provinceNode?.name ?? '',
    city: cityNode?.name ?? provinceNode?.name ?? '',
    district: districtNode?.name ?? '',
    districtAdcode,
    path: chain.slice(1), // 去掉全国层级
    category: curatedMatch?.category ?? category,
    summary:
      curatedMatch?.summary ??
      `${districtNode?.name ?? ''}的${curatedMatch?.category ?? category}类景点，自动收录自 Wikidata。`,
    description: curatedMatch?.description ?? '',
    image: '',
    address: curatedMatch
      ? stripAdminPrefix(curatedMatch.address, [provinceNode?.name, cityNode?.name, districtNode?.name])
      : '',
    latitude: curatedMatch ? curatedMatch.latitude : Number(entry.lat.toFixed(5)),
    longitude: curatedMatch ? curatedMatch.longitude : Number(entry.lng.toFixed(5)),
    coordSource: curatedMatch
      ? curatedMatch.coordSource
      : 'Wikidata P625 坐标（WGS-84），未逐点人工复核',
    source: curatedMatch?.source ?? {
      label: 'Wikidata',
      url: `https://www.wikidata.org/wiki/${entry.qid}`,
    },
    adminNote: curatedMatch?.adminNote ?? undefined,
    origin: curatedMatch ? 'curated' : 'osm',
    rank: (curatedMatch ? 100 : 0) + (CLASS_PRIORITY[entry.cls] ?? 0),
  };
  items.push(item);
  usedDistricts.set(districtAdcode, (usedDistricts.get(districtAdcode) ?? 0) + 1);
}

/** 补充：人工数据里没有被 Wikidata 命中的条目直接加入 */
const wikidataNames = new Set(items.map((item) => item.name));
let curatedOnly = 0;
for (const entry of curated) {
  if (wikidataNames.has(entry.name)) continue;
  const chain = chainOf(entry.districtAdcode);
  if (!chain.length) continue;
  items.push({
    id: entry.id,
    name: entry.name,
    province: nodes.get(chain[1] ?? chain[0])?.name ?? '',
    city: chain.length > 2 ? nodes.get(chain[chain.length - 2])?.name ?? '' : nodes.get(chain[1] ?? chain[0])?.name ?? '',
    district: nodes.get(chain[chain.length - 1])?.name ?? '',
    districtAdcode: entry.districtAdcode,
    path: chain.slice(1),
    category: entry.category,
    summary: entry.summary,
    description: entry.description,
    image: '',
    address: stripAdminPrefix(entry.address, [
      nodes.get(chain[1] ?? chain[0])?.name,
      chain.length > 2 ? nodes.get(chain[chain.length - 2])?.name : '',
      nodes.get(chain[chain.length - 1])?.name,
    ]),
    latitude: entry.latitude,
    longitude: entry.longitude,
    coordSource: entry.coordSource,
    source: entry.source,
    adminNote: entry.adminNote ?? undefined,
    origin: 'curated',
    rank: 100,
  });
  curatedOnly += 1;
}

console.log(`落界成功 ${items.length} 个（其中人工补充 ${curatedOnly}），落空 ${outside}，名称过滤 ${badName}`);

/* ---------------------- 合并 OpenStreetMap 补充数据 ---------------------- */

const OSM_FILE = path.join(ROOT, 'data-src', 'osm-attractions.json');
let osmAdded = 0;
let osmSkipped = 0;

if (fs.existsSync(OSM_FILE)) {
  const osmItems = JSON.parse(fs.readFileSync(OSM_FILE, 'utf8'));

  /** 名称归一：去掉常见后缀差异，避免「西湖」与「西湖风景区」重复收录 */
  const normalizeName = (name) =>
    name
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/(风景区|景区|旅游区|游览区|公园|博物馆|纪念馆)$/g, '')
      .replace(/\s+/g, '')
      .trim();

  // 已有条目的空间索引：同名的近似位置视为同一个地方
  const CELL_S = 0.02;
  const occupied = new Map();
  const pushCell = (lng, lat, name) => {
    const key = `${Math.floor(lng / CELL_S)},${Math.floor(lat / CELL_S)}`;
    const list = occupied.get(key) ?? [];
    list.push({ lng, lat, name });
    occupied.set(key, list);
  };
  for (const item of items) pushCell(item.longitude, item.latitude, normalizeName(item.name));

  const isDuplicate = (lng, lat, name) => {
    const cx = Math.floor(lng / CELL_S);
    const cy = Math.floor(lat / CELL_S);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of occupied.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (other.name !== name) continue;
          const dLng = (other.lng - lng) * 111 * Math.cos((lat * Math.PI) / 180);
          const dLat = (other.lat - lat) * 111;
          if (Math.hypot(dLng, dLat) < 2) return true; // 2km 内同名视为同一景点
        }
      }
    }
    return false;
  };

  function categorizeOsm(entry) {
    if (entry.tourism === 'museum' || entry.tourism === 'gallery') return '博物馆';
    if (entry.tourism === 'zoo' || entry.tourism === 'theme_park' || entry.tourism === 'aquarium') return '园林公园';
    for (const rule of KEYWORD_RULES) {
      if (rule.re.test(entry.name)) return rule.category;
    }
    if (entry.historic) return '历史文化';
    return '自然风光';
  }

  for (const entry of osmItems) {
    const districtAdcode = locate(entry.lng, entry.lat);
    if (!districtAdcode) { osmSkipped += 1; continue; }
    const norm = normalizeName(entry.name);
    if (norm.length < 2) { osmSkipped += 1; continue; }
    if (isDuplicate(entry.lng, entry.lat, norm)) { osmSkipped += 1; continue; }

    const chain = chainOf(districtAdcode);
    const provinceNode = nodes.get(chain[1] ?? chain[0]);
    const cityNode = chain.length > 2 ? nodes.get(chain[chain.length - 2]) : null;
    const districtNode = nodes.get(districtAdcode);
    const category = categorizeOsm(entry);
    const famous = Boolean(entry.wikidata || entry.wikipedia);

    items.push({
      id: `osm-${entry.osm.replace('/', '-')}`,
      name: entry.name,
      province: provinceNode?.name ?? '',
      city: cityNode?.name ?? provinceNode?.name ?? '',
      district: districtNode?.name ?? '',
      districtAdcode,
      path: chain.slice(1),
      category,
      summary: `${districtNode?.name ?? ''}的${category}类景点，自动收录自 OpenStreetMap。`,
      description: '',
      image: '',
      address: '',
      latitude: entry.lat,
      longitude: entry.lng,
      coordSource: 'OpenStreetMap 坐标（WGS-84），未逐点人工复核',
      source: {
        label: 'OpenStreetMap',
        url: `https://www.openstreetmap.org/${entry.osm}`,
      },
      origin: 'osm',
      rank: (famous ? 30 : 0) + (entry.tourism === 'museum' ? 26 : entry.tourism === 'attraction' ? 12 : 16),
    });
    pushCell(entry.lng, entry.lat, norm);
    osmAdded += 1;
  }
  console.log(`OpenStreetMap 补充 ${osmAdded} 个（跳过重复/落界失败 ${osmSkipped}）`);
} else {
  console.log('未找到 data-src/osm-attractions.json，跳过 OSM 补充（先运行 npm run data:osm）');
}


/* ------------------- 合并省级 A 级景区名录（权威名册） ------------------- */

/**
 * 数据来自 data-src/a-level/provincial.json：
 * 各省文旅厅发布的《XX省A级旅游景区名录表》，是官方名册，
 * 含景区名称 + 所在市/区县 + 等级，但没有坐标。
 *
 * 处理原则：
 *   1. 同区县里能对上同名点位的（OSM 里已有的），只补等级，坐标不动；
 *   2. 对不上的，新增点位，坐标落在区县代表点，并在 coordSource 里写明是示意位置；
 *   3. 名称匹配只在同区县 / 同市范围内做，避免跨市同名（「西湖」在建德也有）。
 */
const PROVINCIAL = path.join(ROOT, 'data-src', 'a-level', 'provincial.json');
let provMatched = 0;
let provAdded = 0;
let provNoCenter = 0;

/** 景区名归一：去括号备注、去行政区词、去「景区/旅游区」后缀 */
function normScenicName(name) {
  return String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(特别行政区|自治区|自治州|地区)/g, '')
    .replace(/(国家|中国|世界)/g, '')
    .replace(/(旅游景区|风景名胜区|旅游度假区|旅游度假区|旅游区|风景区|景区|度假区|游览区)$/g, '')
    .replace(/[\s　·・．.\-—_]/g, '')
    .trim();
}

if (fs.existsSync(PROVINCIAL)) {
  const records = JSON.parse(fs.readFileSync(PROVINCIAL, 'utf8'));

  const byDistrict = new Map();
  const byCity = new Map();
  for (const item of items) {
    const l = byDistrict.get(item.districtAdcode) ?? [];
    l.push(item);
    byDistrict.set(item.districtAdcode, l);

    // 市级索引：名录里不少条目只标到「市辖区」，靠区县根本对不上
    // path 形如 [省, 市] 或 [省, 市, 区县]，两种情况市都在第 2 位
    const cityAdcode = item.path.length >= 2 ? item.path[1] : null;
    if (cityAdcode) {
      const cl = byCity.get(cityAdcode) ?? [];
      cl.push(item);
      byCity.set(cityAdcode, cl);
    }
  }

  /** 名称相似：完全一致最强，一方包含另一方（至少 3 字）次之 */
  function nameMatch(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 3;
    const [shortName, longName] = a.length <= b.length ? [a, b] : [b, a];
    // 「西湖」这种 2 字名在同一个区县内是安全的（跨区同名才危险，而这里的池子就是同区县）
    if (shortName.length < 2) return 0;
    if (!longName.includes(shortName)) return 0;
    if (shortName.length / longName.length < 0.5) return 0;
    return 2;
  }

  const usedIds = new Set();

  for (const record of records) {
    const core = normScenicName(record.name);
    if (!core) continue;

    let best = null;
    let bestScore = 0;
    // 第一轮：同区县，只要求名称相似
    for (const item of byDistrict.get(record.districtAdcode) ?? []) {
      if (usedIds.has(item.id) || item.level) continue;
      const score = nameMatch(core, normScenicName(item.name));
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    /**
     * 第二轮：名录里只标到「市辖区」的记录，扩大到同市范围找。
     * 这里允许包含关系，但要求最优候选人唯一——「杭州西湖景区」能对上「西湖」，
     * 而如果同市里有好几个都沾边的，就宁可放弃也不猜。
     */
    if (!best && !record.district) {
      const cityAdcode = record.path.length >= 2 ? record.path[record.path.length - 1] : record.path[0];
      let topScore = 0;
      let top = [];
      for (const item of byCity.get(cityAdcode) ?? []) {
        if (usedIds.has(item.id) || item.level) continue;
        const score = nameMatch(core, normScenicName(item.name));
        if (score > topScore) {
          topScore = score;
          top = [item];
        } else if (score === topScore && score > 0) {
          top.push(item);
        }
      }
      if (topScore >= 2 && top.length === 1) {
        best = top[0];
        bestScore = topScore;
      }
    }

    if (best) {
      best.level = record.level;
      best.levelSource = `《${record.sourceTitle}》`;
      best.rank = Math.max(best.rank ?? 0, 96);
      usedIds.add(best.id);
      provMatched += 1;
      continue;
    }

    // 新增点位：坐标用区县代表点，按名字做个确定性微偏移，避免同区县的点完全重叠
    const center = geo.centerOf(record.districtAdcode);
    if (!center) {
      provNoCenter += 1;
      continue;
    }
    let hash = 0;
    for (const ch of record.name) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
    const angle = ((hash % 360) * Math.PI) / 180;
    const radius = 0.006 + ((hash % 17) / 17) * 0.012;
    const lat = Number((center[1] + Math.sin(angle) * radius).toFixed(5));
    const lng = Number((center[0] + Math.cos(angle) * radius).toFixed(5));

    const provinceNode = nodes.get(record.path[0]);
    const cityNode = record.path.length >= 2 ? nodes.get(record.path[1]) : null;
    const districtNode = record.path.length >= 3 ? nodes.get(record.path[2]) : null;

    const item = {
      id: `al-${record.districtAdcode}-${hash}`,
      name: record.name,
      province: provinceNode?.name ?? record.province,
      city: record.district ? (cityNode?.name ?? '') : (districtNode ? (cityNode?.name ?? '') : (cityNode?.name ?? '')),
      district: districtNode?.name ?? '',
      districtAdcode: record.districtAdcode,
      path: record.path,
      category: KEYWORD_RULES.find((rule) => rule.re.test(record.name))?.category ?? '自然风光',
      summary: `国家${record.level}级旅游景区，位于${districtNode?.name ?? cityNode?.name ?? record.province}。`,
      description: '',
      image: '',
      address: '',
      latitude: lat,
      longitude: lng,
      coordSource: '省级名录未提供坐标，此处为所在区县示意位置',
      source: {
        label: '省级 A 级旅游景区名录',
        url: record.sourceUrl,
        license: '各省文化和旅游厅公开发布的名录',
        note: record.sourceTitle,
      },
      origin: 'a-level',
      level: record.level,
      levelSource: `《${record.sourceTitle}》`,
      rank: 90,
    };
    items.push(item);
    byDistrict.get(record.districtAdcode)?.push(item) ?? byDistrict.set(record.districtAdcode, [item]);
    usedIds.add(item.id);
    provAdded += 1;
  }

  console.log(`省级名录：${records.length} 条中，为已有景点补等级 ${provMatched} 个，新增点位 ${provAdded} 个，无区县代表点跳过 ${provNoCenter} 个`);
} else {
  console.log('未找到 data-src/a-level/provincial.json，跳过省级名录（先运行 npm run data:province）');
}

/* ---------------------- 合并 A 级景区名录（等级标注） ---------------------- */

/**
 * 数据来自 data-src/a-level/located.json：
 * 名录（文旅部 5A + 公开 4A 数据集）本身不带可信坐标，
 * 已经由 tools/locate-a-level.mjs 用 OSM 同名地物重新定位，
 * 因此这里的坐标是 OSM 实测坐标，而不是名录里那批错位的数。
 */
const A_LEVEL = path.join(ROOT, 'data-src', 'a-level', 'located.json');
let aLevelMatched = 0;
let aLevelAdded = 0;
let aLevelSkipped = 0;

if (fs.existsSync(A_LEVEL)) {
  const records = JSON.parse(fs.readFileSync(A_LEVEL, 'utf8'));

  const CELL_A = 0.02;
  const gridA = new Map();
  const pushA = (item) => {
    const key = `${Math.floor(item.longitude / CELL_A)},${Math.floor(item.latitude / CELL_A)}`;
    const list = gridA.get(key) ?? [];
    list.push(item);
    gridA.set(key, list);
  };
  for (const item of items) pushA(item);

  /**
   * 名称归一：去掉括号备注与「旅游景区/风景区/景区」等通用后缀，
   * 用来判断「同一个地方的不同叫法」。
   */
  const baseName = (name) =>
    String(name ?? '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/(旅游景区|风景名胜区|旅游度假区|旅游区|风景区|景区|度假区)$/g, '')
      .trim();

  const similarName = (a, b) => {
    const mine = baseName(a);
    const them = baseName(b);
    if (!mine || !them) return false;
    if (mine === them) return true;
    return mine.length >= 3 && them.length >= 3 && (them.includes(mine) || mine.includes(them));
  };

  for (const record of records) {
    // 近距离视为同一个地方：只补等级，不改坐标与来源。
    // 距离近不代表是同一处 —— 一个 5A 景区内部常散落着「太和宫」「秘云洞」这类子景点，
    // 纯靠 400 米会把 5A 贴到它们身上，所以必须同时要求名称相似。
    const cx = Math.floor(record.lng / CELL_A);
    const cy = Math.floor(record.lat / CELL_A);
    let best = null;
    let bestDist = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of gridA.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (other.level) continue;
          if (!similarName(record.name, other.name)) continue;
          const d = Math.hypot(
            (other.longitude - record.lng) * 111 * Math.cos((record.lat * Math.PI) / 180),
            (other.latitude - record.lat) * 111,
          );
          if (d < 0.4 && d < bestDist) {
            best = other;
            bestDist = d;
          }
        }
      }
    }

    // 400 米内没有，再放宽到 2 公里 + 名称相似（同一景区常被标在别的点位名上）
    if (!best) {
      const mine = baseName(record.name);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          for (const other of gridA.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (other.level) continue;
            if (!similarName(record.name, other.name)) continue;
            const d = Math.hypot(
              (other.longitude - record.lng) * 111 * Math.cos((record.lat * Math.PI) / 180),
              (other.latitude - record.lat) * 111,
            );
            if (d < 2 && d < bestDist) {
              best = other;
              bestDist = d;
            }
          }
        }
      }
    }

    if (best) {
      best.level = record.level;
      best.levelSource = record.source.label;
      best.rank = Math.max(best.rank ?? 0, 96);
      aLevelMatched += 1;
      continue;
    }

    // 名称不是"完整同名"的（「杭州西湖」对上了建德那个「西湖」），坐标可能跑偏，
    // 只用来给已有景点补等级，不新增点位 —— 宁可少一个点，也不在图上放错位置
    if (record.match !== 'exact') {
      aLevelSkipped += 1;
      continue;
    }

    const category = KEYWORD_RULES.find((rule) => rule.re.test(record.name))?.category ?? '自然风光';
    const item = {
      id: `a-${record.osm.replace('/', '-')}`,
      name: record.name,
      province: record.province,
      city: record.city,
      district: record.district,
      districtAdcode: record.districtAdcode,
      path: record.path,
      category,
      summary: `国家${record.level}级旅游景区，位于${record.district}。`,
      description: '',
      image: '',
      address: '',
      latitude: record.lat,
      longitude: record.lng,
      coordSource: 'OSM 地物坐标（WGS-84），按名录名称匹配，未逐点复核',
      source: record.source,
      origin: 'a-level',
      level: record.level,
      levelSource: record.levelSource,
      rank: 94,
    };
    items.push(item);
    pushA(item);
    aLevelAdded += 1;
  }
  console.log(`A 级名录：${aLevelMatched} 个已有景点补上等级，新增 ${aLevelAdded} 个 A 级景区点位，${aLevelSkipped} 个坐标不确定未上图`);
} else {
  console.log('未找到 data-src/a-level/located.json，跳过等级标注（先运行 npm run data:alevel）');
}

/* ------------------------------ 去重与限量 ------------------------------ */

const seen = new Set();
const seenIds = new Set();
const deduped = [];
let idCollision = 0;
for (const item of items) {
  const key = `${item.districtAdcode}|${item.name}`;
  if (seen.has(key)) continue;
  // id 是前端列表的 React key，重复会造成列表出现重复/残留节点
  if (seenIds.has(item.id)) {
    idCollision += 1;
    continue;
  }
  seen.add(key);
  seenIds.add(item.id);
  deduped.push(item);
}
if (idCollision) console.log(`剔除 id 重复条目 ${idCollision} 个`);
process.on('exit', () => {
  if (typeof cappedOut !== 'undefined') console.log(`因区县上限裁掉的自动导入点位：${cappedOut} 个`);
});

/**
 * 第二层去重：同一区县里「恭王府」和「恭王府景区」、「故宫博物院」和「故宫」
 * 这类同一实体的不同叫法，精确名称去重拦不住。
 * 归一（去括号备注 + 去「景区/旅游区」等后缀）后相同就合并，保留信息更全的那条。
 */
const normDedupeName = (name) =>
  String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(旅游景区|风景名胜区|旅游度假区|旅游区|风景区|景区|度假区|荣誉墙)$/g, '')
    .replace(/[\s\u3000]+/g, '')
    .trim();

const quality = (x) =>
  (x.level ? Number(String(x.level)[0]) * 100 : 0) +
  (x.origin === 'a-level' ? 20 : 0) +
  (x.coordSource && !/示意/.test(x.coordSource) ? 10 : 0) +
  (x.description ? 2 : 0);

const byNorm = new Map();
let mergedAlias = 0;
for (const item of deduped) {
  const key = `${item.districtAdcode}|${normDedupeName(item.name)}`;
  const prev = byNorm.get(key);
  if (!prev) {
    byNorm.set(key, item);
    continue;
  }
  mergedAlias += 1;
  const winner = quality(item) > quality(prev) ? item : prev;
  const loser = winner === prev ? item : prev;
  // 落选者带着的等级/简介别丢
  if (!winner.level && loser.level) {
    winner.level = loser.level;
    winner.levelSource = loser.levelSource;
  }
  if (!winner.summary && loser.summary) winner.summary = loser.summary;
  byNorm.set(key, winner);
}
if (mergedAlias) console.log(`合并同名异写（恭王府/恭王府景区）${mergedAlias} 个`);
const mergedItems = (() => {
  /**
   * 第二层半去重：同一区县里「太姥山」和「宁德市福鼎太姥山风景区」是同一处 ——
   * 前者是 OSM 的短名，后者是名录的全称。归一后名称仍不相等，前两层都拦不住。
   *
   * 只在「一方是官方名录、另一方是 OSM/Wikidata」且短名 >= 3 字时才合并；
   * 放开到所有来源会把「庐山」并进「庐山西海景区」，那是两个不同的 5A。
   * 合并时保留名录的正式名称与等级，但把 OSM 的实测坐标接过来，
   * 免得知名景区反而退回区县示意位置。
   */
  const buckets = new Map();
  for (const item of byNorm.values()) {
    const key = item.districtAdcode;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const removed = new Set();
  let mergedContain = 0;
  for (const list of buckets.values()) {
    const officials = list.filter((x) => x.origin === 'a-level');
    if (!officials.length) continue;
    for (const official of officials) {
      const longName = normDedupeName(official.name);
      if (longName.length < 4) continue;
      for (const other of list) {
        if (other.origin === 'a-level' || removed.has(other)) continue;
        const shortName = normDedupeName(other.name);
        if (shortName.length < 3 || shortName === longName) continue;
        // 必须是「长名里连着的一段」，不能只是零散共享几个字
        if (!longName.includes(shortName)) continue;
        removed.add(other);
        mergedContain += 1;
        const officialIsApprox = /示意/.test(String(official.coordSource ?? ''));
        const otherIsReal = other.coordSource && !/示意/.test(String(other.coordSource));
        if (officialIsApprox && otherIsReal) {
          official.longitude = other.longitude;
          official.latitude = other.latitude;
          official.coordSource = other.coordSource;
        }
        if (!official.level && other.level) official.level = other.level;
      }
    }
  }
  if (mergedContain) console.log(`合并「简称/全称」同物 ${mergedContain} 个（短名并入官方名录全称）`);
  return [...byNorm.values()].filter((x) => !removed.has(x));
})();

/**
 * 第三层去重：跨区县的同名同物。
 * 故宫被 OSM 落在西城区、名录落在东城区；慕田峪、颐和园也有类似情况，
 * 区县级去重拦不住。这里只在同城、归一名称相同且两点相距 1.5 公里内才合并。
 */
const distKm = (a, b) =>
  Math.hypot(
    (a.longitude - b.longitude) * 111 * Math.cos((a.latitude * Math.PI) / 180),
    (a.latitude - b.latitude) * 111,
  );

const crossBuckets = new Map();
let mergedCross = 0;
const isApprox = (x) => /示意/.test(String(x.coordSource ?? ''));
for (const item of mergedItems) {
  // 直辖市没有市级节点（path 只有 [省, 区]），此时用省级当城市键
  const cityCode = (item.path?.length ?? 0) >= 3 ? item.path[1] : item.path?.[0];
  const key = `${cityCode}|${normDedupeName(item.name)}`;
  const list = crossBuckets.get(key) ?? [];
  // 名录点位是「区县代表点 + 微偏移」，本身就偏几百米到几公里；
  // 只要有一方是示意坐标，就把判定半径放宽，否则故宫这类会被判成两处
  const near = list.find((x) => {
    const d = distKm(x, item);
    return d < (isApprox(x) || isApprox(item) ? 5 : 1.5);
  });
  if (!near) {
    list.push(item);
    crossBuckets.set(key, list);
    continue;
  }
  mergedCross += 1;
  const winner = quality(item) > quality(near) ? item : near;
  const loser = winner === near ? item : near;
  if (!winner.level && loser.level) {
    winner.level = loser.level;
    winner.levelSource = loser.levelSource;
  }
  const slot = list.indexOf(near);
  list[slot] = winner;
}
if (mergedCross) console.log(`合并跨区县同名同物 ${mergedCross} 个`);
const finalCandidates = [...crossBuckets.values()].flat();

/**
 * 单个区县最多保留的自动导入景点数，避免市中心区县被同质 POI 占满。
 * A 级景区来自官方名录，属于"确有其物"的实体，不受这个上限约束。
 */
const PER_DISTRICT_CAP = 30;
const grouped = new Map();
for (const item of finalCandidates) {
  const list = grouped.get(item.districtAdcode) ?? [];
  list.push(item);
  grouped.set(item.districtAdcode, list);
}
const finalItems = [];
let cappedOut = 0;
for (const list of grouped.values()) {
  list.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, 'zh'));
  const official = list.filter((i) => i.level || i.origin === 'curated');
  const others = list.filter((i) => !i.level && i.origin !== 'curated');
  const keepOthers = others.slice(0, Math.max(0, PER_DISTRICT_CAP - official.length));
  cappedOut += others.length - keepOthers.length;
  finalItems.push(...official, ...keepOthers);
}

/* ------------------- 合并百科简介 / 游玩攻略（data-src/enrich） ------------------- */

/**
 * 两类补充内容，都来自公开页面，和名录数据分开存放：
 *   enrich/baike.json  —— 百度百科词条摘要 + 信息卡（门票 / 开放时间 / 建议游玩时长）
 *   enrich/guides.json —— 百度搜索结果里的 AI 游玩攻略（结构化小节）
 * 匹配按「省 + 归一化名称」，因为百科词条名与名录里的写法常有「XX市YY景区」这类差异。
 */
const ENRICH_DIR = path.join(ROOT, 'data-src', 'enrich');
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

const matchKey = (name) =>
  String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(旅游景区|风景名胜区|旅游度假区|旅游区|风景区|景区|度假区|游览区)$/g, '')
    .replace(/[\s　·・．.\-—_]/g, '')
    .trim();

/** 剥掉名字前面的行政区链：「浙江省温州市乐清市雁荡山」→「雁荡山」 */
function stripAdminChain(name) {
  let out = String(name ?? '');
  for (let i = 0; i < 4; i++) {
    const m = out.match(/^([\u4e00-\u9fa5]{2,8}?(?:省|自治区|特别行政区|市|自治州|地区|盟|县|区|旗|州))/);
    if (!m) break;
    if (out.length - m[1].length < 2) break;
    out = out.slice(m[1].length);
  }
  return out;
}

/** 行政区别名，避免把「市区」「新区」这类通用词当成景点名 */
const ADMIN_WORDS = new Set(['市区', '城区', '郊区', '新区', '地区', '县区', '自治州', '自治区']);

/**
 * 一份补充内容可能对应多个名字写法，所以建两级索引：
 *   exact —— 「省|归一名称」精确命中，优先
 *   loose —— 去掉行政区前缀 / 城市前缀 / 按「·－」拆开后的写法（同名不同地靠省隔离）
 */
/**
 * 名录名带「公园」「博物馆」「国家遗址公园」这类通用尾缀，而地图上显示的是去掉尾缀的名字
 * （名录「天坛公园」↔点位「天坛」）。补内容时这类差异会让整条白丢，所以单独剥一层。
 */
const GENERIC_TAIL = [
  '国家考古遗址公园',
  '考古遗址公园',
  '国家遗址公园',
  '国家城市湿地公园',
  '国家森林公园',
  '国家地质公园',
  '国家湿地公园',
  '国家矿山公园',
  '遗址公园',
  '森林公园',
  '湿地公园',
  '地质公园',
  '海洋公园',
  '博物院',
  '博物馆',
  '纪念馆',
  '美术馆',
  '展览馆',
  '历史文化街区',
  '历史街区',
  '文化街区',
  '街区',
  '古村落',
  '古村',
  '古镇',
  '公园',
  '故里',
];

function stripGenericTail(name) {
  const n = String(name ?? '').replace(/^[*＊·\s]+/, '').trim();
  for (const tail of GENERIC_TAIL) {
    if (n.endsWith(tail) && n.length - tail.length >= 2) return n.slice(0, n.length - tail.length);
  }
  return '';
}

function indexEnrich(store, extras = []) {
  const exact = new Map();
  const loose = new Map();
  for (const [key, value] of Object.entries(store)) {
    const [province, rawName] = key.split('|');
    const prov = value.province ?? province;
    const name = value.name ?? rawName;
    const norm = matchKey(name);
    if (!norm) continue;
    exact.set(`${prov}|${norm}`, value);

    const aliases = new Set();
    const added = (x) => {
      const k = matchKey(x);
      if (k.length >= 2 && !ADMIN_WORDS.has(k)) aliases.add(k);
    };
    added(stripAdminChain(norm));
    added(stripAdminChain(name));
    const city = String(value.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
    if (city.length >= 2 && norm.startsWith(city)) added(norm.slice(city.length));
    for (const part of String(name).split(/[·•、・\-—/]/)) added(part);
    added(stripGenericTail(matchKey(name)));
    for (const extra of extras) {
      for (const seed of extra(value) ?? []) {
        added(seed);
        added(stripAdminChain(seed));
        added(stripGenericTail(matchKey(seed)));
      }
    }
    for (const alias of aliases) {
      const k = `${prov}|${alias}`;
      if (!loose.has(k)) loose.set(k, value);
    }
  }
  return { exact, loose, get(prov, name) {
    const norm = matchKey(name);
    return exact.get(`${prov}|${norm}`) ?? loose.get(`${prov}|${norm}`) ?? null;
  } };
}

/** 按显示名再补一轮的结果（enrich/baike-items.json）优先级高于名录名那一轮 */
const baikeIndex = indexEnrich({
  ...readJson(path.join(ENRICH_DIR, 'baike.json')),
  ...readJson(path.join(ENRICH_DIR, 'baike-items.json')),
});
const guideIndex = indexEnrich(readJson(path.join(ENRICH_DIR, 'guides.json')), [
  // 攻略抓取时用的搜索词（「天坛公园游玩攻略」）往往比名录名更接近地图显示名，拿它当别名
  (value) => [String(value.query ?? '').replace(/攻略$/, '').replace(/(游玩|旅游)$/, '')],
]);

let introAdded = 0;
let summaryUpgraded = 0;
let factAdded = 0;
let guideAdded = 0;

/** 摘要取第一句，超过 60 字就截断（卡片上只放得下一行半） */
/**
 * 卡片上的一句话简介：优先取第一句，但整体压到 30 字以内（抽屉里已有完整介绍，
 * 标题下面再堆三行就重复了），所以先找第一个小句，实在没有再退到第一句。
 */
function firstSentence(text) {
  // 只压中文之间的空白，英文括号注释（Temple of Heaven）里的词距要留着
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .trim();
  if (!clean) return '';
  const clause = clean.match(/^(.{6,30}?)[，。；;]/);
  if (clause) return clause[1];
  const sentence = clean.match(/^(.{10,60}?)[。；;]/);
  if (sentence && sentence[1].length <= 34) return sentence[1];
  return clean.slice(0, 28);
}

/**
 * 卡片上真正显示的一句话简介。
 * 「深圳望野博物馆，位于广东省…」这种开头就是全名的，第一个分句只有 7 个字，
 * 直接拿来当简介等于没写，所以要往后多截一段。
 */
function summaryOf(text) {
  const short = firstSentence(text);
  if (short.length >= 10) return short;
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .trim();
  const m = clean.match(/^(.{10,44}?)[，。；;]/);
  return (m ? m[1] : clean.slice(0, 40)).trim();
}

for (const item of finalItems) {
  const baike = baikeIndex.get(item.province, item.name);
  if (baike && baike.status === 'ok') {
    // 名录自动生成的一句话简介（「国家4A级旅游景区，位于杭州市。」）不算介绍，能改写就改写
    const autoSummary = /自动收录自|省级名录|A 级旅游景区名录|级旅游景区，位于|名录收录/.test(item.summary ?? '');
    if (!item.description) {
      item.description = baike.abstract;
      item.introSource = { label: '百度百科', url: baike.url };
      introAdded += 1;
    }
    if (autoSummary && baike.abstract) {
      const s = summaryOf(baike.abstract);
      if (s.length >= 8) {
        item.summary = s;
        summaryUpgraded += 1;
      }
    }
    if (baike.ticket) item.ticket = baike.ticket;
    if (baike.hours) item.openingHours = baike.hours;
    if (baike.duration) item.bestSeason = baike.duration;
    if (baike.ticket || baike.hours || baike.duration) factAdded += 1;
  }

  const guide = guideIndex.get(item.province, item.name);
  if (guide && guide.status === 'ok' && guide.sections?.length) {
    // 百度卡片尾部常粘着「…游览。2百科」「…06:00-22:00。2官媒」这种引用角标，清一遍再入库
    const tidy = (text) =>
      String(text ?? '')
        .replace(/[0-9]*\s*(百科|官媒|引用|参考资料?|来源)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    item.guide = {
      intro: tidy(guide.intro),
      sections: guide.sections
        .map((s) => ({ title: tidy(s.title), items: (s.items ?? []).map(tidy).filter((x) => x.length >= 2) }))
        .filter((s) => s.items.length),
      sourceUrl: guide.sourceUrl,
      sourceLabel: '百度 AI 摘要',
    };
    guideAdded += 1;
  }
}

console.log(
  `补充百科介绍 ${introAdded} 个 / 改写一句话简介 ${summaryUpgraded} 个 / 门票开放时间 ${factAdded} 个 / 游玩攻略 ${guideAdded} 个`,
);

/* ------------------------------ 写出 ------------------------------ */

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const file of fs.readdirSync(OUT_DIR)) {
  if (file.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, file));
}

const byProvince = new Map();
for (const item of finalItems) {
  const prov = item.path[0];
  const list = byProvince.get(prov) ?? [];
  list.push(item);
  byProvince.set(prov, list);
}

const provinceCounts = {};
const districtCounts = {};
let total = 0;

for (const [provAdcode, list] of byProvince) {
  list.sort((a, b) => a.districtAdcode - b.districtAdcode || b.rank - a.rank);
  const cleaned = list.map(({ rank, ...rest }) => rest); // eslint-disable-line no-unused-vars
  fs.writeFileSync(
    path.join(OUT_DIR, `${provAdcode}.json`),
    JSON.stringify({
      province: nodes.get(provAdcode)?.name ?? '',
      adcode: provAdcode,
      generatedAt: new Date().toISOString().slice(0, 10),
      items: cleaned,
    }),
  );
  provinceCounts[provAdcode] = cleaned.length;
  total += cleaned.length;
  for (const item of cleaned) {
    districtCounts[item.districtAdcode] = (districtCounts[item.districtAdcode] ?? 0) + 1;
  }
}

fs.writeFileSync(
  path.join(OUT_DIR, 'summary.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      total,
      provinces: provinceCounts,
      districts: districtCounts,
      sources: [
        {
          label: 'Wikidata',
          url: 'https://query.wikidata.org/',
          license: 'CC0 1.0',
          note:
            '取有中文维基百科条目的景点类实体（旅游景点/博物馆/公园/山/湖/考古遗址/宗教建筑等），含 P625 坐标。类别由实体类型与名称关键词推断，坐标为 WGS-84，未逐点人工复核。',
        },
        {
          label: 'OpenStreetMap',
          url: 'https://www.openstreetmap.org/',
          license: 'ODbL 1.0',
          note:
            '取自 Geofabrik 的 china-latest.osm.pbf 全量导出，筛 tourism=attraction/museum/gallery/zoo/theme_park/aquarium 且带名称的对象（含 node 与面要素中心点）。类别由标签与名称关键词推断，坐标为 WGS-84，未逐点人工复核。',
        },
        {
          label: 'A 级旅游景区名录',
          url: 'https://chinatopattractions.com/china-attractions-dataset/',
          license: '公开数据集（署名引用）+ 文旅部 5A 名录',
          note:
            '5A 来自文化和旅游部名录，4A 来自公开数据集；两套数据本身坐标不可靠（同省内也有上百公里偏差），已用 OSM 同名地物重新定位，定位成功 548 条，其余暂不上图。',
        },
        {
          label: '人工核对名录',
          url: 'data-src/curated.json',
          license: '项目自有',
          note: '杭州市西湖区 6 个景点，坐标与区划归属已逐条核对，含人工撰写的介绍。',
        },
        {
          label: '百度百科',
          url: 'https://baike.baidu.com/',
          license: '公开网页内容，按词条原文引用并标注出处',
          note: '景点介绍取自百科词条摘要，门票 / 开放时间 / 建议游玩时长取自词条信息卡。仅收录摘要中提及本省 / 本市 / 本区县、可确认是同一地点的词条。内容可能滞后，出行前请以景区公告为准。',
        },
        {
          label: '百度 AI 游玩攻略',
          url: 'https://www.baidu.com/',
          license: '公开搜索结果页的 AI 摘要，仅作参考',
          note: '以「景区名 + 游玩攻略」为关键词，抓取搜索结果页由 AI 生成的结构化攻略（玩法路线 / 门票与开放时间 / 交通与吃住）。仅覆盖部分知名景区，内容由模型根据公开信息生成，未经人工核实。',
        },
        {
          label: '行政区划边界',
          url: 'https://geo.datav.aliyun.com/areas_v3/bound/',
          license: '阿里云 DataV.GeoAtlas 公开数据',
          note: '景点归属由本项目用真实区县边界做 point-in-polygon 计算得出。',
        },
      ],
    },
    null,
    2,
  ),
);

// 名录里只落到「市」的条目，districtAdcode 是市级 adcode，不能算进区县覆盖率
const covered = Object.keys(districtCounts).filter((a) => nodes.get(Number(a))?.levelCode === 3).length;
const cityOnlyNodes = Object.keys(districtCounts).filter((a) => nodes.get(Number(a))?.levelCode !== 3).length;
console.log(`\n===== 景点数据构建完成 =====`);
console.log(
  `景点 ${total} 个，覆盖 ${Object.keys(provinceCounts).length} 个省 / ${covered} 个区县（全国区县 2837 个，覆盖率 ${((covered / 2837) * 100).toFixed(0)}%）`,
);
if (cityOnlyNodes) console.log(`另有 ${cityOnlyNodes} 个市级节点只有「只标到市」的点位（名录未给出区县）`);
console.log(`输出目录 ${OUT_DIR}`);
