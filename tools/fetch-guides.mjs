/**
 * 抓「游玩攻略」——来自百度搜索结果页的 AI 卡片。
 *
 * 搜索「<景区名>游玩攻略」时，百度会在结果页顶部生成一张结构化攻略卡
 * （核心景点怎么玩 / 几条路线不绕路 / 吃住交通少踩坑 …）。这份内容只在前端
 * 流式渲染，没有公开接口，只能用真实浏览器内核拿。
 *
 * DOM 结构（2025 版）：
 *   .result-op.c-container
 *     └ .cosc-card                     ← 攻略卡本体，取它的文本
 *         ├ .link-wrapper_xxx > .cosd-markdown   导语段落（可能夹着视频卡）
 *         ├ .cosd-video-scroll                   视频推荐，丢掉
 *         ├ .cos-accordion-panel × N             小标题 + 正文段落
 *         └ .follow-up-guide                     AI 反问，丢掉
 *
 * 一条要十几秒（等页面渲染完 + 换问法重试），脚本默认单页串行、按间隔请求，
 * 跑一段就停（--minutes / --batch），下次按 id 续跑；遇到无法访问的页面就跳过并记下来。
 *
 * 用法：
 *   node tools/fetch-guides.mjs --levels=5A             只抓 5A（默认）
 *   node tools/fetch-guides.mjs --levels=5A,4A --limit=300
 *   node tools/fetch-guides.mjs --tabs=3 --minutes=60   3 个标签页，最多跑 60 分钟
 *   node tools/fetch-guides.mjs --retry=weak,blocked    重抓上次失败的
 *   node tools/fetch-guides.mjs --source=items --levels=5A  补抓名录没有、只在地图点位里的
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data-src', 'a-level', 'provincial.json');
const OUT_DIR = path.join(ROOT, 'data-src', 'enrich');
const OUT_FILE = path.join(OUT_DIR, 'guides.json');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const LEVELS = new Set((argOf('levels', '5A') || '5A').split(','));
const LIMIT = Number(argOf('limit', '0')) || 0;
// 默认单页串行；多标签页同时请求更容易被服务端限流，实际总产出未必更高
const TABS = Math.max(1, Number(argOf('tabs', '1')) || 1);
const MINUTES = Number(argOf('minutes', '0')) || 0;
const DELAY_MIN = Number(argOf('delay-min', '900')) || 900;
const DELAY_MAX = Number(argOf('delay-max', '1800')) || 1800;
const MIN_CHARS = 180;

/**
 * 持久化 profile：固定一个 Chrome 用户目录，缓存与站点数据跨运行保留，
 * 不必每次运行都从空白会话开始。
 */
const PROFILE_DIR = path.resolve(ROOT, argOf('profile', 'tmpdata/chrome-profile'));
const FRESH_PROFILE = args.includes('--fresh-profile');
const CD_MIN = Number(argOf('cooldown-min', '45000')) || 45000;
const CD_MAX = Number(argOf('cooldown-max', '80000')) || 80000;
const CHROME_PATH =
  argOf('chrome') || process.env.CHROME_PATH || 'C:////Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

/** 词条名精简：去括号备注 + 去行政区前缀 */
function cleanName(name) {
  return String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^[\u4e00-\u9fa5]{2,8}?(?:省|自治区|特别行政区)/, '')
    .replace(/^[\u4e00-\u9fa5]{2,8}?(?:市|自治州|地区|盟)/, '')
    .trim();
}

const store = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
const RETRY = new Set(argOf('retry') ? argOf('retry').split(',') : []);
if (RETRY.size) {
  let dropped = 0;
  // 只清本次要跑的等级：不限定的话 --retry=none 会把全等级的失败项一起删掉，
  // 队列瞬间膨胀到几千条，等于把已经跑完的活重做一遍。
  for (const [k, v] of Object.entries(store)) {
    if (RETRY.has(v.status) && LEVELS.has(v.level)) {
      delete store[k];
      dropped += 1;
    }
  }
  if (dropped) console.log(`重试队列：清掉 ${dropped} 条 ${[...RETRY].join('/')} 结果`);
}

const keyOf = (r) => `${r.province}|${r.name}`;

/**
 * 两个数据源：
 *   list  —— 省级 A 级名录（默认）。名录是「评定单位」，一个名录可能对应多个地图点位。
 *   items —— 构建产物里的景点。这里比名录多出来的那批，是 Wikidata / OSM 点位
 *            与名录等级合并后带上了 4A/5A 的（北海公园、孔庙和国子监博物馆这类），
 *            list 模式看不到它们，只能靠这个源补。
 */
function loadRecords(source) {
  if (source !== 'items') return JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const dir = path.join(ROOT, 'public', 'data', 'attractions');
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/^\d+\.json$/.test(file)) continue;
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const item of bundle.items ?? []) {
      if (!item.name || item.name.length < 2) continue;
      if (item.guide) continue; // 已有攻略的不再排进队列，省得重复搜同一批词
      out.push({ province: item.province, city: item.city, district: item.district, name: item.name, level: item.level });
    }
  }
  return out;
}

const records = loadRecords(argOf('source', 'list'));
let todo = records
  .filter((r) => LEVELS.has(r.level))
  .filter((r) => String(r.name ?? '').trim().length >= 2)
  .filter((r) => !store[keyOf(r)]);
if (LIMIT) todo = todo.slice(0, LIMIT);

console.log(`待抓 ${todo.length}（已有 ${Object.keys(store).length} 条缓存，${TABS} 个标签页并行）`);
if (!todo.length) process.exit(0);

fs.mkdirSync(OUT_DIR, { recursive: true });
const flush = () => fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));

const isNewProfile = FRESH_PROFILE || !fs.existsSync(path.join(PROFILE_DIR, 'Default', 'Network', 'Cookies'));
if (FRESH_PROFILE) {
  if (!PROFILE_DIR.includes('chrome-profile')) {
    console.error(`拒绝清空 ${PROFILE_DIR}：--fresh-profile 只对 …/chrome-profile 目录生效`);
    process.exit(1);
  }
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME_PATH,
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 1200 },
  args: ['--disable-dev-shm-usage'],
});

// 先正常访问一次首页，确认页面能打开；拿不到内容就整轮跳过
const warmPage = await ctx.newPage();
await warmPage
  .goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  .catch(() => {});
console.log(`  profile ${path.relative(ROOT, PROFILE_DIR)} | ${isNewProfile ? '第一次运行' : '复用已有目录'}`);
// isBlocked 定义在下面的「单条」段，这里直接内联判断，避免提前引用
const warmBlocked = await warmPage
  .evaluate(() => /百度安全验证|请完成下方验证/.test(document.body.innerText.slice(0, 400)))
  .catch(() => false);
if (warmBlocked) console.log('  首页返回了人工校验页，本次抓取可能不完整，可以稍后再跑');
await warmPage.close().catch(() => {});

/* ---------------------------------- 解析 ---------------------------------- */

/**
 * 等攻略卡的正文长起来（流式渲染），返回卡片文本长度。
 * 卡片通常在 5–9 秒后才出现，所以只有「一直没有卡片」才提前放弃（10 秒），
 * 有卡片了则是「连续两次长度不变」就算渲染完。
 */
async function waitCard(page, maxTries = 26, step = 500) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxTries; i++) {
    // 页面里 .cosc-card 不止一个（「相关搜索」也是这个壳），取正文最长的那个
    const len = await page
      .evaluate(() => {
        const cards = [...document.querySelectorAll('.cosc-card')].filter((c) => c.querySelector('.cosd-markdown'));
        return cards.reduce((n, c) => Math.max(n, c.innerText.length), 0);
      })
      .catch(() => 0);
    if (len > 0 && len === last) {
      stable += 1;
      if (stable >= 2 && len > MIN_CHARS) return len;
    } else {
      stable = 0;
    }
    last = len;
    if (len === 0 && i >= 14) return 0; // 7 秒还没出现，这次就是没有
    await page.waitForTimeout(step);
  }
  return Math.max(last, 0);
}

/** 把攻略卡读成「导语 + 若干小节」；视频卡、AI 反问这些噪音在页面里先剔掉 */
async function readGuide(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.cosc-card')].filter((c) => c.querySelector('.cosd-markdown'));
    const card = cards.sort((a, b) => b.innerText.length - a.innerText.length)[0];
    if (!card) return null;

    const clone = card.cloneNode(true);
    // clone 里把干扰块删掉再读文本，比逐节点过滤稳
    clone
      .querySelectorAll('.cosd-video-scroll, .follow-up-guide_2Ol3Z, [class*="follow-up-guide"], [class*="cosd-video"]')
      .forEach((el) => el.remove());

    const clean = (s) =>
      String(s ?? '')
        .replace(/[\u200b-\u200f\u2028\u2029\u2060]/g, '')
        .replace(/\s*\[component:\d+\]\s*/g, '')
        .replace(/[0-9]*\s*(百科|官媒|引用|参考资料?|来源)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const NOISE =
      /^(内容由AI生成|以上内容均由AI生成|长按识别，即刻体验百度AI|展开剩余\d+%内容|展开|收起|百度AI|AI总结|百科|总结全网\d+篇结果|AI总结\d+篇结果生成)$/;
    const lines = String(clone.innerText ?? '')
      .split('\n')
      .map(clean)
      .filter((t) => t.length >= 2 && !NOISE.test(t))
      .filter((t) => !/^(长按识别|以上内容均由|相关搜索)/.test(t))
      .filter((t) => !/要不要(继续看看|了解一下)/.test(t));

    const isHeading = (t) => t.length <= 16 && !/[。，,；;！？]/.test(t) && !/^\d/.test(t) && !/[：:]/.test(t.slice(-1));

    const intro = [];
    const sections = [];
    let current = null;
    for (const t of lines) {
      if (isHeading(t)) {
        current = { title: t.replace(/[:：]$/, ''), items: [] };
        sections.push(current);
        continue;
      }
      if (current) current.items.push(t);
      else intro.push(t);
    }

    // 结尾那句 AI 反问（「…要不要继续看看 X？」）不进正文
    const last = sections[sections.length - 1];
    if (last?.items.length && /要不要继续看看|想了解哪方面/.test(last.items[last.items.length - 1])) {
      last.items.pop();
    }

    // 有些卡片其实是「百度地图 / 携程酒店」这类插件块，标题就是工具名，整段不要
    const JUNK_TITLE = /^(百度地图|高德地图|携程|去哪儿|马蜂窝|美团|飞猪|同程|展开更多|查看更多|更多推荐)/;
    const filled = sections.filter((s) => s.items.length && !JUNK_TITLE.test(s.title));
    const totalChars = filled.reduce((n, s) => n + s.items.join('').length, 0);
    return {
      intro: intro.join(' ').slice(0, 400),
      sections: filled
        .slice(0, 8)
        .map((s) => ({ title: s.title.slice(0, 24), items: s.items.slice(0, 12).map((x) => x.slice(0, 320)) })),
      chars: totalChars + intro.join('').length,
      hasStructure: filled.length >= 1,
    };
  });
}

/* ---------------------------------- 单条 ---------------------------------- */

const isBlocked = (page) =>
  page
    .evaluate(() => /百度安全验证|请完成下方验证/.test(document.body.innerText.slice(0, 400)))
    .catch(() => false);

async function queryOnce(page, q) {
  // 带上前端搜索页常用的入参，拿到的结果页结构与浏览器里一致
  await page.goto(`https://www.baidu.com/s?ie=utf-8&f=3&rsv_bp=1&tn=baidu&wd=${encodeURIComponent(q)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 35000,
  });
  await waitCard(page);
  if (await isBlocked(page)) return { status: 'blocked' };
  const parsed = await readGuide(page);
  if (!parsed) return { status: 'none' };
  if (parsed.chars < MIN_CHARS || !parsed.hasStructure) return { status: 'weak', guide: parsed };
  return { status: 'ok', guide: parsed };
}

const noSuffix = (x) =>
  String(x).replace(
    /(历史文化街区|文化街区|步行街|老街|街区|古城|古镇|景区|风景区|旅游区|旅游景区|度假区|风景名胜区|文化旅游区|旅游度假区|森林公园|湿地公园|地质公园|遗址公园|纪念馆|博物馆|遗址)$/,
    '',
  );

/** 剥完后缀常留下「西溪国家」「五大连池世界」这种悬空词，搜出来一塌糊涂 */
const trimDangling = (x) => String(x).replace(/(国家|世界|中国|国家级|世界级|省级|市级)$/, '');

function queryCore(name) {
  const stripped = noSuffix(name);
  return trimDangling(stripped) || stripped || name;
}

async function fetchOne(page, record) {
  const raw = String(record.name ?? '');
  const short = cleanName(raw);
  const core = queryCore(short);
  const city = String(record.city ?? '').replace(/(市|地区|自治州|盟)$/, '');
  // 问法越短越像真人，AI 卡片出现率也高；名字太短（「古田」这种）才补上城市名
  const qualified = core.length <= 4 && city.length >= 2 ? `${city}${core}` : short;

  // 三种名字形态经常搜不出东西，但换个叫法就有卡：
  //   括号里的别称 ——「明故城（三孔）旅游区」真正好搜的是「三孔」
  //   `·` 拼起来的组合景区 ——「大雁塔·大唐芙蓉园景区」整串没结果，拆开就有
  const altCores = [];
  // cleanName 已经把括号内容剥掉了，这里要从原名里取，才拿得到「三孔」这种别称
  const paren = raw.match(/[（(]([^）)]{2,12})[）)]/);
  if (paren) altCores.push(queryCore(paren[1]));
  for (const part of raw.split(/[·•・]/)) {
    const p = queryCore(part.trim());
    if (p.length >= 2 && p !== core) altCores.push(p);
  }

  const queries = [
    ...new Set([
      `${core}游玩攻略`,
      `${qualified}游玩攻略`,
      `${core}旅游攻略`,
      ...altCores.slice(0, 2).map((x) => `${x}游玩攻略`),
    ]),
  ].filter((q) => q.length > 4);
  let weak = null;
  let q = queries[0];

  for (const [idx, candidateQuery] of queries.entries()) {
    q = candidateQuery;
    let res;
    try {
      res = await queryOnce(page, q);
    } catch (err) {
      res = { status: String(err.message ?? '').includes('Timeout') ? 'none' : 'error' };
    }
    if (res.status === 'ok') return { status: 'ok', guide: res.guide, query: q };
    if (res.status === 'blocked') return { status: 'blocked', query: q };
    if (res.status === 'weak' && !weak) weak = { status: 'weak', guide: res.guide, query: q };
    if (idx < queries.length - 1) await sleep(rand(400, 900));
  }
  return weak ?? { status: 'none', query: q };
}

/* ---------------------------------- 主循环 ---------------------------------- */

const startedAt = Date.now();
const deadline = MINUTES ? startedAt + MINUTES * 60000 : Infinity;
let cursor = 0;
let done = 0;
let ok = 0;
let blockedCount = 0;
let sinceFlush = 0;

function baseOf(record) {
  return {
    name: record.name,
    province: record.province,
    city: record.city ?? '',
    district: record.district ?? '',
    level: record.level ?? '',
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

async function worker(id) {
  let page = await ctx.newPage();
  let cooldown = 0;
  let streak = 0;

  while (cursor < todo.length && Date.now() < deadline) {
    if (cooldown > Date.now()) {
      await sleep(Math.min(5000, cooldown - Date.now()));
      continue;
    }
    const record = todo[cursor++];
    const result = await fetchOne(page, record);

    if (result.status === 'blocked') {
      // 暂停一段时间再继续，间隔随连续失败次数增长；不反复新开浏览器窗口
      blockedCount += 1;
      streak += 1;
      const wait = rand(CD_MIN, CD_MAX) * Math.min(5, 1.7 ** (streak - 1));
      cooldown = Date.now() + wait;
      await page
        .goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
      console.log(`  [tab${id}] 页面暂不可用（本轮连续第 ${streak} 次），暂停 ${Math.round(wait / 1000)}s`);
      if (!record.__retried) {
        record.__retried = true;
        todo.push(record);
      } else {
        store[keyOf(record)] = { ...baseOf(record), query: result.query, status: 'blocked' };
      }
      continue;
    }

    store[keyOf(record)] = {
      ...baseOf(record),
      query: result.query,
      sourceUrl: `https://www.baidu.com/s?wd=${encodeURIComponent(result.query)}`,
      status: result.status,
      ...(result.guide ?? {}),
    };

    streak = 0;
    done += 1;
    if (result.status === 'ok') ok += 1;
    sinceFlush += 1;
    if (sinceFlush >= 5) {
      flush();
      sinceFlush = 0;
      const rate = done / ((Date.now() - startedAt) / 1000);
      const left = todo.length - done;
      console.log(
        `  ${done}/${todo.length} 命中 ${ok}（${((ok / Math.max(done, 1)) * 100).toFixed(0)}%）| ${rate.toFixed(2)} 条/秒 | 剩余约 ${Math.round(left / Math.max(rate, 0.001) / 60)} 分钟`,
      );
    }
    await sleep(rand(DELAY_MIN, DELAY_MAX));
  }
  await page.close().catch(() => {});
}

await Promise.all(Array.from({ length: TABS }, (_, i) => worker(i + 1)));

flush();
const stats = {};
for (const v of Object.values(store)) stats[v.status] = (stats[v.status] ?? 0) + 1;
console.log(
  `\n完成，用时 ${Math.round((Date.now() - startedAt) / 60000)} 分钟`,
  stats,
  blockedCount ? `| 其中页面不可用 ${blockedCount} 次` : '',
);
await ctx.close();
