import type { Attraction, AttractionCategory, LevelFilter } from '../types';

/**
 * 景点搜索：以名称匹配为主，同时支持地址关键词（如「龙井路」）
 * 不匹配详细介绍，避免"灵隐寺"这类词把相邻景点也一起命中。
 */
export function searchAttractions(list: Attraction[], query: string): Attraction[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (item) =>
      item.name.toLowerCase().includes(q) || item.address.toLowerCase().includes(q),
  );
}

/** 类别筛选，category 为 null 表示全部 */
export function filterByCategory(
  list: Attraction[],
  category: AttractionCategory | null,
): Attraction[] {
  if (!category) return list;
  return list.filter((item) => item.category === category);
}

/** 统计各类别数量（用于筛选按钮上的角标） */
export function countByCategory(list: Attraction[]): Record<string, number> {
  return list.reduce<Record<string, number>>((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});
}

/** 等级筛选，level 为 null 表示不限 */
export function filterByLevel(list: Attraction[], level: LevelFilter | null): Attraction[] {
  if (!level) return list;
  return list.filter((item) => item.level === level);
}

/** 统计各等级景区数量；无等级（OSM 自动导入）与 2A/1A 一并计入 none，不占筛选档位 */
export function countByLevel(list: Attraction[]): Record<LevelFilter | 'none', number> {
  const acc: Record<LevelFilter | 'none', number> = { '5A': 0, '4A': 0, '3A': 0, none: 0 };
  for (const item of list) {
    if (item.level === '5A' || item.level === '4A' || item.level === '3A') acc[item.level] += 1;
    else acc.none += 1;
  }
  return acc;
}
