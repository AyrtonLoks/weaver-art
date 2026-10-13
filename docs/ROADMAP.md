# Roadmap

Legenda: ✅ feito · 🔜 próximo · 💡 ideia

## v0.1 — Fundação (atual)

- ✅ Monorepo TypeScript (core, CLI, web), testes, lint, formatação, CI
- ✅ Tear circular em mm com pinos de diâmetro real (tangentes, lados, arcos)
- ✅ Rasterização por cobertura de área com largura real do fio
- ✅ Modelo de tom físico em luz linear; otimização gulosa por redução de erro
- ✅ Vários fios coloridos contínuos (paleta Vrellis)
- ✅ Exportação TXT / CSV / JSON / SVG 1:1 / PNG
- ✅ Estúdio web com Web Worker e pré-visualização ao vivo
- ✅ Modo tecelagem: próximo pino em destaque, voz pt-BR, avanço automático, progresso salvo

## v0.2 — Fidelidade visual & Cor (concluído)

- ✅ **Ordem de camadas e blocos por cor**: tecelagem sequencial contínua (`layered`) com rollover dinâmico para atingir metas de 10.000 cordas
- ✅ **Pré-processamento para retratos**: elevação de sombras (`shadowLift`) e mapa de importância por bordas/feições faciais (`edgeEmphasis`)
- ✅ **Preset CMYK clássico**: síntese subtrativa (Ciano, Magenta, Amarelo, Preto) com proporção ponderada para o preto final
- ✅ **Prevenção de paradas prematuras**: controle de parada opcional e aviso/sugestão dinâmica de `maxChordRepeats >= 2`
- ✅ **Modo tecelagem guiado por camadas**: anúncios de voz inteligentes ao trocar de cor e instruções agrupadas
- ✅ **Modelo de distância de observação**: simulação de desfoque retiniano com filtro gaussiano separável $O(N)$ baseado na acuidade visual humana (Birsak et al., 2018)
- ✅ **Refinamento global**: passes pós-gulosos de perturbação de nós intermediários ($p_{i-1} \to p_i' \to p_{i+1}$) que reduzem o erro residual preservando estritamente a continuidade do fio
- ✅ **Calibração**: extração robusta de cor sRGB linear de foto de meada com rejeição de reflexos/sombras e calibração física de largura/opacidade via transmitância
- ✅ **Métricas perceptuais**: erro em CIELAB ($\Delta E_{ab}^*$, CIE76) e Índice de Similaridade Estrutural (SSIM) além do RMSE linear
- ✅ **Penalidade opcional por comprimento de fio**: penalização ajustável proporcional ao comprimento da corda $L_{norm}$ para otimizar consumo de fio
- ✅ **Equalização local de contraste (CLAHE)**: algoritmo puro em TypeScript de contraste limitado adaptativo com interpolação bilinear contínua sem artefatos de borda de bloco

## v0.3 — Otimização avançada de cor (concluído)

- ✅ **Seleção automática de paleta personalizada**: extração perceptual de $k$ cores dominantes a partir da imagem via clusterização K-Means em espaço CIELAB (k-means++), amostragem restrita à máscara circular do tear, ordenação decrescente física por luminância (luz $\to$ sombra), cotas ponderadas com âncora escura e nomes automáticos em português
- ✅ **Modelo óptico de mistura por meio-tom**: modelagem de ponto óptico da retina humana ($G * (T - C)$), permitindo que cordas adjacentes de cores primárias/secundárias (ex: amarelo e ciano) se combinem oticamente em cores intermediárias (ex: verde) sem penalidades locais artificiais, com atualização local otimizada e validação completa

## v0.4 — Fabricação

- 🔜 Teares quadrados/retangulares e pinos em posições arbitrárias (importar CSV)
- 🔜 Folha de furação/gabarito do tear em SVG/PDF (posição dos pinos em escala real)
- 🔜 Estimativa de tempo de tecelagem e de consumo de fio por bobina
- 💡 Exportar G-code para máquinas/robôs de tecelagem
- 💡 Retomar a tecelagem em outro dispositivo (sincronizar progresso)

## Desempenho

- 🔜 Cache de rasterização das cordas mais usadas e poda de candidatos
- 💡 Núcleo em Rust → WebAssembly (SIMD) ou WebGPU para grades maiores
- 💡 Paralelismo: avaliar candidatos em vários Workers
