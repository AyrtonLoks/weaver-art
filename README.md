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

|                     | Implementações clássicas              | Weaver Art                                                                                                                                      |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Unidades            | pixels                                | **milímetros** (tear de 28″ = 711,2 mm, como o original)                                                                                        |
| Critério de escolha | “linha mais escura” (média de pixels) | **redução do erro quadrático** entre simulação e alvo (com penalidade de comprimento configurável)                                              |
| Modelo de tom       | subtrai constante do alvo             | **cobertura física do fio** em luz linear: `T = Π(1 − cᵢ)` — o tom escurece com a densidade **e com as interseções**, como descrito por Vrellis |
| Espaço de cor       | sRGB (gama)                           | **luz linear** (sRGB ↔ linear correto)                                                                                                          |
| Rasterização        | Bresenham / Wu                        | **cobertura exata de área** de um fio com largura real (sub-pixel)                                                                              |
| Pinos               | pontos                                | **cilindros com diâmetro**: segmentos tangentes, sentido de contorno (horário/anti-horário) e arco enrolado no pino                             |
| Comprimento do fio  | estimado                              | **exato** (segmentos + arcos), com **penalidade ajustável** para economia de linha                                                              |
| Cor                 | camadas separadas                     | **camadas sequenciais (`layered`) ou intercalado balanceado** com cotas ponderadas (presets `vrellis-color` e `cmyk`)                           |
| Percepção           | pixel a pixel local                   | **distância de observação** (desfoque retiniano, Birsak et al., 2018), CLAHE e **métricas CIELAB ΔE e SSIM**                                    |
| Otimização          | apenas gulosa                         | **gulosa + refinamento global pós-processamento** preservando a continuidade física estrita do fio                                              |
| Calibração          | manual empírica                       | **ferramenta de calibração** de cor e parâmetros físicos a partir de fotos de meadas                                                            |
| Saída               | lista de pinos                        | instruções `.txt` agrupadas por camada, `.csv`, `.json`, **SVG em escala real**, PNG e **modo tecelagem com voz**                               |

Detalhes matemáticos em [docs/ALGORITHM.md](docs/ALGORITHM.md).

## Estrutura

```
weaver-art/
├── packages/
│   ├── core/   @weaver-art/core — motor (TypeScript puro, sem dependências; roda no navegador e no Node)
│   └── cli/    @weaver-art/cli  — linha de comando (foto → JSON/TXT/CSV/SVG/PNG)
├── apps/
│   └── web/    @weaver-art/web  — estúdio no navegador (Vite + Web Worker) e modo tecelagem
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
npm run weave -- foto.jpg                                           # preset Vrellis monocromático
npm run weave -- foto.jpg --preset cmyk --lines 10000 --repeats 2   # preset CMYK em camadas (10.000 cordas)
npm run weave -- foto.jpg --preset vrellis-color --lines 6000 --shadow-lift 0.12 --edge-emphasis 0.5
npm run weave -- foto.jpg --clahe --length-penalty 0.15 --viewing-distance 2.0 --refine 1
npm run weave -- calibrate-color amostra-carretel.jpg               # calibra cor #hex a partir de foto
npm run weave -- --help
```

> [!TIP]
> **Tecelagem Multicolorida em Camadas**:
> Por padrão, presets coloridos utilizam `colorStrategy: 'layered'`. As cores constroem a base cromática luminosa primeiro e o **fio preto entra por último**, conferindo nitidez e contraste sem apagar as cores de baixo. Além disso, avaliar apenas o fio ativo torna a geração em camadas **4 a 5× mais rápida**.

Arquivos gerados em `./output/`:

| Arquivo           | Conteúdo                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `foto.weave.txt`  | instruções numeradas para tecer à mão (`0001   1 → 87 (horário)`) |
| `foto.weave.csv`  | uma linha por corda (pinos, lado, comprimento)                    |
| `foto.weave.json` | projeto completo (reabrível no modo tecelagem)                    |
| `foto.weave.svg`  | desenho vetorial em escala 1:1 (mm), com arcos nos pinos          |
| `foto.weave.png`  | simulação física do resultado                                     |
| `foto.target.png` | imagem-alvo após o preparo                                        |

### Estúdio web

1. Arraste uma foto (retratos funcionam melhor — como na série de Vrellis baseada em El Greco).
2. Ajuste tear, algoritmo e tom (incluindo **CLAHE**, **Penalidade de comprimento de fio** e **Distância de observação**).
3. Opcionalmente calibre a cor de carretéis reais carregando a foto de uma meada de linha.
4. Clique em **Gerar padrão** e acompanhe a simulação ao vivo com métricas completas em tempo real: **RMSE**, **$\Delta E$ (CIELAB)** e **SSIM**.
5. Exporte, ou abra o **Modo tecelagem**: o próximo pino aparece em destaque, a corda é
   desenhada no tear, e o número pode ser **ditado por voz** (pt-BR), avançando com a barra de
   espaço ou automaticamente. O progresso fica salvo no navegador.

## Parâmetros padrão (preset `vrellis-mono`)

| Parâmetro               | Valor          | Origem                                                                     |
| ----------------------- | -------------- | -------------------------------------------------------------------------- |
| Diâmetro do tear        | 711,2 mm (28″) | publicado por Vrellis                                                      |
| Pinos                   | 200            | publicado por Vrellis                                                      |
| Linhas                  | até 4 000      | Vrellis: 3 000 – 4 000 cordas, 1 – 2 km de fio                             |
| Diâmetro do pino        | 2 mm           | estimativa — calibre com o seu tear                                        |
| Largura aparente do fio | 0,2 mm         | estimativa — calibre com o seu fio                                         |
| Gap mínimo              | 12 pinos       | evita cordas inúteis rente ao aro                                          |
| Repetições por par      | 1              | uma passada por par de pinos                                               |
| Resolução da grade      | 400 px         | resolução de simulação física (ver ALGORITHM.md)                           |
| Penalidade comp. fio    | 0.0            | deságio de cordas longas (use 0.1 a 0.25 para economizar fio)              |
| Distância de observação | 0.0 m          | desfoque retiniano à distância real (ex: 1.5 a 3.0 m, Birsak et al., 2018) |
| Refinamento global      | 0 passes       | passes pós-gulosos para redução de erro mantendo continuidade              |

> [!TIP]
>
> - **Economia de fio e tensão mecânica**: utilize **Penalidade comp. fio** (`--length-penalty 0.15` a `0.25`) para priorizar cordas mais eficientes e aproximar a metragem total aos 1–2 km reportados por Petros Vrellis.
> - **Fotos escuras e roupas pretas**: utilize **Elevação de sombras** (`--shadow-lift 0.10` a `0.15`) para evitar que a roupa absorva a maior parte das linhas e suje o rosto.
> - **Foco nas feições**: utilize **Foco em detalhes** (`--edge-emphasis 0.40` a `0.60`) para realçar olhos, óculos, nariz e boca através de mapa de saliência Sobel.
> - **Iluminação irregular e retratos**: ative **CLAHE** (`--clahe --clahe-clip 2.0`) para equalizar contraste local adaptativo sem estourar ruído.
> - **Metas altas de cordas (ex: 10.000 cordas)**: aumente **Repetições** para `2` ou `3`. Um tear de 200 pinos possui limite combinatório de cordas que cruzam a figura; permitir repetições viabiliza atingir 10.000 cordas mantendo o fundo limpo.
> - **Máxima precisão**: ative **Refinamento global** (`--refine 1`) para executar passes pós-gulosos que trocam pinos intermediários mantendo estritamente o fio contínuo e sem emaranhados.

## Scripts

| Comando                           | O que faz                             |
| --------------------------------- | ------------------------------------- |
| `npm run dev`                     | estúdio web com hot reload            |
| `npm run build`                   | compila core, CLI e web               |
| `npm test`                        | testes unitários                      |
| `npm run typecheck`               | checagem de tipos em todos os pacotes |
| `npm run lint` / `npm run format` | ESLint / Prettier                     |
| `npm run check`                   | tudo acima (o mesmo que a CI)         |

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
