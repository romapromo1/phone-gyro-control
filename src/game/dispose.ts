import * as THREE from 'three';

export function disposeObject(root: THREE.Object3D | null, disposeGeometry = true) {
  if (!root) return;
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (disposeGeometry) geometries.add(child.geometry);
    if (Array.isArray(child.material)) child.material.forEach((material) => materials.add(material));
    else if (child.material) materials.add(child.material);
  });
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
  root.removeFromParent();
}

export function removeNamedChildren(parent: THREE.Object3D, names: readonly string[]) {
  for (const name of names) {
    let child = parent.getObjectByName(name);
    while (child) {
      child.removeFromParent();
      child = parent.getObjectByName(name);
    }
  }
}
