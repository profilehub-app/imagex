import React from 'react';
import { ExternalLink, Globe, Heart, ShieldCheck, Users, X } from 'lucide-react';
import { Language } from '../../types';
import { translations } from '../../i18n/translations';
import { CommunityConfig, getCommunityConfig } from '../../services/communityConfig';
import { AppDialog } from './AppDialog';

export function SupportActionLinks({
  lang,
  config,
  variant = 'dialog',
}: {
  lang: Language;
  config: CommunityConfig;
  variant?: 'dialog' | 'settings';
}) {
  const t = (translations[lang]?.support || translations['pt-BR']?.support) as Record<string, string>;
  const isSettings = variant === 'settings';

  return (
    <div className="space-y-3">
      {!config.hasConfiguredChannels && (
        <p
          role="status"
          className="rounded-2xl border border-border bg-surface-elevated/70 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--text-secondary)]"
        >
          {t.unconfiguredNotice}
        </p>
      )}

      <div className={isSettings ? 'flex flex-wrap gap-2' : 'grid gap-2'}>
        {config.communityUrl && (
          <a
            href={config.communityUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-brand-600/20 hover:bg-brand-500 transition-colors"
          >
            <Users size={15} aria-hidden="true" className="shrink-0" />
            <span>{t.joinCommunity}</span>
            <ExternalLink size={12} aria-hidden="true" className="shrink-0 opacity-80" />
          </a>
        )}

        {config.donateUrl && (
          <a
            href={config.donateUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-600 to-fuchsia-600 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-rose-600/20 hover:from-rose-500 hover:to-fuchsia-500 transition-all"
          >
            <Heart size={15} aria-hidden="true" className="shrink-0" />
            <span>{t.donatePrimary}</span>
            <ExternalLink size={12} aria-hidden="true" className="shrink-0 opacity-80" />
          </a>
        )}

        {config.donateSecondaryUrl && (
          <a
            href={config.donateSecondaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-elevated px-4 py-2.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-surface-hover transition-colors"
          >
            <Heart size={14} aria-hidden="true" className="shrink-0 text-rose-400" />
            <span>{t.donateSecondary}</span>
            <ExternalLink size={12} aria-hidden="true" className="shrink-0 opacity-75" />
          </a>
        )}

        {config.promoSiteUrl && (
          <a
            href={config.promoSiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-elevated px-4 py-2.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-surface-hover transition-colors"
          >
            <Globe size={14} aria-hidden="true" className="shrink-0 text-brand-400" />
            <span>{t.openWebsite}</span>
            <ExternalLink size={12} aria-hidden="true" className="shrink-0 opacity-75" />
          </a>
        )}

        <a
          href={config.releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-surface-elevated transition-colors"
        >
          <span>{t.viewReleases}</span>
          <ExternalLink size={12} aria-hidden="true" className="shrink-0 opacity-75" />
        </a>
      </div>
    </div>
  );
}

export function SupportDialogContent({
  lang,
  config,
  onClose,
  titleId = 'support-dialog-title',
  descriptionId = 'support-dialog-description',
}: {
  lang: Language;
  config: CommunityConfig;
  onClose: () => void;
  titleId?: string;
  descriptionId?: string;
}) {
  const t = (translations[lang]?.support || translations['pt-BR']?.support) as Record<string, string>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/15 text-rose-400">
            <Heart size={17} aria-hidden="true" />
          </span>
          <h1 id={titleId} className="text-base font-bold text-[var(--text-primary)]">
            {t.dialogTitle}
          </h1>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-surface-elevated transition-colors cursor-pointer"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <p id={descriptionId} className="text-sm leading-relaxed text-[var(--text-primary)]">
        {t.dialogSubtitle}
      </p>

      <SupportActionLinks lang={lang} config={config} variant="dialog" />

      <div className="flex items-start gap-2 rounded-2xl border border-border bg-surface-elevated/40 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--text-secondary)]">
        <ShieldCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-400" />
        <span>{t.privacyNote}</span>
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-border px-4 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-surface-elevated transition-colors cursor-pointer"
        >
          {t.close}
        </button>
      </div>
    </div>
  );
}

export function SupportDialog({
  open,
  lang,
  onClose,
  configOverride,
}: {
  open: boolean;
  lang: Language;
  onClose: () => void;
  configOverride?: CommunityConfig;
}) {
  if (!open) return null;
  const config = configOverride ?? getCommunityConfig();
  return (
    <AppDialog
      titleId="support-dialog-title"
      descriptionId="support-dialog-description"
      onClose={onClose}
      className="w-[min(92vw,30rem)] max-h-[85dvh] overflow-y-auto rounded-3xl border border-border bg-surface p-5 sm:p-6 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70"
    >
      <SupportDialogContent lang={lang} config={config} onClose={onClose} />
    </AppDialog>
  );
}
