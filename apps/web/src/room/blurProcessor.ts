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

type Segmenter = {
  segmentPeople: (
    input: HTMLVideoElement,
    config?: { flipHorizontal?: boolean },
  ) => Promise<Array<{ mask: { toCanvasImageSource: () => Promise<CanvasImageSource> } }>>;
  dispose: () => void;
};

export class BackgroundBlurProcessor implements TrackProcessor<Track.Kind.Video> {
  name = 'nme-background-blur';
  processedTrack?: MediaStreamTrack;

  private source?: HTMLVideoElement | undefined;
  private canvas?: HTMLCanvasElement | undefined;
  private context?: CanvasRenderingContext2D | undefined;
  private segmenter?: Segmenter | undefined;
  private maskSource?: CanvasImageSource | undefined;
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
    this.maskSource = undefined;

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

    if (this.maskSource) {
      // 1. Person, drawn sharp.
      context.globalCompositeOperation = 'copy';
      context.filter = 'none';
      context.drawImage(source, 0, 0, width, height);

      // 2. Keep only the pixels the mask marks as person.
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(this.maskSource, 0, 0, width, height);

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

    const { segmenter, source } = this;
    if (!segmenter || !source) return;

    try {
      const people = await segmenter.segmentPeople(source, { flipHorizontal: false });
      const mask = people[0]?.mask;
      if (mask && !this.stopped) {
        this.maskSource = await mask.toCanvasImageSource();
      }
    } catch {
      // A failed inference simply leaves the previous mask in place.
    }
  }
}

/**
 * Loads the runtime and model.
 *
 * Model files are served from our own origin: the library's default points at
 * a Google CDN, which the app's `default-src 'none'` CSP blocks outright — and
 * relaxing the policy to allow a third-party fetch would be a much worse trade
 * than hosting 250 KB ourselves.
 */
async function createSegmenter(): Promise<Segmenter> {
  const [tf, bodySegmentation] = await Promise.all([
    import('@tensorflow/tfjs-core'),
    import('@tensorflow-models/body-segmentation'),
    import('@tensorflow/tfjs-backend-webgl'),
  ]);

  await tf.setBackend('webgl');
  await tf.ready();

  const segmenter = await bodySegmentation.createSegmenter(
    bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
    {
      runtime: 'tfjs',
      modelType: 'general',
      modelUrl: '/models/selfie-segmentation/model.json',
    },
  );

  return segmenter as unknown as Segmenter;
}
