---
name: weaver-art-task-runner
description: >-
  Executa procedimentos de desenvolvimento, calibração, benchmarks visuais e testes
  no projeto Weaver Art. Use sempre que for modificar o algoritmo de tecelagem, rodar
  experimentos com fotos reais ou implementar tarefas do roadmap.
---

# Weaver Art Task Runner

Runbook para desenvolvimento e verificação no ecossistema Weaver Art.

## 1. Verificação Rápida de Ambiente

Certifique-se de que o Node.js em execução seja >= 22.12 e o Cargo esteja acessível:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo --version
node --version
```

Execute o checklist de qualidade completo (Rust Cargo Workspace + TypeScript/Vite):

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo check --workspace
cargo test --workspace
npm run check
npm run build
```

## 2. Roteiro para Alterações no Algoritmo Core e Kernel WASM

Ao alterar `packages/core/src` ou crates Rust em `crates/`:

1. Mantenha os testes existentes passando (`npx vitest run`).
2. Se editar código Rust em `crates/`:
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo test --workspace
   npm run build:wasm
   ```
3. Compile todos os workspaces e valide tipos/testes:
   ```powershell
   npm run check
   npm run build
   ```

## 3. Validação Visual e Benchmarks com o CLI Nativo (`weaver-cli`)

Para verificar se uma alteração melhorou ou piorou a qualidade visual:

1. Use uma imagem de referência de teste (ex.: `bench/fixtures/venus_botticelli_face.png` ou foto em `samples/private/`).
2. Execute o benchmark nativo em release salvando na pasta de saída:
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo run --release -p weaver-cli -- bench --image bench/fixtures/venus_botticelli_face.png --lines 6000 --out bench-out --label venus
   ```
3. Inspecione o PNG gerado (`bench-out/*_canvas.png`), o SSIM facial e a correlação à distância reportados.
4. Gere folhas de contato comparativas se necessário (`weaver-cli contact`).

## 4. Testes do App Web

Ao tocar em `apps/web`:

1. Verifique tipos:
   ```bash
   npm run typecheck --workspace @weaver-art/web
   ```
2. Teste o build de produção Vite:
   ```bash
   npm run build --workspace @weaver-art/web
   ```
3. Para validar interativamente, instrua o usuário a rodar `npm run dev`.

## 5. Testes de Isolamento Cross-Origin (COOP/COEP) e SharedArrayBuffer

Ao alterar `vite.config.ts`, workers ou a camada `core-bridge`:

1. Execute os testes automatizados de headers HTTP e CDP Chromium:
   ```bash
   npx vitest run apps/web/test/workspace-structure.test.ts
   ```
2. Valide que `window.crossOriginIsolated === true` e que `typeof SharedArrayBuffer === 'function'`.
3. Garanta que novos módulos em `apps/web/src/` sejam exportados ou referenciados no bundle de produção.

## 6. Testes dos Contratos de Domínio, Memória Compartilhada e Presets (Task 0.3)

Ao modificar `src/domain-contracts/`, `src/core-bridge/` ou `src/preset-engine/`:

1. Execute a suíte de testes unitários:
   ```bash
   npx vitest run apps/web/test/contracts-presets-memory.test.ts
   ```
2. Valide formatação Prettier e linter:
   ```bash
   npm run lint
   npm run format:check
   ```
3. Se houver discrepância de formatação nos novos arquivos TS, corrija com:
   ```bash
   npm run format
   ```

## 7. Testes das Vistas, CAM Blueprint e Multi-Estágio (Task 0.4)

Ao modificar `src/views/`, `src/preset-engine/` ou o enquadramento:

1. Execute a suíte de testes de diagnóstico mecânico e inspeção:
   ```bash
   npx vitest run apps/web/test/views-cam-studio.test.ts
   ```
2. Valide se as 3 vistas compilam sem erro de tipo:
   ```bash
   npx tsc -p apps/web/tsconfig.json --noEmit
   ```

## 8. Validação do Cache CSR de Cordas e Teto de Memória (Task 1.3 / RNF-03)

Ao alterar ou estender a estrutura de dados de cordas e motores de rasterização em `crates/weaver-domain`:

1. Execute o benchmark do cache CSR para tear de $N = 250$ pinos em resolução $600 \times 600$ px:
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo test -p weaver-domain test_memory_ceiling_rnf03 -- --nocapture
   ```
2. **Critério de Aprovação**:
   - Consumo estrito de memória heap $\le 130\text{ MB}$ (tolerância máxima de 135 MB em debug).
   - Tempo de construção do cache completo $< 1{,}0\text{ s}$ em modo unoptimized.
3. Valide o teste de integração com tear $N = 50$:
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo test -p weaver-domain integration_csr_matrix_test_loom_n50
   ```

## 9. Validação dos Motores de Otimização e Teste Sintético (Task 2.4)

Ao modificar os algoritmos de tecelagem em `crates/weaver-solvers`:

1. Execute os testes unitários dedicados aos motores (`greedy`, `beam_search`, `refine`) e `solver_runner`:
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo test -p weaver-solvers
   ```
2. Execute o teste de integração sintético ponta a ponta (DSP + Solvers):
   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo test -p weaver-wasm-adapter --test integration_sprint2_solvers -- --nocapture
   ```
3. **Critérios de Aprovação**:
   - Queda monotônica estrita do erro $\Delta E$ em todos os lotes de tecelagem.
   - Redução substancial de RMSE em relação ao estado inicial.
   - Zero alocações na heap durante o laço interno de avaliação de cordas.
   - Respeito integral às regras de Clean Architecture (`workspace-structure.test.ts`).

## 10. Validação do Modo Tecelagem, Voz TTS, Persistência e QR Code (Task 4.3)

Ao modificar os componentes em `apps/web/src/views/player-view/`:

1. **Executar a Suíte de Testes Dedicada**:

   ```powershell
   node ./node_modules/vitest/vitest.mjs run apps/web/test/sprint4-task4-3-player-view.test.ts
   ```

2. **Checagem de Tipagem TypeScript**:

   ```powershell
   node ./node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
   ```

3. **Invariantes para Mocks em Ambiente Vitest/Node**:
   - Em rotinas que agendam timers com fallback, utilize resolução segura:
     ```typescript
     const timerFn =
       typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window.setTimeout : setTimeout;
     ```
   - Ao disparar eventos sintéticos no mock de elementos HTML, faça cast para `Event`:
     ```typescript
     el.dispatchEvent({ type: 'change' } as unknown as Event);
     ```
   - Mocks de `speechSynthesis` devem implementar `speak: vi.fn()` e `cancel: vi.fn()`, e a classe `SpeechSynthesisUtterance` deve estar acessível tanto em `window` quanto em `globalThis`.

## 11. Verificação de Deploy Estático, Build Unificado e Cross-Origin Isolation (COOP/COEP) (Task 4.4)

Ao preparar releases ou testar a hospedagem estática online:

1. **Executar o Build Completo de Produção**:
   ```powershell
   npm run build
   ```
2. **Validar os Artefatos Gerados em `dist/`**:
   - Certifique-se de que `dist/` contém:
     - `index.html` (com injeção condicional de `coi-serviceworker.js`).
     - `coi-serviceworker.js`.
     - `_headers` (Cloudflare Pages / Netlify).
     - `assets/weaver_wasm_adapter_bg-*.wasm` (binário Wasm empacotado).
     - `assets/solver.worker-*.js`.
3. **Verificar os Cabeçalhos do Vercel**:
   - Verifique se `vercel.json` na raiz e em `apps/web/` possui os headers `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp`.
4. **Verificação de Inicialização em Desenvolvimento (`npm run dev`)**:
   - Execute `npm run dev` e verifique no console se `ensure-wasm.mjs` valida o `.wasm` antes de abrir a porta 5173.
