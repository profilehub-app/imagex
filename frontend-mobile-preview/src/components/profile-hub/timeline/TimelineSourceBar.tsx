import { useEffect, useRef } from 'react';
import { ArrowUpRight, ChevronDown, Ellipsis } from 'lucide-react';
import { getTimelineSourceDisplayName, TIMELINE_SOURCES, type TimelineSource } from './timelineSourceNavigation';
import { renderBrandPlatformIcon } from './TimelineBrandIcons';

export function renderSourceIcon(site: TimelineSource, size = 16) {
  return renderBrandPlatformIcon(site, size);
}

const PREFERRED_SOURCE_ORDER = ['all', 'youtube', 'x', 'instagram', 'pinterest', 'imgur', 'slack'];

export function TimelineSourceBar({
  source,
  available,
  dynamicSources = [],
  isEn,
  isMobile = false,
  disableAnimations = false,
  onChange,
}: {
  source: TimelineSource;
  available: ReadonlySet<TimelineSource>;
  dynamicSources?: ReadonlyArray<{ id: string; name: string }>;
  isEn: boolean;
  isMobile?: boolean;
  disableAnimations?: boolean;
  onChange: (source: TimelineSource) => void;
}) {
  const language = isEn ? 'en' : 'pt';
  const navRef = useRef<HTMLElement | null>(null);

  const orderedActive = Array.from(new Set<string>(['all', ...available]))
    .filter((id) => id === 'all' || available.has(id))
    .sort((a, b) => {
      if (a === 'all') return -1;
      if (b === 'all') return 1;
      const idxA = PREFERRED_SOURCE_ORDER.indexOf(a);
      const idxB = PREFERRED_SOURCE_ORDER.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

  const labelFor = (sid: string): string => {
    const dyn = dynamicSources.find((d) => d.id.toLowerCase() === sid.toLowerCase());
    return TIMELINE_SOURCES[sid]?.[language] ?? dyn?.name ?? getTimelineSourceDisplayName(sid, language);
  };

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof nav.querySelector !== 'function') return;
    const activeBtn = nav.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
      const reduced =
        disableAnimations ||
        (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
      try {
        activeBtn.scrollIntoView({
          inline: 'nearest',
          block: 'nearest',
          behavior: reduced ? 'auto' : 'smooth',
        });
      } catch {
        // Guard non-DOM test environments
      }
    }
  }, [source, disableAnimations]);

  if (isMobile) {
    return (
      <nav
        ref={navRef}
        aria-label={isEn ? 'Sources' : 'Fontes'}
        className="tl-source-bar tl-source-bar--mobile tl-source-bar--edge-fade"
      >
        {orderedActive.map((site) => (
          <button
            key={site}
            type="button"
            className="tl-source-tile tl-pressable"
            data-source-pill={site}
            aria-pressed={site === source}
            onClick={() => onChange(site as TimelineSource)}
          >
            {renderBrandPlatformIcon(site, 17)}
            <span className={site === 'x' && orderedActive.length > 3 ? 'sr-only' : undefined}>{labelFor(site)}</span>
          </button>
        ))}
      </nav>
    );
  }

  const desktopPrimary = orderedActive.slice(0, 5);
  const desktopOthers = orderedActive.slice(5);
  const otherSelected = desktopOthers.includes(source);
  const selectedOtherLabel = labelFor(source);

  return (
    <nav ref={navRef} aria-label={isEn ? 'Sources' : 'Fontes'} className="tl-source-bar">
      {desktopPrimary.map((site) => (
        <button
          key={site}
          type="button"
          className="tl-source-tile tl-pressable"
          data-source-pill={site}
          aria-pressed={site === source}
          onClick={() => onChange(site as TimelineSource)}
        >
          {renderBrandPlatformIcon(site, 17)}
          <span className={site === 'x' && desktopPrimary.length > 3 ? 'sr-only' : undefined}>{labelFor(site)}</span>
        </button>
      ))}
      {desktopOthers.length > 0 && (
        <label
          className="tl-source-tile tl-pressable"
          data-source-pill={otherSelected ? source : 'more'}
          data-selected={otherSelected || undefined}
        >
          {otherSelected ? renderSourceIcon(source, 17) : <Ellipsis aria-hidden size={19} />}
          <span>{otherSelected ? selectedOtherLabel : (isEn ? 'More' : 'Mais')}</span>
          <ChevronDown aria-hidden size={14} className="opacity-70 shrink-0" />
          <select
            value={otherSelected ? source : ''}
            aria-label={isEn ? 'More sources' : 'Mais fontes'}
            onChange={(event) => onChange(event.target.value as TimelineSource)}
          >
            <option value="" disabled>
              {isEn ? 'More sources' : 'Mais fontes'}
            </option>
            {desktopOthers.map((site) => (
              <option key={site} value={site}>
                {labelFor(site)}
              </option>
            ))}
          </select>
        </label>
      )}
    </nav>
  );
}

export function TimelineSourceLinks({ source, isEn }: { source: TimelineSource; isEn: boolean }) {
  if (source !== 'youtube' && source !== 'instagram' && source !== 'pinterest' && source !== 'imgur') return null;
  return (
    <div className="tl-source-links">
      {source === 'youtube' ? (
        <>
          <a href="https://www.youtube.com/feed/subscriptions" target="_blank" rel="noreferrer">
            {isEn ? 'Subscriptions on YouTube' : 'Inscrições no YouTube'} <ArrowUpRight aria-hidden size={14} />
          </a>
          <a href="https://www.youtube.com/" target="_blank" rel="noreferrer">
            {isEn ? 'Recommendations on YouTube' : 'Recomendações no YouTube'} <ArrowUpRight aria-hidden size={14} />
          </a>
        </>
      ) : source === 'instagram' ? (
        <a href="https://www.instagram.com/" target="_blank" rel="noreferrer">
          {isEn ? 'Feed on Instagram' : 'Feed no Instagram'} <ArrowUpRight aria-hidden size={14} />
        </a>
      ) : source === 'pinterest' ? (
        <a href="https://www.pinterest.com/" target="_blank" rel="noreferrer">
          {isEn ? 'Explore on Pinterest' : 'Explorar no Pinterest'} <ArrowUpRight aria-hidden size={14} />
        </a>
      ) : (
        <a href="https://imgur.com/" target="_blank" rel="noreferrer">
          {isEn ? 'Viral on Imgur' : 'Em alta no Imgur'} <ArrowUpRight aria-hidden size={14} />
        </a>
      )}
    </div>
  );
}
