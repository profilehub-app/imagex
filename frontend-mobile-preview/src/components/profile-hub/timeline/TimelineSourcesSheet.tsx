import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ClipboardPaste, Download, Layers, Plus, RotateCcw, Search, Trash2, Upload, Users, X, AlertCircle } from 'lucide-react';
import { ModalPortal } from '../../common/ModalPortal';
import {
  PLAYER_OVERLAY_LAYER_ATTR,
  PLAYER_OVERLAY_PRIORITY,
  registerPlayerOverlayLayer,
} from '../../video-player/engine/playerOverlayStack';
import { closeWithExitTransition, isReducedMotionPreferred } from '../../video-player/engine/playerMotion';
import { useAppStore } from '../../../store/useAppStore';
import { translations } from '../../../i18n/translations';
import { renderSourceIcon } from './TimelineSourceBar';
import { getTimelineSourceDisplayName } from './timelineSourceNavigation';
import {
  computeBottomSheetDismiss,
  type IntegratedSourceRecord,
  type IntegrateUrlResult,
} from './timelineOptIn';

export interface SheetCreatorEntry {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  profileUrl: string;
  site: string;
  postCount: number;
}

export interface TimelineSourcesSheetBodyProps {
  isEn: boolean;
  activeSource: string;
  integratedSources: readonly IntegratedSourceRecord[];
  creatorEntries: readonly SheetCreatorEntry[];
  creatorSearch: string;
  integrating: boolean;
  lastIntegrationResult: IntegrateUrlResult | null;
  postCountBySource?: Record<string, number>;
  creatorCountBySource?: Record<string, number>;
  onCreatorSearchChange: (value: string) => void;
  onSelectSource: (sourceId: string) => void;
  onSelectCreator: (creatorId: string) => void;
  onIntegrateUrl: (rawUrl: string) => Promise<void> | void;
  onRemoveSource: (sourceId: string) => Promise<void> | void;
  onResetSources: () => Promise<void> | void;
  inputRef?: React.RefObject<HTMLInputElement>;
}

export const TimelineSourcesSheetBody: React.FC<TimelineSourcesSheetBodyProps> = ({
  isEn,
  activeSource,
  integratedSources,
  creatorEntries,
  creatorSearch,
  integrating,
  lastIntegrationResult,
  postCountBySource = {},
  creatorCountBySource = {},
  onCreatorSearchChange,
  onSelectSource,
  onSelectCreator,
  onIntegrateUrl,
  onRemoveSource,
  onResetSources,
  inputRef,
}) => {
  const [urlDraft, setUrlDraft] = useState('');
  const [touchedInvalid, setTouchedInvalid] = useState(false);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);
  const [bundleStatus, setBundleStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const tBrowse = (translations[isEn ? 'en-US' : 'pt-BR'] as any).timelineBrowse || {};

  const handleImportConnectors = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBundleStatus(null);
    try {
      const text = await file.text();
      const resp = await fetch('/api/profile-hub/timeline/connectors/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      if (!resp.ok) throw new Error('import_failed');
      setBundleStatus({
        ok: true,
        text: tBrowse.connectorsImportOk || (isEn ? 'Local connectors imported successfully.' : 'Conectores locais importados com sucesso.'),
      });
    } catch {
      setBundleStatus({
        ok: false,
        text: tBrowse.connectorsImportErr || (isEn ? 'Invalid connectors JSON file.' : 'Arquivo JSON de conectores inválido.'),
      });
    }
  };

  const handleExportConnectors = async () => {
    setBundleStatus(null);
    try {
      const resp = await fetch('/api/profile-hub/timeline/connectors/export');
      if (!resp.ok) throw new Error('export_failed');
      const data = await resp.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'connectors.local.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setBundleStatus({
        ok: false,
        text: tBrowse.connectorsImportErr || (isEn ? 'Could not export connectors.' : 'Não foi possível exportar os conectores.'),
      });
    }
  };

  const handlePaste = async () => {
    setClipboardHint(null);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        const clip = (await navigator.clipboard.readText()).trim();
        if (clip) {
          setUrlDraft(clip);
          setTouchedInvalid(false);
          return;
        }
      } catch {
        // Fallback below when clipboard access is denied
      }
    }
    setClipboardHint(tBrowse.pasteClipboardHint || (isEn ? 'Paste directly in the input field.' : 'Cole diretamente no campo acima.'));
  };

  const submitUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      setTouchedInvalid(true);
      return;
    }
    setTouchedInvalid(false);
    setClipboardHint(null);
    await onIntegrateUrl(trimmed);
  };

  const renderFeedback = () => {
    if (touchedInvalid) {
      return (
        <p role="status" className="tl-live-enter flex items-center gap-1.5 text-xs text-rose-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{tBrowse.integrationInvalidUrl || (isEn ? 'Enter a valid URL.' : 'Informe uma URL válida.')}</span>
        </p>
      );
    }
    if (clipboardHint) {
      return (
        <p role="status" className="text-xs text-[var(--tl-text-muted)]">
          {clipboardHint}
        </p>
      );
    }
    if (!lastIntegrationResult) return null;
    if (lastIntegrationResult.ok && lastIntegrationResult.integration) {
      const msg = lastIntegrationResult.integration.autoDiscovered
        ? (tBrowse.integrationAutoDiscovered || (isEn ? 'Source auto-discovered and saved locally.' : 'Fonte detectada automaticamente e salva localmente.'))
        : lastIntegrationResult.integration.level === 'profile'
          ? tBrowse.integrationMatchedProfile
          : tBrowse.integrationMatchedNetwork;
      return (
        <p role="status" className="tl-integrated-pulse flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" aria-hidden="true" />
          <span>{msg}</span>
        </p>
      );
    }
    const msg =
      lastIntegrationResult.reason === 'unreachable_origin'
        ? (tBrowse.integrationUnreachable || (isEn ? 'Could not reach this address right now.' : 'Não foi possível acessar este endereço no momento.'))
        : lastIntegrationResult.reason === 'https_required'
          ? (tBrowse.integrationHttpsRequired || (isEn ? 'Use a public https:// URL for automatic discovery.' : 'Use um link público com https:// para descoberta automática.'))
          : lastIntegrationResult.reason === 'unsupported_domain'
            ? tBrowse.integrationUnsupported
            : tBrowse.integrationInvalidUrl;
    return (
      <p role="status" className="tl-live-enter flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
        <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" aria-hidden="true" />
        <span>{msg}</span>
      </p>
    );
  };

  const filterNorm = creatorSearch.trim().toLowerCase();
  const filteredCreators = filterNorm
    ? creatorEntries.filter(
        c =>
          c.name.toLowerCase().includes(filterNorm) ||
          c.handle.toLowerCase().includes(filterNorm) ||
          c.site.toLowerCase().includes(filterNorm)
      )
    : creatorEntries;

  return (
    <div className="space-y-4">
      <form onSubmit={submitUrl} className="space-y-2.5" noValidate>
        <div className="flex items-stretch gap-2">
          <input
            ref={inputRef}
            type="url"
            inputMode="url"
            enterKeyHint="go"
            data-optin-url-input="true"
            value={urlDraft}
            onChange={(e) => {
              setUrlDraft(e.target.value);
              if (touchedInvalid) setTouchedInvalid(false);
            }}
            placeholder={tBrowse.pasteUrlPlaceholder}
            aria-label={tBrowse.pasteUrlPlaceholder || (isEn ? 'Source or creator URL' : 'Link da fonte ou criador')}
            className="tl-focus-ring flex-1 min-w-0 min-h-[44px] rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3 text-[16px] sm:text-sm text-[var(--tl-text-primary)] placeholder:text-[var(--tl-text-muted)] focus:outline-none focus:border-[var(--tl-accent-hover)]"
          />
          <button
            type="button"
            onClick={handlePaste}
            className="tl-pressable min-w-[44px] min-h-[44px] px-2.5 rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] text-xs font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] inline-flex items-center justify-center gap-1 shrink-0"
            aria-label={tBrowse.pasteClipboardBtn || (isEn ? 'Paste' : 'Colar')}
            title={tBrowse.pasteClipboardBtn || (isEn ? 'Paste' : 'Colar')}
          >
            <ClipboardPaste className="w-4 h-4 shrink-0" aria-hidden="true" />
          </button>
          <button
            type="submit"
            disabled={integrating}
            data-optin-submit="true"
            className="tl-pressable min-w-[44px] min-h-[44px] px-3.5 rounded-xl bg-[var(--tl-accent)] text-[var(--tl-accent-contrast)] text-xs font-bold inline-flex items-center justify-center gap-1.5 hover:bg-[var(--tl-accent-hover)] disabled:opacity-60 shrink-0"
          >
            <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{integrating ? (tBrowse.integratingBtn || (isEn ? 'Integrating...' : 'Integrando...')) : (tBrowse.integrateBtn || (isEn ? 'Integrate' : 'Integrar'))}</span>
          </button>
        </div>
        {renderFeedback()}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void handleImportConnectors(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="tl-pressable min-h-[44px] px-3 rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] text-xs font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] inline-flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{tBrowse.importConnectorsBtn || (isEn ? 'Import JSON' : 'Importar JSON')}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleExportConnectors()}
            className="tl-pressable min-h-[44px] px-3 rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] text-xs font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{tBrowse.exportConnectorsBtn || (isEn ? 'Export JSON' : 'Exportar JSON')}</span>
          </button>
        </div>
        {bundleStatus && (
          <p
            role="status"
            className={`text-xs rounded-xl border px-3 py-2 ${
              bundleStatus.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
            }`}
          >
            {bundleStatus.text}
          </p>
        )}
      </form>

      <section className="space-y-2 pt-2 border-t border-[var(--tl-border)]">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--tl-text-muted)]">
            <Layers className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{tBrowse.integratedNetworksTitle || (isEn ? 'Integrated Networks' : 'Redes Integradas')}</span>
            <span className="px-1.5 py-0.5 rounded-full bg-[var(--tl-accent-soft)] text-[var(--tl-accent-text)] font-mono">
              {integratedSources.length}
            </span>
          </h4>
          {integratedSources.length > 0 && (
            <button
              type="button"
              onClick={() => void onResetSources()}
              className="tl-pressable min-h-[44px] px-2.5 rounded-lg text-xs font-semibold text-[var(--tl-text-muted)] hover:text-rose-400 inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{tBrowse.resetSourcesBtn || (isEn ? 'Clear all' : 'Limpar todas')}</span>
            </button>
          )}
        </div>

        {integratedSources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] p-3.5 text-center space-y-1">
            <p className="text-xs font-semibold text-[var(--tl-text-primary)]">
              {tBrowse.integratedNetworksEmpty || (isEn ? 'No networks integrated yet.' : 'Nenhuma rede integrada ainda.')}
            </p>
            <p className="text-xs text-[var(--tl-text-muted)]">
              {tBrowse.integratedZeroHint || (isEn ? 'Adapters are ready in code, but nothing preloads automatically.' : 'Os adaptadores estão no app, mas nada pré-carrega sem você colar um link.')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {integratedSources.map((src) => {
              const sid = src.id.toLowerCase();
              const isSelected = activeSource === sid;
              const isNewlyAdded = lastIntegrationResult?.ok && lastIntegrationResult.integration?.sourceId === sid;
              const label = src.displayName || getTimelineSourceDisplayName(sid, isEn ? 'en' : 'pt');
              const cCount = creatorCountBySource[sid] || 0;
              const pCount = postCountBySource[sid] || 0;
              const removeLabel = String(tBrowse.removeSourceLabel || (isEn ? 'Remove source {name}' : 'Remover fonte {name}')).replace('{name}', label);

              return (
                <div
                  key={sid}
                  data-integrated-row={sid}
                  className={`tl-live-enter flex items-center gap-2 p-1.5 rounded-xl border transition-colors ${
                    isNewlyAdded
                      ? 'tl-integrated-pulse border-emerald-500/45 bg-emerald-500/10'
                      : isSelected
                        ? 'border-[var(--tl-accent-border)] bg-[var(--tl-accent-soft)]'
                        : 'border-[var(--tl-border)] bg-[var(--tl-surface-elevated)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectSource(isSelected ? 'all' : sid)}
                    className="tl-pressable flex-1 min-w-0 min-h-[44px] px-2 rounded-lg flex items-center gap-2.5 text-left"
                  >
                    <span className="tl-context-platform-icon shrink-0" data-platform={sid}>
                      {renderSourceIcon(sid, 15)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <strong className="block text-xs font-bold text-[var(--tl-text-primary)] truncate">{label}</strong>
                      <small className="block text-[11px] text-[var(--tl-text-muted)] truncate">
                        {cCount} {cCount === 1 ? (isEn ? 'profile' : 'perfil') : (isEn ? 'profiles' : 'perfis')} · {pCount} {isEn ? 'items' : 'itens'}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    data-remove-integrated={sid}
                    onClick={() => void onRemoveSource(sid)}
                    aria-label={removeLabel}
                    title={removeLabel}
                    className="tl-pressable min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-[var(--tl-text-muted)] hover:text-rose-400 hover:bg-rose-500/10 shrink-0"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2 pt-2 border-t border-[var(--tl-border)]">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--tl-text-muted)]">
            <Users className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{tBrowse.savedCreatorsTitle || (isEn ? 'Saved Creators' : 'Criadores Salvos')}</span>
            <span className="px-1.5 py-0.5 rounded-full bg-[var(--tl-surface-elevated)] text-[var(--tl-text-secondary)] font-mono">
              {creatorEntries.length}
            </span>
          </h4>
        </div>

        {creatorEntries.length > 0 && (
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--tl-text-muted)] pointer-events-none" aria-hidden="true" />
            <input
              type="search"
              value={creatorSearch}
              onChange={(e) => onCreatorSearchChange(e.target.value)}
              placeholder={tBrowse.savedCreatorsFilterPlaceholder || (isEn ? 'Filter creators...' : 'Filtrar criadores...')}
              aria-label={tBrowse.savedCreatorsFilterPlaceholder || (isEn ? 'Filter creators' : 'Filtrar criadores')}
              className="tl-focus-ring w-full min-h-[44px] rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] pl-9 pr-3 text-[16px] sm:text-xs text-[var(--tl-text-primary)] placeholder:text-[var(--tl-text-muted)] focus:outline-none focus:border-[var(--tl-accent-hover)]"
            />
          </div>
        )}

        {filteredCreators.length === 0 ? (
          <p className="text-xs text-[var(--tl-text-muted)] py-1">
            {tBrowse.savedCreatorsEmpty || (isEn ? 'No saved creators yet.' : 'Nenhum criador salvo ainda.')}
          </p>
        ) : (
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
            {filteredCreators.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectCreator(c.id)}
                className="tl-pressable w-full min-h-[44px] px-2.5 py-1.5 rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] hover:bg-[var(--tl-surface-hover)] flex items-center gap-2.5 text-left"
              >
                {c.avatar ? (
                  <img src={c.avatar} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                ) : (
                  <span className="w-8 h-8 rounded-full bg-[var(--tl-accent-soft)] text-[var(--tl-accent-text-strong)] flex items-center justify-center text-xs font-bold shrink-0">
                    {(c.name[0] || '@').toUpperCase()}
                  </span>
                )}
                <span className="flex-1 min-w-0">
                  <strong className="block text-xs font-bold text-[var(--tl-text-primary)] truncate">{c.name}</strong>
                  <small className="block text-[11px] text-[var(--tl-text-muted)] truncate">
                    {c.handle} · {getTimelineSourceDisplayName(c.site, isEn ? 'en' : 'pt')}
                  </small>
                </span>
                <span className="text-xs font-mono text-[var(--tl-text-muted)] shrink-0">{c.postCount}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export interface TimelineSourcesSheetProps extends Omit<TimelineSourcesSheetBodyProps, 'isEn' | 'inputRef'> {
  open: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export const TimelineSourcesSheet: React.FC<TimelineSourcesSheetProps> = ({
  open,
  onClose,
  triggerRef,
  ...bodyProps
}) => {
  const isEn = useAppStore(state => state.settings?.language === 'en-US');
  const disableAllAnimations = useAppStore(state => Boolean(state.settings?.disableAllAnimations));
  const tBrowse = (translations[isEn ? 'en-US' : 'pt-BR'] as any).timelineBrowse || {};

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const sheetPanelRef = useRef<HTMLDivElement | null>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [rendered, setRendered] = useState(open);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const swipeRef = useRef<{ startY: number; startTime: number } | null>(null);

  const requestDismiss = () => {
    const target = sheetPanelRef.current || dialogRef.current;
    void closeWithExitTransition(
      target,
      undefined,
      () => {
        setDragY(0);
        setRendered(false);
        onClose();
      },
      {
        disableAllAnimations,
        prefersReducedMotion: isReducedMotionPreferred(),
        timeoutMs: 280,
      }
    );
  };

  useEffect(() => {
    if (open) {
      setRendered(true);
      setDragY(0);
      return;
    }
    setRendered(false);
  }, [open]);

  useEffect(() => {
    if (!rendered || !open) return;
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Ignore if already open
      }
    }
    const raf = window.requestAnimationFrame(() => {
      urlInputRef.current?.focus({ preventScroll: true });
    });
    const unregister = registerPlayerOverlayLayer({
      id: 'timeline-sources-bottom-sheet',
      priority: PLAYER_OVERLAY_PRIORITY.BOTTOM_SHEET,
      dialogElement: dialog,
      triggerElement: triggerRef?.current ?? null,
      onDismiss: requestDismiss,
    });
    return () => {
      window.cancelAnimationFrame(raf);
      unregister();
      if (dialog?.open) {
        try {
          dialog.close();
        } catch {
          // Ignore close cleanup race
        }
      }
    };
  }, [rendered, open]);

  if (!rendered && !open) return null;

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    if (!touch) return;
    if ((scrollBodyRef.current?.scrollTop ?? 0) > 0) return;
    swipeRef.current = { startY: touch.clientY, startTime: performance.now() };
    setIsDragging(true);
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!swipeRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dy = Math.max(0, touch.clientY - swipeRef.current.startY);
    const check = computeBottomSheetDismiss(dy, 0, scrollBodyRef.current?.scrollTop ?? 0);
    setDragY(check.activeDragY);
  };

  const onTouchEnd = () => {
    if (!swipeRef.current) return;
    const elapsed = Math.max(1, performance.now() - swipeRef.current.startTime);
    const velocity = dragY / elapsed;
    const check = computeBottomSheetDismiss(dragY, velocity, scrollBodyRef.current?.scrollTop ?? 0);
    swipeRef.current = null;
    setIsDragging(false);
    if (check.shouldDismiss) {
      requestDismiss();
    } else {
      setDragY(0);
    }
  };

  return (
    <ModalPortal>
      <dialog
        ref={dialogRef}
        {...{ [PLAYER_OVERLAY_LAYER_ATTR]: 'true' }}
        aria-labelledby="timeline-sources-sheet-title"
        onCancel={(e) => {
          e.preventDefault();
          requestDismiss();
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) {
            requestDismiss();
          }
        }}
        className="tl-themed tl-bottom-sheet-dialog fixed inset-0 m-0 h-[100dvh] w-screen max-h-none max-w-none border-0 bg-black/65 backdrop-blur-sm p-0 flex flex-col justify-end sm:items-center sm:justify-center overscroll-contain z-50"
      >
        <div
          ref={sheetPanelRef}
          data-disable-animations={disableAllAnimations ? 'true' : undefined}
          style={{
            transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
            transition: isDragging || disableAllAnimations ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          className="tl-bottom-sheet-panel w-full sm:max-w-lg bg-[var(--tl-surface)] border-t sm:border border-[var(--tl-border-strong)] rounded-t-3xl sm:rounded-2xl max-h-[86dvh] flex flex-col shadow-2xl overflow-hidden pb-safe"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
            style={{ touchAction: 'none' }}
            className="pt-2.5 pb-3 px-4 border-b border-[var(--tl-border)] select-none shrink-0"
          >
            <div className="w-10 h-1.5 rounded-full bg-[var(--tl-border-strong)] mx-auto mb-2.5" aria-hidden="true" />
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 id="timeline-sources-sheet-title" className="text-sm font-bold text-[var(--tl-text-primary)] truncate">
                  {tBrowse.sourcesSheetTitle || (isEn ? 'Integrated Networks & Creators' : 'Redes Integradas & Criadores')}
                </h3>
                <p className="text-xs text-[var(--tl-text-muted)]">
                  {tBrowse.sourcesSheetSubtitle || (isEn ? 'Paste a network or creator URL' : 'Cole o link da rede ou perfil')}
                </p>
              </div>
              <button
                type="button"
                onClick={requestDismiss}
                aria-label={isEn ? 'Close' : 'Fechar'}
                className="tl-pressable min-w-[44px] min-h-[44px] rounded-full border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] text-[var(--tl-text-muted)] hover:text-[var(--tl-text-primary)] flex items-center justify-center shrink-0"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div
            ref={scrollBodyRef}
            className="flex-1 overflow-y-auto p-4 overscroll-contain"
          >
            <TimelineSourcesSheetBody
              {...bodyProps}
              isEn={isEn}
              inputRef={urlInputRef}
              onSelectSource={(sid) => {
                bodyProps.onSelectSource(sid);
                requestDismiss();
              }}
              onSelectCreator={(cid) => {
                bodyProps.onSelectCreator(cid);
                requestDismiss();
              }}
            />
          </div>
        </div>
      </dialog>
    </ModalPortal>
  );
};
