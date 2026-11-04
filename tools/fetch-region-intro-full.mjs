/**
 * 把「被截断的地区介绍」补全。
 *
 * 背景：百科开放接口 `BaikeLemmaCardApi` 返回的 `abstract` 有约 400 字硬上限，
 * 超出的部分直接被切掉并以「...」结尾。3,234 个地区里有 2,336 个是这样断在半句的
 * （河北省那条断在「明称...」）。但同一个词条的**网页摘要段**是完整的（400–800 字），
 * 只是接口不给。所以这里用持久化 profile 打开词条页，把 `.J-summary` 里的几段摘要取下来。
 *
 * 只读不写死：结果落 `regions.json` 的 `introFull`，原来的 `abstract` 原样保留，
 * 构建期优先用 `introFull`、没有才退回 `abstract`，随时可以回滚。
 *
 * 用法：
 *   node tools/fetch-region-intro-full.mjs --limit=20            先试 20 条
 *   node tools/fetch-region-intro-full.mjs --minutes=60          跑一小时（断点续跑）
 *   node tools/fetch-region-intro-full.mjs --only=河北省,东城区    点名补
 *   node tools/fetch-region-intro-full.mjs --all                 连没截断的也重取（一般不用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENRICH_DIR = path.join(ROOT, 'data-src', 'enrich');
const REGION_FILE = path.join(ENRICH_DIR, 'regions.json');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ONLY = argOf('only')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const LIMIT = Number(argOf('limit', '0')) || 0;
const MINUTES = Number(argOf('minutes', '0')) || 0;
const DELAY_MIN = Number(argOf('delay-min', '900')) || 900;
const DELAY_MAX = Number(argOf('delay-max', '1800')) || 1800;
const BATCH = Number(argOf('batch', '150')) || 0;
const REST_MIN = Number(argOf('rest', '5')) || 5;
const CD_MIN = Number(argOf('cooldown-min', '60000')) || 60000;
const CD_MAX = Number(argOf('cooldown-max', '95000')) || 95000;
const ALL = args.includes('--all');
const CHROME_PATH =
  argOf('chrome') || process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.resolve(ROOT, argOf('profile', 'tmpdata/chrome-profile'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const log = (...xs) => console.log(...xs);

const store = JSON.parse(fs.readFileSync(REGION_FILE, 'utf8'));
const all = Object.values(store);

/** 被切过的：以省略号收尾。接口切的时候固定用三个点。 */
const truncated = (entry) => /(\.\.\.|…)\s*$/.test(String(entry.abstract ?? '').trim());

const short = (name) =>
  String(name ?? '')
    .replace(/(特别行政区|自治区|自治州|自治县|地区|省|市|区|县|旗|盟)$/, '')
    .replace(/(维吾尔|哈萨克|柯尔克孜|土家|布依|纳西|傈僳|拉祜|景颇|布朗|阿昌|普米|德昂|基诺|仡佬|毛南|东乡|保安|裕固|撒拉|锡伯|达斡尔|鄂温克|鄂伦春|门巴|珞巴|高山|仫佬|独龙|各族|壮|回|藏|蒙古|彝|白|傣|苗|哈尼|朝鲜|满|侗|瑶|黎|水|土|羌|佤|怒|畲|京)(族)?$/, '')
    .trim();

/**
 * 摘要段之间是同一段话被切成几块，直接连起来就通顺；
 * 但每一段末尾残留的「[12]」「[3-5]」引用角标要清掉，否则读起来像乱码。
 */
function tidy(text) {
  let out = String(text ?? '')
    .replace(/\[\d+(?:\s*-\s*\d+)?\]/g, '')
    .replace(/\[ citation needed \]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 页面里的「展开」「收起」这类按钮文字会混进 innerText
  out = out.replace(/(展开|收起)$/g, '').trim();
  // 去掉角标后会留下「HeBei Province 」这种尾随空格，中文之间也被撑开，统一收紧
  out = out
    .replace(/\s+([，。、；：）】」』！？])/g, '$1')
    .replace(/([，。、；：！？（【「『])\s+/g, '$1')
    .replace(/([\u4e00-\u9fa5])\s+(?=[（(])/g, '$1')
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    // 「故名河南。。中华人民共和国省级行政区」：摘要段之间有句号叠在一起
    .replace(/。{2,}/g, '。')
    .replace(/，{2,}/g, '，')
    .replace(/\s{2,}/g, ' ');
  return out;
}

/** 段落去重：同一句在摘要里可能出现两次（导语 + 正文首段） */
function joinParts(parts) {
  const seen = new Set();
  const keep = [];
  for (const raw of parts) {
    const p = tidy(raw);
    if (p.length < 20) continue;
    const key = p.slice(0, 40);
    if (seen.has(key)) continue;
    if (keep.some((k) => k.includes(p))) continue;
    seen.add(key);
    keep.push(p);
  }
  return keep.join('');
}

const PLACE_RE = (entry) => {
  const core = short(entry.name);
  const full = entry.name;
  return { core, full };
};

function fits(entry, text) {
  const { core, full } = PLACE_RE(entry);
  if (text.includes(full)) return true;
  if (core.length >= 2 && text.includes(core)) return true;
  // 少数词条开头就是全称但被括号注释打断，退一步看省名
  const prov = short(entry.province);
  return prov.length >= 2 && entry.level !== 1 && text.includes(prov);
}

async function readSummary(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.J-summary');
    if (!box) return [];
    return [...box.querySelectorAll('[class*="summary"]')]
      .map((el) => el.innerText ?? '')
      .filter((t) => t.trim().length > 20);
  });
}

/**
 * 多义词页：唐山市、邢台市、承德市这些「XX市」都是多义词，
 * 直接打开 /item/唐山市 只给一个「请选择义项」的空壳（body 500 字），没有 .J-summary。
 * 义项链接长这样：/item/唐山市/8404217?fromModule=disambiguation，
 * 文本是义项描述（「河北省辖地级市」/「焦立松2025年演唱歌曲」）。按描述打分挑行政区那一条。
 */
function scoreOption(desc, entry) {
  let s = 0;
  const prov = short(entry.province || '');
  const city = short(entry.city || '');
  const self = short(entry.name);
  if (prov.length >= 2 && desc.includes(prov)) s += 5;
  if (city.length >= 2 && desc.includes(city)) s += 4;
  if (self.length >= 2 && desc.includes(self)) s += 1;
  if (/省|市|区|县|洲|盟|旗|辖/.test(desc)) s += 2;
  if (/歌曲|专辑|小说|电影|电视剧|纪录片|游戏|漫画|动画|图书|杂志|品牌|公司|人物|演员|歌手|作家|教授/.test(desc)) s -= 8;
  return s;
}

async function pickOption(page, entry) {
  const options = await page
    .evaluate(() =>
      [...document.querySelectorAll('a[href*="fromModule=disambiguation"]')].map((a) => ({
        href: a.getAttribute('href') || '',
        desc: (a.innerText || '').replace(/\s+/g, ' ').trim(),
      })),
    )
    .catch(() => []);
  if (!options.length) return null;
  const scored = options
    .map((o) => ({ ...o, score: scoreOption(o.desc, entry) }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0] : null;
}

/* ------------------------------ 队列 ------------------------------ */

// --tidy：只把已抓到的 introFull 用最新清洗规则过一遍，不联网。
// 抓取规则改过之后跑一次就行，不用为了「去掉多余空格」把几千条重抓。
if (args.includes('--tidy')) {
  let changed = 0;
  for (const entry of all) {
    if (!entry.introFull) continue;
    const next = tidy(entry.introFull);
    if (next !== entry.introFull) {
      entry.introFull = next;
      entry.introFullLen = next.length;
      changed += 1;
    }
  }
  fs.writeFileSync(REGION_FILE, JSON.stringify(store, null, 1));
  log(`清洗完成：${changed} 条有改动。`);
  process.exit(0);
}

const queue = (ONLY.length ? all.filter((e) => ONLY.includes(e.name)) : all)
  .filter((e) => e.infoStatus === 'ok')
  .filter((e) => ALL || truncated(e))
  // 补过的就不再补：判据是「新的这段是不是完整收尾」，不是比长度。
  // 有 42 条网页摘要本身就比接口那段短几十字（接口是把摘要硬切到 400，切进了下一段开头），
  // 但网页这段是完整的，不能因为短就丢掉。
  .filter((e) => ALL || !e.introFull || /(\.\.\.|…)\s*$/.test(String(e.introFull).trim()))
  .sort((a, b) => (a.level ?? 9) - (b.level ?? 9) || a.adcode - b.adcode);

log(`待补介绍 ${queue.length} 条（共 ${all.length} 个地区，${all.filter(truncated).length} 条被截断）`);
if (!queue.length) {
  log('没有需要补的，退出。');
  process.exit(0);
}

/* ------------------------------ 抓取 ------------------------------ */

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME_PATH,
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 1000 },
});
const page = await ctx.newPage();

const started = Date.now();
const deadline = MINUTES ? started + MINUTES * 60000 : Infinity;

let done = 0;
let improved = 0;
let failed = 0;
let blocked = 0;
let written = 0;
let inBatch = 0;
let stop = false;

function persist() {
  fs.writeFileSync(REGION_FILE, JSON.stringify(store, null, 1));
  written += 1;
}

for (const [idx, entry] of queue.entries()) {
  if (stop) break;
  if (Date.now() > deadline) {
    log('\n到时间了，先停。下次跑同一条命令会从断点继续。');
    break;
  }
  if (LIMIT && done >= LIMIT) {
    log(`\n已达 --limit=${LIMIT}，停。`);
    break;
  }

  const keyword = entry.keyword || entry.title || entry.name;
  const url = 'https://baike.baidu.com/item/' + encodeURIComponent(keyword);
  let parts = [];
  let err = '';
  let viaDisambig = '';

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    if (/安全验证|百度安全/.test(title)) {
      blocked += 1;
      const cd = rand(CD_MIN, CD_MAX);
      log(`  ⚠ 页面返回校验页（第 ${blocked} 次），暂停 ${Math.round(cd / 1000)} 秒`);
      await page.goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(cd);
      continue;
    }
    // 别用「等 .J-summary 超时 → 再判断多义词」：多义词页永远等不到那个选择器，
    // 等于每条白等 6 秒。改成等「摘要 or 多义词提示」哪个先出现，正常页 0.3–1 秒就返回。
    const mode = await page
      .waitForFunction(
        () => {
          if (document.querySelector('.J-summary')) return 'summary';
          const text = document.body?.innerText || '';
          if (/本词条是一个多义词|多义词，请在下列义项/.test(text)) return 'disambig';
          return false;
        },
        { timeout: 8000, polling: 200 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);

    if (mode === 'summary') {
      parts = await readSummary(page);
    } else if (mode === 'disambig') {
      // 多义词：挑「河北省辖地级市」这类义项，跳过「焦立松2025年演唱歌曲」
      const option = await pickOption(page, entry);
      if (option?.href) {
        const next = new URL(option.href, 'https://baike.baidu.com').toString();
        await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.J-summary', { timeout: 8000 }).catch(() => {});
        parts = await readSummary(page);
        if (parts.length) viaDisambig = option.desc.slice(0, 16);
      }
    } else if (err === '') {
      err = '页面无摘要也没多义词提示';
    }
  } catch (e) {
    err = String(e.message ?? '').split('\n')[0].slice(0, 60);
  }

  done += 1;
  inBatch += 1;

  if (!parts.length) {
    failed += 1;
    entry.introFullStatus = 'miss';
    if (err) log(`  ✗ ${entry.adcode} ${entry.name} | ${err}`);
  } else {
    const text = joinParts(parts);
    if (text.length < 60 || !fits(entry, text)) {
      failed += 1;
      entry.introFullStatus = 'mismatch';
      log(`  ✗ ${entry.adcode} ${entry.name} | 摘要不匹配（${text.length} 字）`);
    } else {
      const before = (entry.abstract ?? '').length;
      entry.introFull = text;
      entry.introFullLen = text.length;
      entry.introFullAt = new Date().toISOString().slice(0, 10);
      delete entry.introFullStatus;
      if (viaDisambig) entry.introDisambig = viaDisambig;
      if (text.length > before + 20) improved += 1;
      log(
        `  ✓ ${entry.adcode} ${entry.name} | ${before} → ${text.length} 字${viaDisambig ? `（多义词→${viaDisambig}）` : ''}`,
      );
    }
  }

  if (done % 10 === 0) persist();
  if (BATCH && inBatch >= BATCH) {
    persist();
    inBatch = 0;
    log(`\n—— 主动歇 ${REST_MIN} 分钟（已处理 ${done} 条）——\n`);
    await sleep(REST_MIN * 60000);
  }

  const elapsed = (Date.now() - started) / 1000;
  const rate = done / Math.max(elapsed, 1);
  if (done % 20 === 0) {
    const left = queue.length - idx - 1;
    log(
      `进度 ${done}/${queue.length} | 补全 ${improved} | 失败 ${failed} | ${rate.toFixed(2)} 条/秒 | 预计剩 ${Math.round(left / Math.max(rate, 0.01) / 60)} 分钟`,
    );
  }

  await sleep(rand(DELAY_MIN, DELAY_MAX));
}

persist();
await ctx.close().catch(() => {});

log(
  `\n完成：处理 ${done} 条，补全 ${improved} 条，失败 ${failed} 条，页面不可用 ${blocked} 次，落盘 ${written} 次。`,
);
const remain = Object.values(store).filter(
  (e) => e.infoStatus === 'ok' && truncated(e) && (!e.introFull || (e.introFull ?? '').length < (e.abstract ?? '').length),
).length;
log(`仍待补：${remain} 条。`);
