import type { TimelinePlatform, TimelinePost } from './timelineModel';

export type SourceContentArchetype =
  | 'social_microblog'
  | 'social_visual'
  | 'video_platform'
  | 'video_portal'
  | 'gallery_catalog'
  | 'forum_board'
  | 'generic';

export type DirectoryKind = 'categories' | 'artists' | 'channels' | 'tags' | 'boards';

export type SourceLayoutMode = 'editorial_wall' | 'category_showcase' | 'forum_index' | 'video_wall' | 'standard';

export interface DynamicUrlHints {
  videoPathRegex?: string;
  playlistPathRegex?: string;
  entityPrefixes?: string[];
}

export interface SourceSearchOptionsSpec {
  supportsBoardFilter: boolean;
  supportsSearchScope: boolean;
  supportsMediaFilter: boolean;
  supportsSubfilterSearch: boolean;
  sortOptions: string[];
}

export interface SourceCapabilities {
  archetype: SourceContentArchetype;
  layoutMode: SourceLayoutMode;
  supportsComments: boolean;
  supportsSourceLikes: boolean;
  supportsNativePlayback: boolean;
  supportsVideosTab: boolean;
  supportsPlaylists: boolean;
  supportsArtistProfiles: boolean;
  supportsDirectories: boolean;
  supportsThreadReader: boolean;
  directoryKinds: DirectoryKind[];
  searchCategories: string[];
  searchOptions?: SourceSearchOptionsSpec;
}

export interface DynamicSourceSubfilter {
  id: string;
  label_key?: string;
  fallback_label?: string;
  group?: string;
}

export interface DynamicSourceRegistrationInput {
  source_id?: string;
  id?: string;
  display_name?: string;
  name?: string;
  default_category?: string;
  categories?: string[];
  subfilters?: DynamicSourceSubfilter[];
  supports_quick_url_open?: boolean;
  icon_kind?: string;
  iconKind?: string;
  accentColor?: string;
  accent_color?: string;
  urlHints?: DynamicUrlHints;
  url_hints?: DynamicUrlHints;
  origins?: string[];
  capabilities?: Partial<SourceCapabilities>;
}

export interface RegisteredDynamicSource {
  sourceId: string;
  displayName: string;
  defaultCategory: string;
  categories: string[];
  subfilters: DynamicSourceSubfilter[];
  supportsQuickUrlOpen: boolean;
  iconKind: string;
  accentColor?: string;
  urlHints?: DynamicUrlHints;
  origins: string[];
  capabilities: SourceCapabilities;
}

const VALID_ARCHETYPES: ReadonlySet<SourceContentArchetype> = new Set([
  'social_microblog',
  'social_visual',
  'video_platform',
  'video_portal',
  'gallery_catalog',
  'forum_board',
  'generic',
]);

const VALID_DIRECTORY_KINDS: ReadonlySet<DirectoryKind> = new Set([
  'categories',
  'artists',
  'channels',
  'tags',
  'boards',
]);

const VALID_LAYOUT_MODES: ReadonlySet<SourceLayoutMode> = new Set([
  'editorial_wall',
  'category_showcase',
  'forum_index',
  'video_wall',
  'standard',
]);

const VALID_BROWSE_MODES: ReadonlySet<string> = new Set([
  'recent',
  'recommended',
  'posts',
  'photos',
  'reels',
  'videos',
  'shorts',
  'playlists',
  'community',
  'albums',
  'gifs',
  'popular',
]);

const BUILTIN_CAPABILITIES: Record<string, SourceCapabilities> = {
  x: {
    archetype: 'social_microblog',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: false,
    supportsArtistProfiles: true,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'users', 'posts', 'photos', 'videos', 'gifs'],
  },
  instagram: {
    archetype: 'social_visual',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: false,
    supportsArtistProfiles: true,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'users', 'posts', 'photos', 'videos'],
  },
  pinterest: {
    archetype: 'social_visual',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: true,
    supportsArtistProfiles: true,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'users', 'photos', 'albums', 'videos'],
  },
  imgur: {
    archetype: 'social_visual',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: false,
    supportsArtistProfiles: true,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'albums', 'photos', 'gifs', 'videos', 'posts'],
  },
  slack: {
    archetype: 'social_microblog',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: false,
    supportsArtistProfiles: false,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'posts', 'photos', 'videos'],
  },
  youtube: {
    archetype: 'video_platform',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: true,
    supportsArtistProfiles: true,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'users', 'videos', 'shorts', 'playlists', 'posts'],
  },
  generic: {
    archetype: 'generic',
    layoutMode: 'standard',
    supportsComments: true,
    supportsSourceLikes: true,
    supportsNativePlayback: true,
    supportsVideosTab: true,
    supportsPlaylists: true,
    supportsArtistProfiles: true,
    supportsDirectories: false,
    supportsThreadReader: false,
    directoryKinds: [],
    searchCategories: ['all', 'albums', 'photos', 'posts', 'gifs'],
  },
};

const dynamicSourceRegistry = new Map<string, RegisteredDynamicSource>();
const dynamicOriginToSource = new Map<string, string>();
const dynamicCatalogHosts = new Set<string>();

function normalizeArchetype(value: unknown, fallback: SourceContentArchetype = 'generic'): SourceContentArchetype {
  const raw = String(value || '').trim().toLowerCase() as SourceContentArchetype;
  return VALID_ARCHETYPES.has(raw) ? raw : fallback;
}

function defaultSearchOptionsForArchetype(archetype: SourceContentArchetype): SourceSearchOptionsSpec {
  if (archetype === 'forum_board') {
    return {
      supportsBoardFilter: true,
      supportsSearchScope: true,
      supportsMediaFilter: true,
      supportsSubfilterSearch: true,
      sortOptions: ['relevance', 'recent', 'replies'],
    };
  }
  if (archetype === 'gallery_catalog') {
    return {
      supportsBoardFilter: false,
      supportsSearchScope: false,
      supportsMediaFilter: false,
      supportsSubfilterSearch: true,
      sortOptions: ['relevance', 'popular', 'recent'],
    };
  }
  if (archetype === 'video_platform') {
    return {
      supportsBoardFilter: false,
      supportsSearchScope: false,
      supportsMediaFilter: false,
      supportsSubfilterSearch: false,
      sortOptions: ['relevance', 'recent'],
    };
  }
  if (archetype === 'video_portal') {
    return {
      supportsBoardFilter: false,
      supportsSearchScope: false,
      supportsMediaFilter: false,
      supportsSubfilterSearch: true,
      sortOptions: ['relevance', 'recent', 'popular'],
    };
  }
  return {
    supportsBoardFilter: false,
    supportsSearchScope: false,
    supportsMediaFilter: false,
    supportsSubfilterSearch: false,
    sortOptions: [],
  };
}

function defaultCapabilitiesForArchetype(archetype: SourceContentArchetype): SourceCapabilities {
  if (archetype === 'video_portal') {
    return {
      archetype: 'video_portal',
      layoutMode: 'video_wall',
      supportsComments: true,
      supportsSourceLikes: true,
      supportsNativePlayback: true,
      supportsVideosTab: true,
      supportsPlaylists: true,
      supportsArtistProfiles: true,
      supportsDirectories: true,
      supportsThreadReader: false,
      directoryKinds: ['categories', 'channels', 'artists', 'tags'],
      searchCategories: ['all', 'profiles', 'videos', 'playlists'],
      searchOptions: defaultSearchOptionsForArchetype('video_portal'),
    };
  }
  if (archetype === 'gallery_catalog') {
    return {
      archetype: 'gallery_catalog',
      layoutMode: 'editorial_wall',
      supportsComments: false,
      supportsSourceLikes: false,
      supportsNativePlayback: false,
      supportsVideosTab: false,
      supportsPlaylists: false,
      supportsArtistProfiles: true,
      supportsDirectories: true,
      supportsThreadReader: false,
      directoryKinds: ['categories', 'artists', 'channels', 'tags'],
      searchCategories: ['all', 'users', 'albums', 'photos', 'gifs'],
      searchOptions: defaultSearchOptionsForArchetype('gallery_catalog'),
    };
  }
  if (archetype === 'forum_board') {
    return {
      archetype: 'forum_board',
      layoutMode: 'forum_index',
      supportsComments: false,
      supportsSourceLikes: false,
      supportsNativePlayback: false,
      supportsVideosTab: false,
      supportsPlaylists: false,
      supportsArtistProfiles: true,
      supportsDirectories: true,
      supportsThreadReader: true,
      directoryKinds: ['boards', 'categories'],
      searchCategories: ['all', 'albums', 'photos', 'posts', 'gifs', 'videos'],
      searchOptions: defaultSearchOptionsForArchetype('forum_board'),
    };
  }
  return {
    ...BUILTIN_CAPABILITIES.generic,
    archetype,
    searchOptions: defaultSearchOptionsForArchetype(archetype),
  };
}

function normalizeLayoutMode(value: unknown, fallback: SourceLayoutMode): SourceLayoutMode {
  const raw = String(value || '').trim().toLowerCase() as SourceLayoutMode;
  return VALID_LAYOUT_MODES.has(raw) ? raw : fallback;
}

function normalizeCapabilities(
  raw: Partial<SourceCapabilities> | undefined,
  iconKind: string
): SourceCapabilities {
  const inferredArchetype: SourceContentArchetype =
    raw?.archetype
      ? normalizeArchetype(raw.archetype)
      : iconKind === 'video_portal'
        ? 'video_portal'
        : iconKind === 'forum_board'
          ? 'forum_board'
          : iconKind === 'gallery_catalog' || iconKind === 'gallery_hd'
            ? 'gallery_catalog'
            : 'generic';
  const base = defaultCapabilitiesForArchetype(inferredArchetype);
  const inferredLayout: SourceLayoutMode =
    raw?.layoutMode
      ? normalizeLayoutMode(raw.layoutMode, base.layoutMode)
      : iconKind === 'gallery_hd'
        ? 'category_showcase'
        : base.layoutMode;
  const directoryKinds = Array.isArray(raw?.directoryKinds)
    ? Array.from(
        new Set(
          raw!.directoryKinds
            .map((kind) => {
              const norm = String(kind || '').trim().toLowerCase();
              return (norm === 'sections' ? 'boards' : norm) as DirectoryKind;
            })
            .filter((kind) => VALID_DIRECTORY_KINDS.has(kind))
        )
      )
    : base.directoryKinds;
  const searchCategories = Array.isArray(raw?.searchCategories) && raw!.searchCategories.length > 0
    ? raw!.searchCategories.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean)
    : base.searchCategories;

  const baseSearchOpts = base.searchOptions || defaultSearchOptionsForArchetype(inferredArchetype);
  const rawSearchOpts = raw?.searchOptions;
  const searchOptions: SourceSearchOptionsSpec = {
    supportsBoardFilter: rawSearchOpts?.supportsBoardFilter ?? baseSearchOpts.supportsBoardFilter,
    supportsSearchScope: rawSearchOpts?.supportsSearchScope ?? baseSearchOpts.supportsSearchScope,
    supportsMediaFilter: rawSearchOpts?.supportsMediaFilter ?? baseSearchOpts.supportsMediaFilter,
    supportsSubfilterSearch: rawSearchOpts?.supportsSubfilterSearch ?? baseSearchOpts.supportsSubfilterSearch,
    sortOptions: Array.isArray(rawSearchOpts?.sortOptions)
      ? rawSearchOpts!.sortOptions.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
      : baseSearchOpts.sortOptions,
  };

  return {
    archetype: inferredArchetype,
    layoutMode: inferredLayout,
    supportsComments: raw?.supportsComments ?? base.supportsComments,
    supportsSourceLikes: raw?.supportsSourceLikes ?? base.supportsSourceLikes,
    supportsNativePlayback: raw?.supportsNativePlayback ?? base.supportsNativePlayback,
    supportsVideosTab: raw?.supportsVideosTab ?? base.supportsVideosTab,
    supportsPlaylists: raw?.supportsPlaylists ?? base.supportsPlaylists,
    supportsArtistProfiles: raw?.supportsArtistProfiles ?? base.supportsArtistProfiles,
    supportsDirectories: raw?.supportsDirectories ?? base.supportsDirectories,
    supportsThreadReader: raw?.supportsThreadReader ?? base.supportsThreadReader,
    directoryKinds,
    searchCategories,
    searchOptions,
  };
}

function extractHost(urlOrHost: string): string | null {
  const trimmed = String(urlOrHost || '').trim().toLowerCase();
  if (!trimmed) return null;
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).hostname.replace(/^www\./, '').toLowerCase() || null;
    }
    return new URL(`https://${trimmed}`).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

export function registerDynamicOrigin(urlOrOrigin: string | null | undefined, sourceId: string): void {
  const normalizedId = String(sourceId || '').trim().toLowerCase();
  if (!normalizedId || !urlOrOrigin) return;
  const host = extractHost(urlOrOrigin);
  if (!host) return;
  dynamicOriginToSource.set(host, normalizedId);
  const entry = dynamicSourceRegistry.get(normalizedId);
  if (entry) {
    if (!entry.origins.includes(host)) {
      entry.origins.push(host);
    }
    if (entry.capabilities.archetype === 'gallery_catalog') {
      dynamicCatalogHosts.add(host);
    }
  }
}

export function registerDynamicSources(sources: DynamicSourceRegistrationInput[]): void {
  if (!Array.isArray(sources)) return;
  for (const raw of sources) {
    const sourceId = String(raw.source_id || raw.id || '').trim().toLowerCase();
    if (!sourceId) continue;
    // Never overwrite built-in platform capabilities (YouTube, X, Pinterest, Imgur, etc.)
    if (sourceId !== 'generic' && Object.prototype.hasOwnProperty.call(BUILTIN_CAPABILITIES, sourceId)) {
      continue;
    }
    const existing = dynamicSourceRegistry.get(sourceId);
    const hasExplicitCaps = Boolean(raw.capabilities && typeof raw.capabilities === 'object');
    const hasExplicitIcon = Boolean(raw.icon_kind || raw.iconKind);
    if (!existing && !hasExplicitCaps && !hasExplicitIcon && !raw.default_category) {
      continue;
    }
    const iconKind = String(raw.icon_kind || raw.iconKind || existing?.iconKind || 'gallery_catalog').trim();
    const capabilities = normalizeCapabilities(raw.capabilities || existing?.capabilities, iconKind);
    const rawBrowseModes = Array.isArray(raw.categories)
      ? raw.categories
          .map((c) => String(c || '').trim().toLowerCase())
          .filter((c) => VALID_BROWSE_MODES.has(c))
      : [];
    const categories = rawBrowseModes.length > 0 && (raw.default_category !== undefined || !existing?.categories?.length)
      ? rawBrowseModes
      : existing?.categories || rawBrowseModes;
    const defaultCategory = String(raw.default_category || existing?.defaultCategory || categories[0] || 'recent')
      .trim()
      .toLowerCase();
    const displayName = String(raw.display_name || raw.name || existing?.displayName || sourceId).trim();
    const subfilters = Array.isArray(raw.subfilters)
      ? raw.subfilters
      : existing?.subfilters || [];
    const origins = Array.from(new Set([
      ...(existing?.origins || []),
      ...((Array.isArray(raw.origins) ? raw.origins : []).map((o) => extractHost(o)).filter((o): o is string => Boolean(o))),
    ]));
    const rawAccent = typeof raw.accentColor === 'string'
      ? raw.accentColor
      : (typeof raw.accent_color === 'string' ? raw.accent_color : existing?.accentColor);
    const accentColor = rawAccent ? rawAccent.trim() : undefined;
    const rawUrlHints = raw.urlHints || raw.url_hints;
    const urlHints = rawUrlHints && typeof rawUrlHints === 'object'
      ? {
          ...(existing?.urlHints || {}),
          ...rawUrlHints,
        }
      : existing?.urlHints;

    dynamicSourceRegistry.set(sourceId, {
      sourceId,
      displayName,
      defaultCategory,
      categories,
      subfilters,
      supportsQuickUrlOpen: raw.supports_quick_url_open ?? existing?.supportsQuickUrlOpen ?? true,
      iconKind,
      accentColor,
      urlHints,
      origins,
      capabilities,
    });

    for (const host of origins) {
      dynamicOriginToSource.set(host, sourceId);
      if (capabilities.archetype === 'gallery_catalog') {
        dynamicCatalogHosts.add(host);
      }
    }
  }
}

export function clearDynamicSources(): void {
  dynamicSourceRegistry.clear();
  dynamicOriginToSource.clear();
  dynamicCatalogHosts.clear();
}

export function listDynamicSources(): RegisteredDynamicSource[] {
  return Array.from(dynamicSourceRegistry.values());
}

export function getDynamicSource(sourceId?: string | null): RegisteredDynamicSource | undefined {
  const key = String(sourceId || '').trim().toLowerCase();
  return key ? dynamicSourceRegistry.get(key) : undefined;
}

export function isDynamicCatalogCdnUrl(url?: string | null): boolean {
  if (!url) return false;
  const host = extractHost(url);
  if (!host) return false;
  for (const catalogHost of dynamicCatalogHosts) {
    if (host === catalogHost || host.endsWith(`.${catalogHost}`)) {
      return true;
    }
  }
  return false;
}

export function resolveDynamicSourceFromUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const host = extractHost(url);
  if (!host) return undefined;
  const direct = dynamicOriginToSource.get(host);
  if (direct) return direct;
  for (const [registeredHost, sourceId] of dynamicOriginToSource.entries()) {
    if (host.endsWith(`.${registeredHost}`)) {
      return sourceId;
    }
  }
  return undefined;
}

export function getDynamicSourceLabel(source?: TimelinePlatform | string | null): string {
  const key = String(source || '').trim().toLowerCase();
  if (!key) return '';
  const registered = dynamicSourceRegistry.get(key);
  if (registered?.displayName) return registered.displayName;
  if (key.includes('_') || key.includes('-')) {
    return key
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return key.toUpperCase();
}

export function getDynamicSourceIconKind(source?: TimelinePlatform | string | null): string {
  const key = String(source || '').trim().toLowerCase();
  if (!key) return 'generic';
  const registered = dynamicSourceRegistry.get(key);
  if (registered?.iconKind) return registered.iconKind;
  if (registered?.capabilities.archetype === 'video_portal') return 'video_portal';
  if (registered?.capabilities.archetype === 'forum_board') return 'forum_board';
  if (registered?.capabilities.archetype === 'gallery_catalog') return 'gallery_catalog';
  return 'video';
}

export function getDynamicUrlHints(source?: TimelinePlatform | string | null): DynamicUrlHints | undefined {
  const key = String(source || '').trim().toLowerCase();
  return key ? dynamicSourceRegistry.get(key)?.urlHints : undefined;
}

export function getDynamicSourceAccent(source?: TimelinePlatform | string | null): string | undefined {
  const key = String(source || '').trim().toLowerCase();
  return key ? dynamicSourceRegistry.get(key)?.accentColor : undefined;
}

export function getSourceCapabilities(
  source?: TimelinePlatform | string | null,
  post?: Partial<TimelinePost> | null
): SourceCapabilities {
  const key = String(source || '').trim().toLowerCase();
  let base: SourceCapabilities;
  if (key && key !== 'generic' && Object.prototype.hasOwnProperty.call(BUILTIN_CAPABILITIES, key)) {
    base = { ...BUILTIN_CAPABILITIES[key] };
  } else {
    const registered = key ? dynamicSourceRegistry.get(key) : undefined;
    if (registered) {
      base = { ...registered.capabilities };
    } else if (post?.threadKind || (Array.isArray(post?.releaseLinks) && post.releaseLinks.length > 0)) {
      base = defaultCapabilitiesForArchetype('forum_board');
    } else if (
      Array.isArray(post?.artists) && post.artists.length > 0
      || Array.isArray(post?.channels) && post.channels.length > 0
    ) {
      base = defaultCapabilitiesForArchetype('gallery_catalog');
    } else {
      base = { ...BUILTIN_CAPABILITIES.generic };
    }
  }

  // Per-post guards for forum release threads or albums without native playable streams
  if (post?.threadKind === 'video_release' || post?.threadKind === 'download_pack') {
    const hasRealVideoStream = Boolean(
      post.masterHlsUrl
      || post.videoUrl
      || (Array.isArray(post.qualities) && post.qualities.length > 0)
    );
    base = {
      ...base,
      supportsNativePlayback: hasRealVideoStream,
      supportsPlaylists: false,
    };
  }

  return base;
}
