// @oar/renderer — WebGL2 drawing. Takes a solved model, draws it.
//
// Premultiplied alpha is non-negotiable, and all five points must agree:
//   1. context created with premultipliedAlpha: true
//   2. UNPACK_PREMULTIPLY_ALPHA_WEBGL before every texImage2D
//   3. blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
//   4. the shader outputs colour × uAlpha (texture is already premultiplied)
//   5. the clear colour is premultiplied too
// Miss any one and dark fringes return around traced artwork.

import type { SolvedModel, SolvedLayer } from "@oar/core";

export interface CameraState {
  /** canvas-space point at the viewport centre */
  x: number;
  y: number;
  zoom: number;
}

const VERT = `#version 300 es
in vec2 aPos;
in vec2 aUV;
uniform mat3 uView;
out vec2 vUV;
void main() {
  vec3 p = uView * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uAlpha;
void main() {
  vec4 c = texture(uTex, vUV);
  outColor = c * uAlpha; // premultiplied in, premultiplied out
}`;

const MASK_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  float a = texture(uTex, vUV).a;
  if (a < 0.02) discard;
  outColor = vec4(1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private maskProgram: WebGLProgram;
  private posBuffer: WebGLBuffer;
  private uvBuffer: WebGLBuffer;
  private idxBuffer: WebGLBuffer;
  private textures = new Map<string, WebGLTexture>();
  private aPos: number;
  private aUV: number;
  private aPosMask: number;
  private aUVMask: number;
  private uView: WebGLUniformLocation | null;
  private uViewMask: WebGLUniformLocation | null;
  private uAlpha: WebGLUniformLocation | null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      alpha: true,
      stencil: true,
      antialias: true,
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.program = link(gl, VERT, FRAG);
    this.maskProgram = link(gl, VERT, MASK_FRAG);
    this.posBuffer = gl.createBuffer()!;
    this.uvBuffer = gl.createBuffer()!;
    this.idxBuffer = gl.createBuffer()!;
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aUV = gl.getAttribLocation(this.program, "aUV");
    this.aPosMask = gl.getAttribLocation(this.maskProgram, "aPos");
    this.aUVMask = gl.getAttribLocation(this.maskProgram, "aUV");
    this.uView = gl.getUniformLocation(this.program, "uView");
    this.uViewMask = gl.getUniformLocation(this.maskProgram, "uView");
    this.uAlpha = gl.getUniformLocation(this.program, "uAlpha");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST); // painter's order, back to front
  }

  setTexture(id: string, source: TexImageSource): void {
    const gl = this.gl;
    let tex = this.textures.get(id);
    if (!tex) {
      tex = gl.createTexture()!;
      this.textures.set(id, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  deleteTexture(id: string): void {
    const tex = this.textures.get(id);
    if (tex) {
      this.gl.deleteTexture(tex);
      this.textures.delete(id);
    }
  }

  clear(r: number, g: number, b: number, a: number): void {
    const gl = this.gl;
    // Premultiply the clear colour too.
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }

  private viewMatrix(cam: CameraState): Float32Array {
    // Zoom is expressed in CSS pixels (the overlay uses them too). The
    // drawing buffer is clientSize × devicePixelRatio, so it must not be
    // used here, or the render shrinks by 1/DPR relative to the overlay.
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    const a = (2 * cam.zoom) / w;
    const d = (-2 * cam.zoom) / h;
    const e = -cam.x * a;
    const f = -cam.y * d;
    // column-major mat3
    return new Float32Array([a, 0, 0, 0, d, 0, e, f, 1]);
  }

  private drawMesh(
    positions: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    textureId: string,
    alpha: number,
    mask: boolean,
  ): void {
    const gl = this.gl;
    const prog = mask ? this.maskProgram : this.program;
    gl.useProgram(prog);
    gl.uniformMatrix3fv(mask ? this.uViewMask : this.uView, false, this.viewMatrix(this.cam));
    if (!mask) gl.uniform1f(this.uAlpha, alpha);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    const aPos = mask ? this.aPosMask : this.aPos;
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.DYNAMIC_DRAW);
    const aUV = mask ? this.aUVMask : this.aUV;
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

    const tex = this.textures.get(textureId);
    gl.bindTexture(gl.TEXTURE_2D, tex ?? null);
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
  }

  private cam: CameraState = { x: 0, y: 0, zoom: 1 };

  draw(solved: SolvedModel, cam: CameraState, background: [number, number, number, number] = [0.13, 0.14, 0.17, 1]): void {
    this.cam = cam;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.clear(...background);

    const byId = new Map(solved.layers.map((l) => [l.id, l]));
    for (const layer of solved.layers) {
      if (!layer.visible || layer.alpha <= 0.001) continue;
      const positions = new Float32Array(layer.positions.length * 2);
      for (let i = 0; i < layer.positions.length; i++) {
        positions[i * 2] = layer.positions[i]![0];
        positions[i * 2 + 1] = layer.positions[i]![1];
      }
      const uvs = new Float32Array(layer.uvs.length * 2);
      for (let i = 0; i < layer.uvs.length; i++) {
        uvs[i * 2] = layer.uvs[i]![0];
        uvs[i * 2 + 1] = layer.uvs[i]![1];
      }
      const indices = new Uint32Array(layer.triangles.length * 3);
      for (let i = 0; i < layer.triangles.length; i++) {
        indices[i * 3] = layer.triangles[i]![0];
        indices[i * 3 + 1] = layer.triangles[i]![1];
        indices[i * 3 + 2] = layer.triangles[i]![2];
      }

      if (layer.clipTo) {
        // Runtime clipping (iris): stamp the base layer's alpha into the
        // stencil at the clipped layer's moment in painter's order, then draw
        // only where the base currently is. Baked clips freeze the iris in
        // the shape of the eye at rest; this does not.
        const base = byId.get(layer.clipTo);
        if (base && base.visible) {
          const basePos = new Float32Array(base.positions.length * 2);
          for (let i = 0; i < base.positions.length; i++) {
            basePos[i * 2] = base.positions[i]![0];
            basePos[i * 2 + 1] = base.positions[i]![1];
          }
          const baseUv = new Float32Array(base.uvs.length * 2);
          for (let i = 0; i < base.uvs.length; i++) {
            baseUv[i * 2] = base.uvs[i]![0];
            baseUv[i * 2 + 1] = base.uvs[i]![1];
          }
          const baseIdx = new Uint32Array(base.triangles.length * 3);
          for (let i = 0; i < base.triangles.length; i++) {
            baseIdx[i * 3] = base.triangles[i]![0];
            baseIdx[i * 3 + 1] = base.triangles[i]![1];
            baseIdx[i * 3 + 2] = base.triangles[i]![2];
          }
          gl.enable(gl.STENCIL_TEST);
          gl.colorMask(false, false, false, false);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
          this.drawMesh(basePos, baseUv, baseIdx, base.id, 1, true);
          gl.colorMask(true, true, true, true);
          gl.stencilFunc(gl.EQUAL, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          this.drawMesh(positions, uvs, indices, layer.id, layer.alpha, false);
          gl.disable(gl.STENCIL_TEST);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          continue;
        }
        // Base missing or invisible: clipped layer cannot show.
        continue;
      }
      this.drawMesh(positions, uvs, indices, layer.id, layer.alpha, false);
    }
  }
}
