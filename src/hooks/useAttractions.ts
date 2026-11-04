import { useEffect, useState } from 'react';
import type { Attraction, RegionNode } from '../types';
import { getRegionPath } from '../lib/regions';
import { attractionsUnderRegion, loadProvinceAttractions } from '../lib/attractions';

export interface AttractionState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 当前区域内（含下级）的景点 */
  items: Attraction[];
  /** 所属省份已加载的景点总数 */
  provinceTotal: number;
  error?: string;
}

const EMPTY: AttractionState = { status: 'idle', items: [], provinceTotal: 0 };

/**
 * 按区域加载景点：整省数据只请求一次并缓存，切换区县时在本地过滤。
 * 全国层级不加载明细（各省数量由 summary.json 提供）。
 */
export function useRegionAttractions(region: RegionNode | undefined): AttractionState {
  const [state, setState] = useState<AttractionState>(EMPTY);

  const adcode = region?.adcode ?? 0;
  const level = region?.level;

  useEffect(() => {
    if (!region || level === 'country') {
      setState(EMPTY);
      return;
    }

    const path = getRegionPath(adcode);
    const provinceAdcode = path.length > 1 ? path[1].adcode : adcode;

    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading', error: undefined }));

    loadProvinceAttractions(provinceAdcode)
      .then((list) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          items: attractionsUnderRegion(list, adcode),
          provinceTotal: list.length,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({ status: 'error', items: [], provinceTotal: 0, error: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, [adcode, level, region]);

  return state;
}
