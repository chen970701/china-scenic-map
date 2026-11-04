/**
 * 省文旅厅 A 级景区名录发现器
 *
 * 思路：从首页出发做有界 BFS，只跟「政务公开 / 通知公告 / 数据发布 / 资源开发」类栏目，
 * 收集标题命中「A级旅游景区名录 / 景区名录」的链接（含 xlsx/pdf 附件）。
 *
 * 政务网站详情页和列表页混在一起，所以判断依据是"锚文本"而不是 URL 形态。
 *
 * 用法：
 *   node tools/find-provincial-lists.mjs            # 全部省
 *   node tools/find-provincial-lists.mjs 四川省 山东省  # 指定省
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
  { province: '北京市', adcode: 110000, base: 'https://whlyj.beijing.gov.cn' },
  { province: '天津市', adcode: 120000, base: 'https://whly.tj.gov.cn' },
  { province: '河北省', adcode: 130000, base: 'https://whly.hebei.gov.cn' },
  { province: '山西省', adcode: 140000, base: 'https://wlt.shanxi.gov.cn' },
  { province: '内蒙古自治区', adcode: 150000, base: 'https://wlt.nmg.gov.cn' },
  { province: '辽宁省', adcode: 210000, base: 'https://whly.ln.gov.cn' },
  { province: '吉林省', adcode: 220000, base: 'https://wlt.jl.gov.cn' },
  { province: '黑龙江省', adcode: 230000, base: 'https://wlt.hlj.gov.cn' },
  { province: '上海市', adcode: 310000, base: 'https://whlyj.sh.gov.cn' },
  { province: '江苏省', adcode: 320000, base: 'http://wlt.jiangsu.gov.cn' },
  { province: '浙江省', adcode: 330000, base: 'http://ct.zj.gov.cn' },
  { province: '安徽省', adcode: 340000, base: 'https://ct.ah.gov.cn' },
  { province: '福建省', adcode: 350000, base: 'https://wlt.fujian.gov.cn' },
  { province: '江西省', adcode: 360000, base: 'https://dct.jiangxi.gov.cn' },
  { province: '山东省', adcode: 370000, base: 'http://whhly.shandong.gov.cn' },
  { province: '河南省', adcode: 410000, base: 'http://wlt.henan.gov.cn' },
  { province: '湖北省', adcode: 420000, base: 'https://wlt.hubei.gov.cn' },
  { province: '湖南省', adcode: 430000, base: 'https://whhlyt.hunan.gov.cn' },
  { province: '广东省', adcode: 440000, base: 'http://whly.gd.gov.cn' },
  { province: '广西壮族自治区', adcode: 450000, base: 'http://wlt.gxzf.gov.cn' },
  { province: '海南省', adcode: 460000, base: 'https://lwt.hainan.gov.cn' },
  { province: '重庆市', adcode: 500000, base: 'http://whlyw.cq.gov.cn' },
  { province: '四川省', adcode: 510000, base: 'https://wlt.sc.gov.cn' },
  { province: '贵州省', adcode: 520000, base: 'https://whhly.guizhou.gov.cn' },
  { province: '云南省', adcode: 530000, base: 'https://wlt.yn.gov.cn' },
  { province: '西藏自治区', adcode: 540000, base: 'http://wlt.xizang.gov.cn' },
  { province: '陕西省', adcode: 610000, base: 'http://wlt.shaanxi.gov.cn' },
  { province: '甘肃省', adcode: 620000, base: 'http://wlt.gansu.gov.cn' },
  { province: '青海省', adcode: 630000, base: 'http://whlyt.qinghai.gov.cn' },
  { province: '宁夏回族自治区', adcode: 640000, base: 'https://whhlyt.nx.gov.cn' },
  { province: '新疆维吾尔自治区', adcode: 650000, base: 'https://wlt.xinjiang.gov.cn' },
];

/** 值得深入的栏目名 */
const COL_HINT =
  /(政务公开|信息公开|通知公告|公告公示|公示公告|政策文件|数据发布|统计数据|统计信息|公共服务|资源开发|行业管理|规划财务|文旅资讯|产业概况|文旅名录|名录|资源|大数据|数据开放|开放数据)/;
/** 名录类文件标题 */
const LIST_HINT = /(A级|Ａ级)[^。]{0,14}(景区|旅游区)[^。]{0,10}(名录|名单)|(景区|旅游区)[^。]{0,4}名录|A级景区名单/i;

const visited = new Set();
let requestCount = 0;
const MAX_REQUESTS = 130;

function decode(buf, contentType) {
  if (/gb2312|gbk|gb18030/i.test(contentType)) return new TextDecoder('gb18030').decode(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  return bad > 15 ? new TextDecoder('gb18030').decode(buf) : utf8;
}

/**
 * 用 curl 抓页面。
 * Node 内置 fetch 不读 HTTP_PROXY，在受限网络里会被直接拦掉，
 * 而 curl 走系统代理，实测可达率高得多。政务站编码以 GBK 居多，统一在这里解码。
 */
async function get(url, timeout = 20000) {
  requestCount += 1;
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sL',
        '--compressed',
        '-m', String(Math.round(timeout / 1000)),
        '-A', UA,
        '-H', 'Accept-Language: zh-CN,zh;q=0.9',
        '-w', '\n__META__%{http_code} %{url_effective}',
        url,
      ],
      { encoding: 'buffer', maxBuffer: 40 * 1024 * 1024, timeout: timeout + 8000 },
    );
    const text = stdout.toString('latin1');
    const idx = text.lastIndexOf('__META__');
    const meta = idx >= 0 ? text.slice(idx + 8).trim() : '';
    const body = Buffer.from(idx >= 0 ? text.slice(0, idx) : text, 'latin1');
    const [codeStr, ...rest] = meta.split(' ');
    const status = Number(codeStr) || 0;
    const finalUrl = rest.join(' ') || url;
    return { ok: status >= 200 && status < 400, status, html: decode(body, ''), url: finalUrl };
  } catch (error) {
    return { ok: false, status: 0, html: '', error: error.message?.slice(0, 80), url };
  }
}

/** 抽链接：同时读锚文本和 title 属性（列表页标题常被截断在 title 里） */
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const raw = hrefMatch[1].trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) continue;
    let href;
    try {
      href = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    const anchor = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const titleMatch = attrs.match(/title\s*=\s*["']([^"']+)["']/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
    const text = (anchor.length >= title.length ? anchor : title) || anchor;
    out.push({ href, text, anchor });
  }
  return out;
}

async function crawlSite(site) {
  visited.clear();
  requestCount = 0;
  const found = [];
  const queue = [{ url: site.base, depth: 0 }];
  const host = new URL(site.base).host;

  while (queue.length && requestCount < MAX_REQUESTS) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await get(url);
    if (!page.ok) {
      if (depth === 0) return { ok: false, note: `首页 ${page.status || page.error}` };
      continue;
    }

    const links = extractLinks(page.html, page.url || url);
    for (const l of links) {
      let hostOk = false;
      try {
        hostOk = new URL(l.href).host === host;
      } catch {}
      if (!hostOk) continue;

      const isFile = /\.(xlsx?|pdf|docx?|csv)(\?|$)/i.test(l.href);
      if (LIST_HINT.test(l.text) || (isFile && /名录|名单|景区/.test(l.text))) {
        found.push({ text: l.text.slice(0, 90), href: l.href, from: url, isFile });
        continue;
      }
      // 只有当锚文本像栏目、且还没爬过时才入队
      if (depth < 3 && COL_HINT.test(l.text) && l.text.length <= 16) {
        if (!visited.has(l.href)) queue.push({ url: l.href, depth: depth + 1 });
      }
    }
    // 队列控制在合理长度
    if (queue.length > 60) queue.length = 60;
  }

  // 同名去重，优先 xlsx 附件
  const dedup = new Map();
  for (const f of found) {
    const key = f.text.replace(/\s/g, '');
    const prev = dedup.get(key);
    if (!prev || (f.isFile && !prev.isFile)) dedup.set(key, f);
  }
  return { ok: true, found: [...dedup.values()], requests: requestCount, pages: visited.size };
}

const only = process.argv.slice(2);
const targets = only.length ? SITES.filter((s) => only.some((p) => s.province.includes(p) || p.includes(s.province))) : SITES;
const report = [];

for (const site of targets) {
  process.stdout.write(`${site.province.padEnd(10)} `);
  const r = await crawlSite(site);
  if (!r.ok) {
    console.log(`不可达：${r.note}`);
    report.push({ ...site, ok: false, note: r.note });
  } else {
    console.log(`抓 ${r.pages} 页，名录相关 ${r.found.length} 条`);
    for (const f of r.found.slice(0, 8)) console.log(`    · ${f.text} → ${f.href.slice(0, 120)}`);
    report.push({ ...site, ok: true, requests: r.requests, found: r.found });
  }
  await new Promise((res) => setTimeout(res, 800));
}

fs.writeFileSync(path.join(OUT_DIR, 'discover.json'), JSON.stringify(report, null, 1), 'utf8');
console.log(`\n写入 tmpdata/prov/discover.json`);
