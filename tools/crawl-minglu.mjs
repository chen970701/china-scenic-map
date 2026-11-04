/**
 * 站内广度搜索「A 级景区名录」
 *
 * 省厅结构差异太大，写死栏目路径不可行（试过 ggfw/jqml、zfxxgk/zyml 等，
 * 每省都不一样）。改成从首页出发做受限 BFS，按链接文字和路径给优先级：
 *   高：文字含「A级/景区/名录/资源名录」、路径含 zyml/ml/jqml/wlgz
 *   中：路径含 zfxxgk/ggfw/bsfw/zwgk（栏目容器）
 *   低：其它同域链接
 *
 * 判定名录页的口径：正文表格 ≥ 20 行，或有名字像名录的 xlsx/doc/pdf 附件。
 *
 * 用法：node tools/crawl-minglu.mjs 省名... [--pages=30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'province-sites.json'), 'utf8'));
const MAX_PAGES = Number((process.argv.find((a) => a.startsWith('--pages=')) || '--pages=28').split('=')[1]);

const HIGH_TEXT = /(A级|Ａ级|a级|景区名录|旅游景区名录|资源名录|旅游名录|景区名单|景区查询)/;
const HIGH_PATH = /(zyml|\/ml\/|jqml|ajjq|lyjq|wlgz|minglu|scenic)/i;
const MID_PATH = /(zfxxgk|ggfw|bsfw|zwgk|xxgk|lyfw|cxfw)/i;

const evaluatePage = () => {
  let best = 0;
  let sample = [];
  for (const t of document.querySelectorAll('table')) {
    const rows = t.querySelectorAll('tr').length;
    if (rows > best) {
      best = rows;
      sample = [...t.querySelectorAll('tr')].slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 100));
    }
  }
  const files = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try {
      u = new URL(a.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    if (!/\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(u)) continue;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!/(景区|名录|名单|A级|旅游)/.test(text)) continue;
    files.push({ url: u, text });
  }
  const plain = document.body ? document.body.innerText : '';
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try {
      u = new URL(a.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    links.push({ url: u, text });
  }
  return {
    title: document.title,
    url: location.href,
    best,
    sample,
    files,
    links,
    hasListInText: /(A级|Ａ级)[^\n]{0,14}(景区|旅游区)[^\n]{0,10}(名录|名单)/.test(plain),
  };
};

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = only.length
  ? SITES.filter((s) => only.some((p) => s.province.includes(p) || p.includes(s.province)))
  : SITES;

const report = [];

for (const site of targets) {
  console.log(`\n${site.province} ${site.base}`);
  const found = [];
  const visited = new Set();
  const origin = new URL(site.base).origin;

  try {
    await withPage(
      site.base,
      async (page) => {
        await page.waitForTimeout(1800);
        const queue = [];

        const absorb = async (info, depth) => {
          // 名录判定：大表格 / 挂着名字像名录的附件 / 正文出现「A级…名录」
          const isList = info.best >= 20 || info.files.length > 0 || info.hasListInText;
          if (isList) {
            found.push({
              url: info.url,
              title: info.title.slice(0, 60),
              tableRows: info.best,
              sample: info.sample.slice(0, 2),
              files: info.files.slice(0, 4),
            });
          }
          if (depth >= 4) return;
          for (const l of info.links) {
            if (!l.url.startsWith(origin)) continue;
            if (visited.has(l.url)) continue;
            if (/\.(xlsx?|docx?|pdf|csv|jpg|png|zip|rar|mp4)(\?|$)/i.test(l.url)) continue;
            let pri = 3;
            if (HIGH_TEXT.test(l.text) || HIGH_PATH.test(l.url)) pri = 0;
            else if (MID_PATH.test(l.url)) pri = 1;
            queue.push({ url: l.url, depth: depth + 1, pri, text: l.text });
          }
          queue.sort((a, b) => a.pri - b.pri);
        };

        const home = await page.evaluate(evaluatePage);
        visited.add(page.url());
        await absorb(home, 0);

        let count = 0;
        while (queue.length && count < MAX_PAGES) {
          const next = queue.shift();
          if (visited.has(next.url)) continue;
          visited.add(next.url);
          count += 1;
          try {
            await page.goto(next.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(700);
            const info = await page.evaluate(evaluatePage);
            await absorb(info, next.depth);
          } catch {
            // 单页失败跳过
          }
          if (found.length >= 5) break;
        }
        console.log(`  访问 ${count} 页，命中 ${found.length}，队列余 ${queue.length}`);
      },
      { timeout: 45000, warmupWait: 2500 },
    );
  } catch (error) {
    console.log('  失败', error.message?.slice(0, 70));
  }

  for (const f of found) {
    console.log(`  · ${f.title.slice(0, 46)} rows=${f.tableRows} files=${f.files.length}`);
    console.log(`    ${f.url.slice(0, 110)}`);
    for (const file of f.files.slice(0, 2)) console.log(`    附件 ${file.text.slice(0, 34)} ${file.url.slice(0, 95)}`);
  }
  report.push({ province: site.province, base: site.base, found });
}

fs.writeFileSync(path.join(OUT_DIR, 'crawl.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/crawl.json');
