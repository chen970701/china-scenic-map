/**
 * 从百度百科补景点简介。
 *
 * 用百科的开放接口（BaikeLemmaCardApi）拿摘要与信息卡，不渲染页面，速度快、可批量：
 *   GET https://baike.baidu.com/api/openapi/BaikeLemmaCardApi
 *       ?scope=103&format=json&appid=379020&bk_key=<词条名>&bk_length=1200
 * 返回的 abstract 是词条摘要（约 200–400 字），card 是信息卡（门票价格 / 开放时间 / 地理位置等）。
 *
 * 关键点是**校验词条是不是我们要的那个地方**：百科里同名词条很多
 * （「西湖」有杭州的湖、惠州的湖、还有村镇），所以要求摘要或信息卡里出现
 * 省份简称 / 城市名 / 区县名之一，否则判为「疑似他地」不入库。
 *
 * 用法：
 *   node tools/fetch-baike.mjs --levels=5A,4A      只抓指定等级
 *   node tools/fetch-baike.mjs --limit=200         只抓前 200 条（调试）
 *   node tools/fetch-baike.mjs                     全量（已有结果自动跳过，可反复跑）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data-src', 'a-level', 'provincial.json');
const OUT_DIR = path.join(ROOT, 'data-src', 'enrich');
const OUT_FILE = path.join(OUT_DIR, 'baike.json');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const LEVELS = argOf('levels') ? new Set(argOf('levels').split(',')) : null;
const LIMIT = Number(argOf('limit', '0')) || 0;
const CONCURRENCY = Number(argOf('concurrency', '3')) || 3;
const DELAY_MS = Number(argOf('delay', '260')) || 260;

const API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 景区名归一：去掉括号备注与「景区」类后缀，百科词条名通常就长这样 */
function cleanName(name) {
  return String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^[^\u4e00-\u9fa5]+/, '')
    .trim();
}

/** 省份简称：「内蒙古自治区」→「内蒙古」，「浙江省」→「浙江」 */
const SHORT_PROVINCE = (name) =>
  String(name)
    .replace(/(省|市|自治区|维吾尔|壮族|回族|特别行政区)/g, '')
    .replace(/(蒙古|西藏|新疆|宁夏|广西)/g, '$1')
    .trim();

function normText(s) {
  return String(s ?? '')
    // 引用角标 <sup>12</sup> 去掉标签后会剩下裸数字（「30元/人10」），标签和内容一起删
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<a name="ref_\d+"><\/a>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    // 只吃掉汉字之间的空白，英文单词之间的空格保留（否则 XiamenBotanicGarden 连成一串）
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从信息卡里按名字取值（「门票价格」「开放时间」这类字段名各省词条写法不一） */
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

/** 判断词条是不是本地那一个：省份 / 城市 / 区县至少命中一个 */
function localityScore(record, haystack) {
  const prov = SHORT_PROVINCE(record.province);
  const city = String(record.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
  const district = String(record.district ?? '').replace(/(区|县|市|旗)$/, '');
  let score = 0;
  if (prov && prov.length >= 2 && haystack.includes(prov)) score += 1;
  if (city && city.length >= 2 && haystack.includes(city)) score += 2;
  if (district && district.length >= 2 && haystack.includes(district)) score += 3;
  return score;
}

async function queryLemma(keyword) {
  const url = `${API}?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(keyword)}&bk_length=1200`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: 'https://baike.baidu.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !json.title || json.errno) return null;
  return json;
}

/** 剥掉名字前面的行政区链：「浙江省温州市乐清市雁荡山景区」→「雁荡山景区」 */
function stripAdminChain(name) {
  let out = name;
  for (let i = 0; i < 4; i++) {
    const m = out.match(/^([\u4e00-\u9fa5]{2,8}?(?:省|自治区|特别行政区|市|自治州|地区|盟|县|区|旗|州))/);
    if (!m) break;
    const token = m[1];
    // 「西湖」「雁荡山」这类不该被当成行政区剥掉：剥完至少还要剩 2 个字
    if (out.length - token.length < 2) break;
    out = out.slice(token.length);
  }
  return out;
}

/** 景区名可选的词条名写法，按优先级排 */
function candidateNames(record) {
  const base = String(record.name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
  const city = String(record.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
  const core = stripAdminChain(base);
  const noSuffix = (x) => x.replace(/(景区|风景区|旅游区|旅游景区|度假区|风景名胜区|文化旅游区)$/, '');
  const parts = (x) => x.split(/[·•、・\-—/]/).map((y) => y.trim()).filter((y) => y.length >= 2);

  const list = [
    base,
    noSuffix(base),
    core,
    noSuffix(core),
    `${core}景区`,
    city.length >= 2 ? `${city}${noSuffix(core)}` : '',
    ...parts(core),
    ...parts(noSuffix(core)),
  ];
  return [...new Set(list.map((x) => x.trim()))].filter((x) => x.length >= 2 && x.length <= 24).slice(0, 8);
}

/** 一 record 多候选词条名依次尝试，命中本地校验就停 */
async function enrichOne(record) {
  const unique = candidateNames(record);

  let best = null;
  for (const keyword of unique) {
    let lemma = null;
    try {
      lemma = await queryLemma(keyword);
    } catch (err) {
      if (String(err.message).includes('429')) await sleep(4000);
      continue;
    }
    if (!lemma) continue;
    if (/^(地市|序号|名称|景区|旅游区)$/.test(String(lemma.title ?? ''))) continue;

    const abstract = normText(lemma.abstract || lemma.desc || '');
    const card = lemma.card ?? [];
    const place = cardValue(card, ['地理位置', '地址', '所处地区', '所在地区']);
    const haystack = `${abstract}${place}${normText(lemma.desc)}`;
    const score = localityScore(record, haystack);
    const candidate = {
      keyword,
      title: lemma.title,
      abstract,
      place,
      ticket: cardValue(card, ['门票', '票价']),
      hours: cardValue(card, ['开放时间', '营业时间']),
      duration: cardValue(card, ['游玩时长', '建议游玩', '游览时间']),
      level: cardValue(card, ['景区等级', '级别']),
      url:
        lemma.url || `https://baike.baidu.com/item/${encodeURIComponent(lemma.title ?? keyword)}`,
      score,
    };
    // 地点命中（省 1 分 / 市 2 分 / 区县 3 分）才算找对人；同名不同地继续试其它写法
    if (score >= 1) return { status: 'ok', ...candidate };
    if (!best) best = candidate;
  }
  if (!best) return { status: 'notfound' };
  if (best.abstract.length < 20) return { status: 'thin', ...best };
  return { status: 'mismatch', ...best };
}

/* ---------------------------------- 主流程 ---------------------------------- */

const records = JSON.parse(fs.readFileSync(SRC, 'utf8'));
let todo = records
  .filter((r) => (LEVELS ? LEVELS.has(r.level) : true))
  .filter((r) => String(r.name ?? '').length >= 2)
  .filter((r) => !/^(地市|序号|名称|景区|旅游区)$/.test(String(r.name ?? '').trim()));
if (LIMIT) todo = todo.slice(0, LIMIT);

const store = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};

// --retry=notfound,mismatch：把上次没抓到的重新排进队列（候选词条名改过之后要重试）
const RETRY = new Set(argOf('retry') ? argOf('retry').split(',') : []);
if (RETRY.size) {
  let dropped = 0;
  for (const [k, v] of Object.entries(store)) {
    if (RETRY.has(v.status)) {
      delete store[k];
      dropped += 1;
    }
  }
  if (dropped) console.log(`重试队列：清掉 ${dropped} 条上次的 ${[...RETRY].join('/')} 结果`);
}
const keyOf = (r) => `${r.province}|${r.name}`;

const pending = todo.filter((r) => {
  const hit = store[keyOf(r)];
  // notfound / mismatch / thin 都是"试过了"，重跑不再浪费时间；要重试就删掉对应键
  return !hit;
});

console.log(`待抓 ${pending.length} / 共 ${todo.length}（已有 ${Object.keys(store).length} 条缓存）`);
const startedAt = Date.now();
let done = 0;
let ok = 0;

fs.mkdirSync(OUT_DIR, { recursive: true });

async function worker(queue) {
  while (queue.length) {
    const record = queue.shift();
    let result;
    try {
      result = await enrichOne(record);
    } catch (err) {
      result = { status: 'error', message: String(err.message ?? err) };
    }
    store[keyOf(record)] = {
      name: record.name,
      province: record.province,
      city: record.city ?? '',
      district: record.district ?? '',
      level: record.level ?? '',
      fetchedAt: new Date().toISOString().slice(0, 10),
      ...result,
    };
    done += 1;
    if (result.status === 'ok') ok += 1;
    if (done % 50 === 0) {
      fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));
      const rate = done / ((Date.now() - startedAt) / 1000);
      const left = pending.length - done;
      console.log(
        `  ${done}/${pending.length} 命中 ${ok} | ${rate.toFixed(2)} 条/秒 | 预计剩余 ${Math.round(left / rate / 60)} 分钟`,
      );
    }
    await sleep(DELAY_MS);
  }
}

const queue = [...pending];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));

const stats = { ok: 0, notfound: 0, mismatch: 0, thin: 0, error: 0 };
for (const v of Object.values(store)) stats[v.status] = (stats[v.status] ?? 0) + 1;
console.log(`\n完成，用时 ${Math.round((Date.now() - startedAt) / 60000)} 分钟`);
console.log(stats);
console.log(`写入 ${OUT_FILE}`);
