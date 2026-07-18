import type { GestureRecognizer } from '@mediapipe/tasks-vision';

const INFERENCE_INTERVAL_MS = 220;
const REQUIRED_STABLE_FRAMES = 2;
const MIN_CONFIDENCE = 0.68;
const ARM_DELAY_MS = 900;
const ANALYSIS_MAX_EDGE = 640;
const MAX_CONSECUTIVE_FRAME_ERRORS = 3;

export type ThumbCaptureState = 'loading' | 'ready' | 'unavailable';

export class ThumbUpCapture {
  private recognizer: GestureRecognizer | null = null;
  private recognizerPromise: Promise<GestureRecognizer> | null = null;
  private video: HTMLVideoElement | null = null;
  private onCapture: (() => void) | null = null;
  private onState: ((state: ThumbCaptureState) => void) | null = null;
  private timerId: number | null = null;
  private analysisCanvas: HTMLCanvasElement | null = null;
  private analysisContext: CanvasRenderingContext2D | null = null;
  private lastInferenceAt = 0;
  private lastVideoTime = -1;
  private stableFrames = 0;
  private consecutiveFrameErrors = 0;
  private armedAt = 0;
  private active = false;

  start(
    video: HTMLVideoElement,
    onCapture: () => void,
    onState?: (state: ThumbCaptureState) => void,
  ) {
    this.stopLoop();
    this.video = video;
    this.onCapture = onCapture;
    this.onState = onState || null;
    this.active = true;
    this.stableFrames = 0;
    this.consecutiveFrameErrors = 0;
    this.lastVideoTime = -1;
    this.lastInferenceAt = 0;
    this.armedAt = performance.now() + ARM_DELAY_MS;
    this.onState?.('loading');

    void this.getRecognizer()
      .then(() => {
        if (!this.active || this.video !== video) return;
        this.onState?.('ready');
        this.scheduleNextFrame(0);
      })
      .catch((error) => {
        console.warn('Thumb-up recognition is unavailable; manual capture remains active.', error);
        if (this.active) this.onState?.('unavailable');
      });
  }

  pause() {
    this.active = false;
    this.stopLoop();
    this.stableFrames = 0;
  }

  stop() {
    this.pause();
    this.video = null;
    this.onCapture = null;
    this.onState = null;
  }

  private async getRecognizer() {
    if (this.recognizer) return this.recognizer;
    if (this.recognizerPromise) return this.recognizerPromise;

    const recognizerPromise = (async () => {
      const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const createRecognizer = (delegate: 'CPU' | 'GPU') => GestureRecognizer.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: '/mediapipe/gesture_recognizer.task',
          delegate,
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
        cannedGesturesClassifierOptions: {
          categoryAllowlist: ['Thumb_Up'],
          scoreThreshold: MIN_CONFIDENCE,
          maxResults: 1,
        },
      });

      try {
        this.recognizer = await createRecognizer('GPU');
      } catch (gpuError) {
        // A second WebGL context is not always available on kiosk hardware.
        // CPU fallback keeps gesture capture optional instead of breaking the
        // camera flow or retrying GPU initialization on every frame.
        console.warn('MediaPipe GPU delegate is unavailable; using CPU gesture recognition.', gpuError);
        this.recognizer = await createRecognizer('CPU');
      }
      return this.recognizer;
    })();
    this.recognizerPromise = recognizerPromise;

    try {
      return await recognizerPromise;
    } catch (error) {
      // A temporary asset/network failure may recover for the next guest.
      if (this.recognizerPromise === recognizerPromise) this.recognizerPromise = null;
      throw error;
    }
  }

  private scheduleNextFrame(delayMs = INFERENCE_INTERVAL_MS) {
    if (!this.active || this.timerId !== null) return;
    this.timerId = window.setTimeout(this.processFrame, delayMs);
  }

  private processFrame = () => {
    this.timerId = null;
    if (!this.active || !this.recognizer || !this.video) return;

    const now = performance.now();
    const video = this.video;
    if (
      now >= this.armedAt
      && now - this.lastInferenceAt >= INFERENCE_INTERVAL_MS
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && video.currentTime !== this.lastVideoTime
    ) {
      this.lastInferenceAt = now;
      this.lastVideoTime = video.currentTime;
      try {
        const result = this.recognizer.recognizeForVideo(this.prepareAnalysisFrame(video), now);
        this.consecutiveFrameErrors = 0;
        const gesture = result.gestures[0]?.[0];
        const isThumbUp = gesture?.categoryName === 'Thumb_Up' && gesture.score >= MIN_CONFIDENCE;
        this.stableFrames = isThumbUp ? this.stableFrames + 1 : 0;
        if (this.stableFrames >= REQUIRED_STABLE_FRAMES) {
          this.pause();
          this.onCapture?.();
          return;
        }
      } catch (error) {
        this.consecutiveFrameErrors += 1;
        this.stableFrames = 0;
        if (this.consecutiveFrameErrors === 1) {
          console.warn('Thumb-up frame recognition failed; retrying.', error);
        }
        if (this.consecutiveFrameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
          console.warn('Thumb-up recognition stopped after repeated frame errors; manual capture remains active.');
          this.pause();
          this.onState?.('unavailable');
          return;
        }
      }
    }

    const processingTime = performance.now() - now;
    this.scheduleNextFrame(Math.max(16, INFERENCE_INTERVAL_MS - processingTime));
  };

  private prepareAnalysisFrame(video: HTMLVideoElement): TexImageSource {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    if (longestEdge <= 0 || longestEdge <= ANALYSIS_MAX_EDGE) return video;

    const scale = ANALYSIS_MAX_EDGE / longestEdge;
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    if (!this.analysisCanvas) {
      this.analysisCanvas = document.createElement('canvas');
      this.analysisContext = this.analysisCanvas.getContext('2d', {
        alpha: false,
        desynchronized: true,
      });
    }
    if (!this.analysisCanvas || !this.analysisContext) return video;
    if (this.analysisCanvas.width !== targetWidth || this.analysisCanvas.height !== targetHeight) {
      this.analysisCanvas.width = targetWidth;
      this.analysisCanvas.height = targetHeight;
    }
    this.analysisContext.drawImage(video, 0, 0, targetWidth, targetHeight);
    return this.analysisCanvas;
  }

  private stopLoop() {
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timerId = null;
  }
}
