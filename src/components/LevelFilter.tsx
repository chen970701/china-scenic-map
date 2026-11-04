import type { LevelFilter } from '../types';
import { LEVEL_FILTERS } from '../data/levels';

interface LevelFilterProps {
  value: LevelFilter | null;
  counts: Record<LevelFilter | 'none', number>;
  total: number;
  onChange: (value: LevelFilter | null) => void;
}

export default function LevelFilter({ value, counts, total, onChange }: LevelFilterProps) {
  return (
    <div className="chips chips--level" role="group" aria-label="按景区等级筛选">
      <span className="chips__label">等级</span>
      <button
        type="button"
        className={`chip${value === null ? ' is-active' : ''}`}
        aria-pressed={value === null}
        title="不限等级，含未评级点位"
        onClick={() => onChange(null)}
      >
        不限
        <span className="chip__count">{total}</span>
      </button>
      {LEVEL_FILTERS.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`chip${value === item.value ? ' is-active' : ''}`}
          aria-pressed={value === item.value}
          title={item.hint}
          onClick={() => onChange(value === item.value ? null : item.value)}
        >
          <i className="chip__dot" style={{ background: item.color }} />
          {item.label}
          <span className="chip__count">{counts[item.value] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
