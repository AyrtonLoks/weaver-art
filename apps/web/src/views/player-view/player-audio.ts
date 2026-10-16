/**
 * Player audio subsystem: pt-BR text-to-speech dictation and synthesized Web Audio feedback.
 * Fully node-safe and resilient against disabled audio or missing browser APIs.
 */

export interface PlayerAudioOptions {
  voiceEnabled?: boolean;
  chimesEnabled?: boolean;
  rate?: number;
  pitch?: number;
  lang?: string;
}

export class PlayerAudio {
  private voiceEnabled: boolean;
  private chimesEnabled: boolean;
  private rate: number;
  private pitch: number;
  private lang: string;
  private audioCtx: AudioContext | null = null;

  constructor(options: PlayerAudioOptions = {}) {
    this.voiceEnabled = options.voiceEnabled ?? false;
    this.chimesEnabled = options.chimesEnabled ?? true;
    this.rate = options.rate ?? 1.0;
    this.pitch = options.pitch ?? 1.0;
    this.lang = options.lang ?? 'pt-BR';
  }

  setVoiceEnabled(enabled: boolean): void {
    this.voiceEnabled = enabled;
    if (!enabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  isVoiceEnabled(): boolean {
    return this.voiceEnabled;
  }

  setChimesEnabled(enabled: boolean): void {
    this.chimesEnabled = enabled;
  }

  isChimesEnabled(): boolean {
    return this.chimesEnabled;
  }

  setSpeechRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2.5, rate));
  }

  /**
   * Speak a text string aloud in pt-BR using SpeechSynthesisUtterance.
   * Invokes onEnd callback strictly when playback finishes, enabling seamless hands-free auto-advance.
   */
  speak(text: string, onEnd?: () => void): void {
    if (!this.voiceEnabled) {
      onEnd?.();
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      onEnd?.();
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      u.rate = this.rate;
      u.pitch = this.pitch;

      let called = false;
      const finish = () => {
        if (!called) {
          called = true;
          onEnd?.();
        }
      };

      u.onend = finish;
      u.onerror = finish;

      // Watchdog timeout to prevent auto-timer stalling if speech synthesis gets muted or paused by browser
      const maxDurationMs = Math.max(2500, text.length * 140);
      const timerFn =
        typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window.setTimeout : setTimeout;
      if (typeof timerFn === 'function') {
        timerFn(finish, maxDurationMs);
      }

      window.speechSynthesis.speak(u);
    } catch {
      onEnd?.();
    }
  }

  /**
   * High-level speech dictation for weaving steps, spool changes, and completion.
   */
  dictateStep(params: {
    toPeg: number;
    sideText?: string;
    layerTransition?: {
      isStart?: boolean;
      prevThreadName?: string;
      nextThreadName?: string;
      prevPin?: number;
    };
    isComplete?: boolean;
    onEnd?: () => void;
  }): void {
    if (params.isComplete) {
      this.playChime('complete');
      this.speak('Tecelagem concluída com sucesso!', params.onEnd);
      return;
    }

    const speechParts: string[] = [];

    if (params.layerTransition) {
      const { isStart, prevThreadName, nextThreadName, prevPin } = params.layerTransition;
      if (isStart && nextThreadName) {
        speechParts.push(`Iniciando tecelagem com fio ${nextThreadName}.`);
      } else if (prevThreadName && nextThreadName) {
        const pinPart = prevPin !== undefined ? ` no pino ${prevPin}` : '';
        speechParts.push(
          `Camada ${prevThreadName} concluída. Troque para o fio ${nextThreadName}.${pinPart ? ' Amarre' + pinPart + '.' : ''}`,
        );
        this.playChime('layer');
      }
    } else {
      this.playChime('step');
    }

    speechParts.push(String(params.toPeg));
    if (params.sideText) {
      speechParts.push(params.sideText);
    }

    if (speechParts.length > 0) {
      this.speak(speechParts.join(', '), params.onEnd);
    } else {
      params.onEnd?.();
    }
  }

  /**
   * Play synthesized harmonic chimes using Web Audio API oscillators.
   */
  playChime(type: 'step' | 'layer' | 'complete'): void {
    if (!this.chimesEnabled) return;
    if (typeof window === 'undefined') return;

    try {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!this.audioCtx) {
        this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      const now = this.audioCtx.currentTime;

      if (type === 'step') {
        // Crisp gentle blip: 587.33 Hz (D5)
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.09);
      } else if (type === 'layer') {
        // Ascending major third chime: 440 Hz (A4) -> 554.37 Hz (C#5)
        const notes = [440, 554.37];
        notes.forEach((freq, idx) => {
          if (!this.audioCtx) return;
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          const start = now + idx * 0.12;

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, start);

          gain.gain.setValueAtTime(0.12, start);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start(start);
          osc.stop(start + 0.26);
        });
      } else if (type === 'complete') {
        // Triumphant arpeggio: C5 (523.25) -> E5 (659.25) -> G5 (783.99) -> C6 (1046.5)
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
          if (!this.audioCtx) return;
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          const start = now + idx * 0.14;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, start);

          gain.gain.setValueAtTime(0.15, start);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start(start);
          osc.stop(start + 0.42);
        });
      }
    } catch {
      // Audio playback blocked or failed
    }
  }

  /**
   * Stop any ongoing speech or sounds.
   */
  stop(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }
}
