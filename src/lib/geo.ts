import type { GeoCollection } from '../types';

/**
 * GeoJSON 加载器
 * - 按 URL 缓存 Promise，避免重复请求
 * - 加载失败抛出可读的错误信息，由地图组件展示重试入口
 */
const cache = new Map<string, Promise<GeoCollection>>();

export function loadGeo(url: string): Promise<GeoCollection> {
  const cached = cache.get(url);
  if (cached) return cached;

  const task = fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`行政区划数据请求失败（HTTP ${res.status}）`);
      const json = (await res.json()) as GeoCollection;
      if (!json || !Array.isArray(json.features) || json.features.length === 0) {
        throw new Error('行政区划数据格式异常');
      }
      return json;
    })
    .catch((err: unknown) => {
      // 失败不缓存，允许重试
      cache.delete(url);
      throw err instanceof Error ? err : new Error('行政区划数据加载失败');
    });

  cache.set(url, task);
  return task;
}
