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

## v0.2 — Fidelidade visual & Cor (atual)

- ✅ **Ordem de camadas e blocos por cor**: tecelagem sequencial contínua (`layered`) com rollover dinâmico para atingir metas de 10.000 cordas
- ✅ **Pré-processamento para retratos**: elevação de sombras (`shadowLift`) e mapa de importância por bordas/feições faciais (`edgeEmphasis`)
- ✅ **Preset CMYK clássico**: síntese subtrativa (Ciano, Magenta, Amarelo, Preto) com proporção ponderada para o preto final
- ✅ **Prevenção de paradas prematuras**: controle de parada opcional e aviso/sugestão dinâmica de `maxChordRepeats >= 2`
- ✅ **Modo tecelagem guiado por camadas**: anúncios de voz inteligentes ao trocar de cor e instruções agrupadas
- 🔜 **Modelo de distância de observação**: simular em alta resolução e comparar o alvo em
  resolução reduzida/desfocada (percepção), como em Birsak et al. (2018)
- 🔜 **Refinamento global**: após o guloso, passes de remoção/troca de cordas que reduzam o erro
  (mantendo a continuidade do fio)
- 🔜 **Calibração**: fotografar um trecho tecido para estimar largura aparente/opacidade do fio e
  as cores reais dos fios
- 🔜 Métricas perceptuais (SSIM / erro em CIELAB) além do RMSE linear
- 🔜 Penalidade opcional por comprimento de fio (aproximar 1–2 km para 3–4 mil cordas, como Vrellis)
- 💡 Equalização local de contraste (CLAHE) como opção

## v0.3 — Otimização avançada de cor

- 🔜 Seleção automática de paleta personalizada (k cores a partir da imagem)
- 💡 Modelo óptico de mistura por meio-tom (cores vizinhas que se fundem a distância)

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
