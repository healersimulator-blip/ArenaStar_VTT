/**
 * §11 3D dice — cosmetic tumbling dice that ALWAYS settle on the determined
 * result (host-crypto roll; the animation never chooses the outcome).
 * three.js is lazily imported (`await import("three")`): the single-file
 * build inlines the chunk as a Blob-URL module, so the ~600 KB library is
 * parsed only on first roll.
 */
import { diceFromTerms, planDieFaces, type DieSpec } from "./dice3dMath";

export interface Dice3dRollInfo {
  formula: string;
  total: number;
  dice: DieSpec[];
}

/** Last-roll readback for e2e (module-level, mirrors the overlay lifecycle). */
export interface Dice3dStats {
  loads: number;
  rolls: number;
  settled: number;
  lastValues: number[];
  lastTotal: number | null;
  disposed: boolean;
}
export const dice3dStats: Dice3dStats = {
  loads: 0,
  rolls: 0,
  settled: 0,
  lastValues: [],
  lastTotal: null,
  disposed: false,
};

const DIE_SIZE = 1.6;
const TUMBLE_MS = 900;
const SETTLE_MS = 450;
const HOLD_MS = 900;

/** Extract display dice from a chat RollRecord's terms. */
export function diceInfoFromRecord(record: {
  formula: string;
  total: number;
  terms: unknown[];
}): Dice3dRollInfo {
  return { formula: record.formula, total: record.total, dice: diceFromTerms(record.terms) };
}

interface DieActor {
  mesh: import("three").Mesh;
  materials: import("three").MeshStandardMaterial[];
  target: import("three").Quaternion;
  spin: { x: number; y: number; z: number };
  delay: number;
}

/**
 * Play one 3D dice roll inside `host`. Resolves when the dice have settled
 * (or immediately when WebGL / three.js is unavailable — chat never blocks).
 */
export async function showDice3D(host: HTMLElement, info: Dice3dRollInfo): Promise<void> {
  if (info.dice.length === 0) return;
  dice3dStats.rolls++;
  dice3dStats.lastValues = info.dice.map((d) => d.value);
  dice3dStats.lastTotal = info.total;
  dice3dStats.disposed = false;

  let THREE: typeof import("three");
  try {
    THREE = await import("three");
    dice3dStats.loads++;
  } catch {
    return; // library unavailable — the chat card still shows the result
  }

  let renderer: import("three").WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch {
    return; // no WebGL context
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 7.5, 11);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 8, 6);
  scene.add(key);

  const width = Math.max(240, host.clientWidth);
  const height = Math.max(160, Math.round(host.clientHeight * 0.5));
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  const canvas = renderer.domElement;
  canvas.setAttribute("data-dice3d-canvas", "");
  canvas.style.cssText = `position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);pointer-events:none;z-index:70;`;
  host.appendChild(canvas);

  const n = info.dice.length;
  const cols = Math.ceil(Math.sqrt(n));
  const dice: DieActor[] = [];
  const disposables: Array<{ dispose(): void }> = [];

  info.dice.forEach((die, i) => {
    const topSlot = (i % 6) as import("./dice3dMath").CubeFace;
    const plan = planDieFaces(die.sides, die.value, topSlot);
    const materials = plan.labels.map((label) => {
      const texture = makeLabelTexture(THREE, label, die.sides);
      disposables.push(texture);
      return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.35, metalness: 0.05 });
    });
    const geometry = new THREE.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE);
    disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, materials);
    const col = i % cols;
    const row = Math.floor(i / cols);
    mesh.position.set(
      (col - (cols - 1) / 2) * (DIE_SIZE + 0.5),
      6 + row * 2.2,
      (row - (Math.ceil(n / cols) - 1) / 2) * 0.6,
    );
    scene.add(mesh);
    const target = new THREE.Quaternion(
      plan.orientation.x,
      plan.orientation.y,
      plan.orientation.z,
      plan.orientation.w,
    );
    dice.push({
      mesh,
      materials,
      target,
      spin: {
        x: 6 + ((i * 2.3) % 5),
        y: 7 + ((i * 3.1) % 5),
        z: 5 + ((i * 1.7) % 5),
      },
      delay: i * 70,
    });
  });

  const t0 = performance.now();
  let settled = false;

  await new Promise<void>((resolve) => {
    renderer.setAnimationLoop(() => {
      const t = performance.now() - t0;
      let allSettled = true;
      for (const die of dice) {
        const local = Math.max(0, t - die.delay);
        if (local < TUMBLE_MS) {
          allSettled = false;
          const k = local / TUMBLE_MS;
          die.mesh.rotation.x += die.spin.x * 0.016;
          die.mesh.rotation.y += die.spin.y * 0.016;
          die.mesh.rotation.z += die.spin.z * 0.016;
          // ballistic drop with a soft bounce
          const p = k * k;
          die.mesh.position.y =
            6 - p * 6 + Math.sin(Math.min(1, k * 1.15) * Math.PI) * (1 - k) * 2.2;
        } else if (local < TUMBLE_MS + SETTLE_MS) {
          allSettled = false;
          const k = (local - TUMBLE_MS) / SETTLE_MS;
          const ease = 1 - Math.pow(1 - k, 3);
          die.mesh.quaternion.slerp(die.target, ease * 0.35);
          die.mesh.position.y += (0 - die.mesh.position.y) * 0.3;
        } else {
          die.mesh.quaternion.copy(die.target);
          die.mesh.position.y = 0;
        }
      }
      renderer.render(scene, camera);
      if (allSettled && !settled) {
        settled = true;
        dice3dStats.settled++;
      }
      if (t > TUMBLE_MS + SETTLE_MS + HOLD_MS + dice.length * 70) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });

  for (const d of dice) for (const m of d.materials) m.dispose();
  for (const d of disposables) d.dispose();
  renderer.dispose();
  canvas.remove();
  dice3dStats.disposed = true;
}

/** Canvas texture with the face label — pip dot for d6, numeral otherwise. */
function makeLabelTexture(
  THREE: typeof import("three"),
  label: number,
  sides: number,
): import("three").CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = sides >= 20 ? "#201410" : "#f4efe6";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = sides >= 20 ? "#f4efe6" : "#201410";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, size - 6, size - 6);
    ctx.fillStyle = sides >= 20 ? "#f4efe6" : "#201410";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = String(label);
    ctx.font = `bold ${text.length > 1 ? 58 : 68}px system-ui, sans-serif`;
    ctx.fillText(text, size / 2, size / 2 + 4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
