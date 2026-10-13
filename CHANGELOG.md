# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

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
