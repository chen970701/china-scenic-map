/**
 * 浏览器版名录入口发现（应对 JS 渲染 / 521 cookie 挑战 / curl 被拦）
 *
 * 与 find-a-nav.mjs 的区别：那个用 curl，拿不到渲染后的 DOM；
 * 这个用真实 Chrome 内核，页面跑完脚本后再从 DOM 里取链接和表格。
 *
 * 判定口径与 curl 版一致：
 *   table —— 渲染后 DOM 里有 >=20 行的 table（多为名录正文表格）
 *   file  —— 挂着 xlsx/xls/doc/pdf/csv 附件
 *   list  —— 栏目页，还要再进一层
 *
 * 用法：node tools/find-a-nav-browser.mjs [省名...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'province-sites.json'), 'utf8'));

const NAV_HINT = /(A级|Ａ级|a级|景区|名录|旅游区)/;

/** 在页面 DOM 里取候选链接（已渲染） */
async function grabLinks(page, baseUrl) {
  return page.evaluate(
    ({ navSrc }) => {
      const re = new RegExp(navSrc);
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!re.test(text)) continue;
        if (text.length > 20) continue;
        let href;
        try {
          href = new URL(a.getAttribute('href'), location.href).href;
        } catch {
          continue;
        }
        if (/^javascript:|^mailto:/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        out.push({ text, href });
        if (out.length >= 12) break;
      }
      return out;
    },
    { navSrc: NAV_HINT.source },
  );
}

/** 页面形态判断 */
async function inspect(page) {
  return page.evaluate(() => {
    let bestTable = 0;
    let bestRowsSample = [];
    for (const t of document.querySelectorAll('table')) {
      const rows = t.querySelectorAll('tr').length;
      if (rows > bestTable) {
        bestTable = rows;
        bestRowsSample = [...t.querySelectorAll('tr')].slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 80));
      }
    }
    const files = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (/\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(href) || /\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(text)) {
        files.push({ href: new URL(href, location.href).href, text: text.slice(0, 60) });
      }
    }
    const plain = document.body ? document.body.innerText : '';
    const hasListTitle = /(A级|Ａ级)[^\n]{0,10}(景区|旅游区)[^\n]{0,6}名录/.test(plain);
    return { tableRows: bestTable, rowsSample: bestRowsSample, files: files.slice(0, 6), hasListTitle, textLen: plain.length };
  });
}

const only = process.argv.slice(2);
const targets = only.length
  ? SITES.filter((s) => only.some((p) => s.province.includes(p) || p.includes(s.province)))
  : SITES;

const report = [];

for (const site of targets) {
  process.stdout.write(`${site.province.padEnd(12)} `);
  let result = { ...site, ok: false, note: '', found: [] };
  try {
    await withPage(
      site.base,
      async (page) => {
        await page.waitForTimeout(2000);
        const homeTitle = await page.title();
        const cands = await grabLinks(page, site.base);
        result.homeTitle = homeTitle.slice(0, 40);
        result.candidates = cands.length;

        for (const c of cands) {
          if (result.found.length >= 4) break;
          // 已经拿到像样的表格就不再往下试，省时间
          if (result.found.some((f) => f.kind === 'table' && f.tableRows >= 30)) break;
          try {
            const resp = await page.goto(c.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(1200);
            const info = await inspect(page);
            const kind = info.tableRows >= 20 ? 'table' : info.files.length ? 'file' : info.hasListTitle ? 'list' : '';
            if (!kind) continue;
            result.found.push({
              text: c.text,
              url: page.url(),
              status: resp ? resp.status() : 0,
              tableRows: info.tableRows,
              rowsSample: info.rowsSample,
              files: info.files,
              hasListTitle: info.hasListTitle,
              kind,
            });
          } catch (error) {
            // 单条链接失败不影响整站
          }
        }
        result.ok = true;
      },
      { timeout: 45000, warmupWait: 2500 },
    );
  } catch (error) {
    result.note = error.message?.slice(0, 80) ?? 'unknown';
  }

  console.log(`${result.ok ? 'OK' : 'FAIL'} ${result.found.length} 命中 ${result.note}`);
  for (const f of result.found) {
    console.log(`    · [${f.kind}] ${f.text.slice(0, 22)} rows=${f.tableRows} files=${f.files.length} → ${f.url.slice(0, 95)}`);
    if (f.rowsSample?.[0]) console.log(`        ${f.rowsSample[0].slice(0, 90)}`);
  }
  report.push(result);
  await new Promise((r) => setTimeout(r, 400));
}

fs.writeFileSync(path.join(OUT_DIR, 'nav-browser.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/nav-browser.json');
