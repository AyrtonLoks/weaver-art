# Diretrizes para Agentes de IA — Weaver Art

Este arquivo estabelece os princípios fundamentais, regras físicas, matemáticas e arquiteturais que qualquer modelo de IA deve respeitar ao trabalhar ou estender o código deste projeto.

## 1. Filosofia e Contexto do Projeto

Weaver Art reproduz computacionalmente as obras de arte de fios (_string art_ ou _algorithmic knitting_) de Petros Vrellis. Diferente de geradores simplistas que apenas traçam linhas em pixels, o Weaver Art modela o **objeto físico real**:

- Dimensões reais em milímetros (`mm`), diâmetro dos pinos com tangentes e arcos, espessura e opacidade do fio.
- Modelo físico de transmitância em luz linear: $T = \prod (1 - \alpha c_i)$, onde o tom escurece com densidade E interseções.

## 2. Invariantes Matemáticas e de Cor

- **Competição Cromática e Ordem de Camadas**:
  - O fio preto ($K=[0,0,0]$) tem ganho matemático MSE 3× maior sobre fundo branco que fios coloridos. **Nunca deixe fios coloridos competirem livremente contra o preto sem cotas ou camadas**, caso contrário ocorrerá exclusão total de cores (fome de azul/verde).
  - A única estratégia multicor permitida é **Camadas Sequenciais (`layered`)**. Estratégias intercaladas (`interleaved-balanced`, `free`) são proibidas por gerarem milhares de trocas de carretel. A ordem física obrigatória é: cores luminosas primeiro (Amarelo $\rightarrow$ Magenta/Ciano $\rightarrow$ Azul/Verde) e **Preto por último** (para definir sombras e contornos sem apagar as cores de baixo).
  - Sempre forneça cotas ponderadas com maior peso no preto final (ex: 40% preto no CMYK, 30% no Vrellis 5 cores) e **rollover dinâmico** de saldo para o preto caso cores anteriores atinjam limite de ganho.
- **Atingimento de Metas de Linhas e Repetições**:
  - Um tear circular com 200 pinos possui apenas ~16.500 pares de pinos possíveis, dos quais apenas ~7.500 cruzam a figura.
  - Para metas altas ($\ge 5.000$ cordas, ex: 10.000 cordas), configure `maxChordRepeats >= 2` ou `3`. Se `maxChordRepeats = 1`, o motor ficará sem cordas úteis com ganho positivo e parará prematuramente.
- **Fidelidade de Retratos (regras medidas no benchmark com foto real — `weaver-cli bench`)**:
  - **Benchmark obrigatório antes de qualquer ajuste de qualidade**: toda mudança no solver, no DSP ou nos presets deve ser medida com `weaver-cli bench` sobre **fotos reais** (no mínimo o retrato do usuário e `bench/fixtures/venus_botticelli_face.png`), comparando SSIM e correlação "à distância" contra a foto enquadrada. Benchmarks com imagens sintéticas (ovais desenhados) **não** servem para julgar qualidade.
  - **Enquadramento e Escala Facial (rodada "reconhecimento facial")**: o padrão é enquadrar pelo **rosto detectado** (Viola-Jones, `FramingTarget::Face`): a caixa do rosto ocupa **~95% do diâmetro** do aro (`DEFAULT_FACE_FILL = 0.95`), cortando o topo do cabelo e as orelhas — foi o nível em que o usuário se reconheceu. 105% corta o queixo; 80% (cabeça inteira) deixa o rosto pequeno demais para 200 pinos. "Cabeça e ombros" (`FramingTarget::HeadAndShoulders`, fill 0,8) fica como opção e é o fallback quando nenhum rosto é detectado. O enquadramento é aplicado automaticamente ao carregar a foto.
  - **Tear padrão = aro de bicicleta 28" (ISO 622 / 700C)**: diâmetro **622 mm**, **200 pinos**, fio **0,18 mm** (0,15 mm foi pior em todas as fotos; 288 pinos deram só +0,015 de SSIM). Monocromático com **6000 linhas** (fotos escuras: SSIM 0,66→0,74 na noite, 0,71→0,79 na igreja, Vênus 0,80→0,85; em fotos claras o guloso para sozinho antes, ~4100).
  - **Resolução de Simulação**: use grade $\ge 500$ px para retratos (resoluções 300–600 px deram a mesma correlação estrutural; 500 px equilibra fidelidade e tempo).
  - **Física do fio**: fios reais são praticamente opacos (`alpha_material ≈ 1.0`); o escurecimento por pixel vem da cobertura física $t_f \cdot R_{px} / D_{mm}$. Opacidades artificiais (ex.: 0.35) deixam a obra lavada/cinza e foram removidas. Solver (`build_spools`) e renderer (`DEFAULT_PALETTES`) devem usar as mesmas opacidades.
  - **Função objetivo limpa**: o ganho de uma corda é a variação **exata** do erro quadrático ponderado em espaço perceptual (curva sRGB). Não acrescente constantes empíricas por região (amortecimentos de pele, fundo de estúdio, reservas de K etc.) — a pilha dessas heurísticas foi a principal causa dos resultados irreconhecíveis.
  - **Proteção de realces (`highlightProtection`)**: padrão **0 (desligada)**. Valores 1–3 pioraram as duas imagens de referência (SSIM e correlação menores, imagem mais clara que a foto).
  - **Realces do alvo**: CLAHE, unsharp e fusão de bordas ficam **desligados por padrão** (CLAHE 2.0 reduziu a correlação de 0,935 para 0,912 na Vênus). `shadowLift`/`torsoFeathering`/modelagem tonal de retrato e faixas anatômicas fixas no mapa de importância foram removidos.
  - **Mapa de importância**: suave e limitado, $W = 1 + \beta_f M_{\text{face}} + \beta_e E \ge 1$ (sem regiões abaixo de 1, exceto pelo pincel do usuário). Padrão $\beta_f = 2.0$, $\beta_e = 0$.
  - **Passe de refinamento (`refine_passes`)**: implementado com movimentos que preservam o fio contínuo (realocação/remoção de nós). Nas imagens de referência não trouxe ganho mensurável e custa 2–4× o tempo, por isso o padrão é **0**; mantenha-o disponível e reavalie com o benchmark.
  - **Realce de feições (`featureEmphasisWeight` → `beta_feature`) e "pele mais limpa" (`skinLift`)**: opcionais, **padrão 0**. O mapa de feições (`compute_dark_feature_map`: black top-hat × pele) soma ao mapa de importância; `skin_lift` clareia sombras suaves da pele no espaço perceptual. Valores 2/4 e 0,4 deram diferença visual mínima e correlação global levemente pior — ficam nos sliders para o usuário escolher visualmente.
  - **Avaliação por reconhecimento**: julgue retratos pela **vista à distância** (UI: "Vista à distância", σ = 0,6 mm por metro ≈ 2′ de arco, lado a lado com a foto enquadrada) e pelas métricas "ROSTO SSIM/RMSE" do `weaver-cli bench` (elipse sobre o rosto detectado). Compare variantes com folhas de contato (`weaver-cli contact`). Fotos pessoais de teste ficam em `samples/private/` (gitignored — **nunca** commitar).
- **Parâmetros e Heurísticas Legadas Expurgadas (NUNCA Reintroduzir)**:
  - Os seguintes parâmetros e controles distorciam a função objetivo e foram permanentemente banidos do estado, tipos e UI: `centerDampRadiusMm` (Damping central), `angularDiversity` (Dispersão angular), `lengthPenalty` (Penalidade comp. fio), `stopWhenNoImprovement`, `halftoneMixing` / `halftoneRadiusMm`, `candidatePruning` (`lazy`), `rasterCacheMb` e os seletores legados de aceleração JS / Workers JS.
- **Espaços de Cor e Separação de Domínios**:
  - **Mistura Óptica e Física de Transmitância**: Opera exclusivamente no espaço **Linear RGB** com ponto branco D65 ($T = \prod (1 - \alpha c_i)$). Jamais calcule absorção ou cobertura de fios no espaço sRGB gama-codificado, pois distorce tons médios e causa escurecimento prematuro.
  - **Decisão de Erro e Função Perceptual**: Opera no espaço **CIELAB** ($\Delta E^*_{76}$ ou $\Delta E_{00}$ CIEDE2000 canônico) ou aproximações rápidas ponderadas (**Redmean** / luminância Rec. 709).
  - **Conversão de Entrada/Saída**: sRGB com curva padrão piecewise (IEC 61966-2-1), tolerando gamma simplificado $\gamma = 2.2$ apenas em interfaces externas legadas.
- **Gamut Mapping por Projeção Convexa (Prevenção de Cores Inatingíveis)**:
  - O conjunto de cores atingíveis sobre o tear é o fecho convexo dos carretéis e do fundo: $\mathcal{G} = \text{Conv}(\{\mathbf{s}_0, \mathbf{s}_1, \dots, \mathbf{s}_M\})$ no espaço CIELAB.
  - Imagens com cores fora do gamut devem ser pré-mapeadas antes da otimização para evitar corrida infinita do solver e sobre-escurecimento ("buraco negro").
  - **Preservação Prioritária de Luminância ($L^\*$)**: O mapeamento deve preservar prioritariamente $L^_$, restringindo a luminância a $[\min_i L_i, \max_i L_i]$ da paleta e minimizando o erro de croma $(\Delta a^_)^2 + (\Delta b^*)^2$.
  - **Algoritmo de Projeção Convexa GJK em $\mathbb{R}^3$ Ponderado**:
    - O fecho convexo em CIELAB com peso de luminância $w_L \gg 1$ é altamente mal condicionado para algoritmos de gradiente projetado (PGD) de passo fixo.
    - A projeção deve utilizar o algoritmo **GJK (Gilbert-Johnson-Keerthi)** transformado para coordenadas isométricas $\mathbb{R}^3$ ($[s \cdot L^_, a^_, b^*]$, com $s = \sqrt{w_L}$) e sub-simplex exato (Voronoi de triângulos de Ericson), convergindo deterministicamente em $\le 6$ passos com zero hiperparâmetros de passo.

## 3. Invariantes de Código e Arquitetura

- **`@weaver-art/core` deve permanecer puro**: Zero dependências de runtime, sem DOM, sem `fs`, sem `Buffer`. Deve rodar perfeitamente em Node, Web Workers e testes.
- **Convenção de Unidades**:
  - Grandeza física $\rightarrow$ `mm` (ex: `diameterMm`, `pegRadiusMm`, `widthMm`, `totalLengthMm`).
  - Grandeza discreta de simulação $\rightarrow$ sufixo `Px` (ex: `resolutionPx`, `widthPx`).
- **Invariantes de Desempenho e Aceleração**:
  - **Proibição de Cálculo Pesado de String Art em JS**: A UI (Main Thread) e Workers JS jamais devem executar loops gulosos de String Art, rasterização de linhas ou extração de paletas K-Means em JavaScript. O motor algorítmico e a renderização pertencem exclusivamente à arquitetura **Rust/Wasm + TypeScript/WebGL2**.
  - **Isolamento de Threads e Plataforma**: `@weaver-art/core` nunca instancia diretamente `Worker` (DOM) ou `worker_threads` (Node). A orquestração e instanciação de workers pertencem estritamente às camadas de aplicação (`apps/web` e `@weaver-art/cli`).
- **Preservação de Ativos Visuais e Estruturais**:
  - Mantenha intactos: tema escuro (`apps/web/src/style.css`), Header (`Weaver Art`), cards de telemetria (`LINHAS`, `FIO`, `RMSE`, `ΔE (CIELAB)`, `SSIM`, `TEMPO`, `TEMPO MANUAL EST.`), tabela de `ESTIMATIVA DE CARRETÉIS`, card de `ENQUADRAMENTO & GUIA FACIAL` (Zoom, Pan X, Pan Y), geração de gabaritos (SVG/PDF/CSV/G-code) e o `Modo tecelagem` (`apps/web/src/player.ts`, pino gigante, direção CW/CCW, voz TTS, timer automático e retomada via `#progress=...`).
- **Arquitetura do Cargo Workspace Rust (`crates/`) e Regra de Dependência**:
  - O workspace Rust (`Cargo.toml` raiz) utiliza `resolver = "2"` e perfil release com `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`.
  - A Clean Architecture impõe direção estrita de dependências:
    - **Camada 1 (Domain)**: `crates/weaver-domain` (zero dependências internas; tipos físicos `mm`, pixels `Px`, lados de tangência, cores lineares, matriz CSR).
    - **Camada 2 (Use Cases / Engines)**: `crates/weaver-dsp`, `crates/weaver-solvers`, `crates/weaver-cam` (dependem exclusivamente de `weaver-domain`).
    - **Camada 3 (Adapters)**: `crates/weaver-wasm-adapter` (depende das Camadas 1 e 2; expõe ponte `wasm-bindgen` e layout de `SharedArrayBuffer`).
    - **Camada 4 (Infrastructure / Apps)**: `crates/weaver-cli` (binário nativo; depende das Camadas 1 e 2).
- **Isolamento Cross-Origin e SharedArrayBuffer no Frontend**:
  - Tanto `server.headers` quanto `preview.headers` em `vite.config.ts` devem conter:
    - `'Cross-Origin-Opener-Policy': 'same-origin'`
    - `'Cross-Origin-Embedder-Policy': 'require-corp'`
  - Ativos `.wasm` e `worker: { format: 'es' }` são obrigatórios para suporte a módulos Web Worker com Wasm.
- **Modularização de `apps/web/src/` e Arquitetura Desacoplada em 3 Vistas**:
  - A aplicação deve respeitar os domínios: `domain-contracts/`, `core-bridge/`, `preset-engine/`, `renderer-webgl/` e as 3 vistas principais:
    - **`views/studio-view/`**: Responsável pelo enquadramento híbrido (arraste Pan X/Y com mouse drag e Zoom 0,5–6× com mouse wheel sincronizados com sliders; enquadramento automático pelo rosto ao carregar a foto, seletor "Rosto | Cabeça e ombros" e `runSmartFrame()`), inspeção multi-estágio do alvo (`prepared`, `importance`, `edges`, `radon`, `residual`), pincel interativo de foco facial e a **vista à distância** (`distance-view.ts`: modos "Fios (tamanho real)" | "Vista à distância" com desfoque `blur(σ)` por acuidade visual, slider 1–6 m e comparação lado a lado com o alvo preparado; liga automaticamente ao terminar a geração).
    - **`views/blueprint-view/` (Task 4.2)**: Viewport CAD técnico de engenharia para furação do aro, cotas em mm, diâmetro primitivo, marcação centesimal de broca $\varnothing\text{ mm}$, inspeção visual ampliada de parede livre entre pinos, grade de páginas 1:1 sobreposta com cruzetas de registro e códigos de folhas (`A1`, `A2`...), card de diagnóstico mecânico e exportações (`PDF 1:1`, `SVG 1:1`, `CSV de pinos`, `G-Code G81/G83`).
      - **Separação Estrita de Responsabilidades**:
        - `BlueprintCanvas` (`blueprint-canvas.ts`): Componente puro de desenho CAD vetorial em Canvas 2D. Responsável pelo cálculo matricial de viewport (Pan/Zoom até décimos de milímetro), detecção de _hover_ e clique em furos por distância euclidiana radial, renderização das cruzetas de punção em escala exata de broca $\varnothing\text{ mm}$, numeração orientada por normais externas unitárias $(\hat{n}_x, \hat{n}_y)$, cota flutuante de parede livre e projeção da grade de paginação 1:1.
        - `BlueprintView` (`blueprint-view.ts`): Controlador que orquestra a sincronização de controles DOM, tabela interativa de coordenadas, card de diagnóstico mecânico e acionamento dos exportadores CAM com fallback resiliente.
      - **Inspeção de Parede Livre e Códigos de Segurança**:
        - Ao passar o mouse sobre qualquer furo ou selecionar um pino na tabela, a folga é avaliada por $w_{\text{livre}} = d_{\text{adj}} - \varnothing_{\text{broca}}$.
        - Classificação canônica obrigatória com código de cores:
          - `Seguro` ($w_{\text{livre}} \ge 1.5\text{ mm}$): `#22c55e` (Verde).
          - `Alerta Parede Fina` ($0 < w_{\text{livre}} < 1.5\text{ mm}$): `#eab308` (Amarelo).
          - `Erro Colisão de Broca` ($w_{\text{livre}} \le 0\text{ mm}$): `#ef4444` (Vermelho).
      - **Overlay de Impressão Paginada 1:1 com Culling de Vão Central**:
        - Suporte a `A4` ($210 \times 297\text{ mm}$), `A3` ($297 \times 420\text{ mm}$) e `Carta/Letter` ($215.9 \times 279.4\text{ mm}$) com margens de sobreposição de `15.0 mm` e impressora de `10.0 mm`.
        - Diferenciação visual estrita: **Folhas Ativas** (com furos e cruzetas de registro `+` nos cantos) vs. **Folhas Centrais Descartadas** (vão central vazio omitido da impressão para economia de papel/tinta).
      - **Dual-Path nos Exportadores CAM (Wasm Worker com Fallback TypeScript)**:
        - O disparo de download deve tentar prioritariamente o Web Worker Wasm (`engineClient.exportCam`), passando a configuração atual do tear para inicialização _on-demand_.
        - Caso o Wasm esteja indisponível ou ocorra falha, o sistema deve acionar automaticamente os geradores em TypeScript de `@weaver-art/core` (`toTemplatePDF`, `toTemplateSVG`, CSV mecânico padronizado e gerador G-code interno), garantindo execução sem falhas.
    - **`views/player-view/`**: Assistente de tecelagem passo a passo com ditado TTS, timer, rotação horária/anti-horária e sincronização de retomada via código e URL hash.
- **Invariante de Testabilidade e Compatibilidade DOM/Node em Controladores**:
  - Controladores e classes nas vistas (`BlueprintView`, `StudioViewManager`, etc.) devem ser executáveis e testáveis na suíte Vitest em ambiente Node sem quebrar por ausência de variáveis globais do navegador:
    - Proteger acessos a `window`, `document` e `alert` via `typeof window !== 'undefined'`, `typeof document !== 'undefined'` ou wrappers seguros.
    - Em rotinas de Canvas 2D, métodos que podem não estar implementados em mocks simples (ex: `ctx.measureText`) devem ser chamados com salvaguarda: `typeof ctx.measureText === 'function' ? ctx.measureText(text).width : fallback`.
    - Em rotinas de download (`downloadBlob`), o `Blob` e a chamada `URL.createObjectURL(blob)` devem ser executados mesmo em ambiente Node (quando mockados pela suíte de testes), guardando apenas a manipulação do DOM (`document.createElement('a')`) com `typeof document !== 'undefined'`.
    - Utilizar `ctx.createImageData(w, h)` combinado com `idata.data.set(buffer)` para carregar pixels nos canvases, evitando incompatibilidades de tipo entre `new ImageData(...)` e `SharedArrayBuffer` / `ArrayBufferLike`.
    - Ao instanciar `Blob([data])` a partir de `Uint8Array`, garantir que a memória seja um `ArrayBuffer` convencional (efetuando cópia/slice quando necessário) para prevenir rejeições de tipagem estrita TS2322.
- **Multiformato Geométrico do Tear**:
  - Suporte formal aos 4 formatos fundamentais: `CIRCULAR`, `ELLIPTICAL`, `RECTANGULAR`, `REGULAR_POLYGON` (além de `custom` CSV). Formatos curvos não circulares ou poligonais devem mapear para listas ordenadas de pinos perimétricos compatíveis com `CustomLoomConfig`.
- **Geometria de Precisão, Furação Mecânica e Tangentes Reais (Camada 1 - `weaver-domain`)**:
  - Toda representação de tear no ecossistema Rust deve derivar de `LoomPhysicalSpec` e implementar parametrização estrita por comprimento de arco $s \in [0, P)$ em `LoomContour` (`CircularContour`, `EllipticalContour` com quadratura Simpson e refinamento Newton-Raphson, `PolygonContour` com interpolação CCW e normais bissetrizes).
  - Pinos perimétricos devem disponibilizar acesso $O(1)$ indexado para posições `(x, y)` e vetores normais unitários externos `(nx, ny)`.
  - Validação de integridade de furação mecânica deve computar a parede livre $w_{\text{livre}} = d_{\text{adj}} - d_{\text{broca}}$ e classificar em `Safe` ($w \ge 1.5\text{ mm}$), `WarningThinWall` ($0 < w < 1.5\text{ mm}$) ou `ErrorCollision` ($w \le 0$).
  - O cálculo de segmentos de corda deve considerar o raio do pino $r_p = d_p / 2 > 0$ e sentidos `WindingDirection` (`Clockwise` $-1$, `CounterClockwise` $+1$):
    - Tangentes externas paralelas ($s_A == s_B$): deslocamento ortogonal por $\pm r_p \hat{n}$ com comprimento $L = D_{ij}$.
    - Tangentes internas cruzadas ($s_A \ne s_B$): rotação pelo ângulo de desvio $\Delta \phi = \arcsin(2r_p / D_{ij})$ com comprimento $L = \sqrt{D_{ij}^2 - 4r_p^2}$.
    - Invariante de reciprocidade: inverter o sentido do percurso ($B \to A$) deve inverter ambos os sentidos de enrolamento e traçar o idêntico segmento físico.
- **Layout Binário SharedArrayBuffer (ADR-003)**:
  - O buffer compartilhado é estritamente particionado em:
    - **ControlBlock (primeiros 128 bytes)**: 32 bytes de controle atômico `Int32Array` (`StatusFlag` [IDLE=0, RUNNING=1, PAUSED=2, DONE=3, ABORT=4], `CurrentStepIndex`, `ActiveSpoolIndex`, `TotalSpoolSwitches`) e 96 bytes de métricas `Float32Array` (offset 32 bytes: `CurrentRMSE`, `CurrentDeltaE`, `CurrentSSIM`, `TotalThreadMeters`, `ThreadMetersPerSpool[16]`).
    - **WeavingPathBuffer (byte 128 em diante, 8 bytes por passo)**: Cada passo codifica `fromPin: u16`, `toPin: u16`, `spoolId: u8`, `windings: u8` (bit 0 saída CW/CCW, bit 1 chegada CW/CCW), e `scoreNormalized: u16` em ponto fixo (`score * 65535`).
  - **Fallback Obrigatório**: Toda implementação em `core-bridge` deve prover fallback transparente para `ArrayBuffer` convencional quando `SharedArrayBuffer` não estiver disponível no ambiente, evitando lançar exceções com `Atomics`.
  - **Zero-Copy e Zero-Allocation**: Leituras na thread de UI e renderizadores devem priorizar getters indexados diretos e métodos com buffer mutável reutilizável (`readStep(i, out)`).
- **Zero-Allocation em Processamento de Cor por Pixel (Camada 1 - `weaver-domain`)**:
  - Funções de métrica (`delta_e_76`, `delta_e_2000`, `redmean_distance`) e projeção de gamut (`project_orthogonal`, `map_color`) na Camada 1 não devem alocar na heap. Buffers de simplex e vetores temporários utilizam arrays estáticos em pilha (`[f32; 4]` e `[Vec3; 4]`).
- **Matriz Esparsa CSR e Localidade L1/L2 de Cordas (Camada 1 - `weaver-domain` / ADR-001 e RNF-03)**:
  - Todas as cordas rasterizadas do tear devem residir em uma struct `SparseChordMatrixCSR` formada estritamente por 3 vetores planos contíguos: `chord_offsets: Vec<u32>`, `pixel_indices: Vec<u32>` e `pixel_weights: Vec<u8>`.
  - **Teto Estrito de Memória RNF-03**: Para tear circular $N = 250$ pinos e resolução $600 \times 600$ px com rasterização de Xiaolin Wu ($\approx 21{,}25$ milhões de entradas de pixel), o consumo de memória heap deve ser $\le 130\text{ MB}$ (medido em $\approx 101{,}44\text{ MB}$).
  - **Indexação Canônica Triangular $O(1)$**: O mapeamento entre qualquer par de pinos $(a, b)$ e a linha da matriz $k \in [0, \binom{N}{2})$ deve ser computado por aritmética fechada $k = a \cdot N - \frac{a(a+1)}{2} + (b - a - 1)$ para $a < b$, garantindo reciprocidade física estrita (`get_chord(a, b) == get_chord(b, a)`) com zero tabelas de dispersão ou alocações na heap. A reversão $k \to (a, b)$ deve utilizar fórmula quadrática direta.
  - **Supressão de Cordas Periféricas Curtas ($d\_{\min}$)**: Cordas com distância perimétrica circular $\min(|a - b|, N - |a - b|) < d_{\min}$ permanecem com tamanho 0 (`chord_offsets[k] == chord_offsets[k+1]`), consumindo zero entradas nos vetores de pixels e pesos.
  - **Zero-Copy e Zero-Allocation em Consultas**: Métodos de acesso do solver (`get_chord`, `chord_slice`) devem retornar fatias emprestadas `(&[u32], &[u8])` em $O(1)$ sem clonagem de dados.
  - **Motores de Rasterização**:
    - `BresenhamBinary`: Linha inteira clássica com peso binário pleno ($w = 255$).
    - `XiaolinWuAntialiased`: Amostragem perpendicular sub-pixel com conservação de energia e descarte estrito de pesos nulos ($w = 0$) para manter a esparsidade da matriz.
    - `LoomGridMapping`: Mapeamento centrado $((W-1)/2, (H-1)/2)$ com margem de 1 pixel contra clipping de antialiasing nas bordas da moldura.
- **Motor de Presets Reativos e Visibilidade Contextual (ADR-005)**:
  - Os 4 perfis fundamentais de preset (`VRELLIS_CLASSIC_MONO`, `PORTRAIT_HIGH_SHARPNESS_EPOCHS`, `CMYK_DYNAMIC_HYSTERESIS`, `GLOBAL_RADON_FISTA`) devem permanecer sincronizados entre os contratos formais (`preset-registry.ts`) e a interface.
  - O estado de modificação do usuário deve utilizar rastreamento genérico e estrito `isDirty` (`resetParam<K extends keyof WeaverConfig>`, `resetAllDirty`).
  - Controles e sliders na UI devem ser filtrados via predicados `isControlVisible(id, config)` e `getVisibleControls(config)` para ocultar opções irrelevantes ao modo cromático, forma do tear ou algoritmo solver ativo.
- **Pipeline de DSP e Pré-processamento de Imagem (Camada 2 - `weaver-dsp`)**:
  - **Zero Dependências Pesadas C/OpenCV**: `weaver-dsp` deve permanecer em Rust puro, dependendo exclusivamente de `weaver-domain`, garantindo compilação transparente para `wasm32-unknown-unknown`.
  - **Buffers Unificados**: Utilizar `ImageBuffer<T>`, `GrayImage` (luminância fotométrica em $[0.0, 1.0]$), `Rgba8Image` e mapeamento sem cópia para `LinearRgbColor` e `LabColor`.
  - **Enquadramento Afim 2D e Recorte Analítico**:
    - Suportar interpolação sub-pixel bilinear e bicúbica (Catmull-Rom spline, $a = -0.5$).
    - O recorte por máscara geométrica (`LoomMask`) deve avaliar analiticamente a inclusão de coordenadas contínuas em milímetros contra o contorno de `LoomGeometry` (`is_inside`), preenchendo áreas externas com cor de fundo neutra.
  - **Auto-Enquadramento Facial (`compute_auto_framing` + `face_framing.rs`)**:
    - **Modo Rosto (padrão na UI)**: detector **Viola-Jones** em Rust puro (`detect_faces`/`detect_face_region`) sobre imagem integral em tons de cinza, com a cascata `haarcascade_frontalface_default` do OpenCV convertida para tabelas estáticas em `haar_frontalface.rs` (gerado; licença Intel/BSD preservada nos comentários; não editar à mão). Agrupamento com `MIN_NEIGHBORS = 3`, supressão de caixas sobrepostas/aninhadas e prioridade ao maior rosto; `face_framing_from_region` converte a caixa em zoom/pan para o rosto ocupar `fill` do diâmetro. ~25–40 ms por foto.
    - Detecção por cor de pele foi **abandonada** como detector de rosto: falha com luz quente/noturna e fundos bege (caixas cobrindo a foto inteira).
    - **Modo Cabeça e ombros (fallback)**: fusão de Sobel, probabilidade de pele YCbCr e prior gaussiano central, com escala para 80% do diâmetro e olhos no terço superior.
    - Wasm: `compute_smart_framing_wasm(raw, w, h, target_ratio, mode, face_index)` devolve `zoom`, `panXPercent`, `panYPercent`, `mode`, `faceIndex`, `faceCount`; cliques repetidos em "Enquadrar rosto" alternam entre rostos.
  - **Ajuste Radiométrico e CLAHE**:
    - Contraste sigmoidal normalizado via logística contínua em torno do ponto de inflexão $m \in [0, 1]$, evitando clipping abrupto de realces e sombras.
    - CLAHE opera estritamente no canal de luminância ($L^_$ no CIELAB ou escala de cinza), preservando $a^_$ e $b^*$ rigorosamente invariantes (sem desvio tonal).
    - Interpolação bilinear contínua entre centros de tiles vizinhos para eliminar descontinuidades e artefatos de bloco nas fronteiras.
  - **Morfologia Matemática em Escala de Cinza**:
    - Elementos estruturantes configuráveis (`StructuringElement`: disco euclidiano, quadrado, cruz e linhas).
    - Operações fundamentais (`erode`, `dilate`) e derivadas (`opening`, `closing`, `morph_gradient`, `white_tophat`, `black_tophat`) devem preservar invariantes de idempotência e extensividade/anti-extensividade.
  - **Invariantes de Testes Flutuantes em DSP**:
    - Nunca comparar floats por igualdade estrita (`==`); utilizar sempre tolerâncias $\epsilon$ (`.abs() < 1e-5` / `1e-6`).
    - Testes de CLAHE devem verificar o aumento da entropia de Shannon e expansão da amplitude dinâmica/desvio padrão local sem presumir escala irrestrita para $[0, 1]$, já que o contraste é intencionalmente limitado por `clip_limit`.
  - **Detecção de Bordas (Sobel e Canny) e Supressão Não-Máxima (NMS)**:
    - O operador de Sobel deve calcular $G_x$ e $G_y$, magnitude euclidiana normalizada $\Vert\nabla I\Vert / 4.0 \in [0.0, 1.0]$ e ângulo $\theta = \text{atan2}(G_y, G_x)$.
    - A supressão não-máxima de Canny deve quantizar em 4 setores ($0^\circ, 45^\circ, 90^\circ, 135^\circ$) utilizando desempate direcional estrito ($m \ge n_1 \land m > n_2$) para afinar platôs e degraus estritamente para 1 pixel de espessura.
    - A fusão de alta frequência escurece os canais fotométricos para intensificar linhas finas nos solvers de String Art: $I_{\text{fused}}(x, y) = \text{clamp}(I(x, y) - \beta_{\text{borda}} \cdot E(x, y), 0.0, 1.0)$.
  - **Mapa de Importância Espacial $W(x,y)$ e Pincel Interativo**:
    - Composição automática estrita: $W(x, y) = 1.0 + \beta_{\text{face}} \cdot M_{\text{saliência\_facial}}(x, y) + \beta_{\text{borda}} \cdot E(x, y)$.
    - O pincel manual (`user_brush_mask`) suporta reforço ($>0$) e zeramento ($<0$) com piso $W \ge 0.0$.
  - **Transformada de Radon, Sinograma e Filtro de Ram-Lak**:
    - O centro contínuo de rotação polar do sinograma deve ser fixado estritamente em $((W - 1)/2.0, (H - 1)/2.0)$ para preservar simetria circular radial analítica sobre grades discretas de pixels.
    - O filtro passa-alta em rampa de Ram-Lak opera no domínio espacial/discreto 1D com $h[0] = 0.25$, $h[n] = -1/(\pi^2 n^2)$ para $n$ ímpar e $h[n] = 0$ para $n$ par, eliminando FFT externa e preservando compilação pura para `wasm32-unknown-unknown`.
  - **Orquestrador de DSP e Cache de Diagnóstico**:
    - `DspPipeline` deve reter buffers intermediários em cache e exportar os 4 buffers da Studio View (`PreparedTargetRGBA`, `ImportanceMapRGBA`, `EdgesRGBA`, `RadonSinogramRGBA`), além do preview composto `EdgeAndRadonPreviewRGBA`.
- **Fundação Física e Métrica dos Solvers (Camada 2 - `weaver-solvers`)**:
  - **Layout SoA (_Struct of Arrays_) e Alinhamento SIMD**:
    - O estado da tela em simulação deve residir em `CanvasStateSoA`, mantendo vetores planos contíguos `Vec<f32>` separados por canal (`target_c0..c2`, `current_c0..c2`, `importance_w`, `base_importance_w`).
    - Todos os vetores devem ser preenchidos até múltiplos de `SOA_SIMD_LANE_ALIGNMENT = 16` floats (64 bytes / linha de cache AVX-512) com peso zero nos elementos de padding, garantindo laços vetorizados limpos sem tail-loops escalares ou desvios condicionais.
  - **Cobertura Física vs. Resolução (RF-2.3)**:
    - A cobertura por pixel é $c = \min\left(1.0, \frac{t_f \cdot R_{\text{px}}}{D_{\text{mm}}}\right)$ (`compute_effective_alpha` com $\alpha = 1$); a opacidade efetiva de um fio é $a = c \cdot \alpha_{\text{material}} \cdot w_{\text{sub-pixel}}$, aplicada **por carretel** pelo `OpticalModelEvaluator`. Não aplique `clamp` arbitrário à cobertura.
  - **Função Objetivo Exata (`optical_models.rs`)**:
    - O ganho de uma corda é a variação exata $\sum_p W(p) \left[ e_{\text{antes}}(p)^2 - e_{\text{depois}}(p)^2 \right]$, com $e = \text{enc}(C) - \text{enc}(T)$ e `enc` = curva sRGB (LUT de 4096 entradas); `ColorErrorMetric::LinearRgb` usa `enc` = identidade.
    - Modo `luma_only` (alvo e fio neutros) avalia um único canal; `chord_removal_gain`/`remove_chord` invertem a mistura óptica para o passe de refinamento.
  - **Estratégias de Carretel e Teto de Trocas Físicas**:
    - A estratégia `CoarseToFineEpochs` deve particionar deterministicamente as épocas de Base, Refino e Topo, assegurando rigorosamente menos de 15 trocas totais de carretel em 6.000 passos. O mapa de importância **não** é alterado durante a execução (o antigo reforço de bordas por época foi removido).
  - **Métricas (`telemetry_metrics.rs` / `MetricsTracker`)**:
    - Referência = foto enquadrada **sem realces** (`DspPipeline::reference_linear_rgb`), nunca o alvo processado.
    - Tela e referência desfocadas por gaussiana ($\sigma$ = resolução/250 px, visão à distância); SSIM padrão (janela gaussiana 1,5) e RMSE em luma sRGB; ΔE\*76 médio em CIELAB — tudo apenas dentro do disco do tear. Recalculadas a cada 250 passos e ao final.
- **Motores de Otimização e Solvers (Camada 2 - `weaver-solvers` / Task 2.4)**:
  - **Solver 1: Algoritmo Guloso Iterativo (`solvers/greedy.rs`)**:
    - Varre todos os pinos candidatos $p_{\text{prox}}$ a partir de $p_{\text{atual}}$ lendo as fatias contíguas da `SparseChordMatrixCSR`.
    - Normalização de Score: $\text{Score}(L, k) = \frac{\Delta E(L, k)}{|L|^\gamma} - \text{PenalidadeTroca}(k)$, onde $|L|$ é a integral de cobertura sub-pixel; para quando nenhuma corda reduz o erro.
    - Desempate estritamente determinístico (RNF-02): maior score; em empate, menor `to_pin`; em novo empate, menor `spool_id`.
    - Respeito a `max_chord_repeats` e fila FIFO de histórico Tabu recente.
  - **Passe de Refinamento (`solvers/refine.rs`)**:
    - Revisita os nós internos do caminho $(a \to p \to b)$ testando realocação de $p$ e remoção do nó, aceitando apenas movimentos que reduzem o erro exato e preservando o fio único e contínuo. `SolverSession` executa as fases Construção → Refinamento → Preenchimento e incrementa `path_revision` (ControlBlock `Int32[4]`) quando reescreve passos, para o renderer redesenhar do zero.
  - **Solver 2: Busca em Feixe sem Explosão de Memória (`solvers/beam_search.rs`)**:
    - Parametrizado por largura de feixe $B \in [2, 16]$ e profundidade de lookahead $d \in [2, 4]$.
    - Proibição de clonagem por candidato: pool estático fixo de exatamente $2 \times B$ estados `CanvasStateSoA` (`pool_a` e `pool_b`) pré-alocado na inicialização.
    - Avaliação diferencial read-only na CSR para todos os candidatos; mutação de pixels via `copy_from` e `apply_chord` restrita exclusivamente aos $B$ sobreviventes de cada nível.
  - **Solver 3: Otimização Global Contínua NNLS/FISTA + Roteamento Euleriano (`solvers/global_fista.rs`)**:
    - Formulação Matrix-Free $\min_{w \ge 0} \frac{1}{2} \|A w - b\|_2^2 + \lambda_1 \|w\|_1$: operadores direto $A w$ e adjunto $A^T r$ varrem diretamente a `SparseChordMatrixCSR` sem alocar matrizes densas. Raio espectral $L = \|A^T A\|_2$ estimado via método das potências.
    - Quantização discreta de pesos contínuos pelo método dos maiores restos com limite `max_chord_repeats`.
    - Roteador Contínuo Euleriano: algoritmo de Hierholzer combinado com Nearest-Neighbor Stitching para saltos em componentes conexas, garantindo sequência contínua ininterrupta de pinos $(p_0, p_1, \dots, p_K)$.
    - Sub-camadas de Pintor (_Painter's Algorithm_): divisão dos passos de cada carretel em $L$ sub-camadas intercaladas periodicamente para evitar que a última cor sobre-escureça as camadas inferiores.
  - **Interface Unificada de Execução (`solver_runner.rs`)**:
    - Máquina de estados `SolverSession` com `step_batch(&mut self, batch_size: usize) -> SolverProgress`, permitindo processamento em lotes e interrupções atômicas `PAUSE`, `RESUME` e `ABORT`.
- **Manufatura Física, Gabaritos Paginados 1:1, CSV Mecânico e G-Code CNC (Camada 2 - `weaver-cam` / Sprint 3 Task 3.1)**:
  - **Zero Dependências de SO / Pure Rust para WebAssembly**:
    - `weaver-cam` depende exclusivamente de `weaver-domain`, com zero bibliotecas C externas, garantindo compilação pura para `wasm32-unknown-unknown` e execução nativa em navegador ou CLI.
  - **Paginador de Gabarito de Furação 1:1 (`blueprint_tiler.rs`)**:
    - Suporta formatos de papel (`A4`, `A3`, `Letter`) com margem de impressora configurável (padrão 10.0 mm) e sobreposição de colagem (padrão 15.0 mm).
    - Grade matricial $(r, c)$ centralizada simetricamente sobre a Bounding Box do aro ($W_{\text{bb}} \times H_{\text{bb}}$).
    - **Culling Analítico de Vão Central Vazio**: Identifica páginas em que a distância máxima de todos os cantos até a origem é estritamente menor que o raio interno do aro ($d_{\max} < R_{\text{inner}}$) sem conter pinos nem bordas, marcando-as como `is_empty_interior = true` para economizar papel e tinta.
    - **Projeção em Folhas Ativas**: Círculo no diâmetro exato da broca ($\varnothing_{\text{broca}}\text{ mm}$), cruzeta central de punção de `0.2 mm` em vermelho, rótulo numérico ($1 \dots N$) projetado ao longo da normal unitária externa ($\vec{n}$) para eliminar colisão com furos adjacentes, arcos do aro e linha primitiva tracejada sob máscara de recorte (`clip_rect`).
    - **Aferição e Registro**: Cruzetas fiduciais de registro (`+`) nos 4 cantos da área útil, linhas de corte/sobreposição tracejadas com instruções de colagem (ex: `Folha B2 - Colar à direita com B3`), e **Régua de Aferição de Escala de 100.0 mm** milimetrada impressa no rodapé de cada folha ativa para validação física com paquímetro.
    - Exporta SVG mestre 1:1 integral (`to_master_svg`) e PDF multi-páginas 1:1 vetorial (`to_multipage_pdf`).
  - **Gerador Vetorial de PDF 1.4 Puro (`pdf.rs`)**:
    - Estrutura ISO PDF 1.4 pura diretamente em bytes (`Vec<u8>`), objetos de catálogo, árvore de páginas, fontes Type 1 (`Helvetica` e `Helvetica-Bold` em `WinAnsiEncoding`), e operadores vetoriais padrão (`w`, `G`, `g`, `RG`, `rg`, `m`, `l`, `c`, `re W n`, `BT/ET`).
    - Círculos traçados por 4 cúbicas de Bézier com constante analítica $\kappa = 0.5522847498$.
    - Offsets da tabela `xref` registrados diretamente a partir de `output.len()`, eliminando contadores mutáveis e conflitos de borrow-checker.
  - **Exportador de Coordenadas Mecânicas CSV (`csv_exporter.rs`)**:
    - Tabela com precisão estrita de 4 casas decimais (`0.0001 mm`) nas 9 colunas canônicas:
      `pin_number,angle_deg,arc_length_mm,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm`
  - **Gerador de G-Code CNC de Furação (`gcode_exporter.rs`)**:
    - Suporte a ciclos enlatados ISO/GRBL/Mach3: ciclo profundo pica-pau `G83 X... Y... Z... R... Q... F...` (quando `peck_depth_mm` definido e $> 0$) ou furação simples `G81`.
    - Percurso perimétrico sequencial $0 \dots N-1$ para minimizar deslocamentos em vazio do cabeçote da máquina CNC.
    - Cabeçalho de segurança (`G21 G90 G17 G94`, `S... M03`, `G00 Z...`) e encerramento com cancelamento e desliga fuso (`G80 M05 M30`).
- **BOM Logístico, Exportação da Obra e Codec de Retomada (Camada 2 - `weaver-cam` / Sprint 3 Task 3.2)**:
  - **Calculadora de BOM e Tempo de Execução (`bom_calculator.rs`)**:
    - **Comprimento Trigonométrico Real**: O consumo de fio de cada corda deve somar o comprimento linear livre da tangente física exata entre os pinos (`compute_tangent`) com o arco de contorno de acomodação perimétrica ao redor do pino cilíndrico ($\Delta L \approx \pi \cdot r_p$).
    - **Margens e Cones Comerciais**: Agrupamento estrito por carretel/cor com margem de segurança configurável (padrão `+10%`), folga adicional de ponta para nós/amarração (padrão `300.0 mm`), cálculo do número inteiro de cones comerciais (arredondado para cima com base no padrão comercial de `1000.0 m`) e taxa de uso da capacidade (`spool_usage_percent`).
    - **Modelo Bifásico de Tempo Manual**: Detalha separadamente o tempo ativo tecendo (`weaving_time_seconds`, cadência média configurável de `4.5 s/passo`) e o tempo gasto em preparo, cortes e amarrações (`knot_and_switch_time_seconds`, `90.0 s` por amarração inicial `tie_on` e por troca de carretel `switch`), além de formatação amigável para humanos (`format_duration`, ex: `"4 h 32 min"`).
  - **Exportadores da Obra (`artwork_exporter.rs`)**:
    - **Vetor `.svg` 1:1 da Obra**: Deve agrupar os passos em camadas `<g id="spool-k-epoch-m">` dispostas na ordem física exata de empilhamento (de baixo para cima), utilizando a espessura física real do fio em milímetros (`t_f`, ex: `0.20 mm`), opacidade calibrada e coordenadas contínuas das tangentes (`CW`/`CCW`).
    - **Instruções `.txt` para Tecelagem Humana**: Estruturadas em blocos de cor indicando o carretel, pino de amarração inicial e contagem de passos, contendo linhas formatadas no padrão: `Passo 0001 | Pino   1 -> Pino 102 (Sentido Horário/Anti-Horário)`.
    - **Projeto `.json` Completo**: Serialização determinística pura (bit a bit) contendo metadados, hash do projeto, geometria do tear, diagnóstico mecânico de furação, parâmetros de BOM e sequência completa de passos.
  - **Codec de Retomada e Compressor Serverless (`resume_codec.rs`)**:
    - **Token de Progresso em URL Hash**: Padrão canônico `WA1-<project_hash>-<spool_idx>-<step_idx>` para retomada rápida via URL (`#progress=...`), onde `project_hash` é o hash FNV-1a de 64 bits em hexadecimal (`16` caracteres) derivado da geometria e dos passos.
    - **Compressor Binário Serverless (Delta + RLE em Base64URL)**: Serialização compacta sem dependências externas combinando Run-Length Encoding das cores com Delta Encoding perimétrico modular dos pinos e bits de enrolamento `(CW/CCW)` codificados em Base64URL puro (sem padding `=`), viabilizando QR Codes e compartilhamento P2P de projetos completos.
  - **Sintaxe de Raw Strings em Rust contendo Cores Hexadecimais**:
    - Em templates SVG/XML ou asserções contendo atributos como `fill="#666666"` ou `stroke="#000000"`, utilize obrigatoriamente delimitadores estendidos `r##"..."##` (dois ou mais `#`) para prevenir que o compilador Rust interprete `"#` como fechamento antecipado de string raw.
- **Adaptador WebAssembly e Ponte de Memória Compartilhada (Camada 3 - `weaver-wasm-adapter` / Task 3.3)**:
  - **Mapeamento Canônico de Layout Binário (ADR-003)**:
    - `WasmWeavingEngine` mapeia diretamente o buffer fornecido pelo JavaScript em 3 views independentes:
      - `control_view`: `Int32Array` (offset 0 bytes, 32 bytes de controle atômico).
      - `metrics_view`: `Float32Array` (offset 32 bytes, 96 bytes de telemetria).
      - `path_view`: `Uint8Array` (offset 128 bytes, 8 bytes por passo de tecelagem).
  - **Detecção Dinâmica de `is_shared` e Fallback Seguro de Atomics**:
    - O motor deve verificar em runtime se o buffer é compartilhado (`SharedArrayBuffer`).
    - Operações de `Atomics::store` e `Atomics::load` são restritas a buffers compartilhados; em buffers convencionais (`ArrayBuffer`), a escrita deve utilizar atribuição indexada direta, impedindo exceções do tipo `TypeError: Not a SharedArrayBuffer`.
  - **Cache Estrutural da Matriz Esparsa CSR**:
    - `WasmWeavingEngine` deve armazenar em cache a tupla `(LoomPhysicalSpec, Pixels, min_pin_distance, RasterizerType, Arc<SparseChordMatrixCSR>)`.
    - Ao chamar `init_solver()`, se a geometria física, a resolução, a distância mínima de pinos e o tipo de rasterizador forem idênticos à sessão anterior, a matriz existente **deve ser reutilizada** sem re-alocação ou re-rasterização.
  - **Especialização SIMD e Supressão de Chamadas `powf` no Solver Guloso**:
    - No laço crítico de avaliação (`chord_marginal_gain`), o caminho para o modelo padrão (`PorterDuffOcclusion` + `LinearRgb`) deve ser especializado monomorficamente sem ramificações dinâmicas por pixel, viabilizando vetorização automática SIMD pelo LLVM.
    - Ao computar penalidade de comprimento $1 / |L|^\gamma$, verificar explicitamente `if (gamma - 1.0).abs() < 1e-6 { chord_len }` para suprimir chamadas à função `powf` da `libm` em laços de alta frequência.
  - **Compatibilidade Estrita de `ArrayBufferLike` no TypeScript (TS2322)**:
    - Memórias originadas do Wasm ou métodos como `ArrayBuffer.prototype.slice` retornam o tipo `ArrayBufferLike` (`ArrayBuffer | SharedArrayBuffer`).
    - Ao transferir dados para APIs que exigem `ArrayBuffer` convencional (como `Blob([buffer])`), utilize o padrão de cópia defensiva `copyToConventionalArrayBuffer(view: Uint8Array): ArrayBuffer`.
    - Constantes do domínio (como `SolverStatusFlag`) devem ser importadas por valor (`import { SolverStatusFlag }`), jamais como tipo (`import type`).
- **Renderizador Físico WebGL2 e Acumulação em Ponto Flutuante (`renderer-webgl/` / Task 4.1)**:
  - **Pipeline em Dois Estágios (ADR-002)**:
    - **Estágio 1 (Acumulação Linear em `RGBA16F`)**:
      - Requer a extensão `EXT_color_buffer_float`. Se não suportada pelo dispositivo, ativa automaticamente fallback gracioso para Canvas 2D de alta resolução (`canvas2d-fallback`).
      - Framebuffer offscreen inicializado estritamente na cor do fundo do tear convertida para **Linear RGB ($\gamma = 1.0$)**.
      - Cada corda é geometrizada como um quad instanciado (4 vértices compartilhados, 9 floats por instância: `[x0, y0, x1, y1, r, g, b, a, thicknessMm]`).
      - Vértices projetados ao longo das tangentes físicas exatas (`CW`/`CCW`) dos pinos; Fragment Shader calcula a distância sub-pixel $d \in [-1, 1]$ ao eixo central, modelando perfil cilíndrico $\sqrt{1 - d^2}$ com anti-aliasing analítico e mistura óptica Porter-Duff linear (`GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA`).
    - **Estágio 2 (Screen Pass Shader)**:
      - Fullscreen quad amostrando a textura acumulada `RGBA16F`.
      - Tone mapping fotométrico com conversão de Linear RGB para sRGB canônico (IEC 61966-2-1).
      - Efeito sutil de brilho/anisotropia direcional ao longo da tangente do fio, aro físico delimitador e pinos metálicos com iluminação Blinn-Phong.
      - Suporte nativo a Zoom e Pan contínuos mapeando coordenadas de tela para o espaço métrico do tear.
  - **Loop Incremental Zero-Copy a 60 FPS**:
    - O renderizador mantém o ponteiro `lastRenderedStep`.
    - A cada quadro (`requestAnimationFrame`), lê `CurrentStepIndex` de forma atômica no `ControlBlock` do `SharedArrayBuffer`.
    - Faz o upload via `gl.bufferSubData` **apenas das novas cordas** tecidas no intervalo $[lastRenderedStep \dots CurrentStepIndex]$, garantindo 60 FPS estáveis mesmo com $>7.000$ linhas na tela e zero alocações na heap por quadro.
- **Protocolo de Diagnóstico DSP e Pincel Interativo de Foco Facial (Studio View / Task 4.1)**:
  - **5 Abas Canônicas de Diagnóstico**:
    - A miniatura de inspeção do Estúdio deve disponibilizar exatamente 5 modos: `1. Alvo Preparado`, `2. Mapa de Importância W(x,y)`, `3. Bordas Sobel/Canny`, `4. Sinograma de Radon` e `5. Erro Residual`.
    - Os buffers visuais devem ser transferidos do adaptador Wasm (`PreviewBuffers`) e pintados no canvas via `createImageData` e `set(buffer)`.
  - **Pincel Interativo de Foco Facial**:
    - Disponível exclusivamente quando a aba `2. Mapa de Importância W(x,y)` estiver ativa.
    - Suporta dois modos comutáveis: `+ Reforçar Nitidez` (peso $> 1.0$) e `- Reduzir Peso` (peso $< 1.0$, piso $0.0$).
    - Disparo de atualizações para o Worker Wasm via `apply_user_importance_brush` deve ser throttled (ex: $\le 60\text{ Hz}$ durante o arraste) com coordenadas normalizadas $[0, 1]$ relativas ao tear.
- **Invariantes de Testabilidade de Gráficos e DOM em Vitest/Node**:
  - Controladores gráficos e de visualização devem inicializar sem falhas em ambientes sem GPU (Node/Vitest), ativando modo fallback quando `gl === null`.
  - Mocks de `getBoundingClientRect()` devem retornar instâncias completas da interface `DOMRect` (`width, height, top, left, right, bottom, x, y, toJSON`) para satisfazer o TypeScript estrito (`TS2739`).
  - Eventos de ponteiro/mouse sintéticos em testes de desenho devem ser despachados com coerência entre `rect.width` e `canvas.width` para que coordenadas projetadas reflitam a posição real do pixel.
- **Regra de Dependências Cargo e Localização de Testes de Integração**:
  - Crates da Camada 2 (`weaver-solvers`, `weaver-dsp`, `weaver-cam`) são nós irmãos e **não podem** conter dependências mútuas no `Cargo.toml`, inclusive sob `[dev-dependencies]`.
  - Testes de integração de ponta a ponta que conjugam múltiplos crates da Camada 2 (ex: pipeline DSP + Solvers) devem residir estritamente na Camada 3 (`crates/weaver-wasm-adapter/tests/`) ou Camada 4 (`crates/weaver-cli/tests/`).
- **Importações ESM em Testes Web**:
  - Testes em `apps/web/test/` devem importar módulos internos utilizando o caminho com extensão `.js` apontando para `../src/<dominio>/index.js`.
- **Ambiente de Toolchain Rust no Windows**:
  - O binário `cargo` reside tipicamente em `$env:USERPROFILE\.cargo\bin`. Ao executar comandos PowerShell não interativos, garanta `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
  - Evite o operador `&&` no PowerShell clássico; utilize `;` com teste de `$LASTEXITCODE`.
- **Modo Tecelagem, Tangência Física, Hands-Free Voice TTS e Persistência Móvel (`views/player-view/` / Task 4.3)**:
  - **Visualização de Tangência Física Dupla**:
    - Desenho de arcos e pontas de seta no pino de saída (`fromPeg`, `s.fromSide`) e no pino de chegada (`toPeg`, `s.toSide`) indicando o sentido de contorno físico calculado pelo Rust (`-1` = horário / CW, `1` = anti-horário / CCW).
    - Cordas já tecidas desenhadas em baixa opacidade e corda ativa com linha vibrante e halo de realce.
  - **Cadência Humana Adaptativa**:
    - O tempo restante estimado é recalculado dinamicamente com base nos passos restantes multiplicados pela média móvel dos intervalos reais dos passos recentes executados pelo artesão, com fallback gracioso para o modelo analítico `estimateWeave`.
  - **Interrupção e Alerta Automático de Troca de Carretel**:
    - Sempre que o passo atual exigir mudança de fio (`step[t].thread !== step[t-1].thread` ou `layerIndex !== prevStep.layerIndex`), o temporizador de avanço automático é pausado imediatamente, um chime de camada é reproduzido e um card de destaque exibe a instrução: _"Troca de Carretel: Amarre e finalize o fio [Cor Anterior] no pino [X] e inicie o carretel [Nova Cor]"_.
  - **Síntese de Voz Hands-Free (Web Speech API) com Utterance Watchdog**:
    - Ditado em `pt-BR` de forma clara e concisa (`"[Pino Destino], [horário / anti-horário]"`).
    - No modo automático (`"Avançar sozinho a cada X s"`), o contador regressivo para o próximo passo só é disparado após a conclusão da fala (`utterance.onend`), evitando atropelar a pronúncia, com watchdog de segurança contra stalls do motor de síntese.
    - Suporte a atalhos globais de teclado: `Espaço` / `Seta Direita` (próximo), `Seta Esquerda` (anterior), `P` (pausar/retomar avanço automático) e `Escape` (fechar modal/alertas).
  - **Persistência Híbrida IndexedDB e Sincronização Móvel via QR Code**:
    - Persistência assíncrona do projeto completo `WeaveResult` e do progresso no `IndexedDB` (`weaver-art-db`) com espelhamento rápido no `localStorage`.
    - Sincronização em tempo real do hash da URL (`#progress=WA1-...`).
    - Modal de sincronização móvel com gerador de **QR Code vetorial SVG puro e sem dependências externas** (`QRCodeGenerator` ISO/IEC 18004), permitindo apontar a câmera do celular/tablet e retomar a tecelagem sem atrito.
- **Tríade de Hospedagem Estática e Cross-Origin Isolation (`COOP/COEP`) (Task 4.4)**:
  - Para que o `SharedArrayBuffer` funcione em deploys estáticos gratuitos sem requerer servidor Node dedicado, o repositório deve manter e versionar estritamente a tríade de isolamento:
    1. **`vercel.json` (raiz e `apps/web`)**: Cabeçalhos `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp` para todas as rotas `/(.*)`.
    2. **`public/_headers` (raiz e `apps/web/public`)**: Regras estáticas para Cloudflare Pages e Netlify para `/*`.
    3. **`public/coi-serviceworker.js`**: Service Worker leve carregado condicionalmente em `index.html` apenas quando `window.crossOriginIsolated === false` (viabilizando execução transparente no GitHub Pages).
- **Pipeline de Build Unificado e Autocura de Wasm em Dev (Task 4.4)**:
  - O script `"build"` raiz orquestra a sequência estrita: compilação do Wasm em Rust (`scripts/build-wasm.mjs`), compilação TypeScript dos workspaces (`core`, `wasm`, `cli`), empacotamento Vite de `apps/web/` e sincronização do resultado para o diretório raiz `dist/` (`scripts/sync-dist.mjs`).
  - O script `"dev"` deve invocar `scripts/ensure-wasm.mjs` para garantir que o binário `.wasm` esteja presente ou compilado antes do boot do Vite, prevenindo exceções de inicialização em novos clones do projeto.
- **Loop de Telemetria Atômica a 60 Hz e BOM via `weaver-cam` (Task 4.4)**:
  - Durante a execução do solver, a interface gráfica deve atualizar métricas de convergência exclusivamente a 60 Hz via `requestAnimationFrame`, lendo diretamente o `ControlBlock` atômico do `SharedArrayBuffer` sem alocações temporárias na heap da main thread.
  - Ao pausar ou concluir a tecelagem, a interface deve invocar o exportador CAM (`engineClient.exportCam('bom_json')`) para popular a tabela de carretéis (comprimento, carretéis de 1.000 m com margem de +10% e custos) e exibir a estimativa de tempo manual formatada.
- **Invariante de Estreitamento de Tipo (Type Narrowing) em Closures TypeScript**:
  - O TypeScript não propaga o narrowing de não-nulo de variáveis mutáveis (`let result`) para dentro de closures/callbacks assíncronos (`.filter()`, `.map()`, `setTimeout`).
  - Em handlers de conclusão de workers ou eventos assíncronos, atribua imediatamente a variável a uma constante local imutável (`const activeResult = result;` ou `const steps = result.steps;`) antes de invocar operadores funcionais, evitando erros `TS18047: 'result' is possibly 'null'`.
- **Verificação Obrigatória**:
  - Antes de concluir qualquer tarefa, execute a checagem integrada: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"; cargo check --workspace; cargo test --workspace; npm run check; npm run build`. Todos os testes e compilações devem passar com 0 erros.

## Formas de Atuação

Você está atuando em um sistema de alta precisão matemática e mecânica (**Weaver Art**): um motor de _String Art_ computacional policromático e manufatura assistida (CAM) construído em **Rust (WebAssembly SIMD)** e **TypeScript (WebGL2)**.

Antes de planejar ou modificar qualquer linha de código, você **DEVE** ler e obedecer rigorosamente a este documento e às especificações em `docs/REQUIREMENTS.md`, `docs/ARCHITECTURE.md` e `docs/ALGORITHM.md`.

---

## 1. Protocolo de Trabalho Incremental (REGRA DE OURO)

1. **Uma Única Responsabilidade por Tarefa (Mudanças Atômicas):**
   - **PROIBIDO** alterar simultaneamente o Frontend (UI/Canvas), o Pipeline DSP e a Matemática do Solver na mesma tarefa.
   - Se o usuário relatar um problema visual, isole primeiro se a falha está: (a) na renderização/UI (`apps/web`), (b) no pré-processamento (`weaver-dsp`), ou (c) na otimização (`weaver-solvers`), e corrija **um único elo por vez**.
2. **Proibição de Código Prematuro sem Diagnóstico:**
   - Nunca proponha ou aplique "chutes" em constantes mágicas. Toda alteração em equações deve ser justificada matematicamente com base em `docs/ALGORITHM.md`.
3. **Expurgo Estrito de Legado:**
   - É terminantemente proibido duplicar controles no DOM ou manter código morto "por segurança". A pasta legada `packages/` não faz parte da arquitetura ativa; toda a lógica reside em `crates/*` (Rust) e `apps/web/src/*` (TypeScript).

---

## 2. Invariantes Críticas do Sistema (NUNCA VIOLE)

### Invariante 1: Unificação do Sistema de Coordenadas (Rust $\leftrightarrow$ Canvas 2D $\leftrightarrow$ WebGL2)

- **Convenção do Pino 0 e Sentido de Rotação:**
  - Em **TODOS** os módulos (`weaver-domain`, `WebGLLoomRenderer`, `BlueprintCanvas` e `PlayerView`), o **Pino 0 (`index = 0`) DEVE iniciar no topo (12 horas, ângulo $-\frac{\pi}{2}\text{ rad}$ ou $-90^\circ$)** e avançar no **sentido horário (CW)**.
  - Nunca inicie o contorno circular em $0\text{ rad}$ (3 horas) no Rust, pois isso rotaciona a obra em $90^\circ$ em relação à tela.
- **Convenção do Eixo Vertical ($Y$):**
  - Na imagem alvo (`weaver-dsp`) e no Canvas 2D (`core-helpers.ts`), a origem $(0,0)$ fica no **canto superior esquerdo** ($Y$ cresce para baixo).
  - No **WebGL2 (`webgl-loom-renderer.ts`)**, o framebuffer possui origem no **canto inferior esquerdo** ($Y$ cresce para cima). Portanto, ao enviar os vértices das cordas (`seg.y0`, `seg.y1`) para o WebGL2, **DEVE-SE** converter a coordenada vertical fazendo `y_webgl = extentMm - seg.y`, e no arraste do mouse (`pointermove`) o deslocamento `panY` no WebGL deve subtrair `dy`.

### Invariante 2: Integridade de Dimensões de Buffers de Imagem

- Nunca desenhe um `Uint8ClampedArray` em um `<canvas>` assumindo dimensões fixas sem antes validar se `data.length === width * height * 4`.
- Caso a pré-visualização instantânea opere em `256x256` e o Wasm opere em `500x500`, o método de pintura deve inferir `actualSide = Math.round(Math.sqrt(data.length / 4))` e redimensionar o `canvas.width` e `canvas.height` antes de chamar `ctx.putImageData()`, evitando o bug de listras diagonais corrompidas.

### Invariante 3: Imutabilidade do Enquadramento do Usuário (`Pan / Zoom / Rotação`)

- Quando o usuário posicionar a foto manualmente (via mouse ou sliders `cropZoom`, `cropPanX`, `cropPanY`, `cropRotation`), **NENHUM** evento de mudança de Preset, mudança de número de linhas ou retorno assíncrono do Worker Wasm pode sobrescrever os valores dos sliders de enquadramento na UI.
- O enquadramento automático pelo rosto só é aplicado **ao carregar uma foto nova**, ao trocar o alvo (Rosto/Cabeça e ombros) ou ao clicar em "Enquadrar rosto". Trocar de preset ou "Restaurar padrão do modo" preserva o enquadramento da foto carregada (`keepImageFraming` em `main.ts`).
- O arraste da foto na aba `1. Alvo` deve ser renderizado instantaneamente a 60 FPS no cliente via `ctx.drawImage` acelerado por GPU, aplicando _debounce_ ($\ge 200\text{ ms}$) nas chamadas `loadAndPrepareImage` do Wasm para jamais travar a _Main Thread_.

### Invariante 4: Sincronização de Fonte Única da Verdade (Estúdio $\leftrightarrow$ BOM $\leftrightarrow$ Modo Tecelagem)

- A tabela de `Estimativa de Carretéis`, os contadores de rodapé (`LINHAS`, `FIO`, `TROCAS / NÓS`) e o `Modo Tecelagem` devem ler **exatamente a mesma sequência de passos e a mesma paleta de cores ativa** (`MONOCHROME`, `CMYK_SUBTRACTIVE`, `RGB_OCCLUSIVE` ou `USER_CUSTOM`).

---

## 3. Lista Negra de Anti-Padrões (PROIBIDO IMPLEMENTAR)

1. **PROIBIDO converter o alvo para escala de cinza quando `paletteMode !== 'MONOCHROME'`:** Em modos coloridos, o CLAHE e ajustes tonais atuam apenas na luminância, preservando 100% da cromaticidade RGB.
2. **PROIBIDO permitir que fios coloridos (C, M, Y) atuem em pixels acromáticos/pretos:** Sem separação UCR/GCR, o carretel Amarelo tenta reduzir a distância euclidiana RGB em roupas pretas ou óculos escuros, criando bordas amarelas artificiais na periferia do aro.
3. **PROIBIDO penalizar excessivamente o fundo branco (> 0.5x):** Toda corda que desenha os olhos e óculos no centro precisa atravessar o fundo claro nas laterais da cabeça. Uma penalidade severa no fundo branco bloqueia o centro do retrato e aborta o solver prematuramente.
4. **PROIBIDO alocar memória na Heap ou recalcular mapas inteiros dentro do _hot loop_:** Nunca execute cópias de `250.000` pixels a cada passo individual do solver.

---

## 4. Comandos de Verificação Obrigatória após cada Tarefa

Antes de dar qualquer tarefa por concluída, execute e valide:

1. `cargo test --workspace` (Todos os testes unitários e de integração em Rust devem passar).
2. `npm run build:wasm` (O pacote WebAssembly em `apps/web/src/core-bridge/pkg` deve ser atualizado sempre que arquivos `.rs` forem tocados).
3. `npm --prefix apps/web run typecheck` (`tsc --noEmit` deve passar com zero erros).
