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

## v0.2 — Fidelidade visual

- 🔜 **Modelo de distância de observação**: simular em alta resolução e comparar o alvo em
  resolução reduzida/desfocada (percepção), como em Birsak et al. (2018)
- 🔜 **Refinamento global**: após o guloso, passes de remoção/troca de cordas que reduzam o erro
  (mantendo a continuidade do fio)
- 🔜 **Calibração**: fotografar um trecho tecido para estimar largura aparente/opacidade do fio e
  as cores reais dos fios
- 🔜 Métricas perceptuais (SSIM / erro em CIELAB) além do RMSE linear
- 🔜 Penalidade opcional por comprimento de fio (aproximar 1–2 km para 3–4 mil cordas, como Vrellis)
- 💡 Pré-processamento orientado a retratos: detecção de rosto → mapa de importância automático
- 💡 Equalização local de contraste (CLAHE) como opção

## v0.3 — Cor

- 🔜 Seleção automática de paleta (k cores a partir da imagem) e ordem de camadas
- 🔜 Restrições de fabricação: trocar de fio o mínimo possível; blocos por cor
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
