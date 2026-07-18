import { runGenerationPipeline } from './generationService';
import QRCode from 'qrcode';

export interface ImageGenerationUIOptions {
  /**
   * The parent element where the UI overlays should be appended.
   * Defaults to document.body or #app if found.
   */
  container?: HTMLElement;

  /**
   * Google Drive folder URL for the QR code.
   */
  driveFolderUrl?: string;

  /**
   * Callback triggered when the user clicks the "← ЗАНОВО" button.
   */
  onReset?: () => void;

  /**
   * Callback triggered when the image generation successfully completes.
   */
  onSuccess?: (imageUrl: string) => void;

  /**
   * Callback triggered if the generation fails.
   */
  onError?: (error: Error) => void;
}

export class ImageGenerationUI {
  private container: HTMLElement;
  private driveFolderUrl: string;
  private onReset?: () => void;
  private onSuccess?: (imageUrl: string) => void;
  private onError?: (error: Error) => void;

  private abortController: AbortController | null = null;
  private activeOverlay: HTMLElement | null = null;
  private styleElement: HTMLStyleElement | null = null;

  constructor(options: ImageGenerationUIOptions = {}) {
    this.container = options.container || document.getElementById('app') || document.body;
    this.driveFolderUrl = options.driveFolderUrl || 'https://drive.google.com/drive/folders/1QGkdRV_s3VvcPEJoj_L7Fl6S62qaCa9V?usp=sharing';
    this.onReset = options.onReset;
    this.onSuccess = options.onSuccess;
    this.onError = options.onError;

    this.injectStyles();
  }

  /**
   * Injects CSS styles for animations and premium look
   */
  private injectStyles() {
    if (document.getElementById('image-generation-styles')) return;

    this.styleElement = document.createElement('style');
    this.styleElement.id = 'image-generation-styles';
    this.styleElement.textContent = `
      @keyframes ig-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes ig-fadeSlideIn {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .ig-overlay {
        position: absolute;
        inset: 0;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #ffffff;
        font-family: 'Inter', -apple-system, sans-serif;
        box-sizing: border-box;
      }
      .ig-spinner {
        width: clamp(40px, 6cqw, 100px);
        height: clamp(40px, 6cqw, 100px);
        border: 4px solid rgba(0,0,0,0.08);
        border-top: 4px solid #111;
        border-radius: 50%;
        animation: ig-spin 0.8s linear infinite;
        margin-bottom: 20px;
      }
      .ig-status-text {
        font-weight: 800;
        font-size: clamp(16px, 3cqw, 48px);
        color: #111;
        letter-spacing: 2px;
        text-transform: uppercase;
        text-align: center;
        animation: ig-fadeSlideIn 0.4s ease both;
      }
      .ig-btn-view {
        pointer-events: auto;
        font-family: 'Inter', sans-serif;
        font-weight: 800;
        font-size: clamp(16px, 3cqw, 48px);
        letter-spacing: clamp(2px, 0.4cqw, 6px);
        color: #fff;
        background: #111;
        border: none;
        border-radius: clamp(36px, 5cqw, 150px);
        padding: clamp(16px, 2.5cqw, 40px) clamp(48px, 8cqw, 120px);
        cursor: pointer;
        box-shadow: 0 6px 28px rgba(0,0,0,0.25);
        transition: transform 0.15s, background-color 0.15s;
        margin-top: 20px;
        animation: ig-fadeSlideIn 0.5s ease both 0.1s;
      }
      .ig-btn-view:hover {
        transform: scale(1.05);
        background: #222;
      }
      .ig-btn-view:active {
        transform: scale(0.98);
      }
      .ig-viewer-title {
        position: absolute;
        top: clamp(30px, 4%, 100px);
        left: 0;
        right: 0;
        text-align: center;
        z-index: 10;
        pointer-events: none;
        font-family: 'Inter', sans-serif;
        font-weight: 800;
        font-size: clamp(20px, 4.5cqw, 80px);
        color: #333;
        letter-spacing: clamp(2px, 0.5cqw, 8px);
        text-transform: uppercase;
        text-shadow: 0 2px 10px rgba(255,255,255,0.8);
      }
      .ig-btn-reset {
        position: absolute;
        top: clamp(30px, 4%, 100px);
        left: clamp(16px, 3%, 60px);
        z-index: 30;
        background: rgba(255, 255, 255, 0.5);
        border: clamp(1px, 0.2cqw, 3px) solid rgba(0,0,0,0.1);
        border-radius: clamp(16px, 2cqw, 60px);
        backdrop-filter: blur(10px);
        padding: clamp(8px, 1.2cqw, 20px) clamp(16px, 2.5cqw, 40px);
        cursor: pointer;
        font-family: 'Inter', sans-serif;
        font-weight: 500;
        font-size: clamp(10px, 1.6cqw, 32px);
        color: #333;
        box-shadow: 0 4px 16px rgba(0,0,0,0.1);
        transition: transform 0.15s, background-color 0.15s;
      }
      .ig-btn-reset:hover {
        transform: scale(1.05);
        background: rgba(255, 255, 255, 0.8);
      }
      .ig-qr-container {
        position: absolute;
        bottom: clamp(30px, 4%, 100px);
        left: clamp(30px, 4%, 100px);
        z-index: 30;
        background: #ffffff;
        padding: clamp(8px, 1cqw, 24px);
        border-radius: clamp(16px, 2cqw, 40px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: clamp(6px, 0.8cqw, 16px);
        animation: ig-fadeSlideIn 0.6s ease both 0.3s;
      }
      .ig-qr-image {
        width: clamp(100px, 14cqw, 300px);
        height: clamp(100px, 14cqw, 300px);
      }
      .ig-qr-label {
        font-family: 'Inter', sans-serif;
        font-size: clamp(10px, 1.4cqw, 28px);
        font-weight: 800;
        color: #111;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
    `;
    document.head.appendChild(this.styleElement);
  }

  /**
   * Starts the generation pipeline, displaying a loader, then shows
   * the "Посмотреть свой образ" button overlay upon successful generation.
   *
   * @param base64Image - The user's input photo as base64
   */
  public async startGeneration(base64Image: string): Promise<void> {
    this.reset();
    this.abortController = new AbortController();

    // Show loading overlay
    const overlay = this.createLoadingOverlay();
    this.container.appendChild(overlay);
    this.activeOverlay = overlay;

    try {
      const result = await runGenerationPipeline(
        base64Image,
        this.driveFolderUrl,
        this.abortController.signal
      );

      // Trigger callback if defined
      if (this.onSuccess) {
        this.onSuccess(result.imageUrl);
      }

      // Transition loading overlay to success button screen
      this.showReadyButtonOverlay(result.imageUrl);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[ImageGenUI] Generation aborted.');
        return;
      }
      console.error('[ImageGenUI] Pipeline failed:', error);
      if (this.onError) {
        this.onError(error);
      }
      this.showErrorOverlay(error.message || 'Ошибка генерации образа.');
    }
  }

  /**
   * Helper to create the initial loading DOM structure
   */
  private createLoadingOverlay(): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'ig-overlay';

    const spinner = document.createElement('div');
    spinner.className = 'ig-spinner';

    const text = document.createElement('div');
    text.className = 'ig-status-text';
    text.textContent = 'Идёт генерация…';

    div.appendChild(spinner);
    div.appendChild(text);
    return div;
  }

  /**
   * Replaces loading screen with "Посмотреть свой образ" button
   */
  private showReadyButtonOverlay(imageUrl: string) {
    if (!this.activeOverlay) return;

    this.activeOverlay.innerHTML = '';

    const text = document.createElement('div');
    text.className = 'ig-status-text';
    text.textContent = 'Твой образ готов';

    const button = document.createElement('button');
    button.className = 'ig-btn-view';
    button.textContent = 'Посмотреть свой образ';
    button.addEventListener('click', () => {
      this.showPhotoViewer(imageUrl);
    });

    this.activeOverlay.appendChild(text);
    this.activeOverlay.appendChild(button);
  }

  /**
   * Shows an error overlay if the generation fails
   */
  private showErrorOverlay(errorMessage: string) {
    if (!this.activeOverlay) return;

    this.activeOverlay.innerHTML = '';

    const emoji = document.createElement('div');
    emoji.style.fontSize = 'clamp(40px, 8cqw, 100px)';
    emoji.style.marginBottom = '20px';
    emoji.textContent = '😕';

    const text = document.createElement('div');
    text.className = 'ig-status-text';
    text.style.color = '#666';
    text.style.padding = '0 20px';
    text.textContent = errorMessage;

    const button = document.createElement('button');
    button.className = 'ig-btn-view';
    button.textContent = 'Заново';
    button.addEventListener('click', () => {
      this.reset();
      if (this.onReset) this.onReset();
    });

    this.activeOverlay.appendChild(emoji);
    this.activeOverlay.appendChild(text);
    this.activeOverlay.appendChild(button);
  }

  /**
   * Renders the full-screen photo viewer with QR code and image
   */
  public async showPhotoViewer(imageUrl: string): Promise<void> {
    this.clearActiveOverlay();

    const overlay = document.createElement('div');
    overlay.className = 'ig-overlay';

    // 1. The full screen image
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'Your AI look';
    img.style.position = 'absolute';
    img.style.inset = '0';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    overlay.appendChild(img);

    // 2. The title overlay
    const title = document.createElement('div');
    title.className = 'ig-viewer-title';
    title.textContent = 'Твой AI-образ';
    overlay.appendChild(title);

    // 3. The Reset (Заново) Button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'ig-btn-reset';
    resetBtn.textContent = '← ЗАНОВО';
    resetBtn.addEventListener('click', () => {
      this.reset();
      if (this.onReset) {
        this.onReset();
      }
    });
    overlay.appendChild(resetBtn);

    // 4. The QR Code container in the bottom-left corner
    const qrContainer = document.createElement('div');
    qrContainer.className = 'ig-qr-container';

    const qrImg = document.createElement('img');
    qrImg.className = 'ig-qr-image';
    qrContainer.appendChild(qrImg);

    const qrLabel = document.createElement('span');
    qrLabel.className = 'ig-qr-label';
    qrLabel.textContent = 'Скачать фото';
    qrContainer.appendChild(qrLabel);

    overlay.appendChild(qrContainer);

    this.container.appendChild(overlay);
    this.activeOverlay = overlay;

    // Generate QR code base64 asynchronously using the qrcode dependency
    try {
      const qrDataUrl = await QRCode.toDataURL(this.driveFolderUrl, {
        width: 400,
        margin: 1,
        color: { dark: '#111111', light: '#ffffff' }
      });
      qrImg.src = qrDataUrl;
    } catch (err) {
      console.error('[ImageGenUI] Failed to generate QR code:', err);
    }
  }

  /**
   * Helper to remove the overlay from the DOM
   */
  private clearActiveOverlay() {
    if (this.activeOverlay) {
      if (this.activeOverlay.parentElement) {
        this.activeOverlay.parentElement.removeChild(this.activeOverlay);
      }
      this.activeOverlay = null;
    }
  }

  /**
   * Resets the generation flow, aborting any active requests and clearing elements
   */
  public reset(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.clearActiveOverlay();
  }
}
