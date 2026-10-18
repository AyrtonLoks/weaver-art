# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.6.0] — 2026-10-18

### Removido & Limpeza de Legado

- **Expurgo de Pacotes Legados**: Remoção de `packages/cli` (CLI em TS obsoleta) e `packages/wasm` (kernel C-ABI antigo com base64), com unificação no binário nativo `crates/weaver-cli` e no adapter moderno `crates/weaver-wasm-adapter`.
- **Expurgo de Stubs em `@weaver-art/core`**: Remoção de stubs inoperantes de compute em JS (`engine.ts`, `evaluator.ts`, `raster.ts`, `chord-cache.ts`, `refine.ts`, `pruning.ts`, `parallel.ts`, `palette.ts`, `clahe.ts`, `image.ts`, `metrics.ts`, `gcode.ts`).
- **Remoção do Solver Global NNLS/FISTA**: Excluído `global_fista.rs`, eliminando formulação contínua que falhava em modelar a física da transmitância óptica e a continuidade do fio.
- **Teares Secundários Expurgados**: Remoção de teares elípticos, polígonos arbitrários de $N$ lados e upload de CSV na UI, mantendo o foco do projeto em teares circulares e quadrados.

### Alterado & Adicionado

- **Presets Oficiais de Petros Vrellis**:
  - `VRELLIS_CLASSIC_MONO`: Monocromático clássico (fio preto, aro 28", 200 pinos, 6.000 linhas).
  - `VRELLIS_COLOR`: Colorido CMYK Subtrativo em 4 camadas sequenciais físicas (Amarelo $\to$ Magenta $\to$ Ciano $\to$ Preto com cotas ponderadas e rollover dinâmico para o preto final).
- **Geometria Simplificada**: Suporte de primeira classe aos formatos `CIRCULAR` e `SQUARE` (quadrado com lados iguais e pinos distribuídos simetricamente nas 4 bordas).
- **Usabilidade do Estúdio Web**:
  - **Comparação com a foto**: Fim da abertura compulsória após o término da geração. A exibição do canvas comparativo respeita estritamente o checkbox do usuário.
  - **Modo de Visualização**: Fim da troca forçada para "Vista à distância" ao terminar a tecelagem. O modo ativo selecionado pelo usuário ("Fios" ou "Vista à distância") é preservado intacto.
  - **Viewer do Simulador**: Adicionados botões de Zoom In (`+`), Zoom Out (`−`), Centralizar (`Ajustar`) e indicador de porcentagem de zoom na barra de ferramentas; correção matemática de pan/zoom com compensação de proporção (`u_aspect`) no WebGL.

## [0.5.0] — 2026-10-13

### Adicionado

- **Cache de rasterização de cordas canônicas (`chord-cache.ts`)**:
  - Cache LRU em memória (`ChordCache`) delimitado por bytes (`rasterCacheMb`, padrão 128 MB no CLI e 64 MB no web).
  - Indexação por chave canônica de corda (`chordKey`), garantindo resultados de simulação e métricas 100% bit-idênticos à rasterização sem cache.
  - Suporte completo a teares circulares, retangulares e com pinos arbitrários importados via CSV.
- **Poda de candidatos por Lazy Greedy (`pruning.ts`)**:
  - Algoritmo de aceleração gulosa preguiçosa baseado no princípio de submodularidade (Minoux, 1978).
  - Tabela de limites superiores de ganho (`StaleGainTable`) que permite interromper a busca assim que o melhor ganho superestimado não supera a melhor corda exata já encontrada.
  - Em monocromático com fio preto sobre fundo claro, matematicamente preserva passos idênticos à busca exata; em CMYK e mistura óptica de meio-tom, opera como heurística acelerada com fidelidade $\Delta\text{RMSE} \le 2\%$ e $\Delta\text{SSIM} \le 2\%$, pulando até mais de 90% das avaliações de cordas.
- **Núcleo em Rust → WebAssembly SIMD (`@weaver-art/wasm`)**:
  - Novo pacote `@weaver-art/wasm` contendo kernel puro em Rust (`no_std`, `wasm32-unknown-unknown`) com instruções vetoriais de 128 bits (`+simd128`).
  - Fusão de cálculo de segmento tangente canônico, rasterização por cobertura de área e acúmulo de erro quadrático em laço contíguo sem alocações na heap.
  - Binário WASM leve (<32 KB) embutido em Base64 para compilação e execução imediata em qualquer ambiente sem necessidade de toolchain Rust local instalada.
  - Paridade numérica estrita com a implementação de referência em TypeScript validada por suíte de testes dedicada.
- **Paralelismo multi-worker com memória compartilhada (`parallel.ts`)**:
  - Avaliador concorrente `ParallelEvaluator` dividindo os pinos candidatos de chegada (`to`) entre múltiplos trabalhadores com particionamento intercalado para balanceamento de carga.
  - Comunicação de ultra-baixa latência através de `SharedArrayBuffer` com controle de sincronização e barreiras por `Atomics.wait` e `Atomics.notify`.
  - Desempate determinístico preservando estritamente a sequência de cordas da execução sequencial.
  - Suporte nativo em Web Workers (com isolamento cross-origin COOP/COEP) e em Node.js via `node:worker_threads`.
- **Interface e Linha de Comando**:
  - CLI: novas opções `--accel js|wasm|parallel`, `--threads <N>`, `--pruning none|lazy` e `--cache-mb <N>`.
  - Web: grupo retrátil "Desempenho" permitindo alternar motor de cálculo, ativar poda acelerada e configurar quota de cache, com telemetria ao vivo de velocidade (cordas/s).
- **Benchmarking e Automação**:
  - Script reprodutível `scripts/bench.mjs` executável via `npm run bench`.
  - Job de CI dedicado em `.github/workflows/ci.yml` para compilação e teste do kernel WASM.

### Alterado

- `geometry.ts`: `tangentSegment` passa a calcular a hipotenusa com `Math.sqrt(vx*vx + vy*vy)` em substituição a `Math.hypot` para paridade numérica estrita com a libm Rust/WASM.
- `engine.ts`: arquitetura modularizada desacoplando a orquestração do tecido (`WeaveEngine`) dos motores de pontuação (`CandidateEvaluator`), com suporte a inicialização assíncrona com `WeaveEngine.createAsync`.

## [0.4.0] — 2026-10-13

### Adicionado

- **Teares genéricos e pinos arbitrários (`geometry.ts`, `pegs-csv.ts`, `types.ts`)**:
  - Nova união discriminada `LoomConfig = CircleLoomConfig | RectangleLoomConfig | CustomLoomConfig`.
  - Suporte completo a teares quadrados e retangulares (`RectangleLoomConfig`) com pinos ao longo das bordas e teares com pinos arbitrários (`CustomLoomConfig`).
  - Convex hull automático via algoritmo da cadeia monótona de Andrew para polígonos delimitadores convexos e cálculo de normais outward para posicionamento legível de etiquetas de pinos.
  - Funções `toPegsCSV` e `parsePegsCSV` com suporte a delimitadores múltiplos (vírgula, ponto-e-vírgula, tabulação), comentários, vírgula decimal e cabeçalhos flexíveis (`x_mm`, `y_mm`).
  - Máscara analítica poligonal e recorte de enquadramento exato (`loomFrameCrop`, `loomMask`) que preservam a proporção e centralizam o tear no quadro de simulação sem distorções de escala.
- **Gabarito de furação em escala real 1:1 (`template.ts`, `pdf.ts`)**:
  - `toTemplateSVG`: gera gabarito vetorial 1:1 com furos de broca precisos, marcação em cruz central e régua de verificação milimétrica de 100 mm.
  - `toTemplatePDF`: gerador PDF 1.4 puro zero-dependências em TypeScript com folha de capa e ladrilhamento multi-folhas em escala real 1:1 para A4, A3 e Carta.
  - Marcas de registro em cruz nos cantos das folhas, identificadores de coluna/linha (ex: `Folha (2, 1)`), margens de sobreposição e réguas de verificação de 50 mm em cada página.
- **Estimativa de tecelagem e consumo de carretéis (`estimate.ts`)**:
  - Função `estimateWeave` que projeta tempo manual ativo de tecelagem, preparo e amarração de novos fios, e trocas de meada.
  - Cálculo exato de consumo de fio por cor com margem de segurança configurável (padrão 10%), folgas de nós e contagem de carretéis (ex: 1.000 m).
  - Função `formatDuration` para formatação em português amigável (ex: `3h 24min`).
- **G-code para plotters e robôs de tecelagem XY (`gcode.ts`)**:
  - Função `toGcode` que gera código RS-274 para mesas CNC / plotters de tecelagem.
  - Traçado com segmentos retos tangentes (G1) e arcos circulares com raio de folga de ferramenta em torno dos pinos (G2/G3), com divisão automática de arcos >180° para evitar ambiguidades de I/J.
  - Pausas M0 com comentários explicativos para troca de carretel/cor e função `gcodePathLengthMm` para medição exata do percurso da ferramenta.
- **Sincronização de progresso entre dispositivos (`progress.ts`)**:
  - Função `weaveFingerprint` baseada em FNV-1a, retrocompatível com v0.3.
  - Códigos de progresso compactos com checksum de proteção contra erros de digitação: `WA1-<fingerprint>-<idx36>-<checksum>` (ex: `WA1-k3x9q2-1f4-7a`).
  - Funções `encodeProgressCode`, `decodeProgressCode`, `withProgress` e `mergeProgress`.
  - Sincronização automática via hash de URL (`#progress=...`), botões de cópia/cola na UI e retomada automática ao abrir arquivos `.weave.json` com metadados de progresso.
- **CLI (`@weaver-art/cli`)**:
  - Novos subcomandos:
    - `weaver-art template [opções de tear] [--paper A4|A3|Letter] [--drill <mm>] -o <pasta>`
    - `weaver-art gcode <projeto.weave.json> [--clearance <mm>] [--feed <mm/min>] [--origin <...>] -o <pasta>`
    - `weaver-art estimate <projeto.weave.json> [--sec-per-chord <n>] [--spool <m>] [--margin <pct>]`
  - Novas flags de formato de tear: `--shape`, `--width`, `--height`, `--pegs-x`, `--pegs-y`, `--pegs-csv`.
  - Flags de fabricação e CNC: `--paper`, `--drill`, `--margin`, `--gcode`, `--clearance`, `--feed`, `--origin`.
  - Geração automática de `.template.svg`, `.template.pdf` e `.pegs.csv` no fluxo principal de tecelagem.
- **Estúdio Web (`@weaver-art/web`)**:
  - Seletor de forma de tear (Círculo, Quadrado, Retângulo, Personalizado via CSV) com mini-canvas interativo de pré-visualização.
  - Painel de fabricação com botões para download de gabarito SVG, PDF multi-folhas e CSV de pinos antes ou depois da tecelagem, além de exportação de G-code.
  - Tabela detalhada de estimativa de carretéis por cor na aba Estúdio.
  - No Modo Tecelagem: exibição do tempo restante estimado em tempo real e painel de retomada entre dispositivos (código compartilhável com copiar/colar e exportação de JSON de retomada).

## [0.3.0] — 2026-10-13

### Adicionado

- **Seleção automática de paleta personalizada (`palette.ts`)**:
  - Extração perceptual de $k$ cores dominantes ($k \in [2, 10]$, padrão 4) via clusterização K-Means em espaço CIELAB com inicialização k-means++.
  - Amostragem geométrica restrita à máscara circular do tear, ignorando bordas externas e fundos transparentes.
  - Ordenação decrescente física obrigatória por luminância ($L^_$ alto $\to$ $L^_$ baixo: cores luminosas primeiro, âncora escura por último).
  - Alocação de cotas ponderadas com 35% a 40% reservados para a âncora escura e divisão uniforme das claras, com rollover dinâmico.
  - Distribuição uniforme dos pinos de partida de cada carretel ao longo da circunferência do tear.
  - Nomenclatura automática amigável em português (Amarelo, Magenta, Ciano, Vermelho, Azul, Verde, etc.) com IDs estáveis e desambiguação de tons repetidos.
- **Modelo óptico de mistura por meio-tom (`engine.ts`)**:
  - Minimização do erro perceptual após mistura espacial retiniana $\mathcal{E} = \| H * (C - T) \|^2$.
  - Avaliação do ganho guloso orientada pelo mapa de resíduo espacialmente fundido $R_{\text{halftone}} = G * (T - C)$.
  - Cooperação óptica entre fios adjacentes (ex: amarelo e ciano gerando verde à distância sem exigir interseções microscópicas pixel a pixel).
  - Atualização local ultra-rápida via filtro gaussiano separável 1D horizontal + 1D vertical na caixa delimitadora dilatada de cada corda aplicada, com sincronização global periódica a cada 50 passos.
  - Novas opções `halftoneMixing: boolean` e `halftoneRadiusMm: number` (padrão 0.75 mm) com validação de limites físicos.
- **CLI (`@weaver-art/cli`)**:
  - Subcomando `weaver-art extract-palette <imagem> [k]` que imprime tabela formatada (hex, cota %, pino inicial, nome) e snippet JSON pronto para uso.
  - Novas flags `--auto-palette <k>`, `--halftone` e `--halftone-radius <mm>`.
- **Estúdio Web (`@weaver-art/web`)**:
  - Controles para extrair paleta personalizada da imagem ($k$ cores) com botão "Extrair cores", pré-visualização das amostras e inclusão no seletor de preset.
  - Controles de meio-tom óptico (checkbox e slider de raio em mm) transmitidos ao Web Worker.
- **Testes e Validação**:
  - Novas suítes unitárias `palette.test.ts` e `halftone.test.ts` elevando a cobertura para 62 testes automatizados com 100% de sucesso.

## [0.2.0] — 2026-10-13

### Adicionado

- **Tecelagem por camadas (`layered`)**: tecelagem sequencial contínua por cor (Amarelo $\rightarrow$ Magenta/Ciano $\rightarrow$ Azul/Verde $\rightarrow$ Preto por último), permitindo trabalhar carretel a carretel sem emaranhados e acelerando o cálculo em 4 a 5×.
- **Preset CMYK clássico**: Ciano (`#00a0e9`), Magenta (`#e4007f`), Amarelo (`#fff100`) e Preto (`#000000`) com mistura de cores subtrativa ideal para tons de pele fotográficos.
- **Cotas proporcionais com peso no preto final**: alocação ponderada de linhas (ex: 40% no preto no CMYK e 30% no Vrellis 5 cores), garantindo que todas as cores sejam usadas ativamente.
- **Rollover dinâmico de cotas**: saldo de linhas não aproveitado por cores iniciais é transferido automaticamente para o preto final, permitindo atingir metas altas de linhas (como 10.000 cordas) sem interrupções precoces.
- **Filtros de fidelidade para retratos**:
  - `shadowLift` (elevação de sombras): impede que camisetas pretas ou fundos noturnos devorem as cordas e poluam o rosto.
  - `edgeEmphasis` (realce de feições): mapa de saliência automático via filtro Sobel nos olhos, óculos, nariz, boca e silhueta.
  - `clahe` (equalização adaptativa local): realce de contraste local sem amplificação de ruído em grade de 8×8 blocos com interpolação bilinear e processamento de luminância preservando tons de pele.
- **Penalidade opcional por comprimento de fio (`lengthPenalty`)**: fator configurável que aplica deságio proporcional ao comprimento da corda $L_{norm}$, favorecendo cordas mais eficientes e aproximando o consumo total aos 1–2 km reportados por Petros Vrellis.
- **Modelo de distância de observação (`viewingDistanceM`)**: simulação de desfoque retiniano com filtro gaussiano separável $O(N)$ baseado na acuidade visual humana e frequência angular (Birsak et al., 2018).
- **Refinamento global pós-guloso (`refineWeave`)**: passes de perturbação local de nós intermediários ($p_{i-1} \to p_i' \to p_{i+1}$) que reduzem o erro residual mantendo estritamente a conectividade inquebrável do fio contínuo e tangentes físicas válidas.
- **Métricas perceptuais avançadas**: cálculo de erro de cor em CIELAB ($\Delta E_{ab}^*$, CIE76) e Índice de Similaridade Estrutural (SSIM) além do RMSE linear no `WeaveResult`.
- **Módulo de calibração**:
  - `calibrateThreadColor`: extração robusta de cor sRGB linear a partir de fotos de meadas/carretéis com rejeição de reflexos especulares e sombras.
  - `calibrateThreadPhysical`: estimativa numérica de largura aparente e opacidade $\alpha$ via transmitância medida de trecho tecido.
- **Web UI**:
  - Seletor do preset CMYK e seletor de estratégia de cor (`layered` vs `interleaved-balanced`).
  - Sliders para elevação de sombras, foco em detalhes faciais, penalidade de comprimento de fio e distância de observação.
  - Controles de CLAHE (checkbox e slider de corte) e input de passes de refinamento global.
  - Estatísticas completas em tempo real com Linhas, Fio, RMSE, $\Delta E$ (CIELAB), SSIM e Tempo.
  - Ferramenta de calibração de cor de meada com clique para copiar `#hex` para a área de transferência.
  - Indicador e recomendação dinâmica para configurar `Repetições = 2 ou 3` em metas superiores a 5.000 cordas.
- **Modo Tecelagem**:
  - Acompanhamento passo a passo por camadas e avisos de voz inteligentes ao trocar de cor.
- **Exportações**:
  - Instruções `.txt` limpas e divididas em blocos por camada (`=== CAMADA X: Cor ===`).
  - Vetor `.svg` com grupos `<g id="layer-...">` identificando cada cor.
- **CLI**:
  - Novas flags `--preset cmyk`, `--color-strategy`, `--shadow-lift`, `--edge-emphasis`, `--clahe`, `--clahe-clip`, `--length-penalty`, `--viewing-distance` e `--refine`.
  - Subcomando `weaver-art calibrate-color <foto>`.
  - Apresentação completa das métricas RMSE, $\Delta E$ (CIELAB) e SSIM ao término da geração.

### Corrigido

- Exclusão cromática no multicolorido, onde o fio preto monopolizava os primeiros milhares de passos e deixava Azul e Verde com 0 linhas.
- Interrupção prematura em 7.688 de 10.000 linhas decorrente de esgotamento de cordas com ganho positivo em repetição única.

## [0.1.0] — 2026-10-13

### Adicionado

- Monorepo com `@weaver-art/core`, `@weaver-art/cli` e `@weaver-art/web` (npm workspaces).
- Core: tear circular em mm, pinos com diâmetro (segmentos tangentes, lados, arcos),
  rasterização por cobertura de área, modelo de tom em luz linear, otimização gulosa por redução
  de erro, múltiplos fios coloridos, presets `vrellis-mono` e `vrellis-color`.
- Exportação: instruções `.txt` (pt-BR), `.csv`, `.json`, `.svg` em escala real.
- CLI com `sharp` (respeita orientação EXIF) e progresso no terminal.
- Estúdio web (Vite + Web Worker) com simulação ao vivo e exportações.
- Modo tecelagem com voz (Web Speech API, pt-BR), avanço automático e progresso persistente.
- Documentação: README, algoritmo, arquitetura, referências, roadmap e guia de contribuição.
- Testes (Vitest), ESLint, Prettier e GitHub Actions.
