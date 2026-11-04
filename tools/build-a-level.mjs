/**
 * A 级旅游景区名录整理
 *
 * 数据来源：
 *   1. 文化和旅游部 5A 级旅游景区名录（经 Airmole/sight 整理，标注来源为文旅部政府门户网站）
 *      318 条，含省/市与经纬度
 *   2. China Top Attractions 公开数据集（5A + 4A，CC 引用即可）
 *      1,310 条，WGS-84 坐标，含省/市（英文）与中文名
 *
 * 处理：
 *   - 5A 以官方名录为准，数据集里重复的 5A 条目不重复收录
 *   - 用本项目区县边界做 point-in-polygon，得到省/市/区县中文名
 *   - 落不到任何区县的坐标（边界简化导致的海边/边界误差）直接丢弃，不做猜测
 *
 * 输出：data-src/a-level/records.json
 * 用法：node tools/build-a-level.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGeoIndex } from './lib/geo-index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GEO_DIR = path.join(ROOT, 'public', 'geo');
const CSV = path.join(ROOT, 'tmpdata', 'a-level.csv');
const OFFICIAL_5A = path.join(ROOT, 'tmpdata', '5a_full.json');
const OUT = path.join(ROOT, 'data-src', 'a-level', 'records.json');

const geo = createGeoIndex(GEO_DIR);
const { nodes, chainOf, locate } = geo;

/* ------------------------------ CSV 解析 ------------------------------ */

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------ 名称归一 ------------------------------ */

/** 去掉行政区前缀与景区后缀，得到可比较的核心名 */
function coreName(name) {
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^(中国|全国)/, '')
    .replace(/(特别行政区|自治区|自治州|地区|城市|市|省)/g, '')
    .replace(/(旅游景区|风景名胜区|旅游度假区|旅游区|风景区|景区|度假区|游览区)$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/* ------------------------------ 读入数据 ------------------------------ */

const csvRows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const header = csvRows[0];
const col = (row, key) => row[header.indexOf(key)] ?? '';
const records = [];

for (const row of csvRows.slice(1)) {
  const name = col(row, 'name_cn').trim();
  const level = col(row, 'rating').trim();
  const lat = Number(col(row, 'latitude'));
  const lng = Number(col(row, 'longitude'));
  if (!name || !level || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  records.push({
    name,
    level,
    lat,
    lng,
    provinceEn: col(row, 'province_en').trim(),
    official: false,
    source: {
      label: 'China Top Attractions 5A/4A 数据集',
      url: 'https://chinatopattractions.com/china-attractions-dataset/',
    },
  });
}

/**
 * 官方 5A 名录（318 条，2021 年整理）只用来做"名称对照"：
 * 它的 location 有相当一部分填的是城市中心而非景区坐标，
 * 直接入库会把 5A 标到市中心去，所以这里不做坐标合并，仅记录条数供文档说明。
 */
const official5a = fs.existsSync(OFFICIAL_5A) ? JSON.parse(fs.readFileSync(OFFICIAL_5A, 'utf8')) : [];
const officialNames = new Set(official5a.map((x) => x.name));
const csvNames = new Set(records.map((r) => r.name));
let officialOnly = 0;
for (const name of officialNames) if (!csvNames.has(name)) officialOnly += 1;

/* ------------------------------ 落界 ------------------------------ */

let outside = 0;
const EN_PROVINCE = {
  Beijing: '北京市', Tianjin: '天津市', Hebei: '河北省', Shanxi: '山西省', 'Inner Mongolia': '内蒙古自治区',
  Liaoning: '辽宁省', Jilin: '吉林省', Heilongjiang: '黑龙江省', Shanghai: '上海市', Jiangsu: '江苏省',
  Zhejiang: '浙江省', Anhui: '安徽省', Fujian: '福建省', Jiangxi: '江西省', Shandong: '山东省', Henan: '河南省',
  Hubei: '湖北省', Hunan: '湖南省', Guangdong: '广东省', Guangxi: '广西壮族自治区', Hainan: '海南省',
  Chongqing: '重庆市', Sichuan: '四川省', Guizhou: '贵州省', Yunnan: '云南省', Tibet: '西藏自治区',
  Shaanxi: '陕西省', Gansu: '甘肃省', Qinghai: '青海省', Ningxia: '宁夏回族自治区', Xinjiang: '新疆维吾尔自治区',
};

const located = [];
let provinceMismatch = 0;
for (const record of records) {
  const districtAdcode = locate(record.lng, record.lat);
  if (!districtAdcode) {
    outside += 1;
    continue;
  }
  // 坐标落到的省，必须和数据集标的省一致；不一致说明这一行坐标是错的，直接丢弃
  const locatedProvince = nodes.get(chainOf(districtAdcode)[1] ?? districtAdcode)?.name;
  const expectProvince = record.provinceEn ? EN_PROVINCE[record.provinceEn] : undefined;
  if (expectProvince && locatedProvince && expectProvince !== locatedProvince) {
    provinceMismatch += 1;
    continue;
  }
  const chain = chainOf(districtAdcode);
  const provinceNode = nodes.get(chain[1] ?? chain[0]);
  const cityNode = chain.length > 2 ? nodes.get(chain[chain.length - 2]) : null;
  const districtNode = nodes.get(districtAdcode);
  located.push({
    ...record,
    lat: Number(record.lat.toFixed(5)),
    lng: Number(record.lng.toFixed(5)),
    districtAdcode,
    province: provinceNode?.name ?? '',
    city: cityNode?.name ?? provinceNode?.name ?? '',
    district: districtNode?.name ?? '',
    path: chain.slice(1),
    core: coreName(record.name),
  });
}

/* ------------------------------ 去重（同名同地） ------------------------------ */

const LEVEL_RANK = { '5A': 5, '4A': 4, '3A': 3, '2A': 2, '1A': 1 };
const byKey = new Map();
for (const item of located) {
  const key = `${item.core}|${item.districtAdcode}`;
  const prev = byKey.get(key);
  if (!prev) {
    byKey.set(key, item);
    continue;
  }
  // 保留等级更高、或来自官方名录的那条
  const prevScore = (LEVEL_RANK[prev.level] ?? 0) * 10 + (prev.official ? 5 : 0);
  const nextScore = (LEVEL_RANK[item.level] ?? 0) * 10 + (item.official ? 5 : 0);
  if (nextScore > prevScore) byKey.set(key, item);
}

const finalRecords = [...byKey.values()];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(finalRecords));

const byLevel = {};
for (const r of finalRecords) byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
const districts = new Set(finalRecords.map((r) => r.districtAdcode));

console.log(`\n===== A 级景区整理完成 =====`);
console.log(`数据集 ${csvRows.length - 1} 条；官方名录 ${official5a.length} 条中，名称未被数据集覆盖的 ${officialOnly} 条（坐标不可靠，未并库）`);
console.log(`落界成功 ${finalRecords.length} 条，落空 ${outside} 条，省份对不上丢弃 ${provinceMismatch} 条`);
console.log(`等级分布 ${JSON.stringify(byLevel)}；覆盖区县 ${districts.size}`);
console.log(`输出 ${path.relative(ROOT, OUT)}`);
