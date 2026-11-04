/**
 * 单页探测：用真实内核打开一个 URL，报告渲染后的表格 / 附件 / 相关链接 / XHR 接口
 *
 * 省级名录站点形态各异（政务 CMS、Vue 单页、附件下载、JS 反爬），
 * curl 拿到的常是空壳。这个工具把渲染后的结构摊开看，决定用哪种解析策略。
 *
 * 用法：
 *   node tools/probe-page.mjs <url> [更多url...]
 *   --net    记录所有 XHR/fetch 请求及 JSON 响应片段（找接口用）
 *   --click  在页面里点击第一个文本匹配该正则的链接，再重新检测
 *   --text   打印正文
 *   --dump   把渲染后 HTML 写到 tmpdata/prov/probe-<hash>.html
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withPage } from './lib/browser-fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmpdata', 'prov');
fs.mkdirSync(OUT_DIR, { recursive: true });

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : '';
};
const urls = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--click');

const KEY = /(A级|Ａ级|a级|景区|名录|附件|下载|\.xlsx?|\.docx?|\.pdf)/i;

const inspectFn = (keySrc) => {
  const key = new RegExp(keySrc);
  const tables = [...document.querySelectorAll('table')].map((t, i) => {
    const rows = [...t.querySelectorAll('tr')];
    return {
      i,
      rows: rows.length,
      head: rows.slice(0, 3).map((r) =>
        [...r.querySelectorAll('td,th')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).slice(0, 8),
      ),
    };
  });
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
    let href;
    try {
      href = new URL(a.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    if (!key.test(text) && !/\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(href)) continue;
    const k = href + '|' + text;
    if (seen.has(k)) continue;
    seen.add(k);
    links.push({ text: text.slice(0, 60), href: href.slice(0, 160) });
  }
  return {
    title: document.title,
    textLen: document.body ? document.body.innerText.length : 0,
    tables: tables.sort((a, b) => b.rows - a.rows).slice(0, 4),
    links: links.slice(0, 40),
    bodySample: (document.body ? document.body.innerText : '').replace(/\n\s*\n+/g, '\n').slice(0, 1500),
  };
};

function report(info) {
  console.log('标题 :', info.title.slice(0, 60), `| 正文 ${info.textLen} 字`);
  if (info.tables.length) {
    for (const t of info.tables) {
      console.log(`表格#${t.i} ${t.rows} 行`);
      for (const r of t.head) console.log('   ', r.join(' | ').slice(0, 150));
    }
  } else console.log('表格 : 无');
  const files = info.links.filter((l) => /\.(xlsx?|docx?|pdf|csv)(\?|$)/i.test(l.href));
  if (files.length) {
    console.log('附件 :');
    for (const f of files.slice(0, 15)) console.log('   ', f.text.slice(0, 40).padEnd(42), f.href.slice(0, 110));
  }
  const other = info.links.filter((l) => !files.includes(l));
  if (other.length) {
    console.log('相关链接 :');
    for (const l of other.slice(0, 20)) console.log('   ', l.text.padEnd(32), l.href.slice(0, 110));
  }
  if (!info.tables.length && !info.links.length) console.log('正文片段 :', info.bodySample.replace(/\n/g, ' | ').slice(0, 400));
}

const clickRe = value('click');

for (const url of urls) {
  console.log(`\n=== ${url}`);
  try {
    await withPage(
      url,
      async (page) => {
        const net = [];
        if (flag('net')) {
          page.on('response', async (resp) => {
            const ct = resp.headers()['content-type'] || '';
            const u = resp.url();
            if (!/json|javascript\/x-|text\/plain/.test(ct)) return;
            if (/\.(js|css|png|jpg|svg|woff2?)(\?|$)/i.test(u)) return;
            let sample = '';
            try {
              const body = await resp.text();
              sample = body.replace(/\s+/g, ' ').slice(0, 240);
            } catch {}
            net.push({ status: resp.status(), url: u.slice(0, 130), sample });
          });
        }

        await page.waitForTimeout(2500);

        if (clickRe) {
          const clicked = await page.evaluate((src) => {
            const re = new RegExp(src);
            for (const a of document.querySelectorAll('a[href]')) {
              const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
              if (re.test(text)) {
                a.click();
                return text.slice(0, 40);
              }
            }
            return '';
          }, clickRe);
          if (clicked) {
            console.log(`已点击 : ${clicked}`);
            await page.waitForTimeout(3000);
          } else console.log('未找到可点击链接');
        }

        const info = await page.evaluate(inspectFn, KEY.source);
        report(info);
        if (flag('text')) console.log('正文 :\n' + info.bodySample);

        if (net.length) {
          console.log(`\nXHR/fetch ${net.length} 条（去重后）：`);
          const seen = new Set();
          for (const n of net) {
            const k = n.url.split('?')[0];
            if (seen.has(k)) continue;
            seen.add(k);
            console.log(`  [${n.status}] ${n.url}`);
            if (n.sample) console.log(`        ${n.sample.slice(0, 200)}`);
          }
        }

        if (flag('dump')) {
          const html = await page.content();
          const f = path.join(OUT_DIR, `probe-${crypto.createHash('md5').update(url + clickRe).digest('hex').slice(0, 8)}.html`);
          fs.writeFileSync(f, html, 'utf8');
          console.log('已存 :', path.relative(ROOT, f), `(${(html.length / 1024).toFixed(0)} KB)`);
        }
      },
      { timeout: 45000, warmupWait: 3000 },
    );
  } catch (error) {
    console.log('失败 :', error.message?.slice(0, 100));
  }
}
