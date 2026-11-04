/**
 * 省文旅厅站点侦察：抓首页 → 找「通知公告 / 政务公开」类栏目 → 看栏目里有多少 A 级景区相关条目
 *
 * 目的不是抓数据，是先搞清楚每个省的栏目结构，再决定爬取入口。
 * 用法：node tools/probe-sites.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tmpdata', 'site-probe');
fs.mkdirSync(OUT, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 站点清单：优先用能直连的协议 */
const SITES = [
  { province: '四川省', base: 'https://wlt.sc.gov.cn' },
  { province: '湖南省', base: 'https://whhlyt.hunan.gov.cn' },
  { province: '江西省', base: 'https://dct.jiangxi.gov.cn' },
  { province: '安徽省', base: 'https://ct.ah.gov.cn' },
  { province: '福建省', base: 'https://wlt.fujian.gov.cn' },
  { province: '河北省', base: 'https://whly.hebei.gov.cn' },
  { province: '山西省', base: 'https://wlt.shanxi.gov.cn' },
  { province: '湖北省', base: 'https://wlt.hubei.gov.cn' },
  { province: '贵州省', base: 'https://whhly.guizhou.gov.cn' },
  { province: '海南省', base: 'https://lwt.hainan.gov.cn' },
  { province: '宁夏回族自治区', base: 'https://whhlyt.nx.gov.cn' },
  { province: '新疆维吾尔自治区', base: 'https://wlt.xinjiang.gov.cn' },
  { province: '内蒙古自治区', base: 'https://wlt.nmg.gov.cn' },
  { province: '天津市', base: 'https://whly.tj.gov.cn' },
  { province: '北京市', base: 'https://whlyj.beijing.gov.cn' },
  { province: '上海市', base: 'https://whlyj.sh.gov.cn' },
  { province: '黑龙江省', base: 'https://wlt.hlj.gov.cn' },
  { province: '辽宁省', base: 'https://whly.ln.gov.cn' },
  { province: '浙江省', base: 'http://ct.zj.gov.cn' },
  { province: '山东省', base: 'http://whhly.shandong.gov.cn' },
  { province: '广西壮族自治区', base: 'http://wlt.gxzf.gov.cn' },
  { province: '重庆市', base: 'http://whlyw.cq.gov.cn' },
  { province: '青海省', base: 'http://whlyt.qinghai.gov.cn' },
];

const KEYWORDS = ['通知公告', '公告公示', '政务公开', '政策文件', '公示公告', '行业管理', '政府信息公开'];

async function get(url, timeout = 20000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    // 政务网站编码混乱，gbk 的不少
    const ct = res.headers.get('content-type') ?? '';
    let html;
    if (/gb2312|gbk|gb18030/i.test(ct)) {
      html = new TextDecoder('gb18030').decode(buf);
    } else {
      const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      // 含大量替换符说明不是 utf8
      const bad = (utf8.match(/\uFFFD/g) ?? []).length;
      html = bad > 20 ? new TextDecoder('gb18030').decode(buf) : utf8;
    }
    return { ok: res.ok, status: res.status, html, finalUrl: res.url };
  } catch (error) {
    return { ok: false, status: 0, html: '', error: error.message };
  }
}

/** 从 HTML 里抽 <a href> 与锚文本 */
function links(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, '')
      .trim();
    if (!text) continue;
    let href;
    try {
      href = new URL(m[1], baseUrl).href;
    } catch {
      continue;
    }
    out.push({ href, text });
  }
  return out;
}

const results = [];

for (const site of SITES) {
  process.stdout.write(`${site.province.padEnd(10)} `);
  const home = await get(site.base);
  if (!home.ok) {
    console.log(`首页失败 ${home.status || home.error}`);
    results.push({ ...site, ok: false, note: `首页 ${home.status}` });
    continue;
  }

  const all = links(home.html, home.finalUrl || site.base);
  const cols = all.filter((l) => KEYWORDS.some((k) => l.text.includes(k)));
  // 同域去重
  const seen = new Set();
  const uniq = [];
  for (const c of cols) {
    if (seen.has(c.href)) continue;
    seen.add(c.href);
    uniq.push(c);
  }

  // 进入每个候选栏目首屏，统计 A 级景区相关条目
  const colInfo = [];
  for (const col of uniq.slice(0, 4)) {
    const page = await get(col.href);
    if (!page.ok) {
      colInfo.push({ title: col.text, url: col.href, ok: false });
      continue;
    }
    const items = links(page.html, page.finalUrl || col.href);
    const hits = items.filter((i) => /A级|级旅游景[区点]|旅游景区名录|景区名录/i.test(i.text));
    colInfo.push({
      title: col.text,
      url: col.href,
      ok: true,
      links: items.length,
      hits: hits.slice(0, 6).map((h) => ({ text: h.text.slice(0, 50), href: h.href })),
    });
    await new Promise((r) => setTimeout(r, 600));
  }

  fs.writeFileSync(
    path.join(OUT, `${site.province}.home.html`),
    home.html.slice(0, 400000),
    'utf8',
  );
  results.push({ ...site, ok: true, cols: colInfo });

  const totalHits = colInfo.reduce((n, c) => n + (c.hits?.length ?? 0), 0);
  console.log(`首页 ${home.html.length}B，栏目 ${uniq.length} 个，首屏命中 ${totalHits}`);
  for (const c of colInfo) {
    if (c.hits?.length) {
      for (const h of c.hits) console.log(`    · ${c.title} | ${h.text}`);
    }
  }
  await new Promise((r) => setTimeout(r, 900));
}

fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(results, null, 1), 'utf8');
console.log(`\n结果写入 tmpdata/site-probe/probe.json`);
