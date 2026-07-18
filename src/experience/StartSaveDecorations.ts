import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const DEFAULT_ASSET_URL = '/3d/save2.fbx';
const NORMALIZED_MODEL_SIZE = 1.35;
const ENTER_DURATION_MS = 520;
const DEFAULT_EXIT_DURATION_MS = 760;

type DecorationPhase = 'hidden' | 'entering' | 'idle' | 'exiting';

interface MaterialState {
  material: THREE.Material;
  opacity: number;
  visible: boolean;
}

interface SaveDecoration {
  id: 'start-save-large-left' | 'start-save-small-right';
  label: string;
  editorRoot: THREE.Group;
  motionRoot: THREE.Group;
  materials: MaterialState[];
  phaseOffset: number;
  exitDirection: number;
}

export interface StartSaveEditorObject {
  id: SaveDecoration['id'];
  label: string;
  object: THREE.Group;
}

export interface StartSaveDecorationsOptions {
  scene: THREE.Scene;
  assetUrl?: string;
  onReady?: () => void;
}

/**
 * Two lightweight decorative saves for the start screen.
 *
 * Layout/editor transforms live on each `editorRoot`. All procedural motion is
 * applied to a child `motionRoot`, so animation never overwrites values saved
 * by the scene editor.
 */
export class StartSaveDecorations {
  private readonly assetUrl: string;
  private readonly onReady?: () => void;
  private readonly group = new THREE.Group();
  private readonly decorations: SaveDecoration[] = [];
  private preloadPromise: Promise<void> | null = null;
  private phase: DecorationPhase = 'hidden';
  private transitionStart = 0;
  private transitionDuration = ENTER_DURATION_MS;
  private visibility = 0;
  private exitStartVisibility = 1;
  private readyNotified = false;
  private shouldBeVisible = false;

  constructor(options: StartSaveDecorationsOptions) {
    this.assetUrl = options.assetUrl || DEFAULT_ASSET_URL;
    this.onReady = options.onReady;
    this.group.name = 'start-save-decorations';
    this.group.userData.ignoreEditor = true;
    this.group.visible = false;
    options.scene.add(this.group);
  }

  preload() {
    if (!this.preloadPromise) {
      this.preloadPromise = this.loadDecorations().catch((error: unknown) => {
        this.preloadPromise = null;
        throw error;
      });
    }
    return this.preloadPromise;
  }

  async show(appearanceDelayMs = 0) {
    this.shouldBeVisible = true;
    await this.preload();
    if (!this.shouldBeVisible) return;
    this.group.visible = true;
    this.phase = 'entering';
    this.transitionStart = performance.now() + Math.max(0, appearanceDelayMs);
    this.transitionDuration = ENTER_DURATION_MS;
    this.visibility = 0;
    this.applyVisibility(0);
  }

  hide() {
    this.shouldBeVisible = false;
    this.phase = 'hidden';
    this.visibility = 0;
    this.group.visible = false;
    this.resetMotionRoots();
    this.applyVisibility(0);
  }

  beginExit(durationMs = DEFAULT_EXIT_DURATION_MS, now = performance.now()) {
    this.shouldBeVisible = false;
    if (this.phase === 'hidden') return;
    this.exitStartVisibility = this.visibility;
    this.transitionStart = now;
    this.transitionDuration = Math.max(1, durationMs);
    this.phase = 'exiting';
  }

  update(now: number) {
    if (this.phase === 'hidden') return;

    if (this.phase === 'entering') {
      const progress = clamp01((now - this.transitionStart) / this.transitionDuration);
      this.visibility = easeOutCubic(progress);
      if (progress >= 1) this.phase = 'idle';
    } else if (this.phase === 'exiting') {
      const progress = clamp01((now - this.transitionStart) / this.transitionDuration);
      this.visibility = this.exitStartVisibility * (1 - easeInCubic(progress));
      if (progress >= 1) {
        this.hide();
        return;
      }
    }

    this.updateFloatingMotion(now);
    this.applyVisibility(this.visibility);
  }

  needsContinuousRender() {
    return this.phase !== 'hidden';
  }

  getEditorObjects(): StartSaveEditorObject[] {
    return this.decorations.map(({ id, label, editorRoot }) => ({
      id,
      label,
      object: editorRoot,
    }));
  }

  private async loadDecorations() {
    if (this.decorations.length > 0) return;

    const template = await new FBXLoader().loadAsync(this.assetUrl);
    template.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(template);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);

    if (
      bounds.isEmpty()
      || !Number.isFinite(maxDimension)
      || maxDimension <= Number.EPSILON
      || !isFiniteVector(center)
    ) {
      throw new Error(`Invalid FBX bounds: ${this.assetUrl}`);
    }

    const normalizedScale = NORMALIZED_MODEL_SIZE / maxDimension;
    const definitions = [
      {
        id: 'start-save-large-left' as const,
        label: 'Сейв — слева (большой)',
        position: new THREE.Vector3(-1.15, -1.05, 0.12),
        scale: 1.15,
        phaseOffset: 0,
        exitDirection: -1,
      },
      {
        id: 'start-save-small-right' as const,
        label: 'Сейв — справа (маленький)',
        position: new THREE.Vector3(1.5, -1.42, -0.08),
        scale: 0.9,
        phaseOffset: 0.82,
        exitDirection: 1,
      },
    ] as const;

    for (const definition of definitions) {
      const editorRoot = new THREE.Group();
      editorRoot.name = `${definition.id}-editor-root`;
      editorRoot.userData.editorId = definition.id;
      editorRoot.userData.editorLabel = definition.label;
      editorRoot.position.copy(definition.position);
      editorRoot.scale.setScalar(definition.scale);

      const motionRoot = new THREE.Group();
      motionRoot.name = `${definition.id}-motion-root`;
      motionRoot.userData.ignoreEditor = true;

      const model = template.clone(true);
      const materials = cloneMaterials(model);
      model.name = `${definition.id}-model`;

      const centeringRoot = new THREE.Group();
      centeringRoot.name = `${definition.id}-centering-root`;
      centeringRoot.position.copy(center).multiplyScalar(-1);
      centeringRoot.add(model);

      const normalizationRoot = new THREE.Group();
      normalizationRoot.name = `${definition.id}-normalization-root`;
      normalizationRoot.scale.setScalar(normalizedScale);
      normalizationRoot.add(centeringRoot);

      motionRoot.add(normalizationRoot);
      editorRoot.add(motionRoot);
      this.group.add(editorRoot);
      this.decorations.push({
        id: definition.id,
        label: definition.label,
        editorRoot,
        motionRoot,
        materials,
        phaseOffset: definition.phaseOffset,
        exitDirection: definition.exitDirection,
      });
    }

    this.resetMotionRoots();
    this.applyVisibility(0);
    if (!this.readyNotified) {
      this.readyNotified = true;
      this.onReady?.();
    }
  }

  private updateFloatingMotion(now: number) {
    const time = now * 0.00125;
    const exitProgress = this.phase === 'exiting'
      ? clamp01((now - this.transitionStart) / this.transitionDuration)
      : 0;

    for (const decoration of this.decorations) {
      const wave = time + decoration.phaseOffset;
      const root = decoration.motionRoot;

      // Both instances follow the same path; the phase offset creates a soft wave.
      root.position.set(
        Math.sin(wave * 0.73) * 0.055,
        Math.sin(wave) * 0.115,
        Math.cos(wave * 0.61) * 0.07,
      );
      root.rotation.set(
        Math.sin(wave * 0.67) * 0.045,
        Math.cos(wave * 0.53) * 0.065,
        Math.sin(wave * 0.79) * 0.04,
      );

      if (exitProgress > 0) {
        const easedExit = easeInCubic(exitProgress);
        root.position.x += decoration.exitDirection * 0.24 * easedExit;
        root.position.y += 0.06 * easedExit;
      }
      root.scale.setScalar(0.86 + this.visibility * 0.14);
    }
  }

  private resetMotionRoots() {
    for (const decoration of this.decorations) {
      decoration.motionRoot.position.set(0, 0, 0);
      decoration.motionRoot.rotation.set(0, 0, 0);
      decoration.motionRoot.scale.setScalar(1);
    }
  }

  private applyVisibility(visibility: number) {
    for (const decoration of this.decorations) {
      for (const state of decoration.materials) {
        state.material.opacity = state.opacity * visibility;
        state.material.visible = state.visible && visibility > 0.001;
      }
    }
  }
}

function cloneMaterials(root: THREE.Object3D) {
  const states: MaterialState[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;

    const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
    const clonedMaterials = sourceMaterials.map((source) => {
      const material = source.clone();
      const opacity = material.opacity;
      const visible = material.visible;
      material.transparent = true;
      states.push({ material, opacity, visible });
      return material;
    });
    child.material = Array.isArray(child.material) ? clonedMaterials : clonedMaterials[0];
  });
  return states;
}

function isFiniteVector(vector: THREE.Vector3) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function easeInCubic(value: number) {
  return value ** 3;
}
