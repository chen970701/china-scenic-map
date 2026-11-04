/**
 * PDF 名录解析（配合 tools/lib/pdf_tables.py 的输出）
 *
 * 省厅 PDF 名录的典型版式：
 *   序号 | 景区名称 | 等级 | 备注
 *   太原市：34家
 *   1    | 晋祠天龙山景区 | 5A |
 *   ...
 *   大同市：30家
 *   ...
 *
 * 城市不在列里，而是靠一条「城市：N家」的分组标题行表达，
 * 所以要顺序扫描、维护 currentCity 上下文。表格被 pdfplumber 按页切成多块，
 * 分组行可能出现在任意一块的首行，也可能跨块（上一块结尾是城市 A 的数据）。
 */
import { normLevel } from './parse-a-list.mjs';

const clean = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/** 「太原市：34家」「大同市:30 家」「省直：5家」 */
const GROUP_RE = /^([\u4e00-\u9fa5]{2,12}(?:市|州|盟|地区|区|县|省直|厅直)?)\s*[:：]\s*\d+\s*家?$/;

/** 表头 / 说明行 */
const isHeaderish = (row) => {
  const j = row.join('');
  return /(序号|景区名称|旅游景区名称|等级|备注)/.test(j) && !/\dA/.test(j);
};

/**
 * @param {{pages: {page:number, tables: string[][][]}[]}} pdfJson
 * @returns {{records: {name:string, level:string, cityName:string, districtName:string, announceDate:string, address:string}[], groups: string[]}}
 */
export function parsePdfTables(pdfJson) {
  const records = [];
  const groups = [];
  let currentCity = '';

  for (const page of pdfJson.pages ?? []) {
    for (const table of page.tables ?? []) {
      for (const rawRow of table) {
        const row = rawRow.map(clean).filter((c, i, arr) => !(c === '' && i === arr.length - 1));
        if (!row.length) continue;
        const joined = row.join('');

        // 整行只有一个格子且像「城市：N家」→ 切换当前城市
        const nonEmpty = row.filter(Boolean);
        if (nonEmpty.length === 1) {
          const m = nonEmpty[0].match(GROUP_RE);
          if (m) {
            currentCity = m[1];
            if (!groups.includes(currentCity)) groups.push(currentCity);
            continue;
          }
        }
        // 分组行也可能出现在首格，后面几格为空（已过滤）
        const headGroup = nonEmpty[0]?.match(GROUP_RE);
        if (headGroup && nonEmpty.length <= 2) {
          currentCity = headGroup[1];
          if (!groups.includes(currentCity)) groups.push(currentCity);
          continue;
        }

        if (isHeaderish(row)) continue;

        // 数据行：必须有等级；名称取等级列之前第一个「像名字」的格子
        const levelIdx = row.findIndex((c) => normLevel(c));
        if (levelIdx < 0) continue;
        const level = normLevel(row[levelIdx]);
        const head = row.slice(0, levelIdx).filter((c) => c.length >= 2 && !/^\d+$/.test(c) && !/^(备注|序号)$/.test(c));
        const name = head[0];
        if (!name) continue;
        // 名称之后、等级之前的格子若是地名（「所在地市」列），就用它当地市
        let cityName = currentCity;
        let districtName = '';
        const cityCell = head.find((c, i) => i > 0 && /^[\u4e00-\u9fa5]{2,12}?(?:市|州|盟|地区|县|区)$/.test(c));
        if (cityCell) cityName = cityCell;
        const ownCity = name.match(/^([\u4e00-\u9fa5]{2,6}?(?:市|州|盟|地区))/);
        if (ownCity && !cityName) cityName = ownCity[1];

        records.push({ name, level, cityName, districtName, announceDate: '', address: '' });
      }
    }
  }

  return { records, groups };
}
