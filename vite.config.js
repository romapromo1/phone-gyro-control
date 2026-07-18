import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
export const runtimeAssets = [
  'public/images/upper.svg',
  'public/images/lower.svg',
  'public/reklama-disclaimer.svg',
  'public/YSTextCond-Black.ttf',
  'public/YSTextCond-BlackItalic.ttf',
  'flags/fbx_balls/england_ball.fbx',
  'flags/fbx_balls/england_basecolor.png',
  'flags/fbx_balls/france_ball.fbx',
  'flags/fbx_balls/france_basecolor.png',
  'flags/fbx_balls/spain_ball.fbx',
  'flags/fbx_balls/spain_basecolor.png',
  'flags/fbx_balls/argentina_ball.fbx',
  'flags/fbx_balls/argentina_basecolor.png',
  'public/source/save.fbx',
  'public/source/save.svg',
  'public/3d/save2.fbx',
  'public/source/football.glb',
  'public/source/fixed/labirint2.fbx',
  'public/source/fixed/labirint3.fbx',
  'public/source/fixed/labirint5.fbx',
  'public/source/fixed/labirint7.fbx',
  'public/textures/DefaultMaterial_Normal_OpenGL.png',
];

function copyRuntimeAssets() {
  return {
    name: 'copy-runtime-assets',
    apply: 'build',
    writeBundle(outputOptions) {
      const outDir = resolve(projectRoot, outputOptions.dir || 'dist');
      for (const asset of runtimeAssets) {
        const relativePath = asset.replace(/^public\//, '');
        const destination = resolve(outDir, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(resolve(projectRoot, asset), destination);
      }
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [copyRuntimeAssets()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        controller: resolve(projectRoot, 'controller.html'),
        operator: resolve(projectRoot, 'operator.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('@dimforge/rapier3d-compat')) return 'vendor-rapier';
          if (id.includes('/three/')) return 'vendor-three';
          if (id.includes('socket.io-client') || id.includes('engine.io-client')) return 'vendor-socket';
        },
      },
    },
  },
});
