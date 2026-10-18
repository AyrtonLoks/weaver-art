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

|                     | Implementações clássicas              | Weaver Art                                                                                                                                                             |
| ------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unidades            | pixels                                | **milímetros** (padrão: aro de bicicleta 28″ ISO 622 = 622 mm, ou retangular/personalizado com dimensões reais)                                                        |
| Enquadramento       | manual                                | **detecção de rosto Viola-Jones** (Rust puro) — o rosto preenche ~95% do aro automaticamente ao carregar a foto                                                        |
| Formato do tear     | apenas círculo fixo                   | **circular (padrão Petros Vrellis) ou quadrado** com cálculo analítico de tangentes físicas e normais perpendiculares                                                  |
| Critério de escolha | “linha mais escura” (média de pixels) | **redução exata do erro perceptual** entre simulação e alvo em luz linear                                                                                              |
| Modelo de tom       | subtrai constante do alvo             | **cobertura física do fio** em luz linear: `T = Π(1 − cᵢ)` — o tom escurece com a densidade **e com as interseções**, como descrito por Vrellis                        |
| Espaço de cor       | sRGB (gama)                           | **luz linear** (sRGB ↔ linear correto)                                                                                                                                 |
| Rasterização        | Bresenham / Wu                        | **cobertura exata de área** de um fio com largura real (sub-pixel Xiaolin Wu em matriz CSR compacta)                                                                   |
| Pinos               | pontos                                | **cilindros com diâmetro**: segmentos tangentes, sentido de contorno (horário/anti-horário) e arco enrolado no pino                                                    |
| Comprimento do fio  | estimado                              | **exato** (segmentos + arcos nos pinos)                                                                                                                                |
| Cor                 | camadas separadas                     | **camadas sequenciais (`layered`)** com cotas ponderadas e âncora escura no preto final (preset `Vrellis Colorido (CMYK)`: Y → M → C → K)                              |
| Percepção           | pixel a pixel local                   | **função objetivo limpa**, **distância de observação** (desfoque retiniano por acuidade visual ~2′), e **métricas CIELAB ΔE, RMSE e SSIM**                             |
| Otimização          | apenas gulosa                         | **guloso iterativo exato (Vrellis)** com avaliação óptica precisa em luz linear e passe opcional de refinamento                                                        |
| Desempenho          | laço único JS sem cache               | **núcleo Rust puro (WASM)**, **matriz CSR compacta (RNF-03)** e **comunicação zero-copy (SharedArrayBuffer + Atomics)**                                                |
| Calibração          | manual empírica                       | **ferramenta de calibração** de cor e parâmetros físicos a partir de fotos de meadas                                                                                   |
| Fabricação          | nenhuma                               | **gabaritos de furação 1:1** (SVG e PDF multi-folhas com cruzetas de registro e régua), **estimativa BOM/tempo**, **G-code CNC (G81/G83)** e **retomada sem servidor** |
| Saída               | lista de pinos                        | instruções `.txt` agrupadas por camada com estimativa, `.csv`, `.json`, **SVG 1:1**, PDF 1:1, G-code e **modo tecelagem com voz e sincronização**                      |

Detalhes matemáticos em [docs/ALGORITHM.md](docs/ALGORITHM.md).

## Estrutura

```
weaver-art/
├── packages/
│   └── core/    @weaver-art/core — geometria, gabaritos CAD (PDF/SVG/CSV), estimativa e codec de progresso (TypeScript puro)
├── crates/      workspace Rust puro (weaver-domain, weaver-dsp, weaver-solvers, weaver-cam, weaver-wasm-adapter, weaver-cli)
├── apps/
│   └── web/     @weaver-art/web  — estúdio no navegador (Vite + Web Worker + WebGL2/Canvas2D) e modo tecelagem com sincronização
└── docs/        arquitetura, algoritmo, referências e roadmap
```

## Começando

Requisitos: **Node.js ≥ 22.12** e **Rust estável** (`cargo`).

```bash
npm install
npm test                 # testes unitários (Vitest)
cargo test --workspace   # testes unitários e de integração Rust
npm run dev              # estúdio web em http://localhost:5173
```

### Linha de comando nativa (Rust)

O binário nativo de alta performance para benchmarks e contact sheets fica em `crates/weaver-cli`:

```bash
cargo run --release -p weaver-cli -- bench           # benchmark sobre fotos reais
cargo run --release -p weaver-cli -- contact         # folha de contato comparativa
```

> [!TIP]
> **Tecelagem Multicolorida em Camadas (Vrellis CMYK)**:
> No preset colorido, a tecelagem ocorre em camadas físicas sequenciais (`layered`). As cores claras constroem a base luminosa primeiro (Amarelo → Magenta → Ciano) e o **fio preto entra por último**, definindo sombras e contraste sem apagar as cores de baixo.

### Estúdio web

1. Arraste uma foto (retratos funcionam melhor — como na série de Vrellis baseada em El Greco).
2. **Enquadramento automático pelo rosto**: ao carregar a foto, o detector de rostos (Viola-Jones, em Rust/Wasm) ajusta zoom e posição para o rosto preencher ~95% do aro. Ajuste fino: arraste a foto ou use Zoom e Pan X/Y.
3. Configure a geometria do tear: **Circular** (Petros Vrellis) ou **Quadrado**. O padrão é um aro de bicicleta 28″ (622 mm) com 200 pinos e fio de 0,18 mm.
4. Baixe antecipadamente o **Gabarito de furação** (PDF multi-folhas em escala real 1:1 com marcas de registro e régua de conferência, ou SVG) e o **CSV de pinos** para fabricar sua moldura física.
5. Clique em **Gerar padrão** e acompanhe a simulação ao vivo com métricas em tempo real: **RMSE**, **$\Delta E$ (CIELAB)**, **SSIM** e a tabela de **estimativa de carretéis**.
6. Use os novos controles de **Zoom e Pan da simulação** (`+`, `−`, `Ajustar`) para navegar nos detalhes dos fios.
7. Alterne entre **Fios (tamanho real)** e **Vista à distância** (desfoque equivalente à visão humana a 1–6 m), ou marque **Comparar com a foto** para validação lado a lado.
8. Exporte arquivos completos (incluindo **G-code** para robôs de tecelagem), ou abra o **Modo tecelagem** passo a passo.

## Presets do estúdio

| Preset                           | Fios                               | Pinos | Cordas | Destaques                                                                             |
| -------------------------------- | ---------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------- |
| Vrellis Clássico — Monocromático | 1 (Preto)                          | 200   | 6.000  | **Recomendado para se reconhecer no retrato**: guloso exato em luz linear, fio opaco. |
| Vrellis Colorido (CMYK)          | 4 (Amarelo, Magenta, Ciano, Preto) | 200   | 6.000  | Paleta subtrativa CMYK em camadas sequenciais (Y → M → C → K).                        |

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

| Comando                           | O que faz                                                     |
| --------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                     | estúdio web com hot reload                                    |
| `npm run build`                   | compila adapter wasm, pacotes core e web                      |
| `npm run build:wasm`              | compila o adapter Rust (weaver-wasm-adapter) para WebAssembly |
| `npm test`                        | testes unitários (Vitest)                                     |
| `npm run typecheck`               | checagem de tipos em todos os pacotes                         |
| `npm run lint` / `npm run format` | ESLint / Prettier                                             |
| `npm run check`                   | tudo acima (o mesmo que a CI)                                 |

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
