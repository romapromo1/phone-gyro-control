import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeAssets } from '../vite.config.js';

test('production build copies every non-bundled runtime asset used by the active experience', () => {
  const requiredAssets = [
    'public/images/upper.svg',
    'public/images/lower.svg',
    'public/reklama-disclaimer.svg',
    'public/YSTextCond-Black.ttf',
    'public/YSTextCond-BlackItalic.ttf',
    'public/source/save.svg',
    'public/source/save.fbx',
    'public/source/football.glb',
    'public/3d/save2.fbx',
    'public/source/fixed/labirint2.fbx',
    'public/source/fixed/labirint3.fbx',
    'public/source/fixed/labirint5.fbx',
    'public/source/fixed/labirint7.fbx',
    'public/textures/DefaultMaterial_Normal_OpenGL.png',
    'flags/fbx_balls/england_ball.fbx',
    'flags/fbx_balls/england_basecolor.png',
    'flags/fbx_balls/france_ball.fbx',
    'flags/fbx_balls/france_basecolor.png',
    'flags/fbx_balls/spain_ball.fbx',
    'flags/fbx_balls/spain_basecolor.png',
    'flags/fbx_balls/argentina_ball.fbx',
    'flags/fbx_balls/argentina_basecolor.png',
  ];

  for (const asset of requiredAssets) {
    assert.ok(runtimeAssets.includes(asset), `Missing production runtime asset: ${asset}`);
  }
});
