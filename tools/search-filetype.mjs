/**
 * 用 filetype: 限定搜各省名录附件（pdf / xls / xlsx）
 *
 * 名录在政务站多以附件发布，而普通网页搜索的排序会被门户首页挤掉。
 * 限定文件类型后，命中的基本都是名录本体，比逐层翻栏目效率高一个量级。
 *
 * 输出：tmpdata/prov/filetype.json（含每个候选的域名，便于判断是不是本省的）
 * 用法：node tools/search-filetype.mjs [省简称...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PROVINCES = [
  '北京', '天津', '辽宁', '吉林', '黑龙江', '江苏', '安徽', '江西', '湖北', '广东',
  '广西', '海南', '重庆', '云南', '西藏', '陕西', '甘肃', '青海', '新疆',
];

const TYPES = ['pdf', 'xlsx', 'xls'];

const only = process.argv.slice(2);
const targets = only.length ? PROVINCES.filter((p) => only.some((o) => p.includes(o) || o.includes(p))) : PROVINCES;

const report = [];

for (const p of targets) {
  const hits = new Map();
  process.stdout.write(`${p.padEnd(6)} `);
  try {
    await withPage(
      null,
      async (page) => {
        for (const t of TYPES) {
          const q = `${p} A级旅游景区名录 filetype:${t}`;
          await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, {
            waitUntil: 'domcontentloaded',
            timeout: 40000,
          });
          await page.waitForTimeout(2000);
          const rows = await page.evaluate(() =>
            [...document.querySelectorAll('#b_results > li.b_algo')]
              .map((li) => {
                const a = li.querySelector('h2 a');
                if (!a) return null;
                return { title: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 70), url: a.href };
              })
              .filter(Boolean),
          );
          for (const r of rows) {
            if (!/\.gov\.cn/i.test(r.url)) continue;
            if (!/\.(xlsx?|docx?|pdf)(\?|$)/i.test(r.url)) continue;
            if (!hits.has(r.url)) hits.set(r.url, r.title);
          }
          await page.waitForTimeout(700);
        }
      },
      { timeout: 45000 },
    );
  } catch (error) {
    console.log('搜索失败', error.message?.slice(0, 50));
    report.push({ province: p, ok: false, error: error.message?.slice(0, 80) });
    continue;
  }

  const list = [...hits.entries()].map(([url, title]) => ({ url, title, host: new URL(url).host }));
  console.log(`${list.length} 个附件`);
  for (const h of list.slice(0, 6)) console.log(`    ${h.host.slice(0, 26).padEnd(28)} ${h.title.slice(0, 40)}`);
  report.push({ province: p, ok: true, hits: list });
  await new Promise((r) => setTimeout(r, 900));
}

fs.writeFileSync(path.join(OUT_DIR, 'filetype.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/filetype.json');
