/**
 * 省级 A 级景区名录抓取 + 归一
 *
 * 输入：data-src/a-level/sources.json（每省一条或多条来源）
 * 输出：data-src/a-level/provincial.json
 *
 * 统一字段：
 *   { name, level, province, city, district, adcode, path, source, title, fetchedAt }
 * 这里只负责"拿到名册"，坐标另由 OSM 匹配（tools/locate-provincial.mjs）。
 *
 * 用法：node tools/fetch-provincial-a-level.mjs [省名...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WordExtractor from 'word-extractor';
import { parseWorkbook, parseHtmlTables, parseRows, parseGroupedTable, normLevel } from './lib/parse-a-list.mjs';
import { parsePdfTables } from './lib/parse-pdf-list.mjs';
import { grabDataTable } from './lib/grab-table.mjs';
import { createAdminIndex } from './lib/admin-match.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'data-src', 'a-level', 'sources.json');
const CACHE = path.join(ROOT, 'tmpdata', 'prov', 'raw');
const OUT = path.join(ROOT, 'data-src', 'a-level', 'provincial.json');
fs.mkdirSync(CACHE, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function curlBuffer(url, referer, timeout = 60) {
  const args = ['-sL', '--compressed', '-m', String(timeout), '-A', UA, '-H', 'Accept-Language: zh-CN,zh;q=0.9'];
  if (referer) args.push('-e', referer);
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, {
    encoding: 'buffer',
    maxBuffer: 80 * 1024 * 1024,
    timeout: (timeout + 10) * 1000,
  });
  return stdout;
}

function decodeHtml(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  return bad > 15 ? new TextDecoder('gb18030').decode(buf) : utf8;
}

/** 解析 doc 正文：制表符分隔的行，形如「南岳衡山旅游区\t衡阳市\t5A」 */
async function parseDocTab(buf, filePath) {
  fs.writeFileSync(filePath, buf);
  const extractor = new WordExtractor();
  const doc = await extractor.extract(filePath);
  const text = doc.getBody();
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\u3000/g, ' ').trim();
    if (!line) continue;
    const cells = line.split(/\t+/).map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length < 2) continue;
    const level = cells.map(normLevel).find(Boolean);
    if (!level) continue;
    // 等级列之前的第一格是景区名（序号列是纯数字，跳过），后面带「市/州」的格子才是所在地
    const levelIdx = cells.findIndex((c) => normLevel(c));
    const head = cells.slice(0, levelIdx);
    let name = head.find((c) => c.length > 1 && !/^\d+$/.test(c));
    if (!name) continue;
    // 湖南这份表城市列写的是「张家界」「长沙」这种简称，不能靠后缀判断
    let cityName = head.find((c) => c !== name) ?? '';
    // 有些行把等级插在城市前面（「衡阳耒阳市蔡伦纪念园景区 | 4A | 耒阳市」）
    if (!cityName) cityName = cells.slice(levelIdx + 1).find((c) => /(市|州|县|区|旗|盟)$/.test(c)) ?? '';
    if (!cityName) {
      // 「岳阳市」「雁峰区」这种单格是分组小标题
      if (admin.isAdminName(name)) continue;
      // 合并单元格会把景区名和所在地粘成一格（「汉寿县…景区常德市」），按尾部城市名拆开
      const split = admin.splitTrailingCity(name);
      if (!split) continue;
      name = split.head;
      cityName = split.city;
    }
    records.push({ name, level, cityName, districtName: '', announceDate: '', address: '' });
  }
  return records;
}

/** 从来源标题推等级（上海按等级分页发布，表头里没有等级列） */
function levelFromTitle(title) {
  const m = String(title).match(/([1-5])\s*A\s*级/);
  return m ? `${m[1]}A` : '';
}

/**
 * PDF 名录：落盘后用 pdfplumber 抽表格再解析
 * （PDF 里的表格用文本流切行不可靠，必须走真实表格结构）
 */
async function parsePdf(buf, src) {
  const safe = `${src.province}-${Buffer.from(src.title).toString('hex').slice(0, 8)}.pdf`;
  const pdfPath = path.join(CACHE, safe);
  const jsonPath = pdfPath.replace(/\.pdf$/i, '.tables.json');
  fs.writeFileSync(pdfPath, buf);
  await execFileAsync('python', [path.join(ROOT, 'tools', 'lib', 'pdf_tables.py'), pdfPath, '--json', jsonPath], {
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return parsePdfTables(data).records;
}

/** 地址里抠区县名：上海只有「景区地址」列，如「黄浦区人民大道201号」 */
function districtFromAddress(address) {
  if (!address) return '';
  // 「广西壮族自治区南宁市青秀区凤岭南路」不先剥省级前缀，会抠出「广西壮族自治区」
  const s = String(address)
    .replace(/^[\u4e00-\u9fa5]{2,10}?(?:省|自治区|特别行政区)/, '')
    .replace(/^(北京|上海|天津|重庆)(市)?/, '');
  const m = s.match(/^(.{2,8}?(?:区|县))/);
  if (m) return m[1];
  const m2 = s.match(/^(.{2,8}?(?:区|县|市))/);
  return m2 ? m2[1] : '';
}

const admin = createAdminIndex();
const sources = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const only = process.argv.slice(2);
const targets = only.length ? sources.filter((s) => only.some((p) => s.province.includes(p) || p.includes(s.province))) : sources;

const all = [];
const summary = [];

for (const src of targets) {
  const tag = `${src.province}/${src.title}`.slice(0, 70);
  process.stdout.write(`${tag.padEnd(72)} `);
  let records = [];
  try {
    const defaultLevel = levelFromTitle(src.title);

    // 分页查询型（DataTables）用内核抓，不需要先 curl
    if (src.kind === 'datatable') {
      const rows = await grabDataTable(src.url, {
        maxPages: src.maxPages ?? 40,
        onProgress: (m) => process.stdout.write(`${m} `),
      });
      records = parseRows(rows, defaultLevel).records;
    } else if (src.kind === 'local-rows') {
      // 需要逐表翻页点击才能拿全的站（江苏），抓取结果先落成行数组快照，
      // 由 tools/grab-jiangsu.mjs 生成，这里只负责解析
      const rows = JSON.parse(fs.readFileSync(path.join(ROOT, src.file), 'utf8'));
      records = parseRows(rows, defaultLevel).records;
    } else {
      const buf = await curlBuffer(src.url, src.page);
      if (!buf.length) throw new Error('空响应');

      if (src.kind === 'xlsx') {
        records = parseWorkbook(buf, defaultLevel).records;
      } else if (src.kind === 'html-table') {
        records = parseHtmlTables(decodeHtml(buf), defaultLevel).records;
      } else if (src.kind === 'html-grouped') {
        // 统计年鉴的旅游章节：等级靠分组标题行切换，且常拆成「续表1..N」多页，
        // 等级状态要跨页延续，所以这里按页顺序解析、共用一个 state
        const pages = src.pages?.length ? src.pages : [src.url];
        const state = {};
        const collected = [];
        for (const pageUrl of pages) {
          const pageBuf = pageUrl === src.url ? buf : await curlBuffer(pageUrl, src.page);
          const parsed = parseGroupedTable(decodeHtml(pageBuf), state);
          collected.push(...parsed.records);
        }
        records = collected;
      } else if (src.kind === 'doc-tab') {
        const safe = `${src.province}-${Buffer.from(src.title).toString('hex').slice(0, 8)}.doc`;
        records = await parseDocTab(buf, path.join(CACHE, safe));
      } else if (src.kind === 'pdf') {
        records = await parsePdf(buf, src);
      } else {
        throw new Error(`未知类型 ${src.kind}`);
      }
    }
  } catch (error) {
    console.log(`失败：${error.message?.slice(0, 60)}`);
    summary.push({ province: src.province, title: src.title, ok: false, error: error.message });
    continue;
  }

  // 落界
  let exact = 0;
  let approx = 0;
  let fail = 0;
  const merged = [];
  for (const r of records) {
    // 极少数条目名录和地址都给不出归属（青海湖景区地址写的是「大通山、日月山之间」），
    // 允许来源配置里写死，理由记在 sources.json 的 overrides 里
    const override = src.overrides?.[r.name];
    if (override) {
      const hit = admin.resolve({ province: src.province, cityName: override.cityName, districtName: override.districtName });
      if (!hit) {
        fail += 1;
        continue;
      }
      const cleanPath = hit.path.filter((a) => a !== 100000);
      if (hit.level === 'exact') exact += 1;
      else approx += 1;
      merged.push({
        name: r.name,
        level: r.level,
        province: src.province,
        city: hit.city,
        district: hit.district,
        districtAdcode: hit.adcode,
        path: cleanPath,
        announceDate: r.announceDate ?? '',
        sourceTitle: src.title,
        sourceUrl: src.page,
      });
      continue;
    }
    // 城市列可能已经把区县带出来了（广西「所在地区」写的是「南宁市青秀区」），
    // 这时再从地址抠区县会重复，反而把整串地名拼坏
    const cityCarriesDistrict = /(区|县|旗)$/.test(String(r.cityName ?? '').trim());
    const fromAddress = r.districtName || (cityCarriesDistrict ? '' : districtFromAddress(r.address));
    // 名录只有市级列时（山西/河南/云南/内蒙古的 PDF、辽宁的 xlsx），
    // 退一步看景区名开头有没有带区县（「清徐县六味斋云梦坞景区」）
    let districtName = fromAddress || admin.guessDistrict(src.province, r.cityName, r.name);
    // 地址里连「区/县」都没有、名字也不带区县时（青海「海北州西海镇境内」），
    // 把地址原串交给 resolve，它还能从里面捞出市州或区县名
    if (!districtName && r.address) districtName = String(r.address).trim();
    const hit = admin.resolve({ province: src.province, cityName: r.cityName, districtName });
    if (!hit) {
      fail += 1;
      continue;
    }
    // path 去掉国家级根节点 100000，保持与项目其它数据一致
    const cleanPath = hit.path.filter((a) => a !== 100000);
    if (hit.level === 'exact') exact += 1;
    else approx += 1;
    merged.push({
      name: r.name,
      level: r.level,
      province: src.province,
      city: hit.city,
      district: hit.district,
      districtAdcode: hit.adcode,
      path: cleanPath,
      announceDate: r.announceDate ?? '',
      sourceTitle: src.title,
      sourceUrl: src.page,
    });
  }

  const lv = {};
  for (const m of merged) lv[m.level] = (lv[m.level] ?? 0) + 1;
  console.log(`${merged.length} 条（精确 ${exact} / 到市 ${approx} / 落空 ${fail}）${JSON.stringify(lv)}`);
  all.push(...merged);
  summary.push({ province: src.province, title: src.title, ok: true, count: merged.length, exact, approx, fail, levels: lv, url: src.url });
  await new Promise((r) => setTimeout(r, 500));
}

// 同省内同名去重（同名可能来自多个等级页面）
const dedup = new Map();
for (const item of all) {
  const key = `${item.districtAdcode}|${item.name}`;
  const prev = dedup.get(key);
  if (!prev || Number(item.level[0]) > Number(prev.level[0])) dedup.set(key, item);
}
const fresh = [...dedup.values()];

// 只跑部分省时，保留其它省的既有结果，避免整文件被覆盖
let final = fresh;
if (only.length && fs.existsSync(OUT)) {
  const keptProv = new Set(targets.map((s) => s.province));
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const kept = prev.filter((r) => !keptProv.has(r.province));
  const mergedMap = new Map();
  for (const r of [...kept, ...fresh]) {
    const key = `${r.districtAdcode}|${r.name}`;
    const old = mergedMap.get(key);
    if (!old || Number(String(r.level)[0] || 0) > Number(String(old.level)[0] || 0)) mergedMap.set(key, r);
  }
  final = [...mergedMap.values()];
  console.log(`\n保留其它省 ${kept.length} 条，合并后 ${final.length} 条`);
}

fs.writeFileSync(OUT, JSON.stringify(final, null, 1), 'utf8');
const byProvince = {};
for (const item of final) byProvince[item.province] = (byProvince[item.province] ?? 0) + 1;
const byLevel = {};
for (const item of final) byLevel[item.level] = (byLevel[item.level] ?? 0) + 1;

console.log(`\n合计 ${final.length} 条（去重前 ${all.length}）`);
console.log('按省:', byProvince);
console.log('按等级:', byLevel);
console.log(`写入 ${path.relative(ROOT, OUT)}`);
fs.writeFileSync(path.join(CACHE, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8');
