import "pixi.js/unsafe-eval"; // Pixi static shader fallback; keep CSP free of unsafe-eval.
import { Application } from "pixi.js";
import { ModelLayer } from "../../canvas/layers/ModelLayer";
import type { Camera, Viewport } from "../../canvas/camera";
import type { Baseline, ModelMarker } from "../../core/strategicRoom/protocol";
import { detailLayer } from "./hostedLayer";

export async function detailRenderer(element: HTMLElement) {
  const app = new Application();
  await app.init({
    preference: "webgl",
    width: Math.max(1, element.clientWidth),
    height: Math.max(1, element.clientHeight),
    backgroundAlpha: 0,
    antialias: false,
    autoStart: false,
    hello: false,
  });
  element.append(app.canvas);
  const layer = new ModelLayer(app, { cellSize: 5, modelSize: 2.5 });
  app.stage.addChild(layer.container);
  let cached: ReturnType<typeof detailLayer> | undefined;
  let previousView: Baseline | undefined;
  let previousModels: ReadonlyMap<string, ModelMarker> | undefined;
  return {
    draw(
      view: Baseline,
      models: ReadonlyMap<string, ModelMarker>,
      camera: Camera,
      viewport: Viewport,
      zoomOutUnitToken = false,
    ) {
      layer.setZoomOutUnitToken(zoomOutUnitToken);
      if (!cached || view !== previousView || models !== previousModels) {
        cached = detailLayer(view, models);
        previousView = view;
        previousModels = models;
      }
      if (
        app.screen.width !== viewport.width ||
        app.screen.height !== viewport.height
      )
        app.renderer.resize(viewport.width, viewport.height);
      layer.container.scale.set(camera.scale);
      layer.container.position.set(
        -camera.x * camera.scale,
        -camera.y * camera.scale,
      );
      layer.sync(cached.pool, cached.units, camera, viewport);
      app.render();
    },
    destroy() {
      layer.destroy();
      app.destroy(true, { children: true });
    },
  };
}
