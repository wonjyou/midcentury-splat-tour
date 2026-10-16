# Mid-century splat tour

A rental-listing page for a fictional 1958 Palm Springs living room, where the photo slot is a live 3D room built from Gaussian splats. Move your mouse and the view turns and shifts. Turn on Live view and the room follows your head instead, so the screen behaves like a window you can peek through and look around.

"Stayhaus", the host and the listing are made up. Nothing on the page books anything.

## Running it

It's plain HTML and ES modules with no build step. The camera only works from a secure context, and `localhost` counts, so serve it locally:

```bash
node serve.js
```

Then open http://localhost:8775. Any static server works too, as long as it serves the `js/` folder.

You need a browser with WebGL2. Chrome, Edge, Safari 15+ and Firefox all work. Live view also needs a webcam and permission to use it.

## What you can do

The tour has five stops: the living room, the desert window, the reading corner, the credenza and the sofa. Use the chips at the bottom of the viewer, the arrow keys, or the play button for an automatic tour.

With the mouse, the view turns toward the pointer and slides a little for parallax. If you leave it alone for a few seconds it drifts slowly on its own.

Live view is opt-in. Click the Live view button and allow the camera. Leaning moves your eye position, and turning or tilting your head turns the camera, amplified so a small turn shows the side of the room. Recenter (or the R key) makes your current posture the new neutral. The webcam image is never shown or uploaded. Frames go straight into a face model running in the browser.

## How it works

### The room

`js/scene.js` builds the room procedurally as about 566,000 3D Gaussians. Flat surfaces are grids of thin discs, rods and lamp arcs are chains of needle-shaped splats, and cushions and furniture edges are rounded boxes. Each splat gets an albedo, a normal and a material (oak, walnut, leather, brass, glaze, fabric and so on).

The lighting is path-traced once, when the page loads, in a worker (`js/build-worker.js`). The room is voxelised at 5 cm, and for every splat the baker traces:

- shadow rays toward the sun, through the window aperture and mullions, with a few jittered directions for soft edges
- shadow rays toward the arc lamp and the table lamp
- 20 cosine-weighted rays to gather sky light through the glass and one bounce of coloured light off nearby surfaces

The gathered light is denoised over a 30 cm neighbourhood of splats facing the same way. The result is linear HDR radiance, stored per splat with a gamma curve so it fits in 8 bits. On a laptop the whole build takes about three seconds.

### Rendering

`js/renderer.js` is a small WebGL2 splat rasterizer. Splat data lives in an integer texture, three texels per splat. The vertex shader projects each 3D covariance to a screen-space ellipse using the Jacobian of the projection, and draws it as an instanced quad. It also adds view-dependent specular for glossy materials, so highlights on the floor, brass and leather move as you do.

Splats are blended front to back into a half-float buffer, sorted by depth in `js/sort-worker.js` with a 16-bit counting sort whenever the camera moves. A final pass adds bloom, ACES tone mapping, a vignette and a little grain.

### The window effect

`js/main.js` builds an off-axis projection. The screen is treated as a fixed rectangle in front of the viewer, and the eye moves relative to it, so the frustum becomes asymmetric as you lean. Head yaw and pitch rotate the camera on top of that.

### Tracking

`js/tracking.js` uses the MediaPipe Face Landmarker (loaded from jsDelivr, model from Google's storage bucket). Eye and nose positions are averaged over several landmarks each, then run through a One Euro filter, which smooths heavily when you're still and loosens when you move fast. Head turn comes from where the nose sits relative to the eyes. A short calibration when Live view starts sets your neutral pose.

## Loading a real capture

The procedural room is the default, but the tour can also show a real Gaussian splat capture from Polycam, Luma, Scaniverse or a standard 3DGS training run. There's no button for it. Either open the page with a URL:

```
http://localhost:8775/?scene=https://example.com/room.ply
```

or drag a `.ply` or `.splat` file onto the viewer. `js/capture.js` reads standard binary 3DGS `.ply` files and the 32-byte `.splat` format, levels the capture, puts the floor at y = 0, scales non-metric captures to room size and picks two starting viewpoints. If a capture comes in upside down or facing the wrong way, small controls appear to flip or turn it.

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `styles.css` | The listing page and viewer UI |
| `js/main.js` | Tour stops, camera and projection, UI wiring, frame loop |
| `js/renderer.js` | WebGL2 splat renderer and post-processing |
| `js/scene.js` | Procedural room and the light baker |
| `js/build-worker.js` | Runs the room build off the main thread |
| `js/sort-worker.js` | Per-view depth sort |
| `js/tracking.js` | Pointer input and webcam face tracking |
| `js/capture.js`, `js/capture-worker.js` | `.ply` / `.splat` capture loading |
| `serve.js` | Minimal static server on port 8775 |

## Credits

Face tracking uses [MediaPipe Tasks Vision](https://developers.google.com/mediapipe/solutions/vision/face_landmarker). Fonts are DM Sans and Fraunces from Google Fonts. The splat projection follows the EWA approach from the original 3D Gaussian Splatting paper (Kerbl et al., 2023), and the One Euro filter is from Casiez, Roussel and Vogel (2012).
