/**
 * Face Crop Service
 * Detects the primary face (largest & most centered) in a photo
 * and crops around it before sending to AI generation.
 * This prevents face hybridization when multiple people are in frame.
 */

import { FaceDetector as MediaPipeFaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

interface FaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
  centerScore: number; // 0 = perfect center, higher = further from center
}

interface DetectedFace {
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface FaceDetectorConstructor {
  new (options?: { maxDetectedFaces?: number }): {
    detect: (image: CanvasImageSource) => Promise<DetectedFace[]>;
  };
}

type WindowWithFaceDetector = Window & typeof globalThis & {
  FaceDetector?: FaceDetectorConstructor;
};

let mediaPipeFaceDetectorPromise: Promise<MediaPipeFaceDetector> | null = null;

async function getMediaPipeFaceDetector(): Promise<MediaPipeFaceDetector> {
  mediaPipeFaceDetectorPromise ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
    );

    return MediaPipeFaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.35,
    });
  })();

  return mediaPipeFaceDetectorPromise;
}

async function detectFaces(image: HTMLImageElement): Promise<DetectedFace[]> {
  const NativeFaceDetector = (window as WindowWithFaceDetector).FaceDetector;
  if (NativeFaceDetector) {
    const detector = new NativeFaceDetector({ maxDetectedFaces: 10 });
    return detector.detect(image);
  }

  console.info('[FaceCrop] Native FaceDetector API not available, using MediaPipe fallback');
  const detector = await getMediaPipeFaceDetector();
  const result = detector.detect(image);

  return result.detections
    .map((detection) => detection.boundingBox)
    .filter((box): box is NonNullable<typeof box> => Boolean(box))
    .map((box) => ({
      boundingBox: {
        x: box.originX,
        y: box.originY,
        width: box.width,
        height: box.height,
      },
    }));
}

/**
 * Crops the image around the primary face.
 * Returns the cropped base64 image, or the original if no faces detected.
 * 
 * @param base64Image - The full photo as base64 (with or without data: prefix)
 * @param paddingMultiplier - How much space around the face to keep (2.5 = 2.5x face size on each side)
 */
export async function cropToPrimaryFace(
  base64Image: string,
  paddingMultiplier = 2.5
): Promise<string> {
  try {
    // Create image element from base64
    const img = await loadImage(base64Image);
    
    // Detect faces
    const faces = await detectFaces(img);

    if (!faces || faces.length === 0) {
      console.log('[FaceCrop] No faces detected, returning original image');
      return base64Image;
    }

    if (faces.length === 1) {
      console.log('[FaceCrop] Single face detected, returning original image');
      return base64Image; // No need to crop if only one person
    }

    // Score each face: prefer largest AND most centered
    const imgCenterX = img.width / 2;
    const imgCenterY = img.height / 2;

    const scoredFaces: FaceBounds[] = faces.map((face) => {
      const box = face.boundingBox;
      const faceCenterX = box.x + box.width / 2;
      const faceCenterY = box.y + box.height / 2;

      // Euclidean distance from image center, normalized to 0..1
      const dx = (faceCenterX - imgCenterX) / img.width;
      const dy = (faceCenterY - imgCenterY) / img.height;
      const centerScore = Math.sqrt(dx * dx + dy * dy);

      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        area: box.width * box.height,
        centerScore,
      };
    });

    // Sort by combined score: larger face + more centered = better
    // Normalize area to 0..1 range
    const maxArea = Math.max(...scoredFaces.map(f => f.area));
    scoredFaces.sort((a, b) => {
      const scoreA = (a.area / maxArea) * 0.6 - a.centerScore * 0.4; // 60% size, 40% center
      const scoreB = (b.area / maxArea) * 0.6 - b.centerScore * 0.4;
      return scoreB - scoreA; // descending
    });

    const primaryFace = scoredFaces[0];
    console.log(`[FaceCrop] ${faces.length} faces detected, primary: ${primaryFace.width}x${primaryFace.height} at (${primaryFace.x}, ${primaryFace.y})`);

    // Calculate crop region with generous padding
    const padX = primaryFace.width * paddingMultiplier;
    const padY = primaryFace.height * paddingMultiplier;

    // Center the crop on the face, with more space above (for hair/head) than below
    const faceCenterX = primaryFace.x + primaryFace.width / 2;
    const faceCenterY = primaryFace.y + primaryFace.height / 2;

    let cropX = Math.max(0, faceCenterX - padX);
    let cropY = Math.max(0, faceCenterY - padY * 1.2); // 20% more space above
    let cropW = padX * 2;
    let cropH = padY * 2.4; // match the extra top space

    // Maintain 9:16 aspect ratio (portrait)
    const targetRatio = 9 / 16;
    const currentRatio = cropW / cropH;
    if (currentRatio > targetRatio) {
      // Too wide, increase height
      cropH = cropW / targetRatio;
    } else {
      // Too tall, increase width
      cropW = cropH * targetRatio;
      cropX = Math.max(0, faceCenterX - cropW / 2);
    }

    // Clamp to image bounds
    if (cropX + cropW > img.width) cropX = Math.max(0, img.width - cropW);
    if (cropY + cropH > img.height) cropY = Math.max(0, img.height - cropH);
    cropW = Math.min(cropW, img.width - cropX);
    cropH = Math.min(cropH, img.height - cropY);

    // Crop using canvas
    const canvas = document.createElement('canvas');
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const croppedBase64 = canvas.toDataURL('image/jpeg', 0.92);
    console.log(`[FaceCrop] Cropped to ${Math.round(cropW)}x${Math.round(cropH)} from ${img.width}x${img.height}`);

    return croppedBase64;
  } catch (err) {
    console.warn('[FaceCrop] Face detection failed, returning original image:', err);
    return base64Image;
  }
}

function loadImage(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    // Ensure data URL prefix
    if (!base64.startsWith('data:')) {
      img.src = `data:image/jpeg;base64,${base64}`;
    } else {
      img.src = base64;
    }
  });
}
