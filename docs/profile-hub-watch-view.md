# Vídeo aberto, relacionados e comentários progressivos

O clique explícito num vídeo do feed/perfil/playlist abre `TimelineWatchView`.
O player reutiliza `TimelinePostCard`, inicia inline, transfere tempo/mute/qualidade
e streams já descobertos, e mantém o vídeo no topo durante a rolagem. A animação
usa FLIP/WAAPI e as preferências de movimento do app/sistema. O feed/perfil fica
montado e suspenso; transporte nativo/HLS e requisições antigas são cancelados.
Voltar preserva contexto, scroll e foco. Relacionados transitórios não são inseridos
no snapshot, favoritos ou biblioteca.

Abaixo ficam título, descrição, autor disponível, reações confirmadas, comentários
e relacionados. Reações são leitura da origem, sem votação simulada. Dislikes não
publicados continuam desconhecidos. Fullscreen tem entrada/saída e tenta paisagem
pela API real; rejeição não vira falsa rotação. Orientação é liberada ao sair.

## Rotas e donos

`profile_hub_comments.router` inclui o router importável de `profile_hub_watch.py`:

- `GET /api/profile-hub/video-details?url=...`: detalhes/reações públicos.
- `GET /api/profile-hub/related?url=...`: relacionados ordenados da página daquele
  vídeo, com identidade, URL, título e campos opcionais. `complete:false` não
  promete o catálogo inteiro de recomendações.
- `GET /api/profile-hub/comments-page?url=...[&cursor=...][&parent_id=...]`:
  raízes ou uma thread independente. `entries` é uma lista plana com `id`,
  `parent`, texto e metadados; `next_cursor` é opaco. `reported_total` é da fonte.

O endpoint antigo `/comments` continua compatível e limitado; o viewer **e a
gaveta do feed** usam o caminho progressivo. `SourceComments` compartilha o
renderer, expansão, cancelamento e recuperação. Não existe compositor.

A capacidade de comentários e relacionados depende do conector.
Canonical/og:url ou videoDetails.videoId precisam confirmar o vídeo. Redirects de
continuação não podem trocar proprietário/consulta. Transporte público reutiliza
DNS validado/conexão fixada e limites de corpo/prazo, incluindo espera na fila.

Detalhes e relacionados simultâneos compartilham uma única leitura em andamento.
Não há cache de resultado antigo; cancelar um consumidor preserva o outro,
cancelar o último encerra o trabalho. A fila tem orçamento técnico explícito.

## Paginação e precisão

- Até 40 itens novos por resposta é orçamento técnico, **não corte no total**.
  Continuações remotas e excedentes do mesmo HTML recebem novos cursores.
- Quando a fonte expõe continuações, o leitor segue as páginas e threads na ordem publicada. Identidade, tipo e ordem ficam vinculados ao cursor.
- HTML entregue integralmente é dividido para a UI. Completo exige contagem
  declarada correspondente e parentesco válido. Ausência de próximo link sozinha
  não fabrica completude. Tombstones públicos de removidos permanecem visíveis;
  conteúdo apagado não é recuperado.
- Likes abreviados como `1.2K` não são promovidos a números exatos inventados.
  Zero literal permanece zero; ausente permanece desconhecido.
- `reply_context_available` descreve a existência de uma thread/cursor acessível,
  separadamente de `reply_count`. Não oferecer uma expansão que só geraria 410
  nem inventar zero quando a contagem não foi publicada.
- Cursores ficam só em memória, expiram em 15 minutos e têm orçamento de payload
  de 64 MiB. Isso não é medição/limite do heap inteiro. Contexto HTML guarda IDs e
  parentesco, sem uma segunda cópia de todos os textos antigos. Corpo de replies
  pertence ao cache limitado. Não há gravação em biblioteca/cookies/disco.
- Retry reapresenta o mesmo cursor/resposta; falha preserva dados carregados.
  410 oferece reinício explícito dos comentários, incluindo threads, sem reiniciar
  o vídeo. Não se reinicia uma cadeia silenciosamente após expiração.

## Evidência e limites

Os testes exercitam paginação, carregamento no navegador, retomada após expiração do cursor e movimento reduzido. Esses cenários não medem o tempo de carregamento de todas as fontes.

## Continuação: proporção e histórico

No viewer, a proporção vem de videoWidth/videoHeight decodificados, com largura
integral e altura limitada ao orçamento existente de60dvh; fullscreen conserva
seu tamanho integral. Feed e dependências de transporte não mudam. A primeira
correção encolhia a largura por transferência aspect/maxheight; a captura
identificou alinhamento àesquerda e o ajuste final centraliza em contêiner w-full.
Em393x852, vídeoCSS393x509,19, preservando a imagem inteira.

Abertura cria entrada no histórico com UUID opaco, preservando URL e demais
chaves de history.state. Sessões ficam somente em memória. Relacionados reutilizam
a entrada; Back/botão/Escape retornam ao feed; Forward restaura somente sessão
conhecida. Recarregar marcador órfão não abre uma origem arbitrária. Listeners
são removidos e navegação para outra view encerra o viewer sem consumir sua rota.

`watch-portrait-final/results.json` e `watch-browser-final/results.json` contêm
40grupos cada, PT/EN e desktop/mobile, sem pageerrors. Incluem fullscreen real,
sticky, progressividade, Back/Forward/reload; horizontal inclui expiração410.
Revisão independente estática não encontrou achado restante após ajuste visual.
As capturas finais foram conferidas com CSSglobal. Não extrapolar para rotação
física/Safari ou concluir meta geral de latência pela geometria sintética.

As seis capturas posteriores do usuário apontam trabalho adicional de acesso a
relacionados no mobile, autor/perfis/métricas, apresentação dos comentários e
feedback/persistência das ações; checklist em audit-profilehub-2026-11-11/ui-checklist.md.
Esses pontos não foram declarados resolvidos pela correção de proporção/histórico.


## Continuação: seções acessíveis no celular

No viewer estreito (<768px medidos do componente), relacionados é a seção
inicial; botões bilíngues junto ao playersticky alternam comentários/relacionados.
Desktop mantém duas colunas. Painéis permanecem montados; hidden exclui o painel
inativo da navegação por teclado. SourceComments recebe active opcional (true
por padrão): páginas iniciais podem carregar, chamadas já iniciadas terminam,
mas callbacks pendentes/novas continuações de raízes e replies são bloqueados
quando ocultos. Troca não refaz dados do vídeo ou o transporte.

O teste de resize revelou remount no pai TimelinePreviewView: seus três ramos
recriavam ProfileTimelineView. O pai agora mantém um caminho React único,
preservando nós reais entre desktop, moldura e celular; wrappers display:contents
conservam as caixas visuais dos modos existentes. A revisão estática independente
não encontrou desvio material; o navegador confirmou identidade dos nós reais
em resize e botões de modo, sticky, Back/Forward,85raízes+2replies e cursor410.

Evidências: watch-sections-final/results.json (48grupos em4combinações),
watch-sections-portrait-final/results.json (52grupos, incluindo moldura em tela
desktop), section-calibration.json e preview-identity-calibration.json. Provas
isoladas detectaram ausência de active nas replies e uma key responsiva que
remontava a timeline; cópias removidas. São provas de um arquivo, sem resolver
imports/CSS/gestos físicos. Capturas finais separadas exercitam CSSglobal real.

## Dados de identidade: backend e fronteira frontend (etapa anterior)

Detalhes incluem `author_avatar_url`, `audience_count_text` e `audience_kind`. Comentários podem incluir `author_url`. Identidade e links do autor vêm do adaptador e precisam corresponder ao conteúdo aberto. A audiência usa o rótulo publicado pela fonte. Campos sem evidência permanecem ausentes.

Estado desta etapa anterior (o consumo visual foi concluído na seção seguinte):
Os parsers frontend preservam os campos e aceitam ausência no servidor antigo,
rejeitando URL insegura/credenciais e rótulos incoerentes. Ainda falta conectar
avatar/audiência à apresentação do viewer e links aos autores dos comentários.
Também continuam pendentes as métricas da página de perfil, polimento das
conversas, estados de contagens e açõespersistentes/feedback das seis capturas.


## Identidade agora visível — continuação

A etapa anterior de contratos foi conectada ao viewer e ao leitor compartilhado.
O criador mostra avatar40px, nome/link original e audiência literal da fonte,
com estados bilíngues de carregamento/falha/ausência. Nome, link e avatar de
fallback compartilham a mesma guarda: URL confirmada conflitante bloqueia todos
os dados antigos; nome novo sem URL não herda o perfil salvo. Avatar que falha
cai uma vez no SVG local, sem serviço externo ou nova resolução do vídeo.

Autores de comentários e replies usam seu próprio author_url. Nome é link
alcançável por teclado; avatar usa o mesmo destino sem duplicar parada noTab.
Campo ausente continua não interativo. Não são gerados perfis por nome/handle.
A alteração não cria compositor nem muda likes/heart, paginação ou gate active.

Evidência final do buildDt0EjCEF/CSSCksuiGUT:
- watch-identity-final:56grupos PT/ENdesktop/mobile, metadados retidos até após
  reprodução inicial, avatar real declarado, perfil aberto por teclado, roots e
  replies independentes, relacionados não herdam criador anterior.
- watch-identity-conflicts:56grupos, URL nova/sem nome e nome novo/sem URL.
- watch-identity-avatar-final:60grupos com404HTTP real, fallback uma vez,
  portrait e moldura; todos os três conjuntos sem pageerrors.
- O teste no navegador também verificou que metadados e links de comentários permanecem visíveis durante a reprodução de um vídeo sintético.

Revisão independente achou fallback de nome/link sem a guarda aplicada ao
avatar; corrigido e revisado novamente sem achado estático material. Prova em
cópia única detectou avatar do comentário apontando ao vídeo em vez do perfil
(identity-calibration.json); cópia removida. A prova de um arquivo não valida
imports, aparência, teclado ou aparelhos; navegador forneceu evidência separada.

Ainda não se afirma avatar/audiência principal de EP/PH quando o adaptador não
fornece campos confirmados, nem audiência na página de perfil por esta etapa.
Reações/estética das conversas, loading de contagens e operações persistentes de
salvar/favoritar/compartilhar continuam no escopo das seis capturas.


## Requisitos posteriores do usuário: corrigir interpretação anterior

Os testes antigos de link externo do criador e relatedsubstituindo mesma entrada
registram o comportamento implementado naquele momento. Usuário definiu depois:
perfil do criador abre DENTRO DO APP; descrição inicia recolhida; barra de seções
fica logo abaixo da descrição; relacionados exibem visualizações reais; Voltar
de um relacionado retorna ao vídeo anterior com contexto, antes de voltar aofeed.
Esses ajustes estão pendentes na checklist e prevalecem sobre critérios antigos.

Também entram curtida local e favoritos no viewer, playlists criadas/escolhidas
pelo usuário e área pessoal com histórico/curtidos/Favoritos/playlists. Flags
locais atuais não representam sistema de playlists nem persistência na biblioteca.
A localização desta área ainda precisa de proposta; nenhum requisito anterior foi
removido. A etapa corrente de reações/contagens permanece parcialmente validada,
com browser/async pendentes por revisão automática indisponível.
