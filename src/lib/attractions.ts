import type { Attraction, AttractionSummary } from '../types';

/**
 * 景点数据加载器
 *
 * 全国景点数据按"省"拆分成独立文件，进入某个省才加载明细；
 * /data/attractions/summary.json 只包含各省/各区县的数量，用于地图气泡与省份导航。
 */

const BASE = `${import.meta.env.BASE_URL}data/attractions`;

let summaryPromise: Promise<AttractionSummary> | null = null;
const provinceCache = new Map<number, Promise<Attraction[]>>();

export function loadAttractionSummary(): Promise<AttractionSummary> {
  if (!summaryPromise) {
    summaryPromise = fetch(`${BASE}/summary.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`景点索引加载失败（HTTP ${res.status}）`);
        return (await res.json()) as AttractionSummary;
      })
      .catch((err: unknown) => {
        summaryPromise = null;
        throw err instanceof Error ? err : new Error('景点索引加载失败');
      });
  }
  return summaryPromise;
}

export function loadProvinceAttractions(provinceAdcode: number): Promise<Attraction[]> {
  const cached = provinceCache.get(provinceAdcode);
  if (cached) return cached;

  const task = fetch(`${BASE}/${provinceAdcode}.json`)
    .then(async (res) => {
      // 该省暂无数据时返回空数组，而不是报错
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`景点数据请求失败（HTTP ${res.status}）`);
      const json = (await res.json()) as { items?: Attraction[] };
      return Array.isArray(json.items) ? json.items : [];
    })
    .catch((err: unknown) => {
      provinceCache.delete(provinceAdcode);
      throw err instanceof Error ? err : new Error('景点数据加载失败');
    });

  provinceCache.set(provinceAdcode, task);
  return task;
}

/** 属于某个行政区（含其下级）的景点 */
export function attractionsUnderRegion(items: Attraction[], adcode: number): Attraction[] {
  return items.filter((item) => item.path.includes(adcode));
}

/** 景点落在当前区域的哪一个直接下级（用于聚合气泡与跳转） */
export function childAdcodeOf(item: Attraction, regionAdcode: number): number | null {
  const index = item.path.indexOf(regionAdcode);
  if (index >= 0) return item.path[index + 1] ?? null;
  // 全国层级：取景点所属省份
  return item.path[0] ?? null;
}
