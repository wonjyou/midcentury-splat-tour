# Mid-century splat tour

A rental-listing page for a fictional 1958 Palm Springs living room, where the photo slot is a live 3D room built from Gaussian splats. Move your mouse (or drag on a phone) and the view turns and shifts. Turn on Live view and the room follows your head instead, so the screen behaves like a window you can peek through and look around.

"Stayhaus", the host and the listing are made up. Nothing on the page books anything.

The splat renderer, camera and tracking live in a small, reusable engine (`js/engine/`). The listing page is one app built on it.

## Running it

It's plain HTML and ES modules with no build step. The camera only works from a secure context, and `localhost` counts, so serve it locally:

```bash
node serve.js
```

Then open http://localhost:8775. Any static server works too.

You need a browser with WebGL2. Chrome, Edge, Safari 15+ and Firefox all work. Live view also needs a webcam (or, on a phone, motion sensors) and permission to use it.

## Using the tour

The tour has five stops: the living room, the desert window, the reading corner, the credenza and the sofa. Use the chips at the bottom of the viewer, the arrow keys, or the play button for an automatic tour.

With a mouse, the view turns toward the pointer and slides a little for parallax. If you leave it alone for a few seconds it drifts slowly on its own. On a touch screen, drag sideways across the room to look around; vertical swipes still scroll the page.

Live view is opt-in. Click the Live view button and allow the camera. Leaning moves your eye position, and turning or tilting your head turns the camera, amplified so a small turn shows the side of the room. Recenter (or the R key) makes your current posture the new neutral. On a phone without a usable camera, Live view falls back to the phone's motion: turn and tilt it to look around. The webcam image is never shown or uploaded. Frames go straight into a face model running in the browser.

## Phones and small screens

The page is responsive. On phones the room runs edge to edge, controls are sized for thumbs, and a reserve bar slides up from the bottom once you've scrolled past the room. Held sideways, the room fills the screen.

Quality adapts to the device. Phones and low-memory machines get a lighter build of the room (about 342,000 splats instead of 566,000, with fewer bounce rays in the light bake), a lower pixel ratio and one bloom pass. While running, the render scale drops if frames get slow and comes back when they recover. The viewer stops rendering when it's scrolled off screen or the tab is hidden. Add `?quality=high` or `?quality=low` to the URL to override the choice.

People who ask their system for reduced motion get no idle drift, no load-in sweep and instant cuts between stops.

## How it works

### The room

`js/room/scene.js` builds the room procedurally as 3D Gaussians. Flat surfaces are grids of thin discs, rods and lamp arcs are chains of needle-shaped splats, and cushions and furniture edges are rounded boxes. Each splat gets an albedo, a normal and a material (oak, walnut, leather, brass, glaze, fabric and so on).

The lighting is path-traced once, when the page loads, in a worker. The room is voxelised at 5 cm, and for every splat the baker traces:

- shadow rays toward the sun, through the window aperture and mullions, with a few jittered directions for soft edges
- shadow rays toward the arc lamp and the table lamp
- cosine-weighted rays (20 on high quality, 9 on low) to gather sky light through the glass and one bounce of coloured light off nearby surfaces

The gathered light is denoised over a 30 cm neighbourhood of splats facing the same way. The result is linear HDR radiance, stored per splat with a gamma curve so it fits in 8 bits.

### Rendering

`js/engine/renderer.js` is a small WebGL2 splat rasterizer. Splat data lives in an integer texture, three texels per splat. The vertex shader projects each 3D covariance to a screen-space ellipse using the Jacobian of the projection, and draws it as an instanced quad. It also adds view-dependent specular for glossy materials, so highlights on the floor, brass and leather move as you do.

Splats are blended front to back into a half-float buffer, sorted by depth in a worker with a 16-bit counting sort whenever the camera moves. A final pass adds bloom, ACES tone mapping, a vignette and a little grain.

### The window effect

`js/engine/camera.js` builds an off-axis projection. The screen is treated as a fixed rectangle in front of the viewer, and the eye moves relative to it, so the frustum becomes asymmetric as you lean. Head yaw and pitch rotate the camera on top of that.

### Tracking

`js/engine/input/head.js` uses the MediaPipe Face Landmarker (loaded from jsDelivr, model from Google's storage bucket). Eye and nose positions are averaged over several landmarks each, then run through a One Euro filter, which smooths heavily when you're still and loosens when you move fast. Head turn comes from where the nose sits relative to the eyes. A short calibration when Live view starts sets your neutral pose.

## Using the engine

`js/engine/index.js` exports everything. A minimal page:

```html
<div id="stage" style="position:relative;height:100vh"></div>
<script type="module">
  import { SplatViewer, captureSource } from './js/engine/index.js';

  const viewer = new SplatViewer(document.getElementById('stage'));
  await viewer.show(captureSource({ url: 'room.ply' }));

  // Optional: follow the visitor's head (call from a click).
  document.body.onclick = () => viewer.input.startHead();
</script>
```

`SplatViewer` owns the canvas, renderer, depth sorter, tour rig and inputs. It emits `progress`, `scene` and `stop` events, and has `goTo`, `next`, `prev` and `setAutoplay` for tours. `viewer.input` exposes `startHead()`, `startMotion()`, `stop()` and `recenter()`; the pointer and touch-drag input is always on.

A scene source is any object with `load(onProgress)` that resolves to `{ scene, meta }`. `scene` is a set of typed arrays described at the top of `js/engine/format.js`: positions, covariances, encoded colours, packed normals and a material word per splat. `meta` can carry tour `stops` (each `{ pos, target }` plus anything your UI wants, like a name), a `lights` rig for specular highlights, and a `reveal` for the load-in sweep. The engine ships two kinds of source:

- `workerSource(url, { message, meta })` runs a module worker that builds a scene. Inside the worker, `serveBuilder(build)` handles the protocol; `js/room/build-worker.js` is a three-line example.
- `captureSource({ file | url, options })` loads a captured `.ply` or `.splat` file (see below).

| Module | What it does |
| --- | --- |
| `engine/viewer.js` | `SplatViewer`: frame loop, adaptive quality, visibility pausing |
| `engine/renderer.js` | WebGL2 splat renderer and post-processing |
| `engine/sorter.js`, `engine/sort-worker.js` | Per-view depth sort in a worker |
| `engine/camera.js` | Off-axis window camera and the tour rig |
| `engine/input/controller.js` | Picks the active input and smooths it |
| `engine/input/pointer.js` | Mouse hover look and touch drag look |
| `engine/input/head.js` | Webcam head tracking |
| `engine/input/motion.js` | Device orientation |
| `engine/input/filters.js` | One Euro filter |
| `engine/sources.js` | Worker and capture scene sources |
| `engine/format.js` | The splat data contract, materials and packing helpers |
| `engine/loaders/` | `.ply` / `.splat` parsing, levelling and framing |
| `room/` | The procedural mid-century room, its light bake and tour stops |
| `app.js`, `index.html`, `styles.css` | The listing page |
| `serve.js` | Minimal static server on port 8775 |

## Loading a real capture

The procedural room is the default, but the tour can also show a real Gaussian splat capture. There's no button for it. Either open the page with a URL:

```
http://localhost:8775/?scene=https://example.com/room.ply
```

or drag a `.ply` or `.splat` file onto the viewer. Add `&flip=1` and `&turn=N` (N from 0 to 3, in quarter turns) to open a capture already corrected; some public samples need `&flip=1`.

The loader reads uncompressed binary 3DGS `.ply` files and the 32-byte `.splat` format. It levels the capture, puts the floor at y = 0, scales non-metric captures to room size and picks two starting viewpoints. Only the base colour is used; the higher spherical-harmonic terms that give view-dependent colour are dropped. Compressed `.ply` exports (SuperSplat, PlayCanvas) show a "not supported yet" message, and `.spz` (Scaniverse) and `.ksplat` files aren't read, so exports in those formats need converting first.

Whenever a capture is showing, three controls appear: Flip, Turn 90° and Back to the room. Back to the room returns to the furnished room and clears `?scene=` from the URL.

## Credits

Face tracking uses [MediaPipe Tasks Vision](https://developers.google.com/mediapipe/solutions/vision/face_landmarker). Fonts are DM Sans and Fraunces from Google Fonts. The splat projection follows the EWA approach from the original 3D Gaussian Splatting paper (Kerbl et al., 2023), and the One Euro filter is from Casiez, Roussel and Vogel (2012).
