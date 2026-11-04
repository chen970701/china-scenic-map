/**
 * 行政区划索引 + 点面归属判定（构建期共用）
 *
 * 供 build-attractions.mjs / build-a-level.mjs 共用：
 *   - 读 public/geo/index.json 建树
 *   - 用最细一级（区县）边界建网格索引，做 point-in-polygon
 */
import fs from 'node:fs';
import path from 'node:path';

export function createGeoIndex(geoDir) {
  const index = JSON.parse(fs.readFileSync(path.join(geoDir, 'index.json'), 'utf8'));
  const nodes = new Map();
  for (const [adcode, name, parent, levelCode] of index.nodes) {
    nodes.set(adcode, { adcode, name, parent, levelCode });
  }

  const childrenOf = new Map();
  for (const node of nodes.values()) {
    if (!node.parent) continue;
    const list = childrenOf.get(node.parent) ?? [];
    list.push(node.adcode);
    childrenOf.set(node.parent, list);
  }
  const isLeaf = (adcode) => !(childrenOf.get(adcode)?.length > 0);

  /** 祖先链（全国 → 省 → 市 → 区县） */
  function chainOf(adcode) {
    const chain = [];
    let cursor = nodes.get(adcode);
    let guard = 0;
    while (cursor && guard < 6) {
      chain.unshift(cursor.adcode);
      cursor = cursor.parent ? nodes.get(cursor.parent) : undefined;
      guard += 1;
    }
    return chain;
  }

  /* --------------------------- 边界与空间索引 --------------------------- */

  const polygons = [];
  const geoFiles = fs.readdirSync(path.join(geoDir, 'g')).filter((f) => f.endsWith('.json'));
  for (const file of geoFiles) {
    const collection = JSON.parse(fs.readFileSync(path.join(geoDir, 'g', file), 'utf8'));
    for (const feature of collection.features) {
      const adcode = feature.properties.adcode;
      if (!isLeaf(adcode)) continue; // 只用最细一级做归属判定
      const polys =
        feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const poly of polys) {
        for (const ring of poly) {
          for (const [lng, lat] of ring) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
      }
      polygons.push({ adcode, name: feature.properties.name, bbox: [minLng, minLat, maxLng, maxLat], polys });
    }
  }

  const CELL = 0.5;
  const grid = new Map();
  polygons.forEach((poly, i) => {
    const [minLng, minLat, maxLng, maxLat] = poly.bbox;
    for (let x = Math.floor(minLng / CELL); x <= Math.floor(maxLng / CELL); x++) {
      for (let y = Math.floor(minLat / CELL); y <= Math.floor(maxLat / CELL); y++) {
        const key = `${x},${y}`;
        const list = grid.get(key) ?? [];
        list.push(i);
        grid.set(key, list);
      }
    }
  });

  function inRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** 点落在哪个区县（返回 adcode），落空返回 null */
  function locate(lng, lat) {
    const candidates = grid.get(`${Math.floor(lng / CELL)},${Math.floor(lat / CELL)}`);
    if (!candidates) return null;
    for (const i of candidates) {
      const poly = polygons[i];
      const [minLng, minLat, maxLng, maxLat] = poly.bbox;
      if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
      for (const rings of poly.polys) {
        if (!inRing(lng, lat, rings[0])) continue;
        let inHole = false;
        for (let h = 1; h < rings.length; h++) {
          if (inRing(lng, lat, rings[h])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return poly.adcode;
      }
    }
    return null;
  }

  /* ------------------------------ 区县代表点 ------------------------------ */

  /**
   * 区县代表点（bbox 中心）。
   * 省级名录只给了「某省某市某县」，没有坐标；那些在 OSM 里找不到同名地物的景区，
   * 只能落在区县代表点上，页面上会明确标注「位置为所在区县示意」。
   */
  const centerByAdcode = new Map();
  for (const poly of polygons) {
    const [minLng, minLat, maxLng, maxLat] = poly.bbox;
    if (!centerByAdcode.has(poly.adcode)) {
      centerByAdcode.set(poly.adcode, [Number(((minLng + maxLng) / 2).toFixed(5)), Number(((minLat + maxLat) / 2).toFixed(5))]);
    }
  }
  /**
   * 取代表点。名录里有些只能落到市级（「所在地市」列没有区县），
   * 此时用该市下所有区县代表点的平均值，而不是直接返回空。
   */
  function centerOf(adcode) {
    const direct = centerByAdcode.get(Number(adcode));
    if (direct) return direct;
    const children = childrenOf.get(Number(adcode)) ?? [];
    if (!children.length) return null;
    let sumLng = 0;
    let sumLat = 0;
    let n = 0;
    for (const child of children) {
      const c = centerByAdcode.get(child);
      if (!c) continue;
      sumLng += c[0];
      sumLat += c[1];
      n += 1;
    }
    if (!n) return null;
    return [Number((sumLng / n).toFixed(5)), Number((sumLat / n).toFixed(5))];
  }

  return { nodes, childrenOf, isLeaf, chainOf, locate, centerOf, polygonCount: polygons.length };
}
