# Arquitetura

## Visão geral

```mermaid
flowchart LR
  photo["Foto (JPG/PNG)"] --> decode
  csvIn["CSV de Pinos"] --> pegsCsv["pegs-csv.ts"]
  subgraph cli["@weaver-art/cli (Node)"]
    decode["sharp: decodifica + EXIF"]
  end
  subgraph web["@weaver-art/web (navegador)"]
    bitmap["createImageBitmap + canvas"] --> worker["Web Worker"]
  end
  photo --> bitmap
  decode --> core
  worker --> core
  pegsCsv --> geo
  subgraph core["@weaver-art/core (TypeScript puro)"]
    prep["image.ts + clahe.ts: alvo em luz linear"] --> engine["engine.ts: otimização gulosa + meio-tom"]
    geo["geometry.ts: formas de tear, convex hull, pinos, tangentes, arcos"] --> engine
    ras["raster.ts: cobertura do fio"] --> engine
    cache["chord-cache.ts: cache canônico LRU"] --> engine
    prune["pruning.ts: poda gulosa preguiçosa (Minoux)"] --> engine
    eval["evaluator.ts: JsEvaluator / CandidateEvaluator"] --> engine
    par["parallel.ts: ParallelEvaluator (SharedArrayBuffer + Atomics)"] --> engine
    engine --> refine["refine.ts: refinamento global"]
    engine --> metrics["metrics.ts: CIELAB ΔE e SSIM"]
    engine --> exp["export.ts: TXT / CSV / SVG / JSON"]
    calib["calibration.ts: calibração de cor e transmitância"]
    pal["palette.ts: clusterização CIELAB k-means++"]
    tmpl["template.ts + pdf.ts: gabarito 1:1 SVG/PDF multi-página"]
    geo --> tmpl
    est["estimate.ts: estimativa de tempo e bobinas"]
    gc["gcode.ts: comandos RS-274 para robôs XY"]
    prog["progress.ts: fingerprint, códigos WA1 e merge"]
    exp --> est
    exp --> gc
    exp --> prog
  end
  subgraph wasm["@weaver-art/wasm (Rust SIMD)"]
    rust["lib.rs: score_chord, samples_canonical, best_for_thread"] --> wasmEval["WasmEvaluator"]
  end
  wasmEval -.-> engine
  exp --> files["Arquivos"]
  tmpl --> files
  gc --> files
  exp --> player["Modo tecelagem (voz + tempo + sync)"]
```

## Pacotes

| Pacote             | Responsabilidade                                                                                                   | Dependências de runtime                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `@weaver-art/core` | modelo físico, CLAHE, meio-tom, otimização, refinamento, métricas, calibração, gabarito PDF/SVG, G-code, progresso | **nenhuma**                            |
| `@weaver-art/wasm` | kernel computacional SIMD em Rust compilado para WebAssembly (`f32x4`), com fallback TS e paridade bit a bit       | **nenhuma** (bytecode base64 embutido) |
| `@weaver-art/cli`  | ler/gravar arquivos, decodificar imagens, calibração, subcomandos template/gcode/estimate, progresso no terminal   | `sharp`, core, wasm                    |
| `@weaver-art/web`  | UI, Web Workers, pré-visualização, modo tecelagem com voz, gabaritos de fabricação e sincronização                 | core, wasm                             |

### Por que um core sem dependências?

O motor precisa rodar em três lugares: no **Node** (CLI, testes), no **navegador** (dentro de um
Web Worker) e em WebAssembly/threads. Ele só conhece `RasterImage` (RGBA8 — compatível com
`ImageData` e com a saída crua do `sharp`) e `Float32Array`. Até mesmo o gerador de arquivos PDF vetoriais em escala 1:1 (`pdf.ts`) é implementado do zero em TypeScript puro sem nenhuma biblioteca externa (`pdfkit`, etc.). Nada de DOM, `fs` ou `Buffer`.

O pacote `@weaver-art/wasm` complementa o core fornecendo aceleração SIMD nativa de baixo nível sem violar essa pureza: o binário WASM é pré-compilado e embutido como string Base64 decodificada em tempo de inicialização, operando diretamente sobre typed arrays em memória linear.

### Por que TypeScript e Rust/WASM?

- **TypeScript puro** no core para portabilidade universal instantânea, sem necessidade de toolchain ou etapas de compilação nativa para quem vai tecer no navegador ou usar a API.
- **Rust/WASM SIMD** (`@weaver-art/wasm`) para aceleração extrema de hardware (vetorização de 128 bits via `core::arch::wasm32::*`), processando até 4 pixels simultaneamente no cálculo de ganho e amostragem antisserrilhada com **paridade numérica exata bit a bit** em relação ao TypeScript.
- **Paralelismo multi-worker** (`parallel.ts`) coordenado via memória compartilhada (`SharedArrayBuffer`) e sincronização de barreira sem travamento (`Atomics`), dividindo o espaço de candidatos entre múltiplos núcleos lógicos de CPU.

## Camada de Avaliação e Desempenho

O motor desacopla a busca de cordas através da interface `CandidateEvaluator`:

1. **`JsEvaluator`**: Implementação pura de referência em TypeScript, com buffers estáticos reutilizados para evitar alocações de GC durante o loop de tecelagem.
2. **`WasmEvaluator`**: Instância do kernel WebAssembly compilado a partir de Rust `no_std`, executando vetorização `f32x4` e busca do melhor candidato diretamente em memória linear.
3. **`ParallelEvaluator`**: Distribui blocos contíguos de pinos candidatos para $N$ workers (Web Workers no navegador ou `worker_threads` no Node.js) via `SharedArrayBuffer` estruturado, utilizando desempate determinístico (maior ganho líquido seguido de menor índice de pino).
4. **`ChordCache`**: Cache LRU de amostras canônicas com chave de 64 bits baseada na orientação física das tangentes ($A \le B$). O teto de memória é parametrizável (ex.: 128 MB no CLI, 64 MB na web) e limpa automaticamente entradas antigas sem afetar a fidelidade visual.
5. **`StaleGainTable` (Poda Gulosa de Minoux)**: Algoritmo acelerado para funções submodulares (Minoux, 1978). Mantém os ganhos calculados em passos anteriores e reavalia candidatos sob demanda na ordem do limite superior de ganho, alcançando acelerações de até 4–5× mantendo exatidão matemática estrita em simulações monocromáticas e $\Delta\text{RMSE}/\Delta\text{SSIM} \le 2\%$ em cores/meio-tom.

## Fluxo de dados

1. **Configuração de Geometria** → `LoomConfig` (`CircleLoomConfig | RectangleLoomConfig | CustomLoomConfig`).
   - `createLoom()` calcula posições físicas dos pinos em mm, envoltória convexa (`convexHull`), normais externas para rótulos legíveis e a máscara de cordas admissíveis (`chordMask`), eliminando cordas que coincidam com a mesma aresta do quadro.
   - Pinos arbitrários podem ser importados ou exportados via `parsePegsCSV` e `toPegsCSV`.
2. **Entrada de Imagem** → `RasterImage` (RGBA8, sRGB).
3. `prepareTarget()` → `TargetImage` (`S×S`, 1 ou 3 canais em luz linear, máscara de enquadramento `loomFrameCrop` + `loomMask`, pesos com suporte a CLAHE adaptativo, `shadowLift`, desfoque retiniano por distância de observação e mapa de saliência Sobel `edgeEmphasis`).
4. `WeaveEngine` mantém `canvas` (simulação), mapa de resíduo de meio-tom óptico $R_{\text{halftone}} = G * (T - C)$ (quando ativado), estado de cada fio, uso de pares de pinos e gestão de cotas por camada/fio.
   - `step()` consulta o avaliador configurado (`JsEvaluator`, `WasmEvaluator` ou `ParallelEvaluator`), aplica a estratégia (`layered`, `interleaved-balanced` ou `free`), penalidade opcional por comprimento de fio (`lengthPenalty`), transição automática entre camadas e rollover de saldo para o preto final.
   - `runChunk(n)` permite execução cooperativa (o Worker cede o event loop entre blocos para
     poder receber `stop`).
5. **Refinamento Global Opcional** → `refineWeave()` executa passes de perturbação de nós intermediários ($p_{i-1} \to p_i' \to p_{i+1}$) reduzindo o erro residual sem violar a continuidade do fio nem as restrições da geometria.
6. `result()` → `WeaveResult` contendo métricas completas calculadas por `calculateMetrics()` em `metrics.ts`: RMSE linear, erro de cor em CIELAB ($\Delta E_{ab}^*$) e similaridade estrutural (SSIM).
7. **Exportação e Fabricação**:
   - `export.ts`: instruções (`.txt` com bloco de estimativa e agrupamento por camada), CSV detalhado e SVG vetorial 1:1 (`<g id="layer-...">`).
   - `template.ts` & `pdf.ts`: gabarito físico de furação 1:1 em SVG e PDF multi-páginas ladrilhadas para montagem com marcas de registro em cruz e réguas de validação milimétrica.
   - `estimate.ts`: estimativa de tempo ativo de tecelagem, amarração inicial, trocas e cálculo de bobinas de meada por cor com margem de segurança.
   - `gcode.ts`: geração de percursos de máquina (RS-274) para robôs ou plotters CNC de eixos XY com folga radial de pino (`toolRadius`), arcos `G2`/`G3` e pausas `M0` para troca de fio.
   - `progress.ts`: persistência, geração de códigos curtos com checksum (`WA1-...`) e reconciliação pelo timestamp mais recente (`mergeProgress`).

## Convenções

- **Unidades:** grandezas físicas em mm; quantidades da grade com sufixo `Px`.
- **Pinos:** índice 0-based no código/JSON; exibidos a partir de 1 nas instruções e na UI.
- **Lados:** `+1` anti-horário, `−1` horário (vistos de frente).
- **Cores:** `#rrggbb` sRGB na configuração; luz linear dentro do motor.
- **Idioma:** documentação e textos de interface em português; identificadores e comentários de
  código em inglês.

## Testes

Vitest roda os testes de `packages/*/test` com imagens sintéticas (sem binários no repositório):

- invariantes geométricas (tangência exata, arcos, distância circular, polígonos convexos e detecção de bordas retangulares);
- conservação de área na rasterização e canonicalização de segmentos;
- paridade numérica exata bit a bit entre o avaliador TypeScript e o kernel WebAssembly SIMD (`parity.test.ts`);
- consistência e invariantes da poda gulosa preguiçosa de Minoux (`pruning.test.ts`);
- sincronização paralela multi-thread sem travamento com desempate determinístico (`parallel.test.ts`);
- gerenciamento de limite de memória e conformidade LRU do cache de cordas (`chord-cache.test.ts`);
- motor: erro decrescente, continuidade do fio, restrições de pinos, contabilidade do comprimento,
  múltiplos fios e modelo de meio-tom óptico;
- exportadores: SVG, CSV, JSON, TXT, gerador PDF 1.4 com offsets xref válidos, gabaritos de furação e G-code;
- parsers e sincronização: importação/exportação CSV de pinos, códigos curtos de progresso e reconciliação.
