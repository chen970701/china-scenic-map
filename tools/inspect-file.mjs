/**
 * 附件体检：下载一个 xlsx/xls/pdf/html，按类型解析，报告能抽出多少条景区
 *
 * 搜到的候选一堆，逐个进浏览器看不现实。先下载下来用解析器跑一遍，
 * 条数、表头、等级分布一看就知道是不是名录，不是的直接丢掉。
 *
 * 用法：node tools/inspect-file.mjs <url> [更多url...]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWorkbook, parseHtmlTables } from './lib/parse-a-list.mjs';
import { parsePdfTables } from './lib/parse-pdf-list.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tmpdata', 'prov', 'raw');
fs.mkdirSync(CACHE, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function curlBuf(url) {
  const { stdout } = await execFileAsync('curl', ['-sL', '--compressed', '-m', '90', '-A', UA, url], {
    encoding: 'buffer',
    maxBuffer: 120 * 1024 * 1024,
    timeout: 100000,
  });
  return stdout;
}

function decodeHtml(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  return bad > 15 ? new TextDecoder('gb18030').decode(buf) : utf8;
}

const urls = process.argv.slice(2);

for (const url of urls) {
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
  console.log(`\n=== ${decodeURIComponent(url).slice(0, 120)}`);
  let buf;
  try {
    buf = await curlBuf(url);
  } catch (error) {
    console.log('下载失败', error.message?.slice(0, 60));
    continue;
  }
  if (!buf.length) {
    console.log('空响应');
    continue;
  }
  console.log(`大小 ${(buf.length / 1024).toFixed(0)} KB`);

  // 按 magic number 判断真实类型，扩展名常骗人（download?ID=xxx）
  const isPdf = buf.subarray(0, 4).toString() === '%PDF';
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isOle = buf[0] === 0xd0 && buf[1] === 0xcf;
  const looksHtml = /^\s*<(!doctype|html)/i.test(buf.subarray(0, 200).toString('latin1'));

  let records = [];
  try {
    if (isPdf) {
      const pdfPath = path.join(CACHE, `insp-${hash}.pdf`);
      fs.writeFileSync(pdfPath, buf);
      const jsonPath = pdfPath.replace(/\.pdf$/, '.json');
      await execFileAsync('python', [path.join(ROOT, 'tools', 'lib', 'pdf_tables.py'), pdfPath, '--json', jsonPath], {
        timeout: 240000,
      });
      records = parsePdfTables(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))).records;
    } else if (isZip || isOle) {
      const out = parseWorkbook(buf, '');
      records = out.records;
      console.log('工作表', out.sheet, '| 表头', (out.header || []).join(' | ').slice(0, 100));
    } else if (looksHtml) {
      const out = parseHtmlTables(decodeHtml(buf), '');
      records = out.records;
      console.log('表头', (out.header || []).join(' | ').slice(0, 100));
    } else {
      console.log('未知类型 magic', buf.subarray(0, 8).toString('hex'));
      continue;
    }
  } catch (error) {
    console.log('解析失败', error.message?.slice(0, 80));
    continue;
  }

  const lv = {};
  for (const r of records) lv[r.level || '无等级'] = (lv[r.level || '无等级'] ?? 0) + 1;
  console.log(`解析 ${records.length} 条`, JSON.stringify(lv));
  for (const r of records.slice(0, 4)) {
    console.log(`   ${r.name?.slice(0, 34).padEnd(36)} ${r.level} | ${r.cityName || '-'} | ${r.districtName || '-'}`);
  }
}
