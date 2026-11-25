# Configuração de Comunidade, Apoio e Landing Page

O IMAGEX permite exibir links públicos de comunidade, doação e site do projeto
tanto no aplicativo (barra lateral e Configurações) quanto na página estática em
`website/`, sem embutir tokens privados nem expor URLs quebradas antes da publicação.

## 1. Variáveis do aplicativo (`frontend-mobile-preview`)

Apenas URLs públicas `https://` são aceitas em `communityConfig.ts`. Links em
branco, `http://` ou inválidos são ignorados automaticamente na interface.

- `VITE_GITHUB_REPO`: slug `dono/repositorio` usado nos fallbacks de atualização e
  botão de releases (padrão: `profilehub-app/imagex`).
- `VITE_PROMO_SITE_URL`: URL pública da landing page (ex.: `https://profilehub-app.github.io/imagex/`).
- `VITE_COMMUNITY_URL`: convite público da comunidade (ex.: Discord).
- `VITE_DONATE_URL`: link principal de apoio voluntário (ex.: Ko-fi em USD).
- `VITE_DONATE_SECONDARY_URL`: link secundário opcional `https://` (ex.: Buy Me a Coffee, GitHub Sponsors ou página hospedada em reais).

### Desenvolvimento local

Copie `frontend-mobile-preview/.env.example` para `frontend-mobile-preview/.env.local`,
preencha os links públicos desejados e execute `npm run build` (ou `npm run dev`).
Nunca envie `.env.local` para o repositório e nunca coloque chaves secretas em
variáveis `VITE_*`.

### Releases no GitHub Actions

Antes de publicar uma tag `v*` no GitHub, configure as variáveis correspondentes em
**Settings → Secrets and variables → Actions → Variables** no repositório. O workflow
`.github/workflows/build.yml` injeta essas variáveis na compilação do Vite e gera
`dist/IMAGEX.exe` + `IMAGEX-Windows.zip`.

## 2. Landing page estática (`website/`)

1. Edite `website/config.js` com `githubRepo`, `communityUrl`, `donatePrimaryUrl`
   e `donateSecondaryUrl`.
2. Para testar localmente (necessário usar HTTP local para módulos ES):
   ```powershell
   python -m http.server 8080 -d website
   ```
3. Para publicar gratuitamente no GitHub Pages: ative **Settings → Pages → Source: GitHub Actions**;
   o workflow `.github/workflows/pages.yml` publica `website/` automaticamente a cada push na `main`.
