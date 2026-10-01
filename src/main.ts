import './ui/styles.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './game/Game';
import { params } from './core/params';
import { TIPS } from './data/tips';

const bar = document.getElementById('boot-bar') as HTMLDivElement;
const status = document.getElementById('boot-status') as HTMLDivElement;
const tip = document.getElementById('boot-tip') as HTMLDivElement;
tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)]!;
const tipTimer = setInterval(() => (tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)]!), 4000);

function progress(p: number, msg: string): Promise<void> {
  bar.style.width = `${Math.round(p * 100)}%`;
  status.textContent = msg.toUpperCase();
  // yield so the browser paints the loading bar
  return new Promise((r) => setTimeout(r, 0));
}

async function boot(): Promise<void> {
  await progress(0.1, 'Initialising physics');
  await RAPIER.init();
  await progress(0.3, 'Starting engine');
  const game = new Game(document.getElementById('app')!);
  (window as unknown as { __game: unknown }).__game = game;
  if (params.test) {
    await progress(0.8, 'Building test area');
    game.setupTestArea();
  } else {
    await game.setupWorld(progress);
  }
  await progress(1, 'Ready');
  game.start();
  clearInterval(tipTimer);
  const el = document.getElementById('boot')!;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 700);
}

boot().catch((e: unknown) => {
  status.textContent = 'FAILED TO START: ' + String(e);
  console.error(e);
});
