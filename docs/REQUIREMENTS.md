# Especificação Completa de Engenharia de Requisitos e Regras de Negócio (`docs/REQUIREMENTS.md`)

Este documento é a **Fonte Única da Verdade (Single Source of Truth)** para o escopo funcional, matemático, mecânico e não-funcional do **Weaver Art**. Nenhum requisito listado abaixo pode ser omitido, simplificado ou desativado por agentes de IA durante manutenções.

---

## 1. Regras de Negócio e Invariantes Físicas (RN)

- **RN-01 (Continuidade Física do Fio por Lote):** A obra física é tecida com um fio contínuo a partir de um carretel. Dentro de um mesmo lote de cor, o pino de chegada (`to_pin`) do passo $t$ é obrigatoriamente o pino de partida (`from_pin`) do passo $t+1$.
- **RN-02 (Separação Estrutural vs. Cromática — UCR/GCR):** Em retratos policromáticos (`CMYK`, `RGB` ou `Paleta Customizada`) sobre fundo branco, a estrutura anatômica, sombras profundas, pupilas, sobrancelhas, cabelos escuros e armações de óculos são responsabilidade exclusiva do **Carretel Preto ($K$)**. Os carretéis cromáticos ($C, M, Y$ ou cores do usuário) só devem atuar em pixels que possuam saturação cromática real ($\text{Chroma} = \max(R,G,B) - \min(R,G,B) \ge 0.04$), descontando o componente acromático neutro $K_T = 1.0 - \max(R,G,B)$. É proibido que fios Amarelos, Cianos ou Magentas tentem escurecer roupas pretas, bordas ou óculos escuros.
- **RN-03 (Hierarquia Óptica de Camadas — Ordem de Pintor):** Como a sobreposição física de fios opacos é não-comutativa, o agendamento por épocas (_Coarse-to-Fine_) deve tecer uma base tonal inicial de Preto ($K$), aplicar as camadas cromáticas ($Y, M, C$) no meio e **obrigatoriamente finalizar com uma camada de Preto ($K$) (e Branco $W$ opcional) no topo da pilha física**, garantindo que óculos, pupilas e contornos de alta frequência fiquem nítidos por cima das linhas coloridas.
- **RN-04 (Viabilidade Humana de Trocas de Carretel):** Cada troca manual de carretel na vida real exige cortar o fio, dar nó e amarrar o novo carretel (~90 segundos por troca). As estratégias assistidas de agendamento devem evitar a alternância frenética linha a linha, mantendo o número de trocas humanamente viável, e caso um carretel sature antes do fim da sua cota de época, o agendador deve saltar automaticamente para o próximo carretel (`skip_saturated_spool`) sem encerrar o solver prematuramente.
- **RN-05 (Segurança Mecânica de Furação do Aro):** Na fabricação real do aro (MDF, compensado naval ou alumínio), a espessura de parede livre entre dois furos adjacentes é $w_{\text{livre}} = d_{\text{adj}} - \varnothing_{\text{broca}}$, onde $d_{\text{adj}}$ é a distância centro-a-centro entre pinos vizinhos. O sistema deve classificar e alertar:
  - $w_{\text{livre}} \ge 1.5\text{ mm} \implies \text{SEGURO (Verde)}$
  - $0.0\text{ mm} < w_{\text{livre}} < 1.5\text{ mm} \implies \text{ALERTA DE PAREDE FINA / RISCO DE ROMPIMENTO (Amarelo)}$
  - $w_{\text{livre}} \le 0.0\text{ mm} \implies \text{ERRO CRÍTICO DE COLISÃO DE BROCA (Vermelho)}$
- **RN-06 (Compensação de Resolução vs. Espessura Física do Fio):** A opacidade/atenuação efetiva $\alpha_{\text{efetivo}}$ na matriz de estado deve ser invariante à resolução da malha de pixels e calibrada pelo diâmetro do tear ($D$ em mm), espessura real do fio ($t_f$ em mm), resolução ($R_{\text{px}}$) e orçamento total de linhas ($K_{\max}$), garantindo que o solver utilize todo o orçamento de linhas (ex: $4.000$ a $8.000$ linhas) sem saturar prematuramente na metade e sem deixar a imagem lavada.
- **RN-07 (Escala Real 1:1 e Culling de Folhas Vazias no Gabarito):** A paginação do gabarito de furação em folhas `A4`, `A3` ou `Carta` deve manter escala geométrica estrita de $1:1$ em milímetros, incluir cruzetas de registro fiduciais (`+`) nos 4 cantos, margem de superposição para colagem, régua física de aferição (`100.0 mm` no PDF / `50.0 mm` no HUD) e descartar automaticamente as folhas internas que caem inteiramente no vão central vazio do aro (`is_empty_interior`).
- **RN-08 (Imutabilidade do Enquadramento Escolhido pelo Usuário):** Quando o usuário posicionar a foto manualmente (arrastando com o mouse ou ajustando os seletores de `Zoom`, `Pan X`, `Pan Y` e `Rotação`), **nenhuma** alteração em outros parâmetros (como trocar o Preset, mudar o número máximo de linhas ou receber respostas assíncronas do Web Worker) pode mover a foto ou sobrescrever os valores de enquadramento escolhidos pelo usuário.

---

## 2. Requisitos Funcionais Exaustivos por Subsistema (RF)

### Subsistema 1: Enquadramento, Processamento de Sinais e Visão Computacional (`weaver-dsp` & `studio-view`)

- **RF-1.1 — Enquadramento Híbrido (Manual Livre a 60 FPS + Enquadramento Automático pelo Rosto):**
  - **Modo Manual Interativo:** O usuário pode mover a foto arrastando diretamente sobre o canvas de alvo (`PointerEvents` drag para `Pan X` e `Pan Y` em $[-100\%, +100\%]$), aplicar `Zoom` ($0.50\times$ a $6.00\times$) via roda do mouse ou _slider_, e `Rotação` ($-180^\circ$ a $+180^\circ$). A direção do movimento da imagem deve acompanhar exatamente a direção do mouse, com renderização imediata no cliente (< 2ms via `ctx.drawImage`).
  - **Modo Automático (`Enquadrar rosto`, aplicado ao carregar a foto):** detector de rostos **Viola-Jones** em Rust puro (`weaver-dsp/src/face_framing.rs`, cascata frontal do OpenCV em `haar_frontalface.rs`) localiza a caixa do rosto e ajusta `Zoom`, `Pan X` e `Pan Y` para que ela ocupe **95% do diâmetro** do tear (alvo **Rosto**, padrão — corta topo do cabelo e orelhas) ou 80% da cabeça (alvo **Cabeça e ombros**, que também é o fallback sem rosto detectado, via Sobel + pele YCbCr + prior central). Cliques repetidos alternam entre os rostos de fotos com várias pessoas.
- **RF-1.1b — Vista à Distância:** a simulação oferece os modos **Fios (tamanho real)** e **Vista à distância**; este aplica desfoque gaussiano $\sigma_{mm} = 0{,}6 \cdot d_m$ (≈ 2′ de arco de acuidade visual, $d \in [1, 6]$ m, padrão 3 m) convertido para pixels pela escala do canvas, e mostra lado a lado a foto enquadrada (alvo preparado) com o mesmo desfoque. Liga automaticamente ao final da geração.
- **RF-1.2 — Pré-processamento de Contraste, Curva Radiométrica e CLAHE:**
  - Controles ajustáveis de **Contraste**, **Brilho** e **Correção Gamma ($\gamma$)**.
  - Implementação completa de **CLAHE (_Contrast Limited Adaptive Histogram Equalization_)** com _toggle_ de ativação e _slider_ de `Limite de corte CLAHE (Clip Limit)`, operando com interpolação bilinear entre _tiles_ sobre o canal de luminância para realçar detalhes locais (olhos, armação de óculos, fios de cabelo) sem destruir a cromaticidade RGB nos modos coloridos.
- **RF-1.3 — Operadores Morfológicos Matemáticos:**
  - Seletor permitindo aplicar sobre a imagem base os operadores:
    1. `Nenhuma`
    2. `Erosão` ($\text{Erode}$)
    3. `Dilatação` ($\text{Dilate}$)
    4. `Abertura` ($\text{Opening} = \text{Dilatação}(\text{Erosão}(I))$ — remove ruídos claros isolados)
    5. `Fechamento` ($\text{Closing} = \text{Erosão}(\text{Dilatação}(I))$ — consolida traços escuros finos como óculos e pupilas)
    6. `Gradiente Morfológico` ($\text{Dilatação} - \text{Erosão}$ — extração de contornos morfológicos)
- **RF-1.4 — Detecção de Bordas Estruturais (Sobel e Canny) e Fusão de Alta Frequência:**
  - Seletor de detector de bordas: `Nenhuma`, `Sobel` (magnitude e direção de gradiente) e `Canny` (filtro Gaussiano $5\times 5$, gradiente direcional, Supressão Não-Máxima para afinar bordas para 1px e limiarização por histerese dupla).
  - _Slider_ contextual de `Peso de Fusão de Bordas` ($\beta_{\text{borda}} \in [0.0, 0.5]$) que funde o mapa de bordas à imagem preparada para forçar o delineamento de traços faciais.
- **RF-1.5 — Ponderação de Importância (_Importance Map_ $W(x,y)$ / Foco Facial) Automática e Pincel Manual:**
  - **Composição Automática:** Gera a matriz espacial de pesos $W(x,y)$ combinando saliência facial, mapa de bordas estruturais, foco Gaussiano central suave e _vignette_ perimétrico (reduzindo o peso junto aos pinos externos e na roupa inferior para impedir formação de "cortinas verticais").
  - **Ferramenta de Pincel de Foco Manual Interativo:** Permite ao usuário pintar diretamente sobre o canvas na aba `2. Mapa W(x,y)` com dois modos alternáveis (`+ Reforçar Nitidez` para olhos/óculos e `- Reduzir Peso` para fundo/roupa), ajuste de raio do pincel via roda do mouse e botão `Limpar`, atualizando os pesos no Worker Wasm via `apply_user_importance_brush` sem recalcular os estágios anteriores do DSP.
- **RF-1.6 — Transformada de Radon e Filtro Rampa (Ram-Lak):**
  - Projeção da imagem preparada no espaço de sinograma polar $R(\rho, \theta)$ e aplicação do filtro passa-alta em rampa (_Ramp Filter / Ram-Lak_) no domínio discreto para pré-condicionamento de reconstrução por retas.
- **RF-1.7 — Inspeção Visual Multi-Estágio em 5 Abas:**
  - Acima da miniatura do alvo, o usuário pode alternar instantaneamente entre as 5 vistas diagnósticas:
    1. `1. Alvo` (`PreparedTargetRGBA` em cores ou mono conforme o modo ativo)
    2. `2. Mapa W(x,y)` (`ImportanceMapRGBA` em mapa de calor térmico editável por pincel)
    3. `3. Bordas` (`EdgesRGBA` exibindo o mapa Sobel/Canny)
    4. `4. Radon` (`RadonSinogramRGBA` exibindo o sinograma filtrado)
    5. `5. Erro` (`ResidualErrorRGBA` exibindo a diferença instantânea $\vert{}T - S\vert{}$)

---

### Subsistema 2: Geometria Discreta, Rasterização e Física do Tear (`weaver-domain`)

- **RF-2.1 — Formatos de Tear Polimórficos e Importação Customizada:**
  - Suporte completo e parametrizado em milímetros para:
    1. `Circular (Petros Vrellis)`: Diâmetro $D\text{ (mm)}$ e número de pinos $N$.
    2. `Elíptico`: Largura $W\text{ (mm)}$, Altura $H\text{ (mm)}$ e número de pinos $N$ distribuídos por quadratura de comprimento de arco (Simpson + refinamento de Newton-Raphson).
    3. `Retangular / Quadrado`: Largura $W\text{ (mm)}$, Altura $H\text{ (mm)}$ e contagem de pinos $N_x \times N_y$.
    4. `Polígono Regular`: Número de lados $K \in [3, 16]$, diâmetro inscrito $D\text{ (mm)}$ e total de pinos $N$.
    5. `Customizado via CSV`: Upload de arquivo `.csv` com coordenadas arbitrárias de pinos $(x_i, y_i)$.
- **RF-2.2 — Cálculo Exato das 4 Tangentes em Pinos Cilíndricos Finitos ($\varnothing\_{\text{pino}} > 0$):**
  - Modelagem física do raio do prego $r_p = \frac{\varnothing_{\text{pino}}}{2}$. Calcula as tangentes externas paralelas ($\text{CW}\to\text{CW}$ e $\text{CCW}\to\text{CCW}$) e internas cruzadas ($\text{CW}\to\text{CCW}$ e $\text{CCW}\to\text{CW}$, com desvio angular $\Delta\phi = \arcsin(2r_p / D_{ij})$), registrando os lados de saída e chegada de cada passo.
- **RF-2.3 — Motores de Rasterização Selecionáveis e Cache Esparso CSR (`SparseChordMatrixCSR`):**
  - Seletor na UI permitindo escolher entre:
    1. `Xiaolin Wu Anti-aliased (Subpixel)`: Rasterização contínua com pesos fracionários sub-pixel $w \in [1, 255]$.
    2. `Bresenham Binário`: Rasterização inteira rápida.
  - Armazenamento em 3 vetores contíguos (`chord_offsets`, `pixel_indices`, `pixel_weights`) com indexação canônica recíproca $O(1)$ e respeito estrito ao `Gap mínimo (minPegGap)`.

---

### Subsistema 3: Modelagem de Espaço de Cores, Calibração e Matriz de Estado (`weaver-domain` & `weaver-solvers`)

- **RF-3.1 — Modos de Paleta Suportados:**
  1. `Monocromático (Preto sobre Branco)`
  2. `CMYK (Subtrativo Petros Vrellis)`
  3. `RGB (Oclusivo)`
  4. `Paleta Customizada pelo Usuário (N-Colors)`: Permite ao usuário definir cores customizadas de carretéis e cor de fundo.
- **RF-3.2 — Calibrador de Cor de Meada Real por Fotografia (`Calibrar cor de meada real`):**
  - Permite ao usuário fazer upload de uma fotografia de um carretel/meada real, extraindo a cor média calibrada na região central e fornecendo o código Hex para uso imediato na paleta.
- **RF-3.3 — Projeção no Fecho Convexo (_Gamut Mapping_ em CIELAB):**
  - Algoritmo que projeta cores fora de gamut da imagem alvo para o ponto mais próximo dentro do fecho convexo (_Convex Hull_) gerado pelos carretéis escolhidos pelo usuário no espaço perceptual CIELAB, preservando a luminância $L^*$.
- **RF-3.4 — Modelos Físicos de Mistura Óptica Selecionáveis:**
  1. `Oclusão Porter-Duff`: Mistura física opaca não-comutativa.
  2. `Linear Subtrativo`: Mistura comutativa de absorção de pigmento.
  3. `Beer-Lambert`: Mistura multiplicativa de transmitância espectral.
- **RF-3.5 — Métricas Perceptuais de Erro Selecionáveis:**
  1. `CIELAB ΔE 2000` / `ΔE 76`
  2. `Redmean Ponderado`
  3. `RGB Linear`

---

### Subsistema 4: Motores de Busca e Otimização (`weaver-solvers`)

- **RF-4.1 — Algoritmo Guloso Iterativo (`IterativeGreedy`):**
  - Busca gulosa passo a passo com normalização pela integral sub-pixel de comprimento da corda ($\frac{1}{(\sum w_p)^\gamma}$), limite de repetições por par de pinos (`maxChordRepeats`), fila Tabu de pinos recentes e desempate determinístico.
- **RF-4.2 — Busca em Feixe (`BeamSearch`):**
  - Busca em árvore mantendo $B$ estados candidatos em paralelo (`beamWidth`) e avaliando $d$ passos à frente (`beamDepth`) sobre um pool estático pré-alocado de estados `CanvasStateSoA`.
- **RF-4.3 — Otimização Global Contínua (`GlobalNnlsFista`) + Roteamento em Grafo:**
  - Solver global de Mínimos Quadrados Não-Negativos com penalidade esparsa $L_1$ via **FISTA Livre de Matriz (_Matrix-Free_)** operando diretamente sobre a `SparseChordMatrixCSR` (`fistaIterations` e `l1RegularizationLambda` ajustáveis), seguido de quantização inteira e costura de circuito contínuo (_Eulerian Path Stitching_) dividido em sub-camadas de pintor.

---

### Subsistema 5: Estratégias de Minimização de Trocas de Carretel (`spool_scheduler.rs`)

- **RF-5.1 — Seletor com as 5 Estratégias de Agendamento Cromático:**
  1. `Épocas Coarse-to-Fine`: Divide o orçamento em Base Estrutural Preta $\to$ Camadas Cromáticas (Y, M, C) $\to$ Acabamento Final de Nitidez no Topo (Preto $K$ e Branco $W$ com elevação do peso de bordas em $W(x,y)$).
  2. `Histerese Dinâmica (Penalidade Lambda)`: Aplica barreira $-\lambda_{\text{troca}}$ ajustável pelo _slider_ `Penalidade de Troca (λ)` para agrupar fios organicamente.
  3. `Run-Length Mínimo`: Trava a troca de carretel até atingir o número mínimo configurado de fios consecutivos ($L_{\min}$).
  4. `Canais Separados (Lote Único por Cor)`: Executa cada cor em um único lote contínuo ($M-1$ trocas totais na obra), aplicando fator de compensação de oclusão nas camadas inferiores.
  5. `Guloso Livre (Sem penalidade)`: Permite troca de cor a cada único passo para simulação teórica.

---

### Subsistema 6: Renderização Física WebGL2, Telemetria e Sistema Mecânico de Furação CAM (`weaver-cam`, `renderer-webgl` & `blueprint-view`)

- **RF-6.1 — Renderizador Físico WebGL2 em Ponto Flutuante (`RGBA16F`):**
  - Acumulação incremental _Zero-Copy_ a 60 FPS lendo novos passos do `SharedArrayBuffer`, _framebuffer_ `RGBA16F` em espaço RGB Linear, perfil cilíndrico sub-pixel de fio, _Screen Pass_ com conversão IEC sRGB, aro externo, pinos metálicos, Zoom/Pan com rato (com eixo $Y$ devidamente alinhado) e fallback para Canvas 2D.
- **RF-6.2 — Telemetria Científica em Tempo Real e Tabela BOM de Carretéis:**
  - Cards atualizados a 60 Hz: `LINHAS`, `FIO (m)`, `TROCAS / NÓS`, `RMSE`, `ΔE (CIELAB)`, `SSIM` (calculado incrementalmente em blocos $8\times 8$ em tempo $O(\vert{}L\vert{})$), `TEMPO (s)` e `TEMPO MANUAL EST.`.
  - Tabela `ESTIMATIVA DE CARRETÉIS (1.000 M POR CARRETEL + 10% MARGEM)` detalhando por cor: Linhas, Fio bruto (m), Com margem de 10% (m), Quantidade de Carretéis e `% de Uso`, além do resumo de `Tempo tecendo` vs. `Tempo em nós e trocas`.
- **RF-6.3 — Vista Dedicada `Gabarito & Furação (CAM)` (Plot de Posicionamento de Furos no Aro):**
  - Viewport CAD interativo com grade milimétrica (`10 mm` e `50 mm`), desenho em escala do aro (diâmetro externo, interno e linha primitiva tracejada), plotagem dos $N$ furos no diâmetro exato da broca ($\varnothing_{\text{broca}}\text{ mm}$) com cruzeta de centro de punção e numeração orientada pela normal externa.
  - **Nível de Detalhe Dinâmico (LOD):** Ajusta a exibição de números de pinos conforme o nível de zoom e posiciona os rótulos das folhas A4 em pílulas nos cantos superiores esquerdos para garantir **zero sobreposição ou colisão de textos** em qualquer zoom.
  - **Inspeção de Parede Livre (`Inspecionar Parede Livre`):** Dá zoom de precisão em dois furos adjacentes cotando o passo linear ($d_{\text{adj}}\text{ mm}$) e a espessura de parede livre ($w_{\text{livre}}\text{ mm}$) com badge de integridade mecânica (`SEGURO`, `ALERTA PAREDE FINA` ou `COLISÃO DE BROCA`).
  - **Tabela Interativa de Coordenadas dos Pinos:** Lista rolável com `(Pino #, Ângulo °, X mm, Y mm)` onde clicar em uma linha centraliza e destaca o respectivo furo no canvas CAD.
- **RF-6.4 — Exportações Técnicas CAM e da Obra:**
  - Na vista `Gabarito & Furação (CAM)`:
    1. `Gabarito PDF (1:1 Paginado)`
    2. `Gabarito SVG (1:1)`
    3. `Tabela Pinos (.csv)`
    4. `G-Code CNC (G81/G83)` com painel de parâmetros de usinagem (`RPM do Spindle`, `Avanço de Mergulho mm/min`, `Profundidade Z mm`, `Passo Peck Q mm`, `Z Seguro mm`, `Plano Retração R mm`).
  - Na vista `Estúdio`:
    1. `Projeto .json`
    2. `Instruções .txt`
    3. `Tabela .csv`
    4. `Vetor .svg`
    5. `Imagem .png`

---

### Subsistema 7: Motor de Presets Reativos e Assistente `Modo Tecelagem` (`preset-engine` & `player-view`)

- **RF-7.1 — Presets Reativos e Ajuste Automático Contextual de Reguladores:**
  - Ao selecionar um Preset (`Vrellis Clássico · Monocromático`, `Retrato Vrellis · Alta Fidelidade (Épocas Coarse-to-Fine)`, `CMYK · Histerese Dinâmica`, `Otimização Global · NNLS / Radon (FISTA)` ou presets clássicos), o sistema carrega automaticamente os valores ótimos de todos os _sliders_ daquele modo e oculta no DOM os controles que não pertencem ao algoritmo selecionado.
  - Se o usuário alterar manualmente algum regulador, o botão `"Restaurar padrão do modo"` é exibido para permitir voltar aos _defaults_ sem afetar o enquadramento (`Zoom / Pan / Rotação`) da foto.
- **RF-7.2 — Assistente Passo a Passo (`Modo Tecelagem`):**
  - Exibe no aro a corda atual destacada com indicação visual e textual do pino de origem (`do pino X`), número gigante do pino destino (`Y`), cor e progresso do lote atual, sentido físico de contorno (`contornar no sentido horário` vs. `anti-horário`) e tempo restante dinâmico.
  - **Pausa e Alerta em Troca de Carretel:** Pausa o avanço automático e exibe alerta visual/sonoro sempre que houver transição de cor de carretel.
  - **Ditado por Voz (`TTS`) e Avanço Automático:** Síntese de voz em português (`pt-BR`) sincronizada com o temporizador (só agenda o próximo passo após o término da fala `utterance.onend`), além de suporte a atalhos de teclado (`Espaço`/`Seta Direita`, `Seta Esquerda`, `P`) e salto direto (`Ir para o passo`).
  - **Persistência `IndexedDB` e Sincronização via Código de Retomada / QR Code:** Salva o progresso automaticamente no navegador, atualiza o hash da URL (`#progress=WA1-...`) com botões de `Copiar código`, `Colar código`, `Salvar retomada` e modal **`Abrir no Celular (QR Code)`** com gerador de QR Code SVG vetorial nativo.

---

## 3. Requisitos Não-Funcionais (RNF)

- **RNF-01 (Performance de Otimização):** O motor em Rust/Wasm deve avaliar as cordas através da `SparseChordMatrixCSR` sem alocações na memória Heap durante o _hot loop_ e sem recalculações redundantes de matrizes de `250.000` pixels a cada passo.
- **RNF-02 (Determinismo Bit a Bit):** Execuções repetidas com a mesma imagem e parâmetros devem produzir exatamente a mesma sequência de passos `WeavingPathBuffer`.
- **RNF-03 (Teto de Memória CSR):** O consumo de memória da `SparseChordMatrixCSR` não deve exceder $135\text{ MB}$.
- **RNF-04 (Fluidez de Interface a 60 FPS):** Nenhuma operação de UI (especialmente arrastar a foto para enquadrar ou dar zoom no canvas) pode bloquear a _Main Thread_ por mais de $16.6\text{ ms}$.
- **RNF-05 (Arquitetura 100% Client-Side e Hospedagem Estática):** Toda a computação deve ocorrer localmente no navegador do usuário via Web Workers + WebAssembly + `SharedArrayBuffer` (com headers `COOP`/`COEP` configurados em `vite.config.ts`, `vercel.json`, `_headers` e fallback `coi-serviceworker.js`), permitindo publicação online gratuita sem custo de servidor.
- **RNF-06 (Cobertura de Testes Automatizados):** Todos os crates Rust (`cargo test --workspace`) e a tipagem estrita TypeScript (`tsc --noEmit`) devem passar com zero erros antes de qualquer entrega.
