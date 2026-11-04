import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Attraction,
  AttractionCategory,
  AttractionSummary,
  LevelFilter as LevelFilterValue,
  RegionInfo,
  RegionNode,
} from './types';
import {
  ROOT_ADCODE,
  getChildRegions,
  getRegion,
  getRegionPath,
  loadRegionIndex,
  resolveAdcodePath,
} from './lib/regions';
import { childAdcodeOf, loadAttractionSummary } from './lib/attractions';
import { loadRegionInfo } from './lib/regionInfo';
import { countByCategory, countByLevel, filterByCategory, filterByLevel, searchAttractions } from './lib/filter';
import { useRegionAttractions } from './hooks/useAttractions';
import { useHashRoute } from './hooks/useHashRoute';
import MapView, { type FocusRequest } from './components/MapView';
import Breadcrumb from './components/Breadcrumb';
import SearchBox from './components/SearchBox';
import CategoryFilter from './components/CategoryFilter';
import LevelFilter from './components/LevelFilter';
import AttractionPanel from './components/AttractionPanel';
import RegionGrid from './components/RegionGrid';
import RegionBrief from './components/RegionBrief';
import RegionDrawer from './components/RegionDrawer';
import DetailDrawer from './components/DetailDrawer';

type MobileView = 'map' | 'list';
type BootState = 'loading' | 'ready' | 'error';

/**
 * 定位景点时应该把行政区切到哪一级：优先区县，其次市，最后省。
 * 只挑真正有边界数据的节点——切到索引里没有的区县，地图会一片空白。
 */
function locateTargetAdcode(attraction: Attraction): number | null {
  const chain = attraction.path?.length
    ? attraction.path
    : [attraction.districtAdcode].filter((code) => Number.isFinite(code));
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const adcode = chain[i];
    if (adcode && getRegion(adcode)) return adcode;
  }
  return null;
}

export default function App() {
  const { route, navigate } = useHashRoute();
  const [boot, setBoot] = useState<BootState>('loading');
  const [bootError, setBootError] = useState('');
  const [summary, setSummary] = useState<AttractionSummary | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AttractionCategory | null>(null);
  const [level, setLevel] = useState<LevelFilterValue | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>('map');
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [lastVisitedChild, setLastVisitedChild] = useState<number | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  /** 当前行政区的介绍 / 攻略（没抓到的地区为 null，概览卡自动不显示） */
  const [regionInfo, setRegionInfo] = useState<RegionInfo | null>(null);
  const [regionInfoLoading, setRegionInfoLoading] = useState(false);
  const [regionInfoOpen, setRegionInfoOpen] = useState(false);
  /** 列表列：手机端整列是滚动容器，换地区要回到顶部，否则会停在上一个小区的半截 */
  const listColumnRef = useRef<HTMLElement | null>(null);
  /** 滚深了才出「回到顶部」：一个省上千条，往回扒几十屏不现实 */
  const [showToTop, setShowToTop] = useState(false);
  /** 列表/抽屉里点了「在地图上定位」，但需要先切行政区：等新区域景点就绪后再飞 */
  const pendingFocusRef = useRef<{ id: string; adcode: number } | null>(null);

  /* ---------------- 启动：加载行政区划索引 ---------------- */
  useEffect(() => {
    let cancelled = false;
    loadRegionIndex()
      .then(() => {
        if (!cancelled) setBoot('ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setBootError(err.message);
        setBoot('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- 景点数量索引（省份导航与气泡） ---------------- */
  useEffect(() => {
    loadAttractionSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  const regionPath = useMemo<RegionNode[]>(() => {
    if (boot !== 'ready') return [];
    const adcodes = resolveAdcodePath(route.segments);
    return getRegionPath(adcodes[adcodes.length - 1]);
  }, [route.segments, boot]);

  const region = regionPath[regionPath.length - 1];
  const adcodes = useMemo(() => regionPath.map((item) => item.adcode), [regionPath]);

  const attractionState = useRegionAttractions(region);
  const regionAttractions = attractionState.items;

  const searched = useMemo(() => searchAttractions(regionAttractions, query), [regionAttractions, query]);
  const visibleAttractions = useMemo(
    () => filterByLevel(filterByCategory(searched, category), level),
    [searched, category, level],
  );
  const counts = useMemo(() => countByCategory(regionAttractions), [regionAttractions]);
  const levelCounts = useMemo(() => countByLevel(regionAttractions), [regionAttractions]);

  const selectedAttraction = useMemo(
    () => regionAttractions.find((item) => item.id === route.poiId) ?? null,
    [regionAttractions, route.poiId],
  );

  const highlightAdcode = useMemo(() => {
    if (!lastVisitedChild) return null;
    const child = getRegion(lastVisitedChild);
    return child && region && child.parentAdcode === region.adcode ? child.adcode : null;
  }, [lastVisitedChild, region]);

  const parentRegion = region && region.parentAdcode ? getRegion(region.parentAdcode) : null;

  /** 地区攻略推荐的景点：地图上要额外描一圈，提示「这些是攻略点名的地方」 */
  const recommendedIds = useMemo(
    () => regionInfo?.recommended.map((item) => item.id) ?? [],
    [regionInfo],
  );

  /** 当前区域各直接下级的景点数量，显示在地图区域标签上 */
  const countsByRegion = useMemo(() => {
    const map: Record<number, number> = {};
    if (!region) return map;
    if (region.adcode === ROOT_ADCODE) {
      for (const [key, value] of Object.entries(summary?.provinces ?? {})) {
        map[Number(key)] = value;
      }
      return map;
    }
    for (const item of regionAttractions) {
      const child = childAdcodeOf(item, region.adcode);
      if (child != null) map[child] = (map[child] ?? 0) + 1;
    }
    return map;
  }, [region, regionAttractions, summary]);

  const provinceItems = useMemo(() => {
    if (!region || region.adcode !== ROOT_ADCODE) return [];
    return getChildRegions(ROOT_ADCODE).map((item) => ({
      adcode: item.adcode,
      name: item.name,
      count: summary?.provinces?.[String(item.adcode)] ?? 0,
    }));
  }, [region, summary]);

  // 切换区域时重置搜索与筛选，避免"看起来没有景点"的困惑
  const regionAdcode = region?.adcode ?? 0;

  /** 列表回到顶部：手机端滚的是整列，桌面端滚的是 .panel-list */
  const resetListScroll = useCallback(() => {
    const column = listColumnRef.current;
    if (!column) return;
    column.scrollTop = 0;
    const inner = column.querySelector<HTMLElement>('.panel-list');
    if (inner) inner.scrollTop = 0;
    setShowToTop(false);
  }, []);

  useEffect(() => {
    setQuery('');
    setCategory(null);
    setLevel(null);
    setFocusedId(null);
    // 旧地区的概览抽屉对新区域没意义
    setRegionInfoOpen(false);
    // 旧的定位请求对新层级没有意义，清空以免地图被再次放大
    setFocusRequest(null);
    // 用户自己又跳到别的区域了，之前的定位意图作废（本区域就是目标时保留）
    if (pendingFocusRef.current && pendingFocusRef.current.adcode !== regionAdcode) {
      pendingFocusRef.current = null;
    }
    resetListScroll();
  }, [regionAdcode, resetListScroll]);

  // 换关键词 / 换筛选后列表整体换了一批，停在原来的位置会直接跳过后半段结果
  useEffect(() => {
    resetListScroll();
  }, [query, category, level, resetListScroll]);

  /* ---------------- 「回到顶部」：滚过一屏才需要 ---------------- */
  useEffect(() => {
    const column = listColumnRef.current;
    if (!column) return;
    let ticking = false;
    const measure = () => {
      ticking = false;
      const inner = column.querySelector<HTMLElement>('.panel-list');
      const top = Math.max(column.scrollTop, inner?.scrollTop ?? 0);
      // 带迟滞，避免在阈值附近抖动时反复重渲染
      setShowToTop((prev) => (prev ? top > 400 : top > 900));
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(measure);
    };
    // scroll 不冒泡，用捕获阶段把里层 .panel-list 的滚动一并接住
    column.addEventListener('scroll', onScroll, true);
    return () => column.removeEventListener('scroll', onScroll, true);
  }, [regionAdcode, attractionState.status, regionInfoLoading]);

  const handleListToTop = useCallback(() => {
    const column = listColumnRef.current;
    if (!column) return;
    column.scrollTo({ top: 0, behavior: 'smooth' });
    column.querySelector<HTMLElement>('.panel-list')?.scrollTo({ top: 0, behavior: 'smooth' });
    setShowToTop(false);
  }, []);

  /* ---------------- 地区介绍 / 攻略（按需加载，全国层级不加载） ---------------- */
  useEffect(() => {
    if (!regionAdcode || region?.level === 'country') {
      setRegionInfo(null);
      return;
    }
    let cancelled = false;
    setRegionInfoLoading(true);
    loadRegionInfo(regionAdcode).then((info) => {
      if (cancelled) return;
      setRegionInfo(info);
      setRegionInfoLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [regionAdcode]);

  // 跨层级定位：新区域的景点加载完再发定位请求，否则飞到的是旧图层
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || pending.adcode !== regionAdcode) return;
    if (attractionState.status !== 'ready') return;
    pendingFocusRef.current = null;
    const hit = regionAttractions.find((item) => item.id === pending.id);
    if (!hit) return;
    setFocusedId(hit.id);
    setFocusRequest({
      id: hit.id,
      lat: hit.latitude,
      lng: hit.longitude,
      nonce: Date.now(),
    });
  }, [regionAdcode, attractionState.status, regionAttractions]);

  const showToast = useCallback((text: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ key: Date.now(), text });
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const goToAdcode = useCallback(
    (targetAdcode: number) => {
      const path = getRegionPath(targetAdcode);
      if (!path.length) {
        showToast('该区域暂无边界数据');
        return;
      }
      navigate(path.map((item) => item.adcode));
      setLastVisitedChild(null);
    },
    [navigate, showToast],
  );

  const handleRegionClick = useCallback(
    (targetAdcode: number) => {
      if (!region) return;
      const target = getRegion(targetAdcode);
      if (!target) {
        showToast('该区域暂无数据');
        return;
      }
      setLastVisitedChild(null);
      if (target.parentAdcode === region.adcode) {
        navigate([...adcodes, target.adcode]);
      } else {
        goToAdcode(target.adcode);
      }
      setMobileView('list');
    },
    [adcodes, goToAdcode, navigate, region, showToast],
  );

  const handleBreadcrumb = useCallback(
    (targetAdcode: number) => {
      const index = adcodes.indexOf(targetAdcode);
      if (index < 0 || index === adcodes.length - 1) return;
      const leaving = region?.adcode ?? 0;
      navigate(adcodes.slice(0, index + 1));
      const leavingNode = getRegion(leaving);
      setLastVisitedChild(leavingNode?.parentAdcode === targetAdcode ? leaving : null);
    },
    [adcodes, navigate, region],
  );

  const handleBack = useCallback(() => {
    if (!parentRegion || !region) return;
    navigate(adcodes.slice(0, -1));
    setLastVisitedChild(region.adcode);
  }, [adcodes, navigate, parentRegion, region]);

  const handleOpenAttraction = useCallback(
    (id: string) => {
      setRegionInfoOpen(false);
      navigate(adcodes, id);
      setFocusedId(id);
    },
    [adcodes, navigate],
  );

  const handleCloseDetail = useCallback(() => {
    navigate(adcodes, null);
  }, [adcodes, navigate]);

  const focusAttraction = useCallback(
    (attraction: Attraction, options?: { keepPoi?: boolean }) => {
      // 只飞坐标不够：当前区域可能比景点所在区县高一级甚至两级，那样地图上
      // 只有上级边界、没有标记，左上角也还停在原层级。先把行政区切到位再定位。
      const target = locateTargetAdcode(attraction);
      if (target && target !== region?.adcode) {
        const path = getRegionPath(target);
        if (path.length) {
          pendingFocusRef.current = { id: attraction.id, adcode: target };
          navigate(path.map((item) => item.adcode), options?.keepPoi ? attraction.id : null);
          setLastVisitedChild(null);
          return true;
        }
      }
      setFocusedId(attraction.id);
      setFocusRequest({
        id: attraction.id,
        lat: attraction.latitude,
        lng: attraction.longitude,
        nonce: Date.now(),
      });
      return false;
    },
    [navigate, region],
  );

  /** 手机端定位后要切回地图视图；跳层级时不能再拿旧 adcodes 覆盖 URL */
  const finishLocate = useCallback(
    (jumped: boolean) => {
      if (!window.matchMedia('(max-width: 900px)').matches) return;
      setMobileView('map');
      if (!jumped) navigate(adcodes, null);
    },
    [adcodes, navigate],
  );

  const handleLocateFromList = useCallback(
    (attraction: Attraction) => {
      finishLocate(focusAttraction(attraction));
    },
    [finishLocate, focusAttraction],
  );

  const handleLocateFromDrawer = useCallback(
    (attraction: Attraction) => {
      const narrow = window.matchMedia('(max-width: 900px)').matches;
      // 桌面端定位时保持详情不关，手机端定位就是要看地图，详情让位
      finishLocate(focusAttraction(attraction, { keepPoi: !narrow }));
    },
    [finishLocate, focusAttraction],
  );

  /** 打开「地区介绍与攻略」抽屉：和景点详情互斥，同时收起 poi 参数 */
  const handleOpenRegionInfo = useCallback(() => {
    if (route.poiId) navigate(adcodes, null);
    setRegionInfoOpen(true);
  }, [adcodes, navigate, route.poiId]);

  /** 从攻略推荐里点景点：可能跨层级（省里的推荐景点在市里），交给 focusAttraction 处理 */
  const handleLocateRecommended = useCallback(
    (id: string) => {
      const hit = regionAttractions.find((item) => item.id === id);
      if (!hit) {
        showToast('该景点暂未载入，请稍后再试');
        return;
      }
      setRegionInfoOpen(false);
      finishLocate(focusAttraction(hit));
    },
    [finishLocate, focusAttraction, regionAttractions, showToast],
  );

  const resetFilters = useCallback(() => {
    setQuery('');
    setCategory(null);
    setLevel(null);
  }, []);

  /* ---------------- 启动态 ---------------- */
  if (boot === 'loading') {
    return (
      <div className="boot">
        <div className="spinner" />
        <p>正在加载全国行政区划…</p>
      </div>
    );
  }

  if (boot === 'error' || !region) {
    return (
      <div className="boot boot--error">
        <p className="boot__title">初始化失败</p>
        <p className="boot__desc">{bootError || '行政区划索引为空'}</p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }

  const activeId = selectedAttraction?.id ?? focusedId;
  const hasFilter = query.trim().length > 0 || category !== null || level !== null;
  const isCountry = region.adcode === ROOT_ADCODE;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__row">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path
                  d="M12 3c4.4 0 8 3.3 8 7.5 0 5.2-8 12.5-8 12.5S4 15.7 4 10.5C4 6.3 7.6 3 12 3Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <circle cx="12" cy="10.2" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </span>
            <div className="brand__text">
              <h1>China Scenic Map</h1>
              <p>中国景点地图 · 逐级探索</p>
            </div>
          </div>

          <div className="topbar__nav">
            <Breadcrumb path={regionPath} onNavigate={handleBreadcrumb} />
            <button
              type="button"
              className="btn btn--ghost btn--sm back-btn"
              onClick={handleBack}
              disabled={!parentRegion}
              title={parentRegion ? `返回${parentRegion.name}` : '已在最上级'}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
              返回上级
            </button>
          </div>

          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={isCountry ? '选择省份后可搜索景点' : `在${region.name}搜索景点`}
            resultCount={isCountry ? null : regionAttractions.length}
            disabled={isCountry}
          />
        </div>
      </header>

      <main className="workspace" data-mobile-view={mobileView}>
        <div className="mobile-tabs" role="tablist" aria-label="视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === 'map'}
            className={`mobile-tabs__btn${mobileView === 'map' ? ' is-active' : ''}`}
            onClick={() => setMobileView('map')}
          >
            地图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === 'list'}
            className={`mobile-tabs__btn${mobileView === 'list' ? ' is-active' : ''}`}
            onClick={() => setMobileView('list')}
          >
            景点列表
            <span className="mobile-tabs__count">{visibleAttractions.length}</span>
          </button>
        </div>

        <section className="map-column" aria-label="地图视图">
          <MapView
            region={region}
            attractions={visibleAttractions}
            selectedId={activeId}
            highlightAdcode={highlightAdcode}
            focusRequest={focusRequest}
            panelOffset={selectedAttraction ? 440 : 0}
            countsByRegion={countsByRegion}
            recommendedIds={recommendedIds}
            onRegionClick={handleRegionClick}
            onAttractionClick={handleOpenAttraction}
            onOpenRegion={goToAdcode}
          />
        </section>

        <section className="list-column" aria-label="景点列表" ref={listColumnRef}>
          <div className="panel">
            <div className="panel__head">
              <div>
                <h2 className="panel__title">
                  {region.name}
                  <span className="panel__title-sub">{isCountry ? '省份' : '景点'}</span>
                </h2>
                <p className="panel__desc">
                  {isCountry
                    ? `${region.childAdcodes.length} 个省级行政区 · 全国已收录 ${summary?.total ?? 0} 个景点`
                    : attractionState.status === 'loading'
                      ? '正在加载景点…'
                      : `共 ${regionAttractions.length} 个景点${
                          hasFilter ? ` · 筛选后 ${visibleAttractions.length} 个` : ''
                        }`}
                </p>
              </div>
            </div>

            {!isCountry && (
              <RegionBrief
                info={regionInfo}
                loading={regionInfoLoading}
                onOpen={handleOpenRegionInfo}
                onLocate={handleLocateRecommended}
              />
            )}

            {isCountry ? (
              <RegionGrid items={provinceItems} onSelect={goToAdcode} />
            ) : (
              <>
                <div className="filters">
                  <CategoryFilter
                    value={category}
                    counts={counts}
                    total={regionAttractions.length}
                    onChange={setCategory}
                  />
                  <LevelFilter
                    value={level}
                    counts={levelCounts}
                    total={regionAttractions.length}
                    onChange={setLevel}
                  />
                </div>

                <AttractionPanel
                  regionName={region.name}
                  totalInRegion={regionAttractions.length}
                  items={visibleAttractions}
                  activeId={activeId}
                  hasFilter={hasFilter}
                  loading={attractionState.status === 'loading'}
                  error={attractionState.error}
                  onOpen={handleOpenAttraction}
                  onLocate={handleLocateFromList}
                  onResetFilter={resetFilters}
                />
              </>
            )}

            <footer className="panel__foot">
              <p>
                行政区划边界来自阿里云 DataV.GeoAtlas 公开 GeoJSON（真实边界，仅做几何简化）；景点坐标为参考坐标，
                仅用于示意定位。
              </p>
              {summary && (
                <p className="panel__foot-meta">
                  全国 {summary.total} 个景点 · 区划 {region.childAdcodes.length} 个下级 · 数据生成于{' '}
                  {summary.generatedAt.slice(0, 10)}
                </p>
              )}
            </footer>
          </div>
        </section>
      </main>

      {showToTop && !selectedAttraction && !regionInfoOpen && (
        <button type="button" className="to-top" onClick={handleListToTop} aria-label="回到列表顶部">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M8 12V4m0 0L4 8m4-4l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          顶部
        </button>
      )}

      <RegionDrawer
        info={regionInfoOpen ? regionInfo : null}
        onClose={() => setRegionInfoOpen(false)}
        onLocate={handleLocateRecommended}
      />

      <DetailDrawer
        attraction={selectedAttraction}
        onClose={handleCloseDetail}
        onLocate={handleLocateFromDrawer}
      />

      {toast && (
        <div className="toast" role="status" key={toast.key}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
