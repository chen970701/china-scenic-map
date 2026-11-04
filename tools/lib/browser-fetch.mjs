/**
 * 用真实浏览器内核抓页面（应对 JS cookie 挑战 / 前端渲染的名录页）
 *
 * 江苏省厅的页面首请求会返回 521 + 一段前端脚本，
 * 浏览器跑完才拿到正常页面。curl 拿不到，只能用内核跑。
 *
 * 做法：先打开一次页面把 cookie 种上，再在页面上下文里直接 fetch 目标 URL，
 * 这样翻页只要一次导航，比逐页 goto 快得多。
 *
 * 用法（作为库）：
 *   import { withPage, fetchMany } from './lib/browser-fetch.mjs';
 *   await withPage(async (page, fetchMany) => {
 *     const pages = await fetchMany(['https://...pageNum=0', 'https://...pageNum=1']);
 *   });
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

/**
 * 打开浏览器 → 访问 warmupUrl（可选）→ 执行回调 → 关闭
 * 回调参数：(page, fetchMany)
 *   fetchMany(urls) 在页面上下文里并发抓取，自动带 cookie，返回按顺序的 HTML 字符串数组
 */
export async function withPage(warmupUrl, handler, options = {}) {
  const executablePath = findChrome();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });
  const context = await browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    if (warmupUrl) {
      await page.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout ?? 60000 });
      // 给页面脚本一点时间跑完并重新加载
      await page.waitForTimeout(options.warmupWait ?? 2500);
    }

    const fetchMany = async (urls) => {
      const result = await page.evaluate(async (list) => {
        const out = [];
        for (const url of list) {
          try {
            const res = await fetch(url, { credentials: 'include' });
            out.push(await res.text());
          } catch (error) {
            out.push('');
          }
        }
        return out;
      }, urls);
      return result;
    };

    return await handler(page, fetchMany, context);
  } finally {
    await browser.close();
  }
}

/** 直接把 url 列表抓成 HTML 数组（自带浏览器生命周期） */
export async function fetchPages(urls, warmupUrl) {
  return withPage(warmupUrl ?? urls[0], async (page, fetchMany) => fetchMany(urls));
}
