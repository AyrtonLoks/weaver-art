# Diretrizes para Agentes de IA — Weaver Art

Este arquivo estabelece os princípios fundamentais, regras físicas, matemáticas e arquiteturais que qualquer modelo de IA deve respeitar ao trabalhar ou estender o código deste projeto.

## 1. Filosofia e Contexto do Projeto

Weaver Art reproduz computacionalmente as obras de arte de fios (_string art_ ou _algorithmic knitting_) de Petros Vrellis. Diferente de geradores simplistas que apenas traçam linhas em pixels, o Weaver Art modela o **objeto físico real**:

- Dimensões reais em milímetros (`mm`), diâmetro dos pinos com tangentes e arcos, espessura e opacidade do fio.
- Modelo físico de transmitância em luz linear: $T = \prod (1 - \alpha c_i)$, onde o tom escurece com densidade E interseções.

## 2. Invariantes Matemáticas e de Cor

- **Competição Cromática e Ordem de Camadas**:
  - O fio preto ($K=[0,0,0]$) tem ganho matemático MSE 3× maior sobre fundo branco que fios coloridos. **Nunca deixe fios coloridos competirem livremente contra o preto sem cotas ou camadas**, caso contrário ocorrerá exclusão total de cores (fome de azul/verde).
  - Em presets coloridos, a estratégia padrão deve ser **Camadas Sequenciais (`layered`)**. A ordem física obrigatória é: cores luminosas primeiro (Amarelo $\rightarrow$ Magenta/Ciano $\rightarrow$ Azul/Verde) e **Preto por último** (para definir sombras e contornos sem apagar as cores de baixo).
  - Sempre forneça cotas ponderadas com maior peso no preto final (ex: 40% preto no CMYK, 30% no Vrellis 5 cores) e **rollover dinâmico** de saldo para o preto caso cores anteriores atinjam limite de ganho.
- **Atingimento de Metas de Linhas e Repetições**:
  - Um tear circular com 200 pinos possui apenas ~16.500 pares de pinos possíveis, dos quais apenas ~7.500 cruzam a figura.
  - Para metas altas ($\ge 5.000$ cordas, ex: 10.000 cordas), configure `maxChordRepeats >= 2` ou `3`. Se `maxChordRepeats = 1`, o motor ficará sem cordas úteis com ganho positivo e parará prematuramente.
- **Fidelidade de Retratos e Prevenção do "Buraco Negro"**:
  - Em retratos com roupas ou fundos pretos, sempre use **`shadowLift`** ($0.10$ a $0.15$) para evitar que o tronco consuma milhares de linhas e suje o rosto com retas transversais.
  - Use **`edgeEmphasis`** ($0.40$ a $0.60$) com mapa de saliência Sobel para forçar a concentração de cordas nas feições finas (olhos, óculos, nariz, boca e silhueta).

## 3. Invariantes de Código e Arquitetura

- **`@weaver-art/core` deve permanecer puro**: Zero dependências de runtime, sem DOM, sem `fs`, sem `Buffer`. Deve rodar perfeitamente em Node, Web Workers e testes.
- **Convenção de Unidades**:
  - Grandeza física $\rightarrow$ `mm` (ex: `diameterMm`, `pegRadiusMm`, `widthMm`, `totalLengthMm`).
  - Grandeza discreta de simulação $\rightarrow$ sufixo `Px` (ex: `resolutionPx`, `widthPx`).
- **Verificação Obrigatória**:
  - Antes de concluir qualquer tarefa, execute `npm run check` (typecheck + eslint + prettier + vitest) e `npm run build`. Todos os testes devem passar com 0 erros.
