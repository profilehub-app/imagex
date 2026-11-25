# IMAGEX v5.8.2

## Português

- Galerias de catálogo abrem diretamente a visualização dedicada de galeria a partir dos cards, links de álbum e títulos, exibindo fotos e metadados completos em ordem.
- O enriquecimento em segundo plano agora hidrata fotos em resolução original, contagem real de imagens, atribuição de autores e tags estruturadas também nas telas de entidade e nas demais guias do feed.
- A extração de metadados de álbuns ignora links de navegação configurados para evitar tags indevidas, e badges de contagem evitam marcações redundantes em itens únicos sem contagem confirmada.
- O registro de conectores passa a suportar descritores configuráveis de adaptadores nativos em `connectors.adapters.local.json` e nos padrões empacotados, preservando aliases, correspondência de domínios e origens canônicas sem expor configurações locais.

## English

- Catalog galleries now open directly into the dedicated gallery view from post cards, album grids, and titles, displaying full ordered photos and metadata.
- Background catalog enrichment now hydrates full-resolution photos, accurate photo counts, creator attribution, and structured tag entities across entity views and all feed tabs.
- Album metadata extraction respects configured ignored paths and album route segments to prevent navigation links from being tagged, and photo count badges avoid redundant labels on single-image items.
- The connector registry now supports configurable native adapter descriptors in `connectors.adapters.local.json` and bundled defaults, preserving aliases, domain matching, and canonical origins while keeping workstation configuration separate.
