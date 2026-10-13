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

## 5. Preparação da imagem — [`image.ts`](../packages/core/src/image.ts)

1. Recorte quadrado (padrão: maior quadrado centralizado).
2. Reamostragem para `S × S` com **filtro de área** (k×k amostras bilineares por pixel) em luz linear.
3. Ajustes perceptuais (em sRGB): contraste, brilho, gama, inversão.
4. **Elevação de sombras** (`shadowLift`): eleva suavemente o piso de pretos profundos, impedindo que roupas pretas ou fundos noturnos absorvam desproporcionalmente as cordas e causem borrões sobre o rosto.
5. Luminância (Rec. 709) quando todos os fios e o fundo são acromáticos — 1 canal em vez de 3.
6. Máscara circular anti-serrilhada.
7. **Realce de bordas e detalhes** (`edgeEmphasis`): filtro Sobel aplicado sobre a luminância para gerar um mapa de saliência automático, multiplicando os pesos `weight` nos olhos, nariz, boca, óculos e contornos faciais. Opcionalmente combinado com um mapa de importância externo.

## 6. Otimização e estratégias de cor — [`engine.ts`](../packages/core/src/engine.ts)

Estado: para cada fio, o pino atual e o lado em que ele está enrolado.

A cada passo, para uma corda admissível a partir do pino atual (distância circular `≥ minPegGap`, par `{a, b}` usado menos de `maxChordRepeats` vezes, e os dois lados possíveis de chegada), calcula-se o **ganho**:

```
ganho = Σₚ wₚ · [ (tₚ − Rₚ)² − (tₚ − R'ₚ)² ]  =  Σₚ wₚ · δₚ · (2(tₚ − Rₚ) − δₚ),   δₚ = α cₚ (K − Rₚ)
```

isto é, a redução exata do erro quadrático ponderado provocada pela corda.

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

### Repetições por par de pinos e metas altas de linhas

Em um tear circular de 200 pinos, existem cerca de 16.500 pares de pinos possíveis, dos quais apenas cerca de 7.500 cruzam o interior da figura. Para tecer **10.000 cordas** sem escurecer o fundo branco, o parâmetro `maxChordRepeats` deve ser ajustado para **2 ou 3**, permitindo que múltiplos fios passem pelo mesmo par de pinos com ângulos ligeiramente variados.

### Por que redução de erro em vez de "linha mais escura"?

As implementações clássicas escolhem a corda com maior **escuridão média** do alvo e depois
**subtraem** uma constante do alvo. Isso:

- normaliza pelo comprimento, favorecendo cordas curtas e escuras;
- ignora que interseções escurecem menos que a soma das passadas (o fio não é aditivo);
- não sabe quando parar.

Minimizar diretamente `‖alvo − simulação‖²` com o modelo físico resolve os três pontos: cordas
longas que atravessam áreas escuras são naturalmente preferidas, regiões já escuras "saturam", e o
ganho negativo é um critério de parada objetivo.

### Resolução da grade = distância de observação

Como a cobertura é uma média de área, a grade de `S × S` px equivale a observar a obra com
"pixels" de `D/S` mm. Em testes com retratos, `S = 400` (≈ 1,8 mm/px) preserva olhos, nariz e boca
muito melhor que `S = 700` (≈ 1 mm/px): na grade fina, o erro é dominado por detalhes
sub-milimétricos que 4 000 cordas não conseguem reproduzir, e as feições se perdem. Por isso o
padrão é 400 px. Um modelo perceptual explícito (simular fino, comparar grosso) está no roadmap.

### Custo

Com 200 pinos, 2 lados e grade de 400 px: ≈ 2 × 2 × 176 candidatos × ~500 amostras ≈ 350 mil
avaliações de pixel por corda. No modo por camadas, cada passo avalia apenas o fio ativo (em vez de
avaliar todos os 4 ou 5 fios concorrentemente), resultando em tecelagem **4 a 5 vezes mais rápida**
que o modo guloso irrestrito multicolorido.

## 7. Saídas — [`export.ts`](../packages/core/src/export.ts)

- **Instruções** (`.txt`): numeradas a partir do pino 1, com sentido de contorno e cabeçalhos organizados por camada (`=== CAMADA X: Cor (amarrar no pino Y) ===`) quando tecidas por camadas.
- **CSV**: passo, fio, pinos, lados, comprimentos e ganho.
- **SVG**: escala real (1 unidade = 1 mm), agrupado por `<g id="layer-...">` com a cor e espessura real do fio, arcos `A` nos pinos.
- **JSON**: `WeaveResult` completo — reabrível no modo tecelagem do app web.

## 8. Limitações conhecidas e próximos passos

- Guloso não é ótimo global. Próximo passo: refinamento por remoção/troca de cordas
  (como em Birsak et al., 2018) — ver [ROADMAP.md](ROADMAP.md).
- A comparação é feita na resolução da grade; um modelo de distância de observação (desfoque
  perceptual / comparação em resolução menor) deve melhorar o resultado visto de longe.
- Largura aparente do fio, diâmetro do pino e cores dos fios são estimativas: devem ser
  **calibrados** fotografando um tear real.
