import React, {useEffect, useRef, useState} from 'react';
import {Send, X} from 'lucide-react';
import {resolveTimelinePlatform, TimelinePost} from './timelineModel';
import {getSourceCapabilities} from './timelineSourceCapabilities';
import {timelineCommentsSourceUrl} from '../../../services/profileHubComments';
import {useAppStore} from '../../../store/useAppStore';
import {useProfileTimelineStore} from '../../../store/useProfileTimelineStore';
import {AppDialog} from '../../common/AppDialog';
import {SourceComments} from './SourceComments';

interface CommentsBottomSheetProps {post: TimelinePost | null; isOpen: boolean; onClose: () => void;}
export const CommentsBottomSheet: React.FC<CommentsBottomSheetProps> = ({post, isOpen, onClose}) => {
  const isEn = useAppStore(state => state.settings.language === 'en-US');
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [reported, setReported] = useState<{source:string; total:number|null} | null>(null);
  const [draft, setDraft] = useState('');
  const userComments = useProfileTimelineStore(state => (post ? state.userComments[post.id] || [] : []));
  const addComment = useProfileTimelineStore(state => state.addComment);

  useEffect(() => {
    setReported(null);
    setDraft('');
  }, [isOpen, post?.id]);

  if (!isOpen || !post) return null;
  const postPlatform = resolveTimelinePlatform(post.originalUrl, post.source);
  const postCaps = getSourceCapabilities(postPlatform, post);
  if (!postCaps.supportsComments) return null;
  const sourceUrl = timelineCommentsSourceUrl(post);
  const displayTotal =
    reported?.source === sourceUrl && reported.total != null
      ? reported.total + userComments.length
      : post.metrics?.replies != null
        ? post.metrics.replies + userComments.length
        : userComments.length > 0
          ? userComments.length
          : '—';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    addComment(post.id, draft);
    setDraft('');
  };

  return <AppDialog titleId="timeline-comments-title" descriptionId="timeline-comments-source-description" initialFocusRef={closeRef} onClose={onClose} className="tl-themed fixed inset-0 m-0 h-[100dvh] w-screen max-h-none max-w-none border-0 bg-transparent p-0 text-[var(--tl-text-primary)]">
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm overscroll-contain" onClick={onClose}>
      <div className="w-full sm:max-w-lg bg-[var(--tl-surface)] border-t sm:border border-[var(--tl-border-strong)] rounded-t-3xl sm:rounded-2xl max-h-[85vh] sm:max-h-[80vh] flex flex-col shadow-2xl overflow-hidden" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--tl-border)]"><div className="flex items-center gap-2"><h3 id="timeline-comments-title" className="text-sm font-bold text-[var(--tl-text-primary)]">{isEn ? 'Comments' : 'Comentários'}</h3><span data-source-comment-count className="px-2 py-0.5 rounded-full bg-[var(--tl-accent-soft)] text-[var(--tl-accent-text)] text-xs font-mono font-bold">{displayTotal}</span></div><button ref={closeRef} type="button" onClick={onClose} aria-label={isEn ? 'Close' : 'Fechar'} className="p-2 rounded-full text-[var(--tl-text-muted)] hover:text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)]"><X className="w-4 h-4"/></button></div>
        <div className="overflow-y-auto p-4 space-y-4">
          {post.text && (
            <div className="rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <strong className="font-bold text-[var(--tl-text-primary)]">{post.creatorName}</strong>
                <span className="text-[var(--tl-text-muted)]">{post.creatorHandle}</span>
              </div>
              <p className="text-xs leading-relaxed text-[var(--tl-text-secondary)] whitespace-pre-wrap break-words">{post.text}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder={isEn ? 'Add a comment or note…' : 'Adicionar comentário ou nota…'}
              aria-label={isEn ? 'Add a comment' : 'Adicionar comentário'}
              className="flex-1 min-w-0 rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3 py-2 text-xs text-[var(--tl-text-primary)] placeholder:text-[var(--tl-text-muted)] focus:outline-none focus:border-[var(--tl-accent-hover)]"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--tl-accent)] px-3 py-2 text-xs font-bold text-white hover:bg-[var(--tl-accent-hover)] disabled:opacity-40"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isEn ? 'Post' : 'Publicar'}</span>
            </button>
          </form>

          {userComments.length > 0 && (
            <div className="space-y-2">
              {userComments.map((c, idx) => (
                <div key={idx} className="rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] p-3 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <strong className="font-bold text-[var(--tl-accent-text-strong)]">{c.author}</strong>
                    <span className="text-[11px] text-[var(--tl-text-muted)]">{c.time}</span>
                  </div>
                  <p className="text-xs text-[var(--tl-text-primary)] whitespace-pre-wrap break-words">{c.text}</p>
                </div>
              ))}
            </div>
          )}

          {sourceUrl ? <SourceComments key={sourceUrl} sourceUrl={sourceUrl} showHeading={false} descriptionId="timeline-comments-source-description" onReportedTotal={total => setReported({source:sourceUrl, total})}/> : <p id="timeline-comments-source-description" className="text-xs text-[var(--tl-text-muted)]">{isEn ? 'The original URL is unavailable for this post.' : 'A URL original deste post não está disponível.'}</p>}
        </div>
      </div>
    </div>
  </AppDialog>;
};
