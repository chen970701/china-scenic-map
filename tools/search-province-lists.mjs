/**
 * 用搜索引擎批量定位各省 A 级景区名录页
 *
 * 省厅首页导航命中率很低（很多是图片 / JS 渲染 / 栏目名各异），
 * 但搜索引擎索引里几乎每省都有「xx省A级旅游景区名录」这份文档，
 * 且结果常直接是 gov.cn 的 pdf / xlsx / 详情页，比在站内翻栏目快得多。
 *
 * 输出：tmpdata/prov/search.json
 * 用法：node tools/search-province-lists.mjs [省简称...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PROVINCES = [
  '北京市', '天津市', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '江苏省', '安徽省', '江西省',
  '河南省', '湖北省', '广东省', '广西壮族自治区', '海南省', '重庆市', '云南省', '西藏自治区', '陕西省',
  '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区',
];

/** 政务域名白名单：结果是 gov.cn 才算数，避免本地宝、携程这类聚合站 */
const isGov = (u) => /\.gov\.cn(\/|$)|\/gov\//.test(u) || /\.gov\.cn/.test(u);

const only = process.argv.slice(2);
const targets = only.length ? PROVINCES.filter((p) => only.some((o) => p.includes(o) || o.includes(p))) : PROVINCES;

const report = [];

for (const p of targets) {
  const q = `${p} A级旅游景区名录`;
  process.stdout.write(`${p.padEnd(6)} `);
  let rows = [];
  try {
    await withPage(
      null,
      async (page) => {
        await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&mkt=zh-CN`, {
          waitUntil: 'domcontentloaded',
          timeout: 40000,
        });
        await page.waitForTimeout(2200);
        rows = await page.evaluate(() =>
          [...document.querySelectorAll('#b_results > li.b_algo')]
            .map((li) => {
              const a = li.querySelector('h2 a');
              if (!a) return null;
              const cite = li.querySelector('cite')?.innerText ?? '';
              return { title: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 70), url: a.href, cite };
            })
            .filter(Boolean),
        );
      },
      { timeout: 45000 },
    );
  } catch (error) {
    console.log('搜索失败', error.message?.slice(0, 50));
    report.push({ province: p, ok: false, error: error.message?.slice(0, 80) });
    continue;
  }

  const gov = rows.filter((r) => isGov(r.url));
  console.log(`${rows.length} 条 / gov ${gov.length}`);
  for (const r of gov.slice(0, 6)) {
    const kind = /\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(r.url) ? 'file' : 'page';
    console.log(`    [${kind}] ${r.title.slice(0, 46).padEnd(48)} ${r.url.slice(0, 105)}`);
  }
  report.push({ province: p, ok: true, query: q, results: rows });
  await new Promise((r) => setTimeout(r, 600));
}

fs.writeFileSync(path.join(OUT_DIR, 'search.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/search.json');
