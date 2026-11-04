/**
 * 给「百度怎么问都不出卡」的区县搭攻略骨架。
 *
 * 这些地区的共同点不是没得玩，而是站内已经收录了它的景点（等级 / 介绍 / 坐标都有），
 * 只是没有一个「怎么玩」的叙述。所以骨架从这个站内景点库来，不由模型凭空列名字——
 * 推荐出来的每一个点都能在地图上定位到，这是硬要求。
 *
 * 输出 tmpdata/stub-<adcode>.json，供人工/模型组织成 regions-ai.json 的 guide 段。
 * 只读，不写 regions.json，可以和抓取脚本同时跑。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'stubs');

function readJsonWithRetry(file, times = 6) {
  for (let i = 0; i < times; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // 抓取脚本会整文件回写，撞上就在这几十毫秒里重试
      const until = Date.now() + 250;
      while (Date.now() < until) {}
    }
  }
  throw new Error(`读不到 ${file}`);
}

const regions = readJsonWithRetry(path.join(ROOT, 'data-src/enrich/regions.json'));

const byAd = new Map();
const dir = path.join(ROOT, 'public/data/attractions');
for (const file of fs.readdirSync(dir)) {
  if (file === 'summary.json') continue;
  const payload = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  for (const item of payload.items ?? []) {
    const key = String(item.districtAdcode ?? '');
    if (!key) continue;
    if (!byAd.has(key)) byAd.set(key, []);
    byAd.get(key).push(item);
  }
}

const levelRank = { '5A': 5, '4A': 4, '3A': 3, '2A': 2, '1A': 1 };
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const firstSentence = (text, limit = 90) => {
  const s = clean(text);
  if (!s) return '';
  const cut = s.slice(0, limit);
  const dot = cut.search(/[。；]/);
  return dot > 20 ? cut.slice(0, dot) : cut;
};

const pending = Object.values(regions).filter((r) => r.level === 3 && !r.guide);
fs.mkdirSync(OUT_DIR, { recursive: true });

const index = [];
for (const region of pending) {
  const list = (byAd.get(String(region.adcode)) ?? [])
    .slice()
    .sort((a, b) => (levelRank[b.level] ?? 0) - (levelRank[a.level] ?? 0) || (a.name > b.name ? 1 : -1));
  const stub = {
    adcode: region.adcode,
    name: region.name,
    province: region.province,
    city: region.city,
    intro: firstSentence(region.abstract, 140),
    facts: region.facts ?? {},
    attractions: list.slice(0, 10).map((a) => ({
      name: a.name,
      level: a.level ?? '',
      category: a.category ?? '',
      lng: a.lng,
      lat: a.lat,
      summary: firstSentence(a.description, 110),
      hasGuide: Boolean(a.guide?.sections?.length),
    })),
  };
  fs.writeFileSync(path.join(OUT_DIR, `${region.adcode}.json`), JSON.stringify(stub, null, 1));
  index.push({
    adcode: region.adcode,
    name: region.name,
    city: region.city,
    count: stub.attractions.length,
    withSummary: stub.attractions.filter((a) => a.summary).length,
  });
}

fs.writeFileSync(path.join(OUT_DIR, '_index.json'), JSON.stringify(index, null, 1));
console.log(`骨架已生成：${index.length} 个地区 → tmpdata/stubs/`);
for (const row of index) {
  console.log(` ${row.adcode} ${row.city}·${row.name} | 景点 ${row.count} | 带介绍 ${row.withSummary}`);
}
