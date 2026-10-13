# Algoritmo

Este documento descreve o modelo físico e matemático do Weaver Art. A implementação está em
[`packages/core/src`](../packages/core/src).

## 1. O objeto a reproduzir

Da descrição de Petros Vrellis para _A new way to knit_ (2016):

- tear circular: aro de alumínio de **28″** com **200 pinos** na circunferência;
- **um único fio** vai de pino a pino, continuamente, **3 000 – 4 000 vezes**, somando **1 – 2 km**;
- nada é tecido no interior do aro: o fio segue **cordas** do círculo;
- sem fio, o tom é branco; o tom **escurece com a densidade e com as interseções** do fio preto —
  paleta completa de cinzas;
- obras coloridas usam uma **paleta limitada** (preto, azul, magenta, amarelo e verde) cuja combinação
  produz uma paleta completa;
- a tecelagem é feita à mão, com **instruções passo a passo ditadas por um computador**;
- o padrão vem de um algoritmo próprio (openFrameworks/C++) que faz **mais de 2 bilhões de cálculos**.

Tudo o que segue tenta respeitar essas restrições físicas.

## 2. Geometria do tear — [`geometry.ts`](../packages/core/src/geometry.ts)

Unidades em **mm**, origem no canto superior esquerdo do quadrado que circunscreve o tear, eixo _y_
para baixo. O pino _i_ fica no ângulo `θᵢ = θ₀ + 2πi/N` sobre o círculo de raio `R = D/2`.
O pino 0 fica no topo (`θ₀ = −90°`) e a numeração cresce no sentido horário.

### Pinos com diâmetro

Pinos reais têm raio `r > 0`. O fio não passa pelo centro do pino: ele **tangencia** o pino e o
**contorna** antes de seguir para o próximo. Cada passagem tem um **lado** `s ∈ {+1, −1}`:

- `s = +1`: o pino fica à esquerda do fio → contorno **anti-horário** (visto de frente);
- `s = −1`: o pino fica à direita do fio → contorno **horário**.

O lado é preservado durante o contorno (o fio chega e sai do pino pelo mesmo lado).
Entre os pinos `A` e `B` com lados `sa`, `sb`, sendo `d` a direção do segmento e `n = (−d_y, d_x)`:

```
P_A = A + sa·r·n        P_B = B + sb·r·n
```

- `sa = sb` → tangente externa: `d = (B − A)/|B − A|`, comprimento `|AB|`;
- `sa ≠ sb` → tangente interna (cruzada): `d` é `(B − A)/|AB|` girado de `φ`, com
  `sin φ = 2·sb·r/|AB|`, comprimento `√(|AB|² − 4r²)`.

O arco enrolado no pino ao passar da direção `d₁` para `d₂` é `r·τ`, onde `τ ∈ [0, 2π)` é o ângulo
girado _em direção ao pino_ (sentido fixado por `s`). Assim o **comprimento total do fio** é
exato: soma dos segmentos + soma dos arcos.

Com `r = 0` (pinos ideais) há um único lado e o modelo se reduz ao clássico centro-a-centro.

## 3. Rasterização com largura real — [`raster.ts`](../packages/core/src/raster.ts)

A grade de simulação tem `S × S` pixels cobrindo o diâmetro do tear (`S/D` px por mm). Um fio de
largura `w` mm vira uma faixa de largura `w·S/D` px. Para cada coluna (linhas "horizontais") ou
linha (linhas "verticais") da grade, a faixa tem espessura `w·√(1 + m²)` e a **sobreposição exata**
dessa faixa com cada pixel dá a **cobertura** `c ∈ [0, 1]` — a fração da área do pixel escondida
pelo fio. É um filtro de caixa, válido inclusive para fios mais finos que um pixel, e conserva a
área: `Σ c ≈ w·L`.

## 4. Modelo de tom — luz linear

O alvo e a simulação vivem em **luz linear** (sRGB decodificado). Ao passar um fio de cor `K`
(linear) com opacidade `α` sobre um pixel de valor atual `R`:

```
R ← R + α·c·(K − R)
```

Para fio preto (`K = 0`) sobre fundo branco isso é `R ← R·(1 − α c)`, ou seja, a transmitância
`T = Π(1 − αcᵢ)`: o tom escurece com a **densidade** e as **interseções** das passadas, que nunca
"somam" além do preto. O modelo vale igualmente para fios coloridos e para fio claro em fundo escuro.

## 5. Preparação da imagem — [`image.ts`](../packages/core/src/image.ts) e [`clahe.ts`](../packages/core/src/clahe.ts)

1. Recorte quadrado (padrão: maior quadrado centralizado).
2. Reamostragem para `S × S` com **filtro de área** (k×k amostras bilineares por pixel) em luz linear.
3. **Equalização local adaptativa (CLAHE)** (`clahe.ts`): divide a imagem em uma grade de $8 \times 8$ blocos, constrói histogramas locais de 256 bins e redistribui uniformemente os pixels que ultrapassam o limiar de corte (`claheClipLimit`, padrão 2.0). Em imagens coloridas, o CLAHE opera sobre a luminância perceptual e escala canais proporcionalmente, mantendo integridade de cor e tons de pele. As funções CDF são interpoladas bilinearmente por pixel, eliminando artefatos de borda.
4. Ajustes perceptuais (em sRGB): contraste, brilho, gama, inversão.
5. **Elevação de sombras** (`shadowLift`): eleva suavemente o piso de pretos profundos, impedindo que roupas pretas ou fundos noturnos absorvam desproporcionalmente as cordas e causem borrões sobre o rosto.
6. **Modelo de distância de observação e desfoque retiniano** (`viewingDistanceM`): baseado na acuidade visual humana de ~1 minuto de arco (Birsak et al., 2018), aplica um filtro gaussiano separável $O(N)$ sobre o alvo para que detalhes imperceptíveis à distância física configurada não desviem o algoritmo de tons médios e feições principais.
7. Luminância (Rec. 709) quando todos os fios e o fundo são acromáticos — 1 canal em vez de 3.
8. Máscara circular anti-serrilhada.
9. **Realce de bordas e detalhes** (`edgeEmphasis`): filtro Sobel aplicado sobre a luminância para gerar um mapa de saliência automático, multiplicando os pesos `weight` nos olhos, nariz, boca, óculos e contornos faciais. Opcionalmente combinado com um mapa de importância externo.

## 6. Otimização e estratégias de cor — [`engine.ts`](../packages/core/src/engine.ts)

Estado: para cada fio, o pino atual e o lado em que ele está enrolado.

A cada passo, para uma corda admissível a partir do pino atual (distância circular `≥ minPegGap`, par `{a, b}` usado menos de `maxChordRepeats` vezes, e os dois lados possíveis de chegada), calcula-se o **ganho**:

```
ganho_base = Σₚ wₚ · [ (tₚ − Rₚ)² − (tₚ − R'ₚ)² ]  =  Σₚ wₚ · δₚ · (2(tₚ − Rₚ) − δₚ),   δₚ = α cₚ (K − Rₚ)
```

### Penalidade opcional por comprimento de fio (`lengthPenalty`)

Para aproximar a tecelagem dos 1–2 km reportados por Petros Vrellis para 3.000–4.000 cordas e controlar a tensão mecânica, cordas muito longas podem sofrer um deságio proporcional ao diâmetro do tear:

```
L_norm = L_corda / D_tear ∈ (0, 1]
ganho_efetivo = ganho_base · (1 − λ · L_norm)
```

Com $\lambda = 0$ (padrão de fábrica), o ganho puro é preservado. Com $\lambda \in [0.1, 0.25]$, cordas mais curtas com ganho comparável são priorizadas, gerando economia expressiva de metros de fio com fidelidade visual equivalente.

### Estratégias de tecelagem multicolorida (`ColorStrategy`)

1. **Camadas sequenciais (`layered` — padrão para cores)**:
   - Os fios são tecidos em passes independentes e contínuos, seguindo a ordem subtrativa física:
     - **Preset Vrellis (5 fios)**: Amarelo (20%) $\rightarrow$ Magenta (20%) $\rightarrow$ Azul (20%) $\rightarrow$ Verde (10%) $\rightarrow$ **Preto por último (30%)**.
     - **Preset CMYK (4 fios)**: Amarelo (20%) $\rightarrow$ Ciano (20%) $\rightarrow$ Magenta (20%) $\rightarrow$ **Preto por último (40%)**.
   - As cores formam a base cromática luminosa primeiro; o preto entra no final para assentar as sombras profundas e contornos finos.
   - Fisicamente, o tecelão trabalha com um único carretel por vez até concluir a camada, eliminando o emaranhado de fios.
   - Se uma camada inicial esgotar ganhos antes de atingir sua cota, o motor realiza **rollover** automático do saldo de linhas para o preto final, garantindo o atingimento da meta global de linhas.

2. **Intercalado balanceado (`interleaved-balanced`)**:
   - Revezamento dinâmico em turnos, com cotas máximas proporcionais por fio. Garante que nenhuma cor seja monopolizada ou sofra exclusão cromática durante a tecelagem simultânea.

3. **Livre (`free`)**:
   - Competição gulosa irrestrita tradicional entre todos os fios simultaneamente.

O processo é concluído quando:

- `maxLines` cordas foram tecidas no total; ou
- nenhuma corda viável reduz mais o erro (quando `stopWhenNoImprovement` estiver ativo); ou
- não há mais cordas admissíveis sob os limites de repetições configurados.

## 7. Métricas perceptuais — [`metrics.ts`](../packages/core/src/metrics.ts)

Além do RMSE linear tradicional (em luz linear desprovida de ponderação não linear humana), o motor calcula duas métricas perceptuais reportadas em `WeaveResult.metrics`:

1. **Erro de cor em CIELAB ($\Delta E\_{ab}^\*$, CIE76)**:
   - Conversão linear RGB $\rightarrow$ CIE XYZ (D65) $\rightarrow$ CIELAB ($L^_, a^_, b^*$).
   - $\Delta E = \sqrt{(\Delta L^_)^2 + (\Delta a^_)^2 + (\Delta b^*)^2}$ ponderado dentro da máscara do tear.
   - Valores de $\Delta E < 2.3$ aproximam o limiar de diferença quase imperceptível ao olho humano.
2. **Índice de Similaridade Estrutural (SSIM)**:
   - Formulação de Wang et al. (2004) aplicada sobre a luminância sRGB com janela gaussiana $11 \times 11$ ($\sigma = 1.5$):
     $$\text{SSIM}(x, y) = \frac{(2\mu_x\mu_y + C_1)(2\sigma_{xy} + C_2)}{(\mu_x^2 + \mu_y^2 + C_1)(\sigma_x^2 + \sigma_y^2 + C_2)}$$
   - Varia de 0 a 1, capturando preservação de contraste, nitidez estrutural e luminosidade percebida.

## 8. Refinamento global com continuidade física do fio — [`refine.ts`](../packages/core/src/refine.ts)

A otimização gulosa escolhe cada corda no momento $t$ sem prever as milhares de cordas subsequentes.
Para refinar o traçado sem violar a condição física de **fio contínuo e sem emendas**, o algoritmo executa passes de perturbação local em pares de cordas consecutivas:

- Para cada pino intermediário $p_i$ na sequência $p_{i-1} \to p_i \to p_{i+1}$:
  - Avalia candidatos vizinhos $p_i'$ que satisfaçam as regras de espaçamento `minPegGap` e contagem `maxChordRepeats`.
  - Verifica o lado tangente físico de enrolamento do pino de modo que a chegada e a saída usem o mesmo lado (`toSide === fromSide`).
  - Calcula a variação líquida de erro no canvas gerada ao desfazer $(p_{i-1} \to p_i, p_i \to p_{i+1})$ e aplicar $(p_{i-1} \to p_i', p_i' \to p_{i+1})$.
  - Substituições que reduzem estritamente o erro global são aplicadas incrementalmente no canvas e na lista de passos.
- A continuidade do fio é matematicamente invariante durante todo o processo.

## 9. Calibração de carretéis e parâmetros físicos — [`calibration.ts`](../packages/core/src/calibration.ts)

- **Calibração de Cor de Carretel**: fotografa uma meada ou trecho de fio, descarta reflexos especulares e sombras profundas por corte de percentis (15% a 85%) e calcula a média aparada em luz linear, convertendo para hex sRGB e luminância.
- **Calibração Física de Transmitância**: estima numericamente a espessura aparente `widthMm` e opacidade $\alpha$ analisando um patch tecido com número conhecido de passadas sobre fundo conhecido, através da lei física de transmitância $T = (1 - \alpha \cdot \text{cobertura})^N$.

## 10. Saídas — [`export.ts`](../packages/core/src/export.ts)

- **Instruções** (`.txt`): numeradas a partir do pino 1, com sentido de contorno e cabeçalhos organizados por camada (`=== CAMADA X: Cor (amarrar no pino Y) ===`) quando tecidas por camadas.
- **CSV**: passo, fio, pinos, lados, comprimentos e ganho.
- **SVG**: escala real (1 unidade = 1 mm), agrupado por `<g id="layer-...">` com a cor e espessura real do fio, arcos `A` nos pinos.
- **JSON**: `WeaveResult` completo (com `metrics`, `threads`, `steps`) — reabrível no modo tecelagem do app web.

## 11. Próximos passos (v0.3 e v0.4)

- **v0.3**: Seleção automática de paleta personalizada ($k$ cores a partir da imagem) e modelo óptico de meio-tom.
- **v0.4**: Teares retangulares/quadrados, posições arbitrárias de pinos via CSV e gabarito de furação 1:1 em SVG/PDF.
- **Desempenho**: Cache de rasterização das cordas mais frequentes e paralelismo em Web Workers.
