import type { RegionNode } from '../types';

interface BreadcrumbProps {
  path: RegionNode[];
  onNavigate: (adcode: number) => void;
}

/** 中国 / 浙江省 / 杭州市 / 西湖区 */
export default function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb" aria-label="行政区划路径">
      <ol>
        {path.map((region, index) => {
          const isLast = index === path.length - 1;
          return (
            <li key={region.adcode}>
              {isLast ? (
                <span className="breadcrumb__current" aria-current="page">
                  {region.name}
                </span>
              ) : (
                <button
                  type="button"
                  className="breadcrumb__link"
                  onClick={() => onNavigate(region.adcode)}
                >
                  {region.name}
                </button>
              )}
              {!isLast && (
                <span className="breadcrumb__sep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
