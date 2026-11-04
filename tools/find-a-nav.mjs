/**
 * A 级景区名录入口发现（省级）
 *
 * 经验：多数省厅首页导航里有「A级景区」这一项，点进去就是名录页或名录附件，
 * 比在「通知公告」里大海捞针有效得多。所以先找导航入口，再判断入口里是什么形态：
 *   table   —— 页面自带 HTML 表格（四川、湖南）
 *   file    —— 挂着 xlsx/xls/doc/pdf 附件（福建、山东、河北）
 *   list    —— 栏目页，还要再进一层（湖南的查询栏目）
 *
 * 用法：node tools/find-a-nav.mjs [省名...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SITES = [
  { province: '北京市', base: 'https://whlyj.beijing.gov.cn' },
  { province: '天津市', base: 'https://whly.tj.gov.cn' },
  { province: '河北省', base: 'https://whly.hebei.gov.cn' },
  { province: '山西省', base: 'https://wlt.shanxi.gov.cn' },
  { province: '内蒙古自治区', base: 'https://wlt.nmg.gov.cn' },
  { province: '辽宁省', base: 'https://whly.ln.gov.cn' },
  { province: '吉林省', base: 'http://wlt.jl.gov.cn' },
  { province: '黑龙江省', base: 'https://wlt.hlj.gov.cn' },
  { province: '上海市', base: 'https://whlyj.sh.gov.cn' },
  { province: '江苏省', base: 'http://wlt.jiangsu.gov.cn' },
  { province: '浙江省', base: 'http://ct.zj.gov.cn' },
  { province: '安徽省', base: 'https://ct.ah.gov.cn' },
  { province: '福建省', base: 'https://wlt.fujian.gov.cn' },
  { province: '江西省', base: 'https://dct.jiangxi.gov.cn' },
  { province: '山东省', base: 'http://whhly.shandong.gov.cn' },
  { province: '河南省', base: 'http://wlt.henan.gov.cn' },
  { province: '湖北省', base: 'https://wlt.hubei.gov.cn' },
  { province: '湖南省', base: 'https://whhlyt.hunan.gov.cn' },
  { province: '广东省', base: 'http://whly.gd.gov.cn' },
  { province: '广西壮族自治区', base: 'http://wlt.gxzf.gov.cn' },
  { province: '海南省', base: 'https://lwt.hainan.gov.cn' },
  { province: '重庆市', base: 'http://whlyw.cq.gov.cn' },
  { province: '四川省', base: 'https://wlt.sc.gov.cn' },
  { province: '贵州省', base: 'https://whhly.guizhou.gov.cn' },
  { province: '云南省', base: 'http://wlt.yn.gov.cn' },
  { province: '西藏自治区', base: 'http://wlt.xizang.gov.cn' },
  { province: '陕西省', base: 'http://wlt.shaanxi.gov.cn' },
  { province: '甘肃省', base: 'http://wlt.gansu.gov.cn' },
  { province: '青海省', base: 'http://whlyt.qinghai.gov.cn' },
  { province: '宁夏回族自治区', base: 'https://whhlyt.nx.gov.cn' },
  { province: '新疆维吾尔自治区', base: 'https://wlt.xinjiang.gov.cn' },
];

function decode(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  return bad > 15 ? new TextDecoder('gb18030').decode(buf) : utf8;
}

async function curl(url, { timeout = 25, referer = '' } = {}) {
  const args = ['-sL', '--compressed', '-m', String(timeout), '-A', UA, '-H', 'Accept-Language: zh-CN,zh;q=0.9'];
  if (referer) args.push('-e', referer);
  args.push('-w', '\n__META__%{http_code} %{url_effective}', url);
  try {
    const { stdout } = await execFileAsync('curl', args, { encoding: 'buffer', maxBuffer: 60 * 1024 * 1024, timeout: (timeout + 8) * 1000 });
    const text = stdout.toString('latin1');
    const i = text.lastIndexOf('__META__');
    const meta = i >= 0 ? text.slice(i + 8).trim() : '';
    const body = Buffer.from(i >= 0 ? text.slice(0, i) : text, 'latin1');
    const [code, ...rest] = meta.split(' ');
    return { status: Number(code) || 0, body, url: rest.join(' ') || url };
  } catch (error) {
    return { status: 0, body: Buffer.alloc(0), url, error: error.message?.slice(0, 60) };
  }
}

function links(html, base) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const hrefM = m[1].match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefM) continue;
    const raw = hrefM[1].trim();
    if (!raw || raw.startsWith('#') || /^javascript:|^mailto:/i.test(raw)) continue;
    let href;
    try {
      href = new URL(raw, base).href;
    } catch {
      continue;
    }
    const anchor = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const titleM = m[1].match(/title\s*=\s*["']([^"']+)["']/i);
    const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim() : '';
    out.push({ href, text: anchor.length >= title.length ? anchor : title });
  }
  return out;
}

/** 判断一个页面里有什么形态的名录 */
function inspect(html) {
  const tables = [...html.matchAll(/<table\b[\s\S]{0,200000}?<\/table>/gi)].map((m) => m[0]);
  let bestTable = 0;
  for (const t of tables) {
    const rows = (t.match(/<tr\b/gi) ?? []).length;
    if (rows > bestTable) bestTable = rows;
  }
  const files = [];
  const fileRe = /href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m;
  while ((m = fileRe.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (/\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(href) || /\.(xlsx?|docx?|pdf)(?:\?|$)/i.test(text)) {
      files.push({ href, text: text.slice(0, 60) });
    }
  }
  const hasListTitle = /(A级|Ａ级)[^<]{0,10}(景区|旅游区)[^<]{0,6}名录/.test(html.replace(/<[^>]+>/g, ''));
  return { tableRows: bestTable, files, hasListTitle };
}

const NAV_HINT = /(A级景区|Ａ级景区|a级景区|旅游景区|景区名录|文旅单位|旅游名录|景区查询|名录)/;

const only = process.argv.slice(2);
const targets = only.length
  ? SITES.filter((s) => only.some((p) => s.province.includes(p) || p.includes(s.province)))
  : SITES;

const report = [];

for (const site of targets) {
  const home = await curl(site.base);
  const html = decode(home.body);
  process.stdout.write(`${site.province.padEnd(10)} `);
  if (!html) {
    console.log(`首页不可达 ${home.status || home.error}`);
    report.push({ ...site, ok: false, note: `首页 ${home.status || home.error}` });
    continue;
  }

  const all = links(html, home.url);
  const seen = new Set();
  const cands = [];
  for (const l of all) {
    if (!NAV_HINT.test(l.text)) continue;
    if (l.text.length > 18) continue;
    if (seen.has(l.href)) continue;
    seen.add(l.href);
    cands.push(l);
    if (cands.length >= 6) break;
  }

  const found = [];
  for (const c of cands) {
    const page = await curl(c.href, { referer: site.base });
    const body = decode(page.body);
    if (!body) continue;
    const info = inspect(body);
    if (!info.tableRows && !info.files.length && !info.hasListTitle) continue;
    found.push({
      text: c.text,
      url: page.url || c.href,
      tableRows: info.tableRows,
      files: info.files.slice(0, 4),
      hasListTitle: info.hasListTitle,
      kind: info.tableRows >= 20 ? 'table' : info.files.length ? 'file' : 'list',
    });
  }

  console.log(`${cands.length} 个候选，命中 ${found.length}`);
  for (const f of found) {
    console.log(`    · [${f.kind}] ${f.text} rows=${f.tableRows} files=${f.files.length} → ${f.url.slice(0, 100)}`);
  }
  report.push({ ...site, ok: true, found });
  await new Promise((r) => setTimeout(r, 700));
}

fs.writeFileSync(path.join(OUT_DIR, 'nav.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/nav.json');
