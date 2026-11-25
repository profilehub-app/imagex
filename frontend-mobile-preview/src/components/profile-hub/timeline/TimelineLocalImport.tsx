import React, { useId, useRef, useState } from 'react';
import { ExternalLink, FileUp, X } from 'lucide-react';
import { create } from 'zustand';
import { useAppStore } from '../../../store/useAppStore';
import {
  mergeTimelineExportPages, parseTimelineExport, TimelineExportError,
  type TimelineExportMerge,
} from '../../../services/timelineImport';
import type { TimelinePost } from './timelineModel';
import { TimelineSocialBody, TimelineSocialMetricsRow } from './TimelineSocialContent';
import { TimelinePostIdentity } from './TimelinePostIdentity';
import { resolveTimelinePlatform } from './timelineModel';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_BATCH_FILES = 5;
const MAX_SESSION_POSTS = 3000;
const VISIBLE_INCREMENT = 32;
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--tl-border)] px-3 text-xs font-semibold text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--tl-accent)] disabled:cursor-not-allowed disabled:opacity-50';
const empty: TimelineExportMerge = {creators: [], posts: [], added: 0, updated: 0, duplicates: 0, skipped: 0, completeness: 'unknown'};
const useOfflineImportSession = create<{catalog: TimelineExportMerge; published: TimelineExportMerge}>(() => ({catalog: empty, published: empty}));
export const usePublishedTimelineImports = () => useOfflineImportSession(state => state.published);
type ImportIssue = 'invalid_format' | 'too_large' | 'too_many' | 'session_full' | 'read_error' | 'unsupported_dialog';

export function TimelineLocalImport({ inline = false }: { inline?: boolean } = {}) {
  const isEn = useAppStore(state => state.settings.language === 'en-US');
  const catalog = useOfflineImportSession(state => state.catalog);
  const published = usePublishedTimelineImports();
  const titleId = useId();
  const filesId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(VISIBLE_INCREMENT);
  const [issue, setIssue] = useState<ImportIssue>();
  const [justImported, setJustImported] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  function openDialog() {
    const dialog = dialogRef.current;
    if (!dialog || typeof dialog.showModal !== 'function') { setIssue('unsupported_dialog'); return; }
    if (!dialog.open) { dialog.showModal(); setIsOpen(true); }
  }

  async function importFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.currentTarget.files || [])];
    event.currentTarget.value = '';
    if (!files.length || busyRef.current) return;
    setIssue(undefined);
    setJustImported(false);
    if (files.length > MAX_BATCH_FILES) { setIssue('too_many'); return; }
    if (files.some(file => file.size > MAX_FILE_BYTES) || files.reduce((n, f) => n + f.size, 0) > MAX_BATCH_BYTES) {
      setIssue('too_large');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const pages = [];
      // A corrupt file fails its batch without replacing earlier work.
      for (const file of files) pages.push(parseTimelineExport(await file.text()));
      const merged = mergeTimelineExportPages(useOfflineImportSession.getState().catalog, pages);
      if (merged.posts.length > MAX_SESSION_POSTS) { setIssue('session_full'); return; }
      useOfflineImportSession.setState({catalog: merged});
      setJustImported(true);
    } catch (error) {
      setIssue(error instanceof TimelineExportError ? error.code : 'read_error');
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }

  const issues: Record<ImportIssue, string> = isEn ? {
    invalid_format: 'The file is not a valid Timeline export. Earlier batches were kept.',
    too_large: 'This batch is too large. Select files of up to 4 MB, with at most 12 MB in total.',
    too_many: 'Select up to five JSON files at a time.',
    session_full: 'This session has reached the 3,000-post limit. Earlier batches were kept.',
    read_error: 'Could not read this batch. Earlier batches were kept.',
    unsupported_dialog: 'Open ImageX in a browser that supports dialogs to import files.',
  } : {
    invalid_format: 'O arquivo não é uma exportação válida da Timeline. Os lotes anteriores foram mantidos.',
    too_large: 'O lote é grande demais. Selecione arquivos de até 4 MB, com no máximo 12 MB no total.',
    too_many: 'Selecione até cinco arquivos JSON por vez.',
    session_full: 'Esta sessão atingiu o limite de 3.000 publicações. Os lotes anteriores foram mantidos.',
    read_error: 'Não foi possível ler este lote. Os lotes anteriores foram mantidos.',
    unsupported_dialog: 'Abra o ImageX em um navegador compatível com caixas de diálogo para importar arquivos.',
  };

  return <div className={inline ? 'flex items-center' : 'mx-auto mb-3 flex w-full max-w-2xl items-center justify-end px-3 sm:px-0'}>
    <button ref={openRef} type="button" onClick={openDialog} aria-haspopup="dialog" className={buttonClass} data-timeline-local-import>
      <FileUp size={15} aria-hidden />{isEn ? 'Import batch' : 'Importar lote'}
    </button>
    <span className="sr-only" role="status">{published.posts.length > 0
      ? (isEn ? 'Local imports are included for this session.' : 'Importações locais incluídas nesta sessão.')
      : ''}</span>
    {issue === 'unsupported_dialog' && <p role="alert" className="ml-2 text-xs text-[var(--tl-text-muted)]">{issues[issue]}</p>}
    <dialog ref={dialogRef} aria-labelledby={titleId}
      onClose={() => { setIsOpen(false); openRef.current?.focus(); }}
      className="tl-themed max-h-[88dvh] w-[min(42rem,calc(100%-1.5rem))] max-w-none rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-bg)] p-0 text-[var(--tl-text-primary)] shadow-2xl backdrop:bg-black/60">
      {isOpen && <div className="space-y-3 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-2">
          <div>
            <h2 id={titleId} className="text-lg font-bold">{isEn ? 'Import a local batch' : 'Importar lote local'}</h2>
            <p className="mt-1 text-sm text-[var(--tl-text-muted)]">{isEn
              ? 'Choose the Timeline JSON exports you saved. Batches are combined here for this session. They do not replace or sync your feed.'
              : 'Escolha os arquivos JSON que você exportou da Timeline. Os lotes se juntam aqui nesta sessão, sem substituir nem sincronizar seu feed.'}</p>
          </div>
          <button type="button" onClick={() => dialogRef.current?.close()} className={buttonClass}
            aria-label={isEn ? 'Close batch import' : 'Fechar importação'}><X size={16} aria-hidden /></button>
        </header>
        <div className="space-y-1">
          <label htmlFor={filesId} className="text-xs font-semibold text-[var(--tl-text-primary)]">
            {isEn ? 'Choose JSON exports' : 'Escolher exportações JSON'}
          </label>
          <input id={filesId} type="file" multiple accept=".json,application/json" onChange={event => void importFiles(event)}
            disabled={busy} className="block w-full text-xs text-[var(--tl-text-muted)] file:mr-2 file:min-h-11 file:rounded-lg file:border file:border-[var(--tl-border)] file:bg-[var(--tl-surface)] file:px-3 file:font-semibold file:text-[var(--tl-text-primary)]" />
          <p className="text-xs text-[var(--tl-text-muted)]">{isEn
            ? 'Text, links and observed counts only. No media, account session or network access.'
            : 'Apenas texto, links e contagens observadas. Não carrega mídia, não acessa sua conta nem consulta a rede.'}</p>
        </div>
        {issue && issue !== 'unsupported_dialog' && <p role="alert" className="text-sm">{issues[issue]}</p>}
        {busy && <p role="status" className="text-sm">{isEn ? 'Reading files…' : 'Lendo os arquivos…'}</p>}
        {justImported && <p role="status" className="text-sm" data-import-result>{isEn
          ? `${catalog.added} added · ${catalog.updated} updated · ${catalog.duplicates} overlaps · ${catalog.skipped} skipped`
          : `${catalog.added} adicionadas · ${catalog.updated} atualizadas · ${catalog.duplicates} repetidas · ${catalog.skipped} ignoradas`}</p>}
        {catalog.posts.length > 0 && <p className="text-sm text-[var(--tl-text-muted)]">{isEn
          ? `${catalog.posts.length} available in this session. The export does not establish complete coverage.`
          : `${catalog.posts.length} disponíveis nesta sessão. A exportação não confirma cobertura completa.`}</p>}
        {catalog.posts.length > 0 && <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} disabled={busy || catalog === published}
            onClick={() => { useOfflineImportSession.setState({published: catalog}); dialogRef.current?.close(); }}>
            {isEn ? 'Add to Timeline' : 'Adicionar à Timeline'}
          </button>
          {published.posts.length > 0 && <button type="button" className={buttonClass}
            onClick={() => useOfflineImportSession.setState({published: empty})}>
            {isEn ? 'Remove imports from Timeline' : 'Retirar importações da Timeline'}
          </button>}
        </div>}
        <div className="space-y-2.5">
          {catalog.posts.slice(0, visible).map(post =>
            <TimelineImportedPost key={post.id} post={post} isEn={isEn} />
          )}
        </div>
        {visible < catalog.posts.length &&
          <button type="button" className={buttonClass} onClick={() => setVisible(value => value + VISIBLE_INCREMENT)}>
            {isEn ? 'Show more imported posts' : 'Mostrar mais publicações importadas'}
          </button>}
      </div>}
    </dialog>
  </div>;
}


/** Local-only card: no profile, playback or loaders. Only the original link is interactive. */
export function TimelineImportedPost({post, isEn, inFeed = false, sourceLabel}: {
  post: TimelinePost; isEn: boolean; inFeed?: boolean;
  sourceLabel?: string;
}) {
  const dateLabel = post.date ? new Date(post.date).toLocaleDateString(isEn ? 'en-US' : 'pt-BR', {timeZone: 'UTC'}) : undefined;
  const metrics = <TimelineSocialMetricsRow metrics={post.metrics} isEn={isEn} />;
  const original = post.originalUrl && <a href={post.originalUrl} target="_blank" rel="noopener noreferrer"
    className="inline-flex min-h-11 items-center gap-1.5 text-xs text-[var(--tl-accent-text)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--tl-accent)]">
    <ExternalLink size={14} aria-hidden />{isEn ? 'Open original source' : 'Abrir publicação original'}
  </a>;
  return (
    <article data-import-post={!inFeed || undefined} data-timeline-imported-post={inFeed || undefined} data-timeline-post-id={inFeed ? post.id : undefined} tabIndex={inFeed ? -1 : undefined} className={inFeed ? 'tl-post' : 'space-y-2 rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-3'}>
      {inFeed ? <TimelinePostIdentity name={post.creatorName} handle={post.creatorHandle}
        platform={resolveTimelinePlatform(post.originalUrl, post.source)} sourceLabel={sourceLabel}
        dateLabel={dateLabel} dateTime={post.date || undefined} />
        : <div className="flex flex-wrap items-center gap-x-2 text-xs [overflow-wrap:anywhere]">
        <span className="font-bold">{post.creatorName}</span>
        {post.creatorHandle && <span className="text-[var(--tl-text-muted)]">{post.creatorHandle}</span>}
        {dateLabel && <time className="text-[var(--tl-text-muted)]" dateTime={post.date}>{dateLabel}</time>}
      </div>}
      <TimelineSocialBody text={post.text} relation={post.relation} isEn={isEn} onOpenReferencedMedia={() => {}} />
      {inFeed ? <div className="tl-post-footer">
        <div className="space-y-1">
          <p className="text-xs text-[var(--tl-text-secondary)]">{isEn ? 'Imported locally' : 'Importado localmente'}</p>
          {metrics}
        </div>
        {original}
      </div> : <>{metrics}{original}</>}
    </article>
  );
}
