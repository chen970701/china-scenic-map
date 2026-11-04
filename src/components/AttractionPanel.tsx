import { useEffect, useRef, useState } from 'react';
import type { Attraction } from '../types';
import AttractionCard from './AttractionCard';

interface AttractionPanelProps {
  regionName: string;
  totalInRegion: number;
  items: Attraction[];
  activeId: string | null;
  hasFilter: boolean;
  loading?: boolean;
  error?: string;
  onOpen: (id: string) => void;
  onLocate: (attraction: Attraction) => void;
  onResetFilter: () => void;
}

/** 首屏与每次追加的卡片数：一个省一两千个景点，一次性铺开手机会卡死 */
const PAGE_SIZE = 60;

export default function AttractionPanel({
  regionName,
  totalInRegion,
  items,
  activeId,
  hasFilter,
  loading = false,
  error,
  onOpen,
  onLocate,
  onResetFilter,
}: AttractionPanelProps) {
  // 换地区 / 换筛选后 items 是新数组：直接把分页重置，避免沿用上一批的 limit
  const [page, setPage] = useState<{ key: Attraction[]; limit: number }>({ key: items, limit: PAGE_SIZE });
  if (page.key !== items) {
    setPage({ key: items, limit: PAGE_SIZE });
  }
  const limit = page.key === items ? page.limit : PAGE_SIZE;

  const loadMore = () => {
    setPage((prev) => (prev.key === items ? { ...prev, limit: prev.limit + PAGE_SIZE } : prev));
  };

  // 深链 / 地图点选进来的景点可能排在几百位之后，必须保证它被渲染出来
  const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
  const shownCount = Math.min(items.length, Math.max(limit, activeIndex + 1));
  const hasMore = shownCount < items.length;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setPage((prev) => (prev.key === items ? { ...prev, limit: prev.limit + PAGE_SIZE } : prev));
      },
      // 提前一屏预取，滑到底时不会看到空白等待
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, shownCount, items]);

  if (loading && items.length === 0) {
    return (
      <div className="panel-list" aria-live="polite">
        <div className="empty">
          <div className="spinner" />
          <p className="empty__title">正在加载景点数据</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel-list" aria-live="polite">
        <div className="empty">
          <p className="empty__title">景点数据加载失败</p>
          <p className="empty__desc">{error}</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-list" aria-live="polite">
      {items.length > 0 ? (
        <>
          {items.slice(0, shownCount).map((attraction, index) => (
            <AttractionCard
              key={attraction.id}
              attraction={attraction}
              order={index}
              active={attraction.id === activeId}
              onOpen={onOpen}
              onLocate={onLocate}
            />
          ))}
          {hasMore ? (
            <div className="panel-list__more" ref={sentinelRef}>
              <span className="panel-list__progress">
                已显示 {shownCount} / {items.length} 个
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={loadMore}>
                加载更多
              </button>
            </div>
          ) : (
            items.length > PAGE_SIZE && (
              <p className="panel-list__end">已到列表末尾 · 共 {items.length} 个景点</p>
            )
          )}
        </>
      ) : totalInRegion === 0 ? (
        <div className="empty">
          <div className="empty__icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="40" height="40">
              <path
                d="M8 34l10-16 8 11 5-7 9 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx="32" cy="13" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
          <p className="empty__title">{regionName}暂未收录景点</p>
          <p className="empty__desc">
            全国景点数据正在持续补充，热点城市覆盖较全，部分区县仍为空。可返回上级，或在地图上换个区域看看。
          </p>
        </div>
      ) : (
        <div className="empty">
          <div className="empty__icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="40" height="40">
              <circle cx="21" cy="21" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M29 29l9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <p className="empty__title">没有匹配的景点</p>
          <p className="empty__desc">换个关键词，或清除类别 / 等级筛选后重试。当前区域共 {totalInRegion} 个景点。</p>
          {hasFilter && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onResetFilter}>
              清除筛选条件
            </button>
          )}
        </div>
      )}
    </div>
  );
}
