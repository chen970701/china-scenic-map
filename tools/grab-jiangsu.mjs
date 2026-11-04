/**
 * 江苏省文旅厅「旅游名录」抓取
 *
 * 页面把 5A/4A/3A/2A 拆成 4 张表，每张表各自挂一个 jpage 分页控件
 * （共 2/12/N 页），URL 上的 pageNum 无效，因为翻页走的是
 * /module/web/jpage/dataproxy.jsp 的 AJAX。所以只能在页面里逐表点「下一页」。
 *
 * 输出：tmpdata/prov/jiangsu-final.json（行数组，含表头）
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tmpdata', 'prov', 'jiangsu-final.json');
const URL_ = 'https://wlt.jiangsu.gov.cn/col/col91340/index.html';

const rows = new Map();

await withPage(
  URL_,
  async (page) => {
    await page.waitForTimeout(3000);

    // 分页按钮不在 .default_pgContainer 里（那些容器是空壳），
    // 只能按 DOM 顺序找「紧跟在这张表后面」的第一个 .default_pgNext
    const findNext = (idx) => {
      const tables = [...document.querySelectorAll('table')].filter((t) => t.innerText.includes('景点景区名称'));
      const t = tables[idx];
      if (!t) return null;
      const nexts = [...document.querySelectorAll('.default_pgNext')];
      return nexts.find((n) => t.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
    };

    const tableCount = await page.evaluate(
      () => [...document.querySelectorAll('table')].filter((t) => t.innerText.includes('景点景区名称')).length,
    );
    console.log('表格数', tableCount);

    for (let ti = 0; ti < tableCount; ti++) {
      let prevFirst = '';
      for (let p = 1; p <= 25; p++) {
        const info = await page.evaluate(
          ({ idx, fnSrc }) => {
            const tables = [...document.querySelectorAll('table')].filter((t) => t.innerText.includes('景点景区名称'));
            const t = tables[idx];
            if (!t) return null;
            const data = [...t.querySelectorAll('tr')]
              .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim()))
              .filter((r) => r.length >= 3 && /^[1-5]A$/.test(r[r.length - 1] || ''));
            const nexts = [...document.querySelectorAll('.default_pgNext')];
            const next = nexts.find((n) => t.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
            const disabled = !next || /disabled/i.test(next.className || '') || next.getAttribute('disabled') !== null;
            return { data, first: data[0]?.join('|') ?? '', hasNext: !!next && !disabled };
          },
          { idx: ti, fnSrc: '' },
        );

        if (!info) break;
        for (const r of info.data) rows.set(r.join('|'), r);

        console.log(`表 ${ti} 第 ${p} 页：${info.data.length} 行，累计 ${rows.size}`);
        if (!info.hasNext) break;
        if (p > 1 && info.first === prevFirst) {
          console.log(`表 ${ti} 内容未变化，停止`);
          break;
        }
        prevFirst = info.first;

        const clicked = await page.evaluate((idx) => {
          const tables = [...document.querySelectorAll('table')].filter((t) => t.innerText.includes('景点景区名称'));
          const t = tables[idx];
          if (!t) return false;
          const nexts = [...document.querySelectorAll('.default_pgNext')];
          const btn = nexts.find((n) => t.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
          if (!btn || /disabled/i.test(btn.className || '')) return false;
          btn.click();
          return true;
        }, ti);
        if (!clicked) break;
        await page.waitForTimeout(1500);
      }
    }
  },
  { timeout: 60000, warmupWait: 3500 },
);

const list = [...rows.values()];
fs.writeFileSync(OUT, JSON.stringify(list, null, 1), 'utf8');
const lv = {};
for (const r of list) lv[r[r.length - 1]] = (lv[r[r.length - 1]] ?? 0) + 1;
console.log(`\n合计 ${list.length} 条`, JSON.stringify(lv), '→', path.relative(ROOT, OUT));
