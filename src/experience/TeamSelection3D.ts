import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export interface TeamDefinition {
  id: 'england' | 'france' | 'spain' | 'argentina';
  name: string;
  promptCountry: string;
  asset: string;
}

export const TEAMS: readonly TeamDefinition[] = [
  { id: 'england', name: 'АНГЛИЯ', promptCountry: 'Англии', asset: '/flags/fbx_balls/england_ball.fbx' },
  { id: 'france', name: 'ФРАНЦИЯ', promptCountry: 'Франции', asset: '/flags/fbx_balls/france_ball.fbx' },
  { id: 'spain', name: 'ИСПАНИЯ', promptCountry: 'Испании', asset: '/flags/fbx_balls/spain_ball.fbx' },
  { id: 'argentina', name: 'АРГЕНТИНА', promptCountry: 'Аргентины', asset: '/flags/fbx_balls/argentina_ball.fbx' },
] as const;

interface TeamBall {
  team: TeamDefinition;
  editorRoot: THREE.Group;
  root: THREE.Group;
  materials: THREE.Material[];
  basePosition: THREE.Vector3;
  hoverScale: number;
}

type Phase = 'hidden' | 'appearing' | 'idle' | 'selecting' | 'selected';

export interface TeamCameraView {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov: number;
}

export class TeamSelection3D {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly onSelect: (team: TeamDefinition) => void;
  private readonly onSelectionReady: (team: TeamDefinition) => void;
  private readonly group = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly balls = new Map<string, TeamBall>();
  private preloadPromise: Promise<void> | null = null;
  private phase: Phase = 'hidden';
  private appearanceStart = 0;
  private selectionStart = 0;
  private selected: TeamBall | null = null;
  private selectedStartPosition = new THREE.Vector3();
  private selectedStartRotation = 0;
  private selectedStartScale = 1;
  private hovered: TeamBall | null = null;
  private cameraView: TeamCameraView = {
    position: { x: 0, y: 0.35, z: 12 },
    target: { x: 0, y: -0.35, z: 0 },
    fov: 45,
  };

  constructor(options: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    canvas: HTMLCanvasElement;
    onSelect: (team: TeamDefinition) => void;
    onSelectionReady: (team: TeamDefinition) => void;
  }) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.canvas = options.canvas;
    this.onSelect = options.onSelect;
    this.onSelectionReady = options.onSelectionReady;
    this.group.name = 'team-selection-balls';
    // The versioned editor ID prevents legacy saved scale=1 values from
    // overriding the new campaign layout in browsers that already ran it.
    this.group.userData.editorId = 'team-scene-v2';
    this.group.userData.editorLabel = 'Сцена выбора команды';
    this.group.scale.setScalar(1.05);
    this.group.visible = false;
    this.scene.add(this.group);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
  }

  preload() {
    this.preloadPromise ??= this.loadBalls();
    return this.preloadPromise;
  }

  async show(appearanceDelayMs = 1_200) {
    await this.preload();
    this.resetVisuals();
    this.configureCamera();
    this.group.visible = true;
    this.phase = 'appearing';
    this.appearanceStart = performance.now() + appearanceDelayMs;
  }

  hide() {
    this.phase = 'hidden';
    this.group.visible = false;
    this.canvas.style.cursor = '';
  }

  resize() {
    if (this.phase !== 'hidden') this.configureCamera();
  }

  setCameraView(view: TeamCameraView) {
    this.cameraView = {
      position: { ...view.position },
      target: { ...view.target },
      fov: view.fov,
    };
    if (this.phase !== 'hidden') this.configureCamera();
  }

  needsContinuousRender() {
    return this.phase === 'appearing' || this.phase === 'idle' || this.phase === 'selecting';
  }

  getEditorObjects() {
    return [
      { id: 'team-scene-v2', label: 'Все шары сборных', object: this.group },
      ...TEAMS.flatMap((team) => {
        const ball = this.balls.get(team.id);
        return ball
          ? [{ id: `team-ball-${team.id}`, label: `Шар — ${team.name}`, object: ball.editorRoot }]
          : [];
      }),
    ];
  }

  reset() {
    this.selected = null;
    this.hide();
    this.resetVisuals();
  }

  select(teamId: string) {
    if (this.phase !== 'idle') return false;
    const ball = this.balls.get(teamId);
    if (!ball) return false;
    this.selected = ball;
    this.selectedStartPosition.copy(ball.root.position);
    this.selectedStartRotation = ball.root.rotation.y;
    this.selectedStartScale = ball.hoverScale;
    this.selectionStart = performance.now();
    this.phase = 'selecting';
    this.setHovered(null);
    this.canvas.style.cursor = '';
    this.onSelect(ball.team);
    return true;
  }

  hover(teamId: string | null) {
    this.setHovered(teamId ? this.balls.get(teamId) || null : null);
  }

  update(now: number) {
    if (this.phase === 'hidden') return;
    if (this.phase === 'appearing' || this.phase === 'idle') {
      let allVisible = true;
      TEAMS.forEach((team, index) => {
        const ball = this.balls.get(team.id);
        if (!ball) return;
        const appearProgress = clamp01((now - this.appearanceStart - index * 90) / 520);
        if (appearProgress < 1) allVisible = false;
        const hoverTarget = this.phase === 'idle' && ball === this.hovered ? 1.13 : 1;
        ball.hoverScale = THREE.MathUtils.lerp(ball.hoverScale, hoverTarget, 0.16);
        const scale = easeOutBack(appearProgress) * ball.hoverScale;
        ball.root.scale.setScalar(scale);
        const wave = now * 0.0022 - index * 0.62;
        ball.root.position.copy(ball.basePosition);
        ball.root.position.y += Math.sin(wave) * 0.12;
        ball.root.rotation.z = Math.sin(wave * 0.72) * 0.035;
      });
      if (this.phase === 'appearing' && allVisible) this.phase = 'idle';
      return;
    }

    if (this.phase !== 'selecting' || !this.selected) return;
    const progress = clamp01((now - this.selectionStart) / 1_500);
    const eased = easeInOutCubic(progress);

    for (const ball of this.balls.values()) {
      if (ball === this.selected) continue;
      const fade = 1 - clamp01(progress / 0.38);
      ball.root.scale.setScalar(fade);
      setMaterialOpacity(ball.materials, fade);
    }

    this.selected.root.position.lerpVectors(
      this.selectedStartPosition,
      new THREE.Vector3(0, -0.15, 0.7),
      eased,
    );
    this.selected.root.scale.setScalar(THREE.MathUtils.lerp(this.selectedStartScale, 2, eased));
    this.selected.root.rotation.z *= 1 - eased;
    this.selected.root.rotation.y = this.selectedStartRotation + Math.PI * 2 * eased;

    if (progress >= 1) {
      this.phase = 'selected';
      this.selected.root.rotation.y = this.selectedStartRotation + Math.PI * 2;
      this.onSelectionReady(this.selected.team);
    }
  }

  private async loadBalls() {
    const loader = new FBXLoader();
    const positions = [-1.8, -0.6, 0.6, 1.8];
    const loaded = await Promise.all(TEAMS.map(async (team, index) => {
      const model = await loader.loadAsync(team.asset);
      const editorRoot = new THREE.Group();
      editorRoot.name = `team-ball-editor-${team.id}`;
      editorRoot.userData.editorId = `team-ball-${team.id}`;
      editorRoot.userData.editorLabel = `Шар — ${team.name}`;
      const root = new THREE.Group();
      root.name = `team-ball-${team.id}`;
      const materials: THREE.Material[] = [];

      model.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = false;
        child.userData.teamId = team.id;
        const source = Array.isArray(child.material) ? child.material : [child.material];
        const cloned = source.map((material) => {
          const next = material.clone();
          next.transparent = true;
          next.opacity = 1;
          materials.push(next);
          return next;
        });
        child.material = Array.isArray(child.material) ? cloned : cloned[0];
      });

      const initialBounds = new THREE.Box3().setFromObject(model);
      const size = initialBounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
        throw new Error(`Invalid FBX bounds: ${team.asset}`);
      }
      const normalizedScale = 0.95 / maxDimension;
      model.scale.setScalar(normalizedScale);
      model.updateMatrixWorld(true);
      const normalizedBounds = new THREE.Box3().setFromObject(model);
      const center = normalizedBounds.getCenter(new THREE.Vector3());
      model.position.sub(center);
      root.add(model);
      root.userData.teamId = team.id;

      // A slightly oversized invisible sphere makes WebGL selection forgiving,
      // including taps near the silhouette and on glossy transparent pixels.
      const hitTarget = new THREE.Mesh(
        new THREE.SphereGeometry(0.58, 20, 14),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          colorWrite: false,
        }),
      );
      hitTarget.name = `team-ball-hit-${team.id}`;
      hitTarget.userData.teamId = team.id;
      hitTarget.userData.ignoreShadow = true;
      hitTarget.renderOrder = -1;
      root.add(hitTarget);

      const basePosition = new THREE.Vector3(positions[index], -0.75, 0);
      root.position.copy(basePosition);
      root.scale.setScalar(0);
      editorRoot.add(root);
      this.group.add(editorRoot);
      return { team, editorRoot, root, materials, basePosition, hoverScale: 1 } satisfies TeamBall;
    }));

    loaded.forEach((ball) => this.balls.set(ball.team.id, ball));
  }

  private configureCamera() {
    this.camera.position.set(
      this.cameraView.position.x,
      this.cameraView.position.y,
      this.cameraView.position.z,
    );
    this.camera.fov = this.cameraView.fov;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(
      this.cameraView.target.x,
      this.cameraView.target.y,
      this.cameraView.target.z,
    );
    this.camera.updateProjectionMatrix();
  }

  private resetVisuals() {
    for (const ball of this.balls.values()) {
      ball.root.position.copy(ball.basePosition);
      ball.root.rotation.set(0, 0, 0);
      ball.root.scale.setScalar(0);
      ball.hoverScale = 1;
      setMaterialOpacity(ball.materials, 1);
    }
    this.setHovered(null);
  }

  private handlePointerDown = (event: PointerEvent) => {
    const teamId = this.pickTeam(event);
    if (teamId) this.select(teamId);
  };

  private handlePointerMove = (event: PointerEvent) => {
    const teamId = this.pickTeam(event);
    this.setHovered(teamId ? this.balls.get(teamId) || null : null);
  };

  private handlePointerLeave = () => this.setHovered(null);

  private pickTeam(event: PointerEvent) {
    if (this.phase !== 'idle') return null;
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.group, true);
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      while (object && object !== this.group) {
        if (typeof object.userData.teamId === 'string') return object.userData.teamId as string;
        object = object.parent;
      }
    }
    return null;
  }

  private setHovered(ball: TeamBall | null) {
    this.hovered = this.phase === 'idle' ? ball : null;
    this.canvas.style.cursor = this.hovered ? 'pointer' : '';
  }
}

function setMaterialOpacity(materials: THREE.Material[], opacity: number) {
  materials.forEach((material) => {
    material.opacity = opacity;
    material.visible = opacity > 0.01;
  });
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
}

function easeOutBack(value: number) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (value - 1) ** 3 + c1 * (value - 1) ** 2;
}
