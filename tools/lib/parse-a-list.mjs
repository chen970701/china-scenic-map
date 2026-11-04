/**
 * 省级 A 级景区名录解析器（共用）
 *
 * 各省发布格式五花八门：
 *   福建/山东  xlsx，表头「序号|景区名称|所在地市|县（市）区|等级|公告时间」
 *   有些省      HTML 表格，或 doc/docx，或直接正文列举
 * 这里统一收敛成：
 *   { name, level, cityName, districtName, announceDate }
 * 行政区到 adcode 的换算另行处理（各省叫法不统一，如「湄洲岛」不是标准区县名）。
 */
import XLSX from 'xlsx';

/**
 * 表头关键词 → 标准字段
 *
 * 顺序有讲究：区县规则必须排在市州之前。
 * 新疆表头「序号|地州|县市|景区名称|等级」里，「县市」既像县（强特征）又像市（市$），
 * 谁先匹配谁拿走这一列，所以把更具体的区县规则前置。
 */
const HEADER_RULES = [
  { field: 'name', re: /(景区名称|旅游景区名称|景区名|景点名称|名称|景区)/ },
  { field: 'level', re: /(等级|级别|质量等级|A级)/ },
  { field: 'districtName', re: /(区县|所在县|县市区|县市|行政区|^区$|^县$|县\(市\)区)/ },
  { field: 'cityName', re: /(所在市|所在地市|所在地|地市|市州|地州|城市|地区|市县|所属市|市\s*\(|市$|所在地区)/ },
  { field: 'announceDate', re: /(公告时间|评定时间|批准时间|公布时间|时间|日期)/ },
  { field: 'address', re: /(地址|所在位置|位置)/ },
];

function normCell(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 等级标准化：4A / AAAA / 国家4A级 → 4A */
export function normLevel(raw) {
  const s = normCell(raw).toUpperCase().replace(/\s/g, '');
  // 「AAAA级」「AAA」这种只写 A 个数的写法，A 的个数就是等级
  const aOnly = s.match(/^(A{1,5})(?:级|景区|旅游景区)?$/);
  if (aOnly) return `${aOnly[1].length}A`;
  const m = s.match(/([1-5])\s*A/);
  if (m) return `${m[1]}A`;
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
  const m2 = s.match(/([一二三四五])\s*A/);
  if (m2) return `${cn[m2[1]]}A`;
  if (/AAAAA/.test(s)) return '5A';
  return '';
}

/** 在一张二维表里定位表头行，并给出列映射 */
function locateHeader(rows, defaultLevel = '') {
  // 有些表头写「景区名称」，有些只写「名称」（四川），不能强求含「景区」二字
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const row = rows[i].map(normCell);
    const joined = row.join('|');
    // 表格上方常有一行大标题（「新疆4A级旅游景区名录」），它是单格且含「景区」，
    // 会被误认为表头；真表头至少有两列有内容
    if (row.filter(Boolean).length < 2) continue;
    // 表头里的名称列有三种写法：「景区名称」「名称」「景区」（新疆 5A 表就是最后这种），
    // 前置校验要一并认，否则整张表会被判成没有名称列
    if (!/(名称|景点|景区名|景区)/.test(joined)) continue;
    // 有些名录整页只有同一等级，表头干脆没有等级列（上海的 4A 名录），此时用来源标题推等级
    if (!defaultLevel && !/(等级|级别|A级)/.test(joined)) continue;
    // 「名称 + 等级」在各种名录里都出现（饭店、旅行社），这里再要求上下文是景区
    const context = rows.slice(Math.max(0, i - 6), i + 40).map((r) => r.join('')).join('');
    if (!/(景区|旅游区|景点)/.test(context)) continue;
    const map = {};
    row.forEach((cell, idx) => {
      if (!cell) return;
      // 表头常为了对齐加空格（「地  区」），或用括号补注（福建「县（市）区」、新疆「县(市)」），
      // 比对时把空白和标点一起去掉，剩下的纯文字再走规则
      const probe = cell.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '');
      for (const rule of HEADER_RULES) {
        if (map[rule.field] !== undefined) continue;
        if (rule.re.test(probe)) {
          map[rule.field] = idx;
          break;
        }
      }
    });
    if (map.name === undefined) continue;
    if (map.level === undefined && !defaultLevel) continue;
    return { headerRow: i, map, header: row };
  }
  return null;
}

/**
 * 行数组 → records（xlsx / html / 分页表格共用）
 * @param {string[][]} rows
 * @param {string} defaultLevel 表里没有等级列时用的默认等级
 */
export function parseRows(rows, defaultLevel = '') {
  const head = locateHeader(rows, defaultLevel);
  if (!head) return { records: [], header: [], skipped: 0, headerRow: -1 };

  const records = [];
  let skipped = 0;
  let lastCity = '';
  for (const row of rows.slice(head.headerRow + 1)) {
    const name = normCell(row[head.map.name]);
    if (!name) continue;
    if (/^(合计|总计|小计|注[:：]|说明)/.test(name)) continue;
    const level = head.map.level !== undefined ? normLevel(row[head.map.level]) : defaultLevel;
    if (!level) {
      skipped += 1;
      continue;
    }
    // 城市列常是合并单元格，只在每个城市第一行写名字，后面留空 —— 向下继承
    let cityName = head.map.cityName !== undefined ? normCell(row[head.map.cityName]) : '';
    if (cityName) lastCity = cityName;
    else if (head.map.cityName !== undefined) cityName = lastCity;
    records.push({
      name,
      level,
      cityName,
      districtName: head.map.districtName !== undefined ? normCell(row[head.map.districtName]) : '',
      announceDate: head.map.announceDate !== undefined ? normCell(row[head.map.announceDate]) : '',
      address: head.map.address !== undefined ? normCell(row[head.map.address]) : '',
    });
  }
  return { records, header: head.header, skipped, headerRow: head.headerRow };
}

/**
 * 解析 xlsx/xls buffer
 * @returns {{records: Array, sheet: string, header: string[], skipped: number}}
 */
export function parseWorkbook(buffer, defaultLevel = '') {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const collected = [];
  const usedSheets = [];
  let header = [];
  let skipped = 0;

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
    if (!rows.length) continue;
    // 江西一份工作簿按等级拆成 4 个 sheet（「5A景区」「4A景区」…），表里没有等级列，
    // 等级要从 sheet 名补；多 sheet 的结果要合并，不能只留最大的那个
    const sheetLevel = defaultLevel || normLevel(sheetName);
    const parsed = parseRows(rows, sheetLevel);
    if (!parsed.records.length) continue;
    collected.push(...parsed.records);
    usedSheets.push(sheetName);
    skipped += parsed.skipped;
    if (!header.length) header = parsed.header;
  }

  // 「总表 + 分表」这类重复放在不同 sheet 里，按名称+等级去重
  const seen = new Set();
  const records = collected.filter((r) => {
    const key = `${r.name}|${r.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { records, sheet: usedSheets.join(','), header, skipped };
}

/** 解析 HTML 表格（附件为网页版的省份） */
export function parseHtmlTables(html, defaultLevel = '') {
  const tables = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html))) tables.push(m[0]);

  let best = { records: [], header: [], skipped: 0 };
  for (const table of tables) {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(table))) {
      const cells = [];
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let c;
      while ((c = cellRe.exec(tr[1]))) {
        cells.push(
          c[1]
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim(),
        );
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length < 3) continue;

    const head = locateHeader(rows, defaultLevel);
    if (!head) continue;

    const records = [];
    let skipped = 0;
    for (const row of rows.slice(head.headerRow + 1)) {
      const name = normCell(row[head.map.name]);
      if (!name || /^(合计|总计|小计|注[:：]|说明)/.test(name)) continue;
      const level = head.map.level !== undefined ? normLevel(row[head.map.level]) : defaultLevel;
      if (!level) {
        skipped += 1;
        continue;
      }
      records.push({
        name,
        level,
        cityName: head.map.cityName !== undefined ? normCell(row[head.map.cityName]) : '',
        districtName: head.map.districtName !== undefined ? normCell(row[head.map.districtName]) : '',
        announceDate: head.map.announceDate !== undefined ? normCell(row[head.map.announceDate]) : '',
        address: head.map.address !== undefined ? normCell(row[head.map.address]) : '',
      });
    }
    if (records.length > best.records.length) best = { records, header: head.header, skipped };
  }
  return best;
}

/**
 * 从公告正文里抽名单（"1.XXX景区"、"（一）XXX景区" 这类）
 * 用于没有附件、正文直接列名单的公告。
 */
export function parseAnnouncementText(text, level) {
  const lines = text
    .split(/[\n\r]/)
    .map((l) => l.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const out = [];
  const numbered = /^(?:[（(]?[0-9]{1,3}[)）.、]|[0-9]{1,3}[、.]|[一二三四五六七八九十]{1,3}[、.])\s*(.{2,60}?)(?:景区|旅游区|风景区|度假区|公园|博物馆|古镇|古城|街区|湿地|遗址|乐园|园区)\s*$/;
  for (const line of lines) {
    const m = line.match(numbered);
    if (!m) continue;
    const name = line.replace(/^(?:[（(]?[0-9]{1,3}[)）.、]|[0-9]{1,3}[、.]|[一二三四五六七八九十]{1,3}[、.])\s*/, '').trim();
    if (name.length < 3 || name.length > 40) continue;
    if (/^(特此|附件|名单|如下|公示|公告)/.test(name)) continue;
    out.push({ name, level: level ?? '', cityName: '', districtName: '', announceDate: '', address: '' });
  }
  return out;
}

/**
 * 解析「按等级分组、无等级列」的 HTML 表 —— 统计年鉴里的旅游章节常见这种排法：
 *
 *   景区名称 | Scenic Spot Name | 地  址 | Address
 *   5A级景区 | AAAAA State Class Scenic Spots
 *   塔尔寺景区 | Ta'er Lamasery | 西宁市湟中区鲁沙尔镇
 *   4A级景区 | ...
 *
 * 等级靠分组标题行切换，表头里没有等级列，locateHeader 认不出来。
 * 续表（续表1 / 续表2）通常不再重复分组标题，所以等级状态要跨页传递，
 * 调用方把一个 state 对象按页顺序传进来即可。
 *
 * @param {string} html
 * @param {{level?: string}} state 跨页共享的当前等级
 */
export function parseGroupedTable(html, state = {}) {
  state.level = state.level ?? '';
  const records = [];
  let last = null;
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((m) => m[0]);

  for (const table of tables) {
    const rows = [];
    for (const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [];
      for (const td of tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        const text = td[1]
          .replace(/<br\s*\/?>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\u3000/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) cells.push(text);
      }
      if (cells.length) {
        const line = cells.join(' ');
        // 整张年鉴页面就是一张大表，页眉「19-9 续表1 Continued」也在里面
        if (/^(19|1[0-9])-\d/.test(line) || /续表\s*\d/.test(line)) continue;
        rows.push(cells);
      }
    }

    for (const cells of rows) {
      const line = cells.join(' ');
      const group = line.match(/([1-5])\s*A级景区/);
      if (group) {
        state.level = `${group[1]}A`;
        continue;
      }
      // 表头：景区名称 / Scenic Spot Name / 地 址 / Address
      if (/景区名称/.test(line) || /Scenic Spot Name/i.test(line) || /^地\s*址/.test(line)) continue;

      // 中文单元格里第一格是名称，其余拼成地址；英文列（Ta'er Lamasery）整体跳过
      const cn = cells.filter((c) => /[\u4e00-\u9fa5]/.test(c) && !/^\d+$/.test(c));
      if (!cn.length || !state.level) continue;
      const name = cn[0];
      if (name.length < 2 || /^(序号|备注|合计|总计)$/.test(name)) continue;
      const address = cn.slice(1).join('');
      // 年鉴排版会把长名称折成两行：上一行只有名称，下一行才是「名称后半 + 地址」，
      // 例如「西宁市新华联」/「国际旅游城·童梦乐园」。这种情况合并回上一条
      if (last && !last.address && address && !/^(注|说明)[:：]/.test(name)) {
        last.name += name;
        last.address = address;
        continue;
      }
      // 表下注释行不是景区
      if (/^(注|说明|数据来源)[:：]?/.test(name) && !address) continue;
      // 「景区（城西区）」「景区(德令哈市)」是名称跨行后剩下的注释碎片，不是独立景区
      if (!address && /^[^（(]{0,6}[（(][^）)]{2,8}[）)]$/.test(name)) continue;
      const record = {
        name,
        level: state.level,
        cityName: '',
        districtName: '',
        announceDate: '',
        address,
      };
      records.push(record);
      last = record;
    }
  }
  return { records, level: state.level };
}
