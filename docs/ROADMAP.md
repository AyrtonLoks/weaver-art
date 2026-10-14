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

## v0.4 — Fabricação (concluído)

- ✅ **Teares quadrados/retangulares e pinos arbitrários**: suporte a `RectangleLoomConfig` e `CustomLoomConfig` via importação/exportação de CSV de pinos, detecção de convex hull e normais outward para etiquetas e roteamento físico de cordas.
- ✅ **Gabarito de furação em escala real 1:1**: exportação de SVG e PDF multi-folhas ladrilhadas (A4, A3, Carta) com marcas de registro em cruz, réguas de verificação milimétrica (100 mm e 50 mm) e furos com diâmetro de broca real.
- ✅ **Estimativa de tempo e carretéis**: cálculo de tempo ativo de tecelagem, preparo e trocas de meada, decomposição de carretéis necessários por cor (com margem de segurança configurável) e tempo restante dinâmico no reprodutor.
- ✅ **Exportação de G-code para máquinas/plotters XY**: comandos G1 para segmentos tangentes e G2/G3 para arcos ao redor dos pinos com raio de folga da ferramenta, divisão de arcos >180°, pausas M0 para troca de cor e cálculo exato de percurso.
- ✅ **Retomada e sincronização de progresso sem servidor**: códigos curtos compactos com checksum (`WA1-<fingerprint>-<step>-<checksum>`), sincronização via hash de URL (`#progress=...`), cópia/cola na interface e exportação/retomada em arquivos `.weave.json`.

## v0.5 — Desempenho (concluído)

- ✅ **Cache de rasterização de cordas canônicas (`ChordCache`)**: cache LRU delimitado por memória (128 MB padrão CLI, 64 MB web) armazenando coberturas antialiasing exatas indexadas por chave canônica independente do sentido da corda, bit-idêntico à rasterização direta.
- ✅ **Poda de candidatos por lazy greedy (`candidatePruning: 'lazy'`)**: aceleração baseada no princípio de monotonicidade submodular (Minoux, 1978) que usa o último ganho calculado como limite superior estrito para podar até 90%+ dos candidatos viáveis sem perda de fidelidade (passos idênticos em monocromático, $\Delta\text{RMSE} \le 2\%$ e $\Delta\text{SSIM} \le 2\%$ em CMYK/halftone).
- ✅ **Núcleo em Rust → WebAssembly SIMD (`@weaver-art/wasm`)**: pacote dedicado com kernel puro em Rust (`no_std`, `wasm32-unknown-unknown`) e vetorização SIMD de 128 bits (`+simd128`), fusão de rasterização e pontuação de ganho em laço único sem materialização intermediária, com paridade numérica estrita com a referência em TypeScript.
- ✅ **Paralelismo multi-worker com memória compartilhada (`ParallelEvaluator`)**: avaliação concorrente de candidatos dividida entre múltiplos Web Workers e threads Node (`worker_threads`) via `SharedArrayBuffer` e sincronização sem lock por barreira `Atomics`, com desempate determinístico reproduzindo passos idênticos à execução sequencial.
- 💡 **WebGPU**: mantido como ideia conceitual para exploração futura; o ganho de computação massiva em GPU atualmente é atenuado pela latência de sincronização síncrona exigida pelo algoritmo guloso estrito a cada corda em grades $\le 1600$ px.

## Próximas ideias (v0.6+)

- 💡 Poda de candidatos baseada em limiares de luminância local do alvo
- 💡 Exportação de instruções em áudio MP3 pré-renderizado por camada
- 💡 Algoritmo alternativo de tecelagem não-guloso por simulated annealing global
