import type { RegionIndexFile, RegionLevel, RegionNode } from '../types';

/**
 * 行政区划索引
 *
 * 全国版把 3400+ 个行政区节点放在 /geo/index.json（约 76KB），
 * 地图边界按视图懒加载：进入某区域时只拉取该区域"直接下级"的那一个文件。
 */

export const ROOT_ADCODE = 100000;

const GEO_BASE = '/geo/g';

const LEVEL_BY_CODE: RegionLevel[] = ['country', 'province', 'city', 'district'];

/** 各层级的最大缩放（区县可放得更大） */
export const MAX_ZOOM_BY_LEVEL: Record<RegionLevel, number> = {
  country: 9,
  province: 11,
  city: 12.5,
  district: 15,
};

const nodeMap = new Map<number, RegionNode>();
let loadPromise: Promise<void> | null = null;

export function loadRegionIndex(): Promise<void> {
  if (!loadPromise) {
    loadPromise = fetch('/geo/index.json')
      .then(async (res) => {
        if (!res.ok) throw new Error(`行政区划索引加载失败（HTTP ${res.status}）`);
        const index = (await res.json()) as RegionIndexFile;
        if (!Array.isArray(index.nodes) || index.nodes.length === 0) {
          throw new Error('行政区划索引格式异常');
        }
        build(index);
      })
      .catch((err: unknown) => {
        // 失败不缓存，允许重试
        loadPromise = null;
        throw err instanceof Error ? err : new Error('行政区划索引加载失败');
      });
  }
  return loadPromise;
}

function build(index: RegionIndexFile) {
  nodeMap.clear();
  const childrenOf = new Map<number, number[]>();

  for (const [adcode, name, parent, levelCode] of index.nodes) {
    const level = LEVEL_BY_CODE[levelCode] ?? 'district';
    nodeMap.set(adcode, {
      adcode,
      name,
      level,
      parentAdcode: parent,
      hasChildren: false,
      childAdcodes: [],
      selfGeoFile: adcode === ROOT_ADCODE ? `${GEO_BASE}/${ROOT_ADCODE}.json` : `${GEO_BASE}/${parent}.json`,
      childGeoFile: null,
    });
    if (parent) {
      const list = childrenOf.get(parent) ?? [];
      list.push(adcode);
      childrenOf.set(parent, list);
    }
  }

  for (const [adcode, node] of nodeMap) {
    const list = childrenOf.get(adcode) ?? [];
    node.childAdcodes = list;
    node.hasChildren = list.length > 0;
    node.childGeoFile = list.length > 0 ? `${GEO_BASE}/${adcode}.json` : null;
  }
}

export function isRegionIndexReady(): boolean {
  return nodeMap.size > 0;
}

export function getRegion(adcode: number): RegionNode | undefined {
  return nodeMap.get(adcode);
}

/** 根到指定区域的完整路径（含自身）；节点不存在时返回空数组 */
export function getRegionPath(adcode: number): RegionNode[] {
  const node = nodeMap.get(adcode);
  if (!node) return [];
  const path: RegionNode[] = [node];
  let cursor = node;
  let guard = 0;
  while (cursor.parentAdcode && guard < 8) {
    const parent = nodeMap.get(cursor.parentAdcode);
    if (!parent) break;
    path.unshift(parent);
    cursor = parent;
    guard += 1;
  }
  return path;
}

export function getChildRegions(adcode: number): RegionNode[] {
  const node = nodeMap.get(adcode);
  if (!node) return [];
  return node.childAdcodes
    .map((code) => nodeMap.get(code))
    .filter((item): item is RegionNode => Boolean(item));
}

/**
 * 把 URL 上的 adcode 片段解析为合法路径。
 * 支持省略根节点（#/330000/330100）、也支持显式带上根节点。
 */
export function resolveAdcodePath(segments: string[]): number[] {
  const path = [ROOT_ADCODE];
  const rest = segments[0] === String(ROOT_ADCODE) ? segments.slice(1) : segments;

  for (const segment of rest) {
    const adcode = Number(segment);
    if (!Number.isInteger(adcode)) break;
    const node = nodeMap.get(adcode);
    if (!node) break;
    const tail = path[path.length - 1];
    if (node.parentAdcode === tail) {
      path.push(adcode);
      continue;
    }
    // 省略了中间层级时自动补全祖先链
    const chain = getRegionPath(adcode).map((item) => item.adcode);
    const index = chain.indexOf(tail);
    if (index >= 0 && index < chain.length - 1) {
      path.push(...chain.slice(index + 1));
      continue;
    }
    break;
  }
  return path;
}

/** 某区域及其全部后代的 adcode（用于判断景点归属） */
export function getSubtreeAdcodes(adcode: number): number[] {
  const node = nodeMap.get(adcode);
  if (!node) return [];
  const out: number[] = [];
  const stack = [adcode];
  let guard = 0;
  while (stack.length && guard < 5000) {
    const current = stack.pop() as number;
    out.push(current);
    const child = nodeMap.get(current);
    if (child) stack.push(...child.childAdcodes);
    guard += 1;
  }
  return out;
}

export function getLevelLabel(level: RegionLevel): string {
  return { country: '全国', province: '省级', city: '地级', district: '区县' }[level];
}
