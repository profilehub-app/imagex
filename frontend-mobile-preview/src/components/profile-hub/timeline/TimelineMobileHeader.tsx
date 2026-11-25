import React from 'react';
import { Bell, Layers, Search, X } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import { updateNeedsAttention } from '../../../services/updateAlerts';
import { translations } from '../../../i18n/translations';
import { ImagexAppMark } from './ImagexAppMark';

export interface TimelineMobileHeaderProps {
  onOpenMobileMenu?: () => void;
  sourcesCount?: number;
  searchOpen?: boolean;
  collapsed?: boolean;
  onToggleSearch?: () => void;
  onOpenSourcesSheet?: (trigger?: HTMLElement | null) => void;
}

export const TimelineMobileHeader: React.FC<TimelineMobileHeaderProps> = ({
  onOpenMobileMenu,
  sourcesCount,
  searchOpen = false,
  collapsed = false,
  onToggleSearch,
  onOpenSourcesSheet,
}) => {
  const isEn = useAppStore(state => state.settings?.language === 'en-US');
  const updateAttention = useAppStore(state => updateNeedsAttention(state.updateInfo, state.dismissedUpdateVersion));
  const setNotificationDrawerOpen = useAppStore(state => state.setNotificationDrawerOpen);
  const unreadCount = useAppStore(state => state.notifications.filter(notification => !notification.isRead).length);
  const searchQuery = useProfileTimelineStore(state => state.searchQuery);
  const setSearchQuery = useProfileTimelineStore(state => state.setSearchQuery);
  const selectedCreatorId = useProfileTimelineStore(state => state.selectedCreatorId);
  const setSelectedCreatorId = useProfileTimelineStore(state => state.setSelectedCreatorId);
  const storeSourcesCount = useProfileTimelineStore(state => state.integratedSources.length);
  const effectiveCount = typeof sourcesCount === 'number' ? sourcesCount : storeSourcesCount;
  const tBrowse = (translations[isEn ? 'en-US' : 'pt-BR'] as any).timelineBrowse || {};

  const handleSearchAction = () => {
    if (onToggleSearch) {
      onToggleSearch();
      return;
    }
    if (searchQuery.trim().length > 0 && !selectedCreatorId) {
      setSearchQuery('');
      return;
    }
    if (selectedCreatorId) {
      setSelectedCreatorId(null);
    }
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[data-omni-search-input="true"]');
        if (input) {
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          input.focus();
        }
      });
    }
  };

  const sourcesBtnText = String(tBrowse.sourcesButtonLabel || (isEn ? 'Sources ({count})' : 'Fontes ({count})'))
    .replace('{count}', String(effectiveCount));

  return (
    <header
      data-timeline-toolbar="mobile"
      data-collapsed={collapsed ? 'true' : undefined}
      style={{ top: 'var(--timeline-parent-toolbar-top, 0px)' }}
      className={`tl-mobile-header sticky top-0 z-40 bg-[var(--tl-surface-glass)] backdrop-blur-xl px-2.5 min-[375px]:px-3.5 shrink-0 ${
        collapsed
          ? 'tl-mobile-header--collapsed py-0 h-0 min-h-0 border-b-0 overflow-hidden pointer-events-none'
          : 'py-1.5 border-b border-[var(--tl-border)]'
      }`}
    >
      <div className="flex items-center justify-between gap-1 min-[375px]:gap-2 min-w-0">
        <button
          type="button"
          onClick={() => onOpenMobileMenu?.()}
          className="tl-pressable relative flex items-center gap-1.5 min-[375px]:gap-2 min-h-[44px] px-0.5 rounded-xl min-w-0 cursor-pointer group focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tl-accent-hover)] shrink-0"
          title={isEn ? 'Open navigation menu' : 'Abrir menu de navegação'}
          aria-label={
            isEn
              ? `Open navigation menu · Profile Hub${updateAttention ? ': update available' : ''}`
              : `Abrir menu de navegação · Profile Hub${updateAttention ? ': atualização disponível' : ''}`
          }
        >
          <span className="w-[26px] h-[26px] min-[375px]:w-7 min-[375px]:h-7 rounded-lg overflow-hidden shrink-0 shadow-md flex items-center justify-center group-hover:scale-105 transition-transform">
            <ImagexAppMark size={28} className="w-full h-full" />
          </span>
          {updateAttention && (
            <span
              aria-hidden="true"
              className="absolute top-1.5 left-5 min-[375px]:left-6 w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-[var(--tl-surface)]"
            />
          )}
          <span className="font-extrabold text-[13px] min-[375px]:text-sm text-[var(--tl-text-primary)] tracking-tight whitespace-nowrap">
            {tBrowse.profileHubTitle || 'Profile Hub'}
          </span>
        </button>

        <div className="flex items-center gap-1 min-[375px]:gap-1.5 shrink-0">
          <button
            type="button"
            data-mobile-search-toggle="true"
            aria-expanded={searchOpen}
            onClick={handleSearchAction}
            aria-label={
              searchQuery.trim() && !onToggleSearch
                ? (isEn ? 'Clear search' : 'Limpar busca')
                : (tBrowse.searchToggleLabel || (isEn ? 'Toggle search' : 'Alternar busca'))
            }
            title={
              searchQuery.trim() && !onToggleSearch
                ? (isEn ? 'Clear search' : 'Limpar busca')
                : (tBrowse.searchToggleLabel || (isEn ? 'Toggle search' : 'Alternar busca'))
            }
            className={`tl-pressable min-w-[44px] min-h-[44px] rounded-full border flex items-center justify-center transition-colors ${
              searchOpen
                ? 'bg-[var(--tl-accent-soft)] border-[var(--tl-accent-border)] text-[var(--tl-accent-text-strong)]'
                : 'bg-[var(--tl-surface-elevated)] border-[var(--tl-border)] text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)]'
            }`}
          >
            {searchOpen || (searchQuery.trim() && !onToggleSearch) ? <X className="w-4 h-4" /> : <Search className="w-4 h-4" />}
          </button>

          <button
            type="button"
            data-open-sources-sheet="true"
            onClick={(e) => onOpenSourcesSheet?.(e.currentTarget)}
            className="tl-pressable min-h-[44px] px-2.5 min-[375px]:px-3 rounded-full bg-[var(--tl-accent)] text-[var(--tl-accent-contrast)] text-[11px] min-[375px]:text-xs font-bold inline-flex items-center gap-1 min-[375px]:gap-1.5 whitespace-nowrap shadow-sm hover:bg-[var(--tl-accent-hover)]"
            aria-label={sourcesBtnText}
            title={sourcesBtnText}
          >
            <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{sourcesBtnText}</span>
          </button>

          <button
            type="button"
            onClick={() => setNotificationDrawerOpen(true)}
            className="tl-pressable min-w-[44px] min-h-[44px] rounded-full bg-[var(--tl-surface-elevated)] border border-[var(--tl-border)] flex items-center justify-center text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)] transition-colors relative"
            title={isEn ? 'Notifications' : 'Notificações'}
            aria-label={isEn ? `Notifications (${unreadCount} unread)` : `Notificações (${unreadCount} não lidas)`}
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--tl-accent)] ring-2 ring-[var(--tl-surface)]" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
