/**
 * Sprint 3 Task 3.3 — Unit Tests for WeaverEngineClient, Wasm Bridge, and Solver Worker.
 */

import { describe, expect, it, vi } from 'vitest';
import { WeaverEngineClient } from '../src/core-bridge/engine-client.js';
import { SharedWorkspaceMemory } from '../src/core-bridge/shared-memory-layout.js';
import { SolverStatusFlag } from '../src/domain-contracts/types.js';
import type { FromSolverWorkerMessage, ToSolverWorkerMessage } from '../src/core-bridge/solver.worker.js';

class MockWorker {
  public onmessage: ((e: MessageEvent<FromSolverWorkerMessage>) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public postedMessages: ToSolverWorkerMessage[] = [];
  public terminated = false;

  public postMessage(msg: ToSolverWorkerMessage): void {
    this.postedMessages.push(msg);

    // Auto-respostas assíncronas do mock worker
    setTimeout(() => {
      if (!this.onmessage || this.terminated) return;

      switch (msg.type) {
        case 'INIT':
          this.onmessage(
            new MessageEvent('message', {
              data: {
                type: 'READY',
                isShared: false,
                capacitySteps: msg.capacitySteps ?? 20000,
              },
            }),
          );
          break;

        case 'LOAD_AND_PREPARE_IMAGE':
          this.onmessage(
            new MessageEvent('message', {
              data: {
                type: 'IMAGE_PREPARED',
                summaryJson: msg.configJson ?? JSON.stringify({ preparedWidth: 500, preparedHeight: 500 }),
                preparedRgba: new ArrayBuffer(16),
                importanceRgba: new ArrayBuffer(16),
                edgesRgba: new ArrayBuffer(16),
                radonRgba: new ArrayBuffer(16),
                dimensions: [500, 500, 500, 500, 500, 500, 180, 180],
              },
            }),
          );
          break;

        case 'APPLY_BRUSH': {
          const buf = new ArrayBuffer(16);
          new Uint8Array(buf)[0] = msg.brushWeights.length & 0xff;
          this.onmessage(
            new MessageEvent('message', {
              data: {
                type: 'BRUSH_APPLIED',
                importanceRgba: buf,
              },
            }),
          );
          break;
        }

        case 'INIT_SOLVER':
          this.onmessage(
            new MessageEvent('message', {
              data: { type: 'SOLVER_INITIALIZED' },
            }),
          );
          break;

        case 'START':
          // Emite 2 lotes de progresso e depois 'DONE'
          this.onmessage(
            new MessageEvent('message', {
              data: {
                type: 'PROGRESS',
                currentStep: 50,
                rmse: 0.22,
                deltaE: 10.5,
                ssim: 0.45,
                totalThreadMeters: 25.0,
              },
            }),
          );
          setTimeout(() => {
            if (!this.onmessage || this.terminated) return;
            this.onmessage(
              new MessageEvent('message', {
                data: {
                  type: 'DONE',
                  currentStep: 100,
                  rmse: 0.18,
                  deltaE: 8.2,
                  ssim: 0.65,
                  totalThreadMeters: 50.0,
                },
              }),
            );
          }, 10);
          break;

        case 'PAUSE':
          this.onmessage(
            new MessageEvent('message', {
              data: { type: 'PAUSED', currentStep: 50 },
            }),
          );
          break;

        case 'ABORT':
          this.onmessage(
            new MessageEvent('message', {
              data: { type: 'ABORTED', currentStep: 50 },
            }),
          );
          break;

        case 'EXPORT_CAM':
          this.onmessage(
            new MessageEvent('message', {
              data: {
                type: 'CAM_EXPORT_RESULT',
                exportId: msg.exportId,
                result: msg.camType === 'blueprint_svg' ? '<svg>Master</svg>' : 'pin_number,x_mm,y_mm',
              },
            }),
          );
          break;
      }
    }, 5);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

describe('WeaverEngineClient & Wasm Bridge Architecture (Sprint 3 / Task 3.3)', () => {
  it('instantiates client with SharedWorkspaceMemory and default capacity', () => {
    const client = new WeaverEngineClient({ capacitySteps: 1000 });
    expect(client.memory).toBeInstanceOf(SharedWorkspaceMemory);
    expect(client.memory.capacitySteps).toBe(1000);
    expect(client.isReady()).toBe(false);
    client.dispose();
  });

  it('connects to mock worker through INIT handshake and marks client ready', async () => {
    const client = new WeaverEngineClient({ capacitySteps: 500 });
    const mockWorker = new MockWorker();

    await client.init(mockWorker as unknown as Worker);
    expect(client.isReady()).toBe(true);
    expect(mockWorker.postedMessages.length).toBe(1);
    expect(mockWorker.postedMessages[0].type).toBe('INIT');

    client.dispose();
  });

  it('handles loadAndPrepareImage request and returns 4 diagnostic buffers', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const rawRgba = new Uint8Array(4 * 10 * 10);
    const result = await client.loadAndPrepareImage(
      rawRgba,
      10,
      10,
      JSON.stringify({ shape: 'CIRCULAR', pinCount: 200 }),
    );

    expect(result.preparedRgba.byteLength).toBe(16);
    expect(result.importanceRgba.byteLength).toBe(16);
    expect(result.edgesRgba.byteLength).toBe(16);
    expect(result.radonRgba.byteLength).toBe(16);
    expect(result.dimensions).toEqual([500, 500, 500, 500, 500, 500, 180, 180]);

    client.dispose();
  });

  it('updates manual facial focus brush with applyImportanceBrush', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const brushWeights = new Float32Array(100);
    brushWeights[15] = 2.5;

    const updatedImp = await client.applyImportanceBrush(brushWeights);
    expect(updatedImp.byteLength).toBe(16);

    client.dispose();
  });

  it('initializes solver session and processes iterative batches with telemetry', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    await client.initSolver(JSON.stringify({ solver: 'ITERATIVE_GREEDY', maxLines: 100 }));

    const progressSpy = vi.fn();
    const doneSpy = vi.fn();
    client.onProgress(progressSpy);
    client.onDone(doneSpy);

    client.startSolver(50);

    // Aguarda conclusão assíncrona do loop mock
    await vi.waitFor(() => expect(doneSpy).toHaveBeenCalled(), { timeout: 1000 });

    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        currentStep: 50,
        rmse: 0.22,
        deltaE: 10.5,
      }),
    );
    expect(doneSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        currentStep: 100,
        rmse: 0.18,
        deltaE: 8.2,
      }),
    );

    client.dispose();
  });

  it('requests on-demand CAM export artifacts (SVG, CSV, G-Code)', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const svgResult = await client.exportCam('blueprint_svg');
    expect(svgResult).toBe('<svg>Master</svg>');

    const csvResult = await client.exportCam('drilling_csv');
    expect(csvResult).toBe('pin_number,x_mm,y_mm');

    client.dispose();
  });

  it('supports zero-copy memory reads and step writing', () => {
    const client = new WeaverEngineClient({ capacitySteps: 100 });
    client.memory.writeStep(0, {
      fromPin: 12,
      toPin: 145,
      spoolId: 1,
      departureWinding: 'CCW',
      arrivalWinding: 'CW',
      scoreNormalized: 0.75,
    });
    client.memory.setCurrentStepIndex(1);
    client.memory.setCurrentRMSE(0.123);
    client.memory.setCurrentSSIM(0.85);

    const step = client.readStep(0);
    expect(step.fromPin).toBe(12);
    expect(step.toPin).toBe(145);
    expect(step.spoolId).toBe(1);
    expect(step.departureWinding).toBe('CCW');
    expect(step.arrivalWinding).toBe('CW');
    expect(step.scoreNormalized).toBeCloseTo(0.75, 3);

    const metrics = client.getMetrics();
    expect(metrics.rmse).toBeCloseTo(0.123, 5);
    expect(metrics.ssim).toBeCloseTo(0.85, 5);
    expect(client.getCurrentStepIndex()).toBe(1);

    client.dispose();
  });

  it('supports pause and abort transitions cleanly', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const pausedSpy = vi.fn();
    client.onPaused(pausedSpy);

    client.pauseSolver();
    expect(client.getStatus()).toBe(SolverStatusFlag.PAUSED);

    await vi.waitFor(() => expect(pausedSpy).toHaveBeenCalledWith(50), { timeout: 500 });

    client.abortSolver();
    expect(mockWorker.postedMessages.some((m) => m.type === 'ABORT')).toBe(true);

    client.dispose();
    expect(mockWorker.terminated).toBe(true);
  });

  it('handles multiple loadAndPrepareImage calls in strict FIFO order (T1)', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const dummyRgba = new Uint8Array(16);
    const cfgA = JSON.stringify({ tag: 'requestA' });
    const cfgB = JSON.stringify({ tag: 'requestB' });

    // Disparar A e B sem await
    const promiseA = client.loadAndPrepareImage(dummyRgba, 2, 2, cfgA);
    const promiseB = client.loadAndPrepareImage(dummyRgba, 2, 2, cfgB);

    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    expect(resA.summaryJson).toBe(cfgA);
    expect(resB.summaryJson).toBe(cfgB);

    client.dispose();
  });

  it('routes ERROR messages to the correct pending queue by op (T1)', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const dummyRgba = new Uint8Array(16);
    const cfgA = JSON.stringify({ tag: 'requestA' });
    const cfgB = JSON.stringify({ tag: 'requestB' });

    // Customiza o próximo postMessage de LOAD_AND_PREPARE_IMAGE para emitir erro no 1º e sucesso no 2º
    let callCount = 0;
    const originalPost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = (msg: ToSolverWorkerMessage): void => {
      mockWorker.postedMessages.push(msg);
      if (msg.type === 'LOAD_AND_PREPARE_IMAGE') {
        callCount++;
        const currentCount = callCount;
        setTimeout(() => {
          if (!mockWorker.onmessage || mockWorker.terminated) return;
          if (currentCount === 1) {
            mockWorker.onmessage(
              new MessageEvent('message', {
                data: {
                  type: 'ERROR',
                  message: 'Falha no prepare A',
                  op: 'prepare',
                },
              }),
            );
          } else {
            mockWorker.onmessage(
              new MessageEvent('message', {
                data: {
                  type: 'IMAGE_PREPARED',
                  summaryJson: msg.configJson,
                  preparedRgba: new ArrayBuffer(16),
                  importanceRgba: new ArrayBuffer(16),
                  edgesRgba: new ArrayBuffer(16),
                  radonRgba: new ArrayBuffer(16),
                  dimensions: [500, 500, 500, 500, 500, 500, 180, 180],
                },
              }),
            );
          }
        }, 5);
      } else {
        originalPost(msg);
      }
    };

    const promiseA = client.loadAndPrepareImage(dummyRgba, 2, 2, cfgA);
    const promiseB = client.loadAndPrepareImage(dummyRgba, 2, 2, cfgB);

    await expect(promiseA).rejects.toThrow('Falha no prepare A');
    const resB = await promiseB;
    expect(resB.summaryJson).toBe(cfgB);

    client.dispose();
  });

  it('handles applyImportanceBrush in FIFO order (T1)', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const weightsA = new Float32Array(10);
    const weightsB = new Float32Array(20);

    const promiseA = client.applyImportanceBrush(weightsA);
    const promiseB = client.applyImportanceBrush(weightsB);

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(new Uint8Array(resA)[0]).toBe(10);
    expect(new Uint8Array(resB)[0]).toBe(20);

    client.dispose();
  });

  it('rejects all pending FIFO queues on dispose() (T1)', async () => {
    const client = new WeaverEngineClient();
    // Worker que responde apenas a INIT e deixa as operações pendentes
    const silentWorker = {
      onmessage: null as ((e: MessageEvent<FromSolverWorkerMessage>) => void) | null,
      onerror: null,
      postMessage: vi.fn((msg: ToSolverWorkerMessage) => {
        if (msg.type === 'INIT') {
          setTimeout(() => {
            silentWorker.onmessage?.(
              new MessageEvent('message', {
                data: { type: 'READY', isShared: false, capacitySteps: 1000 },
              }),
            );
          }, 0);
        }
      }),
      terminate: vi.fn(),
    };
    await client.init(silentWorker as unknown as Worker);

    const dummyRgba = new Uint8Array(16);
    const prepPromise = client.loadAndPrepareImage(dummyRgba, 2, 2, '{}');
    const brushPromise = client.applyImportanceBrush(new Float32Array(5));
    const initSolverPromise = client.initSolver('{}');
    const smartFramePromise = client.computeSmartFraming(dummyRgba, 2, 2);

    client.dispose();

    await expect(prepPromise).rejects.toThrow('Engine descartado');
    await expect(brushPromise).rejects.toThrow('Engine descartado');
    await expect(initSolverPromise).rejects.toThrow('Engine descartado');
    await expect(smartFramePromise).rejects.toThrow('Engine descartado');
  });

  it('rejects all pending FIFO queues on fatal worker ERROR message (T1)', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const dummyRgba = new Uint8Array(16);
    const prepPromise1 = client.loadAndPrepareImage(dummyRgba, 2, 2, '{}');
    const prepPromise2 = client.loadAndPrepareImage(dummyRgba, 2, 2, '{}');
    const brushPromise = client.applyImportanceBrush(new Float32Array(5));

    // Simula mensagem de erro fatal vinda do worker
    mockWorker.onmessage?.(
      new MessageEvent('message', {
        data: {
          type: 'ERROR',
          message: 'Wasm out of memory trap',
          fatal: true,
          op: 'prepare',
        },
      }),
    );

    await expect(prepPromise1).rejects.toThrow('Wasm out of memory trap');
    await expect(prepPromise2).rejects.toThrow('Wasm out of memory trap');
    await expect(brushPromise).rejects.toThrow('Wasm out of memory trap');

    client.dispose();
  });

  it('rejects all pending FIFO queues on worker.onerror event (T1)', async () => {
    const client = new WeaverEngineClient();
    const mockWorker = new MockWorker();
    await client.init(mockWorker as unknown as Worker);

    const dummyRgba = new Uint8Array(16);
    const prepPromise = client.loadAndPrepareImage(dummyRgba, 2, 2, '{}');
    const initSolverPromise = client.initSolver('{}');

    // Simula evento de erro inesperado no worker
    mockWorker.onerror?.({ message: 'Script evaluation error' } as unknown as ErrorEvent);

    await expect(prepPromise).rejects.toThrow('Worker error: Script evaluation error');
    await expect(initSolverPromise).rejects.toThrow('Worker error: Script evaluation error');

    client.dispose();
  });
});
