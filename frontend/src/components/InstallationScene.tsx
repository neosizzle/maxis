import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, OrbitControls, RoundedBox } from '@react-three/drei';
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  Clock,
  Compass,
  Download,
  Droplets,
  Layers,
  LayoutGrid,
  MapPin,
  MoveDown,
  MoveUp,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  ShieldAlert,
  Sparkles,
  Sun,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { EquipmentId, EquipmentStatus, Snapshot } from '../types';
import { ASSET_METADATA } from '../data/metadata';

interface Props {
  snapshot: Snapshot;
  selected: string | null;
  onSelect: (id: string | null) => void;
  immersive?: boolean;
  onExport?: () => void;
  onManageAsset?: () => void;
}

const names: Record<EquipmentId, string> = {
  tank: 'Rainwater tank',
  pump: 'Pump',
  membrane: 'Membrane filter',
  uv: 'UV treatment',
  solar: 'Solar array',
  mains: 'Mains backup',
  homes: 'Community',
};

const tones: Record<EquipmentStatus, string> = {
  normal: '#2b3e8d', warning: '#d89519', critical: '#e35f50', offline: '#878c9b', stopped: '#67708d',
};

const ids: EquipmentId[] = ['tank', 'pump', 'membrane', 'uv', 'solar', 'mains', 'homes'];

// Spatial coordinates within the urban township site
const positions: Record<EquipmentId, [number, number, number]> = {
  tank: [-5.8, 0, 0.6],
  pump: [-3.4, 0, 1.2],
  membrane: [-0.9, 0, 0.7],
  uv: [1.8, 0, 0.8],
  solar: [-2.9, 0, -3.2],
  mains: [4.4, 0, -2.6],
  homes: [5.2, 0, 1.4],
};

const boundingBoxes: Record<EquipmentId, [number, number, number]> = {
  tank: [2.5, 3.4, 2.5],
  pump: [1.6, 1.6, 1.4],
  membrane: [2.2, 2.8, 1.8],
  uv: [2.2, 1.8, 1.4],
  solar: [3.6, 2.5, 2.4],
  mains: [2.0, 1.8, 1.6],
  homes: [4.6, 3.8, 4.4],
};
const labelHeights: Record<EquipmentId, number> = {
  tank: 3.55,
  pump: 1.62,
  membrane: 2.58,
  uv: 1.82,
  solar: 2.88,
  mains: 1.95,
  homes: 2.34,
};
const cameraPosition: [number, number, number] = [14.5, 13, 19.5];
const baseStyle = { fontFamily: 'inherit', border: '1px solid #d0d3df', borderRadius: 9, padding: '8px 12px', minHeight: 40, background: '#ffffff', color: '#33394d', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 };
const textTones: Record<EquipmentStatus, string> = { normal: '#223272', warning: '#875504', critical: '#a73327', offline: '#53586b', stopped: '#464e6b' };
// The same words again for the equipment list, which renders on the dark skin.
const listTones: Record<EquipmentStatus, string> = { normal: '#7fe06d', warning: '#f0c070', critical: '#f0a097', offline: '#aab2c8', stopped: '#b9bfd8' };
type CameraAction = 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset';
type CameraRequest = { action: CameraAction; sequence: number };
const defaultCameraRequest: CameraRequest = { action: 'reset', sequence: 0 };

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function webGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ComponentLabelSprite({
  id,
  status,
  selected,
  isAttention,
  position,
  onClick,
}: {
  id: EquipmentId;
  status: EquipmentStatus;
  selected: boolean;
  isAttention: boolean;
  position: [number, number, number];
  onClick?: () => void;
}) {
  const isWarning = isAttention || status === 'warning';
  const isCritical = status === 'critical';
  const hasAlert = isWarning || isCritical;

  const labelText = hasAlert
    ? `${names[id]} · ${isCritical ? 'Critical' : 'Warning'}`
    : names[id];

  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, 512, 128);

    const bg = isCritical ? '#fee2e2' : isWarning ? '#fef3c7' : selected ? '#f8fafc' : '#ffffff';
    const border = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : selected ? '#3b82f6' : '#cbd5e1';
    const dotColor = isCritical ? '#dc2626' : isWarning ? '#d97706' : selected ? '#2563eb' : '#1e3a8a';
    const textColor = isCritical ? '#991b1b' : isWarning ? '#78350f' : '#1e293b';

    // Measure text to make a snug rounded pill
    ctx.font = 'bold 30px Inter, system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(labelText).width;
    const pillWidth = Math.min(480, textWidth + 76);
    const pillHeight = 68;
    const x = (512 - pillWidth) / 2;
    const y = (128 - pillHeight) / 2;
    const radius = 20;

    // Drop shadow matching user reference picture
    ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;

    // Pill background
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, pillWidth, pillHeight, radius);
    } else {
      ctx.rect(x, y, pillWidth, pillHeight);
    }
    ctx.fill();

    // Turn off shadow for crisp border and text
    ctx.shadowColor = 'transparent';

    // Pill border
    ctx.strokeStyle = border;
    ctx.lineWidth = selected || hasAlert ? 3.5 : 2;
    ctx.stroke();

    // Dot indicator on the left
    const dotX = x + 28;
    const dotY = 128 / 2;
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7.5, 0, Math.PI * 2);
    ctx.fill();

    // Equipment Name
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, dotX + 18, dotY);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [labelText, isCritical, isWarning, selected]);

  if (!texture) return null;

  const scaleX = hasAlert ? 3.8 : names[id].length > 12 ? 3.3 : 2.7;
  const scaleY = scaleX * (128 / 512);

  return (
    <sprite
      position={position}
      scale={[scaleX, scaleY, 1]}
      onClick={e => {
        e.stopPropagation();
        onClick?.();
      }}
      onPointerOver={e => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      <spriteMaterial map={texture} depthTest={false} transparent />
    </sprite>
  );
}

function Pipe({
  points,
  active,
  animate,
  color = '#00a8e8',
  speed = 0.22,
}: {
  points: [number, number, number][];
  active: boolean;
  animate: boolean;
  color?: string;
  speed?: number;
}) {
  const curve = useMemo(() => {
    const vectors = points.map(p => new THREE.Vector3(...p));
    const path = new THREE.CurvePath<THREE.Vector3>();
    let start = vectors[0];
    for (let i = 1; i < vectors.length - 1; i++) {
      const corner = vectors[i];
      const prev = vectors[i - 1];
      const next = vectors[i + 1];
      const radius = Math.min(0.24, corner.distanceTo(prev) / 3, corner.distanceTo(next) / 3);
      const before = corner.clone().add(prev.clone().sub(corner).normalize().multiplyScalar(radius));
      const after = corner.clone().add(next.clone().sub(corner).normalize().multiplyScalar(radius));
      path.add(new THREE.LineCurve3(start, before));
      path.add(new THREE.QuadraticBezierCurve3(before, corner, after));
      start = after;
    }
    path.add(new THREE.LineCurve3(start, vectors[vectors.length - 1]));
    return path;
  }, [points]);

  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 90, 0.08, 12, false), [curve]);
  const markers = useRef<(THREE.Mesh | null)[]>([]);
  const phase = useRef(0);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, delta) => {
    if (!active || !animate) return;
    phase.current = (phase.current + delta * speed) % 1;
    for (let i = 0; i < 8; i++) {
      const mesh = markers.current[i];
      if (mesh) {
        mesh.position.copy(curve.getPointAt((phase.current + i / 8) % 1));
      }
    }
  });

  return (
    <group>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          color={active ? '#38bdf8' : '#94a3b8'}
          metalness={0.7}
          roughness={0.25}
        />
      </mesh>
      {active &&
        Array.from({ length: 8 }, (_, i) => (
          <mesh
            key={i}
            ref={node => {
              markers.current[i] = node;
              if (node && !node.userData.initialized) {
                node.position.copy(curve.getPointAt(i / 8));
                node.userData.initialized = true;
              }
            }}
          >
            <sphereGeometry args={[0.12, 14, 12]} />
            <meshStandardMaterial
              color={color === '#00a8e8' ? '#e0f2fe' : '#fef08a'}
              emissive={color === '#00a8e8' ? '#38bdf8' : '#eab308'}
              emissiveIntensity={0.85}
              roughness={0.2}
            />
          </mesh>
        ))}
    </group>
  );
}

/* =========================================================================
   EQUIPMENT HOUSING / INTERACTIVE TARGET
   ========================================================================= */
function EquipmentTarget({
  id,
  status,
  selected,
  onSelect,
  children,
  animate,
  alertMessage,
}: {
  id: EquipmentId;
  status: EquipmentStatus;
  selected: boolean;
  onSelect: Props['onSelect'];
  children: ReactNode;
  animate: boolean;
  alertMessage?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const ringRef = useRef<THREE.Mesh>(null);
  const modelGroupRef = useRef<THREE.Group>(null);

  const [w, h, d] = boundingBoxes[id];
  const radius = Math.max(w, d) * 0.58;
  const isAttention = status === 'warning' || status === 'critical' || Boolean(alertMessage);
  const alertColor = status === 'critical' ? '#ef4444' : '#f59e0b';
  const ringColor = selected ? '#00f0ff' : isAttention ? alertColor : '#38bdf8';

  useFrame(({ clock }, delta) => {
    // 1. Smoothly elevate the 3D model when selected ("highlight up")
    if (modelGroupRef.current) {
      const targetY = selected ? 0.12 : 0;
      modelGroupRef.current.position.y = THREE.MathUtils.damp(
        modelGroupRef.current.position.y,
        targetY,
        8,
        delta
      );
    }

    // 2. Animate pulsing ground ring when selected
    const t = clock.elapsedTime;
    if (ringRef.current && selected) {
      const pulse = Math.sin(t * 3.5) * 0.08 + 1;
      ringRef.current.scale.set(pulse, pulse, 1);
    }
  });

  return (
    <group
      position={positions[id]}
      onClick={e => {
        e.stopPropagation();
        onSelect(id);
      }}
      onPointerOver={e => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* Ground Target Footprint Disc & Ring when selected or hovered */}
      {(selected || hovered) && (
        <>
          <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.038, 0]}>
            <ringGeometry args={[radius * 0.92, radius + (selected ? 0.18 : 0.08), 64]} />
            <meshBasicMaterial color={ringColor} transparent opacity={selected ? 0.9 : 0.6} side={THREE.DoubleSide} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.036, 0]}>
            <circleGeometry args={[radius * 0.91, 64]} />
            <meshBasicMaterial color={ringColor} transparent opacity={selected ? 0.2 : 0.06} side={THREE.DoubleSide} />
          </mesh>
        </>
      )}

      {/* Component Name Floating Badge matching user picture */}
      <ComponentLabelSprite
        id={id}
        status={status}
        selected={selected}
        isAttention={isAttention}
        position={[0, h, 0]}
        onClick={() => onSelect(id)}
      />

      {/* Lifted Model Container */}
      <group ref={modelGroupRef}>
        {children}
      </group>
    </group>
  );
}

function Pad({ width = 1.8, depth = 1.4 }: { width?: number; depth?: number }) {
  return (
    <RoundedBox args={[width, 0.16, depth]} radius={0.06} smoothness={2} position={[0, 0.08, 0]} receiveShadow castShadow>
      <meshStandardMaterial color="#cbd5e1" roughness={0.7} metalness={0.1} />
    </RoundedBox>
  );
}

// 1. Transparent Rainwater Storage Tank (Matching User Picture: Clear Cylinder with Direct Visible Water Level)
function Tank({ level, quality, animate }: { level: number | null; quality: string; animate: boolean }) {
  const surface = useRef<THREE.Mesh>(null);
  const fraction = level === null ? 0.75 : THREE.MathUtils.clamp(level / 100, 0.02, 0.98);
  const fillHeight = 2.35 * fraction;

  useFrame(({ clock }) => {
    if (surface.current) {
      surface.current.position.y = 0.3 + fillHeight + (animate ? Math.sin(clock.elapsedTime * 1.5) * 0.015 : 0);
    }
  });

  return (
    <group>
      <Pad width={2.7} depth={2.7} />

      {/* Clear Transparent Outer Cylinder Shell (Allows viewing the water level directly) */}
      <mesh position={[0, 1.5, 0]} castShadow>
        <cylinderGeometry args={[1.06, 1.12, 2.55, 48, 1, true]} />
        <meshPhysicalMaterial
          color="#cbd4de"
          roughness={0.08}
          metalness={0.05}
          transparent
          opacity={0.25}
          transmission={0.9}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Dynamic Water Body inside tank */}
      <mesh position={[0, 0.3 + fillHeight / 2, 0]}>
        <cylinderGeometry args={[1.035, 1.085, fillHeight, 48]} />
        <meshStandardMaterial
          color={quality === 'valid' ? '#49bbda' : '#a6bdc6'}
          transparent
          opacity={0.68}
          roughness={0.25}
        />
      </mesh>

      {/* Rippling Water Surface Top Disc */}
      <mesh ref={surface} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3 + fillHeight, 0]}>
        <circleGeometry args={[1.035, 48]} />
        <meshStandardMaterial
          color="#a1e4f1"
          transparent
          opacity={0.62}
          roughness={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* White Circumferential Rim Toruses */}
      {[0.28, 2.76].map(y => (
        <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[1.09, 0.055, 12, 48]} />
          <meshStandardMaterial color="#e5e9ee" metalness={0.2} roughness={0.3} />
        </mesh>
      ))}

      {/* Bottom Foundation Rim */}
      <mesh position={[0, 0.28, 0]} castShadow>
        <cylinderGeometry args={[1.13, 1.13, 0.15, 48]} />
        <meshStandardMaterial color="#dbe1e7" roughness={0.5} />
      </mesh>

      {/* Top Lid Rim */}
      <mesh position={[0, 2.86, 0]} castShadow>
        <cylinderGeometry args={[1.12, 1.12, 0.12, 48]} />
        <meshStandardMaterial color="#fafbf4" roughness={0.5} />
      </mesh>

      {/* Inspection Cap on Lid */}
      <mesh position={[0.3, 2.96, 0]}>
        <cylinderGeometry args={[0.25, 0.25, 0.07, 24]} />
        <meshStandardMaterial color="#8291a0" />
      </mesh>

      {/* Front Decal / Badge */}
      <mesh position={[0.05, 1.35, 1.065]}>
        <boxGeometry args={[0.75, 0.42, 0.055]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>

      {/* Side Vertical Level Gauge Strip */}
      <mesh position={[0.78, 1.5, 0.83]}>
        <boxGeometry args={[0.1, 2.2, 0.055]} />
        <meshStandardMaterial color="#f8ffff" />
      </mesh>

      {/* Fluid Indicator on Side Gauge */}
      <mesh position={[0.78, 0.4 + (fraction * 2.2) / 2, 0.87]}>
        <boxGeometry args={[0.055, fraction * 2.2, 0.02]} />
        <meshBasicMaterial color={quality === 'valid' ? '#258ab0' : '#87929b'} />
      </mesh>
    </group>
  );
}

// 2. Realistic Booster Pump Skid (Blue Motor, Cooling Fins & Impeller Chamber)
function Pump({ running, animate }: { running: boolean; animate: boolean }) {
  const fan = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (fan.current && running && animate) fan.current.rotation.z += delta * 4;
  });

  return (
    <group>
      <Pad width={1.7} depth={1.3} />
      {/* Steel Base Skid */}
      <RoundedBox args={[1.2, 0.16, 0.9]} radius={0.04} position={[0, 0.3, 0]} castShadow>
        <meshStandardMaterial color="#334155" metalness={0.8} roughness={0.25} />
      </RoundedBox>
      {/* Blue Electric Motor Housing */}
      <mesh position={[0, 0.7, -0.12]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.36, 0.36, 0.85, 32]} />
        <meshStandardMaterial color="#1d4ed8" roughness={0.4} metalness={0.3} />
      </mesh>
      {/* Motor Heat Sink Cooling Fins */}
      {[-0.38, -0.28, -0.18, -0.08, 0.02, 0.12].map(z => (
        <mesh key={z} position={[0, 0.7, z]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.365, 0.022, 8, 32]} />
          <meshStandardMaterial color="#1e40af" metalness={0.5} />
        </mesh>
      ))}
      {/* Polished Chrome Impeller Volute Casing */}
      <mesh position={[0, 0.69, 0.48]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.42, 0.42, 0.36, 32]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.15} />
      </mesh>
      {/* Rear Cooling Fan */}
      <group ref={fan} position={[0, 0.7, 0.68]}>
        {[0, 1, 2, 3].map(i => (
          <mesh key={i} rotation={[0, 0, (i * Math.PI) / 2]}>
            <boxGeometry args={[0.5, 0.05, 0.04]} />
            <meshStandardMaterial color="#475569" />
          </mesh>
        ))}
      </group>
      {/* Analog Pressure Gauge */}
      <mesh position={[0.35, 1.05, 0.48]}>
        <cylinderGeometry args={[0.12, 0.12, 0.06, 24]} />
        <meshStandardMaterial color="#ffffff" metalness={0.4} />
      </mesh>
    </group>
  );
}

// 3. Realistic Ultrafiltration Membrane Skid (Multi-Vessel Rack & Manifolds)
function Membrane({ status }: { status: EquipmentStatus }) {
  const fault = status === 'warning' || status === 'critical';
  const vesselColor = status === 'critical' ? '#fecaca' : status === 'warning' ? '#fef3c7' : '#f8fafc';
  const glowTone = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#000000';

  return (
    <group>
      <Pad width={2.2} depth={1.7} />
      {/* Stainless Steel Rack Uprights */}
      {[-0.92, 0.92].map(x => (
        <mesh key={x} position={[x, 1.15, -0.38]} castShadow>
          <boxGeometry args={[0.08, 2.0, 0.08]} />
          <meshStandardMaterial color="#64748b" metalness={0.85} roughness={0.2} />
        </mesh>
      ))}
      {/* Crossbeams */}
      {[0.4, 2.08].map(y => (
        <mesh key={y} position={[0, y, -0.38]} castShadow>
          <boxGeometry args={[1.92, 0.08, 0.08]} />
          <meshStandardMaterial color="#64748b" metalness={0.85} roughness={0.2} />
        </mesh>
      ))}
      {/* 3 High-Flux UF Membrane Pressure Vessels */}
      {[-0.6, 0, 0.6].map((x, i) => (
        <group key={x} position={[x, 0, 0.05]}>
          <mesh position={[0, 1.18, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.22, 1.62, 32]} />
            <meshStandardMaterial
              color={vesselColor}
              emissive={fault ? glowTone : '#000000'}
              emissiveIntensity={fault ? 0.35 : 0}
              roughness={0.3}
              metalness={0.15}
            />
          </mesh>
          {/* Top and Bottom Vessel Endcaps */}
          {[0.38, 1.95].map(y => (
            <mesh key={y} position={[0, y, 0]} castShadow>
              <cylinderGeometry args={[0.25, 0.25, 0.16, 32]} />
              <meshStandardMaterial
                color={fault ? tones[status] : '#334155'}
                metalness={0.7}
                roughness={0.25}
              />
            </mesh>
          ))}
          {/* Inspection Port Indicator */}
          <mesh position={[0, 1.25, 0.225]}>
            <boxGeometry args={[0.16, 0.42, 0.03]} />
            <meshStandardMaterial color={i % 2 === 0 ? '#38bdf8' : '#34d399'} />
          </mesh>
        </group>
      ))}
      {/* Top Distribution Manifold Pipe */}
      <mesh position={[0, 2.26, 0.05]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.075, 0.075, 1.6, 24]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.9} roughness={0.15} />
      </mesh>
    </group>
  );
}

// 4. Realistic UV Disinfection Chamber (Black Reactor Chamber with White Saddles & Blue Panel)
function UV({ running }: { running: boolean }) {
  return (
    <group>
      <Pad width={2.1} depth={1.3} />
      {/* White Skid Mounting Saddles */}
      {[-0.62, 0.62].map(x => (
        <mesh key={x} position={[x, 0.48, 0]} castShadow>
          <boxGeometry args={[0.14, 0.55, 0.6]} />
          <meshStandardMaterial color="#f8fafc" metalness={0.2} roughness={0.3} />
        </mesh>
      ))}
      {/* Matte Black / Charcoal Reactor Chamber */}
      <mesh position={[0, 0.92, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.26, 0.26, 1.68, 36]} />
        <meshStandardMaterial color="#1e293b" metalness={0.65} roughness={0.3} />
      </mesh>
      {/* Glowing Violet Quartz Lamp Core */}
      <mesh position={[0, 0.92, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.09, 0.09, 1.55, 24]} />
        <meshStandardMaterial
          color={running ? '#c084fc' : '#94a3b8'}
          emissive={running ? '#a855f7' : '#000000'}
          emissiveIntensity={running ? 0.95 : 0}
        />
      </mesh>
      {/* Electrical Control & Ballast Enclosure */}
      <RoundedBox args={[0.62, 0.5, 0.32]} radius={0.04} position={[0, 0.62, 0.52]} castShadow>
        <meshStandardMaterial color="#f8fafc" roughness={0.4} />
      </RoundedBox>
      <mesh position={[0, 0.68, 0.69]}>
        <planeGeometry args={[0.34, 0.18]} />
        <meshBasicMaterial color={running ? '#38bdf8' : '#94a3b8'} />
      </mesh>
    </group>
  );
}

// 5. Realistic Photovoltaic Solar Canopy (Silicon Cells & Steel Truss)
function Solar() {
  return (
    <group>
      {/* Steel Column Supports */}
      {[-1.35, 1.35].flatMap(x =>
        [-0.7, 0.7].map(z => (
          <mesh key={`${x}-${z}`} position={[x, 0.9, z]} castShadow>
            <boxGeometry args={[0.07, 1.8, 0.07]} />
            <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.2} />
          </mesh>
        ))
      )}
      {/* Angled Solar Array Frame */}
      <group position={[0, 1.85, 0]} rotation={[-0.24, 0, 0]}>
        <RoundedBox args={[3.6, 0.09, 2.3]} radius={0.03} castShadow>
          <meshStandardMaterial color="#334155" metalness={0.6} />
        </RoundedBox>
        {/* Photovoltaic Cells (Dark Navy Monocrystalline Silicon) */}
        {[-1.15, 0, 1.15].flatMap(x =>
          [-0.55, 0.55].map(z => (
            <group key={`${x}-${z}`} position={[x, 0.07, z]}>
              <mesh castShadow>
                <boxGeometry args={[1.08, 0.06, 1.02]} />
                <meshStandardMaterial
                  color="#0f172a"
                  metalness={0.85}
                  roughness={0.15}
                  emissive="#0369a1"
                  emissiveIntensity={0.1}
                />
              </mesh>
              {/* Silver Cell Gridlines */}
              {[-0.32, 0, 0.32].map(cx => (
                <mesh key={cx} position={[cx, 0.035, 0]}>
                  <boxGeometry args={[0.01, 0.01, 0.95]} />
                  <meshBasicMaterial color="#38bdf8" />
                </mesh>
              ))}
            </group>
          ))
        )}
      </group>
    </group>
  );
}

// 6. Realistic Mains Interconnection (Flanged Valve & Bright Yellow Handwheel)
function Mains() {
  return (
    <group>
      <Pad width={1.9} depth={1.4} />
      {/* High-Pressure Flanged Feed Pipe */}
      <mesh position={[0, 0.6, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.2, 0.2, 1.7, 32]} />
        <meshStandardMaterial color="#0284c7" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Valve Body Box */}
      <mesh position={[0, 0.82, 0]} castShadow>
        <boxGeometry args={[0.5, 0.5, 0.44]} />
        <meshStandardMaterial color="#0369a1" metalness={0.6} />
      </mesh>
      {/* Valve Stem */}
      <mesh position={[0, 1.18, 0]}>
        <cylinderGeometry args={[0.055, 0.055, 0.45, 16]} />
        <meshStandardMaterial color="#64748b" metalness={0.9} />
      </mesh>
      {/* Large Yellow Control Handwheel */}
      <mesh position={[0, 1.38, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[0.35, 0.05, 12, 32]} />
        <meshStandardMaterial color="#eab308" metalness={0.6} roughness={0.3} />
      </mesh>
      {[0, Math.PI / 3, (2 * Math.PI) / 3].map(r => (
        <mesh key={r} position={[0, 1.38, 0]} rotation={[0, r, 0]}>
          <boxGeometry args={[0.66, 0.045, 0.04]} />
          <meshStandardMaterial color="#eab308" />
        </mesh>
      ))}
    </group>
  );
}

// 7. Realistic Modern Architectural Township Buildings (Matching User Picture)
function TownshipPrecinct() {
  return (
    <group>
      {/* High-Rise Residential Tower 1 (Taller, in back) */}
      <group position={[-0.8, 0, -0.6]}>
        <RoundedBox args={[1.7, 3.2, 1.6]} radius={0.04} position={[0, 1.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#e2e8f0" roughness={0.4} metalness={0.15} />
        </RoundedBox>
        {/* Modern Window Matrix on Facade */}
        {[0.6, 1.2, 1.8, 2.4, 2.8].flatMap(y =>
          [-0.5, 0, 0.5].map(x => (
            <mesh key={`${x}-${y}`} position={[x, y, 0.81]}>
              <planeGeometry args={[0.32, 0.36]} />
              <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.1} />
            </mesh>
          ))
        )}
        {/* Rooftop Plant & HVAC Chiller Unit */}
        <RoundedBox args={[0.9, 0.45, 0.8]} radius={0.03} position={[0, 3.42, 0]} castShadow>
          <meshStandardMaterial color="#334155" metalness={0.7} />
        </RoundedBox>
      </group>

      {/* Mid-Rise Office Block (In front) */}
      <group position={[0.9, 0, 0.9]}>
        <RoundedBox args={[1.9, 2.2, 1.8]} radius={0.04} position={[0, 1.1, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#f1f5f9" roughness={0.5} metalness={0.2} />
        </RoundedBox>
        {/* Window Matrix */}
        {[0.5, 1.0, 1.5].flatMap(y =>
          [-0.55, -0.18, 0.18, 0.55].map(x => (
            <mesh key={`${x}-${y}`} position={[x, y, 0.91]}>
              <planeGeometry args={[0.26, 0.32]} />
              <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.1} />
            </mesh>
          ))
        )}
        {/* Rooftop HVAC Box */}
        <RoundedBox args={[0.6, 0.4, 0.6]} radius={0.02} position={[-0.2, 2.4, -0.2]} castShadow>
          <meshStandardMaterial color="#334155" />
        </RoundedBox>
        {/* Water storage tank on roof */}
        <mesh position={[0.45, 2.32, 0.35]} castShadow>
          <cylinderGeometry args={[0.16, 0.16, 0.28, 16]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.7} />
        </mesh>
      </group>
    </group>
  );
}

// Surrounding Realistic Trees & Street Furniture
function RealisticTree({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.07, 0.9, 10]} />
        <meshStandardMaterial color="#78350f" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.08, 0]} castShadow>
        <sphereGeometry args={[0.42, 16, 14]} />
        <meshStandardMaterial color="#22c55e" roughness={0.7} />
      </mesh>
      <mesh position={[0.04, 1.32, 0]} castShadow>
        <sphereGeometry args={[0.28, 14, 12]} />
        <meshStandardMaterial color="#16a34a" roughness={0.7} />
      </mesh>
    </group>
  );
}

// Streetlight with soft emissive warm glow
function StreetLight({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 1.1, 0]}>
        <cylinderGeometry args={[0.03, 0.04, 2.2, 8]} />
        <meshStandardMaterial color="#1e293b" metalness={0.8} />
      </mesh>
      <mesh position={[0.18, 2.2, 0]}>
        <boxGeometry args={[0.4, 0.05, 0.08]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh position={[0.32, 2.16, 0]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshBasicMaterial color="#fef08a" />
      </mesh>
    </group>
  );
}

// Ground Platform Plinth matching user picture
function UrbanPrecinctPlatform({ onEmptyClick }: { onEmptyClick?: () => void }) {
  return (
    <group position={[0, -0.05, 0]}>
      {/* Clean Smooth Light Plinth with Click-to-Deselect */}
      <RoundedBox
        args={[22, 0.35, 15]}
        radius={0.35}
        position={[0, -0.175, 0]}
        receiveShadow
        onClick={e => {
          e.stopPropagation();
          onEmptyClick?.();
        }}
      >
        <meshStandardMaterial color="#e2e8f0" roughness={0.85} metalness={0.05} />
      </RoundedBox>
    </group>
  );
}

/* =========================================================================
   FULL 3D SCENE ROOT
   ========================================================================= */
function Scene({
  snapshot,
  selected,
  onSelect,
  view = defaultCameraRequest,
  animate,
  compact,
  immersive = false,
}: Props & { view: CameraRequest; animate: boolean; compact: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const responsiveCamera: [number, number, number] = compact ? [20, 18, 27] : cameraPosition;

  useEffect(() => {
    const control = controls.current;
    if (!control) return;
    if (view.action === 'reset') {
      control.target.set(-0.8, 1.3, 0.3);
      control.object.position.set(...responsiveCamera);
      control.update();
      control.saveState();
    } else if (view.action === 'left' || view.action === 'right') {
      control.setAzimuthalAngle(control.getAzimuthalAngle() + (view.action === 'left' ? -1 : 1) * (Math.PI / 8));
    } else if (view.action === 'up' || view.action === 'down') {
      control.setPolarAngle(
        THREE.MathUtils.clamp(
          control.getPolarAngle() + (view.action === 'up' ? -1 : 1) * (Math.PI / 12),
          control.minPolarAngle,
          control.maxPolarAngle
        )
      );
    } else {
      const offset = control.object.position.clone().sub(control.target);
      const distance = THREE.MathUtils.clamp(
        offset.length() * (view.action === 'in' ? 0.85 : 1.18),
        control.minDistance,
        control.maxDistance
      );
      offset.setLength(distance);
      control.object.position.copy(control.target).add(offset);
    }
    control.update();
  }, [view, compact]);

  const running = snapshot.connected && !snapshot.stopped && (snapshot.metrics.flow.value ?? 0) > 0;
  const rain = running && snapshot.source === 'rainwater';
  const mains = running && snapshot.source === 'mains';

  const rainPath = useMemo<[number, number, number][]>(
    () => [[-5.8, 0.48, 0.6], [-5.8, 0.48, 2.3], [-3.4, 0.48, 2.3], [-3.4, 0.48, 1.2]],
    []
  );
  const filterPath = useMemo<[number, number, number][]>(
    () => [[-3.4, 0.48, 1.2], [-3.4, 0.48, 2.3], [-0.9, 0.48, 2.3], [-0.9, 0.48, 0.7]],
    []
  );
  const uvPath = useMemo<[number, number, number][]>(
    () => [[-0.9, 0.48, 0.7], [-0.9, 0.48, 2.3], [1.8, 0.48, 2.3], [1.8, 0.48, 0.8]],
    []
  );
  const homesPath = useMemo<[number, number, number][]>(
    () => [[1.8, 0.48, 0.8], [1.8, 0.48, 2.3], [3.6, 0.48, 2.3], [3.6, 0.48, 1.4], [4.4, 0.48, 1.4]],
    []
  );
  const mainsPath = useMemo<[number, number, number][]>(
    () => [[4.4, 0.48, -2.6], [7.0, 0.48, -2.6], [7.0, 0.48, -0.6], [3.6, 0.48, -0.6], [3.6, 0.48, 1.4], [4.4, 0.48, 1.4]],
    []
  );
  const powerPath = useMemo<[number, number, number][]>(
    () => [[-2.9, 0.2, -3.2], [-2.9, 0.2, -1.4], [-3.4, 0.2, -1.4], [-3.4, 0.2, 1.2]],
    []
  );

  return (
    <>
      {/* Sky & Atmospheric Lighting matching user image */}
      <color attach="background" args={[immersive ? '#0f172a' : '#dbeafe']} />
      <fog attach="fog" args={[immersive ? '#0f172a' : '#dbeafe', 28, 75]} />
      <ambientLight intensity={immersive ? 0.6 : 0.9} />
      <hemisphereLight args={['#dbeafe', '#cbd5e1', 1.1]} />
      <directionalLight
        position={[-8, 18, 12]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-bias={-0.0001}
      />

      {/* Wide background click catcher for any empty space */}
      <mesh
        position={[0, -0.08, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={e => {
          e.stopPropagation();
          onSelect(null);
        }}
      >
        <planeGeometry args={[140, 140]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* Urban Precinct Platform */}
      <UrbanPrecinctPlatform onEmptyClick={() => onSelect(null)} />

      {/* Animated Pipes with Glowing Hydro Particles */}
      <Pipe points={rainPath} active={rain} animate={animate} speed={0.22} />
      <Pipe points={filterPath} active={rain} animate={animate} speed={0.22} />
      <Pipe points={uvPath} active={rain} animate={animate} speed={0.22} />
      <Pipe points={homesPath} active={rain || mains} animate={animate} speed={0.22} />
      <Pipe points={mainsPath} active={mains} animate={animate} speed={0.22} />
      <Pipe
        points={powerPath}
        active={snapshot.connected && (snapshot.metrics.solarPower.value ?? 0) > 0}
        animate={animate}
        color="#eab308"
        speed={0.12}
      />

      {/* Interactive Equipment Models with Abnormal Warning Highlights */}
      {ids.map(id => {
        const eq = snapshot.equipment[id];
        const status = eq?.status || 'normal';
        const isWaterShortage = (snapshot.metrics.tankLevel.value ?? 100) < 20 || snapshot.equipment.tank.status === 'warning';
        const isCommunityAlert = id === 'homes' && (isWaterShortage || (snapshot.metrics.flow.value ?? 0) === 0);
        const effectiveStatus = (id === 'tank' && isWaterShortage) ? 'warning' : isCommunityAlert ? 'warning' : status;

        return (
          <EquipmentTarget
            key={id}
            id={id}
            status={effectiveStatus}
            selected={selected === id}
            onSelect={onSelect}
            animate={animate}
            alertMessage={effectiveStatus === 'warning' ? (id === 'tank' ? 'Low Water Level' : `${names[id]} Warning`) : undefined}
          >
            {id === 'tank' && (
              <Tank
                level={snapshot.metrics.tankLevel.value}
                quality={snapshot.metrics.tankLevel.quality}
                animate={animate}
              />
            )}
            {id === 'pump' && <Pump running={rain} animate={animate} />}
            {id === 'membrane' && <Membrane status={snapshot.equipment.membrane.status} />}
            {id === 'uv' && <UV running={rain} />}
            {id === 'solar' && <Solar />}
            {id === 'mains' && <Mains />}
            {id === 'homes' && <TownshipPrecinct />}
          </EquipmentTarget>
        );
      })}

      {/* Surrounding City Trees and Streetlights matching user image */}
      {[
        [-8.4, 0, -4.5],
        [-2.9, 0, -4.8],
        [-8.8, 0, 3.2],
        [-0.2, 0, 3.6],
        [8.6, 0, 4.4],
        [8.4, 0, -4.2],
      ].map((p, i) => (
        <RealisticTree key={i} position={p as [number, number, number]} scale={i % 2 === 0 ? 1.05 : 0.88} />
      ))}
      {[
        [-1.2, 0, 1.6],
        [5.0, 0, 3.4],
      ].map((p, i) => (
        <StreetLight key={i} position={p as [number, number, number]} />
      ))}

      {/* Soft Contact Shadows on Ground */}
      <ContactShadows
        position={[0, -0.04, 0]}
        opacity={0.3}
        scale={28}
        blur={2.2}
        far={8}
        resolution={1024}
        color="#334155"
        frames={1}
      />

      {/* Orbit Controls with Damping and Full View Framing */}
      <OrbitControls
        ref={controls}
        makeDefault
        target={[-0.8, 1.3, 0.3]}
        minDistance={6}
        maxDistance={45}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2.2}
        enablePan={true}
        enableZoom={true}
        enableDamping={animate}
        dampingFactor={0.1}
      />
    </>
  );
}



/* =========================================================================
   EQUIPMENT VECTOR SYMBOLS (Matching User Specification)
   ========================================================================= */
function EquipmentSymbol({ id, isWarning }: { id: EquipmentId; isWarning?: boolean }) {
  switch (id) {
    case 'solar':
      return (
        <g>
          {/* Angled Photovoltaic Panel */}
          <polygon
            points="51,38 61,15 89,15 79,38"
            fill="#1e3a5f"
            stroke="#1e293b"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Panel Grid Lines */}
          <line x1="58" y1="15" x2="53" y2="38" stroke="#93c5fd" strokeWidth="0.8" opacity="0.8" />
          <line x1="68" y1="15" x2="63" y2="38" stroke="#93c5fd" strokeWidth="0.8" opacity="0.8" />
          <line x1="78" y1="15" x2="73" y2="38" stroke="#93c5fd" strokeWidth="0.8" opacity="0.8" />
          <line x1="57" y1="23" x2="84" y2="23" stroke="#93c5fd" strokeWidth="0.8" opacity="0.8" />
          <line x1="54" y1="31" x2="81" y2="31" stroke="#93c5fd" strokeWidth="0.8" opacity="0.8" />
        </g>
      );
    case 'tank':
      return (
        <g>
          {/* Water Storage Tank Container */}
          <rect x="54" y="14" width="28" height="34" rx="4" fill="#ffffff" stroke="#3b82f6" strokeWidth="1.6" />
          {/* Fluid Water Volume Fill */}
          <rect x="55.5" y="24" width="25" height="22.5" rx="2.5" fill="#3b82f6" opacity="0.85" />
          <line x1="55.5" y1="24" x2="80.5" y2="24" stroke="#2563eb" strokeWidth="1.2" />
          {/* Level Gauge Markings */}
          <line x1="57" y1="19" x2="60" y2="19" stroke="#93c5fd" strokeWidth="1" />
          <line x1="57" y1="22" x2="60" y2="22" stroke="#93c5fd" strokeWidth="1" />
        </g>
      );
    case 'pump':
      return (
        <g>
          {/* Industrial Pump: Circle with plus sign (+) */}
          <circle cx="68" cy="29" r="16" fill="#ffffff" stroke="#2563eb" strokeWidth="2.2" />
          <line x1="68" y1="18" x2="68" y2="40" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" />
          <line x1="57" y1="29" x2="79" y2="29" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" />
        </g>
      );
    case 'membrane': {
      const stroke = isWarning ? '#f59e0b' : '#3b82f6';
      const fill = isWarning ? '#fef3c7' : '#eff6ff';
      return (
        <g>
          {/* 3 Ultrafiltration Cartridges */}
          <rect x="51" y="15" width="10" height="30" rx="4" fill={fill} stroke={stroke} strokeWidth="1.8" />
          <rect x="63" y="15" width="10" height="30" rx="4" fill={fill} stroke={stroke} strokeWidth="1.8" />
          <rect x="75" y="15" width="10" height="30" rx="4" fill={fill} stroke={stroke} strokeWidth="1.8" />
          {/* Manifold Rails */}
          <line x1="49" y1="20" x2="87" y2="20" stroke={stroke} strokeWidth="1.5" />
          <line x1="49" y1="40" x2="87" y2="40" stroke={stroke} strokeWidth="1.5" />
        </g>
      );
    }
    case 'uv':
      return (
        <g>
          {/* UV Capsule Chamber */}
          <rect x="47" y="20" width="42" height="18" rx="9" fill="#f8fafc" stroke="#3b82f6" strokeWidth="1.8" />
          <rect x="56" y="26" width="24" height="6" rx="3" fill="#93c5fd" stroke="#2563eb" strokeWidth="1" />
        </g>
      );
    case 'homes':
      return (
        <g>
          {/* Sustainable Residential Building Roof & Chimney */}
          <polygon points="68,14 50,28 86,28" fill="#64748b" />
          <rect x="77" y="16" width="4" height="7" fill="#64748b" />
          {/* House Structure */}
          <rect x="54" y="28" width="28" height="20" fill="#94a3b8" />
          {/* Front Door */}
          <rect x="65" y="36" width="6" height="12" rx="1" fill="#475569" />
        </g>
      );
    case 'mains':
      return (
        <g>
          {/* Flanged Municipal Connection Base */}
          <line x1="50" y1="42" x2="86" y2="42" stroke="#475569" strokeWidth="3" strokeLinecap="round" />
          {/* Valve Stem */}
          <line x1="68" y1="26" x2="68" y2="42" stroke="#475569" strokeWidth="2.5" />
          {/* Valve Handwheel */}
          <circle cx="68" cy="21" r="8" fill="#ffffff" stroke="#475569" strokeWidth="2.5" />
        </g>
      );
  }
}

/* =========================================================================
   2D SCHEMATIC COMPONENT (Exact Match to User Reference Specification)
   ========================================================================= */
const orderedEquipment: EquipmentId[] = [
  'tank',
  'pump',
  'membrane',
  'uv',
  'solar',
  'mains',
  'homes',
];

function Schematic({
  snapshot,
  selected,
  onSelect,
  animate,
  compact,
  onSwitchTo3D,
}: Props & {
  animate: boolean;
  compact: boolean;
  onSwitchTo3D: () => void;
  onToggleMotion?: () => void;
}) {
  const [, setFocused] = useState<EquipmentId | null>(null);

  const nodePositions: Record<EquipmentId, [number, number]> = compact
    ? {
        solar: [140, 20],
        tank: [40, 140],
        pump: [240, 140],
        membrane: [40, 280],
        uv: [240, 280],
        mains: [40, 420],
        homes: [240, 420],
      }
    : {
        solar: [216, 24],
        tank: [32, 146],
        pump: [216, 146],
        membrane: [400, 146],
        uv: [584, 146],
        homes: [768, 146],
        mains: [680, 285],
      };

  const running = snapshot.connected && !snapshot.stopped && (snapshot.metrics.flow.value ?? 0) > 0;
  const rain = running && snapshot.source === 'rainwater';

  return (
    <div className="schematic-view-container">
      {/* 1. MAIN SCHEMATIC CANVAS: Precision Light Card Matching User Reference */}
      <div className="schematic-canvas-card">
        <svg
          viewBox={compact ? '0 0 420 580' : '0 0 980 430'}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="group"
          aria-label="Interactive installation schematic"
        >
          <defs>
            <filter id="schematic-card-shadow" x="-8%" y="-8%" width="120%" height="120%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#0f172a" floodOpacity="0.06" />
            </filter>
          </defs>

          {/* Light Slate Precision Canvas Card Background */}
          <rect
            x="12"
            y="10"
            width={compact ? 396 : 956}
            height={compact ? 560 : 408}
            rx="24"
            fill="#eaedf4"
            stroke="#d8e0eb"
            strokeWidth="1"
          />

          {/* Connective Pipes (Drawn behind the cards) */}
          {!compact && (
            <>
              {/* Rainwater Main: Tank -> Pump -> Membrane -> UV -> Community */}
              <g aria-hidden="true">
                <path
                  d="M 100 188 H 836"
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
                {rain && (
                  <path
                    d="M 100 188 H 836"
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="3"
                    strokeDasharray="3 14"
                  >
                    {animate && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="-34"
                        dur="1.2s"
                        repeatCount="indefinite"
                      />
                    )}
                  </path>
                )}
              </g>

              {/* Vertical Solar Array Power Line to Pump */}
              <g aria-hidden="true">
                <path
                  d="M 284 108 V 146"
                  fill="none"
                  stroke="#cbd5e1"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </g>

              {/* Mains Backup Interconnection Line into Community */}
              <g aria-hidden="true">
                <path
                  d="M 816 327 H 925 V 188 H 836"
                  fill="none"
                  stroke="#cbd5e1"
                  strokeWidth="6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            </>
          )}

          {/* Interactive White Equipment Cards */}
          {ids.map(id => {
            const [x, y] = nodePositions[id];
            const status = snapshot.equipment[id]?.status || 'normal';
            const isSel = selected === id;
            const isWarning = status === 'warning';
            const isCritical = status === 'critical';
            const statusLabel = isCritical ? 'Fault' : isWarning ? 'Warning' : 'Normal';
            const statusColor = isCritical ? '#ef4444' : isWarning ? '#d97706' : '#2563eb';
            const dotColor = isCritical ? '#ef4444' : isWarning ? '#d97706' : '#2563eb';

            return (
              <g
                key={id}
                transform={`translate(${x} ${y})`}
                role="button"
                tabIndex={0}
                aria-label={`${names[id]}, ${statusLabel}. Click to view details`}
                aria-pressed={isSel}
                onClick={() => onSelect(id)}
                onFocus={() => setFocused(id)}
                onBlur={() => setFocused(null)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(id);
                  }
                }}
                style={{ cursor: 'pointer', outline: 'none' }}
              >
                {/* Active Selection Glow Ring */}
                {isSel && (
                  <rect
                    x="-3"
                    y="-3"
                    width="142"
                    height="90"
                    rx="17"
                    fill="none"
                    stroke="#00f0ff"
                    strokeWidth="2.5"
                    opacity="0.95"
                  />
                )}

                {/* Warning Outer Golden Accent Ring */}
                {isWarning && !isSel && (
                  <rect
                    x="-3.5"
                    y="-3.5"
                    width="143"
                    height="91"
                    rx="17.5"
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="3"
                    opacity="0.9"
                  />
                )}

                {/* Card Body */}
                <rect
                  width="136"
                  height="84"
                  rx="14"
                  fill={isWarning ? '#fef9ee' : '#ffffff'}
                  stroke={isWarning ? '#f59e0b' : '#e2e8f0'}
                  strokeWidth={isWarning ? 1.8 : 1.2}
                  filter="url(#schematic-card-shadow)"
                />

                {/* Indicator Dot (Top-Right) */}
                <circle cx="120" cy="16" r="3.5" fill={dotColor} />

                {/* Equipment Vector Symbol */}
                <EquipmentSymbol id={id} isWarning={isWarning} />

                {/* Clean Equipment Title Inside Card */}
                <text
                  x="68"
                  y="66"
                  textAnchor="middle"
                  fill="#1e293b"
                  fontSize="13"
                  fontWeight="600"
                  fontFamily="Inter, system-ui, -apple-system, sans-serif"
                >
                  {names[id]}
                </text>

                {/* Status Label Underneath Card */}
                <text
                  x="68"
                  y="104"
                  textAnchor="middle"
                  fill={statusColor}
                  fontSize="13"
                  fontWeight="600"
                  fontFamily="Inter, system-ui, -apple-system, sans-serif"
                >
                  {statusLabel}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 2. FOOTER BAR: Subtitle & 3D Installation View Button */}
      <div className="schematic-footer-bar">
        <span className="schematic-footer-status">
          {animate
            ? 'Visual motion active · live readings continue'
            : 'Visual motion paused · live readings continue'}
        </span>
        <button
          type="button"
          className="schematic-footer-btn"
          onClick={onSwitchTo3D}
          aria-label="Switch to 3D installation view"
        >
          <span>3D installation view</span>
        </button>
      </div>

      {/* 3. NUMBERED EQUIPMENT STATUS CARDS (Rows 1 & 2 Matching User Reference) */}
      <div className="schematic-equipment-grid">
        {orderedEquipment.map((id, index) => {
          const status = snapshot.equipment[id]?.status || 'normal';
          const isSel = selected === id;
          const statusDisplay =
            status === 'warning' ? 'Warning' : status === 'critical' ? 'Critical' : 'Normal';
          const statusClass =
            status === 'warning' ? 'warning' : status === 'critical' ? 'critical' : 'normal';

          return (
            <button
              key={id}
              type="button"
              className={`schematic-eq-card ${isSel ? 'selected' : ''}`}
              onClick={() => onSelect(id)}
              aria-label={`${names[id]}, status: ${statusDisplay}`}
              aria-pressed={isSel}
            >
              <div className="schematic-eq-num">{index + 1}</div>
              <div className="schematic-eq-info">
                <span className="schematic-eq-name">{names[id]}</span>
                <span className={`schematic-eq-status ${statusClass}`}>
                  <span className="schematic-status-dot" />
                  <span>{statusDisplay}</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   TOP-LEVEL INSTALLATION SCENE (3D Digital Twin & 2D Schematic)
   ========================================================================= */
export default function InstallationScene(props: Props) {
  const [supported] = useState(webGLAvailable);
  const [mode, setMode] = useState<'3d' | '2d'>(supported ? '3d' : '2d');
  const [renderFailed, setRenderFailed] = useState(false);
  const [view, setView] = useState<CameraRequest>({ action: 'reset', sequence: 0 });
  const [paused, setPaused] = useState(false);
  const reducedMotion = useReducedMotion();
  const animate = !paused && !reducedMotion;
  const container = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(() => window.innerWidth < 1000);

  // Live ticking clock matching Picture 2
  const [currentTime, setCurrentTime] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedTime = currentTime.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const formattedDate = currentTime.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 800));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  const schematic = (
    <Schematic
      {...props}
      animate={animate}
      compact={compact}
      onSwitchTo3D={() => setMode('3d')}
      onToggleMotion={() => setPaused(v => !v)}
    />
  );

  const cameraButtons: { action: CameraAction; label: string; aria: string; icon: typeof RotateCcw }[] = [
    { action: 'left', label: 'Rotate left', aria: 'Rotate left', icon: RotateCcw },
    { action: 'right', label: 'Rotate right', aria: 'Rotate right', icon: RotateCw },
    { action: 'up', label: 'Tilt up', aria: 'Tilt up', icon: MoveUp },
    { action: 'down', label: 'Tilt down', aria: 'Tilt down', icon: MoveDown },
    { action: 'in', label: 'Zoom in', aria: 'Zoom in', icon: ZoomIn },
    { action: 'out', label: 'Zoom out', aria: 'Zoom out', icon: ZoomOut },
    { action: 'reset', label: 'Reset view', aria: 'Reset view', icon: RotateCcw },
  ];

  return (
    <div
      ref={container}
      className={`installation-scene ${mode === '2d' ? 'schematic-mode-active' : ''}`}
      style={{
        position: 'relative',
        borderRadius: 14,
        overflow: 'hidden',
        background: mode === '2d' ? '#0f1422' : '#f0f1f6',
        border: '1px solid #dbdee7',
      }}
    >
      <div
        className="scene-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 18px',
          flexWrap: 'wrap',
          position: 'relative',
          zIndex: 11,
          borderBottom: '1px solid #dee1eb',
        }}
      >
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: '#474d61', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <Droplets size={15} aria-hidden="true" color="#2f4aa4" />
            Water flow
          </span>
          <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <Sun size={15} aria-hidden="true" color="#946c20" />
            Solar energy
          </span>
        </div>

        {/* Action Buttons matching Picture 2 & Picture 3 */}
        <div className="scene-controls" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="scene-toolbar-btn"
            onClick={() => setPaused(v => !v)}
            aria-pressed={!animate}
            aria-label={animate ? 'Pause visual motion' : 'Resume visual motion'}
            title={reducedMotion ? 'Animations are paused by your reduced motion preference' : 'Pause animation without pausing live data'}
          >
            {animate ? (
              <>
                <Pause size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>Pause motion</span>
              </>
            ) : (
              <>
                <Play size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>{reducedMotion ? 'Reduced motion' : 'Resume motion'}</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="scene-toolbar-btn"
            onClick={() => {
              setRenderFailed(false);
              setMode(m => (m === '3d' ? '2d' : '3d'));
            }}
            aria-label={mode === '3d' ? 'Switch to 2D schematic view' : 'Switch to 3D installation view'}
          >
            {mode === '3d' ? (
              <>
                <LayoutGrid size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>2D schematic</span>
              </>
            ) : (
              <>
                <Box size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>3D installation</span>
              </>
            )}
          </button>
        </div>
      </div>

      {mode === '2d' ? (
        schematic
      ) : (
        <>
          {renderFailed && (
            <p role="status" style={{ margin: 0, padding: '12px 18px 0', color: '#525767', fontSize: 12 }}>
              The 3D view could not render. The schematic shows the same live equipment; you can retry 3D above.
            </p>
          )}
          {!supported && (
            <p style={{ margin: 0, padding: '12px 18px 0', color: '#525767', fontSize: 12 }}>
              This device uses the interactive schematic. Live readings and equipment details remain available.
            </p>
          )}
          <SceneBoundary key={mode} fallback={schematic} onError={() => { setRenderFailed(true); setMode('2d'); }}>
            <div className="scene-stage" style={{ height: compact ? 400 : 470 }}>
              <Canvas
                shadows
                frameloop={animate ? 'always' : 'demand'}
                camera={{ position: cameraPosition, fov: 39, near: 0.1, far: 100 }}
                dpr={[1, 1.5]}
                gl={{ antialias: true, powerPreference: 'high-performance' }}
                role="group"
                aria-label="Interactive 3D water treatment installation. Equipment and camera controls are available below"
                onPointerMissed={() => props.onSelect(null)}
              >
                <Suspense fallback={null}><Scene {...props} view={view} animate={animate} compact={compact || Boolean(props.immersive)} immersive={props.immersive} /></Suspense>
              </Canvas>
            </div>
          </SceneBoundary>
          <div className="scene-view-controls" role="group" aria-label="Installation camera controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 18px 16px' }}>
            {cameraButtons.map(({ action, label, aria, icon: Icon }) => (
              <button key={action} type="button" style={{ ...baseStyle, minHeight: 36, padding: '6px 10px' }} aria-label={aria} title={aria} onClick={() => setView(current => ({ action, sequence: current.sequence + 1 }))}>
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <div className="scene-caption" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 18px 16px', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#525767', lineHeight: 1.5 }}>
              {!animate ? 'Visual motion paused · live readings continue' : 'Rotate with the controls or drag · select equipment to inspect'}
            </span>
            <span style={{ fontSize: 12, color: '#374060', background: '#e0e3ec', borderRadius: 20, padding: '5px 10px', fontWeight: 500 }}>
              3D installation view
            </span>
          </div>
          <div className="scene-equipment-list" role="group" aria-label="Select installation equipment" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, background: 'rgba(255,255,255,.75)', borderTop: '1px solid #dbdee7', padding: 16 }}>
            {ids.map((id, index) => (
              <button className="scene-equipment-button" key={id} type="button" onClick={() => props.onSelect(id)} aria-pressed={props.selected === id} aria-label={`${names[id]}, ${props.snapshot.equipment[id].status}. View details`} style={{ ...baseStyle, justifyContent: 'flex-start', gap: 9, padding: '10px 12px', minHeight: 54, background: props.selected === id ? '#e7eaf6' : '#ffffff', border: `1px solid ${props.selected === id ? '#596aa4' : '#d9dbe4'}`, textAlign: 'left' }}>
                <span aria-hidden="true" style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: props.selected === id ? '#cdd4eb' : '#edeef3', color: '#424963', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600 }}>{index + 1}</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{names[id]}</span>
                  <span style={{ color: listTones[props.snapshot.equipment[id].status], textTransform: 'capitalize', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: tones[props.snapshot.equipment[id].status] }} />
                    {props.snapshot.equipment[id].status}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

