# Weaver Art — Diretrizes para Agentes e Modelos de IA

Este repositório implementa arte computacional com fio contínuo em tear circular baseada na técnica de Petros Vrellis (_A new way to knit_, 2016).
Ao atuar em qualquer tarefa neste repositório, você DEVE seguir as diretrizes abaixo.

## 1. Invariantes Físicos e Matemáticos (NÃO VIOLAR)

1. **Unidades físicas em milímetros (mm):**
   - Todas as medidas do tear, pinos e fios usam mm (`diameterMm`, `pegDiameterMm`, `widthMm`, `segmentMm`, `wrapMm`).
   - Coordenadas de grade recebem obrigatoriamente o sufixo `Px`.
2. **Pinos como cilindros reais:**
   - Pinos possuem diâmetro real. O fio tangencia os pinos e possui lado explícito (`PegSide = 1 | -1`, correspondendo a anti-horário e horário).
   - O cálculo do comprimento do fio DEVE incluir a soma dos segmentos tangentes e os arcos contornados nos pinos (`wrapAngle`).
3. **Luz Linear:**
   - Cálculos de cobertura e erro ocorrem estritamente em luz linear (`sRGB` decodificado). Nunca calcule erro em valores sRGB com gama.
4. **Função Objetivo (Redução de Erro Quadrático):**
   - O motor escolhe a corda que maximiza a redução do erro quadrático ponderado $\Delta E = \sum w_p \delta_p (2(t_p - R_p) - \delta_p)$.
   - Nunca regrida para heurísticas ingênuas como "corda mais escura na média" ou subtração aditiva constante.
5. **Isolamento de `@weaver-art/core`:**
   - O pacote `packages/core` é agnóstico de plataforma e DEVE ter ZERO dependências de runtime.
   - Proibido importar `fs`, `path`, `Buffer`, APIs de DOM ou `sharp` dentro de `packages/core`.

## 2. Padrões de Ambiente e Qualidade

- **Node.js:** Versão $\ge 22.12$ obrigatória (conforme `.nvmrc`).
- **Antes de concluir qualquer tarefa ou commit:**
  1. `npm run typecheck` (todos os workspaces)
  2. `npm run lint` (ESLint flat config)
  3. `npm run format:check` (Prettier)
  4. `npm test` (Vitest com testes unitários)
- **Idioma:** Documentação e textos de interface em português (`pt-BR`); código, tipos e identificadores em inglês.

## 3. Guia de Execução das Próximas Tasks (Roadmap)

Ao ser solicitado a implementar tarefas do [docs/ROADMAP.md](docs/ROADMAP.md), siga estas especificações:

### Task: Modelo de Distância de Observação (Viewing Distance Filter)

- **Objetivo:** Simular o fio na grade fina (ex.: 800px) e avaliar o erro visual após aplicar filtro passa-baixa (Gaussian blur / downsample) para comparar como o olho humano percebe a 1-2 metros.
- **Local:** `packages/core/src/image.ts` e `engine.ts`.
- **Validação:** Manter teste de conservação de energia e redução monótona de erro em `packages/core/test`.

### Task: Refinamento Global (Post-Greedy Optimization)

- **Objetivo:** Após a fase gulosa, iterar removendo cordas com menor contribuição ou testando swaps de conexões que reduzam o erro total sem quebrar a continuidade do fio.
- **Local:** `packages/core/src/engine.ts`.
- **Restrição:** Manter a propriedade de fio único contínuo (cada corda parte de onde a anterior terminou).

### Task: Regularização de Comprimento do Fio

- **Objetivo:** Adicionar penalidade $\lambda \cdot \text{lengthMm}$ na função de ganho para aproximar a extensão total de 1,5 a 2 km para ~4000 cordas.
- **Local:** `WeaveOptions` e método `score()` em `engine.ts`.

### Task: Gabarito de Furação e Exportação para Fabricação

- **Objetivo:** Gerar SVG/PDF 1:1 com centro de furos, numeração e círculos de guia para marcar fisicamente no aro de alumínio/madeira.
- **Local:** `packages/core/src/export.ts` e CLI `--template`.

### Task: Calibração de Fio e Pinos

- **Objetivo:** Permitir ajuste fino dos coeficientes de opacidade e largura aparente a partir de fotografias de amostras reais tecidas.
