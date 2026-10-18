# Como contribuir

Obrigado pelo interesse! Este guia resume o fluxo de trabalho.

## Ambiente

- Node.js **≥ 22.12** (`.nvmrc`). Verifique com `node --version` **e** `npm exec -c "node --version"`
  — se o npm estiver usando outro Node mais antigo, dependências nativas (rolldown, sharp) podem não
  ser instaladas.
- `npm install` na raiz instala todos os workspaces.
- **Rust Toolchain**: Rust 2021 edition (`cargo`, `wasm-pack`). O workspace Rust reside em `crates/`. Para compilar o adaptador Wasm, use `npm run build:wasm`.
- `npm install` na raiz instala as dependências dos workspaces.

## Fluxo

1. Crie um branch a partir de `main`: `feat/…`, `fix/…`, `docs/…`.
2. Faça commits pequenos seguindo [Conventional Commits](https://www.conventionalcommits.org/pt-br/):
   `feat(domain): …`, `feat(solvers): …`, `fix(web): …`, `docs: …`, `test: …`, `chore: …`.
3. Rode a checagem completa antes de abrir o PR:
   ```powershell
   cargo test --workspace
   npm run check
   npm run build
   ```
4. Para alterações no motor de tecelagem, execute `cargo run --release -p weaver-cli -- bench` para verificar ausência de regressões e qualidade perceptual.
5. Descreva no PR **o efeito visual** da mudança quando ela tocar o algoritmo — de preferência com métricas de SSIM e correlação à distância.

## Onde mexer

| Quero…                                                  | Arquivo / Crate                      |
| :------------------------------------------------------ | :----------------------------------- |
| mudar a geometria do tear / pinos / tangentes           | `crates/weaver-domain/src/geometry/` |
| mudar o modelo de cor, métricas ou CSR                  | `crates/weaver-domain/src/`          |
| mudar o preparo da foto, auto-enquadramento ou DSP      | `crates/weaver-dsp/src/`             |
| mudar o motor guloso, Beam Search ou refinamento        | `crates/weaver-solvers/src/`         |
| mexer no gabarito CAM, PDF 1.4, CSV, BOM ou G-Code      | `crates/weaver-cam/src/`             |
| mudar a ponte WebAssembly e memória compartilhada       | `crates/weaver-wasm-adapter/src/`    |
| adicionar ou modificar comandos no CLI nativo           | `crates/weaver-cli/src/`             |
| helpers TypeScript de gabaritos, CSV e BOM              | `packages/core/src/`                 |
| mexer na interface, WebGL2, Studio, Blueprint ou Player | `apps/web/src/`                      |

## Princípios

- **Fidelidade física primeiro**: grandezas em mm, luz linear, nada de "constantes mágicas" em
  pixels. Se um parâmetro é uma estimativa, documente-o como tal.
- **Core sem dependências** e sem APIs de plataforma (DOM, `fs`, `Buffer`).
- **Paridade Exata TS ↔ WASM**: o kernel WebAssembly SIMD deve produzir resultados matematicamente idênticos bit a bit à implementação pura em TypeScript.
- **Testes para invariantes**: toda mudança no motor deve manter (ou acrescentar) testes de
  continuidade do fio, restrições de pinos, redução de erro e concorrência sem travamentos.
- Documentação e interface em português; código e comentários em inglês.
