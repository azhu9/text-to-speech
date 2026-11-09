/// <reference lib="webworker" />
// Runs the Kokoro text-to-speech model off the main thread.
import { env } from '@huggingface/transformers';
import type { KokoroTTS } from 'kokoro-js';

export type WorkerRequest =
  | { type: 'load'; ortBase: string }
  | { type: 'generate'; id: number; text: string; voice: string };

export type WorkerResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; device: string }
  | { type: 'load-error'; message: string }
  | { type: 'audio'; id: number; wav: ArrayBuffer; duration: number }
  | { type: 'error'; id: number; message: string };

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

let tts: Promise<KokoroTTS> | null = null;

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function load(ortBase: string): Promise<KokoroTTS> {
  if (tts) return tts;
  tts = (async () => {
    // Serve the ONNX runtime from this app instead of a CDN.
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: string; numThreads?: number } };
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = ortBase;
      // Default is half the cores; use all but one (needs cross-origin isolation).
      if (self.crossOriginIsolated) onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
    }
    const { KokoroTTS } = await import('kokoro-js');
    const webgpu = await hasWebGPU();
    const device = webgpu ? 'webgpu' : 'wasm';
    const model = await KokoroTTS.from_pretrained(MODEL, {
      // Full precision (~330 MB, downloaded once): needed for WebGPU, and on CPU it
      // measured ~1.6x faster than the 8-bit model (which is smaller but slower).
      dtype: 'fp32',
      device,
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file) post({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
      },
    });
    post({ type: 'ready', device });
    return model;
  })();
  tts.catch((e) => {
    tts = null;
    post({ type: 'load-error', message: e instanceof Error ? e.message : String(e) });
  });
  return tts;
}

// One generation at a time, in the order the main thread sends them.
let chain: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    void load(msg.ortBase).catch(() => {});
    return;
  }
  if (msg.type === 'generate') {
    chain = chain.then(async () => {
      try {
        if (!tts) throw new Error('Model not loaded');
        const model = await tts;
        const audio = await model.generate(msg.text, { voice: msg.voice as 'af_heart' });
        const wav = audio.toWav();
        post({ type: 'audio', id: msg.id, wav, duration: audio.audio.length / audio.sampling_rate }, [wav]);
      } catch (err) {
        post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }
};
