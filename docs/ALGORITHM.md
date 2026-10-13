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

Unidades em **mm**, com origem no canto superior esquerdo do quadro de simulação delimitador e eixo _y_ apontando para baixo. O motor suporta três geometrias físicas (`LoomConfig`):

### 2.1 Formatos de tear

1. **Circular (`CircleLoomConfig`)**:
   - Pinos dispostos sobre a circunferência de diâmetro $D$ ($R = D/2$): $\theta_i = \theta_0 + 2\pi i / N$.
   - O pino 0 fica no topo por padrão ($\theta_0 = -90^\circ$) e a numeração segue o sentido horário.
2. **Retangular ou Quadrado (`RectangleLoomConfig`)**:
   - Dimensões físicas $W \times H$ em mm, com contagem de pinos $p_x \ge 2$ nas bordas horizontais e $p_y \ge 2$ nas bordas verticais.
   - Pinos nos 4 cantos físicos, com contagem total exata $N = 2(p_x + p_y) - 4$ e espaçamento uniforme ao longo de cada aresta.
   - Numeração horária contínua a partir do canto superior esquerdo.
3. **Personalizado / Pinos Arbitrários (`CustomLoomConfig`)**:
   - Coordenadas arbitrárias $(x_i, y_i)$ em mm (ex: importadas via arquivo CSV).
   - O perímetro e o polígono interno são computados automaticamente através do algoritmo da **Cadeia Monótona de Andrew** para envoltória convexa (_convex hull_) em $O(N \log N)$, assegurando orientação horária estrita.

### 2.2 Normais externas e matriz de cordas admissíveis (`chordMask`)

- Para posicionamento de etiquetas numéricas e desenho de gabarito sem sobreposição, cada pino calcula sua **normal externa** $(n_x, n_y)$ apontando para fora do tear.
- Em teares poligonais ou retangulares, cordas cujos pinos pertençam à mesma aresta reta física (ex: topo com topo) não cruzam a área útil da obra e apenas cobririam a moldura. A matriz `chordMask` proíbe preventivamente essas cordas inválidas, além de respeitar o espaçamento mínimo circular `minPegGap`.

### 2.3 Pinos com diâmetro real

Pinos reais têm raio $r > 0$. O fio não passa pelo centro do pino: ele **tangencia** o pino e o
**contorna** antes de seguir para o próximo. Cada passagem tem um **lado** $s \in \{+1, -1\}$:

- $s = +1$: o pino fica à esquerda do fio $\to$ contorno **anti-horário** (visto de frente);
- $s = -1$: o pino fica à direita do fio $\to$ contorno **horário**.

O lado é preservado durante o contorno (o fio chega e sai do pino pelo mesmo lado).
Entre os pinos $A$ e $B$ com lados $s_a, s_b$, sendo $d$ a direção do segmento e $n = (-d_y, d_x)$:

```
P_A = A + sa·r·n        P_B = B + sb·r·n
```

- $s_a = s_b \to$ tangente externa: $d = (B - A)/|B - A|$, comprimento $|AB|$;
- $s_a \ne s_b \to$ tangente interna (cruzada): $d$ é $(B - A)/|AB|$ girado de $\phi$, com
  $\sin \phi = 2 \cdot s_b \cdot r / |AB|$, comprimento $\sqrt{|AB|^2 - 4r^2}$.

O arco enrolado no pino ao passar da direção $d_1$ para $d_2$ é $r \cdot \tau$, onde $\tau \in [0, 2\pi)$ é o ângulo
girado _em direção ao pino_ (sentido fixado por $s$). Assim o **comprimento total do fio** é
exato: soma dos segmentos + soma dos arcos.

Com $r = 0$ (pinos ideais) há um único lado e o modelo se reduz ao clássico centro-a-centro.

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

1. **Enquadramento de aspecto (`loomFrameCrop`)**: recorta o maior retângulo centralizado mantendo a proporção exata do tear e o centraliza dentro do quadro quadrado de simulação de tamanho $S \times S$ px ($S / \text{extentMm}$ px por mm). Em teares circulares ou quadrados, reduz-se ao clássico maior quadrado centralizado.
2. Reamostragem para `S × S` com **filtro de área** (k×k amostras bilineares por pixel) em luz linear.
3. **Equalização local adaptativa (CLAHE)** (`clahe.ts`): divide a imagem em uma grade de $8 \times 8$ blocos, constrói histogramas locais de 256 bins e redistribui uniformemente os pixels que ultrapassam o limiar de corte (`claheClipLimit`, padrão 2.0). Em imagens coloridas, o CLAHE opera sobre a luminância perceptual e escala canais proporcionalmente, mantendo integridade de cor e tons de pele. As funções CDF são interpoladas bilinearmente por pixel, eliminando artefatos de borda.
4. Ajustes perceptuais (em sRGB): contraste, brilho, gama, inversão.
5. **Elevação de sombras** (`shadowLift`): eleva suavemente o piso de pretos profundos, impedindo que roupas pretas ou fundos noturnos absorvam desproporcionalmente as cordas e causem borrões sobre o rosto.
6. **Modelo de distância de observação e desfoque retiniano** (`viewingDistanceM`): baseado na acuidade visual humana de ~1 minuto de arco (Birsak et al., 2018), aplica um filtro gaussiano separável $O(N)$ sobre o alvo para que detalhes imperceptíveis à distância física configurada não desviem o algoritmo de tons médios e feições principais.
7. Luminância (Rec. 709) quando todos os fios e o fundo são acromáticos — 1 canal em vez de 3.
8. **Máscara do tear antisserrilhada (`loomMask`)**:
   - Em teares circulares: máscara analítica circular $m = \text{clamp}(R - d + 0.5)$.
   - Em teares retangulares e poligonais convexos: cálculo contínuo de distância com sinal a todas as arestas do polígono orientadas em sentido horário, $m = \text{clamp}(\min_e d_e + 0.5)$, garantindo antisserrilhamento e bordas nítidas sem denteamento.
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

- **Instruções** (`.txt`): numeradas a partir do pino 1, com sentido de contorno e cabeçalhos organizados por camada (`=== CAMADA X: Cor (amarrar no pino Y) ===`), acompanhadas do bloco detalhado de **ESTIMATIVA DE FABRICAÇÃO** (tempo estimado ativo e overhead, amarrações e carretéis por cor).
- **CSV**: passo, fio, pinos, lados, comprimentos e ganho.
- **SVG**: escala real (1 unidade = 1 mm), agrupado por `<g id="layer-...">` com a cor e espessura real do fio, arcos `A` nos pinos e contorno físico do tear.
- **JSON**: `WeaveResult` completo (com `metrics`, `threads`, `steps` e metadados de `progress`) — reabrível no modo tecelagem do app web.

## 11. Seleção automática de paleta personalizada — [`palette.ts`](../packages/core/src/palette.ts)

Para reproduzir fotografias sem restrição aos presets fixos (Vrellis ou CMYK), o Weaver Art extrai uma paleta adaptativa de $k$ cores ($k \in [2, 10]$) diretamente da imagem do usuário:

1. **Amostragem Geométrica do Tear**: Amostra pixels exclusivamente dentro da máscara do tear (circular ou poligonal convexa), ignorando fundos externos e cantos brancos/transparentes.
2. **Espaço Perceptual CIELAB**:
   - Cada pixel RGB linear é convertido para espaço CIE XYZ e em seguida para CIELAB ($L^_, a^_, b^*$).
   - A métrica de distância utilizada na clusterização é a distância euclidiana CIE76:
     $$\Delta E_{ab}^* = \sqrt{(\Delta L^*)^2 + (\Delta a^*)^2 + (\Delta b^*)^2}$$
     que reflete a sensibilidade perceptual do olho humano de forma muito superior ao espaço RGB euclidiano.
3. **Clusterização K-Means++**:
   - Inicialização estocástica ponderada pela distância quadrática ($D(x)^2$) para cobrir polos cromáticos distintos (ex: tons de pele, realces e sombras).
   - Iterações de Lloyd até convergência ($\Delta E < 0.05$) com reatribuição de clusters vazios.
4. **Ordenação Física por Luminância ($L^\*$)**:
   - Os centróides são estritamente ordenados de forma decrescente por luminância ($L^_$ alto $\to$ $L^_$ baixo).
   - O fio mais luminoso inicia a tecelagem e a âncora mais escura (preto, grafite ou marinho profundo) fica por último, respeitando a regra física de que fios escuros não devem ser soterrados por fios claros.
5. **Alocação de Cotas Ponderadas e Rollover**:
   - Para $k \ge 4$ cores, a âncora escura recebe cota terminal de $35\%$ a $40\%$ (padrão $38\%$). As $k-1$ cores claras dividem equitativamente os $62\%$ restantes.
   - Em conjunto com a estratégia `layered`, qualquer saldo não consumido pelas camadas claras é transferido dinamicamente (_rollover_) para a âncora escura, garantindo que a meta de linhas seja cumprida.
6. **Distribuição Angular dos Pinos Iniciais**:
   - Os pinos de amaciamento inicial de cada carretel são distribuídos uniformemente na borda do tear: $\text{startPeg}_i = \lfloor i \cdot N / k \rfloor$.

## 12. Modelo óptico de mistura por meio-tom — [`engine.ts`](../packages/core/src/engine.ts)

A mistura de cores em string art à distância de visualização não ocorre pixel a pixel, mas sim pela fusão espacial contínua dos pontos luminosos na retina humana (_optical halftoning_ ou mistura aditiva de cor espacial):

### Formulação Matemática

Em vez de minimizar o erro residual local ponto a ponto $\|C - T\|^2$, minimizamos o erro perceptual após a mistura espacial da visão humana:

$$\mathcal{E}_{\text{halftone}} = \| H * (C - T) \|^2$$

onde $H$ é a função de espalhamento pontual (PSF da retina) e $G = H^T * H = H * H$ é o filtro gaussiano equivalente. Pela propriedade do produto interno:

$$\mathcal{E}_{\text{halftone}} = \langle C - T, G * (C - T) \rangle$$

Ao adicionar uma corda com perturbação $\Delta C$, a redução do erro perceptual (ganho óptico) é:

$$\text{ganho} = \sum_{p \in \text{corda}} w_p \cdot \left[ 2 \cdot \delta_p \cdot R_{\text{halftone}}[p] - \delta_p^2 \right]$$

onde $R_{\text{halftone}} = G * (T - C)$ é o **mapa de resíduo perceptualmente filtrado**.

### Vantagens e Comportamento Cooperativo

- **Cooperação entre Fios Adjacentes**: Fios de cores complementares (por exemplo, Amarelo e Ciano sobre uma área verde) passam a cooperar oticamente mesmo quando correm em paralelo ou com pequenos afastamentos, sem a penalidade artificial do modelo pixel a pixel que exigiria interseções microscópicas perfeitas.
- **Desempenho em Tempo Real**:
  - $R_{\text{halftone}}$ é avaliado diretamente em $O(1)$ por amostra rasterizada durante o cálculo do ganho.
  - Ao aplicar uma corda selecionada, $R_{\text{halftone}}$ é atualizado localmente sobre a caixa delimitadora dilatada da corda com filtro gaussiano separável 1D horizontal + 1D vertical em $O(\text{largura} + \text{altura})$, com ressincronização completa periódica a cada 50 passos.
- Quando `halftoneMixing: false` (padrão), o motor se reduz estritamente ao resíduo local clássico $R = T - C$ com custo adicional zero.

## 13. Gabarito de furação 1:1 e gerador PDF vetorial puro — [`template.ts`](../packages/core/src/template.ts), [`pdf.ts`](../packages/core/src/pdf.ts)

Para a construção física do tear por marcenaria ou serralheria:

1. **Gabarito Vetorial SVG 1:1**:
   - Emite desenho vetorial onde 1 unidade = 1 mm físico.
   - Cada pino contém cruz de centro milimétrica e círculo correspondente ao diâmetro real da broca de furação (`drillDiameterMm`).
   - Inclui marcadores numéricos a cada 10 pinos, eixos ortogonais principais e **régua de calibração de 100 mm** para aferição direta com paquímetro ou fita métrica após a impressão.
2. **Ladrilhamento Multi-páginas em PDF Puro (`pdf.ts`)**:
   - Implementação independente de escritor PDF 1.4 sem dependências de terceiros, com cálculo exato de offsets de tabela `xref` e tipografia `WinAnsiEncoding`.
   - Gera uma **página de capa (visão geral)** com diagrama da grade de folhas montada e especificações físicas.
   - Decompõe teares maiores que a folha física (ex: aro de 711 mm em papel A4 de 210 × 297 mm) em uma grade de $L \times C$ blocos com margem de sobreposição de 10 mm.
   - Cada folha impressa traz: marcas de corte e registro em cruz nos quatro cantos, identificador de coluna/linha (ex: `Folha L2·C3`), e **régua de conferência local de 50 mm** com o aviso explícito de impressão em escala 100% (sem ajuste de página).

## 14. Estimativa física de tecelagem e consumo de carretéis — [`estimate.ts`](../packages/core/src/estimate.ts)

Para planejamento prático de tecelagem manual:

- **Tempo Ativo**: $\text{tempo\_cordas} = N_{\text{passos}} \times t_{\text{corda}}$ (padrão: 6 s por corda, calibrado a partir das sessões de tecelagem de Vrellis).
- **Tempo de Preparo (Overhead)**: $\text{tempo\_overhead} = N_{\text{amarrações}} \times t_{\text{amarração}} + N_{\text{trocas}} \times t_{\text{troca}}$ (padrão: 120 s para amarração e ancoragem inicial de um carretel novo, 10 s para alternância entre fios em estratégias intercaladas).
- **Consumo de Meadas com Margem de Segurança**:
  $$\text{fio\_necessário}_t = \text{comprimento\_físico}_t \times (1 + \text{margem}) + \text{sobras\_amarração}$$
  O número de carretéis/bobinas por cor é calculado por $\lceil \text{fio\_necessário}_t / L_{\text{carretel}} \rceil$ (ex: carretéis de 1.000 m com 10% de margem e 300 mm de ponta para nós).
- **Tempo Restante Dinâmico**: Permite calcular em tempo real o tempo restante a partir de qualquer passo $k$ no reprodutor web.

## 15. Cinemática e percursos de G-code para robôs/plotters XY — [`gcode.ts`](../packages/core/src/gcode.ts)

Para tecelagem automatizada via máquinas CNC de 2 eixos ou braços cartesianos com dispensador de fio:

1. **Compensação Radial da Ferramenta**:
   - O bico guia do fio não pode colidir com os pinos. O centro da ferramenta se move em uma órbita dilatada com raio efetivo $r' = r_{\text{pino}} + \text{clearanceMm}$.
2. **Segmentos Lineares Tangentes (`G1`)**:
   - Calcula a tangente matemática exata entre as órbitas dos dois pinos através de `tangentSegment(a, fromSide, b, toSide, r')`.
3. **Contornos em Arco Circular (`G2` / `G3`)**:
   - No sistema de coordenadas da máquina (Y apontando para o fundo da mesa), arcos anti-horários no tear com $s = +1$ são emitidos como interpolação circular anti-horária `G3`, e $s = -1$ como `G2`.
   - Arcos com ângulo de contorno $\tau > \pi$ radianos ($180^\circ$) são automaticamente bipartidos em dois arcos consecutivos menores, prevenindo ambiguidades de arco maior/menor com coordenadas relativas de centro `I` e `J`.
4. **Gerenciamento de Fios e Cores**:
   - Cabeçalho padronizado RS-274 com unidades em mm (`G21`), coordenadas absolutas (`G90`) e plano XY (`G17`).
   - Trocas de meada emitem comando de pausa obrigatória `M0` com mensagem legível nos comentários indicando cor, pino de amarração e camada, seguido de avanço rápido em vazio (`G0`) até o próximo pino de ancoragem.

## 16. Sincronização e retomada de progresso sem servidor — [`progress.ts`](../packages/core/src/progress.ts)

Para permitir que o tecelão alterne livremente entre computador de mesa e celular/tablet na bancada sem exigir contas na nuvem ou banco de dados:

1. **Fingerprint Criptográfico Leve (`weaveFingerprint`)**:
   - Hash FNV-1a de 32 bits determinístico calculado sobre a contagem de pinos, dimensões, lista de passos e ordem de fios. Retrocompatível com projetos circulares da v0.3.
2. **Códigos Compactos com Checksum (`encodeProgressCode`, `decodeProgressCode`)**:
   - Formato padronizado: `WA1-<fingerprint>-<passo36>-<checksum>` (ex: `WA1-k3x9q2-1f4-7a`).
   - O checksum de 2 caracteres em base 36 valida a integridade do código e impede que erros acidentais de digitação desloquem o progresso da obra.
3. **Sincronização por Link e Reconciliação**:
   - O progresso pode ser compartilhado diretamente via URL através da âncora `#progress=WA1-...`.
   - Ao importar ou reabrir arquivos `.weave.json` com campo `progress: { index, updatedAt }`, a função `mergeProgress` compara com o histórico local do navegador e eleva automaticamente o progresso para o timestamp mais recente.

## 17. Próximos passos (v0.5)

- **Desempenho**: Cache de rasterização das cordas mais frequentes e poda antecipada de candidatos inviáveis.
- **Aceleração de Baixo Nível**: Núcleo computacional em Rust compilado para WebAssembly (com extensões SIMD de 128 bits) ou aceleração de matriz de ganhos via WebGPU para resoluções $> 1000$ px.
- **Paralelismo**: Avaliação concorrente de candidatos distribuída entre múltiplos Web Workers.
