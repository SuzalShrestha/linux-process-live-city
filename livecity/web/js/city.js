// The 3D city: every process is an instanced, shader-lit glass tower.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import {
  CELL, COLOR_METRICS, HEIGHT_METRICS, computeLayout, footprint,
} from './layout.js';
import { esc as escapeHtml } from './format.js';

const FOG_COLOR = new THREE.Color('#0a1330');
const STATUS_CODE = { zombie: 1, stopped: 2, 'tracing-stop': 2 };

// ------------------------------------------------------------- shaders
const BUILDING_VERT = /* glsl */`
  attribute vec4 aData;   // heat, seed, hover, dim
  attribute vec4 aData2;  // status, io, birth, selected
  uniform float uReflect;
  varying vec3 vLocal;
  varying vec3 vScale;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vData;
  varying vec4 vData2;
  varying float vDepth;
  void main() {
    vLocal = position;
    vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vNormal = normal;
    vData = aData;
    vData2 = aData2;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    if (uReflect > 0.5) world.y = -world.y;
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BUILDING_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uReflect;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uGlassCool, uGlassHot, uEdgeCool, uEdgeHot, uWinCool, uWinHot;
  varying vec3 vLocal;
  varying vec3 vScale;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vData;
  varying vec4 vData2;
  varying float vDepth;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    float heat = vData.x, seed = vData.y, hover = vData.z, dim = vData.w;
    float status = vData2.x, io = vData2.y, birth = vData2.z, sel = vData2.w;
    vec3 n = normalize(vNormal);
    if (n.y < -0.5) discard;

    // Face-local coordinates in world units, so windows keep their size
    // no matter how tall or wide a tower is.
    vec2 uv; vec2 size; float face;
    if (n.y > 0.5) {
      uv = (vLocal.xz + 0.5) * vScale.xz; size = vScale.xz; face = 4.0;
    } else if (abs(n.x) > 0.5) {
      uv = vec2((vLocal.z + 0.5) * vScale.z, vLocal.y * vScale.y); size = vec2(vScale.z, vScale.y);
      face = n.x > 0.0 ? 0.0 : 1.0;
    } else {
      uv = vec2((vLocal.x + 0.5) * vScale.x, vLocal.y * vScale.y); size = vec2(vScale.x, vScale.y);
      face = n.z > 0.0 ? 2.0 : 3.0;
    }

    // Snap quickly from blue to orange: a plain RGB blend lingers in pink.
    float tint = smoothstep(0.2, 0.34, heat);
    vec3 glass = mix(uGlassCool, uGlassHot, tint);
    vec3 edgeCol = mix(uEdgeCool, uEdgeHot, tint);
    vec3 winCol = mix(uWinCool, uWinHot, tint);
    edgeCol = mix(edgeCol, vec3(0.55, 1.0, 1.25), sel);

    float h01 = vLocal.y;
    vec3 col = glass * (0.35 + 0.65 * h01);

    // Cheap fake reflection of the sky on glass at grazing angles.
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - abs(dot(V, n)), 3.0);
    col += edgeCol * fres * 0.12;

    if (face < 4.0) {
      vec2 cell = vec2(0.24, 0.36);
      vec2 g = uv / cell;
      vec2 gi = floor(g);
      vec2 gf = fract(g);
      float inside = step(0.14, uv.x) * step(0.14, size.x - uv.x) * step(0.16, uv.y) * step(0.12, size.y - uv.y);
      float pane = smoothstep(0.14, 0.24, gf.x) * (1.0 - smoothstep(0.76, 0.86, gf.x))
                 * smoothstep(0.16, 0.26, gf.y) * (1.0 - smoothstep(0.76, 0.86, gf.y));
      float r = hash(gi + vec2(seed * 91.7 + face * 13.1, seed * 17.3));
      // Windows switch on/off slowly; busier processes light more of them.
      float epoch = floor(uTime * 0.12 + r * 9.0);
      float r2 = hash(gi * 1.37 + vec2(epoch, seed * 3.1));
      float lit = step(r2, 0.05 + heat * 0.92);
      float bright = 0.55 + 0.45 * hash(gi + seed * 5.0);
      col += winCol * pane * inside * (0.05 + lit * bright * (0.4 + 1.5 * heat));
      // Thin floor bands, like the lit slabs of an office tower.
      float band = 1.0 - smoothstep(0.0, 0.07, abs(gf.y - 0.03));
      col += winCol * band * inside * (0.03 + 0.3 * heat);
      // Scanline climbing the tower: speed tracks CPU load.
      float s = fract(h01 * 0.999 - uTime * (0.08 + heat * 0.45) + seed);
      float scan = exp(-pow((s - 0.5) * 28.0, 2.0)) * smoothstep(0.04, 0.2, heat);
      col += edgeCol * scan * 0.6;
    } else {
      // Rooftop: a dim grid plus a beacon that pulses with disk IO.
      vec2 c = uv - size * 0.5;
      float beacon = exp(-dot(c, c) * 5.0) * io * (0.6 + 0.4 * sin(uTime * 7.0 + seed * 20.0));
      col = glass * 1.25 + winCol * beacon * 2.5;
    }

    // Glowing edges (antialiased with screen-space derivatives).
    vec2 dEdge = min(uv, size - uv);
    float de = min(dEdge.x, dEdge.y);
    float ew = 0.045 + 0.035 * hover + 0.05 * sel;
    float edge = 1.0 - smoothstep(ew, ew + fwidth(de) * 1.5, de);
    float pulse = 1.0 + sel * (0.6 + 0.6 * sin(uTime * 4.0));
    col = mix(col, edgeCol * (1.0 + 0.8 * hover) * pulse, edge);
    col += edgeCol * hover * 0.12;

    // Process state tints.
    float luma = dot(col, vec3(0.3, 0.59, 0.11));
    if (status > 0.5 && status < 1.5) {        // zombie: flickering green ghost
      col = mix(col, vec3(0.2, 1.0, 0.45) * (luma + 0.05), 0.8) * (0.6 + 0.4 * step(0.3, hash(vec2(floor(uTime * 8.0), seed))));
    } else if (status > 1.5 && status < 2.5) { // stopped: frozen violet
      col = mix(col, vec3(0.55, 0.3, 1.0) * (luma + 0.08), 0.75);
    } else if (status > 2.5) {                 // no permission to inspect
      col = mix(col, vec3(luma) * vec3(0.55, 0.65, 0.9), 0.55);
    }

    col += vec3(1.0, 0.85, 0.6) * birth * 0.9;
    col = mix(col, vec3(luma) * 0.12, dim * 0.88);

    if (uReflect > 0.5) {
      float below = vLocal.y * vScale.y;
      col *= 0.22 * exp(-below * 0.09);
    }

    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
  }
`;

const GROUND_VERT = /* glsl */`
  varying vec3 vWorld;
  varying float vDepth;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const GROUND_FRAG = /* glsl */`
  uniform float uCell;
  uniform float uRadius;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying vec3 vWorld;
  varying float vDepth;
  float grid(vec2 p) {
    vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  void main() {
    vec2 p = vWorld.xz;
    float minor = grid(p / uCell);
    float major = grid(p / (uCell * 8.0));
    float r = length(p);
    vec3 col = vec3(0.003, 0.005, 0.014);
    col += vec3(0.02, 0.045, 0.13) * minor * 0.12;
    col += vec3(0.05, 0.1, 0.32) * major * 0.25;
    col += vec3(0.06, 0.03, 0.09) * exp(-r / max(uRadius, 1.0) * 1.4);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    gl_FragColor = vec4(mix(col, uFogColor, fog), mix(0.8, 1.0, fog));
  }
`;

const PLATE_FRAG = /* glsl */`
  uniform vec2 uSize;
  uniform vec3 uColor;
  uniform float uGlow;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * uSize;
    vec2 d = min(p, uSize - p);
    float e = min(d.x, d.y);
    float border = 1.0 - smoothstep(0.05, 0.05 + fwidth(e) * 1.5, e);
    float inner = 1.0 - smoothstep(0.55, 0.6 + fwidth(e), abs(e - 0.6));
    // Dashed curb lights along the edge.
    float along = d.x < d.y ? p.y : p.x;
    float dash = step(0.5, fract(along * 0.5)) * inner * 0.1;
    vec3 col = uColor * (border * (0.45 + uGlow) + dash + 0.012);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SIMPLE_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const SKY_FRAG = /* glsl */`
  uniform vec3 uHorizon;
  varying vec3 vDir;
  void main() {
    float y = normalize(vDir).y;
    vec3 horizon = uHorizon;
    vec3 top = vec3(0.001, 0.002, 0.006);
    vec3 col = mix(horizon, top, smoothstep(-0.05, 0.5, y));
    col += vec3(0.06, 0.03, 0.02) * exp(-abs(y) * 18.0); // amber haze on the horizon
    gl_FragColor = vec4(col, 1.0);
  }
`;

const LINK_VERT = /* glsl */`
  attribute float aT;
  attribute float aKind;
  varying float vT;
  varying float vKind;
  void main() {
    vT = aT; vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LINK_FRAG = /* glsl */`
  uniform float uTime;
  varying float vT;
  varying float vKind;
  void main() {
    float flow = fract(vT * 5.0 - uTime * 0.9);
    float blip = smoothstep(0.0, 0.25, flow) * (1.0 - smoothstep(0.35, 0.6, flow));
    vec3 c; float k;
    if (vKind < 0.5) { c = vec3(0.3, 0.9, 1.4); k = 1.0; }        // to parent
    else if (vKind < 1.5) { c = vec3(1.4, 0.6, 0.15); k = 1.0; }  // to children
    else { c = vec3(0.25, 0.4, 1.0); k = 0.22; }                  // whole tree
    gl_FragColor = vec4(c * k * (0.3 + blip * 1.4), 1.0);
  }
`;

const BEAM_FRAG = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float a = pow(1.0 - vUv.y, 4.0) * (0.14 + 0.05 * sin(uTime * 3.0));
    gl_FragColor = vec4(vec3(0.35, 0.85, 1.2) * a, 1.0);
  }
`;

const DUST_VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime;
  uniform float uHeight;
  uniform float uPixel;
  varying float vSeed;
  void main() {
    vec3 p = position;
    p.y = mod(p.y + uTime * (0.4 + aSeed * 1.2), uHeight);
    p.x += sin(uTime * 0.2 + aSeed * 30.0) * 0.01;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uPixel * (0.6 + aSeed) * 30.0 / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */`
  varying float vSeed;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    vec3 c = vSeed > 0.5 ? vec3(1.0, 0.5, 0.15) : vec3(0.3, 0.5, 1.0);
    gl_FragColor = vec4(c * a * 0.5, 1.0);
  }
`;

function lin(hex) { return new THREE.Color(hex); }

// ---------------------------------------------------------------- City
export class City {
  constructor(container) {
    this.container = container;
    this.buildings = new Map();   // pid -> building state
    this.districts = new Map();   // key -> district state
    this.order = [];              // instance index -> building
    this.hovered = null;
    this.selectedPid = null;
    this.filter = null;
    this.opts = { groupBy: 'app', height: 'memory', color: 'cpu', showKernel: true, links: false, labels: true };
    this.radius = 60;
    this.hasFramed = false;
    this.onHover = () => {};
    this.onSelect = () => {};
    this.onAutoRotate = () => {};
    this.timer = new THREE.Timer();
    this.capacity = 0;

    this._initRenderer();
    this._initScene();
    this._initInput();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  // ---------------------------------------------------------------- setup
  _initRenderer() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(this.container.clientWidth, this.container.clientHeight);
    r.toneMapping = THREE.NoToneMapping;
    this.container.appendChild(r.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(this.container.clientWidth, this.container.clientHeight);
    this.labels.domElement.className = 'label-layer';
    this.container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(42, this.container.clientWidth / this.container.clientHeight, 0.5, 6000);
    this.camera.position.set(90, 80, 110);

    const c = this.controls = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.47;
    c.minDistance = 4;
    c.maxDistance = 1500;
    c.autoRotate = true;
    c.autoRotateSpeed = 0.35;
    c.screenSpacePanning = false;
    c.addEventListener('start', () => {
      this.flight = null;
      if (c.autoRotate) { c.autoRotate = false; this.onAutoRotate(false); }
    });

    this.scene = new THREE.Scene();
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  _initScene() {
    const fogUniforms = { uFogColor: { value: FOG_COLOR }, uFogDensity: { value: 0.004 } };
    this.fogUniforms = fogUniforms;
    this.time = { value: 0 };

    // Sky dome.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2500, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: SKY_FRAG,
        uniforms: { uHorizon: { value: FOG_COLOR } },
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    sky.renderOrder = -10;
    this.scene.add(sky);
    this.sky = sky;

    // Ground (semi-transparent so the mirrored towers show through).
    this.groundUniforms = { uCell: { value: CELL }, uRadius: { value: 60 }, ...fogUniforms };
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.ShaderMaterial({
        vertexShader: GROUND_VERT,
        fragmentShader: GROUND_FRAG,
        uniforms: this.groundUniforms,
        transparent: true,
        depthWrite: true,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.renderOrder = -5;
    this.scene.add(ground);

    // Buildings: one instanced unit box, pivot at the base.
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometry.translate(0, 0.5, 0);
    const uniforms = {
      uTime: this.time,
      uReflect: { value: 0 },
      uGlassCool: { value: lin('#0b1438') },
      uGlassHot: { value: lin('#4a1606') },
      uEdgeCool: { value: lin('#4f7dff') },
      uEdgeHot: { value: lin('#ff9540') },
      uWinCool: { value: lin('#2c46a8') },
      uWinHot: { value: lin('#ffa640') },
      ...fogUniforms,
    };
    this.buildingMat = new THREE.ShaderMaterial({ vertexShader: BUILDING_VERT, fragmentShader: BUILDING_FRAG, uniforms });
    this.reflectMat = new THREE.ShaderMaterial({
      vertexShader: BUILDING_VERT,
      fragmentShader: BUILDING_FRAG,
      uniforms: { ...uniforms, uReflect: { value: 1 } },
      side: THREE.DoubleSide,
    });
    this._ensureCapacity(1024);

    // Parent/child links.
    this.linkGeo = new THREE.BufferGeometry();
    this.linkMat = new THREE.ShaderMaterial({
      vertexShader: LINK_VERT,
      fragmentShader: LINK_FRAG,
      uniforms: { uTime: this.time },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.links = new THREE.LineSegments(this.linkGeo, this.linkMat);
    this.links.frustumCulled = false;
    this.scene.add(this.links);

    // Selection beam.
    const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32, 1, true);
    beamGeo.translate(0, 0.5, 0);
    this.beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      vertexShader: SIMPLE_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uTime: this.time },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.beam.visible = false;
    this.scene.add(this.beam);

    const tag = document.createElement('div');
    tag.className = 'bldg-label';
    this.selLabel = new CSS2DObject(tag);
    this.selLabel.visible = false;
    this.scene.add(this.selLabel);

    // Floating dust for atmosphere.
    const N = 1400;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 2;
      pos[i * 3 + 1] = Math.random() * 90;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 2;
      seed[i] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: { uTime: this.time, uHeight: { value: 90 }, uPixel: { value: this.renderer.getPixelRatio() } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }));
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  _ensureCapacity(n) {
    if (n <= this.capacity) return;
    const cap = Math.max(1024, 2 ** Math.ceil(Math.log2(n)));
    if (this.mesh) {
      this.scene.remove(this.mesh, this.mirror);
      this.mesh.geometry.dispose();
    }
    const geo = this.geometry.clone();
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aData2 = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aData', this.aData);
    geo.setAttribute('aData2', this.aData2);

    this.mesh = new THREE.InstancedMesh(geo, this.buildingMat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mirror = new THREE.InstancedMesh(geo, this.reflectMat, cap);
    this.mirror.instanceMatrix = this.mesh.instanceMatrix; // share, so one upload drives both
    this.mirror.frustumCulled = false;
    this.mirror.renderOrder = -8;
    this.mirror.count = 0;
    this.scene.add(this.mirror, this.mesh);
    this.capacity = cap;
  }

  _initInput() {
    const el = this.renderer.domElement;
    this.pointer = new THREE.Vector2(2, 2);
    this.raycaster = new THREE.Raycaster();
    this.needsPick = false;
    let down = null;
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.pointerClient = { x: e.clientX, y: e.clientY };
      this.needsPick = true;
    });
    el.addEventListener('pointerleave', () => { this.pointer.set(2, 2); this.needsPick = true; });
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      down = null;
      const b = this._pick();
      if (b) this.select(b.pid, { fly: true });
      else if (e.button === 0) this.select(null);
    });
    el.addEventListener('dblclick', () => {
      const b = this._pick();
      if (b) this.focus(b.pid, true);
    });
  }

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  // ----------------------------------------------------------------- data
  setOptions(patch) {
    const relayout = ['groupBy', 'height', 'color', 'showKernel'].some((k) => k in patch && patch[k] !== this.opts[k]);
    Object.assign(this.opts, patch);
    if (relayout && this.lastProcs) this.setData(this.lastProcs, this.lastNow);
    for (const d of this.districts.values()) d.label.visible = this.opts.labels && d.showLabel;
  }

  setFilter(fn) { this.filter = fn; }

  setData(procs, now) {
    this.lastProcs = procs;
    this.lastNow = now;
    const visible = this.opts.showKernel ? procs : procs.filter((p) => !p.kernel);
    const layout = computeLayout(visible, this.opts.groupBy);
    const hFn = HEIGHT_METRICS[this.opts.height].fn;
    const cFn = COLOR_METRICS[this.opts.color].fn;
    const ctx = { now, maxRss: Math.max(1, ...visible.map((p) => p.rss || 0)) };
    const first = this.buildings.size === 0;

    const seen = new Set();
    for (const p of visible) {
      const lot = layout.lots.get(p.pid);
      let b = this.buildings.get(p.pid);
      if (!b || b.createTime !== p.create_time) {
        b = {
          pid: p.pid, createTime: p.create_time, seed: Math.random(),
          x: lot.x, z: lot.z, w: footprint(p) * 0.6, h: 0, heat: 0, dim: 0,
          hover: 0, birth: first ? 0 : 1,
        };
        this.buildings.set(p.pid, b);
      }
      b.proc = p;
      b.dying = false;
      b.district = lot.district;
      b.tx = lot.x; b.tz = lot.z;
      b.tw = footprint(p);
      b.th = Math.max(0.3, hFn(p, now));
      b.theat = Math.max(0, Math.min(1, cFn(p, ctx)));
      b.status = STATUS_CODE[p.status] ?? (p.denied ? 3 : 0);
      b.io = Math.min(1, Math.log10(1 + (p.io_read || 0) + (p.io_write || 0)) / 6);
      seen.add(p.pid);
    }
    for (const b of this.buildings.values()) {
      if (!seen.has(b.pid)) { b.dying = true; b.th = 0; }
    }
    this._ensureCapacity(this.buildings.size);
    this._updateDistricts(layout.districts);

    this.radius = Math.max(20, layout.radius);
    this.maxHeight = Math.max(10, ...[...this.buildings.values()].map((b) => b.th || 0));
    this.fogUniforms.uFogDensity.value = 1.5 / (this.radius * 4 + 120);
    this.groundUniforms.uRadius.value = this.radius;
    this.dust.scale.set(this.radius * 1.4, 1, this.radius * 1.4);
    this.controls.maxDistance = this.radius * 5 + 200;
    if (!this.hasFramed && visible.length) {
      this.hasFramed = true;
      this.resetView(true);
    }
  }

  _updateDistricts(list) {
    const seen = new Set();
    for (const d of list) {
      let s = this.districts.get(d.key);
      if (!s) {
        const mat = new THREE.ShaderMaterial({
          vertexShader: SIMPLE_VERT,
          fragmentShader: PLATE_FRAG,
          uniforms: { uSize: { value: new THREE.Vector2(1, 1) }, uColor: { value: lin('#3d6bff') }, uGlow: { value: 0 } },
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0.02;
        const el = document.createElement('div');
        el.className = 'district-label';
        const label = new CSS2DObject(el);
        this.scene.add(mesh, label);
        s = { key: d.key, mesh, label, el, x: d.x, z: d.z, w: d.w, d: d.d };
        this.districts.set(d.key, s);
      }
      Object.assign(s, { tx: d.x, tz: d.z, tw: d.w, td: d.d, count: d.count, dying: false });
      s.el.innerHTML = `<span>${escapeHtml(d.key)}</span><em>${d.count}</em>`;
      s.showLabel = d.count >= 2 || list.length < 40;
      s.label.visible = this.opts.labels && s.showLabel;
      seen.add(d.key);
    }
    for (const s of this.districts.values()) if (!seen.has(s.key)) s.dying = true;
  }

  // -------------------------------------------------------------- queries
  get(pid) { return this.buildings.get(pid); }

  _pick() {
    if (!this.mesh.count) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.mesh.boundingSphere = null;
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const b = this.order[hit.instanceId];
    return b && !b.dying ? b : null;
  }

  // ----------------------------------------------------------- navigation
  select(pid, { fly = false } = {}) {
    this.selectedPid = pid;
    if (pid !== null && fly) this.focus(pid);
    this._lastSelPos = null;
    const b = pid !== null ? this.buildings.get(pid) : null;
    if (b && this.controls.autoRotate) { this.controls.autoRotate = false; this.onAutoRotate(false); }
    this.onSelect(b ? b.proc : null);
  }

  focus(pid, close = false) {
    const b = this.buildings.get(pid);
    if (!b) return;
    const target = new THREE.Vector3(b.tx, b.th * 0.55, b.tz);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.25) { dir.y = 0.45; dir.normalize(); }
    const dist = close ? Math.max(10, b.th * 1.6) : Math.max(22, b.th * 2.4);
    this._flyTo(target.clone().add(dir.multiplyScalar(dist)), target);
  }

  resetView(instant = false) {
    // Back off far enough to see both the footprint and the tallest tower.
    const R = Math.max(this.radius, this.maxHeight * 1.1);
    const pos = new THREE.Vector3(R * 1.05, R * 0.85 + 20, R * 1.2);
    const target = new THREE.Vector3(0, this.maxHeight * 0.15, 0);
    if (instant) {
      this.flight = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this._flyTo(pos, target);
    }
  }

  _flyTo(pos, target) {
    this.flight = {
      t: 0,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: pos,
      toTarget: target,
    };
  }

  // ---------------------------------------------------------------- frame
  _frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time.value += dt;
    const k = 1 - Math.exp(-dt * 4.5);
    const kFast = 1 - Math.exp(-dt * 10);

    if (this.needsPick) {
      this.needsPick = false;
      const b = this._pick();
      if (b !== this.hovered) {
        this.hovered = b;
        this.renderer.domElement.style.cursor = b ? 'pointer' : '';
      }
      this.onHover(b ? b.proc : null, this.pointerClient);
    }

    // Animate buildings toward their targets and write instance data.
    const m = this.mesh.instanceMatrix.array;
    const a1 = this.aData.array;
    const a2 = this.aData2.array;
    this.order.length = 0;
    let i = 0;
    for (const b of this.buildings.values()) {
      b.x += (b.tx - b.x) * k;
      b.z += (b.tz - b.z) * k;
      b.w += (b.tw - b.w) * k;
      b.h += (b.th - b.h) * k;
      b.heat += (b.theat - b.heat) * k;
      b.birth = Math.max(0, b.birth - dt * 0.7);
      const match = !this.filter || this.filter(b.proc);
      b.dim += ((match ? 0 : 1) - b.dim) * kFast;
      b.hover += ((b === this.hovered ? 1 : 0) - b.hover) * kFast;
      if (b.dying && b.h < 0.03) {
        this.buildings.delete(b.pid);
        continue;
      }
      const o = i * 16;
      m[o] = b.w; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = Math.max(0.001, b.h); m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = b.w; m[o + 11] = 0;
      m[o + 12] = b.x; m[o + 13] = 0; m[o + 14] = b.z; m[o + 15] = 1;
      const j = i * 4;
      a1[j] = b.heat; a1[j + 1] = b.seed; a1[j + 2] = b.hover; a1[j + 3] = b.dim;
      a2[j] = b.status; a2[j + 1] = b.io; a2[j + 2] = b.birth; a2[j + 3] = b.pid === this.selectedPid ? 1 : 0;
      this.order.push(b);
      i++;
    }
    this.mesh.count = this.mirror.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aData.needsUpdate = true;
    this.aData2.needsUpdate = true;

    this._animateDistricts(k);
    this._updateSelection(dt);
    this._updateLinks();

    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / 1.1);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      if (f.t >= 1) this.flight = null;
    }
    this.controls.update();
    this.sky.position.copy(this.camera.position);
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }

  _animateDistricts(k) {
    for (const s of this.districts.values()) {
      if (s.dying) {
        s.tw = 0; s.td = 0;
        if (s.w < 0.2) {
          this.scene.remove(s.mesh, s.label);
          s.mesh.material.dispose();
          s.mesh.geometry.dispose();
          s.label.element.remove();
          this.districts.delete(s.key);
          continue;
        }
      }
      s.x += (s.tx - s.x) * k; s.z += (s.tz - s.z) * k;
      s.w += (s.tw - s.w) * k; s.d += (s.td - s.d) * k;
      s.mesh.position.set(s.x + s.w / 2, 0.02, s.z + s.d / 2);
      s.mesh.scale.set(Math.max(0.01, s.w), Math.max(0.01, s.d), 1);
      s.mesh.material.uniforms.uSize.value.set(Math.max(0.01, s.w), Math.max(0.01, s.d));
      const sel = this.selectedPid !== null && this.buildings.get(this.selectedPid)?.district === s.key;
      const u = s.mesh.material.uniforms.uGlow;
      u.value += ((sel ? 1.2 : 0) - u.value) * k;
      s.label.position.set(s.x + s.w / 2, 0.1, s.z + s.d + 0.4);
    }
  }

  _updateSelection() {
    const b = this.selectedPid !== null ? this.buildings.get(this.selectedPid) : null;
    const show = !!b && !b.dying;
    this.beam.visible = show;
    this.selLabel.visible = show;
    if (!show) return;
    this.beam.position.set(b.x, b.h, b.z);
    this.beam.scale.set(b.w * 0.55, 140, b.w * 0.55);
    this.selLabel.position.set(b.x, b.h + 1.2, b.z);
    const p = b.proc;
    const html = `<b>${escapeHtml(p.name)}</b> <span>${p.pid}</span>`;
    if (this.selLabel.element.innerHTML !== html) this.selLabel.element.innerHTML = html;

    // Keep the camera locked on the selection if the layout shifts under it.
    if (this._lastSelPos && !this.flight) {
      const dx = b.x - this._lastSelPos.x;
      const dz = b.z - this._lastSelPos.z;
      if (dx || dz) {
        this.camera.position.x += dx; this.camera.position.z += dz;
        this.controls.target.x += dx; this.controls.target.z += dz;
      }
    }
    this._lastSelPos = { x: b.x, z: b.z };
  }

  _updateLinks() {
    const pairs = [];
    const sel = this.selectedPid !== null ? this.buildings.get(this.selectedPid) : null;
    if (sel && !sel.dying) {
      const parent = this.buildings.get(sel.proc.ppid);
      if (parent && !parent.dying) pairs.push([parent, sel, 0]);
      for (const b of this.buildings.values()) {
        if (!b.dying && b.proc.ppid === sel.pid && b !== sel) pairs.push([sel, b, 1]);
      }
    }
    if (this.opts.links) {
      for (const b of this.buildings.values()) {
        const parent = this.buildings.get(b.proc.ppid);
        if (parent && parent !== b && !b.dying && !parent.dying && b !== sel && parent !== sel) pairs.push([parent, b, 2]);
      }
    }
    const SEG = 16;
    const nVerts = pairs.length * SEG * 2;
    let posAttr = this.linkGeo.getAttribute('position');
    if (!posAttr || posAttr.count < nVerts) {
      const cap = Math.max(1024, 2 ** Math.ceil(Math.log2(nVerts + 1)));
      posAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.linkGeo.setAttribute('position', posAttr);
      this.linkGeo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
      this.linkGeo.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
    }
    const P = posAttr.array;
    const T = this.linkGeo.getAttribute('aT').array;
    const K = this.linkGeo.getAttribute('aKind').array;
    let v = 0;
    const pt = (a, b, lift, t) => {
      const u = 1 - t;
      // Quadratic bezier from roof A over an arch to roof B.
      const cx = (a.x + b.x) / 2; const cz = (a.z + b.z) / 2; const cy = Math.max(a.h, b.h) + lift;
      return [
        u * u * a.x + 2 * u * t * cx + t * t * b.x,
        u * u * a.h + 2 * u * t * cy + t * t * b.h,
        u * u * a.z + 2 * u * t * cz + t * t * b.z,
      ];
    };
    for (const [a, b, kind] of pairs) {
      const lift = 2 + Math.hypot(a.x - b.x, a.z - b.z) * 0.35;
      let prev = pt(a, b, lift, 0);
      for (let s = 1; s <= SEG; s++) {
        const t = s / SEG;
        const cur = pt(a, b, lift, t);
        P.set(prev, v * 3); T[v] = (s - 1) / SEG; K[v] = kind; v++;
        P.set(cur, v * 3); T[v] = t; K[v] = kind; v++;
        prev = cur;
      }
    }
    this.linkGeo.setDrawRange(0, v);
    posAttr.needsUpdate = true;
    this.linkGeo.getAttribute('aT').needsUpdate = true;
    this.linkGeo.getAttribute('aKind').needsUpdate = true;
  }
}
