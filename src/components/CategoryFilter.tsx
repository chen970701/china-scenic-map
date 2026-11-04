import type { AttractionCategory } from '../types';
import { CATEGORIES, CATEGORY_META } from '../data/categories';

interface CategoryFilterProps {
  value: AttractionCategory | null;
  counts: Record<string, number>;
  total: number;
  onChange: (value: AttractionCategory | null) => void;
}

export default function CategoryFilter({ value, counts, total, onChange }: CategoryFilterProps) {
  return (
    <div className="chips" role="group" aria-label="按类别筛选">
      <button
        type="button"
        className={`chip${value === null ? ' is-active' : ''}`}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        全部
        <span className="chip__count">{total}</span>
      </button>
      {CATEGORIES.map((category) => (
        <button
          key={category}
          type="button"
          className={`chip${value === category ? ' is-active' : ''}`}
          aria-pressed={value === category}
          title={CATEGORY_META[category].description}
          onClick={() => onChange(value === category ? null : category)}
        >
          <i className="chip__dot" style={{ background: CATEGORY_META[category].color }} />
          {category}
          <span className="chip__count">{counts[category] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
