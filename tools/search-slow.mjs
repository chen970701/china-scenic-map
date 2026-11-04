/**
 * 逐省、逐类型、单次搜索（慢速版）
 *
 * 批量快跑时 Bing 会做查询改写：把「辽宁 A级旅游景区名录 filetype:pdf」
 * 改写成「全国A级景区名录」，返回一堆门户首页。放慢到每省一次、
 * 每次新起浏览器上下文、间隔 4 秒，改写概率明显下降。
 *
 * 用法：node tools/search-slow.mjs [pdf|xlsx] [省简称...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
const OUT = path.join(OUT_DIR, 'slow.json');

const ALL = [
  '北京', '天津', '辽宁', '吉林', '江苏', '江西', '湖北', '广东',
  '广西', '海南', '重庆', '西藏', '陕西', '甘肃', '青海', '新疆',
];

const argv = process.argv.slice(2);
const type = argv[0] === 'xlsx' || argv[0] === 'pdf' ? argv[0] : 'pdf';
const provs = argv.filter((a) => !['pdf', 'xlsx'].includes(a));
const targets = provs.length ? ALL.filter((p) => provs.some((o) => p.includes(o) || o.includes(p))) : ALL;

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const report = { ...prev };

for (const p of targets) {
  const q = `${p} A级旅游景区名录 filetype:${type}`;
  process.stdout.write(`${p.padEnd(6)} `);
  let rows = [];
  try {
    await withPage(
      null,
      async (page) => {
        await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&ensearch=0`, {
          waitUntil: 'domcontentloaded',
          timeout: 40000,
        });
        await page.waitForTimeout(2500);
        rows = await page.evaluate(() =>
          [...document.querySelectorAll('#b_results > li.b_algo')]
            .map((li) => {
              const a = li.querySelector('h2 a');
              if (!a) return null;
              return { title: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 70), url: a.href };
            })
            .filter(Boolean),
        );
      },
      { timeout: 45000 },
    );
  } catch (error) {
    console.log('失败', error.message?.slice(0, 50));
    continue;
  }

  const files = rows.filter((r) => /\.(xlsx?|docx?|pdf)(\?|$)/i.test(r.url));
  const pages = rows.filter((r) => !files.includes(r) && /名录|名单/.test(r.title));
  console.log(`${files.length} 附件 / ${pages.length} 页`);

  for (const f of files.slice(0, 5)) console.log(`    [F] ${decodeURIComponent(f.url).slice(0, 118)}`);
  for (const g of pages.slice(0, 3)) console.log(`    [P] ${g.title.slice(0, 34)} ${decodeURIComponent(g.url).slice(0, 100)}`);

  report[`${p}|${type}`] = rows;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');
  await new Promise((r) => setTimeout(r, 4000));
}

console.log(`\n写入 ${path.relative(ROOT, OUT)}`);
