/**
 * 从 Geofabrik 的 China PBF 全量数据里提取景点 POI
 *
 * 为什么用 PBF 而不是 Overpass：
 *   Overpass 公共实例在高峰期长期 502（队列已满）/ 406，34 个省级查询跑不完一轮；
 *   Geofabrik 的 china-latest.osm.pbf 是 OSM 官方导出的整包（1.6GB），
 *   一次下载后可离线、可重复、无限速地解析，结果比逐省查询更完整。
 *
 * 两遍扫描：
 *   第一遍收集带 tourism=* 且带 name 的 node/way/relation，记下 way/relation 的节点引用；
 *   第二遍只把被引用到的节点坐标读进来，算出面要素的中心点。
 *   （不做单遍：存全国 1.5 亿节点坐标要好几 GB 内存）
 *
 * 输入：tmpdata/osm/china-latest.osm.pbf
 * 输出：data-src/osm-attractions.json
 *
 * 用法：node tools/extract-osm-pbf.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import parse from 'osm-pbf-parser';

const ROOT = path.resolve(import.meta.dirname, '..');
const PBF = path.join(ROOT, 'tmpdata', 'osm', 'china-latest.osm.pbf');
const OUT = path.join(ROOT, 'data-src', 'osm-attractions.json');

const TOURISM = new Set(['attraction', 'museum', 'gallery', 'zoo', 'theme_park', 'aquarium']);
// 只取中国境内（含港澳台），避免拿到周边国家飞地数据
const BOX = { w: 73, s: 3.5, e: 135.5, n: 54.5 };

if (!fs.existsSync(PBF)) {
  console.error(`缺少 ${PBF}，请先运行：npm run data:pbf:download`);
  process.exit(1);
}

const inBox = (lat, lng) => lat >= BOX.s && lat <= BOX.n && lng >= BOX.w && lng <= BOX.e;

/* ------------------------------ 第一遍：收集目标对象 ------------------------------ */

const targets = new Map(); // `${type}/${id}` -> { type, id, tags, refs }
const neededNodes = new Set();

async function pass1() {
  let batches = 0;
  await pipeline(
    fs.createReadStream(PBF),
    parse(),
    async function* (source) {
      for await (const batch of source) {
        batches += 1;
        for (const item of batch) {
          const tags = item.tags;
          if (!tags?.tourism || !TOURISM.has(tags.tourism)) continue;
          if (!tags.name) continue;
          const entry = { type: item.type, id: item.id, tags, refs: item.refs ?? null };
          targets.set(`${item.type}/${item.id}`, entry);
          // 节点自身也要取坐标；面要素则记下构成它的节点引用
          if (item.type === 'node') neededNodes.add(item.id);
          else for (const ref of entry.refs ?? []) neededNodes.add(ref);
        }
        if (batches % 200 === 0) process.stdout.write(`\r第一遍：${batches} 批，命中 ${targets.size}`);
      }
    },
  );
  console.log(`\n第一遍完成：命中 ${targets.size} 个对象，需要 ${neededNodes.size} 个节点坐标`);
}

/* ------------------------------ 第二遍：取节点坐标 ------------------------------ */

const coords = new Map();

async function pass2() {
  let batches = 0;
  await pipeline(
    fs.createReadStream(PBF),
    parse(),
    async function* (source) {
      for await (const batch of source) {
        batches += 1;
        for (const item of batch) {
          if (item.type !== 'node') continue;
          if (!neededNodes.has(item.id)) continue;
          coords.set(item.id, [item.lon, item.lat]);
        }
        if (batches % 200 === 0) process.stdout.write(`\r第二遍：${batches} 批，已取 ${coords.size}`);
      }
    },
  );
  console.log(`\n第二遍完成：取到 ${coords.size} 个节点坐标`);
}

/* ------------------------------ 汇总 ------------------------------ */

await pass1();
await pass2();

const NOISE = /停车场|售票|出入口|游客中心|服务中心|管理处|管委会|派出所|公共厕所|垃圾|工地|小区|写字楼|加油站|收费站|服务区|医院|幼儿园|小学|中学|菜市场|便利店|超市|公交站|地铁站/;

const out = [];
const seen = new Map();
const reasons = { noChinese: 0, badLength: 0, noise: 0, noCoord: 0, outBox: 0, dup: 0 };

for (const entry of targets.values()) {
  const raw = String(entry.tags.name).trim();
  if (!/[\u4e00-\u9fa5]/.test(raw)) { reasons.noChinese += 1; continue; }
  if (raw.length < 2 || raw.length > 32) { reasons.badLength += 1; continue; }
  if (NOISE.test(raw)) { reasons.noise += 1; continue; }

  let lng;
  let lat;
  if (entry.type === 'node') {
    const c = coords.get(entry.id);
    if (!c) { reasons.noCoord += 1; continue; }
    [lng, lat] = c;
  } else {
    // 面要素用所有节点的平均位置近似中心点；关系只取外环成员
    const pts = (entry.refs ?? []).map((ref) => coords.get(ref)).filter(Boolean);
    if (!pts.length) { reasons.noCoord += 1; continue; }
    lng = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
    lat = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  }
  if (!inBox(lat, lng)) { reasons.outBox += 1; continue; }

  const key = `${raw}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
  if (seen.has(key)) { reasons.dup += 1; continue; }

  const item = {
    name: raw,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    tourism: entry.tags.tourism ?? '',
    historic: entry.tags.historic ?? '',
    leisure: entry.tags.leisure ?? '',
    natural: entry.tags.natural ?? '',
    wikidata: entry.tags.wikidata ?? '',
    wikipedia: entry.tags.wikipedia ?? '',
    osm: `${entry.type}/${entry.id}`,
    adcodeHint: '',
  };
  seen.set(key, item);
  out.push(item);
}

fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`\n===== PBF 提取完成 =====`);
const dropped = Object.values(reasons).reduce((a, b) => a + b, 0);
console.log(`景点 POI ${out.length} 条（丢弃 ${dropped}：${JSON.stringify(reasons)}）`);
console.log(`输出 ${path.relative(ROOT, OUT)}`);
