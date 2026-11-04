import type { AttractionCategory } from '../types';

export const CATEGORIES: AttractionCategory[] = ['自然风光', '历史文化', '园林公园', '博物馆'];

export const CATEGORY_META: Record<AttractionCategory, { color: string; description: string }> = {
  自然风光: { color: '#2f7d63', description: '湖泊、湿地、山体等自然景观' },
  历史文化: { color: '#8a5a2b', description: '古建、宗教场所、石窟造像等' },
  园林公园: { color: '#7c9a3e', description: '植物园、城市园林与公园' },
  博物馆: { color: '#4a6fa5', description: '博物馆、专题展馆' },
};
