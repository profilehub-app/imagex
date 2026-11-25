import {profileShortcutIdentity} from '../store/useProfileDirectoryLibraryStore';
import type {ProfileShortcut} from '../store/useProfileDirectoryLibraryStore';
import {resolveCreatorHandle, resolveTimelinePlatform} from '../components/profile-hub/timeline/timelineModel';
import type {TimelineCreator} from '../components/profile-hub/timeline/timelineModel';

/** Membership comes only from the persisted profile collection. Catalog entries
 * supply reusable identity/metadata, never authorization to re-add a creator.
 */
export function projectSavedTimelineCreators(favorites:ProfileShortcut[], known:TimelineCreator[]):TimelineCreator[] {
  const identities=new Map(known.map(creator=>[profileShortcutIdentity(creator.profileUrl),creator]));
  const seen=new Set<string>();
  return favorites.flatMap(favorite=>{
    const identity=profileShortcutIdentity(favorite.url);
    if(favorite.kind!=='profile'||!identity||identity.startsWith('demo:')||seen.has(identity)) return [];
    seen.add(identity);
    const previous=identities.get(identity);
    const name=favorite.name || previous?.name || '';
    const avatar=favorite.imageUrl || previous?.avatar || '';
    const banner=previous?.banner || favorite.bannerUrl || undefined;
    const entityKind=previous?.entityKind || favorite.entityKind;
    const portalInfo=previous?.portalInfo || favorite.portalInfo;
    const verified=previous?.verified ?? favorite.verified ?? false;
    const handle=resolveCreatorHandle({handle:previous?.handle, name, profileUrl:favorite.url});
    const site=resolveTimelinePlatform(favorite.url, previous?.site || favorite.source) || previous?.site;
    if(previous && previous.name===name && previous.avatar===avatar && previous.handle===handle && previous.site===site && previous.banner===banner && previous.entityKind===entityKind && previous.verified===verified) return [previous];
    return [{...previous,id:previous?.id || favorite.key,name,handle,avatar,banner,site,entityKind,portalInfo,
      profileUrl:favorite.url,verified,stats:previous?.stats || {}}];
  });
}
