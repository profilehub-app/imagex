import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

type Phase = 'starting' | 'preparing' | 'ready' | 'failed' | 'unmanaged';

export function BrowserSetupNotice() {
  const english = useAppStore(s => s.settings.language === 'en-US');
  const [phase, setPhase] = useState<Phase>('unmanaged');
  const [retrying, setRetrying] = useState(false);
  const onDesktop = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      try {
        const response = await fetch('/api/browser-runtime', { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as { phase: Phase };
        if (controller.signal.aborted) return;
        setPhase(data.phase);
        if (data.phase !== 'ready' && data.phase !== 'unmanaged') {
          timer = window.setTimeout(refresh, data.phase === 'failed' ? 5000 : 2000);
        }
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);

  async function retry() {
    setRetrying(true);
    try {
      const response = await fetch('/api/browser-runtime/retry', {
        method: 'POST',
        headers: { 'X-ImageX-Runtime': '1' },
      });
      if (response.ok) setPhase((await response.json()).phase);
    } catch {
      // Keep the failure notice and allow another retry.
    } finally {
      setRetrying(false);
    }
  }

  if (phase === 'ready' || phase === 'unmanaged') return null;
  const failed = phase === 'failed';
  return (
    <div role="status" aria-live="polite" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2 text-sm text-[var(--text-primary)]">
      {failed
        ? <AlertTriangle aria-hidden="true" size={16} className="shrink-0 text-amber-400" />
        : <Loader2 aria-hidden="true" size={16} className="shrink-0 text-brand-400 motion-safe:animate-spin" />}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{failed
          ? english ? 'The extractor could not be prepared' : 'Não foi possível preparar o extrator'
          : english ? 'Preparing the extractor…' : 'Preparando o extrator…'}</div>
        <div className="text-xs text-[var(--text-secondary)]">{failed
          ? english ? 'Check the internet connection on the computer running ImageX. Your local library is still available.'
                    : 'Confira a internet no computador que roda o ImageX. A biblioteca local continua disponível.'
          : english ? 'Chromium is being set up in the background. You can keep using your local library.'
                    : 'O Chromium está sendo preparado em segundo plano. Você pode continuar usando a biblioteca local.'}</div>
      </div>
      {failed && onDesktop && <button type="button" disabled={retrying} onClick={() => void retry()}
        className="rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 disabled:opacity-50">
        {english ? 'Retry' : 'Tentar novamente'}
      </button>}
    </div>
  );
}
