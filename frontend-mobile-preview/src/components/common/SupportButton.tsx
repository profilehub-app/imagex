import React, { useState } from 'react';
import { Heart } from 'lucide-react';
import { Language } from '../../types';
import { translations } from '../../i18n/translations';
import { useAppStore } from '../../store/useAppStore';
import { SupportDialog } from './SupportDialog';

export function SupportTriggerButton({
  lang,
  compact,
  onClick,
}: {
  lang: Language;
  compact: boolean;
  onClick: () => void;
}) {
  const t = (translations[lang]?.support || translations['pt-BR']?.support) as Record<string, string>;
  const label = t.buttonLabel;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-bold bg-gradient-to-r from-rose-600/20 to-fuchsia-600/20 hover:from-rose-600/35 hover:to-fuchsia-600/35 text-[var(--text-primary)] border border-rose-500/30 transition-all shadow-lg cursor-pointer"
      title={label}
      aria-label={label}
    >
      <Heart size={15} aria-hidden="true" className="shrink-0 text-rose-400" />
      {!compact && <span className="truncate">{label}</span>}
    </button>
  );
}

export function SupportButton({
  compact,
  onOpen,
}: {
  compact: boolean;
  onOpen?: () => void;
}) {
  const language = useAppStore((state) => state.settings.language);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <SupportTriggerButton
        lang={language}
        compact={compact}
        onClick={() => {
          onOpen?.();
          setDialogOpen(true);
        }}
      />
      <SupportDialog
        open={dialogOpen}
        lang={language}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
