/// <reference types="vite/client" />
import type { Gender } from './types';
import { getRandomPrompt } from './prompts';
import { cropToPrimaryFace } from './faceCropService';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:3005";

function dataUrlToObjectUrl(dataUrl: string): string {
  const [header, base64] = dataUrl.split(',');
  const mimeType = header.match(/^data:([^;]+);base64$/)?.[1] || 'image/png';
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

// ─── Detect gender from photo ─────────────────────────────────────────────────
export async function detectGender(base64Image: string, signal?: AbortSignal): Promise<Gender> {
  try {
    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
    
    console.log('[Direct AI] Detecting gender via local backend...');
    const response = await fetch(`${BACKEND_URL}/api/detect-gender`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ imageBase64: cleanBase64 }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Local backend error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.gender === 'female' || data.gender === 'male' ? data.gender : 'unknown';
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    console.warn('Gender detection failed, using universal prompt:', err);
    return 'unknown';
  }
}

// ─── Generate styled image using Local Backend ──────────────────────────────────
export async function generateStyledImage(
  base64Image: string,
  gender: Gender,
  driveFolderUrl?: string,
  signal?: AbortSignal,
): Promise<string> {
  const promptText = getRandomPrompt(gender);
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

  console.log('[Direct AI] Generating 2K styled image via local backend...', { gender });

  const response = await fetch(`${BACKEND_URL}/api/generate-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      promptText,
      base64Image: cleanBase64,
      driveFolderUrl
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Local backend error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (!data.imageDataUrl) {
    throw new Error("Local backend did not return imageDataUrl");
  }

  return dataUrlToObjectUrl(data.imageDataUrl);
}

export async function runGenerationPipeline(
  base64Image: string,
  driveFolderUrl?: string,
  signal?: AbortSignal,
): Promise<{
  imageUrl: string;
  gender: Gender;
}> {
  // Step 0: Crop to primary face if multiple people in frame
  console.log('[Pipeline] Step 0: Detecting and cropping primary face...');
  const croppedImage = await cropToPrimaryFace(base64Image);
  
  const gender = await detectGender(croppedImage, signal);
  const imageUrl = await generateStyledImage(croppedImage, gender, driveFolderUrl, signal);
  return { imageUrl, gender };
}
