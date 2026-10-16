import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoom, resolveOptions, type WeaveResult } from '@weaver-art/core';
import {
  PlayerAudio,
  PlayerCanvas,
  PlayerProgressCodec,
  PlayerStorage,
  PlayerView,
  QRCodeGenerator,
  type PlayerViewElements,
} from '../src/views/player-view/index.js';

function createMockElement<T extends HTMLElement>(tagName = 'div', attrs: Record<string, string> = {}): T {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const el = {
    tagName: tagName.toUpperCase(),
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    hidden: false,
    style: {
      background: '',
      width: '',
    },
    dataset: {},
    classList: {
      classes: new Set<string>(),
      add(c: string) {
        this.classes.add(c);
      },
      remove(c: string) {
        this.classes.delete(c);
      },
      contains(c: string) {
        return this.classes.has(c);
      },
    },
    click() {
      const list = listeners['click'];
      if (list) {
        for (const fn of list) fn({ type: 'click' });
      }
    },
    addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    }),
    dispatchEvent: vi.fn((event: { type: string }) => {
      const list = listeners[event.type];
      if (list) {
        for (const fn of list) fn(event);
      }
      return true;
    }),
    ...attrs,
  } as unknown as T;
  return el;
}

function createMockCanvas(): HTMLCanvasElement {
  const canvas = createMockElement<HTMLCanvasElement>('canvas');
  canvas.width = 800;
  canvas.height = 800;

  const ctx = {
    canvas,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((txt: string) => ({ width: txt.length * 8 })),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    lineCap: 'butt',
  };

  (canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return canvas;
}

function createDummyWeaveResult(): WeaveResult {
  const options = resolveOptions({
    loom: {
      shape: 'circle',
      diameterMm: 600,
      pegCount: 200,
      startAngleDeg: -90,
      pegDiameterMm: 2.5,
    },
    threads: [
      { id: 'yellow', name: 'Amarelo', color: '#ffdd00', widthMm: 0.2, opacity: 0.15, startPeg: 0 },
      { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.2, opacity: 0.25, startPeg: 50 },
    ],
    colorStrategy: 'layered',
    background: '#ffffff',
  });

  return {
    version: 1,
    options,
    steps: [
      {
        index: 0,
        from: 0,
        to: 100,
        thread: 0,
        fromSide: 1,
        toSide: -1,
        layerIndex: 0,
        gain: 0.1,
        segmentMm: 600,
        wrapMm: 2,
      },
      {
        index: 1,
        from: 100,
        to: 50,
        thread: 0,
        fromSide: -1,
        toSide: 1,
        layerIndex: 0,
        gain: 0.1,
        segmentMm: 600,
        wrapMm: 2,
      },
      {
        index: 2,
        from: 50,
        to: 150,
        thread: 1,
        fromSide: 1,
        toSide: -1,
        layerIndex: 1,
        gain: 0.1,
        segmentMm: 600,
        wrapMm: 2,
      },
      {
        index: 3,
        from: 150,
        to: 20,
        thread: 1,
        fromSide: -1,
        toSide: 1,
        layerIndex: 1,
        gain: 0.1,
        segmentMm: 600,
        wrapMm: 2,
      },
    ],
    threads: [
      { id: 'yellow', name: 'Amarelo', color: '#ffdd00', pegs: [0, 100, 50], lengthMm: 1200, lines: 2 },
      { id: 'black', name: 'Preto', color: '#000000', pegs: [50, 150, 20], lengthMm: 1200, lines: 2 },
    ],
    totalLengthMm: 2400,
    rmse: 0.05,
    stopReason: 'max-lines',
    durationMs: 120,
  };
}

describe('Sprint 4 — Task 4.3: Vista Modo Tecelagem (PlayerView)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. PlayerProgressCodec (Dual WA1 Token Codec & Persistence)', () => {
    it('encodes and decodes Core WA1 token with FNV-1a checksum', () => {
      const result = createDummyWeaveResult();
      const code = PlayerProgressCodec.encode(result, 2);

      expect(code).toMatch(/^WA1-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i);

      const decoded = PlayerProgressCodec.decode(code);
      expect(decoded).not.toBeNull();
      expect(decoded?.index).toBe(2);
      expect(decoded?.format).toBe('core_v1');
    });

    it('decodes CAM format tokens (WA1-<project_hash>-<spool>-<step>) and strips URL prefixes', () => {
      const camToken = '#progress=WA1-a9f8c1-1-42';
      const decoded = PlayerProgressCodec.decode(camToken);

      expect(decoded).not.toBeNull();
      expect(decoded?.format).toBe('cam_v1');
      expect(decoded?.fingerprint).toBe('a9f8c1');
      expect(decoded?.spoolIdx).toBe(1);
      expect(decoded?.index).toBe(42);
    });

    it('returns null on invalid or malformed tokens', () => {
      expect(PlayerProgressCodec.decode('')).toBeNull();
      expect(PlayerProgressCodec.decode('INVALID-TOKEN')).toBeNull();
      expect(PlayerProgressCodec.decode('WA1-too-few-parts')).toBeNull();
    });

    it('saves and retrieves progress from localStorage', () => {
      const mockStorage: Record<string, string> = {};
      const origStorage = globalThis.localStorage;

      // Mock localStorage
      globalThis.localStorage = {
        getItem: (k: string) => mockStorage[k] ?? null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v;
        },
        removeItem: (k: string) => {
          delete mockStorage[k];
        },
        clear: () => {},
        key: () => null,
        length: 0,
      };

      try {
        PlayerProgressCodec.saveToLocalStorage('test-fp', 15);
        const loaded = PlayerProgressCodec.loadFromLocalStorage('test-fp');
        expect(loaded).not.toBeNull();
        expect(loaded?.index).toBe(15);
      } finally {
        globalThis.localStorage = origStorage;
      }
    });
  });

  describe('2. PlayerAudio (pt-BR Speech Synthesis & Chimes)', () => {
    it('safely handles audio and speech in SSR/Node without throwing', () => {
      const audio = new PlayerAudio();
      expect(() => audio.speak('Olá')).not.toThrow();
      expect(() => audio.playChime('step')).not.toThrow();
      expect(() => audio.playChime('layer')).not.toThrow();
      expect(() => audio.playChime('complete')).not.toThrow();
    });

    it('configures voice toggles and speech rate', () => {
      const audio = new PlayerAudio({ voiceEnabled: true, chimesEnabled: false });
      expect(audio.isVoiceEnabled()).toBe(true);
      expect(audio.isChimesEnabled()).toBe(false);

      audio.setVoiceEnabled(false);
      expect(audio.isVoiceEnabled()).toBe(false);

      audio.setSpeechRate(1.5);
    });

    it('dispatches speech synthesis utterance with correct lang and message when available', () => {
      const speakMock = vi.fn();
      const cancelMock = vi.fn();

      class MockUtterance {
        lang = '';
        rate = 1;
        pitch = 1;
        constructor(public text: string) {}
      }

      const origWindow = globalThis.window;
      // Inject mock speechSynthesis
      (globalThis as unknown as { window: unknown }).window = {
        speechSynthesis: {
          speak: speakMock,
          cancel: cancelMock,
        },
      };
      (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = MockUtterance;

      try {
        const audio = new PlayerAudio({ voiceEnabled: true });
        audio.dictateStep({
          toPeg: 101,
          sideText: 'sentido horário',
          layerTransition: {
            prevThreadName: 'Amarelo',
            nextThreadName: 'Preto',
          },
        });

        expect(cancelMock).toHaveBeenCalled();
        expect(speakMock).toHaveBeenCalled();
        const callArg = speakMock.mock.calls[0][0] as MockUtterance;
        expect(callArg.lang).toBe('pt-BR');
        expect(callArg.text).toContain('Camada Amarelo concluída. Troque para o fio Preto.');
        expect(callArg.text).toContain('101, sentido horário');
      } finally {
        globalThis.window = origWindow;
      }
    });
  });

  describe('3. PlayerCanvas (Loom Silhouette & Active Chord Winding)', () => {
    it('renders circular loom, past threads, glowing active chord and winding arrows', () => {
      const canvas = createMockCanvas();
      const playerCanvas = new PlayerCanvas(canvas);
      const result = createDummyWeaveResult();
      const loom = createLoom(result.options.loom);

      expect(() => playerCanvas.render(result, loom, 1)).not.toThrow();

      const ctx = canvas.getContext('2d') as unknown as {
        arc: ReturnType<typeof vi.fn>;
        stroke: ReturnType<typeof vi.fn>;
        fill: ReturnType<typeof vi.fn>;
        fillText: ReturnType<typeof vi.fn>;
      };

      // Ensure arc was called for loom perimeter, pegs, and winding indicators
      expect(ctx.arc).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.fillText).toHaveBeenCalled();
    });

    it('handles completed state (index >= steps.length) without throwing', () => {
      const canvas = createMockCanvas();
      const playerCanvas = new PlayerCanvas(canvas);
      const result = createDummyWeaveResult();
      const loom = createLoom(result.options.loom);

      expect(() => playerCanvas.render(result, loom, result.steps.length)).not.toThrow();
    });
  });

  describe('4. PlayerView Controller (DOM, Telemetry, and Playback)', () => {
    function setupPlayerView(): { player: PlayerView; elements: PlayerViewElements } {
      const elements: PlayerViewElements = {
        canvas: createMockCanvas(),
        empty: createMockElement('div'),
        live: createMockElement('div'),
        step: createMockElement('strong'),
        total: createMockElement('span'),
        swatch: createMockElement('span'),
        thread: createMockElement('span'),
        from: createMockElement('span'),
        to: createMockElement('p'),
        side: createMockElement('p'),
        prev: createMockElement<HTMLButtonElement>('button'),
        next: createMockElement<HTMLButtonElement>('button'),
        voice: createMockElement<HTMLInputElement>('input', { type: 'checkbox' }),
        auto: createMockElement<HTMLInputElement>('input', { type: 'checkbox' }),
        interval: createMockElement<HTMLInputElement>('input', { value: '4' }),
        goto: createMockElement<HTMLInputElement>('input'),
        bar: createMockElement('div'),
        remaining: createMockElement('strong'),
        code: createMockElement<HTMLInputElement>('input'),
        copyCodeBtn: createMockElement<HTMLButtonElement>('button'),
        pasteCodeBtn: createMockElement<HTMLButtonElement>('button'),
        exportResumeBtn: createMockElement<HTMLButtonElement>('button'),
        spoolAlert: createMockElement('div'),
        spoolAlertText: createMockElement('p'),
        spoolAlertDismissBtn: createMockElement<HTMLButtonElement>('button'),
        qrBtn: createMockElement<HTMLButtonElement>('button'),
        qrModal: createMockElement('div'),
        qrContainer: createMockElement('div'),
        qrCloseBtn: createMockElement<HTMLButtonElement>('button'),
        qrUrlText: createMockElement('p'),
      };

      const player = new PlayerView(elements);
      return { player, elements };
    }

    it('initializes in empty state and displays pattern on load', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();

      player.load(result);

      expect(elements.empty.hidden).toBe(true);
      expect(elements.live.hidden).toBe(false);
      expect(elements.total.textContent).toBe('4');

      const state = player.getState();
      expect(state.index).toBe(0);
      expect(state.totalSteps).toBe(4);
      expect(state.currentPegFrom).toBe(1); // 0-based index 0 + PEG_BASE (1)
      expect(state.currentPegTo).toBe(101); // 0-based index 100 + PEG_BASE (1)
      expect(state.isDone).toBe(false);

      // Verify giant pin number display
      expect(elements.to.textContent).toBe('101');
      expect(elements.from.textContent).toBe('1');
    });

    it('navigates next and previous steps via UI buttons and clamps at bounds', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();
      player.load(result);

      // Go forward: step 0 -> 1
      elements.next.click();
      expect(player.getState().index).toBe(1);
      expect(elements.to.textContent).toBe('51');

      // Go forward: step 1 -> 2 (layer change)
      elements.next.click();
      expect(player.getState().index).toBe(2);
      expect(elements.thread.textContent).toContain('Camada 2: Preto');

      // Go back: step 2 -> 1
      elements.prev.click();
      expect(player.getState().index).toBe(1);

      // Go back to step 0
      elements.prev.click();
      expect(player.getState().index).toBe(0);
      expect(elements.prev.disabled).toBe(true);

      // Clamping at index 0
      elements.prev.click();
      expect(player.getState().index).toBe(0);
    });

    it('handles keyboard shortcuts (Space / ArrowRight / ArrowLeft / P / Escape)', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();
      player.load(result);

      const spaceEvent = {
        code: 'Space',
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent;

      player.handleKey(spaceEvent);
      expect(spaceEvent.preventDefault).toHaveBeenCalled();
      expect(player.getState().index).toBe(1);

      const leftEvent = {
        code: 'ArrowLeft',
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent;

      player.handleKey(leftEvent);
      expect(leftEvent.preventDefault).toHaveBeenCalled();
      expect(player.getState().index).toBe(0);

      // Toggle auto via 'P'
      expect(elements.auto.checked).toBe(false);
      const pEvent = {
        code: 'KeyP',
        key: 'p',
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent;

      player.handleKey(pEvent);
      expect(pEvent.preventDefault).toHaveBeenCalled();
      expect(elements.auto.checked).toBe(true);

      // Dismiss modal via Escape
      const escEvent = {
        code: 'Escape',
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent;
      player.handleKey(escEvent);
    });

    it('updates layer information and remaining time estimation on advance', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();
      player.load(result);

      expect(elements.thread.textContent).toContain('Camada 1: Amarelo (1/2)');
      expect(elements.remaining?.textContent).not.toBe('');

      // Advance to completion
      player.go(4);
      expect(player.getState().isDone).toBe(true);
      expect(elements.remaining?.textContent).toBe('Concluído!');
      expect(elements.to.textContent).toBe('✔');
      expect(elements.next.disabled).toBe(true);
    });

    it('generates progress code and supports copy/paste', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();
      player.load(result);

      expect(elements.code?.value).toMatch(/^WA1-/);

      // Test copy button click
      expect(() => elements.copyCodeBtn?.click()).not.toThrow();
    });

    it('triggers spool switch alert and pauses auto-advance when thread changes', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();
      player.load(result);

      // Enable auto timer
      elements.auto.checked = true;
      elements.auto.dispatchEvent({ type: 'change' } as unknown as Event);

      // Step 0 -> Step 1 (same thread 0: Yellow)
      elements.next.click();
      expect(elements.spoolAlert?.hidden).toBe(true);

      // Step 1 -> Step 2 (thread changes from Yellow to Black)
      elements.next.click();
      expect(elements.spoolAlert?.hidden).toBe(false);
      expect(elements.spoolAlertText?.textContent).toContain('Troca de Carretel: Amarre e finalize o fio Amarelo no pino 51 e inicie o carretel Preto.');
      // Auto timer should be automatically stopped and unchecked!
      expect(elements.auto.checked).toBe(false);

      // Dismiss alert
      elements.spoolAlertDismissBtn?.click();
      expect(elements.spoolAlert?.hidden).toBe(true);
    });

    it('generates QR Code modal with sync URL upon request', () => {
      const { player, elements } = setupPlayerView();
      const result = createDummyWeaveResult();
      player.load(result);

      elements.qrBtn?.click();
      expect(elements.qrModal?.hidden).toBe(false);
      expect(elements.qrContainer?.innerHTML).toContain('<svg');
      expect(elements.qrUrlText?.textContent).toContain('#progress=WA1-');

      // Close modal
      elements.qrCloseBtn?.click();
      expect(elements.qrModal?.hidden).toBe(true);
    });
  });

  describe('5. QRCodeGenerator (ISO/IEC 18004 Vector SVG)', () => {
    it('generates valid binary module matrices for URLs', () => {
      const url = 'https://weaver.art/#progress=WA1-a9f8c1-1-42';
      const matrix = QRCodeGenerator.generateMatrix(url);

      expect(Array.isArray(matrix)).toBe(true);
      expect(matrix.length).toBeGreaterThanOrEqual(21);
      expect(matrix[0].length).toBe(matrix.length);

      // Verify finder pattern corners are dark
      expect(matrix[0][0]).toBe(true);
      expect(matrix[0][matrix.length - 1]).toBe(true);
      expect(matrix[matrix.length - 1][0]).toBe(true);
    });

    it('generates clean vector SVG with paths and scalable viewBox', () => {
      const url = 'https://weaver.art/#progress=WA1-654817-2a-14';
      const svg = QRCodeGenerator.toSVG(url);

      expect(svg).toContain('<svg');
      expect(svg).toContain('viewBox=');
      expect(svg).toContain('<path d="M');
      expect(svg).toContain('</svg>');
    });
  });

  describe('6. PlayerStorage (IndexedDB Resilience)', () => {
    it('safely performs project and progress persistence operations', async () => {
      const result = createDummyWeaveResult();
      const savedProj = await PlayerStorage.saveProject(result);
      expect(typeof savedProj).toBe('boolean');

      const savedProg = await PlayerStorage.saveProgress('test-fp', 10);
      expect(typeof savedProg).toBe('boolean');

      const loadedProg = await PlayerStorage.loadProgress('test-fp');
      expect(loadedProg === null || typeof loadedProg?.index === 'number').toBe(true);
    });
  });
});
