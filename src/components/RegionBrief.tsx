import { useEffect, useRef, useState } from 'react';
import type { RecommendedAttraction, RegionInfo } from '../types';

interface RegionBriefProps {
  info: RegionInfo | null;
  loading: boolean;
  onOpen: () => void;
  onLocate: (id: string) => void;
}

/**
 * 列表顶部的「地区概览」条：一句话定位 + 攻略里最常被点名的几个景点。
 * 只占三四行高度，正文（介绍全文、攻略小节）放抽屉里，不跟景点列表抢空间。
 * 概览里那句定位默认折三行，真实溢出了才出「展开全文」——不用让用户为了看半句话进抽屉。
 */
export default function RegionBrief({ info, loading, onOpen, onLocate }: RegionBriefProps) {
  const leadRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);

  // 换地区就收起：上一条的展开状态不能带到下一条
  useEffect(() => {
    setExpanded(false);
  }, [info?.adcode]);

  useEffect(() => {
    const el = leadRef.current;
    if (!el) return;
    // 展开后元素本身没有 clamp，量出来必然不溢出，所以只在收起态测
    const measure = () => {
      if (expanded) return;
      setOverflow(el.scrollHeight - el.clientHeight > 2);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [info?.lead, expanded, info?.adcode]);

  if (loading) {
    return (
      <div className="region-brief region-brief--loading" aria-live="polite">
        <span className="region-brief__tag">地区概览</span>
        <p className="region-brief__lead">正在加载该地区的介绍与攻略…</p>
      </div>
    );
  }

  if (!info) return null;

  const recs: RecommendedAttraction[] = info.recommended.slice(0, 6);
  const hasBody = Boolean(info.intro || info.guide);

  return (
    <section className="region-brief" aria-label="地区概览">
      <div className="region-brief__top">
        <span className="region-brief__tag">地区概览</span>
        {hasBody && (
          <button type="button" className="region-brief__more" onClick={onOpen}>
            介绍与攻略
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        )}
      </div>

      {info.lead && (
        <>
          <p
            ref={leadRef}
            className={`region-brief__lead${expanded ? ' is-expanded' : ''}`}
          >
            {info.lead}
          </p>
          {overflow && (
            <button
              type="button"
              className="region-brief__expand"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? '收起' : '展开全文'}
            </button>
          )}
        </>
      )}

      {recs.length > 0 && (
        <div className="region-brief__recs">
          <span className="region-brief__recs-label">
            {info.guide ? '攻略里反复提到' : '百科列出的景点'}
          </span>
          <div className="rec-chips">
            {recs.map((rec) => (
              <button
                key={rec.id}
                type="button"
                className="rec-chip"
                onClick={() => onLocate(rec.id)}
                title={`${rec.name}｜在地图上定位`}
              >
                <span className="rec-chip__pin" aria-hidden="true">
                  <svg viewBox="0 0 12 12" width="9" height="9">
                    <path
                      d="M6 1.2c1.9 0 3.4 1.4 3.4 3.2C9.4 6.6 6 10.6 6 10.6S2.6 6.6 2.6 4.4C2.6 2.6 4.1 1.2 6 1.2Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                </span>
                {/* 显示攻略里的叫法（「乌镇」），全名放 title：名录全名太长会撑爆一行 */}
                {rec.matched || rec.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
