/**
 * Background blur via TensorFlow.js on the GPU.
 *
 * ── Why this shape ──────────────────────────────────────────────────────────
 * The obvious route is MediaPipe (what LiveKit ships by default), but its
 * runtime is ~2.8 MB gzipped and executes in WASM on the CPU — stacking onto
 * three simulcast encoders and the E2EE frame worker, which is exactly the
 * budget a video call cannot spare. TF.js with the WebGL backend is ~216 KB and
 * runs the network on the GPU, leaving the CPU to encode and encrypt.
 *
 * This entire module is behind a dynamic import. Nothing here — runtime or
 * model — is fetched unless a user actually switches blur on, so the app's
 * first load is unchanged for everyone who does not.
 *
 * The pipeline is: camera track -> <video> -> segmentation mask -> composite on
 * a canvas -> captureStream() -> published as the replacement track.
 */
import type { TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import { Track } from 'livekit-client';

/** Blur radius applied to the background, in CSS pixels. */
const BLUR_PX = 10;
/**
 * Segmentation runs at this rate; compositing runs at display rate.
 *
 * Inference is the expensive step and a person's outline changes slowly, so
 * reusing a mask across a few frames is visually indistinguishable and roughly
 * halves GPU cost compared with segmenting every frame.
 */
const SEGMENT_FPS = 15;

/** The model's fixed input resolution. */
const MODEL_SIZE = 256;

type Segmenter = {
  /** Renders a person-alpha mask into `target`. */
  segment: (input: HTMLVideoElement, target: HTMLCanvasElement) => Promise<void>;
  dispose: () => void;
};

export class BackgroundBlurProcessor implements TrackProcessor<Track.Kind.Video> {
  name = 'nme-background-blur';
  processedTrack?: MediaStreamTrack;

  private source?: HTMLVideoElement | undefined;
  private canvas?: HTMLCanvasElement | undefined;
  private context?: CanvasRenderingContext2D | undefined;
  private segmenter?: Segmenter | undefined;
  private maskCanvas?: HTMLCanvasElement | undefined;
  private hasMask = false;
  private frame = 0;
  private lastSegmentAt = 0;
  private stopped = false;

  async init(opts: VideoProcessorOptions): Promise<void> {
    this.stopped = false;

    const settings = opts.track.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 360;

    this.source = document.createElement('video');
    this.source.playsInline = true;
    this.source.muted = true;
    this.source.srcObject = new MediaStream([opts.track]);
    await this.source.play();

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    // `desynchronized` lets the browser skip a frame of latency; `alpha: false`
    // avoids per-pixel compositing work the output never needs.
    this.context =
      this.canvas.getContext('2d', { alpha: false, desynchronized: true }) ?? undefined;

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = MODEL_SIZE;
    this.maskCanvas.height = MODEL_SIZE;

    this.segmenter = await createSegmenter();

    // captureStream at 0 means "produce a frame whenever the canvas is drawn",
    // so the output rate follows our render loop rather than a fixed timer.
    const [captured] = this.canvas.captureStream(0).getVideoTracks();
    if (!captured) throw new Error('Canvas capture produced no video track');
    this.processedTrack = captured;

    this.render();
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.stopped = true;
    cancelAnimationFrame(this.frame);

    this.segmenter?.dispose();
    this.segmenter = undefined;
    this.maskCanvas = undefined;
    this.hasMask = false;

    this.processedTrack?.stop();
    delete this.processedTrack;

    if (this.source) {
      this.source.srcObject = null;
      this.source = undefined;
    }
    this.canvas = undefined;
    this.context = undefined;
  }

  private render = (): void => {
    if (this.stopped) return;
    const { context, canvas, source } = this;

    if (!context || !canvas || !source || source.readyState < 2) {
      this.frame = requestAnimationFrame(this.render);
      return;
    }

    void this.updateMask();

    const { width, height } = canvas;

    if (this.hasMask && this.maskCanvas) {
      // 1. Person, drawn sharp.
      context.globalCompositeOperation = 'copy';
      context.filter = 'none';
      context.drawImage(source, 0, 0, width, height);

      // 2. Keep only the pixels the mask marks as person.
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(this.maskCanvas, 0, 0, width, height);

      // 3. Blurred frame behind them. `destination-over` paints underneath what
      //    is already there, so the sharp cut-out survives.
      context.globalCompositeOperation = 'destination-over';
      context.filter = `blur(${BLUR_PX}px)`;
      context.drawImage(source, 0, 0, width, height);

      context.filter = 'none';
      context.globalCompositeOperation = 'source-over';
    } else {
      // No mask yet: pass the frame through rather than showing black while the
      // model loads.
      context.globalCompositeOperation = 'copy';
      context.drawImage(source, 0, 0, width, height);
    }

    // Signals captureStream(0) to emit this frame.
    (this.processedTrack as MediaStreamTrack & { requestFrame?: () => void })?.requestFrame?.();

    this.frame = requestAnimationFrame(this.render);
  };

  /** Re-segments at SEGMENT_FPS; the composite step runs every frame. */
  private async updateMask(): Promise<void> {
    const now = performance.now();
    if (now - this.lastSegmentAt < 1000 / SEGMENT_FPS) return;
    this.lastSegmentAt = now;

    const { segmenter, source, maskCanvas } = this;
    if (!segmenter || !source || !maskCanvas) return;

    try {
      await segmenter.segment(source, maskCanvas);
      if (!this.stopped) this.hasMask = true;
    } catch {
      // A failed inference simply leaves the previous mask in place.
    }
  }
}

/**
 * Loads the runtime and drives the segmentation model directly.
 *
 * The obvious choice is @tensorflow-models/body-segmentation, and this used it
 * at first. It was dropped because it depends on rimraf -> glob -> minimatch ->
 * brace-expansion, four packages carrying an unpatched DoS advisory, none of
 * which a browser build has any use for. The wrapper adds resize, normalise and
 * argmax around a graph model — about forty lines — so calling the model
 * directly removes the advisories and 57 KB rather than suppressing a warning.
 *
 * Model files are served from our own origin: the usual CDN default is blocked
 * outright by `default-src 'none'`, and loosening the CSP for a third-party
 * fetch would be a far worse trade than hosting 325 KB ourselves.
 */
async function createSegmenter(): Promise<Segmenter> {
  const [tf] = await Promise.all([
    import('@tensorflow/tfjs-core'),
    import('@tensorflow/tfjs-backend-webgl'),
  ]);
  const { loadGraphModel } = await import('@tensorflow/tfjs-converter');

  await tf.setBackend('webgl');
  await tf.ready();

  const model = await loadGraphModel('/models/selfie-segmentation/model.json');

  return {
    async segment(input, target) {
      // Every intermediate is disposed: without this, WebGL textures accumulate
      // each frame and the tab runs out of GPU memory within minutes.
      const alpha = tf.tidy(() => {
        const frame = tf.browser.fromPixels(input);
        const resized = tf.image.resizeBilinear(frame, [MODEL_SIZE, MODEL_SIZE]);
        const batch = tf.expandDims(tf.div(resized, 255), 0);

        const output = model.execute(batch) as import('@tensorflow/tfjs-core').Tensor4D;

        // Two channels: background and person. Softmax turns the pair into
        // probabilities; channel 1 is the person's alpha.
        const probabilities = tf.softmax(output, 3);
        const person = tf.slice4d(probabilities, [0, 0, 0, 1], [1, MODEL_SIZE, MODEL_SIZE, 1]);

        // RGBA where colour is irrelevant and alpha carries the mask — the
        // canvas `destination-in` step reads only alpha.
        const white = tf.onesLike(person);
        const rgba = tf.concat([white, white, white, person], 3);
        // Drop the batch dimension: toPixels wants [height, width, channels].
        return tf.reshape<import('@tensorflow/tfjs-core').Rank.R3>(rgba, [
          MODEL_SIZE,
          MODEL_SIZE,
          4,
        ]);
      });

      try {
        await tf.browser.toPixels(alpha, target);
      } finally {
        alpha.dispose();
      }
    },
    dispose() {
      model.dispose();
    },
  };
}
