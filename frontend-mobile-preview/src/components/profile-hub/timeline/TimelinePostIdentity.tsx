import type { MouseEventHandler, ReactNode } from 'react';
import type { TimelinePlatform } from './timelineModel';
import { renderBrandPlatformIcon, VerifiedSealIcon } from './TimelineBrandIcons';

interface TimelinePostIdentityProps {
  name: string;
  handle?: string;
  avatar?: ReactNode;
  platform?: TimelinePlatform;
  sourceLabel?: string;
  dateLabel?: string;
  dateTime?: string;
  verifiedLabel?: string;
  creatorId?: string;
  profileLabel?: string;
  onOpenProfile?: MouseEventHandler<HTMLButtonElement>;
}

export function renderPlatformIcon(platform?: TimelinePlatform, size = 14) {
  return renderBrandPlatformIcon(platform, size);
}

export function TimelinePostIdentity({
  name, handle, avatar, platform, sourceLabel, dateLabel, dateTime,
  verifiedLabel, creatorId, profileLabel, onOpenProfile,
}: TimelinePostIdentityProps) {
  const author = <>
    <span className="tl-post-avatar" data-avatar-platform={platform || 'generic'} aria-hidden>{avatar || Array.from(name.trim())[0]?.toLocaleUpperCase()}</span>
    <span className="tl-post-author-text">
      <span className="tl-post-name">
        <span>{name}</span>
        {verifiedLabel && (
          <span className="tl-post-verified-seal" role="img" aria-label={verifiedLabel} title={verifiedLabel}>
            <VerifiedSealIcon size={16} />
          </span>
        )}
      </span>
      {handle && <span className="tl-post-handle">{handle}</span>}
    </span>
  </>;

  return <div className="tl-post-identity">
    {onOpenProfile ? <button type="button" className="tl-post-author" data-post-creator-id={creatorId}
      aria-label={profileLabel} onClick={onOpenProfile}>{author}</button>
      : <div className="tl-post-author">{author}</div>}
    {(sourceLabel || dateLabel) && <div className="tl-post-meta">
      {sourceLabel && <span className="tl-post-source" data-platform={platform || 'generic'}>
        {renderPlatformIcon(platform, 13)}
        <span className={platform === 'x' ? 'sr-only' : undefined}>{sourceLabel}</span>
      </span>}
      {dateLabel && <time className="tl-post-time" dateTime={dateTime}>{dateLabel}</time>}
    </div>}
  </div>;
}
