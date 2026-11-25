export const DEFAULT_GITHUB_REPO = 'profilehub-app/imagex';

const GITHUB_REPO_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export interface CommunityConfig {
  githubRepo: string;
  releasesUrl: string;
  promoSiteUrl: string;
  communityUrl: string;
  donateUrl: string;
  donateSecondaryUrl: string;
  hasConfiguredChannels: boolean;
}

/** Normalize a GitHub owner/repo slug, falling back to DEFAULT_GITHUB_REPO on invalid input. */
export function normalizeGithubRepo(raw?: string | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (
    !trimmed ||
    trimmed.includes('..') ||
    trimmed.toLowerCase().endsWith('.git') ||
    !GITHUB_REPO_RE.test(trimmed)
  ) {
    return DEFAULT_GITHUB_REPO;
  }
  return trimmed;
}

/** Allow strictly valid public https:// URLs; return an empty string for anything else. */
export function validatePublicHttpsUrl(raw?: string | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

/** Build validated community and support configuration from Vite build-time env variables. */
export function getCommunityConfig(
  env?: Record<string, string | undefined>
): CommunityConfig {
  const source =
    env ??
    ((typeof import.meta !== 'undefined' &&
      (import.meta as unknown as { env?: Record<string, string | undefined> }).env) ||
      {});

  const githubRepo = normalizeGithubRepo(source.VITE_GITHUB_REPO);
  const promoSiteUrl = validatePublicHttpsUrl(source.VITE_PROMO_SITE_URL);
  const communityUrl = validatePublicHttpsUrl(source.VITE_COMMUNITY_URL);
  const donateUrl = validatePublicHttpsUrl(source.VITE_DONATE_URL);
  const donateSecondaryUrl = validatePublicHttpsUrl(source.VITE_DONATE_SECONDARY_URL);

  return {
    githubRepo,
    releasesUrl: `https://github.com/${githubRepo}/releases`,
    promoSiteUrl,
    communityUrl,
    donateUrl,
    donateSecondaryUrl,
    hasConfiguredChannels: Boolean(communityUrl || donateUrl || donateSecondaryUrl),
  };
}
