/**
 * 名录入口发现 v2：首页 → 栏目 → 名录（两级下钻）
 *
 * v1 只认首页导航里字面含「A级/景区/名录」的链接，命中率低，因为：
 *   - 多数省厅首页导航写的是「公共服务」「政务公开」，景区名录在里面第二层
 *   - 部分站点导航是图片或 JS 渲染
 * 所以改成：先把「像栏目的链接」都收上来（文本或路径命中 ggfw/bsfw/zwgk/ml 等），
 * 再进每一个栏目页找带「景区 / A级 / 名录」的子链接，最后判断子页面形态。
 *
 * 用法：node tools/find-a-nav2.mjs [省名...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'province-sites.json'), 'utf8'));

const COLUMN_HINT = /(公共服务|政务公开|政务服务|便民服务|查询服务|信息查询|名录|数据开放|文旅名录|景区)/;
const COLUMN_PATH = /\/(ggfw|bsfw|zwgk|zfxxgk|xxgk|cxfw|mlcx|wlgz|lyfw|fwzn)\//i;
const ITEM_HINT = /(A级|Ａ级|a级|景区|名录|旅游区)/;

/** 收集页面所有链接（可选过滤） */
const collect = (mode) => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
    let href;
    try {
      href = new URL(a.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    if (!/^https?:/.test(href)) continue;
    if (/^javascript:|^mailto:/i.test(a.getAttribute('href') || '')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ text: text.slice(0, 60), href });
    if (out.length > 600) break;
  }
  return out;
};

const columnsFn = ({ colHint, colPath }) => {
  const t = new RegExp(colHint);
  const p = new RegExp(colPath);
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
    let href;
    try {
      href = new URL(a.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    if (!/^https?:/.test(href)) continue;
    if (seen.has(href)) continue;
    const byText = t.test(text) && text.length <= 14;
    const byPath = p.test(href);
    if (!byText && !byPath) continue;
    seen.add(href);
    out.push({ text, href });
    if (out.length > 40) break;
  }
  return out;
};

const itemsFn = ({ itemHint }) => {
  const t = new RegExp(itemHint);
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t.test(text)) continue;
    let href;
    try {
      href = new URL(a.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    if (!/^https?:/.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ text: text.slice(0, 70), href });
    if (out.length > 25) break;
  }
  return out;
};

const inspectHtml = () => {
  let best = 0;
  let sample = [];
  for (const t of document.querySelectorAll('table')) {
    const rows = t.querySelectorAll('tr').length;
    if (rows > best) {
      best = rows;
      sample = [...t.querySelectorAll('tr')].slice(0, 2).map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 90));
    }
  }
  const files = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = new URL(a.getAttribute('href'), location.href).href;
    if (!/\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(href)) continue;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    // 页脚常年挂着「招商引资」这类无关附件，只保留名字像名录的
    if (!/(景区|名录|名单|A级|旅游)/.test(text)) continue;
    files.push({ href, text });
  }
  const plain = document.body ? document.body.innerText : '';
  return {
    tableRows: best,
    sample,
    files: files.slice(0, 5),
    hasListTitle: /(A级|Ａ级)[^\n]{0,12}(景区|旅游区)[^\n]{0,8}(名录|名单)/.test(plain),
    textLen: plain.length,
  };
};

const only = process.argv.slice(2);
const targets = only.length
  ? SITES.filter((s) => only.some((p) => s.province.includes(p) || p.includes(s.province)))
  : SITES;

const report = [];

for (const site of targets) {
  process.stdout.write(`\n${site.province} `);
  const result = { ...site, ok: false, found: [], note: '' };
  try {
    await withPage(
      site.base,
      async (page) => {
        await page.waitForTimeout(2200);
        result.homeTitle = (await page.title()).slice(0, 40);

        // 第一级：首页里的「像栏目」的链接
        const cols = await page.evaluate(columnsFn, { colHint: COLUMN_HINT.source, colPath: COLUMN_PATH.source });
        // 去重后最多进 10 个栏目
        const colTargets = cols.slice(0, 8);
        result.columns = colTargets.map((c) => `${c.text}→${c.href}`.slice(0, 100));
        process.stdout.write(`栏目 ${colTargets.length} `);

        const seenItems = new Set();
        for (const col of colTargets) {
          if (result.found.length >= 6) break;
          try {
            await page.goto(col.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1000);
          } catch {
            continue;
          }

          // 栏目页自己可能就是名录页（只认大表格或带名录字样的附件）
          const self = await page.evaluate(inspectHtml);
          if (self.tableRows >= 20 || self.files.length) {
            const key = page.url();
            if (!seenItems.has(key)) {
              seenItems.add(key);
              result.found.push({
                kind: self.tableRows >= 20 ? 'table' : 'file',
                text: col.text || '（栏目页）',
                url: key,
                from: col.href,
                ...self,
              });
            }
          }

          // 第二级：栏目里的名录子链接
          const items = await page.evaluate(itemsFn, { itemHint: ITEM_HINT.source });
          for (const it of items.slice(0, 4)) {
            if (result.found.length >= 6) break;
            if (seenItems.has(it.href)) continue;
            seenItems.add(it.href);
            try {
              await page.goto(it.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForTimeout(900);
              const info = await page.evaluate(inspectHtml);
              const kind = info.tableRows >= 20 ? 'table' : info.files.length ? 'file' : info.hasListTitle ? 'list' : '';
              if (!kind) continue;
              result.found.push({ kind, text: it.text, url: page.url(), from: col.href, ...info });
            } catch {
              // 忽略单条失败
            }
          }
        }
        result.ok = true;
      },
      { timeout: 45000, warmupWait: 2500 },
    );
  } catch (error) {
    result.note = error.message?.slice(0, 80) ?? '';
  }

  console.log(`→ 命中 ${result.found.length} ${result.note}`);
  for (const f of result.found) {
    console.log(`    · [${f.kind}] ${f.text.slice(0, 26)} rows=${f.tableRows} files=${f.files.length} → ${f.url.slice(0, 100)}`);
    if (f.sample?.[0]) console.log(`        ${f.sample[0].slice(0, 95)}`);
    if (f.files?.[0]) console.log(`        附件 ${f.files[0].text.slice(0, 30)} ${f.files[0].href.slice(0, 90)}`);
  }
  report.push(result);
  await new Promise((r) => setTimeout(r, 300));
}

fs.writeFileSync(path.join(OUT_DIR, 'nav2.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('\n写入 tmpdata/prov/nav2.json');
