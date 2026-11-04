/** 全局类型定义 */

/** 行政区划层级（全国版：国 → 省 → 市 → 区县） */
export type RegionLevel = 'country' | 'province' | 'city' | 'district';

export interface RegionNode {
  /** 国标行政区划代码，同时作为路由与唯一标识 */
  adcode: number;
  /** 展示名，如 `西湖区` */
  name: string;
  level: RegionLevel;
  /** 父级 adcode，根节点为 0 */
  parentAdcode: number;
  /** 是否存在下级行政区（决定地图上是否可继续下钻） */
  hasChildren: boolean;
  /** 直接下级 adcode 列表 */
  childAdcodes: number[];
  /** 自身边界所在的文件：根是 g/100000.json，其余是父级的 g 文件（含同级兄弟，用于地图背景） */
  selfGeoFile: string;
  /** 有下级时：该节点直接下级的边界文件 g/{adcode}.json */
  childGeoFile: string | null;
}

/** 景点类别 */
export type AttractionCategory = '自然风光' | '历史文化' | '园林公园' | '博物馆';

/** 景点数据来源类型：人工核对 / A 级景区名录 / 自动导入 */
export type AttractionOrigin = 'curated' | 'a-level' | 'osm';

/** 国家 A 级旅游景区等级 */
export type ScenicLevel = '5A' | '4A' | '3A' | '2A' | '1A';

/**
 * 等级筛选档位。
 * 只到 3A：2A / 1A 大多是本地小景点，与"值得专程去"的诉求相反，
 * 塞进筛选行还要多占一行位置，直接并在「不限」里。
 */
export type LevelFilter = '5A' | '4A' | '3A';

export interface Attraction {
  id: string;
  name: string;
  province: string;
  city: string;
  district: string;
  /** 景点所属区县的国标代码 */
  districtAdcode: number;
  /** 祖先 adcode 链：省 → 市 → 区县（含自身），用于按任意层级聚合 */
  path: number[];
  category: AttractionCategory;
  /** 一句话介绍 */
  summary: string;
  /** 详细介绍（自动导入的数据可能为空） */
  description: string;
  /** 图片字段预留，本阶段为空字符串 */
  image: string;
  address: string;
  /** 参考纬度（仅用于地图定位展示） */
  latitude: number;
  /** 参考经度 */
  longitude: number;
  /** 坐标来源说明 */
  coordSource: string;
  /** 数据来源 */
  source: { label: string; url: string };
  /** 归属说明/备注（例如跨区、行政归属特殊） */
  adminNote?: string;
  /** 数据置信度：curated 为人工核对，a-level 为官方名录，osm 为自动导入未逐条复核 */
  origin: AttractionOrigin;
  /** 国家 A 级景区等级（仅有等级评定的景点才有） */
  level?: ScenicLevel;
  /** 等级来源说明 */
  levelSource?: string;
  /** 开放时间（来自公开百科，可能已变动） */
  openingHours?: string;
  /** 门票（来自公开百科，可能已变动） */
  ticket?: string;
  /** 建议游玩时长 */
  bestSeason?: string;
  /** 介绍文字出处（与 source 分开：source 是名录/坐标来源，这里是文案来源） */
  introSource?: { label: string; url: string };
  /** 游玩攻略（结构化，来自公开搜索结果的 AI 摘要） */
  guide?: AttractionGuide;
}

/** 攻略的一个小节，如「怎么玩最顺路」「门票与开放时间」 */
export interface GuideSection {
  title: string;
  items: string[];
}

export interface AttractionGuide {
  /** 开头一段总述 */
  intro: string;
  sections: GuideSection[];
  /** 攻略出处链接 */
  sourceUrl: string;
  sourceLabel: string;
}

/** 地区攻略里被点名、且库里已收录的景点（可直接定位） */
export interface RecommendedAttraction {
  id: string;
  name: string;
  /** 在攻略里实际命中的叫法，如「西湖」 */
  matched: string;
  level: string;
  /** 在攻略正文中出现的次数 */
  hits: number;
  /** true 表示来自地区攻略；false 表示只出现在行政区「著名景点」栏 */
  fromGuide: boolean;
  score: number;
  first: number;
}

/** 行政区（省 / 市 / 区县）的介绍与旅游攻略，按 adcode 单独存一个文件 */
export interface RegionInfo {
  adcode: number;
  name: string;
  /** 1 省 / 2 市 / 3 区县 */
  level: number;
  province: string;
  city: string;
  generatedAt: string;
  /** 一句话定位（百科首句） */
  lead?: string;
  /** 完整介绍 */
  intro?: string;
  /** 面积、人口、气候、政府驻地等 */
  facts?: Record<string, string>;
  introSource?: { label: string; url: string };
  guide?: {
    intro: string;
    sections: GuideSection[];
    sourceUrl: string;
    sourceLabel: string;
    /** search：百度 AI 卡摘下来的；model：抓到的卡太残（或无卡），由模型整理 */
    author?: 'search' | 'model';
    /** 用模型版的原因：none = 完全没有卡；thin = 有卡但内容太少 */
    reason?: 'none' | 'thin';
  };
  recommended: RecommendedAttraction[];
  stats: {
    /** 该地区（含下级）已收录的景点数 */
    attractions: number;
    byLevel: Record<string, number>;
    /** 推荐里有几个是攻略点名的 */
    inGuide: number;
  };
}

/** 全国景点索引（按省拆分存储，进入某省才加载明细） */
export interface AttractionSummary {
  generatedAt: string;
  /** 全国合计 */
  total: number;
  /** 省 adcode → 景点数 */
  provinces: Record<string, number>;
  /** 区县 adcode → 景点数（用于地图气泡与空状态提示） */
  districts?: Record<string, number>;
  sources: { label: string; url: string; license: string; note: string }[];
}

export interface GeoFeatureProperties {
  adcode: number;
  name: string;
  level?: string;
  center?: [number, number];
}

export interface GeoFeature {
  type: 'Feature';
  properties: GeoFeatureProperties;
  geometry: unknown;
}

export interface GeoCollection {
  type: 'FeatureCollection';
  metadata?: { source: string; sourceUrl: string; note: string };
  bbox?: [number, number, number, number];
  features: GeoFeature[];
}

/** /geo/index.json 的结构 */
export interface RegionIndexFile {
  generatedAt: string;
  source: string;
  counts: { nodes: number; province: number; city: number; district: number; geoFiles: number };
  /** [adcode, 名称, 父级adcode, 层级(0国/1省/2市/3区县)] */
  nodes: [number, string, number, number][];
}
