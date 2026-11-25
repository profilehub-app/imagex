import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  Check,
  ExternalLink,
  Loader2,
  Share2,
} from 'lucide-react';
import {
  TimelineCreator,
  TimelineEntityRef,
  TimelinePhotoItem,
  TimelinePost,
  doesPostMatchCreator,
  resolveTimelinePlatform,
} from './timelineModel';
import { getDynamicSourceLabel, getSourceCapabilities } from './timelineSourceCapabilities';
import { getTimelineSourceDisplayName } from './timelineSourceNavigation';
import {
  CategoryShowcaseCard,
  EditorialGalleryCard,
  ForumThreadRow,
} from './AdaptiveSourceCards';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import {
  profileShortcutIdentity,
  useProfileDirectoryLibraryStore,
} from '../../../store/useProfileDirectoryLibraryStore';
import { useAppStore } from '../../../store/useAppStore';

export interface CatalogEntityViewProps {
  creator: TimelineCreator;
  posts: TimelinePost[];
  isEn: boolean;
  isLoadingMore?: boolean;
  onBack: () => void;
  onOpenGallery: (post: TimelinePost) => void;
  onOpenThread: (post: TimelinePost) => void;
  onOpenEntity: (entity: TimelineEntityRef) => void;
  onOpenLightbox: (
    images: string[],
    index: number,
    title?: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedPhotoCount?: number
  ) => void;
  onLoadMore?: () => void;
}

/**
 * Dedicated in-app Hub View for Visual Catalog Categories, Tags, Artists, Channels,
 * and Forum Subforums/Uploaders.
 * Avoids recycling the generic video-creator profile page (no fake `@category` handles,
 * no "Follow Creator" on categories, and no duplicate Timeline / Photos tabs).
 */
export const CatalogEntityView: React.FC<CatalogEntityViewProps> = ({
  creator,
  posts,
  isEn,
  isLoadingMore = false,
  onBack,
  onOpenGallery,
  onOpenThread,
  onOpenEntity,
  onOpenLightbox,
  onLoadMore,
}) => {
  const addNotification = useAppStore((s) => s.addNotification);
  const toggleFollowCreator = useProfileTimelineStore((s) => s.toggleFollowCreator);
  const favorites = useProfileDirectoryLibraryStore((s) => s.favorites);

  const site = resolveTimelinePlatform(creator.profileUrl, creator.site) || '';
  const caps = getSourceCapabilities(site);
  const sourceLabel = getTimelineSourceDisplayName(site || 'generic', isEn ? 'en' : 'pt') || getDynamicSourceLabel(site);
  const entityKind = creator.entityKind || (caps.archetype === 'forum_board' ? 'subforum' : 'artist');
  const isTopicHub = entityKind === 'category' || entityKind === 'tag';
  const isForumEntity = caps.archetype === 'forum_board' || entityKind === 'subforum';

  const creatorIdentity = profileShortcutIdentity(creator.profileUrl);
  const isSaved = Boolean(
    creatorIdentity &&
    favorites.some((item) => item.kind === 'profile' && profileShortcutIdentity(item.url) === creatorIdentity)
  );

  const entityPosts = useMemo(
    () => posts.filter((p) => doesPostMatchCreator(p, creator)),
    [posts, creator]
  );

  const gifPosts = useMemo(
    () => entityPosts.filter((p) => p.type === 'gif' || p.mediaType === 'gif'),
    [entityPosts]
  );

  const [activeSubTab, setActiveSubTab] = useState<'all' | 'albums' | 'videos' | 'gifs' | 'packs'>('all');
  const [visibleCount, setVisibleCount] = useState(32);

  const filteredPosts = useMemo(() => {
    if (isForumEntity) {
      if (activeSubTab === 'albums') return entityPosts.filter((p) => (p.threadKind || 'inline_album') === 'inline_album');
      if (activeSubTab === 'videos') return entityPosts.filter((p) => p.threadKind === 'video_release');
      if (activeSubTab === 'packs') return entityPosts.filter((p) => p.threadKind === 'download_pack');
      if (activeSubTab === 'gifs') return gifPosts;
      return entityPosts;
    }
    if (activeSubTab === 'gifs') return gifPosts;
    return entityPosts;
  }, [entityPosts, gifPosts, activeSubTab, isForumEntity]);

  const renderedPosts = filteredPosts.slice(0, visibleCount);
  const hasMoreLocal = renderedPosts.length < filteredPosts.length;

  const entityKindLabel =
    entityKind === 'category' ? (isEn ? 'Category' : 'Categoria')
    : entityKind === 'tag' ? 'Tag'
    : entityKind === 'channel' ? (isEn ? 'Channel' : 'Canal')
    : entityKind === 'subforum' ? (isEn ? 'Board' : 'Subfórum')
    : caps.archetype === 'forum_board' ? 'Uploader'
    : (isEn ? 'Artist' : 'Artista');

  const saveLabel = isSaved
    ? (isTopicHub ? (isEn ? 'Saved' : 'Salvo') : (isEn ? 'Following' : 'Seguindo'))
    : (isTopicHub
        ? (isEn ? `Save ${entityKindLabel}` : `Salvar ${entityKindLabel}`)
        : entityKind === 'channel'
          ? (isEn ? 'Follow Channel' : 'Seguir Canal')
          : (isEn ? 'Follow Artist' : 'Seguir Artista'));

  const handleShare = () => {
    const url = creator.profileUrl;
    if (!url || typeof navigator.clipboard?.writeText !== 'function') return;
    navigator.clipboard.writeText(url).then(() => {
      addNotification({
        type: 'info',
        title: isEn ? 'Link copied' : 'Link copiado',
        message: isEn ? 'Link copied to clipboard.' : 'Link copiado para a área de transferência.',
      });
    }).catch(() => {});
  };

  const countLabel = isForumEntity
    ? (isEn ? `${entityPosts.length} threads` : `${entityPosts.length} tópicos`)
    : (isEn ? `${Math.max(creator.stats?.albums || 0, entityPosts.length)} galleries` : `${Math.max(creator.stats?.albums || 0, entityPosts.length)} galerias`);

  return (
    <section
      className="tl-entity-hub space-y-5 min-w-0 max-w-full"
      data-catalog-entity-view={entityKind}
      data-entity-layout-mode={caps.layoutMode}
    >
      {/* Top Bar */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          data-action="back-to-timeline"
          onClick={onBack}
          className="tl-nav-back-btn"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{isEn ? 'Back' : 'Voltar'}</span>
        </button>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => toggleFollowCreator(creator)}
            aria-pressed={isSaved}
            className={isSaved ? 'tl-entity-save-btn is-saved' : 'tl-entity-save-btn'}
          >
            {isSaved ? <Check className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />}
            <span>{saveLabel}</span>
          </button>
          <button
            type="button"
            onClick={handleShare}
            aria-label={isEn ? 'Copy link' : 'Copiar link'}
            className="tl-clean-icon-btn"
          >
            <Share2 className="h-4 w-4" />
          </button>
          {creator.profileUrl && (
            <a
              href={creator.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={isEn ? 'Open on source' : 'Abrir na fonte'}
              className="tl-clean-icon-btn"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>

      {/* Distinct Entity Header: Editorial Topic Banner for Categories/Tags vs Portrait Header for Artists/Channels */}
      <header className={`tl-entity-hub-header ${isTopicHub ? 'tl-entity-hub-header--topic' : 'tl-entity-hub-header--person'}`}>
        {!isTopicHub && !isForumEntity && creator.avatar && !creator.avatar.startsWith('data:image/gif') && (
          <div className="tl-entity-portrait-frame">
            <img
              src={creator.avatar}
              alt={creator.name}
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
            />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tl-entity-kind-tag">{sourceLabel} · {entityKindLabel}</span>
            <span className="text-xs font-mono text-[var(--tl-text-muted)]">{countLabel}</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-[var(--tl-text-primary)] leading-tight break-words">
            {creator.name}
          </h1>
          {creator.bio && (
            <p className="text-xs sm:text-sm text-[var(--tl-text-secondary)] max-w-2xl line-clamp-2">
              {creator.bio}
            </p>
          )}
        </div>
      </header>

      {/* Related Entities / Sub-Categories Strip */}
      {Array.isArray(creator.relatedEntities) && creator.relatedEntities.length > 0 && (
        <div className="tl-entity-related-bar" data-profile-related-entities="true">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--tl-text-muted)] shrink-0">
            {isEn ? 'Related' : 'Relacionados'}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {creator.relatedEntities.map((ent) => (
              <button
                key={`${ent.kind || 'rel'}-${ent.url || ent.name}`}
                type="button"
                onClick={() => ent.url && onOpenEntity(ent)}
                className="tl-clean-tag-pill"
              >
                <span>{ent.name}</span>
                {typeof ent.count === 'number' && ent.count > 0 && (
                  <span className="opacity-70 ml-1">{ent.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Purposeful Sub-Filter Bar (only when multiple distinct types exist; NO duplicate tabs!) */}
      {(isForumEntity || gifPosts.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={activeSubTab === 'all'}
            onClick={() => setActiveSubTab('all')}
            className="tl-subfilter-pill"
          >
            {isEn ? `All (${entityPosts.length})` : `Tudo (${entityPosts.length})`}
          </button>
          {isForumEntity && (
            <>
              <button type="button" aria-pressed={activeSubTab === 'albums'} onClick={() => setActiveSubTab('albums')} className="tl-subfilter-pill">
                {isEn ? 'Photo Sets' : 'Álbuns'}
              </button>
              <button type="button" aria-pressed={activeSubTab === 'videos'} onClick={() => setActiveSubTab('videos')} className="tl-subfilter-pill">
                {isEn ? 'Video Releases' : 'Vídeos'}
              </button>
              <button type="button" aria-pressed={activeSubTab === 'packs'} onClick={() => setActiveSubTab('packs')} className="tl-subfilter-pill">
                {isEn ? 'Download Packs' : 'Pacotes'}
              </button>
            </>
          )}
          {gifPosts.length > 0 && (
            <button type="button" aria-pressed={activeSubTab === 'gifs'} onClick={() => setActiveSubTab('gifs')} className="tl-subfilter-pill">
              GIFs ({gifPosts.length})
            </button>
          )}
        </div>
      )}

      {/* Content Grid */}
      {renderedPosts.length === 0 ? (
        <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] py-12 text-center text-xs text-[var(--tl-text-muted)]">
          {isEn ? 'No galleries available yet.' : 'Nenhuma galeria disponível ainda.'}
        </div>
      ) : (
        <div
          data-profile-layout-mode={caps.layoutMode}
          className={
            caps.layoutMode === 'forum_index'
              ? 'tl-forum-thread-list'
              : caps.layoutMode === 'category_showcase'
                ? 'tl-category-showcase-grid'
                : 'tl-editorial-wall-grid'
          }
        >
          {renderedPosts.map((post) => {
            if (caps.layoutMode === 'forum_index') {
              return (
                <ForumThreadRow
                  key={post.id}
                  post={post}
                  isEn={isEn}
                  onOpenThread={onOpenThread}
                  onOpenLightbox={onOpenLightbox}
                  onOpenEntity={onOpenEntity}
                />
              );
            }
            if (caps.layoutMode === 'category_showcase') {
              return (
                <CategoryShowcaseCard
                  key={post.id}
                  post={post}
                  sourceLabel={sourceLabel}
                  isEn={isEn}
                  onOpenGallery={onOpenGallery}
                  onOpenLightbox={onOpenLightbox}
                  onOpenEntity={onOpenEntity}
                />
              );
            }
            return (
              <EditorialGalleryCard
                key={post.id}
                post={post}
                sourceLabel={sourceLabel}
                isEn={isEn}
                onOpenGallery={onOpenGallery}
                onOpenLightbox={onOpenLightbox}
                onOpenEntity={onOpenEntity}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-center gap-3 pt-2 pb-6">
        {hasMoreLocal && (
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + 32)}
            className="tl-entity-load-more-btn"
          >
            {isEn
              ? `Show more (${filteredPosts.length - renderedPosts.length} remaining)`
              : `Mostrar mais (${filteredPosts.length - renderedPosts.length} restantes)`}
          </button>
        )}
        {!hasMoreLocal && creator.profileHasMore && onLoadMore && (
          <button
            type="button"
            data-load-more-profile-albums="true"
            disabled={isLoadingMore}
            onClick={onLoadMore}
            className="tl-entity-load-more-btn"
          >
            {isLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{isEn ? 'Load more from source' : 'Carregar mais da origem'}</span>
          </button>
        )}
      </div>
    </section>
  );
};
