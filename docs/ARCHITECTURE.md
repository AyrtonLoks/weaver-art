# Arquitetura

## Visão geral

```mermaid
flowchart LR
  photo["Foto (JPG/PNG)"] --> decode
  subgraph cli["@weaver-art/cli (Node)"]
    decode["sharp: decodifica + EXIF"]
  end
  subgraph web["@weaver-art/web (navegador)"]
    bitmap["createImageBitmap + canvas"] --> worker["Web Worker"]
  end
  photo --> bitmap
  decode --> core
  worker --> core
  subgraph core["@weaver-art/core (TypeScript puro)"]
    prep["image.ts + clahe.ts: alvo em luz linear"] --> engine["engine.ts: otimização gulosa"]
    geo["geometry.ts: pinos, tangentes, arcos"] --> engine
    ras["raster.ts: cobertura do fio"] --> engine
    engine --> refine["refine.ts: refinamento global"]
    engine --> metrics["metrics.ts: CIELAB ΔE e SSIM"]
    engine --> exp["export.ts: TXT / CSV / SVG / JSON"]
    calib["calibration.ts: calibração de cor e transmitância"]
  end
  exp --> files["Arquivos"]
  exp --> player["Modo tecelagem (voz)"]
```

## Pacotes

| Pacote             | Responsabilidade                                                            | Dependências de runtime              |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------ |
| `@weaver-art/core` | modelo físico, CLAHE, otimização, refinamento, métricas, calibração, export | **nenhuma**                          |
| `@weaver-art/cli`  | ler/gravar arquivos, decodificar imagens, calibração, progresso no terminal | `sharp`, core                        |
| `@weaver-art/web`  | UI, Web Worker, pré-visualização, modo tecelagem com voz, calibração        | core (via alias para o código-fonte) |

### Por que um core sem dependências?

O motor precisa rodar em três lugares: no **Node** (CLI, testes), no **navegador** (dentro de um
Web Worker) e, no futuro, em WebAssembly/GPU. Ele só conhece `RasterImage` (RGBA8 — compatível com
`ImageData` e com a saída crua do `sharp`) e `Float32Array`. Nada de DOM, `fs` ou `Buffer`.

### Por que TypeScript?

- Um único código para web (sem instalação para quem vai tecer) e linha de comando.
- Desempenho suficiente: ≈ 2 bilhões de operações por padrão rodam em segundos com typed arrays.
- O original de Vrellis é C++/openFrameworks e as referências abertas são Processing (Java); a
  separação core/app permite portar o núcleo para Rust/WASM se for necessário mais desempenho.

## Fluxo de dados

1. **Entrada** → `RasterImage` (RGBA8, sRGB).
2. `prepareTarget()` → `TargetImage` (`S×S`, 1 ou 3 canais em luz linear, máscara, pesos com suporte a CLAHE adaptativo, `shadowLift`, desfoque retiniano por distância de observação e mapa de saliência Sobel `edgeEmphasis`).
3. `WeaveEngine` mantém `canvas` (simulação), estado de cada fio, uso de pares de pinos e gestão de cotas por camada/fio.
   - `step()` aplica a estratégia configurada (`layered`, `interleaved-balanced` ou `free`), penalidade opcional por comprimento de fio (`lengthPenalty`), transição automática entre camadas e rollover de saldo para o preto final.
   - `runChunk(n)` permite execução cooperativa (o Worker cede o event loop entre blocos para
     poder receber `stop`).
4. **Refinamento Global Opcional** → `refineWeave()` executa passes de perturbação de nós intermediários ($p_{i-1} \to p_i' \to p_{i+1}$) reduzindo o erro residual sem violar a continuidade do fio.
5. `result()` → `WeaveResult` contendo métricas completas calculadas por `evaluateQuality()` em `metrics.ts`: RMSE linear, erro de cor em CIELAB ($\Delta E_{ab}^*$) e similaridade estrutural (SSIM).
6. `export.ts` transforma o resultado em instruções (`.txt` agrupado por camada), CSV e SVG (`<g id="layer-...">`); `threadPath()` reconstrói a
   geometria física (segmentos + arcos) a partir dos passos.

## Convenções

- **Unidades:** grandezas físicas em mm; quantidades da grade com sufixo `Px`.
- **Pinos:** índice 0-based no código/JSON; exibidos a partir de 1 nas instruções e na UI.
- **Lados:** `+1` anti-horário, `−1` horário (vistos de frente).
- **Cores:** `#rrggbb` sRGB na configuração; luz linear dentro do motor.
- **Idioma:** documentação e textos de interface em português; identificadores e comentários de
  código em inglês.

## Testes

Vitest roda os testes de `packages/*/test` com imagens sintéticas (sem binários no repositório):

- invariantes geométricas (tangência exata, arcos, distância circular);
- conservação de área na rasterização;
- motor: erro decrescente, continuidade do fio, restrições de pinos, contabilidade do comprimento,
  múltiplos fios;
- exportadores.
