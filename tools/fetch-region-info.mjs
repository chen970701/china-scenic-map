/**
 * 抓「行政区级别」的介绍与旅游攻略（省 / 市 / 区县三级）。
 *
 * 和景点链路是一套思路，但对象从「景区」换成了「行政区」：
 *   介绍 —— 百度百科开放接口（BaikeLemmaCardApi），词条名就是行政区名；
 *            同名区县（北京朝阳区 / 长春朝阳区）要多试「省+区名」这种写法。
 *   攻略 —— 百度搜索结果页的 AI 卡片，搜「杭州旅游攻略」「西湖区旅游攻略」，
 *            复用 fetch-guides.mjs 的取卡逻辑（同一个 DOM，同一套限流）。
 *
 * 抓完只落 data-src/enrich/regions.json，键是 adcode。
 * 「攻略里提到的景点」不在这里做——要拿景点库做匹配，放构建期（build-regions.mjs）。
 *
 * 用法：
 *   node tools/fetch-region-info.mjs --levels=province                只抓省
 *   node tools/fetch-region-info.mjs --levels=province,city           省 + 市
 *   node tools/fetch-region-info.mjs --levels=city --limit=50         先试 50 个市
 *   node tools/fetch-region-info.mjs --levels=district --minutes=120  区县跑 2 小时
 *   node tools/fetch-region-info.mjs --only=杭州市,西湖区               点名抓（调试用）
 *   node tools/fetch-region-info.mjs --levels=city --info-only        只补介绍、不抓攻略
 *   node tools/fetch-region-info.mjs --levels=city --retry=none,weak  重抓失败的
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEO_INDEX = path.join(ROOT, 'public', 'geo', 'index.json');
const ENRICH_DIR = path.join(ROOT, 'data-src', 'enrich');
const OUT_FILE = path.join(ENRICH_DIR, 'regions.json');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const LEVEL_NAMES = { province: 1, city: 2, district: 3 };
const LEVELS = new Set(
  (argOf('levels', 'province,city') || 'province,city')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
const WANTED = new Set([...LEVELS].map((l) => LEVEL_NAMES[l]).filter(Boolean));
const ONLY = argOf('only')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const LIMIT = Number(argOf('limit', '0')) || 0;
const MINUTES = Number(argOf('minutes', '0')) || 0;
const DELAY_MIN = Number(argOf('delay-min', '3500')) || 3500;
const DELAY_MAX = Number(argOf('delay-max', '7000')) || 7000;
const MIN_CHARS = 180;
const INFO_ONLY = args.includes('--info-only');
const FORCE = args.includes('--force');
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', '4')) || 4);
const DELAY_MS = Number(argOf('delay', '150')) || 150;

/**
 * 持久化 profile：固定一个 Chrome 用户目录，缓存与站点数据跨运行保留，
 * 不必每次运行都从空白会话开始。
 */
const PROFILE_DIR = path.resolve(ROOT, argOf('profile', 'tmpdata/chrome-profile'));
const FRESH_PROFILE = args.includes('--fresh-profile');
const CD_MIN = Number(argOf('cooldown-min', '45000')) || 45000;
const CD_MAX = Number(argOf('cooldown-max', '80000')) || 80000;
/**
 * 每跑一批就停下来歇一会儿，避免长时间连续请求。
 * --batch=0 关掉这个机制。
 */
const BATCH = Number(argOf('batch', '120')) || 0;
const REST_MIN = Number(argOf('rest', '8')) || 8;
const CHROME_PATH =
  argOf('chrome') || process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------ 行政区清单 ------------------------------ */

const index = JSON.parse(fs.readFileSync(GEO_INDEX, 'utf8'));
const byAdcode = new Map();
for (const [adcode, name, parentAdcode, level] of index.nodes) {
  byAdcode.set(adcode, { adcode, name, parentAdcode, level });
}

/**
 * 按「已收录景点数」从多到少排。
 * 市 363 个、区县 2,800 多个，一个不落要跑十几个小时；中途停下时应该先把杭州、南京、
 * 成都这种用户真会去看的地方跑完，而不是按 adcode 从石家庄一路排到新疆。
 * 市的数字是自己下辖区县之和。
 */
function loadPriority() {
  const file = path.join(ROOT, 'public', 'data', 'attractions', 'summary.json');
  const priority = new Map();
  if (!fs.existsSync(file)) return priority;
  try {
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    const districts = summary.districts ?? {};
    for (const [k, v] of Object.entries(districts)) priority.set(Number(k), v);
    // 市的景点数 = 下辖区县之和
    for (const [adcode, node] of byAdcode) {
      if (node.level !== 2) continue;
      let total = 0;
      for (const [child] of byAdcode) {
        const childNode = byAdcode.get(child);
        if (childNode?.parentAdcode === adcode) total += districts[String(child)] ?? 0;
      }
      priority.set(adcode, total);
    }
    return priority;
  } catch {
    return priority;
  }
}

const regionPriority = loadPriority();

/** 往上找第一个指定层级的祖先（直辖市的区县没有「市」这一级，因此要兜底） */
function ancestor(node, level) {
  let cursor = byAdcode.get(node.parentAdcode);
  let guard = 0;
  while (cursor && guard++ < 6) {
    if (cursor.level === level) return cursor;
    cursor = byAdcode.get(cursor.parentAdcode);
  }
  return null;
}

/**
 * 简称：先剥行政区后缀，再连着剥民族名。
 * 「黔东南苗族侗族自治州」只剥一层会剩「黔东南苗族侗族」，问法就成了
 * 「黔东南苗族侗族旅游攻略」——这 6 个自治州搜不到 AI 卡，问法怪异是原因之一。
 */
const ETHNIC_TAIL_RE =
  /(维吾尔|哈萨克|柯尔克孜|土家|布依|纳西|傈僳|拉祜|景颇|布朗|阿昌|普米|德昂|基诺|仡佬|毛南|东乡|保安|裕固|撒拉|锡伯|达斡尔|鄂温克|鄂伦春|门巴|珞巴|高山|仫佬|独龙|壮|回|藏|蒙古|彝|白|傣|苗|哈尼|朝鲜|满|侗|瑶|黎|水|土|羌|佤|怒|畲|京)族$/;
/** 「龙胜各族自治县」「XX民族自治县」里的「各族 / 民族」不是民族名 */
const ETHNIC_LOOSE_RE = /(各族|民族)$/;
/** 「新疆维吾尔自治区」「内蒙古自治区」里的民族名不带「族」字 */
const ETHNIC_NO_SUFFIX_RE = /(维吾尔|蒙古)$/;

const short = (name) => {
  let out = String(name ?? '')
    .replace(/(特别行政区|自治区|自治州|自治县|地区|省|市|区|县|旗|盟)$/, '')
    .replace(ETHNIC_LOOSE_RE, '');
  for (let i = 0; i < 3; i++) {
    const next = out.replace(ETHNIC_TAIL_RE, '').replace(ETHNIC_NO_SUFFIX_RE, '');
    if (next === out || next.length < 2) break;
    out = next;
  }
  return out.trim();
};

const nodes = index.nodes
  .filter(([, , , level]) => WANTED.has(level))
  .map(([adcode, name, parentAdcode, level]) => {
    const node = { adcode, name, parentAdcode, level };
    const provinceNode = level === 1 ? node : ancestor(node, 1);
    const cityNode = level === 2 ? node : ancestor(node, 2);
    return {
      ...node,
      province: provinceNode?.name ?? name,
      city: cityNode?.name ?? provinceNode?.name ?? name,
    };
  })
  .filter((n) => (ONLY.length ? ONLY.some((x) => x === n.name || String(n.adcode) === x) : true))
  // 省 → 市 → 区县；市和区县都按景点数从多到少，中断续跑时先覆盖热门地区
  .sort(
    (a, b) =>
      a.level - b.level ||
      (b.level >= 2 ? (regionPriority.get(b.adcode) ?? 0) - (regionPriority.get(a.adcode) ?? 0) : 0) ||
      a.adcode - b.adcode,
  );

/* ------------------------------ 文本工具 ------------------------------ */

/** 同名区县（西湖区 / 朝阳区 / 鼓楼区 / 市中区…）：攻略必须带市名查，否则一定串到别处 */
const DUP_NAMES = (() => {
  const count = new Map();
  for (const node of nodes) {
    if (node.level !== 3) continue;
    count.set(node.name, (count.get(node.name) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([name]) => name));
})();

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
    const text = normText((field.value ?? field.format ?? []).join(' '));
    if (text) return text;
  }
  return '';
}

/** 行政区介绍里第一句通常是「XX市，简称X，是XX省下辖…」，拿来做一句话定位 */
function firstSentence(text, fallbackLen = 60) {
  const clean = String(text ?? '').replace(/\s+/g, '');
  if (!clean) return '';
  const m = clean.match(/^[\s\S]{10,}?[。！？]/);
  if (m) return m[0];
  return clean.slice(0, fallbackLen);
}

/* ------------------------------ 百科介绍 ------------------------------ */

const API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi';
const lemmaCache = new Map();

async function queryLemma(keyword) {
  if (lemmaCache.has(keyword)) return lemmaCache.get(keyword);
  const url = `${API}?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(keyword)}&bk_length=1500`;
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

/**
 * 区县同名太常见（朝阳区 / 鼓楼区 / 市中区），词条候选要带上父级。
 * 注意百科开放接口只认「词条全名」，是精确查表不是搜索：
 *   「临沂河东区」查不到，「临沂市河东区」能命中（重名区县的义项挂在带市名的别名上）。
 * 所以市名要同时给出「带市字」和「剥后缀」两种写法。
 */
function candidates(node) {
  const list = [node.name];
  const core = short(node.name);
  if (core && core !== node.name) list.push(core);
  if (node.level === 3) {
    list.push(
      `${node.city}${node.name}`,
      `${short(node.city)}${node.name}`,
      `${node.city}${core}`,
      `${short(node.city)}${core}`,
      `${node.province}${node.name}`,
      `${short(node.province)}${node.name}`,
    );
  } else if (node.level === 2) {
    list.push(`${node.province}${core}`, `${short(node.province)}${core}`);
  }
  return [...new Set(list.map((x) => x.trim()))].filter((x) => x.length >= 2 && x.length <= 24);
}

/**
 * 词条是不是这个行政区。
 * 「杭州市」的摘要里一定有「浙江」；「西湖区」的摘要里应有「杭州」或「浙江」。
 * 省级不校验——全国只有一个浙江省。
 */
function addressCheck(node, lemma, haystack) {
  const title = String(lemma.title ?? '');
  const core = short(node.name);
  const titleHit = title === node.name || title === core || title.startsWith(node.name);
  if (node.level === 1) return { ok: titleHit || haystack.includes(core), score: titleHit ? 3 : 1 };
  const provShort = short(node.province);
  const cityShort = short(node.city);
  const provHit = provShort.length >= 2 && haystack.includes(provShort);
  const cityHit = cityShort.length >= 2 && haystack.includes(cityShort);
  const score = (titleHit ? 3 : 0) + (provHit ? 1 : 0) + (cityHit ? 2 : 0);
  // 直辖市：city 与 province 同名，只要命中一次就算
  const ok = node.level === 2 ? cityHit || (provHit && provShort !== cityShort) : cityHit || provHit;
  return { ok, score };
}

async function fetchInfo(node) {
  let best = null;
  let error = false;

  for (const keyword of candidates(node)) {
    let lemma;
    try {
      lemma = await queryLemma(keyword);
    } catch (err) {
      error = true;
      if (String(err.message).includes('429')) await sleep(3000);
      continue;
    }
    if (!lemma) continue;
    if (/^(地市|序号|名称|景区|旅游区|县|区)$/.test(String(lemma.title ?? ''))) continue;

    const abstract = normText(lemma.abstract || lemma.desc || '');
    const card = lemma.card ?? [];
    const place = cardValue(card, ['地理位置', '地址', '所处地区', '所在地区']);
    const check = addressCheck(node, lemma, `${abstract}${place}`);
    const candidate = {
      status: check.ok && abstract.length >= 20 ? 'ok' : 'mismatch',
      keyword,
      title: lemma.title,
      abstract,
      lead: firstSentence(abstract),
      place,
      facts: {
        type: cardValue(card, ['行政区类别', '行政级别']),
        area: cardValue(card, ['面积']),
        population: cardValue(card, ['人口']),
        climate: cardValue(card, ['气候']),
        seat: cardValue(card, ['政府驻地', '驻地']),
        famous: cardValue(card, ['著名景点', '景点']),
      },
      url: lemma.url || `https://baike.baidu.com/item/${encodeURIComponent(lemma.title ?? keyword)}`,
      score: check.score,
    };
    if (candidate.status === 'ok') return candidate;
    if (!best || candidate.score > (best.score ?? -1)) best = candidate;
  }

  if (best) return { ...best, status: 'mismatch' };
  return { status: error ? 'error' : 'notfound' };
}

/* ------------------------------ 攻略 ------------------------------ */

async function waitCard(page, maxTries = 26, step = 500) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxTries; i++) {
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
    if (len === 0 && i >= 14) return 0;
    await page.waitForTimeout(step);
  }
  return Math.max(last, 0);
}

async function readGuide(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.cosc-card')].filter((c) => c.querySelector('.cosd-markdown'));
    const card = cards.sort((a, b) => b.innerText.length - a.innerText.length)[0];
    if (!card) return null;

    const clone = card.cloneNode(true);
    clone
      .querySelectorAll('.cosd-video-scroll, [class*="follow-up-guide"], [class*="cosd-video"]')
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

    const last = sections[sections.length - 1];
    if (last?.items.length && /要不要继续看看|想了解哪方面/.test(last.items[last.items.length - 1])) {
      last.items.pop();
    }

    const JUNK_TITLE = /^(百度地图|高德地图|携程|去哪儿|马蜂窝|美团|飞猪|同程|展开更多|查看更多|更多推荐)/;
    const filled = sections.filter((s) => s.items.length && !JUNK_TITLE.test(s.title));
    const totalChars = filled.reduce((n, s) => n + s.items.join('').length, 0);
    return {
      intro: intro.join(' ').slice(0, 500),
      sections: filled
        .slice(0, 10)
        .map((s) => ({ title: s.title.slice(0, 24), items: s.items.slice(0, 14).map((x) => x.slice(0, 360)) })),
      chars: totalChars + intro.join('').length,
      hasStructure: filled.length >= 1,
    };
  });
}

const isBlocked = (page) =>
  page
    .evaluate(() => /百度安全验证|请完成下方验证/.test(document.body.innerText.slice(0, 400)))
    .catch(() => false);

async function queryOnce(page, q) {
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

/**
 * 省市的攻略问法只要两种：`杭州旅游攻略` 基本必中，`杭州旅游景点攻略` 兜底。
 * 区县要分两类，否则会讲错城市：
 *   - 非重名区县：泛问法 `吉安县旅游攻略` 就能拿到本县的卡，带市名的反而常不出卡
 *     （实测「杭州上城区旅游攻略」「成都武侯区旅游攻略」都是 0 字）。
 *   - 重名区县（西湖区 / 朝阳区 / 鼓楼区 / 市中区…几百个）：泛问法只会给最出名的那一个
 *     （南昌西湖区拿到了杭州西湖整份攻略，988 字一模一样），必须带市名问
 *     `广州白云区旅游攻略`，有卡才用，没有就空着。
 *
 * 剩下的尾巴（56 个）证明了「旅游攻略」这个问法本身有召回缺口：
 * 百度把它理解成「怎么去 / 行程规划」，冷一点的地区干脆不出卡。
 * 换成人话问法「XX有什么好玩的地方」几乎全中——连革吉县、仁布县都有 700–870 字，
 * 所以缺的多半不是冷门，是问法。下面三个是兜底，放在「旅游攻略」全部失败之后才试。
 */
function guideQueries(node) {
  const core = short(node.name);
  const cityCore = short(node.city);
  if (node.level !== 3) return [`${core}旅游攻略`, `${core}旅游景点攻略`];
  const byCity = [
    `${cityCore}${node.name}旅游攻略`,
    // 单字短名的拼接是垃圾（「沧县」→ core「沧」→「沧州沧旅游攻略」），直接不生成
    ...(core.length >= 2 ? [`${cityCore}${core}旅游攻略`] : []),
  ];
  const byName = [`${node.name}旅游攻略`];
  const head = DUP_NAMES.has(node.name) ? byCity : [...byName, ...byCity];
  // 兜底的人话问法同样要分重名：裸问「普陀区一日游」拿到的是上海普陀区（舟山那个被 offtopic 拦下）
  const alt = DUP_NAMES.has(node.name)
    ? [
        `${cityCore}${node.name}有什么好玩的地方`,
        `${cityCore}${node.name}值得去的景点`,
        `${cityCore}${node.name}一日游`,
      ]
    : [`${node.name}有什么好玩的地方`, `${node.name}值得去的景点`, `${node.name}一日游`];
  const list = [...head, ...alt];
  return [...new Set(list.map((x) => x.trim()))].filter((q) => q.length >= 5);
}

/**
 * 攻略是不是在讲这个地区。
 * 「西湖区旅游攻略」这种泛问法拿回来的卡，正文里讲的是哪个城市，就是哪个城市——
 * 所以对**重名**区县，市名是硬条件（杭州卡里不会出现「南昌」）。
 *
 * 但校验收紧过头会误杀：平遥县 / 涞水县 / 江宁区 / 格尔木市 / 伊宁市这些名字本来没有同名冲突，
 * 卡片里讲的是「平遥古城」「江宁织造」，压根不会写「晋中」「南京」「海西」。
 * 所以区县分两档：不重名的，正文提到自己就算过；重名的，还要命中市名。
 * 退一步认「省 + 区县全名」同时出现，覆盖少数只写省的写法。
 */
function guideFitsRegion(node, guide) {
  const text = [
    guide.intro ?? '',
    ...(guide.sections ?? []).map((s) => `${s.title}${(s.items ?? []).join('')}`),
  ].join('');
  const core = short(node.name);
  // 市辖区只能用全名核对：短名会撞上景点名——南昌「青山湖区」的卡片讲的是杭州临安青山湖，
  // 正文里"青山湖"反复出现，用短名判断就一路绿灯放进来了。
  const needFullName = /区$/.test(node.name);
  const nameHit = text.includes(node.name) || (!needFullName && core.length >= 2 && text.includes(core));
  const cityCore = short(node.city);
  const provCore = short(node.province);
  const dup = DUP_NAMES.has(node.name);
  if (!dup && nameHit) return true;
  if (cityCore.length >= 2 && text.includes(cityCore)) return true;
  return provCore.length >= 2 && text.includes(provCore) && nameHit;
}

/**
 * 有时答的不是「这地方有什么好玩的」，而是「怎么过去」——
 * 整张卡是过路费、耗时、高速编号，一个景点都没有（问法被理解成了行程规划）。
 * 这类卡比没有更糟：用户点开只会看到「全程约 1638 公里，耗时 17.2 小时」。
 * 判据只看开头两句，且要求整卡不超过 2 节——正常攻略提到「从某地出发」不算。
 */
const NAV_HEAD = /(交通指南|交通与行程|交通出行|交通方式|交通与路线|自驾路线|总里程|路线规划|怎么抵达|如何抵达|从.{0,14}(出发|前往)|如果您(打算|计划)?从|距离较远)/;
function isNavGuide(guide) {
  if ((guide.sections ?? []).length > 3) return false;
  const head = [guide.intro ?? '', guide.sections?.[0]?.title ?? '', guide.sections?.[0]?.items?.[0] ?? '']
    .join(' ')
    .replace(/\s+/g, '')
    .slice(0, 12);
  return NAV_HEAD.test(head);
}

/**
 * 地区攻略的 AI 卡质量参差：有的只有两三百字，有的上千字。
 * 够 400 字就收，不再为多几十字多等一轮——一个地区多试一次问法就是十几秒，
 * 全区县跑下来会差出好几个小时。
 */
const GOOD_ENOUGH = 400;

async function fetchGuide(page, node) {
  let best = null;
  let q = '';
  let offTopic = 0;
  const queries = guideQueries(node);
  for (const [idx, query] of queries.entries()) {
    q = query;
    let res;
    try {
      res = await queryOnce(page, query);
    } catch (err) {
      res = { status: String(err.message ?? '').includes('Timeout') ? 'none' : 'error' };
    }
    if (res.status === 'blocked') return { status: 'blocked', query: q };
    if (res.guide) {
      // 串味的卡（同名区县拿到别处的攻略）比没有更糟：宁可空着，也不能讲错城市。
      // 导航卡同理——整篇讲「从杭州怎么过去」，一个景点都没有。
      if (!guideFitsRegion(node, res.guide) || isNavGuide(res.guide)) {
        offTopic += 1;
      } else {
        const chars = res.guide.chars ?? 0;
        if (!best || chars > (best.guide.chars ?? 0)) best = { ...res, query };
        if (res.status === 'ok' && chars >= GOOD_ENOUGH) break;
      }
    }
    if (idx < queries.length - 1) await sleep(rand(600, 1200));
  }
  if (!best) return { status: offTopic ? 'offtopic' : 'none', query: q, offTopic };
  return best;
}

/* ------------------------------ 主流程 ------------------------------ */

fs.mkdirSync(ENRICH_DIR, { recursive: true });
const store = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
const flush = () => fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));

const RETRY = new Set(argOf('retry') ? argOf('retry').split(',') : []);
if (RETRY.size) {
  let dropped = 0;
  for (const node of nodes) {
    const hit = store[node.adcode];
    if (!hit) continue;
    // 只清对应那一段：攻略没抓到时不能把介绍一起删了，否则又得重查一遍百科
    if (RETRY.has(hit.status)) {
      delete hit.status;
      delete hit.guide;
      delete hit.query;
      delete hit.sourceUrl;
      dropped += 1;
    }
    if (RETRY.has(hit.infoStatus)) {
      delete hit.infoStatus;
      delete hit.abstract;
      delete hit.lead;
      delete hit.facts;
      dropped += 1;
    }
    if (!hit.infoStatus && !hit.status) delete store[node.adcode];
  }
  if (dropped) console.log(`重试队列：清掉 ${dropped} 段 ${[...RETRY].join('/')} 结果`);
}

const baseOf = (node) => ({
  adcode: node.adcode,
  name: node.name,
  level: node.level,
  province: node.province,
  city: node.city,
  fetchedAt: new Date().toISOString().slice(0, 10),
});

/* 阶段一：介绍（HTTP 接口，快，全部一次跑完） */
let infoTodo = nodes.filter((node) => {
  if (ONLY.length) return true;
  const hit = store[node.adcode];
  if (FORCE) return true;
  return !hit || !hit.abstract;
});
if (LIMIT) infoTodo = infoTodo.slice(0, LIMIT);

console.log(`介绍队列 ${infoTodo.length} 条（已有 ${Object.keys(store).length} 条缓存）`);
let infoDone = 0;
let infoOk = 0;
const infoQueue = [...infoTodo];
async function infoWorker() {
  while (infoQueue.length) {
    const node = infoQueue.shift();
    let result;
    try {
      result = await fetchInfo(node);
    } catch (err) {
      result = { status: 'error', message: String(err.message ?? err) };
    }
    const prev = store[node.adcode] ?? {};
    store[node.adcode] = {
      ...baseOf(node),
      ...prev,
      infoStatus: result.status,
      ...(result.status === 'ok' || result.status === 'mismatch'
        ? {
            keyword: result.keyword,
            title: result.title,
            abstract: result.abstract,
            lead: result.lead,
            place: result.place,
            facts: result.facts,
            infoUrl: result.url,
          }
        : {}),
    };
    infoDone += 1;
    if (result.status === 'ok') infoOk += 1;
    if (infoDone % 30 === 0) {
      flush();
      const rate = infoDone / ((Date.now() - startedAt) / 1000);
      console.log(`  介绍 ${infoDone}/${infoTodo.length} 命中 ${infoOk} | ${rate.toFixed(2)} 条/秒`);
    }
    await sleep(DELAY_MS);
  }
}
const startedAt = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => infoWorker()));
flush();
console.log(`介绍完成：${infoOk}/${infoTodo.length} 命中，用时 ${Math.round((Date.now() - startedAt) / 60000)} 分钟`);

if (INFO_ONLY) process.exit(0);

/* 阶段二：攻略（真实浏览器，慢，可限时） */
const guideTodo = nodes
  .filter((node) => (ONLY.length ? ONLY.some((x) => x === node.name || String(node.adcode) === x) : true))
  .filter((node) => {
    const hit = store[node.adcode];
    // 介绍没抓到就先不抓攻略：没有行政区身份校验的攻略容易是别的同名地区
    if (!hit || !hit.abstract) return false;
    if (hit.guide?.sections?.length) return false;
    // 有结论（ok / none / weak / blocked）默认不重跑，要重跑得显式 --retry
    return FORCE || !hit.status;
  })
  .slice(0, LIMIT || undefined);

console.log(`攻略队列 ${guideTodo.length} 条`);
if (!guideTodo.length) process.exit(0);

const deadline = MINUTES ? Date.now() + MINUTES * 60000 : Infinity;
// 默认单页串行；多标签页同时请求更容易被服务端限流，实际总产出未必更高。
const TABS = Math.max(1, Number(argOf('tabs', '1')) || 1);
let cursor = 0;
let done = 0;
let ok = 0;
let blockedCount = 0;
let flushTick = 0;

// 队列带重排：暂时抓不到的条目先放回队尾，歇一会儿再试一次
const queue = [...guideTodo];

// 目录之前有没有东西，决定日志里说「首次运行」还是「复用目录」
const isNewProfile = FRESH_PROFILE || !fs.existsSync(path.join(PROFILE_DIR, 'Default', 'Network', 'Cookies'));
if (FRESH_PROFILE) {
  if (!PROFILE_DIR.includes('chrome-profile')) {
    console.error(`拒绝清空 ${PROFILE_DIR}：--fresh-profile 只对 …/chrome-profile 目录生效`);
    process.exit(1);
  }
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// 复用 profile 而不是每次新建上下文：站点数据落到磁盘，下次启动直接沿用
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME_PATH,
  locale: 'zh-CN',
  userAgent: UA,
  viewport: { width: 1280, height: 1200 },
  args: ['--disable-dev-shm-usage'],
});

/**
 * 先正常访问一次首页，确认页面能打开再开始，拿不到内容就整轮跳过。
 */
const warmPage = await ctx.newPage();
await warmPage
  .goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  .catch(() => {});
console.log(`  profile ${path.relative(ROOT, PROFILE_DIR)} | ${isNewProfile ? '第一次运行' : '复用已有目录'}`);
if (await isBlocked(warmPage)) console.log('  首页返回了人工校验页，本次抓取可能不完整，可以稍后再跑');
await warmPage.close().catch(() => {});

/**
 * 抓取 worker。一条要 10–20 秒（等页面渲染 + 可能换一次问法）。
 * 默认单页，--tabs 可调，但并发越高被限流的概率越大。
 */
async function worker(id) {
  let page = await ctx.newPage();
  let cooldown = 0;
  let streak = 0;

  while (cursor < queue.length && Date.now() < deadline) {
    if (cooldown > Date.now()) {
      await sleep(Math.min(5000, cooldown - Date.now()));
      continue;
    }
    const node = queue[cursor++];
    if (!node) break;
    const result = await fetchGuide(page, node);

    if (result.status === 'blocked') {
      blockedCount += 1;
      streak += 1;
      // 连续失败次数越多，暂停时间越长；留一段时间让服务端恢复
      const wait = rand(CD_MIN, CD_MAX) * Math.min(5, 1.7 ** (streak - 1));
      cooldown = Date.now() + wait;
      // 不关页面重开：Cookie 在 context 里本来就是共享的，留在原会话回首页更像正常用户，
      // 关页重开反而把「同一会话」的连续性丢了
      await page
        .goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
      console.log(`  [tab${id}] 页面暂不可用（本轮连续第 ${streak} 次），暂停 ${Math.round(wait / 1000)}s`);
      if (!node.__retried) {
        node.__retried = true;
        queue.push(node);
      } else {
        store[node.adcode] = { ...store[node.adcode], status: 'blocked', query: result.query };
      }
      continue;
    }
    streak = 0;

    store[node.adcode] = {
      ...store[node.adcode],
      query: result.query,
      sourceUrl: `https://www.baidu.com/s?wd=${encodeURIComponent(result.query ?? '')}`,
      status: result.status,
      ...(result.guide ? { guide: result.guide } : {}),
    };
    done += 1;
    if (result.status === 'ok') ok += 1;
    flushTick += 1;

    // 到量主动歇一会儿，不要让请求一直连下去
    if (BATCH && done % BATCH === 0 && Date.now() < deadline) {
      flush();
      flushTick = 0;
      console.log(`  已连续 ${done} 条，按窗口额度主动休息 ${REST_MIN} 分钟`);
      await sleep(REST_MIN * 60000);
    }
    if (flushTick >= 3) {
      flush();
      flushTick = 0;
      const rate = done / ((Date.now() - startedAt) / 1000);
      const left = queue.length - cursor;
      console.log(
        `  攻略 ${done}/${queue.length} 命中 ${ok} | ${rate.toFixed(3)} 条/秒 | 剩余约 ${Math.round(left / Math.max(rate, 0.0001) / 60)} 分钟`,
      );
    }
    await sleep(rand(DELAY_MIN, DELAY_MAX));
  }
  await page.close().catch(() => {});
}

await Promise.all(Array.from({ length: TABS }, (_, i) => worker(i + 1)));

flush();
const stats = {};
for (const v of Object.values(store)) stats[v.status ?? '无状态'] = (stats[v.status ?? '无状态'] ?? 0) + 1;
const infoStats = {};
for (const v of Object.values(store)) infoStats[v.infoStatus ?? '无状态'] = (infoStats[v.infoStatus ?? '无状态'] ?? 0) + 1;
console.log('\n介绍状态', infoStats);
console.log('攻略状态', stats, blockedCount ? `| 其中页面不可用 ${blockedCount} 次` : '');
await ctx.close();
