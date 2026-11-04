/**
 * 按「地图上真正显示的景点名」补百度百科简介。
 *
 * fetch-baike.mjs 是按**名录名**（「浙江省温州市乐清市雁荡山景区」）去查百科，
 * 但地图上打点用的是 OSM／名录混排后的显示名（「雁荡山」「天坛」），
 * 归一化之后常常对不上，5A 里就有一批景点拿不到介绍。
 *
 * 这个脚本反过来：读构建产物里**还没有介绍**的景点，拿它的显示名（加上所属城市）
 * 再去查百科，结果单独存 enrich/baike-items.json，键是「省|显示名」，
 * 构建时与 baike.json 一起并入，互不覆盖。
 *
 * 用法：
 *   node tools/fetch-baike-items.mjs --levels=5A
 *   node tools/fetch-baike-items.mjs --levels=5A,4A --limit=500 --concurrency=4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'public', 'data', 'attractions');
const ENRICH_DIR = path.join(ROOT, 'data-src', 'enrich');
const OUT_FILE = path.join(ENRICH_DIR, 'baike-items.json');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const LEVELS = new Set((argOf('levels', '5A') || '5A').split(','));
const ALL_LEVELS = LEVELS.has('all') || LEVELS.has('*');
const LIMIT = Number(argOf('limit', '0')) || 0;
const CONCURRENCY = Number(argOf('concurrency', '4')) || 4;
const DELAY_MS = Number(argOf('delay', '200')) || 200;
/** 第二轮「加类型后缀」猜词条名，默认开；量大时可以 --deep=0 关掉 */
const DEEP = argOf('deep', '1') !== '0';
const levelHit = (item) => {
  if (ALL_LEVELS) return true;
  const lv = item.level ?? '';
  if (LEVELS.has(lv)) return true;
  // 名录外的 OSM 点位没有等级，用「无」来筛
  return !lv && (LEVELS.has('无') || LEVELS.has('none'));
};

const API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHORT_PROVINCE = (name) =>
  String(name ?? '')
    .replace(/(省|市|自治区|维吾尔|壮族|回族|特别行政区)/g, '')
    .trim();

function normText(s) {
  return String(s ?? '')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<a name="ref_\d+"><\/a>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cardValue(card, names) {
  for (const field of card ?? []) {
    const fieldName = String(field.name ?? '');
    if (!names.some((n) => fieldName.includes(n))) continue;
    const raw = (field.value ?? field.format ?? []).join(' ');
    const text = normText(raw);
    if (text) return text;
  }
  return '';
}

function stripAdminChain(name) {
  let out = name;
  for (let i = 0; i < 4; i++) {
    const m = out.match(/^([\u4e00-\u9fa5]{2,8}?(?:省|自治区|特别行政区|市|自治州|地区|盟|县|区|旗|州))/);
    if (!m) break;
    if (out.length - m[1].length < 2) break;
    out = out.slice(m[1].length);
  }
  return out;
}

/** 景区类后缀，长的排前面（「华清宫文化旅游景区」要整个剥掉，不能只剥「旅游景区」） */
const SUFFIX_RE =
  /(文化旅游景区|风景旅游区|旅游风景区|文化旅游区|风景名胜区|旅游度假区|旅游景区|游览区|风景区|旅游区|度假区|景区)$/;

const noSuffix = (x) => {
  let out = String(x ?? '');
  for (let i = 0; i < 2; i++) {
    const next = out.replace(SUFFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
};

/** 名字里直接嵌着行政区名（「迪庆香格里拉普达措」）时，一层层剥掉已知的省市县名 */
function stripKnownAdmin(name, item) {
  const tokens = [item.province, item.city, item.district]
    .map((x) =>
      String(x ?? '')
        .replace(/(省|市|自治区|自治州|地区|盟|县|区|旗)$/, '')
        .replace(/(维吾尔|壮族|回族|藏族|蒙古族|彝族|白族|傣族|苗族|哈尼族|土家族)/g, ''),
    )
    .filter((x) => x.length >= 2)
    .sort((a, b) => b.length - a.length);

  let out = String(name ?? '');
  for (let i = 0; i < 4; i++) {
    const token = tokens.find((t) => out.startsWith(t) && out.length - t.length >= 2);
    if (!token) break;
    out = out.slice(token.length);
  }
  return out;
}

function candidateNames(item) {
  const base = String(item.name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
  const city = String(item.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
  const district = String(item.district ?? '').replace(/(区|县|市|旗)$/, '');
  const core = stripKnownAdmin(stripAdminChain(base), item);
  const parts = (x) => String(x).split(/[·•、・\-—/]/).map((y) => y.trim()).filter((y) => y.length >= 2);

  const list = [
    noSuffix(base),
    base,
    noSuffix(core),
    core,
    city.length >= 2 ? `${city}${noSuffix(core)}` : '',
    city.length >= 2 ? `${city}${core}` : '',
    district.length >= 2 ? `${district}${noSuffix(core)}` : '',
    ...parts(core),
    ...parts(noSuffix(core)),
  ];
  return [...new Set(list.map((x) => x.trim()))].filter((x) => x.length >= 2 && x.length <= 24).slice(0, 8);
}

/**
 * 第一轮没命中时的第二轮：补实体类型后缀。
 * 典型的坑是「同名不同义项」——查「雁门关」拿到的是豫剧剧目，正主词条叫「雁门关长城」。
 * 这类只能靠后缀试，所以仅在第一轮至少见到过词条时才展开，避免对纯英文/无词条的条目白跑。
 */
const DEEP_SUFFIXES = [
  '长城',
  '古城',
  '古镇',
  '古村',
  '风景名胜区',
  '风景区',
  '景区',
  '公园',
  '国家森林公园',
  '森林公园',
  '湿地公园',
  '地质公园',
  '博物馆',
  '纪念馆',
  '遗址',
  '石窟',
  '寺',
  '庙',
  '宫',
  '祠',
  '塔',
  '楼',
  '阁',
  '关',
  '山',
  '峰',
  '湖',
  '岛',
  '峡',
  '洞',
  '瀑布',
  '温泉',
  '庄园',
  '大院',
  '会馆',
  '书院',
];

function deepCandidates(item) {
  const base = String(item.name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
  const city = String(item.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
  const core = stripKnownAdmin(stripAdminChain(noSuffix(base)), item);
  if (core.length < 2 || core.length > 12) return [];

  const list = [];
  for (const suffix of DEEP_SUFFIXES) {
    if (core.endsWith(suffix)) continue;
    list.push(`${core}${suffix}`);
  }
  if (city.length >= 2) list.push(`${city}${core}古城`, `${city}${core}山`, `${city}${core}湖`);
  return [...new Set(list)].filter((x) => x.length >= 2 && x.length <= 24);
}

/**
 * 判断词条是不是本地那一个。
 * 只在摘要里命中「区县」不够——「普陀」可以是浙江舟山普陀区，也可以是辽宁锦州北普陀山，
 * 所以要求：命中市名，或者「省 + 区县」同时命中。
 */
function localityCheck(item, haystack) {
  const prov = SHORT_PROVINCE(item.province);
  const city = String(item.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
  const district = String(item.district ?? '').replace(/(区|县|市|旗)$/, '');
  const provHit = !!prov && prov.length >= 2 && haystack.includes(prov);
  const cityHit = !!city && city.length >= 2 && haystack.includes(city);
  const districtHit = !!district && district.length >= 2 && haystack.includes(district);
  const score = (provHit ? 1 : 0) + (cityHit ? 2 : 0) + (districtHit ? 3 : 0);
  return { score, ok: cityHit || (provHit && districtHit) };
}

const lemmaCache = new Map();

async function queryLemma(keyword) {
  if (lemmaCache.has(keyword)) return lemmaCache.get(keyword);
  const url = `${API}?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(keyword)}&bk_length=1200`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: 'https://baike.baidu.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const value = !json || !json.title || json.errno ? null : json;
  lemmaCache.set(keyword, value);
  return value;
}

/** 查一个候选词条并打分；命中就返回 ok 结果，否则返回「最像的那个」 */
async function tryKeyword(item, keyword, best) {
  let lemma = null;
  try {
    lemma = await queryLemma(keyword);
  } catch (err) {
    if (String(err.message).includes('429')) await sleep(3000);
    return { result: null, best, failed: true };
  }
  if (!lemma) return { result: null, best, failed: false };
  if (/^(地市|序号|名称|景区|旅游区)$/.test(String(lemma.title ?? ''))) return { result: null, best, failed: false };

  const abstract = normText(lemma.abstract || lemma.desc || '');
  const card = lemma.card ?? [];
  const place = cardValue(card, ['地理位置', '地址', '所处地区', '所在地区']);
  const haystack = `${abstract}${place}${normText(lemma.desc)}`;
  const { score, ok } = localityCheck(item, haystack);
  const candidate = {
    keyword,
    title: lemma.title,
    abstract,
    place,
    ticket: cardValue(card, ['门票', '票价']),
    hours: cardValue(card, ['开放时间', '营业时间']),
    duration: cardValue(card, ['游玩时长', '建议游玩', '游览时间']),
    level: cardValue(card, ['景区等级', '级别']),
    url: lemma.url || `https://baike.baidu.com/item/${encodeURIComponent(lemma.title ?? keyword)}`,
    score,
  };
  if (ok && abstract.length >= 20) return { result: { status: 'ok', ...candidate }, best, failed: false };
  return { result: null, best: best ?? candidate, failed: false };
}

async function enrichOne(item) {
  let best = null;
  let failed = 0;

  for (const keyword of candidateNames(item)) {
    const step = await tryKeyword(item, keyword, best);
    best = step.best;
    if (step.result) return step.result;
    if (step.failed) failed += 1;
  }

  // 第二轮：只在「查到了词条但义项不对」或「本来就有官方等级」时才值得加后缀试
  if (DEEP && (best || item.level)) {
    for (const keyword of deepCandidates(item)) {
      const step = await tryKeyword(item, keyword, best);
      best = step.best;
      if (step.result) return step.result;
    }
  }

  if (!best) return failed ? { status: 'error' } : { status: 'notfound' };
  if (best.abstract.length < 20) return { status: 'thin', ...best };
  return { status: 'mismatch', ...best };
}

/* ---------------------------------- 主流程 ---------------------------------- */

const DEBUG = argOf('debug');

const items = [];
for (const file of fs.readdirSync(DATA_DIR)) {
  if (!/^\d+\.json$/.test(file)) continue;
  const json = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  items.push(...(json.items ?? []));
}

if (DEBUG) {
  const target = items.find((it) => String(it.name ?? '').includes(DEBUG));
  if (!target) {
    console.log('没找到匹配的景点', DEBUG);
    process.exit(0);
  }
  console.log(JSON.stringify({ name: target.name, province: target.province, city: target.city, district: target.district }));
  console.log('候选词条名', candidateNames(target));
  const result = await enrichOne(target);
  console.log(result.status, result.title, (result.abstract ?? '').slice(0, 120), 'score', result.score);
  process.exit(0);
}

const store = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};

// --revalidate：用存下来的摘要重算一次地点校验，把「省份和城市都没对上」的旧结果降级
if (args.includes('--revalidate')) {
  let demoted = 0;
  for (const [k, v] of Object.entries(store)) {
    if (v.status !== 'ok') continue;
    const { ok } = localityCheck(v, `${v.abstract ?? ''}${v.place ?? ''}`);
    if (!ok) {
      v.status = 'mismatch';
      v.revalidated = true;
      demoted += 1;
    }
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));
  console.log(`重新校验：降级 ${demoted} 条（省份 / 城市都没对上）`);
  process.exit(0);
}
const keyOf = (it) => `${it.province}|${it.name}`;

const RETRY = new Set(argOf('retry') ? argOf('retry').split(',') : []);
if (RETRY.size) {
  // 只清掉本次要跑的等级里的结果，别把不在队列里的条目一起删了（删了就不会再抓）
  for (const it of items) {
    if (!levelHit(it)) continue;
    const hit = store[keyOf(it)];
    if (hit && RETRY.has(hit.status)) delete store[keyOf(it)];
  }
}

let todo = items
  .filter(levelHit)
  .filter((it) => !it.description)
  .filter((it) => String(it.name ?? '').trim().length >= 2)
  .filter((it) => !store[keyOf(it)]);
if (LIMIT) todo = todo.slice(0, LIMIT);

console.log(`待补 ${todo.length} 条（已有 ${Object.keys(store).length} 条缓存）`);
const startedAt = Date.now();
let done = 0;
let ok = 0;

async function worker(queue) {
  while (queue.length) {
    const item = queue.shift();
    let result;
    try {
      result = await enrichOne(item);
    } catch (err) {
      result = { status: 'error', message: String(err.message ?? err) };
    }
    store[keyOf(item)] = {
      name: item.name,
      province: item.province,
      city: item.city ?? '',
      district: item.district ?? '',
      level: item.level ?? '',
      byItemName: true,
      fetchedAt: new Date().toISOString().slice(0, 10),
      ...result,
    };
    done += 1;
    if (result.status === 'ok') ok += 1;
    if (done % 40 === 0) {
      fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));
      const rate = done / ((Date.now() - startedAt) / 1000);
      console.log(`  ${done}/${todo.length} 命中 ${ok} | ${rate.toFixed(2)} 条/秒`);
    }
    await sleep(DELAY_MS);
  }
}

fs.mkdirSync(ENRICH_DIR, { recursive: true });
const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));

const stats = {};
for (const v of Object.values(store)) stats[v.status] = (stats[v.status] ?? 0) + 1;
console.log(`完成，用时 ${Math.round((Date.now() - startedAt) / 60000)} 分钟`, stats);
