import type { Attraction } from '../types';
import { CATEGORY_META } from '../data/categories';

interface AttractionCardProps {
  attraction: Attraction;
  order: number;
  active: boolean;
  onOpen: (id: string) => void;
  onLocate: (attraction: Attraction) => void;
}

export default function AttractionCard({
  attraction,
  order,
  active,
  onOpen,
  onLocate,
}: AttractionCardProps) {
  const meta = CATEGORY_META[attraction.category];

  return (
    <article
      className={`poi-card${active ? ' is-active' : ''}`}
      onClick={() => onOpen(attraction.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(attraction.id);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`查看${attraction.name}详情`}
      data-poi-id={attraction.id}
    >
      <div className="poi-card__head">
        <span className="poi-card__index">{String(order + 1).padStart(2, '0')}</span>
        <h3 className="poi-card__name">{attraction.name}</h3>
        {attraction.level && (
          <span className="level-badge" title={`国家${attraction.level}级旅游景区`}>
            {attraction.level}
          </span>
        )}
        <span className="tag" style={{ ['--tag-color' as string]: meta.color }}>
          {attraction.category}
        </span>
      </div>

      <p className="poi-card__summary">{attraction.summary}</p>

      <div className="poi-card__foot">
        <span className="poi-card__meta">
          {attraction.address
            ? `${attraction.district} · ${attraction.address}`
            : `${attraction.city} · ${attraction.province}`}
        </span>
        <span className="poi-card__actions">
          <button
            type="button"
            className="icon-btn"
            title="在地图上定位"
            aria-label={`在地图上定位${attraction.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onLocate(attraction);
            }}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
              <path
                d="M10 2c3.3 0 6 2.6 6 5.9 0 4.2-6 10.1-6 10.1s-6-5.9-6-10.1C4 4.6 6.7 2 10 2Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="10" cy="7.8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <span className="poi-card__more" aria-hidden="true">
            详情
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
        </span>
      </div>
    </article>
  );
}
