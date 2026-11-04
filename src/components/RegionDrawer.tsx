import { useEffect, useRef } from 'react';
import type { RegionInfo } from '../types';

interface RegionDrawerProps {
  info: RegionInfo | null;
  onClose: () => void;
  onLocate: (id: string) => void;
}

const LEVEL_LABEL: Record<number, string> = { 1: '省级行政区', 2: '地级行政区', 3: '区县' };

/**
 * 地区介绍与攻略抽屉，和景点详情共用一套抽屉样式与交互，
 * 但内容是「整个地区」：百科介绍 + AI 攻略 + 攻略里点名的景点。
 */
export default function RegionDrawer({ info, onClose, onLocate }: RegionDrawerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const open = Boolean(info);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!info) return null;

  const facts = info.facts ?? {};
  const factRows: [string, string][] = [
    ['行政区类别', facts.type ?? ''],
    ['面积', facts.area ?? ''],
    ['常住人口', facts.population ?? ''],
    ['气候', facts.climate ?? ''],
    ['政府驻地', facts.seat ?? ''],
  ].filter(([, value]) => Boolean(value)) as [string, string][];

  const recs = info.recommended;
  // 攻略有两个来源：百度 AI 卡摘下来的，或者这个市搜不到卡、由模型整理的。
  // 两者在界面上必须能分清，不能让用户以为是同一件事。
  const authored = info.guide?.author === 'model';
  // 顶部那句「一句话定位」取的就是百科摘要的第一句，介绍正文也从同一句开始。
  // 补全介绍之后两段会连着出现一摸一样的开头，所以重复时只留正文那份。
  const norm = (text: string) => text.replace(/\s+/g, '');
  const showLead = Boolean(info.lead) && norm(info.intro ?? '').slice(0, 18) !== norm(info.lead ?? '').slice(0, 18);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="region-drawer-title"
        aria-describedby="region-drawer-desc"
      >
        <div className="drawer__grip" aria-hidden="true" />

        <header className="drawer__head">
          <div>
            <p className="drawer__eyebrow">
              <span className="tag tag--region">{LEVEL_LABEL[info.level] ?? '地区'}</span>
              <span className="drawer__loc">
                {info.level === 1 ? '地区概览' : `${info.province} · ${info.city}`}
              </span>
            </p>
            <h2 id="region-drawer-title" className="drawer__title">
              {info.name}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn icon-btn--lg"
            onClick={onClose}
            aria-label="关闭地区介绍"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.7" fill="none" />
            </svg>
          </button>
        </header>

        <div className="drawer__body">
          {showLead && (
            <p id="region-drawer-desc" className="drawer__summary">
              {info.lead}
            </p>
          )}

          {factRows.length > 0 && (
            <section className="drawer__section">
              <h3>基本信息</h3>
              <dl className="info-grid">
                {factRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                <div>
                  <dt>已收录景点</dt>
                  <dd>
                    {info.stats.attractions} 个
                    {info.stats.byLevel?.['5A'] ? `（含 5A ${info.stats.byLevel['5A']} 个）` : ''}
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {info.intro && (
            <section className="drawer__section">
              <h3>地区介绍</h3>
              <p id={showLead ? undefined : 'region-drawer-desc'}>{info.intro}</p>
              {info.introSource &&
                (info.introSource.url ? (
                  <p className="drawer__cite">
                    介绍摘自{' '}
                    <a href={info.introSource.url} target="_blank" rel="noreferrer">
                      {info.introSource.label}
                    </a>
                    ，可能与现状有出入。
                  </p>
                ) : (
                  // 重名小市辖区在百科没有独立词条，这类介绍是模型按可靠事实写的，必须注明
                  <p className="drawer__cite">
                    {info.introSource.label}：该地百科无独立词条，介绍未采用百科原文，可能与现状有出入。
                  </p>
                ))}
            </section>
          )}

          {info.guide && info.guide.sections.length > 0 && (
            <section className="drawer__section drawer__section--guide">
              <h3>
                旅游攻略
                <span className="guide-badge">{authored ? 'AI 整理' : 'AI 摘要'}</span>
              </h3>
              {info.guide.intro && <p className="guide__intro">{info.guide.intro}</p>}
              {info.guide.sections.map((section, idx) => (
                <div className="guide__block" key={`${section.title}-${idx}`}>
                  <h4>{section.title}</h4>
                  <ul className="guide__list">
                    {section.items.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="drawer__cite">
                {authored
                  ? info.guide.reason === 'thin'
                    ? '搜索引擎给的现成摘要内容太少，本篇改用模型整理的完整版，未经实地核实；门票、班次、开放时间请以景区官方公告为准。'
                    : '这个地方没有现成的攻略摘要，本篇由模型根据公开常识与站内收录的景点资料整理，未经实地核实；门票、班次、开放时间请以景区官方公告为准。'
                  : '攻略由搜索引擎根据公开信息自动生成，未经人工核实，仅供行程参考。'}
              </p>
            </section>
          )}

          {recs.length > 0 && (
            <section className="drawer__section">
              <h3>
                攻略推荐的景点
                <span className="guide-badge">
                  {recs.filter((r) => r.fromGuide).length} 个被点名
                </span>
              </h3>
              <p className="drawer__muted region-drawer__hint">
                下面每个名字都在上面的攻略里出现过，点一下直接跳过去定位。
              </p>
              <ul className="rec-list">
                {recs.map((rec) => (
                  <li key={rec.id}>
                    <button type="button" className="rec-row" onClick={() => onLocate(rec.id)}>
                      <span className="rec-row__name">
                        <span className="rec-row__label">{rec.matched || rec.name}</span>
                        {rec.matched && rec.matched !== rec.name && (
                          <span className="rec-row__full">{rec.name}</span>
                        )}
                        {rec.level && <span className="rec-row__level">{rec.level}</span>}
                      </span>
                      <span className="rec-row__meta">
                        {rec.fromGuide ? `攻略提到 ${rec.hits} 次` : '百科列出'}
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="notice">
            地区介绍来自公开网页；攻略为自动整理或模型撰写，均未经实地核实；推荐只覆盖本图已收录的景点。
          </p>
        </div>

        <footer className="drawer__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </footer>
      </aside>
    </>
  );
}
