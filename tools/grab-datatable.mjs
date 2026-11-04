/**
 * DataTables 分页表格抓取
 *
 * 政务站的「名录查询」多用 jQuery DataTables：一次性把全部数据塞进 DOM，
 * 前端只显示 N 条、靠翻页切换。curl 拿到的 HTML 里往往只有第一条，
 * 因为渲染由脚本完成。
 *
 * 做法：把「显示条数」下拉设到最大 → 逐页收集行 → 翻到 disabled 为止。
 *
 * 用法：
 *   node tools/grab-datatable.mjs <url> [--out tmpdata/prov/xxx.json] [--max=40]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--'));
const outArg = argv.find((a) => a.startsWith('--out='));
const maxPages = Number((argv.find((a) => a.startsWith('--max=')) || '--max=60').split('=')[1]);

if (!url) {
  console.error('usage: node tools/grab-datatable.mjs <url> [--out=file] [--max=40]');
  process.exit(2);
}

const all = new Map();

await withPage(
  url,
  async (page) => {
    await page.waitForTimeout(3000);

    // 1) 把每页显示条数调到最大
    const sizeInfo = await page.evaluate(() => {
      const sels = [...document.querySelectorAll('select')];
      const target = sels.find((s) => [...s.options].some((o) => /^\d+$/.test(o.text.trim()) && Number(o.text) >= 50)) || sels[0];
      if (!target) return null;
      const opts = [...target.options].map((o) => ({ v: o.value, t: o.text.trim() }));
      const best = opts.filter((o) => /^\d+$/.test(o.t)).sort((a, b) => Number(b.t) - Number(a.t))[0];
      return { name: target.name || target.id, best, opts: opts.slice(0, 8) };
    });
    if (sizeInfo?.best) {
      try {
        await page.selectOption(
          sizeInfo.name ? `select[name="${sizeInfo.name}"]` : 'select',
          sizeInfo.best.v,
        );
        await page.waitForTimeout(1200);
        console.log(`每页条数设为 ${sizeInfo.best.t}`);
      } catch (error) {
        console.log('设置条数失败', error.message?.slice(0, 50));
      }
    }

    const readRows = () =>
      page.evaluate(() => {
        const tables = [...document.querySelectorAll('table')];
        if (!tables.length) return { head: [], rows: [] };
        const t = tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
        const trs = [...t.querySelectorAll('tr')];
        const headIdx = trs.findIndex((tr) => tr.querySelector('th')) >= 0 ? trs.findIndex((tr) => tr.querySelector('th')) : 0;
        const head = [...(trs[headIdx]?.querySelectorAll('th,td') ?? [])].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
        const rows = trs
          .slice(headIdx + 1)
          .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim()))
          .filter((r) => r.length >= 2 && r.some(Boolean));
        return { head, rows };
      });

    for (let p = 1; p <= maxPages; p++) {
      const { head, rows } = await readRows();
      if (p === 1) console.log('表头:', head.join(' | ').slice(0, 140));
      let added = 0;
      for (const r of rows) {
        const key = r.join('|');
        if (all.has(key)) continue;
        all.set(key, r);
        added += 1;
      }
      console.log(`第 ${p} 页：${rows.length} 行，新增 ${added}，累计 ${all.size}`);
      if (added === 0 && p > 1) break;

      // 2) 翻页：优先点 DataTables 的 next 按钮
      const clicked = await page.evaluate(() => {
        const cands = [
          ...document.querySelectorAll('a.paginate_button.next, a.next, li.next a'),
          ...[...document.querySelectorAll('a,button')].filter((a) => /^\s*(下一页|下页|>|›)\s*$/.test(a.textContent || '')),
        ];
        for (const a of cands) {
          const cls = (a.className || '') + ' ' + (a.parentElement?.className || '');
          if (/disabled/i.test(cls)) continue;
          if (a.getAttribute('aria-disabled') === 'true') continue;
          a.click();
          return true;
        }
        return false;
      });
      if (!clicked) {
        console.log('没有可点的下一页，结束');
        break;
      }
      await page.waitForTimeout(1200);
    }
  },
  { timeout: 60000, warmupWait: 3000 },
);

const head = [...all.values()][0] ?? [];
const outPath = outArg ? path.join(ROOT, outArg.split('=')[1]) : path.join(OUT_DIR, `dt-${crypto.createHash('md5').update(url).digest('hex').slice(0, 8)}.json`);
fs.writeFileSync(outPath, JSON.stringify([...all.values()], null, 1), 'utf8');
console.log(`\n合计 ${all.size} 行 → ${path.relative(ROOT, outPath)}`);
