/**
 * 用搜狗批量定位各省 A 级景区名录的真实 gov.cn 地址
 *
 * 为什么不用 Bing：同一个 query 首次能出结果页/附件，重跑就退化成门户首页。
 * 搜狗对政务站的索引更"直给"，结果块里常直接暴露真实 URL（不止省份域名）。
 *
 * 输出：tmpdata/prov/sogou.json
 * 用法：node tools/search-province-sogou.mjs [省名...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PROVINCES = [
  '北京市', '天津市', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '江苏省', '安徽省', '江西省',
  '湖北省', '广东省', '广西壮族自治区', '海南省', '重庆市', '云南省', '西藏自治区', '陕西省',
  '甘肃省', '青海省', '新疆维吾尔自治区',
];

/** query 变体：词太窄/太泛都会漏，多试几次 */
const variants = (p) => [`${p} A级旅游景区名录`, `${p} A级旅游景区名录表`, `${p} 文化和旅游厅 A级景区名单`];

const only = process.argv.slice(2);
const targets = only.length ? PROVINCES.filter((p) => only.some((o) => p.includes(o) || o.includes(p))) : PROVINCES;

const report = [];

for (const p of targets) {
  const hits = new Map(); // url -> title
  process.stdout.write(`${p.padEnd(12)} `);
  try {
    await withPage(
      null,
      async (page) => {
        for (const q of variants(p)) {
          await page.goto(`https://www.sogou.com/web?query=${encodeURIComponent(q)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 40000,
          });
          await page.waitForTimeout(2000);
          const rows = await page.evaluate(() =>
            [...document.querySelectorAll('h3')].map((h) => {
              const a = h.querySelector('a[href]');
              if (!a) return null;
              const text = (a.innerText || h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
              return { text, href: a.href };
            }).filter(Boolean),
          );
          for (const r of rows) {
            // 搜狗跳转链接没用；只要真实的 gov.cn 地址
            if (/sogou\.com\/link/.test(r.href)) continue;
            if (!/\.gov\.cn/i.test(r.href)) continue;
            if (!hits.has(r.href)) hits.set(r.href, r.text);
          }
          await page.waitForTimeout(900);
        }
      },
      { timeout: 45000 },
    );
  } catch (error) {
    console.log('搜索失败', error.message?.slice(0, 50));
    report.push({ province: p, ok: false, error: error.message?.slice(0, 80) });
    continue;
  }

  const list = [...hits.entries()].map(([url, title]) => ({ url, title }));
  console.log(`${list.length} 个 gov 地址`);
  for (const h of list.slice(0, 8)) {
    const kind = /\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(h.url) ? 'file' : 'page';
    console.log(`    [${kind}] ${h.title.slice(0, 44).padEnd(46)} ${h.url.slice(0, 100)}`);
  }
  report.push({ province: p, ok: true, hits: list });
  await new Promise((r) => setTimeout(r, 1200));
}

fs.writeFileSync(path.join(OUT_DIR, 'sogou.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/sogou.json');
