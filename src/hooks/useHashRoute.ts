import { useCallback, useEffect, useState } from 'react';
import { ROOT_ADCODE } from '../lib/regions';

export interface Route {
  /** 从根开始的行政区 adcode 片段（字符串形式，由调用方解析） */
  segments: string[];
  /** 当前打开的景点 id（详情面板状态） */
  poiId: string | null;
}

/** 解析 `#/330000/330100/330106?poi=xxx` */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart ?? '');
  const poiId = params.get('poi');
  return { segments, poiId: poiId || null };
}

function buildHash(adcodes: number[], poiId: string | null): string {
  // 根节点（全国）不出现在 URL 中，保持链接简洁：#/330000/330100
  const list = adcodes[0] === ROOT_ADCODE ? adcodes.slice(1) : adcodes;
  const path = list.join('/');
  return `#/${path}${poiId ? `?poi=${encodeURIComponent(poiId)}` : ''}`;
}

/**
 * 极简 hash 路由：刷新页面后可还原区域与详情状态，同时支持浏览器前进/后退。
 */
export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { segments: [], poiId: null } : parseHash(window.location.hash),
  );

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((adcodes: number[], poiId: string | null = null) => {
    const next = buildHash(adcodes, poiId);
    if (window.location.hash === next) return;
    window.location.hash = next;
  }, []);

  return { route, navigate };
}
