# Algoritmo

Este documento descreve o modelo físico e matemático do Weaver Art. O motor de produção é o
workspace Rust/Wasm em [`crates/`](../crates) (DSP, solvers, CAM); o núcleo TypeScript em
[`packages/core/src`](../packages/core/src) permanece como referência e fallback de exportação.

## 0. Estado atual do motor (reescrita do núcleo + rodada "reconhecimento facial")

O objetivo do projeto é que a pessoa **se reconheça** na obra. As decisões abaixo foram medidas com
fotos reais (`weaver-cli bench`, folhas de contato `weaver-cli contact`) e substituem as seções
legadas marcadas como tal mais adiante.

1. **Fio opaco e cobertura física**: $\alpha_{\text{material}} \approx 1$; o escurecimento por pixel vem
   da cobertura $t_f \cdot R_{px} / D_{mm}$ e da transmitância em luz linear $T = \prod (1 - \alpha c_i)$.
2. **Objetivo limpo**: o ganho de uma corda é a variação **exata** do erro quadrático ponderado em
   espaço perceptual (curva sRGB), com pesos $W = 1 + \beta_f M_{\text{face}} \,[+\, \beta_{\text{feat}} M_{\text{feições}}] \ge 1$.
   As heurísticas `highlightProtection`, `angularDiversity`, `centerDampRadiusMm`, `lengthPenalty`,
   `shadowLift` e `torsoFeathering` (seções 5–6.5 abaixo) **não existem** no motor Rust.
3. **Enquadramento pelo rosto** (`weaver-dsp/src/face_framing.rs`): detector Viola-Jones sobre imagem
   integral em tons de cinza (cascata `haarcascade_frontalface_default` do OpenCV convertida para
   tabelas estáticas, 25 estágios / 2.913 classificadores fracos), janelas multiescala com features
   escaladas, agrupamento com 3 vizinhos mínimos e supressão de caixas sobrepostas. Dada a caixa do
   rosto $(c_x, c_y, s)$ na foto e o raio de entrada $r_{in} = \min(w, h)/2$, o recorte usa
   $\text{zoom} = \text{fill} \cdot 2 r_{in} / s$ e
   $\text{pan} = (c_{in} - c_{\text{rosto}}) / r_{in}$, com `fill = 0,95` (o rosto ocupa 95% do aro;
   topo do cabelo e orelhas ficam de fora). Sem rosto, recai no modo "cabeça e ombros" (Sobel + pele
   YCbCr + prior central, fill 0,8).
4. **Tear padrão**: aro de bicicleta 28″ ISO 622 (622 mm), 200 pinos, fio 0,18 mm, 6000 linhas,
   `maxChordRepeats = 2`, grade de 500 px.
5. **Vista à distância** (UI): a obra é julgada como vista na parede — desfoque gaussiano com
   $\sigma_{mm} = 0{,}6 \cdot d_m$ (≈ 2′ de arco), convertido para pixels pela escala do canvas, lado a
   lado com a foto enquadrada sob o mesmo desfoque. O benchmark usa a mesma ideia ("correlação à
   distância") e mede SSIM/RMSE só na elipse do rosto detectado.
6. **Realces opcionais, padrão 0**: mapa de feições escuras (black top-hat × pele, `beta_feature`) e
   "pele mais limpa" (`skin_lift`). Nos testes deram diferença visual mínima e correlação global
   levemente pior; ficam disponíveis para escolha visual.

> [!NOTE]
> As seções 5–6 a seguir documentam o núcleo TypeScript legado (`packages/core`). Elas são mantidas
> como histórico; para o comportamento atual, valem os itens acima e o `AGENTS.md`.

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
2. **Quadrado (`SquareLoomConfig`)**:
   - Dimensão física de lado $L = W = H$ em mm, com contagem total de pinos $N$ múltipla de 4.
   - Pinos distribuídos simetricamente nas 4 bordas com $p_x = p_y = N/4 + 1$, garantindo $N = 2(p_x + p_y) - 4$ e espaçamento uniforme ao longo de cada aresta.
   - Numeração horária contínua a partir do canto superior esquerdo. Formatos elípticos, polígonos arbitrários e CSV manual foram expurgados para manter o foco na fidelidade e rigidez mecânica.

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

## 3. Rasterização com largura real — [`raster.ts`](../packages/core/src/raster.ts) e [`chord-cache.ts`](../packages/core/src/chord-cache.ts)

A grade de simulação tem `S × S` pixels cobrindo o diâmetro do tear (`S/D` px por mm). Um fio de
largura `w` mm vira uma faixa de largura `w·S/D` px. Para cada coluna (linhas "horizontais") ou
linha (linhas "verticais") da grade, a faixa tem espessura `w·√(1 + m²)` e a **sobreposição exata**
dessa faixa com cada pixel dá a **cobertura** `c ∈ [0, 1]` — a fração da área do pixel escondida
pelo fio. É um filtro de caixa, válido inclusive para fios mais finos que um pixel, e conserva a
área: `Σ c ≈ w·L`.

### Orientação canônica e amostragem invariante

A física da corda depende apenas da reta geométrica que conecta as tangentes dos pinos $A$ e $B$. Para evitar rasterizar a mesma corda no sentido $A \to B$ e depois no sentido inverso $B \to A$, o motor define a **orientação canônica**:

- Se $A < B$, a orientação direta é preservada;
- Se $A > B$, os pontos de tangência e lados são invertidos ($A \leftrightarrow B, s_a \leftrightarrow s_b$), gerando a mesma chave de identificação única de 64 bits $K(a, s_a, b, s_b)$.
- Com a chave canônica, as amostras de cobertura $(x, y, c)$ são calculadas uma única vez e cacheadas em um buffer LRU (`ChordCache`), eliminando repetições de rasterização em passos sucessivos.

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
6. **Atenuação suave de tronco** (`torsoFeathering`): aplica uma janela cosseno contínua na fração inferior do tear ($y > (1 - f) \cdot S$), desvanecendo os pesos $w_p$ em direção à borda inferior. Previne o "efeito poço negro" onde roupas ou moletons escuros dominam a função objetivo gulosa e atraem centenas de cordas espúrias que cruzam o pescoço e a face clara (_streak bleed-through_).
7. **Reforço de microcontraste via Unsharp Mask** (`computeUnsharpMask`, `sharpenSigma`): reforça detalhes finos de alta frequência (armações de óculos, pupilas, cílios) através de $I_{\text{sharp}} = \text{clamp}(I + \beta \cdot (I - G_\sigma * I), 0, 1)$, garantindo que estruturas de 1 a 2 pixels tenham contraste nítido antes da quantização.
8. **Modelo de distância de observação e desfoque retiniano** (`viewingDistanceM`): baseado na acuidade visual humana de ~1 minuto de arco (Birsak et al., 2018), aplica um filtro gaussiano separável $O(N)$ sobre o alvo para que detalhes imperceptíveis à distância física configurada não desviem o algoritmo de tons médios e feições principais.
9. Luminância (Rec. 709) quando todos os fios e o fundo são acromáticos — 1 canal em vez de 3.
10. **Máscara do tear antisserrilhada (`loomMask`)**:
    - Em teares circulares: máscara analítica circular $m = \text{clamp}(R - d + 0.5)$.
    - Em teares retangulares e poligonais convexos: cálculo contínuo de distância com sinal a todas as arestas do polígono orientadas em sentido horário, $m = \text{clamp}(\min_e d_e + 0.5)$, garantindo antisserrilhamento e bordas nítidas sem denteamento.
11. **Saliência facial multiescala não-linear** (`computeMultiscaleSaliency`, `edgeEmphasis`): combina gradientes Sobel em escala direta ($E_1$) e escala suavizada ($E_2$), aplicando compressão não-linear via expoente fracionário $\gamma = 0.7$:
    $$S_{\text{saliency}} = (0.7 \cdot E_1 + 0.3 \cdot E_2)^\gamma$$
    Como $\gamma < 1$, o peso relativo de arestas sutis (hastes finas de óculos, pupilas e sobrancelhas) é amplificado em até $3\times$ a $5\times$ em relação a bordas grosseiras de alto contraste, orientando o algoritmo guloso a detalhar a face. Opcionalmente combinado com mapa de importância externo.

## 6. Otimização e estratégias de cor — Núcleo Rust (`crates/weaver-solvers`)

Estado: para cada fio, o pino atual e o lado em que ele está enrolado.

A cada passo, para uma corda admissível a partir do pino atual (distância perimétrica circular $\ge \text{minPegGap}$, par $\{a, b\}$ usado menos de $\text{maxChordRepeats}$ vezes, e os lados possíveis de chegada), calcula-se o **ganho**:

$$\text{ganho} = \sum_{p \in \text{corda}} W(p) \cdot w_p \cdot \delta_p \cdot [2(t_p - R_p) - \delta_p]$$

onde $W(p) \ge 1.0$ é o mapa de importância suave, $w_p \in [0, 1]$ é o peso de cobertura sub-pixel (Xiaolin Wu), $t_p$ é o alvo óptico, $R_p$ é a simulação acumulada atual e $\delta_p$ é a variação de cobertura física do fio.

### 6.1 Função Objetivo Limpa (Preservação de Fidelidade Facial)

Experimentos medidos com fotos reais no benchmark nativo (`weaver-cli bench`) demonstraram que a acumulação de heurísticas empíricas (como amortecimento central de moiré, proteção assimétrica de realces e repulsão angular forçada) distorcia severamente a convergência do erro quadrático, resultando em retratos irreconhecíveis ou lavados.

O Weaver Art adota uma **função objetivo limpa**:

- **Ganho Exato**: O ganho de uma corda é a redução estrita do erro quadrático ponderado em espaço perceptual.
- **Foco por Reconhecimento**: Regiões anatômicas prioritárias (olhos, nariz, boca) são guiadas unicamente pelo **Mapa de Importância Facial** suave ($W(p) = 1 + \beta_f M_{\text{face}} \ge 1.0$, padrão $\beta_f = 2.0$), sem introduzir penalidades artificiais por ângulo ou posição central.

### 6.2 Presets Oficiais de Petros Vrellis

1. **`VRELLIS_CLASSIC_MONO` (Monocromático Clássico)**:
   - Fio: 1 carretel (Preto, $\alpha = 1.0$, largura real 0,18 mm).
   - Tear: aro circular 28″ (ISO 622, 622 mm), 200 pinos, 6.000 cordas (`maxChordRepeats: 2`).
   - Grade de simulação: 500 px.
   - Padrão ótimo medido para reconhecimento em retratos: guloso exato em luz linear com fio opaco.

2. **`VRELLIS_COLOR` (Colorido CMYK Subtrativo)**:
   - Fios: 4 camadas sequenciais físicas — Amarelo ($Y$), Magenta ($M$), Ciano ($C$) e Preto ($K$).
   - Cotas ponderadas padrão: $[0.18\text{ Y}, 0.22\text{ M}, 0.22\text{ C}, 0.38\text{ K}]$.
   - Ordem física obrigatória: cores luminosas primeiro ($Y \to M \to C$) e **Preto por último** ($K$).
   - **Rollover dinâmico**: se uma camada de cor clara atingir o teto de ganho positivo antes de sua cota máxima, o saldo de linhas é transferido automaticamente para a camada preta final, garantindo cumprimento da meta de cordas sem ruído visual.

### 6.3 Estratégia de Tecelagem Sequencial em Camadas (`layered`)

A tecelagem multicolorida em Weaver Art opera exclusivamente na estratégia de **Camadas Sequenciais (`layered`)**:

- Os fios são tecidos em passes contínuos e completos por carretel, eliminando as centenas ou milhares de trocas de carretel que inviabilizariam a fabricação física manual.
- O fio preto final ancora o contraste e define traços anatômicos (pupilas, narinas, sobrancelhas) sem ser sobreposto ou desbotado por passadas posteriores de fios claros.

O processo de tecelagem é concluído quando:

- `maxLines` cordas foram tecidas no total; ou
- não há mais cordas admissíveis com ganho positivo sob os limites de repetições configurados.

## 7. Métricas perceptuais — `crates/weaver-domain` e `crates/weaver-solvers`

Além do RMSE linear tradicional (em luz linear desprovida de ponderação não linear humana), o motor calcula duas métricas perceptuais reportadas em `WeaveResult.metrics`:

1. **Erro de cor em CIELAB ($\Delta E\_{ab}^\*$, CIE76)**:
   - Conversão linear RGB $\rightarrow$ CIE XYZ (D65) $\rightarrow$ CIELAB ($L^_, a^_, b^*$).
   - $\Delta E = \sqrt{(\Delta L^_)^2 + (\Delta a^_)^2 + (\Delta b^*)^2}$ ponderado dentro da máscara do tear.
   - Valores de $\Delta E < 2.3$ aproximam o limiar de diferença quase imperceptível ao olho humano.
2. **Índice de Similaridade Estrutural (SSIM)**:
   - Formulação de Wang et al. (2004) aplicada sobre a luminância sRGB com janela gaussiana $11 \times 11$ ($\sigma = 1.5$):
     $$\text{SSIM}(x, y) = \frac{(2\mu_x\mu_y + C_1)(2\sigma_{xy} + C_2)}{(\mu_x^2 + \mu_y^2 + C_1)(\sigma_x^2 + \sigma_y^2 + C_2)}$$
   - Varia de 0 a 1, capturando preservação de contraste, nitidez estrutural e luminosidade percebida.

## 8. Refinamento contínuo do fio — `crates/weaver-solvers`

A otimização gulosa escolhe cada corda no momento $t$ sem prever as milhares de cordas subsequentes.
Para refinar o traçado sem violar a condição física de **fio contínuo e sem emendas**, o algoritmo disponibiliza passes opcionais de perturbação local em pares de cordas consecutivas:

- Para cada pino intermediário $p_i$ na sequência $p_{i-1} \to p_i \to p_{i+1}$:
  - Avalia candidatos vizinhos $p_i'$ que satisfaçam as regras de espaçamento `minPegGap` e contagem `maxChordRepeats`.
  - Verifica o lado tangente físico de enrolamento do pino de modo que a chegada e a saída usem o mesmo lado (`toSide === fromSide`).
  - Calcula a variação líquida de erro no canvas gerada ao desfazer $(p_{i-1} \to p_i, p_i \to p_{i+1})$ e aplicar $(p_{i-1} \to p_i', p_i' \to p_{i+1})$.
  - Substituições que reduzem estritamente o erro global são aplicadas incrementalmente no canvas e na lista de passos.
- A continuidade do fio é matematicamente invariante durante todo o processo.

## 9. Calibração de carretéis e parâmetros físicos

- **Calibração de Cor de Carretel**: fotografa uma meada ou trecho de fio, descarta reflexos especulares e sombras profundas por corte de percentis (15% a 85%) e calcula a média aparada em luz linear, convertendo para hex sRGB e luminância.
- **Calibração Física de Transmitância**: estima numericamente a espessura aparente `widthMm` e opacidade $\alpha$ analisando um patch tecido com número conhecido de passadas sobre fundo conhecido, através da lei física de transmitância $T = (1 - \alpha \cdot \text{cobertura})^N$.

## 10. Saídas e Formatos de Exportação

- **Instruções** (`.txt`): numeradas a partir do pino 1, com sentido de contorno e cabeçalhos organizados por camada (`=== CAMADA X: Cor (amarrar no pino Y) ===`), acompanhadas do bloco detalhado de **ESTIMATIVA DE FABRICAÇÃO** (tempo estimado ativo e overhead, amarrações e carretéis por cor).
- **CSV**: passo, fio, pinos, lados, comprimentos e ganho.
- **SVG**: escala real (1 unidade = 1 mm), agrupado por `<g id="layer-...">` com a cor e espessura real do fio, arcos `A` nos pinos e contorno físico do tear.
- **JSON**: `WeaveResult` completo (com `metrics`, `threads`, `steps` e metadados de `progress`) — reabrível no modo tecelagem do app web.

## 11. Gabarito de furação 1:1 e gerador PDF vetorial puro — `crates/weaver-cam` e `packages/core/src/pdf.ts`

Para a construção física do tear por marcenaria ou serralheria:

1. **Gabarito Vetorial SVG 1:1**:
   - Emite desenho vetorial onde 1 unidade = 1 mm físico.
   - Cada pino contém cruz de centro milimétrica e círculo correspondente ao diâmetro real da broca de furação (`drillDiameterMm`).
   - Inclui marcadores numéricos a cada 10 pinos, eixos ortogonais principais e **régua de calibração de 100 mm** para aferição direta com paquímetro ou fita métrica após a impressão.
2. **Ladrilhamento Multi-páginas em PDF Puro (`pdf.ts`)**:
   - Implementação independente de escritor PDF 1.4 sem dependências de terceiros, com cálculo exato de offsets de tabela `xref` e tipografia `WinAnsiEncoding`.
   - Gera uma **página de capa (visão geral)** com diagrama da grade de folhas montada e especificações físicas.
   - Decompõe teares maiores que a folha física (ex: aro de 711 mm em papel A4 de 210 × 297 mm) em uma grade de $L \times C$ blocos com margem de sobreposição de 10 mm e culling de vão central.
   - Cada folha impressa traz: marcas de corte e registro em cruz nos quatro cantos, identificador de coluna/linha (ex: `Folha L2·C3`), e **régua de conferência local de 50 mm** com o aviso explícito de impressão em escala 100% (sem ajuste de página).

## 12. Estimativa física de tecelagem e consumo de carretéis — `packages/core/src/estimate.ts`

Para planejamento prático de tecelagem manual:

- **Tempo Ativo**: $\text{tempo\_cordas} = N_{\text{passos}} \times t_{\text{corda}}$ (padrão: 6 s por corda, calibrado a partir das sessões de tecelagem de Vrellis).
- **Tempo de Preparo (Overhead)**: $\text{tempo\_overhead} = N_{\text{amarrações}} \times t_{\text{amarração}} + N_{\text{trocas}} \times t_{\text{troca}}$ (padrão: 120 s para amarração e ancoragem inicial de um carretel novo, 10 s para alternância entre fios em estratégias intercaladas).
- **Consumo de Meadas com Margem de Segurança**:
  $$\text{fio\_necessário}_t = \text{comprimento\_físico}_t \times (1 + \text{margem}) + \text{sobras\_amarração}$$
  O número de carretéis/bobinas por cor é calculado por $\lceil \text{fio\_necessário}_t / L_{\text{carretel}} \rceil$ (ex: carretéis de 1.000 m com 10% de margem e 300 mm de ponta para nós).
- **Tempo Restante Dinâmico**: Permite calcular em tempo real o tempo restante a partir de qualquer passo $k$ no reprodutor web.

## 13. Cinemática e percursos de G-code para robôs/plotters XY — `crates/weaver-cam`

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

## 14. Sincronização e retomada de progresso sem servidor — `packages/core/src/progress.ts`

Para permitir que o tecelão alterne livremente entre computador de mesa e celular/tablet na bancada sem exigir contas na nuvem ou banco de dados:

1. **Fingerprint Criptográfico Leve (`weaveFingerprint`)**:
   - Hash FNV-1a de 32 bits determinístico calculado sobre a contagem de pinos, dimensões, lista de passos e ordem de fios. Retrocompatível com projetos circulares da v0.3.
2. **Códigos Compactos com Checksum (`encodeProgressCode`, `decodeProgressCode`)**:
   - Formato padronizado: `WA1-<fingerprint>-<passo36>-<checksum>` (ex: `WA1-k3x9q2-1f4-7a`).
   - O checksum de 2 caracteres em base 36 valida a integridade do código e impede que erros acidentais de digitação desloquem o progresso da obra.
3. **Sincronização por Link e Reconciliação**:
   - O progresso pode ser compartilhado diretamente via URL através da âncora `#progress=WA1-...`.
   - Ao importar ou reabrir arquivos `.weave.json` com campo `progress: { index, updatedAt }`, a função `mergeProgress` compara com o histórico local do navegador e eleva automaticamente o progresso para o timestamp mais recente.

## 15. Otimizações de Desempenho e Arquitetura de Execução

O Weaver Art adota arquitetura de alta performance com divisão estrita de responsabilidades:

### 15.1 Matriz Esparsa CSR de Cordas (`SparseChordMatrixCSR`)

- Todas as cordas rasterizadas do tear residem em uma estrutura compacta CSR com indexação canônica triangular $O(1)$:
  $$k = a \cdot N - \frac{a(a+1)}{2} + (b - a - 1) \quad (a < b)$$
- Consumo de heap estritamente contido abaixo do teto RNF-03 ($\le 130$ MB para $N=250$ em grade $600 \times 600$).

### 15.2 Comunicação Zero-Copy via SharedArrayBuffer e Atomics

- **ControlBlock (128 bytes)**: 32 bytes de controle atômico `Int32Array` e 96 bytes de métricas `Float32Array`.
- **WeavingPathBuffer (byte 128 em diante)**: 8 bytes por passo (`fromPin`, `toPin`, `spoolId`, `windings`, `scoreNormalized`).

### 15.3 Desempenho em CPU vs GPU

- A tecelagem de string art possui uma natureza sequencial: a escolha da corda no passo $t+1$ depende criticamente da alteração pontual sofrida pelo canvas no passo $t$ e da posição final do pino.
- O dispatch de pipelines de computação em GPU envolve latências de barreira e sincronização de buffer entre 0,5 ms e 2 ms por chamada. Em 4.000 passos sequenciais, o overhead de sincronização da GPU consumiria de 2 a 8 segundos.
- Por outro lado, a combinação de CPU Rust SIMD (`f32x4`), matriz CSR com localidade L1/L2 e ponte Wasm de memória compartilhada atinge latências inferiores a 0,1 ms por passo, garantindo desempenho interativo superior com menor consumo energético e compatibilidade universal em qualquer navegador.

## Especificação Matemática e Algorítmica

Qualquer manutenção nos crates `weaver-dsp` e `weaver-solvers` deve obedecer estritamente às formulações abaixo.

---

## 1. Transformação Afim de Enquadramento (Invariância JS $\leftrightarrow$ Rust)

Dada uma imagem de entrada de dimensões $(W_{\text{in}}, H_{\text{in}})$ e uma grade de saída $(W_{\text{out}}, H_{\text{out}})$ com raio útil $R_{\text{out}} = \frac{\min(W_{\text{out}}, H_{\text{out}})}{2}$:

1. Define-se o raio base de referência pela menor dimensão da foto:
   $$R_{\text{in}} = \frac{\min(W_{\text{in}}, H_{\text{in}})}{2}$$
2. Para um fator de `zoom` $> 0$ e deslocamentos normalizados $\text{pan}_x, \text{pan}_y \in [-1, 1]$:
   $$\text{scale} = \frac{R_{\text{in}}}{R_{\text{out}} \cdot \text{zoom}}$$
   $$x_{\text{in}} = \frac{W_{\text{in}} - 1}{2} - \text{pan}_x \cdot R_{\text{in}} + (\Delta x \cos\theta + \Delta y \sin\theta) \cdot \text{scale}$$
   $$y_{\text{in}} = \frac{H_{\text{in}} - 1}{2} - \text{pan}_y \cdot R_{\text{in}} + (-\Delta x \sin\theta + \Delta y \cos\theta) \cdot \text{scale}$$

- **Atenção:** O sinal negativo em $-\text{pan}_x R_{\text{in}}$ e $-\text{pan}_y R_{\text{in}}$ garante que arrastar o mouse para a direita/baixo mova a imagem para a direita/baixo na tela. Tanto o preview rápido em TypeScript quanto o `apply_affine_transform` em Rust devem usar exatamente esta equação.

---

## 2. O Algoritmo Monocromático de Petros Vrellis (Referência Base)

Para validar a nitidez estrutural (óculos, olhos, nariz, boca), o modo **Monocromático (Fio Preto sobre Fundo Branco)** é o padrão de referência e funciona por subtração linear direta na matriz de luminância:

1. **Inicialização:** A tela inicia branca ($C(p) = 1.0$) e o alvo $T(p) \in [0.0, 1.0]$ representa a luminância preparada (com CLAHE ativo). Portanto, a "escuridão desejada" (erro inicial) em cada pixel é $E^{(0)}(p) = 1.0 - T(p) = C^{(0)}(p) - T(p)$.
2. **Pontuação da Corda Candidata $L$:**
   Para cada corda candidata com pesos sub-pixel $w_p = \frac{\text{weight\_u8}(p)}{255.0}$, calcula-se a integral ponderada pelo Mapa de Importância Facial $W(p)$ dividida pela integral de cobertura da corda:
   $$\text{Score}(L) = \frac{\sum_{p \in L} W(p) \cdot w_p \cdot \left( C^{(t)}(p) - T(p) \right)}{\left(\sum_{p \in L} w_p\right)^\gamma}$$
   onde $\gamma \in [0.85, 1.0]$ e o denominador usa a soma dos pesos sub-pixel $\sum w_p$ (e nunca `pixel_indices.len()`, evitando viés direcional de Xiaolin Wu).
3. **Atualização da Tela (Atenuação):**
   Ao escolher a corda vencedora $L^_$, escurece-se a tela ao longo de $L^_$ por uma taxa calibrada pelo orçamento de linhas ($\alpha_{\text{eff}} \approx \frac{120}{K_{\max}}$, tipicamente entre $0.02$ e $0.04$):
   $$C^{(t+1)}(p) = \max\left(0.0, \; C^{(t)}(p) - \alpha_{\text{eff}} \cdot w_p\right)$$

- **Por que NÃO multiplicar por $(C(p) - s)$ no ganho do fio Preto?**
  Multiplicar o erro $(C - T)$ por $C(p)$ faz com que regiões muito escuras (como armações de óculos pretas, onde $T = 0$) percam metade do seu peso assim que $C(p)$ cai para $0.5$, fazendo o algoritmo abandonar os óculos cinzentos e espalhar fios na pele clara. O erro linear $(C^{(t)}(p) - T(p))$ garante que os óculos e pupilas continuem recebendo fios até atingirem $C(p) \approx T(p) = 0$.

---

## 3. Extensão Policromática CMYK com Remoção de Sub-Cor (UCR / GCR)

Para evitar que fios coloridos (Amarelo, Magenta, Ciano) tentem escurecer roupas pretas ou óculos (o que gera anéis amarelos na borda e borra o rosto):

1. Para cada pixel $p$ com alvo colorido $T(p) = [R_T, G_T, B_T]$:
   - Calcula-se o componente acromático preto: $K_T(p) = 1.0 - \max(R_T, G_T, B_T)$.
   - Calcula-se o croma real: $\text{Chroma}(p) = \max(R_T, G_T, B_T) - \min(R_T, G_T, B_T)$.
2. **Quando o carretel avaliado é Cromático ($C, M, Y$):**
   - Se $\text{Chroma}(p) < 0.04$ (pixel neutro: fundo branco, moletom preto, cabelo preto, armação de óculos), o alvo cromático efetivo para este fio é $[1.0, 1.0, 1.0]$ (nenhum fio colorido deve ser depositado ali!).
   - Caso contrário, remove-se $90\%$ do componente preto ($T_{\text{croma}}(p) = \min(1.0, T(p) + 0.90 \cdot K_T(p))$), de modo que o fio colorido atue **exclusivamente no matiz e saturação** (pele, lábios), deixando a sombra escura para o fio Preto ($K$).
