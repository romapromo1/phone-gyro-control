import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LevelDefinition } from './config';

export class AssetManager {
  private readonly fbxLoader = new FBXLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly levels: readonly LevelDefinition[];
  private mazeTemplates: THREE.Group[] = [];
  private saveTemplate: THREE.Group | null = null;
  private footballTemplate: THREE.Group | null = null;
  private normalMap: THREE.Texture | null = null;
  private preloadPromise: Promise<void> | null = null;

  constructor(levels: readonly LevelDefinition[]) {
    this.levels = levels;
    // Embedded GLB images are normally exposed through temporary blob: URLs.
    // Some Chromium kiosk shells revoke those URLs before decoding finishes,
    // so decode them through data: URLs instead. Render's CSP explicitly allows
    // data images and the textures remain fully client-side.
    this.gltfLoader.register((parser) => new EmbeddedImageDataUrlPlugin(parser as GltfParser));
  }

  preload() {
    if (this.preloadPromise) return this.preloadPromise;
    this.preloadPromise = this.loadAll().catch((error) => {
      // Allow the kiosk's visible Retry action to recover from a transient
      // Render/network failure instead of reusing a permanently rejected promise.
      this.preloadPromise = null;
      throw error;
    });
    return this.preloadPromise;
  }

  cloneMaze(index: number) {
    const template = this.mazeTemplates[index];
    if (!template) throw new Error(`Maze asset ${index} was not preloaded`);
    return template.clone(true);
  }

  cloneSave() {
    return this.saveTemplate ? cloneWithDisposableGeometry(this.saveTemplate) : null;
  }

  cloneFootball() {
    return this.footballTemplate ? cloneWithDisposableGeometry(this.footballTemplate) : null;
  }

  getNormalMap() {
    if (!this.normalMap) throw new Error('Normal map was not preloaded');
    return this.normalMap;
  }

  private async loadAll() {
    const [save, football, normalMap, ...mazes] = await Promise.all([
      this.fbxLoader.loadAsync('/source/save.fbx'),
      this.gltfLoader.loadAsync('/source/football.glb'),
      this.textureLoader.loadAsync('/textures/DefaultMaterial_Normal_OpenGL.png'),
      ...this.levels.map((level) => this.fbxLoader.loadAsync(level.asset)),
    ]);
    this.saveTemplate = save;
    this.footballTemplate = football.scene;
    this.normalMap = normalMap;
    this.normalMap.wrapS = THREE.RepeatWrapping;
    this.normalMap.wrapT = THREE.RepeatWrapping;
    this.mazeTemplates = mazes;
  }
}

type GltfParser = {
  json: {
    images?: Array<{ bufferView?: number; mimeType?: string; name?: string }>;
    textures?: Array<{ source?: number; name?: string }>;
  };
  getDependency(type: 'bufferView', index: number): Promise<ArrayBuffer>;
};

class EmbeddedImageDataUrlPlugin {
  readonly name = 'EmbeddedImageDataUrlPlugin';

  constructor(private readonly parser: GltfParser) {}

  loadTexture(textureIndex: number): Promise<THREE.Texture> | null {
    const textureDef = this.parser.json.textures?.[textureIndex];
    const sourceIndex = textureDef?.source;
    const sourceDef = sourceIndex === undefined ? undefined : this.parser.json.images?.[sourceIndex];
    if (sourceDef?.bufferView === undefined) return null;

    return this.parser.getDependency('bufferView', sourceDef.bufferView).then(async (bufferView) => {
      const mimeType = sourceDef.mimeType || 'image/png';
      const dataUrl = await readBlobAsDataUrl(new Blob([bufferView], { type: mimeType }));
      const texture = await new THREE.TextureLoader().loadAsync(dataUrl);
      texture.flipY = false;
      texture.name = textureDef?.name || sourceDef.name || '';
      texture.userData.mimeType = mimeType;
      return texture;
    });
  }
}

function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error || new Error('Embedded image decode failed')));
    reader.readAsDataURL(blob);
  });
}

function cloneWithDisposableGeometry(template: THREE.Group) {
  const clone = template.clone(true);
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry = child.geometry.clone();
    if (Array.isArray(child.material)) {
      child.material = child.material.map((material) => material.clone());
    } else if (child.material) {
      child.material = child.material.clone();
    }
  });
  return clone;
}
