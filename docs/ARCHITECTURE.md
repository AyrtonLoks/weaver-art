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
    prep["image.ts: alvo em luz linear"] --> engine["engine.ts: otimização gulosa"]
    geo["geometry.ts: pinos, tangentes, arcos"] --> engine
    ras["raster.ts: cobertura do fio"] --> engine
    engine --> exp["export.ts: TXT / CSV / SVG / JSON"]
  end
  exp --> files["Arquivos"]
  exp --> player["Modo tecelagem (voz)"]
```

## Pacotes

| Pacote             | Responsabilidade                                                | Dependências de runtime              |
| ------------------ | --------------------------------------------------------------- | ------------------------------------ |
| `@weaver-art/core` | modelo físico, preparo da imagem, otimização, exportação        | **nenhuma**                          |
| `@weaver-art/cli`  | ler/gravar arquivos, decodificar imagens, progresso no terminal | `sharp`, core                        |
| `@weaver-art/web`  | UI, Web Worker, pré-visualização, modo tecelagem                | core (via alias para o código-fonte) |

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
2. `prepareTarget()` → `TargetImage` (`S×S`, 1 ou 3 canais em luz linear, máscara, pesos).
3. `WeaveEngine` mantém `canvas` (simulação), estado de cada fio e uso de cada par de pinos.
   - `step()` avalia todas as cordas admissíveis, aplica a melhor e registra um `WeaveStep`.
   - `runChunk(n)` permite execução cooperativa (o Worker cede o event loop entre blocos para
     poder receber `stop`).
4. `result()` → `WeaveResult` (JSON serializável, versionado com `version: 1`).
5. `export.ts` transforma o resultado em instruções, CSV e SVG; `threadPath()` reconstrói a
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
