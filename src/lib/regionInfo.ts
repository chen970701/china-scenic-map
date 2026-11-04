import type { RegionInfo } from '../types';

/**
 * 地区介绍 / 攻略加载器
 *
 * 每个行政区一个文件（/data/regions/{adcode}.json），进入哪个层级就只取那一份；
 * 没抓到的地区返回 null，界面自动不显示概览卡，不影响景点列表。
 */

const BASE = `${import.meta.env.BASE_URL}data/regions`;
const cache = new Map<number, Promise<RegionInfo | null>>();

export function loadRegionInfo(adcode: number): Promise<RegionInfo | null> {
  const cached = cache.get(adcode);
  if (cached) return cached;

  const task = fetch(`${BASE}/${adcode}.json`)
    .then(async (res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`地区资料请求失败（HTTP ${res.status}）`);
      return (await res.json()) as RegionInfo;
    })
    .catch((err: unknown) => {
      // 单条失败不该拖垮页面：清缓存后按「没有资料」处理
      cache.delete(adcode);
      if (import.meta.env.DEV) console.warn('[region-info]', adcode, err);
      return null;
    });

  cache.set(adcode, task);
  return task;
}
