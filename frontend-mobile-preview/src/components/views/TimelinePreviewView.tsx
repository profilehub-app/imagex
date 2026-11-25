import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { ProfileTimelineView } from '../profile-hub/timeline/ProfileTimelineView';
import { TimelineMobileHeader } from '../profile-hub/timeline/TimelineMobileHeader';
import { TimelineLocalImport } from '../profile-hub/timeline/TimelineLocalImport';
import { useProfileTimelineStore } from '../../store/useProfileTimelineStore';

function isMobileTimeline(): boolean {
  if (typeof window === 'undefined') return false;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return window.innerWidth < 768 || (isTouch && window.innerWidth <= 1024);
}

export const TimelinePreviewView: React.FC<{active?: boolean; onOpenMobileMenu?: () => void}> = ({active = true, onOpenMobileMenu}) => {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const sourcesTriggerRef = useRef<HTMLElement | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [isMobileDevice, setIsMobileDevice] = useState(isMobileTimeline);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
  const [mobileChromeCollapsed, setMobileChromeCollapsed] = useState(false);
  const integratedSourcesCount = useProfileTimelineStore(state => state.integratedSources.length);

  useEffect(() => {
    if (!active) return;
    const update = () => setIsMobileDevice(isMobileTimeline());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [active]);

  useEffect(() => {
    if (!isMobileDevice) {
      setMobileChromeCollapsed(false);
    }
  }, [isMobileDevice]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!active || !surface) return;
    const toolbars = Array.from(surface.querySelectorAll<HTMLElement>('[data-timeline-toolbar]'));
    const update = () => {
      surface.style.setProperty('--timeline-parent-toolbar-top', '0px');
      surface.style.setProperty(
        '--timeline-watch-top',
        `${toolbars.reduce((sum, element) => sum + (element.dataset.collapsed === 'true' ? 0 : element.offsetHeight), 0)}px`
      );
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    toolbars.forEach(element => observer?.observe(element));
    return () => observer?.disconnect();
  }, [active, isMobileDevice, mobileChromeCollapsed]);

  const toggleMobileSearch = () => {
    setMobileChromeCollapsed(false);
    setMobileSearchOpen((prev) => {
      const next = !prev;
      if (next && typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          const input = surfaceRef.current?.querySelector<HTMLInputElement>('[data-omni-search-input="true"]');
          input?.focus({ preventScroll: true });
        });
      }
      return next;
    });
  };

  return (
    <div ref={surfaceRef} className={`flex-1 tl-themed bg-[var(--tl-bg)] text-[var(--tl-text-primary)] flex flex-col ${isMobileDevice ? 'w-full antialiased' : ''}`}>
      {isMobileDevice && (
        <TimelineMobileHeader
          onOpenMobileMenu={onOpenMobileMenu}
          sourcesCount={integratedSourcesCount}
          searchOpen={mobileSearchOpen}
          collapsed={mobileChromeCollapsed}
          onToggleSearch={toggleMobileSearch}
          onOpenSourcesSheet={(trigger) => {
            sourcesTriggerRef.current = trigger ?? null;
            setMobileChromeCollapsed(false);
            setSourcesSheetOpen(true);
          }}
        />
      )}
      {/* Keep the timeline's ancestor path stable across viewport changes. */}
      <div className={isMobileDevice ? 'contents' : 'flex-1 flex justify-center items-start p-4 sm:p-6 bg-[var(--tl-bg)]'}>
        <div className="contents">
          <div className={isMobileDevice
            ? 'w-full max-w-lg mx-auto py-2.5 space-y-3 pb-6 flex-1'
            : `w-full ${watchOpen ? 'max-w-7xl' : 'max-w-[1520px]'} py-2`}>
            <ProfileTimelineView
              active={active}
              isMobileOnly={isMobileDevice}
              onWatchOpenChange={setWatchOpen}
              mobileSearchOpen={mobileSearchOpen}
              sourcesSheetOpen={sourcesSheetOpen}
              mobileChromeCollapsed={mobileChromeCollapsed}
              sourcesTriggerRef={sourcesTriggerRef}
              onMobileSearchOpenChange={setMobileSearchOpen}
              onOpenSourcesSheet={() => {
                setMobileChromeCollapsed(false);
                setSourcesSheetOpen(true);
              }}
              onCloseSourcesSheet={() => setSourcesSheetOpen(false)}
              onMobileChromeCollapsedChange={setMobileChromeCollapsed}
              toolbarAction={active && <TimelineLocalImport inline />}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
