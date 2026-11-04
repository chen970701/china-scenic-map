/**
 * 把「地区介绍 + 地区攻略」构建成前端按需加载的小文件，并从攻略里抠出推荐景点。
 *
 * 输入：data-src/enrich/regions.json（fetch-region-info.mjs 抓的）+ public/data/attractions/*.json
 * 输出：public/data/regions/{adcode}.json
 *
 * 推荐景点为什么要在这里做，而不是抓取时做：
 *   抓取脚本只知道文本，不知道「这个地区到底收录了哪些景点」。先把库读进来，
 *   才能保证推荐出来的每一条都能点、都能在地图上定位——推一个库里没有的名字，
 *   用户点下去没反应，比不推荐更糟。
 *
 * 匹配规则（纯字符串，不用模型，可复现）：
 *   1. 候选名 = 景点全名 + 去行政区前缀 + 去景区后缀 + 括号别称 + `·` 拆段；
 *   2. 长名优先登记，命中后从文本里抹掉，避免「灵隐」抢走「灵隐寺」的次数；
 *   3. 命中处紧跟「区 / 县 / 市 / 镇 / 街道 / 路」时不算——攻略里的「西湖区」
 *      是行政区，不是景点「西湖」；
 *   4. 排序 = 出现次数 × 2 + 等级加权（5A 0.6 / 4A 0.3）+ 首次出现位置。
 *
 * 用法：
 *   node tools/build-regions.mjs            全量构建
 *   node tools/build-regions.mjs --only=330100  只重建一个（调试）
 *   node tools/build-regions.mjs --dry      只打印统计，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENRICH = path.join(ROOT, 'data-src', 'enrich', 'regions.json');
/** 少数地区在百度搜不到 AI 攻略卡，这部分由模型撰写，单独存、只在抓取为空时兜底 */
const AI_ENRICH = path.join(ROOT, 'data-src', 'enrich', 'regions-ai.json');
const ATTRACTIONS = path.join(ROOT, 'public', 'data', 'attractions');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'regions');
const GEO_INDEX = path.join(ROOT, 'public', 'geo', 'index.json');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ONLY = argOf('only')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const DRY = args.includes('--dry');
/** --debug=兰州老街：打印这个景点的候选叫法与命中情况，调匹配规则时用 */
const DEBUG = argOf('debug');
const TOP_N = Number(argOf('top', '12')) || 12;

const regions = JSON.parse(fs.readFileSync(ENRICH, 'utf8'));
const aiRegions = fs.existsSync(AI_ENRICH) ? JSON.parse(fs.readFileSync(AI_ENRICH, 'utf8')) : {};
const geo = JSON.parse(fs.readFileSync(GEO_INDEX, 'utf8'));
const nodeOf = new Map();
for (const [adcode, name, parentAdcode, level] of geo.nodes) nodeOf.set(adcode, { adcode, name, parentAdcode, level });

/* ------------------------------ 景点库 ------------------------------ */

const all = [];
for (const file of fs.readdirSync(ATTRACTIONS)) {
  if (!/^\d+\.json$/.test(file)) continue;
  const bundle = JSON.parse(fs.readFileSync(path.join(ATTRACTIONS, file), 'utf8'));
  for (const item of bundle.items ?? []) {
    if (!item.name || item.name.length < 2) continue;
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue;
    all.push(item);
  }
}

/** adcode → 该地区（含下级）的景点；path 里带了这个 adcode 就算 */
function attractionsUnder(adcode) {
  const level = nodeOf.get(adcode)?.level;
  return all.filter((item) => {
    if (Array.isArray(item.path) && item.path.includes(adcode)) return true;
    if (level === 3) return item.districtAdcode === adcode;
    if (level === 2 && !item.path?.length) return item.districtAdcode === adcode;
    return false;
  });
}

/* ------------------------------ 名字归一 ------------------------------ */

/**
 * 景区 / 场所后缀。百科的「著名景点」和攻略都写短名（「故宫」「清河坊」「天坛」），
 * 库里的正式名却常带一长串后缀（「故宫博物院」「清河坊历史文化街区」「天坛公园」），
 * 不剥掉就永远匹配不上——这是地区推荐稀疏的主因。
 */
const SUFFIX_RE =
  /(历史文化特色街区|历史文化街区|文化特色街区|文化旅游景区|风景旅游区|旅游风景区|文化旅游区|风景名胜区|旅游度假区|旅游景区|游览区|风景区|旅游区|度假区|博物院|博物馆|纪念馆|陈列馆|展览馆|古建筑群|建筑群|街区|步行街|老街|遗址|公园|景区|故居|书院|文化园|博览园)$/;

const noSuffix = (x) => {
  let out = String(x ?? '');
  for (let i = 0; i < 2; i++) {
    const next = out.replace(SUFFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
};

const ADMIN_TAIL_RE = /(特别行政区|自治区|自治州|自治县|地区|省|市|区|县|旗|盟)$/;

/**
 * 港澳的景点名是繁体，攻略正文却是简体（「澳門威尼斯人 The Venetian Macau」vs「澳门威尼斯人」），
 * 直接匹配一个都命中不了——路凼填海区 17 个度假村，推荐数是 0。引整套 opencc 太重，
 * 这里只收景点名里真会出现的字，够用就行；漏掉的字再按需补。
 */
const HANT_TO_HANS = {
  門: '门', 灣: '湾', 園: '园', 館: '馆', 樓: '楼', 觀: '观', 會: '会', 場: '场', 廳: '厅',
  廣: '广', 東: '东', 車: '车', 馬: '马', 島: '岛', 龍: '龙', 鳳: '凤', 華: '华', 藝: '艺',
  術: '术', 歷: '历', 鐵: '铁', 銅: '铜', 銀: '银', 際: '际', 麗: '丽', 賭: '赌', 戲: '戏',
  臺: '台', 檯: '台', 樹: '树', 橋: '桥', 頭: '头', 邊: '边', 區: '区', 亞: '亚', 維: '维',
  納: '纳', 爾: '尔', 蘭: '兰', 薩: '萨', 羅: '罗', 濕: '湿', 陽: '阳', 陰: '阴', 雲: '云',
  電: '电', 話: '话', 訊: '讯', 環: '环', 綠: '绿', 黃: '黄', 紅: '红', 藍: '蓝', 點: '点',
  倫: '伦', 宮: '宫', 閣: '阁', 廈: '厦', 廠: '厂', 業: '业', 產: '产', 專: '专', 獅: '狮',
  匯: '汇', 間: '间', 對: '对', 號: '号', 體: '体', 親: '亲', 樂: '乐', 夢: '梦', 灣: '湾',
  圖: '图', 書: '书', 學: '学', 醫: '医', 藥: '药', 鄉: '乡', 鎮: '镇', 莊: '庄', 崗: '岗',
  嶺: '岭', 峽: '峡', 灘: '滩', 澤: '泽', 溝: '沟', 澗: '涧', 溫: '温', 寶: '宝', 貴: '贵',
  豐: '丰', 興: '兴', 榮: '荣', 義: '义', 聖: '圣', 賢: '贤', 靈: '灵', 應: '应', 慶: '庆',
};
const toSimplified = (text) =>
  String(text ?? '')
    .replace(/[^\u4e00-\u9fa5（）()·•・]/g, '')
    .replace(/[門灣園館樓觀會場廳廣東車馬島龍鳳華藝術歷鐵銅銀際麗賭戲臺檯樹橋頭邊區亞維納爾蘭薩羅濕陽陰雲電話訊環綠黃紅藍點倫宮閣廈廠業產專獅匯間對號體親樂夢圖書學醫藥鄉鎮莊崗嶺峽灘澤溝澗溫寶貴豐興榮義聖賢靈應慶]/g, (ch) => HANT_TO_HANS[ch] ?? ch);


/** 民族名，常粘在景点名末尾（「岜沙原生态苗族文化旅游景区」） */
const ETHNIC_RE =
  /(维吾尔族|壮族|回族|藏族|蒙古族|彝族|白族|傣族|苗族|哈尼族|土家族|朝鲜族|满族|侗族|瑶族|黎族|布依族|水族|土族|羌族|纳西族|傈僳族|拉祜族|佤族|景颇族|布朗族|阿昌族|普米族|怒族|德昂族|基诺族|仡佬族|毛南族|畲族|东乡族|保安族|裕固族|撒拉族|哈萨克族|柯尔克孜族|锡伯族|达斡尔族|鄂温克族|鄂伦春族|门巴族|珞巴族|高山族|京族|仫佬族)$/;

/** 描述性尾巴（「原生态」「文化旅游」「民俗风情」），剥掉才剩得下地名 */
const DESCR_RE = /(原生态|民族风情|民俗风情|民俗文化|文化旅游|特色旅游|乡村旅游|生态旅游|风情|文化|旅游|生态|观光|体验|休闲|度假)+$/;

/**
 * 景点名的几种叫法。攻略里几乎不会写全称（「浙江省杭州市西湖风景名胜区」），
 * 所以要把行政区链、景区后缀、括号别称都剥掉，留下「西湖」「灵隐寺」这种口语名。
 *
 * 返回 { name, protected }：protected 表示这个叫法是从「全名本身」收缩来的
 * （全名 / 全名去括号 / 全名去后缀），它可以是「西湖」这种 2 字专名；
 * 而「中国（杭州）人工智能小镇」剥出来的「杭州」不在其中，后面会被行政区名过滤掉。
 */
function aliasList(item) {
  const raw = String(item.name ?? '').trim();
  const noParen = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
  const map = new Map();
  const push = (x, protect = false) => {
    const v = String(x ?? '')
      .replace(/\s+/g, '')
      .trim();
    if (v.length < 2 || v.length > 20) return;
    map.set(v, map.get(v) || protect);
  };

  push(raw, true);
  push(noSuffix(raw), true);
  push(noParen, true);
  push(noSuffix(noParen), true);

  // 繁体 / 夹英文的名字再生成一份简体中文叫法（「澳門威尼斯人 The Venetian Macau」→「澳门威尼斯人」）
  const hans = toSimplified(raw);
  if (hans && hans !== raw) {
    push(hans, true);
    push(noSuffix(hans), true);
  }

  // 剥掉嵌在开头的行政区链（「杭州市西湖」「浙江省杭州市灵隐寺」）
  let core = noSuffix(noParen);
  for (let i = 0; i < 4; i++) {
    const m = core.match(/^([\u4e00-\u9fa5]{2,8}?(?:省|自治区|市|自治州|地区|盟|县|区|旗|州))/);
    if (!m) break;
    if (core.length - m[1].length < 2) break;
    core = core.slice(m[1].length);
    push(core);
    push(noSuffix(core));
  }

  // 「黔东南州从江加榜梯田景区」这类：行政区链剥完还剩「从江加榜梯田」，
  // 县名常常不带「县」字，正则抓不住，得用全国行政区短名表来切边界。
  // 再往下剥民族名与「原生态 / 文化旅游」这类描述词，才能落到「岜沙」「加榜梯田」
  // 这种攻略里真会写的叫法——不然这些景点永远匹配不上。
  let tailCore = core;
  for (let i = 0; i < 4; i++) {
    const stripped = tailCore
      .replace(ETHNIC_RE, '')
      .replace(DESCR_RE, '')
      .replace(SUFFIX_RE, '')
      // 「肇兴侗文化旅游景区」剥到「肇兴侗」：单字民族简称不是词，一并剥掉
      .replace(/(侗|苗|彝|羌|傣|瑶|畲|壮|回|藏)$/, '');
    if (stripped !== tailCore) {
      tailCore = stripped;
      if (tailCore.length >= 2) push(tailCore);
      continue;
    }
    // 首字是行政区短名（「从江」「凯里」「平塘」）就切掉，剩下的至少留 2 字
    let cut = 0;
    for (let len = 2; len <= 4 && len < tailCore.length; len++) {
      if (ADMIN_SHORT.has(tailCore.slice(0, len))) {
        cut = len;
        break;
      }
    }
    if (cut && tailCore.length - cut >= 2) {
      tailCore = tailCore.slice(cut);
      push(tailCore);
      continue;
    }
    break;
  }

  // 括号里常是真正的口语名（「明故城（三孔）旅游区」→「三孔」），但也可能是「(浙江)」这种省份补充
  const paren = raw.match(/[（(]([^）)]{2,12})[）)]/);
  if (paren) push(paren[1]);

  // 组合景区「大雁塔·大唐芙蓉园」两半都是独立景点
  for (const part of noParen.split(/[·•・]/)) push(part);

  return [...map.entries()].map(([name, protect]) => ({ name, protect }));
}

/**
 * 把开头的行政区链切掉，用来判断「全名减掉别名之后，剩下的还够不够实义」。
 * 与 aliasList 里的切法一致：先用「省 / 市 / 县」这类后缀切，
 * 再用行政区短名表切掉不带后缀的县名（「从江」「凯里」「平塘」）。
 */
function cutAdminPrefix(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 4; i++) {
    const m = out.match(/^([\u4e00-\u9fa5]{2,8}?(?:省|自治区|市|自治州|地区|盟|县|区|旗|州))/);
    if (m) {
      out = out.slice(m[1].length);
      continue;
    }
    let cut = 0;
    for (let len = 2; len <= 4 && len <= out.length; len++) {
      if (ADMIN_SHORT.has(out.slice(0, len))) {
        cut = len;
        break;
      }
    }
    if (!cut) break;
    out = out.slice(cut);
  }
  return out;
}

/** 纯类型词，谁都能叫：攻略里「景区」「博物馆」出现几百次，
 * 拿它们去匹配等于把所有景点都算成推荐。
 */
const GENERIC = new Set([
  '景区',
  '风景区',
  '旅游区',
  '旅游景点',
  '景点',
  '古城',
  '古镇',
  '古村',
  '古街',
  '老街',
  '博物馆',
  '纪念馆',
  '遗址',
  '公园',
  '广场',
  '度假区',
  '度假村',
  '温泉',
  '小镇',
  '山庄',
  '乐园',
  '水乡',
  '步行街',
  '商业街',
  '文化街',
  // OSM 自动导入的碎点，确实有条目就叫这些名字，被当成推荐毫无意义
  '基地',
  '中心',
  '观景台',
  '观景平台',
  '游客中心',
  '停车场',
  '售票处',
  '大门',
  '入口',
  '出口',
  '码头',
  '索道',
  '缆车',
  '栈道',
  '服务区',
]);

/** 全国行政区短名（去省/市/区/县后缀）：用来挡住「杭州」「浙江」这种从景点名里剥出来的地名 */
const ADMIN_SHORT = new Set();
for (const [, name] of geo.nodes) {
  const s = String(name).replace(ADMIN_TAIL_RE, '');
  if (s.length >= 2) ADMIN_SHORT.add(s);
}

const usableAliases = (item) =>
  aliasList(item)
    .filter(({ name, protect }) => {
      if (GENERIC.has(name)) return false;
      // 「中国（杭州）人工智能小镇」剥出的「杭州」：是地名不是景点名
      if (!protect && ADMIN_SHORT.has(name)) return false;
      return true;
    })
    .map(({ name }) => name)
    .sort((a, b) => b.length - a.length);

/* ------------------------------ 文本抹除匹配 ------------------------------ */

const isRegionSuffix = (ch) => '区县市镇乡街道路村旗盟州省'.includes(ch);

/**
 * 在文本里找景点名，返回命中次数和首次位置。
 * masked 用等长的占位符代替已匹配的片段，保证后续短名不会重复吃掉同一段文字。
 */
function countHits(masked, name) {
  let from = 0;
  let count = 0;
  let first = -1;
  let out = masked;
  for (;;) {
    const idx = out.indexOf(name, from);
    if (idx < 0) break;
    const after = out[idx + name.length] ?? '';
    // 「西湖区」不是景点「西湖」
    if (after && isRegionSuffix(after)) {
      from = idx + name.length;
      continue;
    }
    // 「西湖」后面接「景区」多半就是它本人，正常计
    if (first < 0) first = idx;
    count += 1;
    out = out.slice(0, idx) + '\u0000'.repeat(name.length) + out.slice(idx + name.length);
    from = idx + name.length;
  }
  return { count, first, masked: out };
}

/** AI 卡的小节标题常带 emoji（「📅 最佳游玩时间」），统一剥掉，抽屉里排版才整齐 */
const cleanTitle = (title) => {
  const raw = String(title ?? '').trim();
  const stripped = raw.replace(/^[^\u4e00-\u9fa5A-Za-z0-9（(【[]+/, '').trim();
  return stripped || raw;
};

/**
 * 有些卡没有分节结构：整个回答是一段 500 字左右的 intro，里面用 emoji 当小标题
 * （衢江区：「🏞️ 想看山水瀑布，去这些地方 药王山景区：…」「🏘️ 想逛老街古村…」）。
 * 内容是有用的，只是 sections 为空会被判定成「没有攻略」。这里按 emoji 断成小节，
 * 段首到第一个标点作标题，剩下的按句号切条目。切不出两节就放弃，宁可当作没有。
 */
const EMOJI_MARK_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

function explodeFlatGuide(guide) {
  if (!guide?.intro || (guide.sections ?? []).length) return guide;
  const text = String(guide.intro).replace(/\s+/g, ' ').trim();
  if (text.length < 300 || !EMOJI_MARK_RE.test(text)) return guide;

  const chunks = text.split(new RegExp(`(?=${EMOJI_MARK_RE.source})`, 'u')).filter((c) => c.trim());
  const sections = [];
  let intro = '';
  for (const [idx, raw] of chunks.entries()) {
    const lead = new RegExp(`^${EMOJI_MARK_RE.source}`, 'u').test(raw.trim());
    // 开头那段没有 emoji 小标题，是总述，直接当 intro——否则会和分节内容重复一遍
    if (idx === 0 && !lead) {
      intro = raw.trim();
      continue;
    }
    const body = raw.replace(new RegExp(`^${EMOJI_MARK_RE.source}+`, 'u'), '').trim();
    if (body.length < 40) continue;
    const headEnd = body.search(/[：:，。！？]/);
    const title = cleanTitle(body.slice(0, headEnd > 1 && headEnd <= 16 ? headEnd : 12));
    const rest = body.slice(title.length).replace(/^[：:，,、\s]+/, '');
    const items = rest
      .split(/[。！？]\s*/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length >= 8);
    if (title && items.length) sections.push({ title, items });
  }
  if (sections.length < 2) return guide;
  return { ...guide, intro: intro || guide.intro, sections };
}

function recommend(region, items) {
  const guide = region.guide;
  const parts = [guide?.intro ?? '', ...(guide?.sections ?? []).flatMap((s) => [s.title, ...s.items])];
  const guideText = parts.join('\n');

  // 行政区介绍里「著名景点」这一栏也点得出名字，但权重低一档
  const famousText = [region.facts?.famous ?? '', region.lead ?? ''].join('\n');
  if (!guideText.trim() && !famousText.trim()) return [];

  // 候选按名字长度降序：长名先占位，短名才不会把「灵隐寺」的文本拿去算「灵隐」
  // 同时挡掉「景点名 = 本地区自己的名字」：OSM 里有个点位就叫「兰州」（城市节点），
  // 把它当景点推荐给兰州市毫无意义。
  // 只比本地区的名字、且只挡**缩写**过来的别名：「兰州老街景区」剥出的「兰州」要去掉，
  // 但全名本身就叫「西湖」的景点在西湖区必须留着，否则最好的推荐就没了。
  const ownNames = new Set([region.name, String(region.name).replace(ADMIN_TAIL_RE, '')]);
  const queue = [];
  for (const item of items) {
    const raw = String(item.name ?? '').trim();
    if (ownNames.has(raw)) continue;
    const aliases = usableAliases(item).filter((a) => a === raw || !ownNames.has(a));
    if (!aliases.length) continue;
    queue.push({ item, primary: aliases[0], aliases });
  }
  queue.sort((a, b) => b.primary.length - a.primary.length);

  let maskedGuide = guideText;
  let maskedFamous = famousText;
  const found = new Map();

  /**
   * 分两轮扫，是为了防「2 字缩写抢走更准的长名」：
   * 「海瑞故居」会剥出「海瑞」，而攻略里写的其实是「海瑞墓」，
   * 一轮贪心匹配会让故居先吃掉「海瑞墓」里的「海瑞」，真正该推荐的墓反而没了。
   * 第一轮只用全名和 3 字以上别名，第二轮才放开 2 字缩写。
   */
  for (const allowShort of [false, true]) {
    for (const entry of queue) {
      if (found.has(entry.item.id)) continue;
      const aliases = allowShort
        ? entry.aliases
        : entry.aliases.filter((a) => a === entry.item.name || a.length >= 3);
      if (!aliases.length) continue;
      if (DEBUG && !allowShort && String(entry.item.name).includes(DEBUG)) {
        console.log(`  [debug] ${entry.item.name} 别名: ${entry.aliases.join(' / ')}`);
      }
      // 先用主名在攻略里找，找到就够；找不到再用别名（短别名放后面，避免误伤）
      let hit = null;
      let usedName = '';
      for (const alias of aliases) {
        const r = countHits(maskedGuide, alias);
        if (r.count > 0) {
          hit = r;
          usedName = alias;
          maskedGuide = r.masked;
          break;
        }
      }
      let fromFamous = false;
      if (!hit) {
        for (const alias of aliases) {
          const r = countHits(maskedFamous, alias);
          if (r.count > 0) {
            hit = r;
            usedName = alias;
            maskedFamous = r.masked;
            fromFamous = true;
            break;
          }
        }
      }
      if (!hit) continue;

      const levelBonus = entry.item.level === '5A' ? 0.6 : entry.item.level === '4A' ? 0.3 : 0;
      const score = hit.count * 2 + levelBonus + (fromFamous ? 0 : 1);
      // 展示名：把全名里的别名和行政区链、类型后缀都剥掉，什么都不剩才用简称
      // （「浙江省杭州市临安区天目山景区」→「天坛山」这种要退到「天目山」，但
      // 「中国杭帮菜博物馆」剥成「杭帮菜」就没人知道是什么，所以场馆类一律用全名）。
      let rest = entry.item.name.replace(usedName, '');
      for (let i = 0; i < 3; i++) {
        rest = cutAdminPrefix(
          rest
            .replace(SUFFIX_RE, '')
            .replace(ETHNIC_RE, '')
            .replace(DESCR_RE, '')
            .replace(/[（）()“”"\s·]/g, ''),
        );
      }
      const isVenue = /(馆|院|园)$/.test(entry.item.name);
      // 剥完只剩一个类型前缀的（「海口热带农业科技博览园」→「海口热带农业科技」）读起来是半截话，
      // 「海口骑楼老街」→「海口骑楼」还能认，所以只挡掉以这些泛词收尾的截断
      const BAD_TAIL = /(科技|文化|农业|工业|旅游|示范|商务|体育|教育|服务|产业|创业|物流|休闲|博览|会展|艺术|影视|生态|观光)$/;
      const display =
        !isVenue && !BAD_TAIL.test(usedName) && usedName.length >= 2 && rest.length === 0
          ? usedName
          : entry.item.name;
      found.set(entry.item.id, {
        id: entry.item.id,
        name: entry.item.name,
        matched: display,
        level: entry.item.level ?? '',
        hits: hit.count,
        fromGuide: !fromFamous,
        score,
        first: hit.first,
      });
    }
  }

  const ranked = [...found.values()].sort((a, b) => b.score - a.score || a.first - b.first);

  // 库里同一个地方常有两条：名字互相包含的（「宋城」/「杭州宋城旅游区」），
  // 或者只差「省 / 市 / 博物院 / 博物馆」这类通用词的（「福建博物院」/「福建省博物馆」）；
  // 归一后 key 相同的算一处，只留分数高的。
  const dedupKey = (name) =>
    String(name)
      .replace(/(博物院|博物馆|纪念馆|美术馆|展览馆|景区|风景区|旅游区|森林公园|湿地公园|遗址公园|公园|广场|省|市|区|县)/g, '')
      .trim();
  const kept = [];
  for (const r of ranked) {
    const key = dedupKey(r.matched);
    const dup = kept.find(
      (k) =>
        k.matched.includes(r.matched) ||
        r.matched.includes(k.matched) ||
        (key.length >= 2 && key === dedupKey(k.matched)),
    );
    if (!dup) kept.push(r);
  }

  // 没等级、攻略里也只出现一次的，多是 OSM 里的细碎点位（「水榭戏台」「张真君祖殿」）。
  // 不是不能推荐，但别让它们把真正的景区挤下去，最多保留 3 个。
  const result = [];
  let weak = 0;
  for (const r of kept) {
    // OSM 自动导入的街道点（就叫「中山路」）和没等级的 2 字碎点（「石刻」）不该占推荐位；
    // 有等级的两字景点（「邛海」「西湖」）照常保留
    if (!r.level && r.matched.length <= 2) continue;
    if (!r.level && r.matched.length <= 4 && /(路|街|巷)$/.test(r.matched)) continue;
    if (!r.level && r.hits < 2) {
      weak += 1;
      if (weak > 3) continue;
    }
    result.push(r);
    if (result.length >= TOP_N) break;
  }
  return result;
}

/* ------------------------------ 输出 ------------------------------ */

const out = [];
let wrote = 0;
let recTotal = 0;
const skipped = [];

for (const [key, region] of Object.entries(regions)) {
  const adcode = Number(key);
  if (ONLY.length && !ONLY.includes(String(adcode)) && !ONLY.includes(region.name)) continue;

  // 介绍必须是「校验通过」的：mismatch 是「查到了词条但省市对不上」，宁可不显示
  const infoOk = region.infoStatus === 'ok' && (region.abstract ?? '').length >= 20;
  // 接口给的 abstract 有约 400 字上限，超了就被切成「明称...」这种半句；
  // introFull 是从词条页摘要段补下来的完整版（tools/fetch-region-intro-full.mjs）。
  // 判据用「是否完整收尾」而不是比长度：有 42 条网页摘要比接口那段还短几十字，
  // 但接口那段是硬切进下一段开头的，短的那份才是完整的话。
  const fullOk =
    (region.introFull ?? '').length >= 200 && !/(\.\.\.|…)\s*$/.test(String(region.introFull).trim());
  const introText = fullOk ? region.introFull : region.abstract;

  // 攻略优先用抓到的；抓不到、或者抓到的明显不完整时，才用模型撰写的那份兜底。
  // 阈值不是拍脑袋：百度 AI 卡正常是 4–8 节、800–1,500 字，低于 4 节或 600 字的多是
  // 「一句话路线 + 三条美食」的残卡（凉山 3 节 321 字、黄南 2 节 663 字），
  // 与其展示这种，不如用结构化更完整的兜底版，并在界面上注明来源。
  const regionGuide = explodeFlatGuide(region.guide);
  const searchSections = regionGuide?.sections?.length ?? 0;
  const searchChars = (regionGuide?.sections ?? []).reduce((n, s) => n + s.items.join('').length, 0);
  const searchUsable = searchSections >= 4 && searchChars >= 600;
  const authored = aiRegions[key]?.guide?.sections?.length ? aiRegions[key] : null;
  // 介绍同理：全国 2,837 个区县里有 21 个是「重名小市辖区」（四平铁西区、辽源龙山区、
  // 鹤岗南山区…），百科只有同名大区的义项、没有它们的独立词条，接口按语义就不该返回，
  // 强抓只会拿到错的城市。这类由模型补写定性介绍，不写面积人口等易错数字。
  // 还有一类是「词条同名但不是同一个东西」：攀枝花东区拿到的是网名「攀枝花东区」的博主简介，
  // 身份校验只看市名是否命中，拦不住。这种在 regions-ai.json 里写 `info.override = true` 强制替换。
  const authoredInfo = aiRegions[key]?.info?.intro ? aiRegions[key].info : null;
  const useModelInfo = Boolean(authoredInfo) && (!infoOk || authoredInfo.override === true);

  const guideSource = searchUsable ? 'search' : authored ? 'model' : searchSections ? 'search' : null;
  const guide = guideSource === 'search' ? regionGuide : guideSource === 'model' ? authored.guide : null;
  const guideReason = guideSource === 'model' ? (searchSections ? 'thin' : 'none') : '';
  const effective = guide && guide !== regionGuide ? { ...region, guide } : region;
  const guideOk = Boolean(guide?.sections?.length);
  if (!infoOk && !useModelInfo && !guideOk) {
    skipped.push(region.name);
    continue;
  }

  const items = attractionsUnder(adcode);
  const recommended = recommend(effective, items);

  const payload = {
    adcode,
    name: region.name,
    level: region.level,
    province: region.province,
    city: region.city,
    generatedAt: new Date().toISOString().slice(0, 10),
    ...(infoOk && !useModelInfo
      ? {
          lead: region.lead || (region.abstract ?? '').slice(0, 80),
          intro: introText,
          facts: Object.fromEntries(Object.entries(region.facts ?? {}).filter(([, v]) => v)),
          introSource: { label: '百度百科', url: region.infoUrl ?? '' },
        }
      : useModelInfo
        ? {
            lead: authoredInfo.lead ?? '',
            intro: authoredInfo.intro,
            facts: {},
            introSource: { label: '模型整理', url: '' },
          }
        : {}),
    ...(guideOk
      ? {
          guide: {
            intro: guide.intro ?? '',
            sections: guide.sections.map((s) => ({ ...s, title: cleanTitle(s.title) })),
            sourceUrl: guideSource === 'search' ? region.sourceUrl ?? '' : '',
            sourceLabel: guideSource === 'search' ? '百度 AI 摘要' : '模型整理',
            author: guideSource,
            ...(guideReason ? { reason: guideReason } : {}),
          },
        }
      : {}),
    recommended,
    stats: {
      attractions: items.length,
      byLevel: items.reduce((acc, it) => {
        if (it.level) acc[it.level] = (acc[it.level] ?? 0) + 1;
        return acc;
      }, {}),
      inGuide: recommended.filter((r) => r.fromGuide).length,
    },
  };

  recTotal += recommended.length;
  if (!DRY) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${adcode}.json`), JSON.stringify(payload));
    wrote += 1;
  }
  out.push(payload);
}

const withInfo = out.filter((x) => x.intro).length;
const withGuide = out.filter((x) => x.guide).length;
const withModel = out.filter((x) => x.guide?.author === 'model').length;
const avgRec = out.length ? (recTotal / out.length).toFixed(1) : '0';
console.log(
  `地区 ${out.length} 个：介绍 ${withInfo}、攻略 ${withGuide}（其中模型整理 ${withModel}）、平均推荐 ${avgRec} 个景点` +
    `${DRY ? '（dry run，未写文件）' : `，写入 ${wrote} 个文件`}`,
);
if (skipped.length) console.log(`跳过 ${skipped.length} 个（介绍和攻略都没有）：${skipped.slice(0, 10).join('、')}`);

if (ONLY.length && out.length) {
  const sample = out[0];
  console.log('\n样例', sample.name, '| 攻略提到', sample.recommended.length, '个已收录景点');
  for (const r of sample.recommended.slice(0, 8)) {
    console.log(`  ${r.name}（${r.matched}${r.level ? ' · ' + r.level : ''}）出现 ${r.hits} 次`);
  }
}
