/**
 * 给 A 级景区名录找坐标
 *
 * 背景：市面上的 5A/4A 免费数据集，坐标有相当一部分是错的
 * （实测「湖州市南浔古镇景区」被标到杭州、「宋井桃源景区」被标到成都，
 *  同省校验都过不了的行有 99 条，同省内偏出上百公里的更多），不能直接上图。
 * 官方名录则通常只给省/市/县，不给坐标。
 *
 * 做法：拿名录里的**名称**去 OSM 全量数据里找同名地物，用 OSM 的坐标。
 * 关键点是不能只找 tourism=*：世纪公园这类在 OSM 里是 leisure=park，
 * 古镇是 historic=*，保护区是 boundary=protected_area，所以这里放开标签限制，
 * 只按名称命中，再按"落在中国境内 + 行政归属自洽"过滤。
 *
 * 输入：data-src/a-level/records.json（含名称，坐标不可信）
 *       tmpdata/osm/china-latest.osm.pbf
 * 输出：data-src/a-level/located.json（含可信坐标与区县）
 *
 * 用法：node tools/locate-a-level.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import parse from 'osm-pbf-parser';
import { createGeoIndex } from './lib/geo-index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GEO_DIR = path.join(ROOT, 'public', 'geo');
const PBF = path.join(ROOT, 'tmpdata', 'osm', 'china-latest.osm.pbf');
const RECORDS = path.join(ROOT, 'data-src', 'a-level', 'records.json');
const OUT = path.join(ROOT, 'data-src', 'a-level', 'located.json');

if (!fs.existsSync(PBF)) {
  console.error(`缺少 ${PBF}，请先运行 npm run data:pbf:download`);
  process.exit(1);
}

const geo = createGeoIndex(GEO_DIR);
const { nodes, chainOf, locate } = geo;

/** 归一化：去括号、去景区后缀、去行政区词与标点 */
function normalize(text) {
  return String(text)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(特别行政区|自治区|自治州|地区|城市|市|省|县)/g, '')
    .replace(/(旅游景区|风景名胜区|旅游度假区|旅游区|风景区|景区|度假区|游览区)$/g, '')
    .replace(/[·、\-\s]/g, '')
    .trim();
}

/**
 * 名录名 → 两个 key：
 *   full     —— 完整归一化（"杭州西湖"）
 *   stripped —— 再剥掉省市县前缀（"西湖"），用来对上 OSM 里更短的名字
 *
 * 但剥前缀有个坑：「海南省博物馆」剥完只剩「博物馆」，
 * 会和「湖北省博物馆」撞成一个 key。所以 stripped 只在"必须同区县"的条件下才参与匹配。
 */
function coreName(name, prefixes = []) {
  const base = String(name).replace(/[（(][^）)]*[）)]/g, '');
  const full = normalize(base);
  let trimmed = base;
  for (const prefix of prefixes) {
    if (prefix && trimmed.startsWith(prefix)) trimmed = trimmed.slice(prefix.length);
  }
  const stripped = normalize(trimmed);

  // 名录里常出现「杭州市杭州西湖风景区」这种地名重复，再剥几轮行政区词才能露出真正的景区名
  const tokens = prefixes
    .flatMap((prefix) => [prefix, prefix.replace(/(省|市|区|县|自治州|地区)$/, '')])
    .filter((token) => token && token.length >= 2)
    .sort((a, b) => b.length - a.length);
  let minimal = trimmed;
  for (let round = 0; round < 4; round++) {
    const hit = tokens.find((token) => minimal.startsWith(token));
    if (!hit) break;
    minimal = minimal.slice(hit.length);
  }
  const minimalCore = normalize(minimal);

  return {
    full,
    stripped: stripped !== full ? stripped : '',
    minimal: minimalCore && minimalCore !== stripped && minimalCore !== full ? minimalCore : '',
  };
}

const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));
const wanted = []; // { record, full, stripped }
const acceptable = new Set();
for (const record of records) {
  const { full, stripped, minimal } = coreName(record.name, [record.province, record.city, record.district]);
  if (full.length < 2) continue;
  wanted.push({ record, full, stripped, minimal });
  // OSM 里的名字往往更短（"西湖" vs "杭州西湖风景区"），把子串也纳入第一遍的命中集合
  for (const key of [full, stripped, minimal]) {
    if (!key) continue;
    for (let i = 0; i < key.length; i++) {
      for (let len = 2; len <= key.length - i; len++) acceptable.add(key.slice(i, i + len));
    }
  }
}
console.log(`待定位 A 级景区 ${records.length} 条，可比对名称片段 ${acceptable.size} 个`);

/* ------------------------------ 第一遍：找同名地物 ------------------------------ */

const targets = new Map(); // `type/id` -> { type, id, name, tags, refs }
const neededNodes = new Set();

await pipeline(
  fs.createReadStream(PBF),
  parse(),
  async function* (source) {
    for await (const batch of source) {
      for (const item of batch) {
        const tags = item.tags;
        const raw = tags?.name;
        if (!raw) continue;
        if (!/[\u4e00-\u9fa5]/.test(raw)) continue;
        const core = normalize(raw);
        if (!acceptable.has(core)) continue;
        // 旅行社、商店、公司之类同名地物会把坐标带偏
        if (tags.shop || tags.office || tags.company || tags.craft) continue;
        if (tags.amenity && !['museum', 'arts_centre', 'theatre', 'place_of_worship'].includes(tags.amenity)) continue;
        const entry = { type: item.type, id: item.id, name: raw, core, tags, refs: item.refs ?? null };
        targets.set(`${item.type}/${item.id}`, entry);
        if (item.type === 'node') neededNodes.add(item.id);
        else for (const ref of entry.refs ?? []) neededNodes.add(ref);
      }
    }
  },
);
console.log(`名称命中 OSM 地物 ${targets.size} 个，需取 ${neededNodes.size} 个节点坐标`);

/* ------------------------------ 第二遍：取坐标 ------------------------------ */

const coords = new Map();

await pipeline(
  fs.createReadStream(PBF),
  parse(),
  async function* (source) {
    for await (const batch of source) {
      for (const item of batch) {
        if (item.type !== 'node') continue;
        if (!neededNodes.has(item.id)) continue;
        coords.set(item.id, [item.lon, item.lat]);
      }
    }
  },
);
console.log(`取得节点坐标 ${coords.size} 个`);

/* ------------------------------ 候选归并 ------------------------------ */

const candidates = new Map(); // core -> [{ lat, lng, districtAdcode, name, osm }]
for (const entry of targets.values()) {
  let lat;
  let lng;
  if (entry.type === 'node') {
    const c = coords.get(entry.id);
    if (!c) continue;
    [lng, lat] = c;
  } else {
    const pts = (entry.refs ?? []).map((ref) => coords.get(ref)).filter(Boolean);
    if (!pts.length) continue;
    lng = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
    lat = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  }
  const districtAdcode = locate(lng, lat);
  if (!districtAdcode) continue;
  const list = candidates.get(entry.core) ?? [];
  list.push({
    name: entry.name,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    districtAdcode,
    osm: `${entry.type}/${entry.id}`,
    tourism: entry.tags.tourism ?? '',
    leisure: entry.tags.leisure ?? '',
    historic: entry.tags.historic ?? '',
    natural: entry.tags.natural ?? '',
    wikidata: entry.tags.wikidata ?? '',
    // 行政区、地名节点（「西双版纳」这类）不能当景区坐标用
    isAdmin:
      entry.tags.boundary === 'administrative' ||
      entry.tags.admin_level !== undefined ||
      entry.tags.place !== undefined,
  });
  candidates.set(entry.core, list);
}

/* ------------------------------ 挑选与落库 ------------------------------ */

const located = [];
const unresolved = [];
const reasons = {
  noCandidate: 0,
  province: 0,
  ambiguous: 0,
  district: 0,
  samples: { noCandidate: [], province: [], ambiguous: [], district: [] },
};

/**
 * 名称相似判定：完全同名最强；一方包含另一方时，要求被包含的部分至少 3 字、
 * 且不短于较长者的 60%，避免「居庸关长城」被「长城」这种通名带跑
 */
function similarity(a, b) {
  if (a === b) return 3;
  const [shortName, longName] = a.length <= b.length ? [a, b] : [b, a];
  if (shortName.length < 3) return 0;
  if (!longName.includes(shortName)) return 0;
  if (shortName.length / longName.length < 0.6) return 0;
  return 2;
}

/**
 * 找出与某条名录记录足够相似的 OSM 候选。
 * sim=3 完全同名（full 或 stripped 两种 key 都算，但 stripped 会标记 weak）；
 * sim=2 为包含关系，只在"同区县"时才会被采用。
 */
function poolFor(full, weakKeys) {
  const out = [];
  const seen = new Set();
  const push = (list, sim, weak = false) => {
    for (const c of list) {
      const key = `${c.osm}|${sim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, sim, weak });
    }
  };

  const own = candidates.get(full);
  if (own) push(own, 3);
  // 剥掉省市前缀后的名字唯一性差，只算"弱精确"，还要过省份校验
  for (const key of weakKeys) {
    if (key === full) continue;
    const short = candidates.get(key);
    if (short) push(short, 3, true);
  }

  for (const [key, list] of candidates) {
    if (key === full || weakKeys.includes(key)) continue;
    const sim = similarity(full, key);
    if (!sim) continue;
    push(list, sim, true);
  }
  return out;
}

/**
 * 名录里的省/市/区县是拿数据集那批错坐标反推出来的（「北京北海公园」被标成海淀区、
 * 「克拉玛依世纪公园」被标到达坂城区），不能当硬条件用。
 * 唯一相对可靠的是数据集自带的省份字段 provinceEn，这里以它为准。
 */
const EN_PROVINCE = {
  Beijing: '北京市', Tianjin: '天津市', Hebei: '河北省', Shanxi: '山西省', 'Inner Mongolia': '内蒙古自治区',
  Liaoning: '辽宁省', Jilin: '吉林省', Heilongjiang: '黑龙江省', Shanghai: '上海市', Jiangsu: '江苏省',
  Zhejiang: '浙江省', Anhui: '安徽省', Fujian: '福建省', Jiangxi: '江西省', Shandong: '山东省', Henan: '河南省',
  Hubei: '湖北省', Hunan: '湖南省', Guangdong: '广东省', Guangxi: '广西壮族自治区', Hainan: '海南省',
  Chongqing: '重庆市', Sichuan: '四川省', Guizhou: '贵州省', Yunnan: '云南省', Tibet: '西藏自治区',
  Shaanxi: '陕西省', Gansu: '甘肃省', Qinghai: '青海省', Ningxia: '宁夏回族自治区', Xinjiang: '新疆维吾尔自治区',
};

for (const { record, full, stripped, minimal } of wanted) {
  const pool = poolFor(full, [stripped, minimal].filter(Boolean)).filter((c) => !c.isAdmin);
  const provinceOf = (adcode) => nodes.get(chainOf(adcode)[1] ?? adcode)?.name;
  const expectProvince = EN_PROVINCE[record.provinceEn] ?? record.province;
  {
    if (!pool.length) {
      reasons.noCandidate += 1;
      if (reasons.samples.noCandidate.length < 8) reasons.samples.noCandidate.push(record.name);
      unresolved.push(record);
      continue;
    }
    /**
     * 判定只看两件事：省对不对、名字像不像。
     * 「完全同名」直接采信；只是"包含关系"的（「北海公园」vs「北京北海公园」），
     * 要求该省内候选不超过 3 个，否则说明这个名字太通用了，宁可不认。
     */
    const inProvince = pool.filter((c) => provinceOf(c.districtAdcode) === expectProvince);
    if (!inProvince.length) {
      reasons.province += 1;
      if (reasons.samples.province.length < 8)
        reasons.samples.province.push(`${record.name}（期望${expectProvince}，OSM 只在${provinceOf(pool[0].districtAdcode)}）`);
      unresolved.push(record);
      continue;
    }
    const exact = inProvince.filter((c) => c.sim === 3);
    const loose = inProvince.filter((c) => c.sim !== 3);
    let eligible = exact;
    if (!eligible.length) {
      const unique = [...new Set(loose.map((c) => c.osm))];
      if (unique.length > 3) {
        reasons.ambiguous += 1;
        if (reasons.samples.ambiguous.length < 8)
          reasons.samples.ambiguous.push(`${record.name}（省内相似点位 ${unique.length} 个）`);
        unresolved.push(record);
        continue;
      }
      eligible = loose;
    }
    if (!eligible.length) {
      reasons.district += 1;
      unresolved.push(record);
      continue;
    }
    /**
     * 名录名里往往直接写着所在地（「杭州市杭州西湖风景区」），拿它给候选加分：
     * 浙江省内叫「西湖」的点不止一个（建德也有），靠这一点才能选中杭州那个。
     */
    // 同一层级内优先"更像景点"的标签
    const scored = eligible
      .map((c) => {
        let score = c.sim === 3 ? (c.weak ? 7 : 10) : 4;
        const candCity = (nodes.get(chainOf(c.districtAdcode).at(-2))?.name ?? '').replace(/(省|市|区|县|自治州|地区)$/, '');
        const candDistrict = (nodes.get(chainOf(c.districtAdcode).at(-1))?.name ?? '').replace(/(省|市|区|县|自治州|地区)$/, '');
        if (candCity && record.name.includes(candCity)) score += 6;
        if (candDistrict && candDistrict.length >= 2 && record.name.includes(candDistrict)) score += 6;
        if (c.tourism === 'attraction') score += 3;
        else if (c.tourism) score += 2;
        if (c.leisure === 'park' || c.leisure === 'garden') score += 1;
        if (c.historic) score += 1;
        if (c.natural) score += 1;
        // 有 wikidata 说明是知名地物，同名的野点位通常没有
        if (c.wikidata) score += 5;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) {
      unresolved.push(record);
      continue;
    }
    const chain = chainOf(best.c.districtAdcode);
    located.push({
      name: record.name,
      level: record.level,
      lat: best.c.lat,
      lng: best.c.lng,
      osm: best.c.osm,
      // exact 完整同名，可放心新增点位；weak/loose 只用来给已有景点补等级
      match: best.c.sim === 3 && !best.c.weak ? 'exact' : best.c.sim === 3 ? 'weak' : 'loose',
      districtAdcode: best.c.districtAdcode,
      province: nodes.get(chain[1] ?? chain[0])?.name ?? '',
      city: chain.length > 2 ? nodes.get(chain[chain.length - 2])?.name ?? '' : nodes.get(chain[1] ?? chain[0])?.name ?? '',
      district: nodes.get(chain[chain.length - 1])?.name ?? '',
      path: chain.slice(1),
      source: {
        label: '文化和旅游部 A 级景区名录 + OpenStreetMap 定位',
        url: 'https://www.openstreetmap.org/',
      },
      levelSource: record.source.label,
    });
  }
}

/**
 * 同一个 OSM 地物可能被多条名录记录命中（千岛湖同时有 4A 和 5A 两条记录），
 * 那样会生成两条同 id 的数据，前端列表 key 冲突。这里按 OSM 对象归并，只留最高等级。
 */
const LEVEL_RANK = { '5A': 5, '4A': 4, '3A': 3, '2A': 2, '1A': 1 };
const merged = new Map();
for (const item of located) {
  const prev = merged.get(item.osm);
  if (!prev) {
    merged.set(item.osm, item);
    continue;
  }
  if ((LEVEL_RANK[item.level] ?? 0) > (LEVEL_RANK[prev.level] ?? 0)) merged.set(item.osm, item);
}
const deduped = [...merged.values()];
const dupRemoved = located.length - deduped.length;

fs.writeFileSync(OUT, JSON.stringify(deduped));
const byLevel = {};
for (const r of deduped) byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
console.log(`\n===== A 级景区定位完成 =====`);
console.log(`定位成功 ${deduped.length} / ${records.length}（${JSON.stringify(byLevel)}）`);
console.log(`同一地点多条记录归并掉 ${dupRemoved} 条`);
const byMatch = {};
for (const r of deduped) byMatch[r.match] = (byMatch[r.match] ?? 0) + 1;
console.log(`匹配置信度：${JSON.stringify(byMatch)}（只有 exact 会新增点位）`);
console.log(`未能定位 ${unresolved.length} 条：OSM 中没有同名地物，需要外部地理编码才能上图`);
console.log(
  `未定位原因：无同名地物 ${reasons.noCandidate}，省不一致 ${reasons.province}，` +
    `名字太通用 ${reasons.ambiguous}，其它 ${reasons.district}`,
);
for (const [key, label] of [
  ['noCandidate', '无同名地物'],
  ['province', '省不一致'],
  ['ambiguous', '名字太通用'],
]) {
  if (reasons.samples[key].length) console.log(`  样例·${label}：${reasons.samples[key].join('；')}`);
}
console.log(`输出 ${path.relative(ROOT, OUT)}`);
