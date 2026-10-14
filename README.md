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
|                     | Implementações clássicas              | Weaver Art                                                                                                                                                                                               |
| ------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unidades            | pixels                                | **milímetros** (tear circular de 28″ = 711,2 mm, ou retangular/personalizado com dimensões reais)                                                                                                        |
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
npm run weave -- foto.jpg                                                    # preset Vrellis monocromático
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
2. Configure a geometria do tear: **Circular**, **Quadrado**, **Retangular** ou importe um **CSV de pinos**.
3. Baixe antecipadamente o **Gabarito de furação** (PDF multi-folhas em escala real 1:1 com marcas de registro e régua de conferência, ou SVG) e o **CSV de pinos** para fabricar sua moldura física.
4. Ajuste algoritmo e tom (incluindo **CLAHE**, **Penalidade de comprimento de fio** e **Distância de observação**).
5. Opcionalmente extraia uma **paleta personalizada** diretamente da foto ($k$ cores em CIELAB) ou calibre a cor de carretéis reais carregando a foto de uma meada de linha.
6. Experimente a **Mistura óptica por meio-tom** para permitir cooperação e fusão perceptual de cores entre fios vizinhos.
7. Clique em **Gerar padrão** e acompanhe a simulação ao vivo com métricas completas em tempo real: **RMSE**, **$\Delta E$ (CIELAB)**, **SSIM** e a tabela detalhada de **estimativa de carretéis**.
8. Exporte arquivos completos (incluindo **G-code** para robôs de tecelagem), ou abra o **Modo tecelagem**:
   - O próximo pino aparece em destaque com o sentido correto de contorno;
   - O número pode ser **ditado por voz** (pt-BR);
   - Acompanhe o **tempo restante estimado** dinamicamente;
   - **Sincronize com outro dispositivo sem servidor**: copie o código compacto (`WA1-...`), compartilhe o link direto (`#progress=...`) ou baixe o arquivo de retomada.

## Parâmetros padrão (preset `vrellis-mono`)

| Parâmetro               | Valor                     | Origem                                                                     |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------- |
| Diâmetro do tear        | 711,2 mm (28″)            | publicado por Vrellis                                                      |
| Pinos                   | 200                       | publicado por Vrellis                                                      |
| Linhas                  | até 4 000                 | Vrellis: 3 000 – 4 000 cordas, 1 – 2 km de fio                             |
| Diâmetro do pino        | 2 mm                      | estimativa — calibre com o seu tear                                        |
| Largura aparente do fio | 0,2 mm                    | estimativa — calibre com o seu fio                                         |
| Gap mínimo              | 12 pinos                  | evita cordas inúteis rente ao aro                                          |
| Repetições por par      | 1                         | uma passada por par de pinos                                               |
| Resolução da grade      | 400 px                    | resolução de simulação física (ver ALGORITHM.md)                           |
| Penalidade comp. fio    | 0.0                       | deságio de cordas longas (use 0.1 a 0.25 para economizar fio)              |
| Distância de observação | 0.0 m                     | desfoque retiniano à distância real (ex: 1.5 a 3.0 m, Birsak et al., 2018) |
| Meio-tom óptico         | desativado (0.75 mm)      | fusão espacial retiniana de cores adjacentes à distância                   |
| Refinamento global      | 0 passes                  | passes pós-gulosos para redução de erro mantendo continuidade              |
| Orçamento do cache      | 128 MB (CLI), 64 MB (web) | tamanho do `ChordCache` de rasterização de cordas canônicas                |
| Poda de candidatos      | `none` (exata)            | poda lazy greedy (`lazy`) para aceleração de até 5–10×                     |

> [!TIP]
>
> - **Aceleração Máxima e Desempenho**: utilize `--accel wasm --pruning lazy` para combinar o kernel Rust SIMD e a poda lazy de candidatos. Em computadores multi-core com imagens em alta resolução ($\ge 600$ px), utilize `--accel parallel --threads 4` para dividir a avaliação entre trabalhadores via memória compartilhada.
> - **Economia de fio e tensão mecânica**: utilize **Penalidade comp. fio** (`--length-penalty 0.15` a `0.25`) para priorizar cordas mais eficientes e aproximar a metragem total aos 1–2 km reportados por Petros Vrellis.
> - **Fotos escuras e roupas pretas**: utilize **Elevação de sombras** (`--shadow-lift 0.10` a `0.15`) para evitar que a roupa absorva a maior parte das linhas e suje o rosto.
> - **Foco nas feições**: utilize **Foco em detalhes** (`--edge-emphasis 0.40` a `0.60`) para realçar olhos, óculos, nariz e boca através de mapa de saliência Sobel.
> - **Iluminação irregular e retratos**: ative **CLAHE** (`--clahe --clahe-clip 2.0`) para equalizar contraste local adaptativo sem estourar ruído.
> - **Paleta personalizada da foto**: extraia $k$ cores dominantes da imagem (`--auto-palette <k>`) com amostragem restrita à máscara do tear, ordenação decrescente por luminância e cota reservada de 35%–40% para a âncora escura final.
> - **Fusão de cores e meio-tom**: ative **Meio-tom óptico** (`--halftone --halftone-radius 0.75`) para modelar como os olhos combinam cores primárias vizinhas à distância (ex: amarelo + ciano gerando verde sem exigir interseção local exata).
> - **Metas altas de cordas (ex: 10.000 cordas)**: aumente **Repetições** para `2` ou `3`. Um tear de 200 pinos possui limite combinatório de cordas que cruzam a figura; permitir repetições viabiliza atingir 10.000 cordas mantendo o fundo limpo.
> - **Máxima precisão**: ative **Refinamento global** (`--refine 1`) para executar passes pós-gulosos que trocam pinos intermediários mantendo estritamente o fio contínuo e sem emaranhados.
> - **Fabricação física**: gere o gabarito PDF multi-folhas com `weaver-art template` e imprima em 100% (sem ajuste de página). Confira com uma régua se os 50 mm marcados em cada folha batem exatamente antes de furar.

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
