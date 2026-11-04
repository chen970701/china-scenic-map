interface RegionGridItem {
  adcode: number;
  name: string;
  count: number;
}

interface RegionGridProps {
  items: RegionGridItem[];
  onSelect: (adcode: number) => void;
}

/** 全国层级：省份快捷入口（地图上的省份面积差异很大，列表入口更稳） */
export default function RegionGrid({ items, onSelect }: RegionGridProps) {
  const withData = items.filter((item) => item.count > 0).length;

  return (
    <div className="region-grid-wrap">
      <p className="region-grid__hint">
        {items.length} 个省级行政区，其中 {withData} 个已收录景点。也可以直接点击地图上的省份。
      </p>
      <div className="region-grid">
        {items.map((item) => (
          <button
            key={item.adcode}
            type="button"
            className={`region-grid__item${item.count > 0 ? ' has-data' : ''}`}
            onClick={() => onSelect(item.adcode)}
            title={`${item.name} · ${item.count} 个景点`}
          >
            <span className="region-grid__name">{item.name}</span>
            <span className="region-grid__count">{item.count > 0 ? item.count : '—'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
