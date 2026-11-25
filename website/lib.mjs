export const DEFAULT_GITHUB_REPO = 'profilehub-app/imagex';

const GITHUB_REPO_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export function normalizeGithubRepo(raw) {
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

export function sanitizeExternalUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function resolveLanguage({ search = '', stored = '' } = {}) {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const queryLang = (params.get('lang') || '').trim().toLowerCase();
  if (queryLang === 'pt' || queryLang === 'pt-br') return 'pt-BR';
  if (queryLang === 'en' || queryLang === 'en-us') return 'en';
  const storedClean = String(stored || '').trim().toLowerCase();
  if (storedClean === 'pt' || storedClean === 'pt-br') return 'pt-BR';
  return 'en';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function selectReleaseAsset(releaseData, rawRepo) {
  const repo = normalizeGithubRepo(rawRepo);
  const fallbackUrl = `https://github.com/${repo}/releases/latest`;
  if (!releaseData || typeof releaseData !== 'object') {
    return {
      version: null,
      assetName: 'IMAGEX-Windows.zip',
      sizeBytes: 0,
      downloadUrl: fallbackUrl,
      releaseUrl: fallbackUrl,
    };
  }

  const version = typeof releaseData.tag_name === 'string' && releaseData.tag_name.trim()
    ? releaseData.tag_name.trim()
    : null;
  const releaseUrl = sanitizeExternalUrl(releaseData.html_url) || fallbackUrl;
  const assets = Array.isArray(releaseData.assets) ? releaseData.assets : [];

  const preferredZip = assets.find((a) => String(a?.name || '').toLowerCase() === 'imagex-windows.zip');
  const anyZip = preferredZip || assets.find((a) => String(a?.name || '').toLowerCase().endsWith('.zip'));
  const anyExe = assets.find((a) => String(a?.name || '').toLowerCase().endsWith('.exe'));
  const chosen = anyZip || anyExe || null;
  const chosenUrl = chosen ? sanitizeExternalUrl(chosen.browser_download_url) : '';

  return {
    version,
    assetName: chosen?.name || 'IMAGEX-Windows.zip',
    sizeBytes: Number(chosen?.size || 0),
    downloadUrl: chosenUrl || releaseUrl,
    releaseUrl,
  };
}

export const COPY = {
  en: {
    pageTitle: 'IMAGEX — Private Local Media Timeline, Smart Shorts & Web Stream',
    navFeatures: 'Features',
    navQuickStart: 'Install & Trust',
    navCommunity: 'Community',
    navDownload: 'Download Free',
    heroEyebrow: '100% Free • Runs Locally on Windows & Mobile Wi-Fi',
    heroTitle: 'One private timeline for your creators, galleries, and videos.',
    heroSubtitle:
      'Stop juggling dozens of browser tabs and bloated folders. Unify your favorite web feeds locally, stream with 0 MB on disk, and jump straight to the best moments with Smart Shorts.',
    ctaDownload: 'Download for Windows',
    ctaDownloadMetaFallback: 'Latest GitHub Release • Portable ZIP',
    ctaCommunity: 'Join Community',
    ctaDonate: 'Support Project',
    ctaSource: 'View Source on GitHub',
    previewLabel: 'Interactive product preview',
    tabTimeline: 'Unified Timeline',
    tabShorts: 'Smart Shorts',
    tabStream: 'Web Stream (0 MB)',
    tabMobile: 'Mobile Wi-Fi',
    panelTimelineBadge: 'Profile Hub • Clean Start',
    panelTimelineTitle: 'Your creators and local batches in one feed',
    panelTimelineDesc:
      'Add creator links or local collections when you want. Filter by feed, inspect profiles without leaving the workspace, and pick exactly what to save.',
    panelShortsBadge: 'Gold / Silver / Bronze Climax Detection',
    panelShortsTitle: 'Skip the slow buildup automatically',
    panelShortsDesc:
      'Vertical 9:16 player with automatic highlight markers (15s, 30s, or 60s), persistent sound across swipes, and smart bandwidth preloading.',
    panelStreamBadge: 'Zero Disk Bloat',
    panelStreamTitle: 'Collect & watch without filling your SSD',
    panelStreamDesc:
      'Save direct video streams using 0 MB on disk, renew expired links automatically, or archive original-resolution albums locally whenever you want.',
    panelMobileBadge: 'PC Server -> Phone Browser',
    panelMobileTitle: 'Browse comfortably from your phone on local Wi-Fi',
    panelMobileDesc:
      'Run IMAGEX on your Windows PC and open http://<YOUR_IP>:8100 on any phone on the same Wi-Fi — no cloud upload, no third-party tracking.',
    whyHeading: 'Built for privacy, speed, and zero clutter',
    whySubheading: 'Everything stays on hardware you control, with zero accounts and zero subscription walls.',
    card1Title: '100% Local Privacy',
    card1Desc: 'No sign-up, no analytics trackers, and your libraries live strictly on your own disk unless you choose optional cloud backup.',
    card2Title: 'Original Resolution & Dedupe',
    card2Desc: 'Capture full-resolution galleries and videos, then automatically detect duplicate albums or lower-resolution copies.',
    card3Title: 'Smart Highlights & Scrubber',
    card3Desc: 'Spot peak moments visually on the timeline scrubber or browse them effortlessly inside the vertical Shorts feed.',
    card4Title: 'Open-Auditable Desktop + Web',
    card4Desc: 'Inspect the source code on GitHub, launch the portable IMAGEX.exe, or run straight from Python.',
    installHeading: 'Install in 60 seconds (and why SmartScreen appears)',
    installSubheading: 'Transparent instructions so you know exactly what you are running on Windows.',
    step1Title: '1. Download & Extract',
    step1Desc: 'Grab IMAGEX-Windows.zip from GitHub Releases and extract the folder anywhere on your PC.',
    step2Title: '2. Run IMAGEX.exe',
    step2Desc: 'Because independent builds do not buy an expensive corporate signing certificate yet, Windows SmartScreen may show a warning. Click "More info" -> "Run anyway", or verify the public CI workflow that built the binary.',
    step2BuildLogs: 'View GitHub Actions Build Logs ->',
    step3Title: '3. Optional Python / Chromium',
    step3Desc: 'Prefer running from source, or need full browser-backed extraction? Run python -m playwright install chromium and python -m src.main directly from the repo.',
    communityHeading: 'Free forever. Sustained by the community.',
    communityDesc:
      'IMAGEX never locks features behind paywalls or ads. Join our English-first Discord (with a dedicated #pt-br-chat channel) to request features, share setup tips, or donate voluntarily to keep development moving.',
    communityPendingNotice:
      'Community and donation links are being finalized — check GitHub Releases for updates or add your URLs in website/config.js.',
    donateSecondaryLabel: 'Alternative Support',
    footerLicense: 'IMAGEX • Proprietary Source-Available Desktop & Local Web Suite.',
  },
  'pt-BR': {
    pageTitle: 'IMAGEX — Timeline Privada Local, Smart Shorts e Web Stream',
    navFeatures: 'Recursos',
    navQuickStart: 'Instalar & Segurança',
    navCommunity: 'Comunidade',
    navDownload: 'Baixar Grátis',
    heroEyebrow: '100% Gratuito • Roda Localmente no Windows e Celular (Wi-Fi)',
    heroTitle: 'Uma timeline privada para seus criadores, galerias e vídeos.',
    heroSubtitle:
      'Chega de dezenas de abas abertas e pastas bagunçadas. Reúna seus feeds favoritos localmente, assista via Web Stream ocupando 0 MB no disco e pule direto para os melhores momentos no Smart Shorts.',
    ctaDownload: 'Baixar para Windows',
    ctaDownloadMetaFallback: 'Última Release no GitHub • ZIP Portátil',
    ctaCommunity: 'Entrar na Comunidade',
    ctaDonate: 'Apoiar o Projeto',
    ctaSource: 'Ver Código no GitHub',
    previewLabel: 'Prévia interativa do aplicativo',
    tabTimeline: 'Timeline Unificada',
    tabShorts: 'Smart Shorts',
    tabStream: 'Web Stream (0 MB)',
    tabMobile: 'Celular via Wi-Fi',
    panelTimelineBadge: 'Profile Hub • Início Limpo',
    panelTimelineTitle: 'Seus criadores e lotes locais em um só feed',
    panelTimelineDesc:
      'Adicione links de criadores ou lotes locais quando quiser. Filtre por fonte, explore perfis sem sair da tela e escolha exatamente o que salvar.',
    panelShortsBadge: 'Detecção de Clímax Ouro / Prata / Bronze',
    panelShortsTitle: 'Pule direto para os melhores momentos',
    panelShortsDesc:
      'Player vertical 9:16 com marcadores automáticos de destaque (15s, 30s ou 60s), áudio contínuo ao rolar e pré-carregamento inteligente.',
    panelStreamBadge: 'Sem Lotar o SSD',
    panelStreamTitle: 'Organize e assista ocupando 0 MB no disco',
    panelStreamDesc:
      'Salve vídeos como Web Stream com zero peso no HD, renove links expirados automaticamente ou baixe álbuns em resolução máxima original.',
    panelMobileBadge: 'Servidor no PC -> Navegador do Celular',
    panelMobileTitle: 'Use deitado no celular pela sua rede Wi-Fi local',
    panelMobileDesc:
      'Inicie o IMAGEX no Windows e acesse http://<SEU_IP>:8100 pelo navegador do celular na mesma rede — sem subir nada para nuvem de terceiros.',
    whyHeading: 'Feito para privacidade, velocidade e organização',
    whySubheading: 'Tudo roda no seu próprio aparelho, sem cadastro, sem rastreadores e sem assinatura obrigatória.',
    card1Title: 'Privacidade 100% Local',
    card1Desc: 'Zero login, zero telemetria oculta e seus arquivos ficam apenas no seu disco, a menos que você ative backup opcional.',
    card2Title: 'Resolução Máxima & Anti-Duplicatas',
    card2Desc: 'Extraia álbuns e vídeos na qualidade original e limpe coleções repetidas ou cópias de baixa resolução automaticamente.',
    card3Title: 'Destaques Inteligentes na Barra',
    card3Desc: 'Veja os picos do vídeo na barra do player ou navegue direto pelos melhores trechos no feed vertical de Shorts.',
    card4Title: 'Código Auditável no GitHub',
    card4Desc: 'Confira o código-fonte aberto para auditoria, baixe o IMAGEX.exe portátil ou execute direto via Python.',
    installHeading: 'Instale em 60 segundos (e entenda o aviso do Windows)',
    installSubheading: 'Transparência total antes de abrir qualquer executável no seu PC.',
    step1Title: '1. Baixe e Extraia',
    step1Desc: 'Baixe o IMAGEX-Windows.zip nas Releases do GitHub e extraia a pasta em qualquer local do Windows.',
    step2Title: '2. Execute o IMAGEX.exe',
    step2Desc: 'Como projetos independentes ainda não compram certificado pago da Microsoft, o Windows SmartScreen pode avisar. Clique em "Mais informações" -> "Executar mesmo assim", ou confira o workflow público do GitHub Actions que compilou o arquivo.',
    step2BuildLogs: 'Ver logs de compilação no GitHub Actions ->',
    step3Title: '3. Python / Chromium Opcional',
    step3Desc: 'Prefere rodar direto pelo código-fonte ou usar recursos com navegador automatizado? Execute python -m playwright install chromium e python -m src.main.',
    communityHeading: 'Gratuito para sempre. Mantido pela comunidade.',
    communityDesc:
      'O IMAGEX nunca trava funções atrás de assinatura ou anúncios. Entre no nosso Discord principal em inglês (com canal dedicado #pt-br-chat) para sugerir recursos, tirar dúvidas ou doar voluntariamente para manter o projeto ativo.',
    communityPendingNotice:
      'Os links da comunidade e de doação estão sendo finalizados — acompanhe as Releases do GitHub ou preencha website/config.js.',
    donateSecondaryLabel: 'Outra Forma de Apoio',
    footerLicense: 'IMAGEX • Suíte Desktop e Web Local Source-Available.',
  },
};
