export interface LevelDefinition {
  id: string;
  asset: string;
  save: { x: number; z: number };
}

export const STATION_ID = new URLSearchParams(window.location.search).get('station') || 'main';
export const GAME_DURATION_MS = 60_000;
export const COUNTDOWN_DURATION_MS = 3_000;
export const RESULT_DISPLAY_MS = 7_000;

export const LEVELS: readonly LevelDefinition[] = [
  { id: '01', asset: '/source/fixed/labirint2.fbx', save: { x: 5.3, z: 1.8 } },
  { id: '02', asset: '/source/fixed/labirint3.fbx', save: { x: -2.95, z: -2.95 } },
  { id: '03', asset: '/source/fixed/labirint5.fbx', save: { x: 2.9, z: -0.55 } },
  { id: '04', asset: '/source/fixed/labirint7.fbx', save: { x: 4.15, z: -1.8 } },
];
