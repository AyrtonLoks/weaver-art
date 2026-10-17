---
name: weaver-art-engineering
description: >-
  Expert guide for developing, tuning, profiling, and debugging Weaver Art string art algorithms,
  layered color strategies (CMYK, Vrellis), physical loom geometry, and portrait tone preprocessing.
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

### 4. Avaliação de Fidelidade com Métricas Perceptuais e Gamut Mapping

Ao pré-processar imagens e avaliar fidelidade de tecelagem:

1. **Gamut Mapping Preventivo com `GamutHull`**:
   - Antes de enviar a imagem ao solver, instancie `GamutHull::new(background, spools)` e mapeie os pixels via `hull.map_image(&input, &mut output)` ou `hull.project_preserve_luminance(lab)`.
   - Isso garante que feições em fotos reais que usem cores inexistentes nos carretéis (ex: pele bronzeada em paleta monocromática ou azul elétrico em CMYK) colapsem no tom neutro correto mantendo a luminosidade idêntica.

2. **Validação e Benchmark CIEDE2000 (Sharma 2005)**:
   - Toda alteração em métricas de erro deve validar os pares canônicos do dataset de Sharma:
     - Par 1: $(50, 2.6772, -79.7751)$ vs $(50, 0, -82.7485) \implies \Delta E_{00} = 2.0425$.
     - Par 2: $(50, 3.1571, -77.2803)$ vs $(50, 0, -82.7485) \implies \Delta E_{00} = 2.8615$.
     - Par 25: $(60.2574, -34.0099, 36.2677)$ vs $(60.4626, -34.1751, 39.4387) \implies \Delta E_{00} = 1.2644$.

3. **Métricas de Telemetria e Decisão**:
   - `deltaE`: erro médio perceptivo CIEDE2000 entre alvo mapeado e estado atual simulado em linear (ideal < 2.3 a 3.5 em retratos complexos).
   - `RMSE`: raiz do erro quadrático médio em intensidade linear normalizada $[0, 1]$.
   - `SSIM`: similaridade estrutural focalizando alta frequência e nitidez de bordas (valores > 0.70 a 0.85 indicam excelente preservação facial).

### 5. Fabricação Física e Gabaritos de Furação (SVG / PDF / CSV / BlueprintView)

Para gerar moldes em escala real 1:1 para a oficina/marcenaria:

1. **Geração via `weaver-cam` (Rust / Wasm) e UI**:
   - Utilize `BlueprintTiler::new(loom, config)` configurado com `PaperSize::A4`, `A3` ou `Letter`.
   - Obtenha o SVG mestre 1:1 via `tiler.to_master_svg()`.
   - Obtenha o PDF multi-páginas 1:1 vetorial via `tiler.to_multipage_pdf()`.
   - Páginas que caem inteiramente no vão central vazio são automaticamente identificadas com `is_empty_interior = true` e omitidas do PDF impresso.
   - Na interface web, a classe `BlueprintCanvas` plota o aro em tempo real com ampliação até escala centesimal (`zoomFreeWall`), facilitando a inspeção da folga entre furos adjacentes antes da furação.
2. **Conferência de escala**: meça com paquímetro a régua de 100.0 mm impressa no rodapé de cada folha ativa para garantir que a impressora operou em escala 100% (desativar "Ajustar à página").
3. **Tabela Mecânica de Coordenadas (CSV)**:
   - Gere com `generate_mechanical_csv(&loom)` para obter as colunas completas com precisão quadrimensional (`0.0001 mm`):
     `pin_number,angle_deg,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm`.

### 6. Exportação e Validação de G-code CNC para Furação e Tecelagem

1. **Furação CNC do Aro (`weaver-cam` e `BlueprintView`)**:
   - Utilize `generate_drilling_gcode(&loom, &params)` ou a geração integrada no `BlueprintView`.
   - Configure `GcodeDrillingParams`:
     - `spindle_rpm`: 12000 a 18000 RPM;
     - `plunge_feed_mm_min`: avanço de penetração (ex: 300 mm/min);
     - `drill_depth_mm`: profundidade total Z (negativo na peça, ex: 10.0 mm);
     - `peck_depth_mm`: `Some(2.0)` para ciclo pica-pau `G83` ou `None` para ciclo simples `G81`.
     - `safe_z_mm`: plano de segurança Z (ex: 5.0 mm);
     - `retract_r_mm`: plano de retração R (ex: 1.0 mm).
   - A furação percorre os pinos em sequência perimétrica contígua ($0 \to 1 \to \dots \to N-1$), minimizando deslocamentos em vazio.
2. **Plotters Cartesianos de Tecelagem (Fios)**:
   - Utilize `toGcode(result, opts)` para traçar os caminhos de linha entre os pinos com arcos tangentes `G2`/`G3`.
   - Inspecione visualmente o percurso em um simulador CNC (ex: NC Viewer) para verificar:
     - Folga radial da cabeça ao redor dos pinos (`toolRadius = pegRadius + clearanceMm`);
     - Sentido correto dos arcos `G2`/`G3`;
     - Pausas programadas `M0` nas trocas de carretel/cor.

### 7. Arquitetura de Aceleração (Rust/Wasm + WebGL2)

1. Nenhum cálculo pesado de String Art deve rodar em JavaScript na Main Thread ou em Workers JS legados.
2. **Recompilar o Kernel WebAssembly (se editar Rust)**:
   ```bash
   npm run build:wasm
   ```

### 8. Pipeline de Verificação Padrão

Sempre execute:

```bash
npm run check
npm run build
```

### 9. Otimização e Ajuste Fino para Retratos (Fidelidade Petros Vrellis)

Para atingir a qualidade expressiva e reconhecimento facial característicos da obra de Petros Vrellis:

1. **Enquadramento e Zoom Facial**:
   - Assegure que a cabeça e as feições ocupem entre 75% e 85% do diâmetro útil do tear circular.
   - Posicione os olhos no terço superior da área circular (evite colocar o centro do nariz exatamente no centro geométrico).
   - Na Web UI, use o botão "Enquadrar Rosto (80%)" ou ajuste Zoom ~ 1.25 a 1.40 com pan vertical.

2. **Uso dos Presets Calibrados**:
   - `portrait-mono`: monocromático de alta fidelidade com resolução de 500 px, 4.000 cordas, repetições = 2, proteção de realce 2.5, CLAHE ativado, unsharp mask $\sigma = 1.5$ e saliência multiescala $0.8$.
   - `portrait-cmyk`: retrato em 4 camadas sequenciais (Amarelo 30%, Magenta 5%, Ciano 25%, Preto 40%) com 6.000 cordas e rollover dinâmico para o preto final.

3. **Ajuste de Parâmetros de Fidelidade Facial**:
   - **`highlightProtection` (2.0 a 4.0)**: Se bochechas, testa ou ponta do nariz ficarem sujas de linhas escuras, aumente o fator para 3.0 ou 3.5.
   - **`torsoFeathering` (0.2 a 0.3)** e **`shadowLift` (0.1 a 0.15)**: Em fotos com roupas pretas ou terno, ative ambos para suavizar o tronco e impedir que o corpo roube linhas das feições.

### 10. Arquitetura do Cargo Workspace e SharedArrayBuffer

1. **Camadas dos Crates Rust (`crates/`)**:
   - `weaver-domain` $\rightarrow$ Entidades puras, unidades físicas (`Millimeters`, `Pixels`), lados de tangência (`PegSide`), espaço de cores lineares e CSR. Zero dependências internas.
   - `weaver-dsp`, `weaver-solvers`, `weaver-cam` $\rightarrow$ Processamento de sinal, solvers greedy/beam/NNLS e gabaritos mecânicos. Dependem exclusivamente de `weaver-domain`.
   - `weaver-wasm-adapter` $\rightarrow$ Ponte `wasm-bindgen` para execução no Web Worker e serialização atômica em `SharedArrayBuffer`.
   - `weaver-cli` $\rightarrow$ Binário nativo para testes de desempenho e calibração fora do navegador.
2. **RingBuffer Atômico**:
   - Cabeçalho de controle: `[writeIndex, readIndex, statusFlags, totalSteps]` (`RING_BUFFER_HEADER_WORDS = 4`).
   - Sincronização entre Rust Worker e TS Main Thread via `Atomics.load` e `Atomics.store`.
3. **Detecção e Fallback de Renderizador**:
   - Preferência para pipeline linear `webgl2-rgba16f` com `EXT_color_buffer_float`.
   - Fallback gracioso para `canvas2d-fallback` em ambientes sem suporte a float textures.

### 11. Padrão de Memória Compartilhada (SharedWorkspaceMemory / ADR-003)

1. **Alocação e Instanciação**:
   - Use `SharedWorkspaceMemory.create(capacitySteps)` para instanciar com capacidade padrão (20.000 passos = 160.128 bytes).
   - Verifique `memory.isShared` para confirmar se o buffer está sob `SharedArrayBuffer` com COOP/COEP ou sob `ArrayBuffer` fallback.
2. **Ciclo de Vida do Solver**:
   - Worker atualiza atomicamente `CurrentStepIndex` após escrever cada acorde via `writeStep()`.
   - Main Thread consome em intervalos `requestAnimationFrame` lendo apenas o delta `[lastReadIndex .. currentStepIndex]`.
3. **Métricas de Telemetria**:
   - Atualize `RMSE`, `DeltaE`, `SSIM` e metros de fio diretamente nos slots Float32 para que os cards de telemetria leiam sem sobrecarga de serialização JSON.

### 12. Extensão e Customização de Presets (ADR-005)

1. **Registrar Novo Preset**:
   - Adicione o identificador no tipo `WeaverPresetProfileId` em `domain-contracts/types.ts`.
   - Configure os valores padrão no dicionário `WEAVER_PRESET_PROFILES` em `preset-engine/preset-registry.ts`.
2. **Rastreamento isDirty**:
   - Utilize a classe `ReactivePresetStore` no painel de controle. Sempre que o usuário alterar um slider, chame `store.setParam(chave, valor)`.
   - Para reverter, chame `store.resetParam(chave)` ou `store.resetAllDirty()`.
3. **Novos Controles Contextuais**:
   - Declare o controle no union `WeaverControlId`.
   - Adicione a regra de exibição na função pura `isControlVisible(controlId, config)`.

### 13. Diagnóstico Mecânico CAM de Furação e Parede Livre

Ao dimensionar teares ou avaliar configurações de pinos e brocas:

1. **Passo Linear Cordal entre Furos Adjacentes**:
   - Para tear circular de diâmetro $D = 2R$ e $N$ pinos:
     $$p = 2 R \sin\left(\frac{\pi}{N}\right)$$
   - Para formatos poligonais ou retangulares: $p = \min_{i} \|P_{i+1} - P_i\|$.
2. **Espessura de Parede Livre de Madeira/MDF**:
   $$w_{\text{livre}} = p - \varnothing_{\text{broca}}$$
3. **Limiares de Segurança Mecânica**:
   - $w_{\text{livre}} \ge 1.5\text{ mm}$: **Seguro** (`badge-success`).
   - $0.5\text{ mm} \le w_{\text{livre}} < 1.5\text{ mm}$: **Alerta Parede Fina** (`badge-warning`). Risco de lascamento entre furos na furação com broca rápida.
   - $w_{\text{livre}} < 0.5\text{ mm}$: **Erro Colisão de Broca** (`badge-danger`). Furos se tocam ou a broca destrói a parede divisória.

### 14. Padrão de Ciclo de Furação CNC (G-Code G81)

O gerador de furação CAM do aro emite ciclos canônicos padronizados:

- `G21` (unidades métricas em mm) e `G90` (posicionamento absoluto);
- `G0 Z15.000` (altura de segurança);
- `M3 S3500` com pausa `G4 P2.0` para estabilização de rotação;
- `G98 G81 R2.000 Z-10.000 F150.0` (furação em ponto com retração automática);
- Listagem dos pontos `X... Y...`;
- `G80` (cancelamento do ciclo de furação) e `M5` (desligamento do fuso).

### 15. Pipeline de Inspeção Multi-Estágio do Alvo

Para diagnosticar problemas de preparo da imagem antes do solver:

1. **1. Alvo Preparado**: Imagem recortada afim 2D, com máscara geométrica do tear e equalização CLAHE.
2. **2. Mapa W(x,y)**: Heatmap térmico radiante (Preto $\to$ Vermelho $\to$ Amarelo $\to$ Branco) combinando foco facial multiescala, prior central elíptico e pintura manual do pincel.
3. **3. Bordas**: Convolução Sobel/Canny afinada para 1 px em tom ciano/elétrico sobre fundo preto.
4. **4. Radon**: Sinograma de projeções angulares $\theta \in [0, \pi)$ vs. distâncias radiais $\rho \in [-R, R]$ filtrado com Ram-Lak.
5. **5. Erro Residual**: Diferença absoluta pontual $|T(x,y) - S(x,y)|$.

### 16. Geometria Computacional, Furação e Tangentes Físicas em Rust (`weaver-domain`)

Ao implementar algoritmos nas Camadas 2 (`weaver-solvers`, `weaver-cam`) ou 3 (`weaver-wasm-adapter`):

1. **Instanciação e Parametrização**:
   - Utilize `LoomPhysicalSpec::circle(...)`, `::ellipse(...)`, `::rectangle(...)` ou `::regular_polygon(...)`.
   - Inicialize o motor geométrico com `let loom = LoomGeometry::new(spec);`.
   - Obtenha posições com `loom.pin_position(i)` e normais com `loom.normal_vector(i)`.

2. **Diagnóstico de Furação CAM**:
   - Obtenha o diagnóstico mecânico com `let diag = loom.drilling_diagnostic();`.
   - Inspecione `diag.status` (`Safe`, `WarningThinWall`, `ErrorCollision`), `diag.min_adjacent_distance_mm` e `diag.free_wall_mm`.
   - Para exportar a tabela de coordenadas CNC/polar, utilize `diag.to_csv()`.

3. **Cálculo de Tangentes CW/CCW**:
   - Para obter a reta tangente exata entre dois pinos com sentidos específicos:
     ```rust
     let tangent = loom.pin_tangent(from_pin, from_dir, to_pin, to_dir);
     ```
   - Para obter as 4 combinações possíveis entre pinos distantes:
     ```rust
     let all = loom.all_pin_tangents(from_pin, to_pin);
     ```
   - Converta livremente entre `PegSide` e `WindingDirection` via `.into()`.

4. **Teste Canônico de Aferição**:
   - Sempre certifique que um círculo de $D = 711.2\text{ mm}$ com $N = 200$ pinos resulte em perímetro $\pi D = 2234.30069\text{ mm}$ e passo linear cordal $d_{\text{adj}} \approx 11.171\text{ mm}$ ($711.2 \times \sin(\pi / 200)$).

### 17. Cache de Cordas em Matriz Esparsa CSR e Rasterização (Camada 1 - `weaver-domain`)

Ao construir solvers nas Camadas 2 (`weaver-solvers`, `weaver-dsp`) ou pontes WASM:

1. **Instanciação da Matriz de Cordas**:
   - Utilize `SparseChordMatrixCSR::build(&loom, resolution, min_pin_distance, method)`.
   - Modos suportados: `RasterizerType::XiaolinWuAntialiased` (padrão de alta fidelidade visual) e `RasterizerType::BresenhamBinary` (máxima velocidade / depuração rápida).
   - O mapeamento contínuo utiliza `LoomGridMapping::from_loom(&loom, width, height)`.

2. **Consulta Zero-Copy pelo Solver**:
   - Durante a avaliação gulosa em laço fechado:
     ```rust
     let (pixels, weights) = matrix.get_chord(from_pin, to_pin);
     if pixels.is_empty() {
         // Corda ignorada por d_min ou pinos coincidentes
         continue;
     }
     for (&idx, &w) in pixels.iter().zip(weights.iter()) {
         // Avaliação direta em cache L1/L2
     }
     ```
   - O solver nunca deve alocar vetores dinâmicos ou efetuar round-trips para obter as coordenadas dos pixels.

3. **Verificação de Benchmark de Memória**:
   - Valide que o consumo permaneça sob o teto RNF-03:
     ```bash
     cargo test -p weaver-domain test_memory_ceiling_rnf03 -- --nocapture
     ```

### 18. Pipeline de DSP e Preparação de Imagem Alvo (`weaver-dsp`)

Ao implementar estágios de filtragem ou calibração de imagem alvo:

1. **Sequência Recomendada de Pipes and Filters**:
   - `compute_auto_framing` $\to$ `apply_affine_transform` (com `LoomMask`) $\to$ `adjust_radiometry` (brilho, sigmoide, gamma) $\to$ `clahe_lab` $\to$ `morphology` (abertura/fechamento ou unsharp mask).
2. **Preservação de Detalhes Faciais**:
   - Para óculos, cílios e pupilas: utilize `closing` com elemento estruturante pequeno (`StructuringElement::disc(1)`) para fechar micro-lacunas sem engrossar contornos.
   - Para remoção de ruídos pontuais em áreas claras: utilize `opening` com raio $1$.
   - Para realce de micro-estruturas: utilize `white_tophat` e `black_tophat` somados/subtraídos com ganho atenuado.
3. **Calibração de CLAHE**:
   - Para retratos em tear circular, grade padrão de $8 \times 8$ tiles com `clip_limit` entre $2.0$ e $3.5$ e 256 bins oferece distribuição tonal uniforme sem granulação de ruído em áreas de pele lisa.

### 19. Pré-processamento e Diagnóstico com `DspPipeline` em Rust (`weaver-dsp`)

Ao utilizar ou estender a Camada 2 para preparar imagens de tecelagem:

1. **Execução com Cache de Estágios**:
   - Instancie `let mut pipeline = DspPipeline::new(config);`.
   - Execute com `let diag = pipeline.execute(&rgba, Some(&loom), user_brush);`.
   - Obtenha os buffers RGBA diretamente via `diag.prepared_target_rgba`, `diag.importance_map_rgba`, `diag.edges_rgba`, `diag.radon_sinogram_rgba` ou `diag.edge_and_radon_preview_rgba()`.
2. **Ajuste de Pesos Faciais**:
   - `beta_face` (padrão 3.0): reforça o peso relativo dos olhos, boca e nariz.
   - `beta_edge` (padrão 1.0): reforça o peso do contorno do rosto, sobrancelhas e armação de óculos.
   - `high_freq_blend` (padrão 0.15): escurece fisicamente os pixels de borda na imagem alvo, induzindo o solver a traçar cordas diretamente sobre as linhas de expressão.

### 20. Motor de Solvers e Métricas Incrementais (Camada 2 - `weaver-solvers`)

Ao implementar ou estender solvers gulosos, Beam Search ou FISTA na Camada 2:

1. **Instanciação do Pipeline de Otimização**:
   - Crie a matriz de estado SoA:
     ```rust
     let mut canvas = CanvasStateSoA::from_target_and_background(w, h, &target_linear, background, Some(&importance));
     canvas.set_edge_map(&edges);
     ```
   - Instancie o avaliador óptico e o rastreador de telemetria:
     ```rust
     let evaluator = OpticalModelEvaluator::new(OpticalMixModelType::PorterDuffOcclusion, ColorErrorMetric::LinearRgb);
     let mut tracker = IncrementalMetricsTracker::new(&canvas);
     let mut scheduler = SpoolScheduler::new(strategy, max_steps, initial_spool);
     ```

2. **Avaliação e Aplicação de Cordas em Laço $O(|L|)$**:
   - Para cada corda candidata $(a, b)$, obtenha a fatia de pixels da CSR `(pixels, weights) = matrix.get_chord(a, b)`.
   - Calcule o ganho marginal instantâneo com `evaluator.chord_marginal_gain(&canvas, pixels, weights, &spool, alpha_eff)`.
   - Desconte a penalidade de troca via `scheduler.switch_penalty(spool.id)`.
   - Ao aplicar a melhor corda:
     1. Salve as cores antigas dos pixels interceptados em um buffer temporário.
     2. Aplique a corda: `evaluator.apply_chord(&mut canvas, pixels, weights, &spool, alpha_eff)`.
     3. Atualize a telemetria em tempo $O(|L|)$: `tracker.update_pixels(&canvas, pixels, &old_colors)`.
     4. Avance o agendador: `scheduler.advance_step(spool.id, &spools)`.
     5. Se o agendador solicitar elevação de bordas (`scheduler.active_edge_boost() > 0.0`), atualize `canvas.apply_edge_importance_boost(boost)`.

### 21. Instanciação e Execução dos Solvers com `SolverSession` (Camada 2 - `weaver-solvers`)

Para executar qualquer um dos 3 solvers de forma padronizada via lotes:

1. **Iterative Greedy (`GreedySolver`)**:

   ```rust
   let config = GreedyConfig {
       max_steps: 4000,
       max_chord_repeats: 2,
       length_exponent_gamma: 1.0,
       start_pin: 0,
       tabu_history_size: 0,
   };
   let mut session = SolverSession::new_greedy(config, canvas, matrix, evaluator, scheduler, spools, alpha_eff);
   ```

2. **Beam Search com Pool de $2 \times B$ Estados (`BeamSearchSolver`)**:

   ```rust
   let config = BeamSearchConfig {
       beam_width: 4,      // B em [2, 16]
       lookahead_depth: 2, // d em [2, 4]
       max_steps: 3000,
       max_chord_repeats: 2,
       length_exponent_gamma: 1.0,
       start_pin: 0,
   };
   let mut session = SolverSession::new_beam_search(config, canvas, matrix, evaluator, scheduler, spools, alpha_eff);
   ```

3. **Global NNLS/FISTA com Roteador Euleriano (`GlobalFistaSolver`)**:

   ```rust
   let config = GlobalFistaConfig {
       max_steps: 3000,
       max_chord_repeats: 2,
       fista_iterations: 60,
       l1_regularization_lambda: 0.05,
       painter_layers_per_color: 3,
       start_pin: 0,
   };
   let mut session = SolverSession::new_global_fista(config, canvas, matrix, evaluator, scheduler, spools, alpha_eff);
   ```

4. **Loop Incremental em Lotes (`step_batch`)**:
   ```rust
   while !session.is_finished() {
       let progress = session.step_batch(25); // Processa lote de 25 passos
       // Inspeciona progress.telemetry (ssim, rmse, delta_e) e progress.batch_steps
   }
   ```

### 22. Roteamento Euleriano e Sub-camadas de Pintor

Ao quantizar e encadear soluções contínuas de String Art:

1. **Quantização pelos Maiores Restos**:
   - Converta os pesos $w_k \in \mathbb{R}_+^M$ escalando pelo orçamento de linhas $\sum c_k = K$.
   - Aplique piso inteiro $\lfloor w'_k \rfloor$ e distribua o saldo remanescente ordenando os restos fracionários, respeitando o teto `max_chord_repeats`.
2. **Roteamento Euleriano com Nearest-Neighbor Stitching**:
   - A partir de $p$, priorize cordas ativas incidentes.
   - Se $p$ não tiver cordas ativas restantes, localize o pino ativo mais próximo por distância perimétrica circular $\min(|p - q|, N - |p - q|)$ e insira uma ponte contínua.
3. **Sub-camadas de Pintor (_Painter's Algorithm_)**:
   - Em tecelagens multicor, divida a sequência de cada carretel em $L$ fatias iguais (`painter_layers_per_color`, ex: 3) e intercale-as sequencialmente (Camada 1: C $\to$ M $\to$ Y $\to$ K; Camada 2: C $\to$ M $\to$ Y $\to$ K; Camada 3: C $\to$ M $\to$ Y $\to$ K). Isso preserva a profundidade cromática e impede que a cor final cubra integralmente as cores anteriores.

### 23. Regras de Testes de Integração Inter-Crates e Dependências Cargo

1. **Isolamento da Camada 2**:
   - Crates de motor (`weaver-solvers`, `weaver-dsp`, `weaver-cam`) dependem estritamente de `weaver-domain`.
   - Nunca adicione `weaver-dsp` como dependência (inclusive sob `[dev-dependencies]`) em `weaver-solvers/Cargo.toml`, pois o teste `apps/web/test/workspace-structure.test.ts` falhará na análise estática de dependências Clean Architecture.
2. **Localização Canônica de Testes de Integração Cruzada**:
   - Testes que combinam múltiplos motores da Camada 2 devem ser implementados na Camada 3 (`crates/weaver-wasm-adapter/tests/`) ou Camada 4 (`crates/weaver-cli/tests/`), onde todas as dependências internas são formalmente permitidas.

### 24. Logística de Fio, Exportadores da Obra e Retomada (`weaver-cam` / Task 3.2)

Ao gerar entregáveis, relatórios de custo e instruções passo a passo da obra de arte:

1. **Cálculo de BOM e Tempo Manual (`bom_calculator.rs`)**:
   - Utilize `calculate_bom(&loom, &steps, &config, &spools)` para obter `BomEstimate`.
   - O cálculo soma as tangentes analíticas exatas entre os pinos com o arco de contorno de acomodação ($\Delta L \approx \pi \cdot r_p$), aplicando margem de segurança de $+10\%$ e folga de amarração de $300\text{ mm}$ por carretel.
   - Fornece detalhamento bifásico: `weaving_time_seconds` ($4.5\text{ s}$ por passo) e `knot_and_switch_time_seconds` ($90\text{ s}$ por nó/troca), além da formatação amigável `format_duration` (ex: `"4 h 32 min"`).

2. **Geração de SVG da Obra, TXT de Instruções e JSON do Projeto (`artwork_exporter.rs`)**:
   - **SVG da Obra**: `export_artwork_svg(&loom, &steps, &spools, &opts)` gera vetor em escala 1:1 (`mm`) agrupado por `<g id="spool-k-epoch-m">` na ordem exata de empilhamento físico.
   - **Instruções TXT**: `export_instructions_txt(&loom, &steps, &spools, &config, &opts)` gera guia estruturado em blocos de cor com numeração física (1-indexed por padrão), no formato `Passo # | Pino Origem -> Pino Destino (Sentido Horário/Anti-Horário)`.
   - **JSON do Projeto**: `export_project_json(&loom, &steps, &spools, &config, title)` serializa o projeto completo de forma determinística pura (bit a bit) contendo diagnóstico mecânico, BOM e passos.

3. **Retomada de Sessão e Compartilhamento Serverless (`resume_codec.rs`)**:
   - **URL Hash (#progress=...)**: `ProgressToken::new(hash, spool_idx, step_idx).encode()` produz `WA1-<hash>-<spool>-<step>` para sincronização leve entre dispositivos.
   - **QR Code / Link P2P**: `compress_steps(&steps, peg_count)` comprime milhares de passos em uma string curta Base64URL via Delta Encoding perimétrico modular e RLE de cores, com decodificação exata via `decompress_steps(&encoded)`.

### 25. Ponte WebAssembly, Web Worker e Orquestração (`weaver-wasm-adapter` / Task 3.3)

Ao conectar o motor Rust compilado ao frontend TypeScript:

1. **Compilação do Módulo Wasm**:

   ```bash
   npm run build:wasm
   ```

   Gera os artefatos em `src/core-bridge/pkg/` (`weaver_wasm_adapter.d.ts`, `weaver_wasm_adapter.js`, `weaver_wasm_adapter_bg.wasm`).

2. **Inicialização do `WasmWeavingEngine`**:

   ```typescript
   import initWasm, { WasmWeavingEngine } from './pkg/weaver_wasm_adapter.js';
   await initWasm();
   const engine = new WasmWeavingEngine(sharedMemory.buffer);
   ```

3. **Loop Não-Bloqueante em Lotes no Web Worker**:
   - No `solver.worker.ts`, execute o laço de tecelagem fatiado em lotes (ex: 50 passos):
     ```typescript
     while (status === SolverStatusFlag.RUNNING) {
       const hasMore = engine.step_solver_batch(50);
       if (!hasMore) break;
       // Ceder a thread para processar mensagens de controle (PAUSE, ABORT, APPLY_BRUSH)
       await new Promise((resolve) => setTimeout(resolve, 0));
     }
     ```
   - O yielding via `setTimeout(..., 0)` garante que comandos de interrupção e atualizações dinâmicas de máscara facial sejam recebidos sem travamento do worker.

4. **Consumo de Telemetria Zero-Copy pela Main Thread**:
   - A Main Thread nunca solicita telemetria via IPC/postMessage. Em vez disso, lê periodicamente os slots de memória em `requestAnimationFrame`:
     ```typescript
     const rmse = memory.currentRMSE;
     const deltaE = memory.currentDeltaE;
     const ssim = memory.currentSSIM;
     const totalMeters = memory.totalThreadMeters;
     ```

5. **Exportações CAM On-Demand**:
   - As funções CAM são invocáveis diretamente no cliente através de métodos assíncronos que delegam ao worker:
     - `engineClient.generateBlueprintSvg()` / `generateBlueprintPdf()`
     - `engineClient.generateDrillingCsv()` / `generateCncGcode()`
     - `engineClient.generateArtworkSvg()` / `getBomSummary()`

### 26. Validação Nativa de Desempenho com `weaver-cli`

Para testar o pipeline completo fora do navegador com máximo desempenho e diagnóstico detalhado:

1. **Executar Benchmark Ponta-a-Ponta**:
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo run --release -p weaver-cli
   ```
2. **Critérios de Aceite**:
   - 4.000 cordas resolvidas em $< 2.0\text{ s}$ (esperado: $\sim 0.9\text{ s}$ a $1.2\text{ s}$).
   - Telemetria final esperada: $SSIM > 0.70$, $\Delta E < 3.5$, zero alocações por passo.
   - Geração e exportação instantânea de arquivos CAM de validação (`test_drilling.svg`, `test_drilling.pdf`, `test_drilling.csv`, `test_drilling.nc`, `test_artwork.svg`, `test_bom.json`).

### 27. Renderizador Físico WebGL2 e Shaders de Simulação (`WebGLLoomRenderer`)

Ao implementar ou ajustar a renderização física por GPU em `src/renderer-webgl/`:

1. **Ciclo de Vida do Renderizador**:

   ```typescript
   import { WebGLLoomRenderer, detectRendererCapabilities } from './renderer-webgl/index.js';

   const caps = detectRendererCapabilities();
   const renderer = new WebGLLoomRenderer(canvas, {
     useFloatTextures: caps.hasFloatColorBuffer,
     powerPreference: 'high-performance',
     pixelRatio: window.devicePixelRatio || 1,
   });
   renderer.initialize(loomPhysicalSpec);
   ```

2. **Loop de Renderização Incremental a 60 FPS com `SharedArrayBuffer`**:
   - Vincule o buffer de tecelagem e inicie o loop de animação:

   ```typescript
   renderer.attachSharedMemory(sharedMemory);
   renderer.startAnimationLoop(); // Dispara requestAnimationFrame contínuo lendo CurrentStepIndex
   ```
   - O método `renderNewSteps(currentStepIndex)` lê diretamente do `WeavingPathBuffer` através de ponteiros indexados, empacota as instâncias em um buffer prealocado e despacha para a GPU via `gl.bufferSubData`.

3. **Arquitetura de Shaders GLSL 300 es (`webgl-shaders.ts`)**:
   - **`ACCUMULATION_VS`**: Recebe os atributos por instância de cada corda (`a_pinA`, `a_pinB`, `a_color`, `a_thicknessMm`) e projeta o quad ao longo da direção ortogonal unitária.
   - **`ACCUMULATION_FS`**: Modela a transmitância linear e atenuação de espessura cilíndrica:
     ```glsl
     float d = v_normalDist; // [-1.0, 1.0]
     float alpha = smoothstep(1.0, 0.7, abs(d)) * sqrt(max(0.0, 1.0 - d * d));
     fragColor = vec4(v_color.rgb, v_color.a * alpha);
     ```
   - **`SCREEN_FS`**: Converte de Linear RGB para sRGB, aplica oclusão ambiente do aro e ilumina os pinos perimétricos:
     ```glsl
     // Linear to sRGB IEC 61966-2-1
     vec3 srgb = mix(
       linearColor * 12.92,
       1.055 * pow(linearColor, vec3(1.0 / 2.4)) - 0.055,
       step(vec3(0.0031308), linearColor)
     );
     ```

4. **Controles de Câmera (Zoom e Pan)**:
   - Suporta zoom centrado no ponteiro do mouse (`wheel`) e translação com botão esquerdo ou do meio (`drag`).
   - Mantenha `setZoom(zoom)` e `setPan(x, y)` sincronizados com os seletores de UI.

### 28. Diagnóstico Multi-Estágio DSP e Pincel de Saliência Facial (`StudioViewManager`)

Para conectar e manipular as etapas de visão computacional na vista Estúdio:

1. **Atualização de Buffers de Diagnóstico**:

   ```typescript
   studioManager.setDiagnosticBuffers({
     prepared: preparedTargetRgba8,
     importance: importanceMapRgba8,
     edges: edgesRgba8,
     radon: radonSinogramRgba8,
     residual: residualErrorRgba8,
   });
   ```

2. **Ativação e Alternância das Abas**:
   - Utilize `studioManager.setDiagnosticTab(tabId)`.
   - O canvas do pincel interativo deve ser ativado exclusivamente quando `activeTab === 'importance'`.

3. **Configuração do Pincel Interativo**:

   ```typescript
   studioManager.setBrushRadiusMm(15.0);
   studioManager.setBrushInteractionMode('boost'); // '+ Reforçar Nitidez' (peso 1.5) ou 'diminish' ('- Reduzir Peso', peso 0.5)
   studioManager.setBrushApplyHandler((centerXNorm, centerYNorm, radiusNorm, weightDelta) => {
     engineClient.applyUserImportanceBrush(centerXNorm, centerYNorm, radiusNorm, weightDelta);
   });
   ```

4. **Padrão de Mocks em Testes Vitest (DOM / Eventos)**:
   - Para evitar rejeições de tipagem estrita TS2739 ao mockar `getBoundingClientRect()`:
   ```typescript
   canvas.getBoundingClientRect = () =>
     ({
       width: 400,
       height: 400,
       top: 0,
       left: 0,
       right: 400,
       bottom: 400,
       x: 0,
       y: 0,
       toJSON: () => {},
     }) as DOMRect;
   ```
   - Ao disparar eventos sintéticos no Node/jsdom:
   ```typescript
   canvas.dispatchEvent({
     type: 'pointerdown',
     clientX: 200,
     clientY: 200,
     buttons: 1,
   } as unknown as Event);
   ```

### 29. Modo Tecelagem Físico, Tangência Dupla, Hands-Free Voice TTS e Sincronização Mobile (`PlayerView`)

Ao desenvolver, estender ou debugar o assistente de tecelagem passo a passo (`src/views/player-view/`):

1. **Tangência Física Dupla nos Pinos (`PlayerCanvas`)**:
   - O traçado da corda ativa deve exibir indicadores de arco e setas em **ambos os pinos**: no pino de saída (`fromPeg`, `s.fromSide`) e no pino de chegada (`toPeg`, `s.toSide`).
   - Respeite rigorosamente a convenção do Rust `WindingDirection` / `PegSide`:
     - `-1` (`right`) = **Sentido Horário (CW)**;
     - `+1` (`left`) = **Sentido Anti-Horário (CCW)**.
   - As cordas anteriores do padrão devem ser desenhadas com baixa opacidade (`globalAlpha ≈ 0.45 ~ 0.55`) para garantir contraste e foco imediato sobre o próximo pino.

2. **Coordenação Hands-Free de Voz TTS (`PlayerAudio`)**:
   - A síntese de voz em `pt-BR` deve pronunciar de forma concisa: `"[Pino Destino], [sentido horário / anti-horário]"` e instruir trocas de carretel.
   - No modo automático (`"Avançar sozinho a cada X s"`), o temporizador regressivo para o próximo passo **só deve ser disparado após a conclusão da fala** (`utterance.onend`), evitando atropelar a voz.
   - Sempre implemente um temporizador watchdog de segurança (ex: `Math.max(2500, text.length * 140) ms`) para destravar o fluxo caso o navegador silencie ou pause a Web Speech API em segundo plano.

3. **Interrupção Obrigatória e Alerta de Troca de Carretel**:
   - Sempre que `step[t].thread !== step[t-1].thread` (ou transição de camada):
     - Pause o temporizador automático (`stopTimer()`, `el.auto.checked = false`);
     - Reproduza o chime harmônico de camada (`playChime('layer')`);
     - Exiba card de destaque com instrução clara:  
       _"Troca de Carretel: Amarre e finalize o fio [Cor Anterior] no pino [X] e inicie o carretel [Nova Cor]"_.

4. **Cadência Humana Adaptativa**:
   - Calcule a média móvel dos intervalos reais dos passos recentes do artesão (últimos 3 a 8 passos válidos entre 0.5 s e 90 s).
   - Estime o tempo restante por: `passosRestantes * cadenciaMediaSegundos`, com fallback gracioso para o modelo analítico `estimateWeave()` quando não houver histórico suficiente.

5. **Persistência Híbrida e QR Code Vetorial Puro (`QRCodeGenerator`)**:
   - Persista o projeto completo `WeaveResult` e o índice atual no `IndexedDB` (`weaver-art-db`), contornando o limite de 5 MB do `localStorage`.
   - Mantenha sincronização síncrona leve no `localStorage` e hash da URL (`#progress=WA1-...`).
   - Para transferir o trabalho para celular/tablet, gere um **QR Code SVG vetorial puro** (ISO/IEC 18004) sem bibliotecas externas pesadas, permitindo leitura direta da URL de retomada pela câmera do dispositivo móvel.

### 6. Integração de Telemetria a 60 Hz e BOM via Wasm CAM (Task 4.4)

Ao estender os cards de telemetria ou telas de relatório de materiais:

1. **Leitura Atômica do ControlBlock a 60 Hz**:
   - Utilize um loop contínuo sincronizado via `requestAnimationFrame`:
     ```typescript
     function start60HzTelemetryLoop() {
       const update = () => {
         if (!isWasmRunning) return;
         const metrics = engineClient.readMetrics();
         // Atualiza cards de linhas, fio, switches, RMSE, deltaE, SSIM e tempo
         animFrameId = requestAnimationFrame(update);
       };
       animFrameId = requestAnimationFrame(update);
     }
     ```
   - Evite mensagens IPC via `postMessage` para telemetria de alta frequência; utilize exclusivamente leituras no `ControlBlock` compartilhado (`SharedArrayBuffer`).

2. **Consumo de BOM JSON do `weaver-cam`**:
   - Para obter a lista de carretéis e a estimativa de tempo manual em segundos:
     ```typescript
     const bomStr = await engineClient.exportCam('bom_json');
     const bom = JSON.parse(bomStr);
     // bom.spools: [{ name, color, meters, spools_needed, cost }]
     // bom.time_estimate: { total_seconds, formatted }
     ```
   - Preencha a tabela de carretéis aplicando as amostras visuais de cor e o tempo estimado de execução física.
