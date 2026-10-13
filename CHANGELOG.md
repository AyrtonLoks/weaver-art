# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.2.0] — 2026-10-13

### Adicionado

- **Tecelagem por camadas (`layered`)**: tecelagem sequencial contínua por cor (Amarelo $\rightarrow$ Magenta/Ciano $\rightarrow$ Azul/Verde $\rightarrow$ Preto por último), permitindo trabalhar carretel a carretel sem emaranhados e acelerando o cálculo em 4 a 5×.
- **Preset CMYK clássico**: Ciano (`#00a0e9`), Magenta (`#e4007f`), Amarelo (`#fff100`) e Preto (`#000000`) com mistura de cores subtrativa ideal para tons de pele fotográficos.
- **Cotas proporcionais com peso no preto final**: alocação ponderada de linhas (ex: 40% no preto no CMYK e 30% no Vrellis 5 cores), garantindo que todas as cores sejam usadas ativamente.
- **Rollover dinâmico de cotas**: saldo de linhas não aproveitado por cores iniciais é transferido automaticamente para o preto final, permitindo atingir metas altas de linhas (como 10.000 cordas) sem interrupções precoces.
- **Filtros de fidelidade para retratos**:
  - `shadowLift` (elevação de sombras): impede que camisetas pretas ou fundos noturnos devorem as cordas e poluam o rosto.
  - `edgeEmphasis` (realce de feições): mapa de saliência automático via filtro Sobel nos olhos, óculos, nariz, boca e silhueta.
- **Web UI**:
  - Seletor do preset CMYK e seletor de estratégia de cor (`layered` vs `interleaved-balanced`).
  - Sliders para elevação de sombras e foco em detalhes faciais.
  - Checkbox para controle de parada prematura (`stopWhenNoImprovement`).
  - Indicador e recomendação dinâmica para configurar `Repetições = 2 ou 3` em metas superiores a 5.000 cordas.
- **Modo Tecelagem**:
  - Acompanhamento passo a passo por camadas e avisos de voz inteligentes ao trocar de cor.
- **Exportações**:
  - Instruções `.txt` limpas e divididas em blocos por camada (`=== CAMADA X: Cor ===`).
  - Vetor `.svg` com grupos `<g id="layer-...">` identificando cada cor.
- **CLI**:
  - Novas flags `--preset cmyk`, `--color-strategy`, `--shadow-lift` e `--edge-emphasis`.

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
