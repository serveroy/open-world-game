import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const bar = document.getElementById('boot-bar') as HTMLDivElement;
const status = document.getElementById('boot-status') as HTMLDivElement;

async function boot(): Promise<void> {
  status.textContent = 'INITIALISING PHYSICS';
  bar.style.width = '30%';
  await RAPIER.init();
  bar.style.width = '70%';
  status.textContent = 'BUILDING SCENE';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.getElementById('app')!.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d8);
  const cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);
  cam.position.set(4, 3, 6);
  cam.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.5));
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xc8283c }));
  scene.add(box);
  renderer.setAnimationLoop((t) => {
    box.rotation.y = t / 1000;
    renderer.render(scene, cam);
  });
  bar.style.width = '100%';
  const el = document.getElementById('boot')!;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 700);
  (window as unknown as { __game: { ready: boolean } }).__game = { ready: true };
}

boot().catch((e: unknown) => {
  status.textContent = 'FAILED TO START: ' + String(e);
  console.error(e);
});
