# Weaver Art

> Um único fio preto. Um aro circular com 200 pinos. Quatro mil cordas. Um retrato.

**Weaver Art** gera padrões de _string art_ computacional em tear circular: a partir de uma
fotografia, calcula a sequência de pinos por onde **um fio contínuo** deve passar para que a
sobreposição de cordas reproduza a imagem — e depois **dita, passo a passo**, a tecelagem à mão.

O projeto toma como referência a obra **“A new way to knit” (2016)**, de
[Petros Vrellis](https://artof01.com/vrellis/works/knit.html), e os projetos abertos
[alyyousuf7/Weaver](https://github.com/alyyousuf7/Weaver) e
[MarginallyClever/weaving_algorithm](https://github.com/MarginallyClever/weaving_algorithm).
O objetivo é ir além dessas implementações e chegar o mais perto possível da precisão do
trabalho do artista — modelando o **objeto físico** (milímetros, largura do fio, diâmetro dos
pinos, comprimento real do fio) em vez de apenas desenhar linhas em pixels.

## O que há de diferente

|                     | Implementações clássicas              | Weaver Art                                                                                                                                                                                               |
| ------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unidades            | pixels                                | **milímetros** (padrão: aro de bicicleta 28″ ISO 622 = 622 mm, ou retangular/personalizado com dimensões reais)                                                                                          |
| Enquadramento       | manual                                | **detecção de rosto Viola-Jones** (Rust puro) — o rosto preenche ~95% do aro automaticamente ao carregar a foto                                                                                          |
| Formato do tear     | apenas círculo fixo                   | **circular, quadrado, retangular ou pinos arbitrários via CSV** com detecção de envoltória convexa e máscara analítica antisserrilhada                                                                   |
| Critério de escolha | “linha mais escura” (média de pixels) | **redução do erro quadrático** entre simulação e alvo (com penalidade de comprimento configurável)                                                                                                       |
| Modelo de tom       | subtrai constante do alvo             | **cobertura física do fio** em luz linear: `T = Π(1 − cᵢ)` — o tom escurece com a densidade **e com as interseções**, como descrito por Vrellis                                                          |
| Espaço de cor       | sRGB (gama)                           | **luz linear** (sRGB ↔ linear correto)                                                                                                                                                                   |
| Rasterização        | Bresenham / Wu                        | **cobertura exata de área** de um fio com largura real (sub-pixel)                                                                                                                                       |
| Pinos               | pontos                                | **cilindros com diâmetro**: segmentos tangentes, sentido de contorno (horário/anti-horário) e arco enrolado no pino                                                                                      |
| Comprimento do fio  | estimado                              | **exato** (segmentos + arcos), com **penalidade ajustável** para economia de linha                                                                                                                       |
| Cor                 | camadas separadas                     | **paleta automática da foto** (K-Means em CIELAB), **camadas sequenciais (`layered`) ou intercalado balanceado** com cotas ponderadas e âncora escura (presets `vrellis-color`, `cmyk` ou personalizado) |
| Percepção           | pixel a pixel local                   | **modelo óptico de meio-tom** ($G * (T - C)$), **distância de observação** (desfoque retiniano, Birsak et al., 2018), CLAHE e **métricas CIELAB ΔE e SSIM**                                              |
| Otimização          | apenas gulosa                         | **gulosa + refinamento global pós-processamento** preservando a continuidade física estrita do fio                                                                                                       |
| Desempenho          | laço único JS sem cache               | **cache LRU exato de cordas**, **poda lazy greedy (Minoux 1978)**, **núcleo Rust SIMD (WASM)** e **paralelismo multi-worker (SharedArrayBuffer + Atomics)**                                              |
| Calibração          | manual empírica                       | **ferramenta de calibração** de cor e parâmetros físicos a partir de fotos de meadas                                                                                                                     |
| Fabricação          | nenhuma                               | **gabaritos de furação 1:1** (SVG e PDF multi-folhas com régua de conferência), **estimativa de tempo/carretéis**, **exportação G-code (XY)** e **retomada entre dispositivos**                          |
| Saída               | lista de pinos                        | instruções `.txt` agrupadas por camada com estimativa, `.csv`, `.json`, **SVG 1:1**, PNG, G-code e **modo tecelagem com voz e sincronização**                                                            |

Detalhes matemáticos em [docs/ALGORITHM.md](docs/ALGORITHM.md).

## Estrutura

```
weaver-art/
├── packages/
│   ├── core/   @weaver-art/core — motor e fabricação (TypeScript puro, sem dependências; roda no navegador e no Node)
│   ├── wasm/   @weaver-art/wasm — kernel computacional de alta performance em Rust compilado para WebAssembly com SIMD 128-bit
│   └── cli/    @weaver-art/cli  — linha de comando (foto → JSON/TXT/CSV/SVG/PNG/GCODE/PDF)
├── apps/
│   └── web/    @weaver-art/web  — estúdio no navegador (Vite + Web Worker) e modo tecelagem com sincronização
└── docs/       arquitetura, algoritmo, referências e roadmap
```

## Começando

Requisitos: **Node.js ≥ 22.12** (veja `.nvmrc`).

```bash
npm install
npm test                 # testes unitários (Vitest)
npm run dev              # estúdio web em http://localhost:5173
```

### Linha de comando

```bash
npm run build
npm run weave -- foto.jpg                                                    # preset monocromático padrão
npm run weave -- foto.jpg --preset portrait-mono                             # preset Petros Vrellis para retratos (alta fidelidade)
npm run weave -- foto.jpg --preset portrait-cmyk                             # preset CMYK calibrado para pele humana (4 camadas)
npm run weave -- foto.jpg --preset cmyk --lines 10000 --repeats 2            # preset CMYK em camadas (10.000 cordas)
npm run weave -- foto.jpg --auto-palette 4 --halftone --lines 6000           # paleta automática da foto + meio-tom óptico
npm run weave -- foto.jpg --accel wasm --pruning lazy                        # aceleração máxima com Rust SIMD + poda lazy
npm run weave -- foto.jpg --accel parallel --threads 4                       # paralelismo em 4 threads via SharedArrayBuffer
npm run weave -- foto.jpg --cache-mb 256                                     # ajuste do orçamento do ChordCache de rasterização
npm run weave -- foto.jpg --shape square --width 500 --pegs 50 --gcode       # tear quadrado 500 mm + geração de G-code CNC
npm run weave -- foto.jpg --shape rectangle --width 600 --height 400 --pegs-x 60 --pegs-y 40
npm run weave -- foto.jpg --pegs-csv pinos.csv                               # pinos personalizados via CSV
npm run weave -- template --shape rectangle --width 600 --height 400 --paper A4 -o gabarito  # apenas gabarito de furação
npm run weave -- estimate output/foto.weave.json --spool 1000                # estimativa de tempo e consumo de carretéis
npm run weave -- gcode output/foto.weave.json --clearance 1.5                # gera G-code a partir de projeto existente
npm run weave -- extract-palette foto.jpg 4                                  # extrai e analisa paleta de cores CIELAB
npm run weave -- calibrate-color amostra-carretel.jpg                        # calibra cor #hex a partir de foto
npm run weave -- --help
```

> [!TIP]
> **Tecelagem Multicolorida em Camadas**:
> Por padrão, presets coloridos utilizam `colorStrategy: 'layered'`. As cores constroem a base cromática luminosa primeiro e o **fio preto entra por último**, conferindo nitidez e contraste sem apagar as cores de baixo. Além disso, avaliar apenas o fio ativo torna a geração em camadas **4 a 5× mais rápida**.

Arquivos gerados em `./output/`:

| Arquivo             | Conteúdo                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| `foto.weave.txt`    | instruções numeradas para tecer à mão com bloco de estimativa de fabricação   |
| `foto.weave.csv`    | uma linha por corda (passo, fio, pinos, lados, comprimentos, ganho)           |
| `foto.weave.json`   | projeto completo com metadados de progresso (reabrível no modo tecelagem)     |
| `foto.weave.svg`    | desenho vetorial em escala real 1:1 (mm), com arcos nos pinos e camadas       |
| `foto.weave.png`    | simulação física do resultado                                                 |
| `foto.target.png`   | imagem-alvo após o preparo                                                    |
| `foto.template.svg` | gabarito de furação vetorial 1:1 com cruzes de centro e régua de 100 mm       |
| `foto.template.pdf` | gabarito de furação ladrilhado em escala 1:1 para impressão (A4, A3 ou Carta) |
| `foto.pegs.csv`     | coordenadas físicas de furação de todos os pinos em mm                        |
| `foto.weave.gcode`  | código CNC RS-274 para robôs e plotters de tecelagem (quando ativado)         |

### Estúdio web

1. Arraste uma foto (retratos funcionam melhor — como na série de Vrellis baseada em El Greco).
2. **Enquadramento automático pelo rosto**: ao carregar a foto, o detector de rostos (Viola-Jones, em Rust/Wasm) ajusta zoom e posição para o rosto preencher ~95% do aro (o topo do cabelo e as orelhas ficam de fora — é assim que o rosto fica grande o bastante para ser reconhecido). Em fotos com várias pessoas, clique de novo em **Enquadrar rosto** para alternar entre os rostos; o seletor **Alvo** troca para **Cabeça e ombros**. Ajuste fino: arraste a foto ou use Zoom e Pan X/Y.
3. Configure a geometria do tear: **Circular**, **Quadrado**, **Retangular** ou importe um **CSV de pinos**. O padrão é um aro de bicicleta 28″ (622 mm) com 200 pinos e fio de 0,18 mm.
4. Baixe antecipadamente o **Gabarito de furação** (PDF multi-folhas em escala real 1:1 com marcas de registro e régua de conferência, ou SVG) e o **CSV de pinos** para fabricar sua moldura física.
5. Opcional: **Realce de feições** (olhos, sobrancelhas, boca) e **Pele mais limpa** — desligados por padrão; compare os níveis com a vista à distância.
6. Clique em **Gerar padrão** e acompanhe a simulação ao vivo com métricas em tempo real: **RMSE**, **$\Delta E$ (CIELAB)**, **SSIM** e a tabela de **estimativa de carretéis**.
7. Ao terminar, a simulação muda para a **Vista à distância**: o desfoque equivale à acuidade visual humana na distância escolhida (1–6 m, padrão 3 m) e a foto enquadrada aparece ao lado com o mesmo desfoque — é assim que a obra será vista na parede. **Fios (tamanho real)** volta a mostrar cada fio.
8. Exporte arquivos completos (incluindo **G-code** para robôs de tecelagem), ou abra o **Modo tecelagem**:
   - O próximo pino aparece em destaque com o sentido correto de contorno;
   - O número pode ser **ditado por voz** (pt-BR);
   - Acompanhe o **tempo restante estimado** dinamicamente;
   - **Sincronize com outro dispositivo sem servidor**: copie o código compacto (`WA1-...`), compartilhe o link direto (`#progress=...`) ou baixe o arquivo de retomada.

## Presets do estúdio

| Preset                              | Fios           | Pinos | Cordas | Destaques                                                               |
| ----------------------------------- | -------------- | ----- | ------ | ----------------------------------------------------------------------- |
| Vrellis Clássico — Monocromático    | 1 (Preto)      | 200   | 6.000  | **Recomendado para se reconhecer no retrato**: guloso exato, fio opaco. |
| Retrato Vrellis — Alta Fidelidade   | 4 (C, M, Y, K) | 288   | 6.500  | CMYK em épocas coarse-to-fine; preto por último.                        |
| CMYK — Histerese Dinâmica de Trocas | 4 (C, M, Y, K) | 288   | 6.000  | Penalidade de troca de carretel por histerese (menos nós).              |
| Otimização Global — NNLS / Radon    | 1 (Preto)      | 200   | 5.000  | Solver global FISTA (experimental).                                     |

Todos usam o aro 28″ (622 mm), fio 0,18 mm, pino de 2 mm e resolução de simulação de 500 px.

## Parâmetros padrão (medidos com fotos reais)

| Parâmetro                 | Valor                         | Origem / evidência                                                                             |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Diâmetro do tear          | 622 mm (aro de bicicleta 28″) | aro ISO 622 / 700C — fácil de conseguir em casa                                                |
| Pinos                     | 200                           | Vrellis; 288 pinos deram só +0,015 de SSIM com 44% mais furos                                  |
| Linhas (mono)             | até 6.000                     | fotos escuras: SSIM 0,66→0,74 (noite) e 0,71→0,79 (igreja); fotos claras param sozinhas ~4.100 |
| Largura do fio            | 0,18 mm                       | 0,15 mm foi pior em todas as fotos do benchmark                                                |
| Enquadramento             | rosto preenchendo 95% do aro  | 80% deixa o rosto pequeno; 105% corta o queixo                                                 |
| Foco facial (importância) | 2,0                           | benchmark Vênus + retratos do usuário                                                          |
| Realce de feições / pele  | 0 (desligados)                | diferença visual mínima e correlação levemente pior — disponíveis para escolha visual          |
| CLAHE / bordas            | desligados                    | CLAHE 2.0 reduziu a correlação de 0,935 para 0,912 na Vênus                                    |
| Repetições por par        | 2                             | necessário para metas ≥ 5.000 cordas                                                           |
| Refinamento global        | 0 passes                      | sem ganho mensurável, 2–4× mais lento (disponível no `weaver-cli bench --refine`)              |

> [!TIP]
>
> - **Para se reconhecer**: use uma foto de frente, com o rosto bem iluminado e sem inclinação. Avalie sempre pela **Vista à distância** ao lado da foto — de perto, toda string art parece só um emaranhado de fios.
> - **Fotos escuras (noite, ambientes internos)**: mantenha as 6.000 linhas; com menos cordas a obra fica mais clara que a foto.
> - **Metas altas de cordas (ex: 10.000 cordas)**: aumente **Repetições** para `2` ou `3`. Um tear de 200 pinos possui limite combinatório de cordas que cruzam a figura; permitir repetições viabiliza atingir 10.000 cordas mantendo o fundo limpo.
> - **Fabricação física**: gere o gabarito PDF multi-folhas e imprima em 100% (sem ajuste de página). Confira com uma régua se os 50 mm marcados em cada folha batem exatamente antes de furar.

### Benchmark com fotos reais (`weaver-cli`)

Toda mudança de qualidade é medida com o binário Rust nativo, sobre fotos reais:

```bash
cargo build --release -p weaver-cli
./target/release/weaver-cli bench --image bench/fixtures/venus_botticelli_face.png --out bench-out --label venus
./target/release/weaver-cli bench --image samples/private/minha_foto.jpg --framing face --lines 6000 --out bench-out --label eu
./target/release/weaver-cli contact --out bench-out/folha.png --size 320 --cols 4 bench-out/*_canvas.png
```

`bench` enquadra pelo rosto (`--framing face|head|manual`, `--fill`), gera, e imprime SSIM/correlação "à distância" contra a foto enquadrada e **ROSTO SSIM/RMSE** (só a região do rosto detectado). `contact` monta uma folha de contato para comparar variantes lado a lado. Coloque suas fotos em `samples/private/` (ignorada pelo git).

## Scripts

| Comando                           | O que faz                                                      |
| --------------------------------- | -------------------------------------------------------------- |
| `npm run dev`                     | estúdio web com hot reload                                     |
| `npm run build`                   | compila core, wasm, CLI e web                                  |
| `npm run build:wasm`              | compila o kernel Rust para WASM e regenera o binário em Base64 |
| `npm run bench`                   | executa a suíte de benchmarks de desempenho                    |
| `npm test`                        | testes unitários (Vitest)                                      |
| `npm run typecheck`               | checagem de tipos em todos os pacotes                          |
| `npm run lint` / `npm run format` | ESLint / Prettier                                              |
| `npm run check`                   | tudo acima (o mesmo que a CI)                                  |

## Documentação

- [docs/ALGORITHM.md](docs/ALGORITHM.md) — modelo físico e matemático
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — pacotes, fluxo de dados e decisões
- [docs/REFERENCES.md](docs/REFERENCES.md) — fontes, o que se sabe da obra de Vrellis e o que veio de cada projeto
- [docs/ROADMAP.md](docs/ROADMAP.md) — próximos passos
- [CONTRIBUTING.md](CONTRIBUTING.md) — como contribuir

## Créditos e licença

Código sob licença [MIT](LICENSE). Este é um projeto independente de estudo e homenagem:
**não é afiliado a Petros Vrellis**. As obras “A new way to knit” e os retratos tecidos são do
artista. Os projetos Weaver (Aly Yousuf) e weaving_algorithm (Marginally Clever Robots) serviram
de inspiração conceitual; nenhum código foi copiado deles.
