import { useEffect, useRef } from 'react';
import type { Attraction } from '../types';
import { CATEGORY_META } from '../data/categories';

interface DetailDrawerProps {
  attraction: Attraction | null;
  onClose: () => void;
  onLocate: (attraction: Attraction) => void;
}

export default function DetailDrawer({ attraction, onClose, onLocate }: DetailDrawerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const open = Boolean(attraction);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!attraction) return null;

  const meta = CATEGORY_META[attraction.category];

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="drawer-title"
        aria-describedby="drawer-desc"
      >
        <div className="drawer__grip" aria-hidden="true" />

        <header className="drawer__head">
          <div>
            <p className="drawer__eyebrow">
              <span className="tag" style={{ ['--tag-color' as string]: meta.color }}>
                {attraction.category}
              </span>
              <span className="drawer__loc">
                {attraction.province} · {attraction.city} · {attraction.district}
              </span>
            </p>
            <h2 id="drawer-title" className="drawer__title">
              {attraction.name}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn icon-btn--lg"
            onClick={onClose}
            aria-label="关闭详情"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.7" fill="none" />
            </svg>
          </button>
        </header>

        <div className="drawer__body">
          <p id="drawer-desc" className="drawer__summary">
            {attraction.summary}
          </p>

          <section className="drawer__section">
            <h3>景点介绍</h3>
            {attraction.description ? (
              <>
                <p>{attraction.description}</p>
                {attraction.introSource && (
                  <p className="drawer__cite">
                    介绍摘自{' '}
                    <a href={attraction.introSource.url} target="_blank" rel="noreferrer">
                      {attraction.introSource.label}
                    </a>
                    ，可能与现状有出入。
                  </p>
                )}
              </>
            ) : (
              <p className="drawer__muted">
                该景点由 {attraction.source.label} 自动导入，暂无可用的文字介绍。可在下方来源链接查看原始数据。
              </p>
            )}
          </section>

          {(attraction.ticket || attraction.openingHours || attraction.bestSeason) && (
            <section className="drawer__section">
              <h3>门票与开放时间</h3>
              <dl className="info-grid">
                {attraction.ticket && (
                  <div>
                    <dt>门票</dt>
                    <dd>{attraction.ticket}</dd>
                  </div>
                )}
                {attraction.openingHours && (
                  <div>
                    <dt>开放时间</dt>
                    <dd>{attraction.openingHours}</dd>
                  </div>
                )}
                {attraction.bestSeason && (
                  <div>
                    <dt>建议游玩</dt>
                    <dd>{attraction.bestSeason}</dd>
                  </div>
                )}
              </dl>
              <p className="drawer__cite">信息来自公开百科，可能已调整，出行前请以景区公告为准。</p>
            </section>
          )}

          {attraction.guide && attraction.guide.sections.length > 0 && (
            <section className="drawer__section drawer__section--guide">
              <h3>
                游玩攻略
                <span className="guide-badge">AI 摘要</span>
              </h3>
              {attraction.guide.intro && <p className="guide__intro">{attraction.guide.intro}</p>}
              {attraction.guide.sections.map((section) => (
                <div className="guide__block" key={section.title}>
                  <h4>{section.title}</h4>
                  <ul className="guide__list">
                    {section.items.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="drawer__cite">
                攻略由搜索引擎根据公开信息自动生成，未经人工核实，仅供行程参考。
              </p>
            </section>
          )}

          {attraction.adminNote && (
            <p className="notice notice--soft">
              <strong>归属说明：</strong>
              {attraction.adminNote}
            </p>
          )}

          <section className="drawer__section">
            <h3>基本信息</h3>
            <dl className="info-grid">
              <div>
                <dt>所属省份</dt>
                <dd>{attraction.province}</dd>
              </div>
              <div>
                <dt>所属城市</dt>
                <dd>{attraction.city}</dd>
              </div>
              <div>
                <dt>所属区县</dt>
                <dd>{attraction.district}</dd>
              </div>
              <div>
                <dt>景点分类</dt>
                <dd>{attraction.category}</dd>
              </div>
              <div>
                <dt>景区等级</dt>
                <dd>
                  {attraction.level ? ` 国家${attraction.level}级旅游景区` : '暂无 A 级评定'}
                  {attraction.level && attraction.levelSource && (
                    <span className="info-grid__hint">（{attraction.levelSource}）</span>
                  )}
                </dd>
              </div>
              <div className="info-grid__full">
                <dt>地址</dt>
                <dd>{attraction.address || '暂无街道地址'}</dd>
              </div>
              <div className="info-grid__full">
                <dt>参考坐标</dt>
                <dd>
                  {attraction.latitude.toFixed(4)}, {attraction.longitude.toFixed(4)}
                  <span className="info-grid__hint">（{attraction.coordSource}）</span>
                </dd>
              </div>
            </dl>
          </section>

          <p className="notice">
            坐标为参考坐标，仅用于地图上的示意定位，不作为测绘或导航依据；介绍、门票与攻略均来自公开网页，未经实地核实。
          </p>

          <p className="drawer__source">
            资料来源：
            <a href={attraction.source.url} target="_blank" rel="noreferrer">
              {attraction.source.label}
            </a>
            <span className={`source-badge source-badge--${attraction.origin}`}>
              {attraction.origin === 'curated'
                ? '人工核对'
                : attraction.origin === 'a-level'
                  ? '官方名录'
                  : '自动导入'}
            </span>
          </p>
        </div>

        <footer className="drawer__foot">
          <button type="button" className="btn btn--primary" onClick={() => onLocate(attraction)}>
            在地图上定位
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </footer>
      </aside>
    </>
  );
}
