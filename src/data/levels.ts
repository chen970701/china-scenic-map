import type { LevelFilter } from '../types';

/**
 * A 级筛选档位。
 * 5A / 4A 是"值得专程去"的那一档，也是大多数人真正想筛的；3A 留作中间档，
 * 2A / 1A 多是本地小景点，不单列（都包含在「不限」里）。
 * 颜色与地图上的等级圆点（global.css 的 .poi-dot--5a 等）保持一致。
 */
export const LEVEL_FILTERS: { value: LevelFilter; label: string; color: string; hint: string }[] = [
  { value: '5A', label: '5A', color: '#b0333f', hint: '国家最高等级景区，全国仅 300 余家' },
  { value: '4A', label: '4A', color: '#c8862f', hint: '国家级精品景区，出行首选' },
  { value: '3A', label: '3A', color: '#7d8f76', hint: '国家级景区，多为地方性景点' },
];
