/**
 * 分页表格抓取（DataTables 形态）
 *
 * 政务站的「名录查询」多用 jQuery DataTables：数据全部在页面里，
 * 前端只渲染 N 条、靠翻页切换。curl 拿到的是空壳，必须跑内核。
 *
 * 做法：每页条数下拉拉到最大 → 逐页读最大的那张表 → 点「下一页」→ 到禁用为止。
 */
import { withPage } from './browser-fetch.mjs';

/**
 * @param {string} url
 * @param {{maxPages?: number, onProgress?: (msg: string) => void}} opts
 * @returns {Promise<string[][]>} 去重后的行数组（含表头行）
 */
export async function grabDataTable(url, opts = {}) {
  const maxPages = opts.maxPages ?? 40;
  const log = opts.onProgress ?? (() => {});
  const all = new Map();

  await withPage(
    url,
    async (page) => {
      await page.waitForTimeout(2800);

      // 1) 每页条数调到最大
      const sizeInfo = await page.evaluate(() => {
        const sels = [...document.querySelectorAll('select')];
        const target =
          sels.find((s) => [...s.options].some((o) => /^\d+$/.test(o.text.trim()) && Number(o.text) >= 50)) || sels[0];
        if (!target) return null;
        const opts = [...target.options].map((o) => ({ v: o.value, t: o.text.trim() }));
        const best = opts.filter((o) => /^\d+$/.test(o.t)).sort((a, b) => Number(b.t) - Number(a.t))[0];
        return { name: target.name || target.id, best };
      });
      if (sizeInfo?.best) {
        try {
          await page.selectOption(sizeInfo.name ? `select[name="${sizeInfo.name}"]` : 'select', sizeInfo.best.v);
          await page.waitForTimeout(1100);
          log(`每页条数 ${sizeInfo.best.t}`);
        } catch {
          // 下拉设不了就按默认条数翻页
        }
      }

      const readRows = () =>
        page.evaluate(() => {
          // 表头常被单独拆成一张 1 行的表（北京信用文旅站就是这样），选表时要排除
          const tables = [...document.querySelectorAll('table')].filter((t) => t.querySelectorAll('tr').length >= 2);
          if (!tables.length) return { head: [], rows: [] };
          const t = tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
          const trs = [...t.querySelectorAll('tr')];
          const thIdx = trs.findIndex((tr) => tr.querySelector('th'));
          const headIdx = thIdx >= 0 ? thIdx : -1;
          let head = headIdx >= 0 ? [...trs[headIdx].querySelectorAll('th,td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()) : [];
          if (!head.length) {
            // 没有 th 行：去别的表里找那行表头
            for (const other of document.querySelectorAll('table')) {
              if (other === t || other.querySelectorAll('tr').length > 2) continue;
              const txt = other.innerText.replace(/\s+/g, ' ').trim();
              if (/景区名称|景点/.test(txt)) {
                head = [...(other.querySelector('tr')?.querySelectorAll('th,td') ?? [])].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
                break;
              }
            }
          }
          const rows = trs
            .slice(headIdx >= 0 ? headIdx + 1 : 0)
            .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim()))
            .filter((r) => r.length >= 2 && r.some(Boolean));
          return { head, rows };
        });

      let header = [];
      for (let p = 1; p <= maxPages; p++) {
        const { head, rows } = await readRows();
        if (p === 1) header = head;
        let added = 0;
        for (const r of rows) {
          const key = r.join('|');
          if (all.has(key)) continue;
          all.set(key, r);
          added += 1;
        }
        log(`第 ${p} 页 ${rows.length} 行 / 新增 ${added}`);
        if (added === 0 && p > 1) break;

        const clicked = await page.evaluate(() => {
          const cands = [
            ...document.querySelectorAll('a.paginate_button.next, a.next, li.next a'),
            // Element UI / Ant Design 的分页
            ...document.querySelectorAll('.el-pagination .btn-next, .el-pagination button.btn-next'),
            ...document.querySelectorAll('.ant-pagination-next, .ant-pagination-next button'),
            ...[...document.querySelectorAll('a,button')].filter((a) => /^\s*(下一页|下页|>|›)\s*$/.test(a.textContent || '')),
          ];
          for (const a of cands) {
            const cls = `${a.className || ''} ${a.parentElement?.className || ''}`;
            if (/disabled|is-disabled/i.test(cls)) continue;
            if (a.getAttribute('aria-disabled') === 'true') continue;
            if (a.disabled) continue;
            a.click();
            return true;
          }
          return false;
        });
        if (!clicked) break;
        await page.waitForTimeout(1100);
      }
      if (header.length) all.set('__head__', header);
    },
    { timeout: 60000, warmupWait: 3000 },
  );

  const header = all.get('__head__') ?? [];
  all.delete('__head__');
  const rows = [...all.values()];
  return header.length ? [header, ...rows] : rows;
}
