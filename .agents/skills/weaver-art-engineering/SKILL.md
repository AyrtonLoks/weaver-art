---
name: weaver-art-engineering
description: >-
  Expert guide for developing, tuning, profiling, and debugging Weaver Art string art algorithms,
  color strategies (CMYK, layered, interleaved), physical loom geometry, and portrait tone preprocessing.
---

# Weaver Art Engineering Skill

Use esta skill sempre que trabalhar na evolução do motor do Weaver Art, calibração de parâmetros de tecelagem, criação de novos presets, testes de desempenho ou exportação física.

## Procedimentos Comuns

### 1. Criar ou Calibrar um Novo Preset de Cores

1. Definir paleta no espaço sRGB e converter para linear via `hexToLinear()`.
2. Ordenar os fios da menor absorção/maior luminosidade para a maior absorção (fio preto sempre por último).
3. Atribuir cotas percentuais no `DEFAULT_OPTIONS` ou preset (garantindo 30% a 40% no fio escuro final).
4. Definir `colorStrategy: 'layered'` como padrão.
5. Adicionar o preset no `PRESETS` em `packages/core/src/config.ts`, no `main.ts` e no `index.html`.

### 2. Diagnosticar Problemas de Distribuição de Linhas

Se um padrão parar antes da meta ou apresentar cores desbalanceadas:

1. Verificar `maxChordRepeats`: se `lines > 5000`, certifique-se de que `repeats >= 2`.
2. Verificar `stepsPerThread`: inspecione `result.threads[i].lines`.
3. Se fios claros terminarem cedo por `gain <= 0`, verifique se o rollover para o fio preto está ativo.

### 3. Calibração Real de Fios e Cores

Para calibrar fios com base em amostras reais de carretel ou trechos tecidos:

1. **Amostra de carretel / meada**: fotografe o fio sob luz neutra e use `calibrateThreadColor()` ou o CLI:
   ```bash
   node packages/cli/dist/index.js calibrate-color amostra.jpg
   ```
2. **Transmitância e opacidade física**: use `calibrateThreadPhysical()` com a foto de um patch tecido e o número conhecido de cordas.

### 4. Avaliação de Fidelidade com Métricas Perceptuais

Ao ajustar parâmetros de tecelagem (resolução, CLAHE, penalidade de comprimento):

1. Avalie o erro de cor perceptivo **$\Delta E$ (CIELAB)** (ideal < 2.3 a 3.5 em retratos complexos).
2. Avalie o índice de similaridade estrutural **SSIM** (valores > 0.70 a 0.85 indicam excelente preservação facial).
3. Teste o impacto de `lengthPenalty` (0.1 a 0.25) no consumo total em metros sem degradar o SSIM.

### 5. Pipeline de Verificação Padrão

Sempre execute:

```bash
npm run check
npm run build
```
