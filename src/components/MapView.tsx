import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Attraction, GeoFeatureProperties, RegionNode } from '../types';
import { CATEGORY_META } from '../data/categories';
import { MAX_ZOOM_BY_LEVEL } from '../lib/regions';
import { loadGeo } from '../lib/geo';

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '底图 &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> 贡献者 · 边界: DataV.GeoAtlas';

/** 多边形配色（浅色主题） */
const COLOR = {
  fill: '#e9e2d1',
  fillClickable: '#c3dcc9',
  fillHover: '#a4cbb4',
  stroke: '#fbf9f3',
  strokeClickable: '#5f8f79',
  activeStroke: '#1f5f4e',
  highlightStroke: '#c4723f',
};

/** 常驻标签的最小面积（平方度），避免小面积行政区标签互相压叠 */
const LABEL_MIN_SPAN: Record<string, number> = {
  country: 3.4,
  province: 0.02,
  city: 0.006,
  district: 0.0035,
};

/**
 * 缩放越大，行政区填充越淡。
 * 全国/省级视图靠色块区分政区，需要较实的填充；放大到街道级别后色块只会糊住底图，
 * 所以从 z8.5 到 z11 线性降到接近透明，只留描边勾出边界。
 */
function fillRamp(zoom: number): number {
  return Math.min(1, Math.max(0, (zoom - 8.5) / 2.5));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export interface FocusRequest {
  id: string;
  lat: number;
  lng: number;
  nonce: number;
}

interface MapViewProps {
  region: RegionNode;
  attractions: Attraction[];
  selectedId: string | null;
  highlightAdcode: number | null;
  focusRequest: FocusRequest | null;
  /** 详情抽屉宽度，用于定位时避让 */
  panelOffset: number;
  /** 直接下级的景点数量，用于区域标签上的数量角标 */
  countsByRegion: Record<number, number>;
  /** 地区攻略里点名过的景点：省市层没有等级的点位也画出来，并加一圈橙色描边 */
  recommendedIds: string[];
  onRegionClick: (adcode: number) => void;
  onAttractionClick: (id: string) => void;
  onOpenRegion: (adcode: number) => void;
}

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

/** 区域标签：名称 + 景点数量角标（数量为 0 时不显示角标） */
function labelHtml(name: string, count?: number): string {
  const badge = count && count > 0 ? `<span class="area-label__count">${count}</span>` : '';
  return `${escapeHtml(name)}${badge}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default function MapView({
  region,
  attractions,
  selectedId,
  highlightAdcode,
  focusRequest,
  panelOffset,
  countsByRegion,
  recommendedIds,
  onRegionClick,
  onAttractionClick,
  onOpenRegion,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const geoLayerRef = useRef<L.GeoJSON | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [basemapOk, setBasemapOk] = useState(true);
  const recKey = recommendedIds.join(',');
  const [retryKey, setRetryKey] = useState(0);
  const panelOffsetRef = useRef(panelOffset);
  panelOffsetRef.current = panelOffset;
  const maxZoomRef = useRef(MAX_ZOOM_BY_LEVEL[region.level]);
  maxZoomRef.current = MAX_ZOOM_BY_LEVEL[region.level];
  // 数量变化不该重建整个图层，用 ref 提供给标签更新副作用
  const countsRef = useRef(countsByRegion);
  countsRef.current = countsByRegion;

  // 用 ref 持有最新回调，避免图层因回调变化被反复重建
  const handlersRef = useRef({ onRegionClick, onAttractionClick, onOpenRegion });
  handlersRef.current = { onRegionClick, onAttractionClick, onOpenRegion };

  const { adcode, name, hasChildren, level } = region;
  // 有下级时渲染下级边界；叶子节点渲染父级文件（含同级兄弟作为背景）并高亮自身
  const geoFile = hasChildren ? region.childGeoFile : region.selfGeoFile;
  const maxZoom = MAX_ZOOM_BY_LEVEL[level];

  const childKey = region.childAdcodes.join(',');
  const childSet = useMemo(() => new Set(region.childAdcodes), [childKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 初始化地图 ---------------- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 15,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
      preferCanvas: true,
    }).setView([35, 104], 4);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    let tileErrors = 0;
    const tiles = L.tileLayer(OSM_TILES, {
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION,
      crossOrigin: true,
    });
    tiles.on('tileerror', () => {
      tileErrors += 1;
      // 底图服务不可用时静默降级为"仅边界"模式，保证站点仍可交互
      if (tileErrors >= 4) {
        setBasemapOk(false);
        tiles.remove();
      }
    });
    tiles.addTo(map);

    mapRef.current = map;
    markerLayerRef.current = L.layerGroup().addTo(map);

    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      geoLayerRef.current = null;
      markerLayerRef.current = null;
    };
    // 只在挂载时创建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 层级变化：加载并渲染边界 ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !geoFile) return;
    let cancelled = false;
    let zoomHandler: (() => void) | null = null;
    setLoadState({ status: 'loading' });
    // 先停止可能在进行的飞行动画，避免其回调覆盖下面的 fitBounds
    map.stop();

    loadGeo(geoFile)
      .then((geo) => {
        if (cancelled || !mapRef.current) return;
        const currentMap = mapRef.current;

        if (geoLayerRef.current) {
          currentMap.removeLayer(geoLayerRef.current);
          geoLayerRef.current = null;
        }

        const labelMinSpan = LABEL_MIN_SPAN[level] ?? 0.003;

        const baseStyle = (feature?: GeoJSON.Feature): L.PathOptions => {
          const props = (feature?.properties ?? {}) as GeoFeatureProperties;
          const clickable = hasChildren ? childSet.has(props.adcode) : props.adcode !== adcode;
          const isActive = props.adcode === adcode;
          const isHighlighted = highlightAdcode !== null && props.adcode === highlightAdcode;
          const strokeColor = isActive
            ? COLOR.activeStroke
            : isHighlighted
              ? COLOR.highlightStroke
              : clickable
                ? COLOR.strokeClickable
                : COLOR.stroke;
          // 叶子层级（区县/无下级的市）：选中区域做实色提示，兄弟区域淡化做背景
          const fillColor = isActive
            ? '#cfe4d7'
            : clickable
              ? hasChildren
                ? COLOR.fillClickable
                : '#ffffff'
              : COLOR.fill;
          // 放大后填充逐渐让位给底图，否则街道、路名全被色块压住
          const t = fillRamp(currentMap.getZoom());
          const fillOpacity = isActive
            ? lerp(0.62, 0.1, t)
            : clickable
              ? hasChildren
                ? lerp(0.9, 0.16, t)
                : lerp(0.3, 0.05, t)
              : lerp(0.94, 0.6, t);
          return {
            color: strokeColor,
            // 放大后描边也收细一点，避免边界线盖住路网
            weight: isActive || isHighlighted ? lerp(2.8, 2.2, t) : lerp(clickable ? 1.6 : 1, 1.1, t),
            fillColor,
            fillOpacity,
            dashArray: isHighlighted && !isActive ? '6 4' : undefined,
            lineJoin: 'round',
          };
        };

        const layer = L.geoJSON(geo as unknown as GeoJSON.FeatureCollection, {
          style: (feature) => baseStyle(feature as GeoJSON.Feature | undefined),
          onEachFeature: (feature, featureLayer) => {
            const props = (feature.properties ?? {}) as GeoFeatureProperties;
            const clickable = hasChildren ? childSet.has(props.adcode) : props.adcode !== adcode;
            const path = featureLayer as L.Path;

            const bounds = (featureLayer as L.Polygon).getBounds?.();
            const span = bounds
              ? (bounds.getNorth() - bounds.getSouth()) * (bounds.getEast() - bounds.getWest())
              : 0;
            const permanentLabel = clickable && span > labelMinSpan;

            path.bindTooltip(labelHtml(props.name ?? '', countsRef.current[props.adcode]), {
              permanent: permanentLabel,
              direction: 'center',
              className: `area-label${permanentLabel ? '' : ' area-label--hover'}${
                clickable ? ' area-label--target' : ''
              }`,
              opacity: 1,
            });

            if (!clickable) return;

            path.on('mouseover', () => {
              // 放大后悬停也不该整片刷色，只轻微提示
              const t = fillRamp(currentMap.getZoom());
              path.setStyle({ fillColor: COLOR.fillHover, fillOpacity: lerp(0.95, 0.22, t), weight: 2 });
              path.bringToFront();
            });
            path.on('mouseout', () => {
              path.setStyle(baseStyle(feature as GeoJSON.Feature));
            });
            path.on('click', () => {
              handlersRef.current.onRegionClick(props.adcode);
            });
          },
        }).addTo(map);

        geoLayerRef.current = layer;

        /**
         * 缩放联动：
         * - 底图随缩放连续"恢复"（通过 CSS 变量控制透明度与滤镜，见 .leaflet-tile-pane）；
         * - 行政区填充重算，放大后让街道透出来。
         * 用连续变量而不是分档 class，滚轮缩放时不会出现底图突然跳亮的情况。
         */
        const syncZoomVisual = () => {
          const zoom = currentMap.getZoom();
          const t = fillRamp(zoom);
          const style = currentMap.getContainer().style;
          style.setProperty('--basemap-opacity', lerp(0.4, 0.97, t).toFixed(3));
          style.setProperty('--basemap-gray', lerp(1, 0.2, t).toFixed(3));
          style.setProperty('--basemap-contrast', lerp(0.62, 1, t).toFixed(3));
          style.setProperty('--basemap-brightness', lerp(1.2, 1.04, t).toFixed(3));
          style.setProperty('--basemap-saturate', lerp(1, 0.65, t).toFixed(3));
          layer.setStyle((f) => baseStyle(f as GeoJSON.Feature | undefined));
        };
        zoomHandler = syncZoomVisual;
        currentMap.on('zoomend', syncZoomVisual);

        if (import.meta.env.DEV) {
          // 仅开发环境暴露，方便调试与自动化测试
          (window as unknown as Record<string, unknown>).__scenicMap = currentMap;
          (window as unknown as Record<string, unknown>).__scenicGeoLayer = layer;
        }

        // 有下级：按全部下级范围取景；叶子节点：只对准自身边界
        let targetBounds: L.LatLngBounds | null = null;
        if (hasChildren) {
          const all = layer.getBounds();
          if (all.isValid()) targetBounds = all;
        } else {
          layer.eachLayer((child) => {
            const f = (child as L.GeoJSON & { feature?: GeoJSON.Feature }).feature;
            if (f?.properties?.adcode === adcode && child instanceof L.Polygon) {
              targetBounds = child.getBounds();
            }
          });
          if (!targetBounds) {
            const all = layer.getBounds();
            if (all.isValid()) targetBounds = all;
          }
        }

        if (targetBounds && (targetBounds as L.LatLngBounds).isValid()) {
          currentMap.fitBounds(targetBounds as L.LatLngBounds, { padding: [28, 28], animate: false });
        }
        // 放在 fitBounds 之后：避免出现"缩放到 maxZoom"的过渡动画把视图拉回旧位置
        currentMap.setMaxZoom(maxZoom);
        syncZoomVisual();
        setLoadState({ status: 'ready' });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadState({ status: 'error', message: err.message });
      });

    return () => {
      cancelled = true;
      if (zoomHandler) map.off('zoomend', zoomHandler);
    };
  }, [geoFile, adcode, hasChildren, childSet, level, maxZoom, highlightAdcode, retryKey]);

  /* ---------------- 景点标记 ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    const markerLayer = markerLayerRef.current;
    if (!map || !markerLayer) return;
    markerLayer.clearLayers();

    if (!hasChildren) {
      // 区县 / 无下级的市：显示具体景点标记，序号与右侧列表一一对应
      attractions.forEach((item, index) => {
        const isActive = item.id === selectedId;
        const color = CATEGORY_META[item.category].color;
        const icon = L.divIcon({
          className: 'marker-holder',
          html: `<div class="poi-marker${isActive ? ' is-active' : ''}" style="--pin-color:${color}">
              <span class="poi-marker__pulse"></span>
              <span class="poi-marker__dot"><span class="poi-marker__num">${index + 1}</span></span>
              <span class="poi-marker__label">${escapeHtml(item.name)}</span>
            </div>`,
          iconSize: [0, 0],
        });
        const marker = L.marker([item.latitude, item.longitude], {
          icon,
          keyboard: false,
          title: `${index + 1}. ${item.name}`,
          zIndexOffset: isActive ? 600 : 0,
        });
        marker.on('click', () => handlersRef.current.onAttractionClick(item.id));
        marker.addTo(markerLayer);
      });
      return;
    }

    // 全国 / 省 / 市：不画独立气泡，景点数量已并入行政区名称标签，
    // 下钻靠点击区域多边形本身完成，避免气泡与地名互相压叠。
    // 但 A 级景区是"有等级评定"的确定点位，用不带文字的小圆点标出来，
    // 否则在省/市层只看得到行政区，感觉不到景点分布。
    // 有等级的点位照旧画；攻略里点过名但没等级的（灵隐寺、河坊街这类）也补上，
    // 否则「推荐了却在地图上找不到」。
    const recSet = new Set(recommendedIds);
    const graded = attractions.filter((item) => item.level || recSet.has(item.id));
    const capped = graded.length > 220 ? graded.slice(0, 220) : graded;
    capped.forEach((item) => {
      const isActive = item.id === selectedId;
      const isRec = recSet.has(item.id);
      const dot = L.divIcon({
        className: 'marker-holder',
        html: `<div class="poi-dot poi-dot--${(item.level ?? '').toLowerCase()}${isActive ? ' is-active' : ''}${isRec ? ' is-rec' : ''}"></div>`,
        iconSize: [0, 0],
      });
      L.marker([item.latitude, item.longitude], {
        icon: dot,
        keyboard: false,
        title: isRec ? `${item.name}（攻略推荐）` : `${item.name}（${item.level}）`,
        zIndexOffset: isActive ? 600 : 0,
      })
        .on('click', () => handlersRef.current.onAttractionClick(item.id))
        .addTo(markerLayer);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attractions, selectedId, adcode, hasChildren, region.childAdcodes, recKey]);

  /* ---------------- 数量变化：只更新标签文字，不重建图层 ---------------- */
  useEffect(() => {
    const layer = geoLayerRef.current;
    if (!layer) return;
    layer.eachLayer((child) => {
      const feature = (child as L.GeoJSON & { feature?: GeoJSON.Feature }).feature;
      const path = child as L.Path;
      if (!feature?.properties || !path.getTooltip?.()) return;
      path.setTooltipContent(
        labelHtml(feature.properties.name ?? '', countsByRegion[feature.properties.adcode]),
      );
    });
  }, [countsByRegion]);

  /* ---------------- 列表 → 地图定位 ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusRequest) return;
    // 边界还在加载时不要飞：加载完成后的 fitBounds 会把视图拉回区域范围，
    // 表现就是"点了定位，画面却停在省级"
    if (loadState.status !== 'ready') return;
    // 只在发起定位时执行一次；maxZoom 通过 ref 读取，避免切换层级时重复飞行
    const targetZoom = Math.min(Math.max(map.getZoom(), 13.5), maxZoomRef.current);
    // 桌面端详情抽屉会遮住地图右侧，把目标点向左偏移，保证标记可见
    const offsetX =
      panelOffsetRef.current > 0 && window.innerWidth > 900 ? panelOffsetRef.current / 2 : 0;
    const projected = map.project([focusRequest.lat, focusRequest.lng], targetZoom);
    const center = map.unproject(projected.add([offsetX, 0] as L.PointExpression), targetZoom);
    map.flyTo(center, targetZoom, { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, loadState.status]);

  const handleRetry = useCallback(() => setRetryKey((key) => key + 1), []);

  const showLegend = !hasChildren || level === 'city';

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" role="application" aria-label={`${name}地图`} />

      <div className="map-hint" aria-hidden="true">
        {hasChildren
          ? '点击高亮区域进入下一级 · 滚轮缩放 / 拖动移动'
          : '点击编号标记查看景点 · 滚轮缩放 / 拖动移动'}
      </div>

      {!basemapOk && (
        <div className="map-badge" role="status">
          底图不可用，已切换为仅边界模式
        </div>
      )}

      {showLegend && (
        <div className="map-legend" aria-label="景点类别图例">
          {Object.entries(CATEGORY_META).map(([name2, meta]) => (
            <span key={name2} className="map-legend__item">
              <i style={{ background: meta.color }} />
              {name2}
            </span>
          ))}
        </div>
      )}

      {loadState.status === 'loading' && (
        <div className="map-overlay" role="status" aria-live="polite">
          <div className="spinner" />
          <p>正在加载{name}行政区划边界…</p>
        </div>
      )}

      {loadState.status === 'error' && (
        <div className="map-overlay map-overlay--error" role="alert">
          <p className="map-overlay__title">地图数据加载失败</p>
          <p className="map-overlay__desc">{loadState.message}</p>
          <button type="button" className="btn btn--primary" onClick={handleRetry}>
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}
