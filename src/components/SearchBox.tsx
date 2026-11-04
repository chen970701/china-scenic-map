interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  resultCount: number | null;
  disabled?: boolean;
}

export default function SearchBox({
  value,
  onChange,
  placeholder,
  resultCount,
  disabled = false,
}: SearchBoxProps) {
  return (
    <div className={`searchbox${disabled ? ' is-disabled' : ''}`} role="search">
      <svg className="searchbox__icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        className="searchbox__input"
        value={value}
        placeholder={placeholder}
        aria-label="搜索景点名称"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="searchbox__clear"
          onClick={() => onChange('')}
          aria-label="清除搜索"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </svg>
        </button>
      ) : (
        resultCount !== null && <span className="searchbox__hint">{resultCount} 个景点</span>
      )}
    </div>
  );
}
