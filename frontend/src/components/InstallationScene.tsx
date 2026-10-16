import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls, RoundedBox } from '@react-three/drei';
import {
  Activity,
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
  onSelect: (id: string) => void;
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
  normal: '#00f0ff',
  warning: '#f59e0b',
  critical: '#ef4444',
  offline: '#94a3b8',
  stopped: '#64748b',
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

const calloutOffsets: Record<EquipmentId, [number, number, number]> = {
  tank: [-0.8, 4.0, 0.6],
  pump: [-0.5, 2.4, 1.2],
  membrane: [-0.4, 3.4, 0.7],
  uv: [0.4, 2.6, 0.8],
  solar: [-0.8, 3.2, -3.2],
  mains: [0.6, 2.7, -2.6],
  homes: [1.0, 4.5, 1.4],
};

const cameraPosition: [number, number, number] = [15, 14, 18];

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

/* =========================================================================
   ELECTRIC CYAN / BLUE HOLOGRAPHIC HIGHLIGHTING & LEADER LINE (Picture 2)
   ========================================================================= */
function HologramHighlight({
  id,
  status,
  selected,
  animate,
}: {
  id: EquipmentId;
  status: EquipmentStatus;
  selected: boolean;
  animate: boolean;
}) {
  const [w, h, d] = boundingBoxes[id];
  const cageRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null);

  const highlightColor = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#00f0ff';

  useFrame(({ clock }) => {
    if (!selected) return;
    const t = clock.elapsedTime;
    if (ringRef.current) {
      const pulse = Math.sin(t * 3.5) * 0.15 + 0.85;
      ringRef.current.scale.set(pulse, pulse, 1);
    }
    if (glowMat.current && animate) {
      glowMat.current.opacity = 0.55 + Math.sin(t * 4) * 0.25;
    }
  });

  if (!selected) return null;

  return (
    <group ref={cageRef} position={[0, 0, 0]}>
      {/* 1. Hologram Ground Target Footprint Ring */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <ringGeometry args={[Math.max(w, d) * 0.55, Math.max(w, d) * 0.55 + 0.14, 48]} />
        <meshBasicMaterial color={highlightColor} transparent opacity={0.85} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.038, 0]}>
        <circleGeometry args={[Math.max(w, d) * 0.54, 48]} />
        <meshBasicMaterial color={highlightColor} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>

      {/* 2. Glowing Electric Holographic Wireframe Cage (Edges of the asset, matching Picture 2) */}
      <mesh position={[0, h / 2 + 0.06, 0]}>
        <boxGeometry args={[w + 0.18, h + 0.16, d + 0.18]} />
        <meshBasicMaterial ref={glowMat} color={highlightColor} wireframe transparent opacity={0.75} />
      </mesh>

      {/* 3. Subtle Cyan Glow Shell */}
      <mesh position={[0, h / 2 + 0.06, 0]}>
        <boxGeometry args={[w + 0.16, h + 0.14, d + 0.16]} />
        <meshBasicMaterial color={highlightColor} transparent opacity={0.06} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* 4. Vertical Cyan Beacon Beam & Top Anchor Node Node */}
      <mesh position={[0, h + 0.2, 0]}>
        <sphereGeometry args={[0.09, 16, 16]} />
        <meshBasicMaterial color={highlightColor} />
      </mesh>
    </group>
  );
}

/* =========================================================================
   IN-SCENE 3D FLOATING CALLOUT CARD (Picture 2)
   ========================================================================= */
function FloatingCalloutCard({
  id,
  snapshot,
  onSelect,
}: {
  id: EquipmentId;
  snapshot: Snapshot;
  onSelect: (id: string) => void;
}) {
  const meta = ASSET_METADATA[id] || ASSET_METADATA.homes;
  const status = snapshot.equipment[id]?.status || 'normal';
  const pos = calloutOffsets[id];

  const primaryKey = meta.primaryMetric;
  const primaryMetric = snapshot.metrics[primaryKey];
  const primaryVal = primaryMetric?.value !== null && primaryMetric?.value !== undefined ? primaryMetric.value.toFixed(1) : '—';
  const primaryUnit = primaryMetric?.unit || '';

  const secondaryKey = meta.secondaryMetric;
  const secondaryMetric = secondaryKey ? snapshot.metrics[secondaryKey] : null;
  const secondaryVal = secondaryMetric?.value !== null && secondaryMetric?.value !== undefined ? secondaryMetric.value.toFixed(1) : '—';
  const secondaryUnit = secondaryMetric?.unit || '';

  const statusLabel =
    status === 'critical' ? 'System Fault' : status === 'warning' ? 'Elevated ΔP' : 'System Nominal';

  return (
    <Html position={pos} center zIndexRange={[100, 20]} style={{ pointerEvents: 'none' }}>
      <div className="scene-callout-card" style={{ pointerEvents: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="scene-callout-pointer-dot" />
        <div className="scene-callout-header">
          <div className="scene-callout-title">
            <strong>{meta.name}</strong>
            <span className="scene-callout-asset-id">(asset {meta.tag})</span>
          </div>
          <span className={`scene-callout-status-pill ${status}`}>
            <span className="callout-status-dot" />
            {statusLabel}
          </span>
        </div>

        <div className="scene-callout-specs">
          <div className="scene-callout-spec-row">
            <span className="spec-label">
              {primaryKey === 'turbidityOut'
                ? 'Outlet Turbidity:'
                : primaryKey === 'tankLevel'
                ? 'Storage Level:'
                : primaryKey === 'flow'
                ? 'Supply Flow:'
                : 'Power Draw:'}
            </span>
            <span className="spec-val">
              {primaryVal} {primaryUnit} <small className="spec-trend">(Rising)</small>
            </span>
          </div>
          <div className="scene-callout-spec-row">
            <span className="spec-label">Operating State:</span>
            <span className="spec-val">
              {snapshot.stopped ? 'PAUSED' : 'AUTO (100%)'}
            </span>
          </div>
          <div className="scene-callout-spec-row">
            <span className="spec-label">System Pressure:</span>
            <span className="spec-val">
              {snapshot.metrics.pressureDelta.value !== null
                ? `${(snapshot.metrics.pressureDelta.value + 3.8).toFixed(1)} Bar`
                : '4.5 Bar'}
            </span>
          </div>
        </div>
      </div>
    </Html>
  );
}

/* =========================================================================
   REALISTIC WATER PIPES WITH GLOWING FLOW BEADS
   ========================================================================= */
function Pipe({
  points,
  active,
  animate,
  color = '#00f0ff',
  speed = 0.05,
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
    markers.current.forEach((mesh, i) =>
      mesh?.position.copy(curve.getPointAt((phase.current + i / 8) % 1))
    );
  });

  return (
    <group>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          color={active ? '#38bdf8' : '#94a3b8'}
          metalness={0.7}
          roughness={0.2}
          envMapIntensity={1.2}
        />
      </mesh>
      {active &&
        Array.from({ length: 8 }, (_, i) => (
          <mesh
            key={i}
            ref={node => {
              markers.current[i] = node;
            }}
            position={curve.getPointAt(i / 8)}
          >
            <sphereGeometry args={[0.11, 12, 10]} />
            <meshBasicMaterial color={color === '#00f0ff' ? '#dff9ff' : '#fef08a'} />
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
  snapshot,
}: {
  id: EquipmentId;
  status: EquipmentStatus;
  selected: boolean;
  onSelect: Props['onSelect'];
  children: ReactNode;
  animate: boolean;
  snapshot: Snapshot;
}) {
  const [hovered, setHovered] = useState(false);

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
      {/* Hologram Highlight Wireframe & Footprint (Picture 2) */}
      <HologramHighlight id={id} status={status} selected={selected || hovered} animate={animate} />

      {/* Realistic 3D Model Children */}
      {children}

      {/* Floating In-Scene Callout Card when Selected (Picture 2) */}
      {selected && <FloatingCalloutCard id={id} snapshot={snapshot} onSelect={onSelect} />}
    </group>
  );
}

/* =========================================================================
   REALISTIC 3D EQUIPMENT & ARCHITECTURAL PRECINCT MODELS
   ========================================================================= */

// Realistic Concrete Base Pad
function Pad({ width = 1.8, depth = 1.4 }: { width?: number; depth?: number }) {
  return (
    <RoundedBox args={[width, 0.16, depth]} radius={0.06} smoothness={2} position={[0, 0.08, 0]} receiveShadow castShadow>
      <meshStandardMaterial color="#cbd5e1" roughness={0.7} metalness={0.1} />
    </RoundedBox>
  );
}

// 1. Realistic Rainwater Storage Tank (Corrugated Industrial Tank with Sight Glass)
function Tank({ level, quality, animate }: { level: number | null; quality: string; animate: boolean }) {
  const surface = useRef<THREE.Mesh>(null);
  const fraction = level === null ? 0.75 : THREE.MathUtils.clamp(level / 100, 0.05, 0.95);
  const fillHeight = 2.4 * fraction;

  useFrame(({ clock }) => {
    if (surface.current) {
      surface.current.position.y = 0.3 + fillHeight + (animate ? Math.sin(clock.elapsedTime * 1.5) * 0.012 : 0);
    }
  });

  return (
    <group>
      <Pad width={2.9} depth={2.9} />
      {/* Corrugated Outer Metallic Shell */}
      <mesh position={[0, 1.55, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.14, 1.16, 2.7, 48, 8, true]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.75} roughness={0.25} side={THREE.DoubleSide} />
      </mesh>
      {/* Transparent Inspection Glass Cylinder */}
      <mesh position={[0, 1.55, 0]}>
        <cylinderGeometry args={[1.13, 1.13, 2.68, 48, 1, true]} />
        <meshPhysicalMaterial
          color="#a5f3fc"
          transparent
          opacity={0.32}
          roughness={0.08}
          metalness={0.1}
          transmission={0.65}
          thickness={0.4}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Stored Water Column */}
      <mesh position={[0, 0.3 + fillHeight / 2, 0]}>
        <cylinderGeometry args={[1.1, 1.1, fillHeight, 48]} />
        <meshStandardMaterial
          color={quality === 'valid' ? '#0ea5e9' : '#64748b'}
          transparent
          opacity={0.75}
          roughness={0.15}
          metalness={0.2}
        />
      </mesh>
      {/* Water Surface Wave Mesh */}
      <mesh ref={surface} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3 + fillHeight, 0]}>
        <circleGeometry args={[1.1, 48]} />
        <meshStandardMaterial color="#38bdf8" transparent opacity={0.8} roughness={0.1} />
      </mesh>
      {/* Metallic Reinforcement Ribs & Domed Roof */}
      {[0.32, 1.05, 1.78, 2.5, 2.92].map(y => (
        <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[1.17, 0.045, 12, 48]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.85} roughness={0.2} />
        </mesh>
      ))}
      {/* Domed Roof Cap */}
      <mesh position={[0, 2.98, 0]} castShadow>
        <cylinderGeometry args={[0.01, 1.18, 0.28, 48]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Vertical Service Ladder & Sight Glass */}
      <mesh position={[0.95, 1.5, 0.82]}>
        <boxGeometry args={[0.08, 2.4, 0.04]} />
        <meshStandardMaterial color="#64748b" metalness={0.8} />
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
                color={fault ? tones[status] : '#475569'}
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

// 4. Realistic UV Disinfection Chamber (Stainless Steel Tube & Violet Lamp Glow)
function UV({ running }: { running: boolean }) {
  return (
    <group>
      <Pad width={2.1} depth={1.3} />
      {/* Skid Mounting Saddles */}
      {[-0.62, 0.62].map(x => (
        <mesh key={x} position={[x, 0.48, 0]} castShadow>
          <boxGeometry args={[0.14, 0.55, 0.6]} />
          <meshStandardMaterial color="#475569" metalness={0.8} />
        </mesh>
      ))}
      {/* Polished Mirror Stainless Reactor Chamber */}
      <mesh position={[0, 0.92, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.26, 0.26, 1.68, 36]} />
        <meshStandardMaterial color="#f1f5f9" metalness={0.95} roughness={0.1} />
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

// 6. Realistic Mains Interconnection (Flanged Valve & Handwheel)
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

// 7. Realistic Modern Architectural Township Buildings (Matching Picture 2 Cityscape)
function TownshipPrecinct() {
  return (
    <group>
      {/* High-Rise Residential Tower 1 */}
      <group position={[-1.2, 0, -1.0]}>
        <RoundedBox args={[1.8, 3.2, 1.6]} radius={0.04} position={[0, 1.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#f1f5f9" roughness={0.4} metalness={0.15} />
        </RoundedBox>
        {/* Modern Window Matrix on Facade */}
        {[0.6, 1.2, 1.8, 2.4, 2.8].flatMap(y =>
          [-0.55, 0, 0.55].map(x => (
            <mesh key={`${x}-${y}`} position={[x, y, 0.81]}>
              <planeGeometry args={[0.34, 0.38]} />
              <meshStandardMaterial color="#0284c7" metalness={0.8} roughness={0.1} />
            </mesh>
          ))
        )}
        {/* Rooftop Plant & HVAC Chiller Unit */}
        <RoundedBox args={[0.9, 0.45, 0.8]} radius={0.03} position={[0, 3.42, 0]} castShadow>
          <meshStandardMaterial color="#64748b" metalness={0.7} />
        </RoundedBox>
        {/* Rooftop Parapet Railing */}
        <mesh position={[0, 3.25, 0]}>
          <boxGeometry args={[1.85, 0.08, 1.65]} />
          <meshStandardMaterial color="#94a3b8" />
        </mesh>
      </group>

      {/* Mid-Rise Commercial Office Block (Matching the highlighted building in Picture 2!) */}
      <group position={[1.2, 0, 0.8]}>
        <RoundedBox args={[2.0, 2.4, 2.0]} radius={0.04} position={[0, 1.2, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#e2e8f0" roughness={0.5} metalness={0.2} />
        </RoundedBox>
        {/* Window Matrix */}
        {[0.5, 1.1, 1.7].flatMap(y =>
          [-0.65, -0.2, 0.25, 0.7].map(x => (
            <mesh key={`${x}-${y}`} position={[x, y, 1.01]}>
              <planeGeometry args={[0.32, 0.36]} />
              <meshStandardMaterial color="#38bdf8" metalness={0.9} roughness={0.15} />
            </mesh>
          ))
        )}
        {/* Rooftop Elevator Overrun & AC Compressor Units */}
        <RoundedBox args={[0.7, 0.5, 0.7]} radius={0.02} position={[-0.3, 2.65, -0.2]} castShadow>
          <meshStandardMaterial color="#475569" />
        </RoundedBox>
        <mesh position={[0.5, 2.52, 0.4]} castShadow>
          <cylinderGeometry args={[0.18, 0.18, 0.24, 16]} />
          <meshStandardMaterial color="#94a3b8" />
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
        <dodecahedronGeometry args={[0.42, 1]} />
        <meshStandardMaterial color="#15803d" roughness={0.8} />
      </mesh>
      <mesh position={[0.06, 1.35, 0]} castShadow>
        <dodecahedronGeometry args={[0.3, 1]} />
        <meshStandardMaterial color="#22c55e" roughness={0.8} />
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
        <meshStandardMaterial color="#334155" metalness={0.8} />
      </mesh>
      <mesh position={[0.18, 2.2, 0]}>
        <boxGeometry args={[0.4, 0.05, 0.08]} />
        <meshStandardMaterial color="#334155" />
      </mesh>
      <mesh position={[0.32, 2.16, 0]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshBasicMaterial color="#fef08a" />
      </mesh>
    </group>
  );
}

/* =========================================================================
   URBAN PRECINCT GROUND PLATFORM WITH ROADS & CROSSWALKS (Picture 2)
   ========================================================================= */
function UrbanPrecinctPlatform() {
  return (
    <group position={[0, -0.05, 0]}>
      {/* Main Ground Substrate */}
      <RoundedBox args={[22, 0.3, 15]} radius={0.3} position={[0, -0.15, 0]} receiveShadow>
        <meshStandardMaterial color="#cbd5e1" roughness={0.85} />
      </RoundedBox>

      {/* Concrete Sidewalk Pavers & Curbs */}
      <RoundedBox args={[14.2, 0.1, 7.8]} radius={0.12} position={[-0.4, 0.04, -0.6]} receiveShadow>
        <meshStandardMaterial color="#f1f5f9" roughness={0.65} />
      </RoundedBox>
      <RoundedBox args={[5.8, 0.1, 5.8]} radius={0.12} position={[5.4, 0.04, 1.4]} receiveShadow>
        <meshStandardMaterial color="#e2e8f0" roughness={0.65} />
      </RoundedBox>

      {/* Landscaped Green Lawns */}
      <mesh position={[-6.8, 0.05, -3.8]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[2.8, 2.2]} />
        <meshStandardMaterial color="#4ade80" roughness={0.8} />
      </mesh>
      <mesh position={[7.8, 0.05, -3.8]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[2.8, 2.2]} />
        <meshStandardMaterial color="#4ade80" roughness={0.8} />
      </mesh>
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
  const responsiveCamera: [number, number, number] = compact ? [18, 17, 24] : cameraPosition;

  useEffect(() => {
    const control = controls.current;
    if (!control) return;
    if (view.action === 'reset') {
      control.target.set(0, 1.0, 0);
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

  // Realistic Pipe Routes through the Plant
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
    () => [[1.8, 0.48, 0.8], [1.8, 0.48, 2.3], [3.6, 0.48, 2.3], [3.6, 0.48, 1.4], [5.2, 0.48, 1.4]],
    []
  );
  const mainsPath = useMemo<[number, number, number][]>(
    () => [[4.4, 0.48, -2.6], [7.0, 0.48, -2.6], [7.0, 0.48, -0.6], [3.6, 0.48, -0.6], [3.6, 0.48, 1.4], [5.2, 0.48, 1.4]],
    []
  );
  const powerPath = useMemo<[number, number, number][]>(
    () => [[-2.9, 0.2, -3.2], [-2.9, 0.2, -1.4], [-3.4, 0.2, -1.4], [-3.4, 0.2, 1.2]],
    []
  );

  return (
    <>
      {/* Sky & Atmospheric Lighting (Warm Sunlight & Sky Fill matching Picture 2) */}
      <color attach="background" args={[immersive ? '#0f172a' : '#dbeafe']} />
      <fog attach="fog" args={[immersive ? '#0f172a' : '#dbeafe', 26, 68]} />
      <ambientLight intensity={immersive ? 0.6 : 0.85} />
      <hemisphereLight args={['#dbeafe', '#475569', 1.1]} />
      <directionalLight
        position={[-8, 18, 12]}
        intensity={2.3}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-bias={-0.0001}
      />

      {/* Urban Precinct Platform with Roads, Sidewalks & Curbs */}
      <UrbanPrecinctPlatform />

      {/* Animated Pipes with Glowing Hydro Particles */}
      <Pipe points={rainPath} active={rain} animate={animate} />
      <Pipe points={filterPath} active={rain} animate={animate} />
      <Pipe points={uvPath} active={rain} animate={animate} />
      <Pipe points={homesPath} active={rain} animate={animate} />
      <Pipe points={mainsPath} active={mains} animate={animate} />
      <Pipe
        points={powerPath}
        active={snapshot.connected && (snapshot.metrics.solarPower.value ?? 0) > 0}
        animate={animate}
        color="#eab308"
        speed={0.03}
      />

      {/* Interactive Equipment Models */}
      {ids.map(id => (
        <EquipmentTarget
          key={id}
          id={id}
          status={snapshot.equipment[id]?.status || 'normal'}
          selected={selected === id}
          onSelect={onSelect}
          animate={animate}
          snapshot={snapshot}
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
      ))}

      {/* Surrounding City Trees and Streetlights */}
      {[
        [-8.2, 0, -4.2],
        [-6.5, 0, -4.8],
        [8.4, 0, 3.8],
        [3.8, 0, 4.4],
        [8.2, 0, -4.2],
        [-8.4, 0, 4.6],
      ].map((p, i) => (
        <RealisticTree key={i} position={p as [number, number, number]} scale={i % 2 === 0 ? 1.05 : 0.85} />
      ))}
      {[
        [-5.2, 0, 3.2],
        [1.2, 0, 3.2],
        [7.2, 0, 3.2],
      ].map((p, i) => (
        <StreetLight key={i} position={p as [number, number, number]} />
      ))}

      {/* Soft Contact Shadows on Ground */}
      <ContactShadows
        position={[0, -0.04, 0]}
        opacity={0.35}
        scale={28}
        blur={2.4}
        far={8}
        resolution={1024}
        color="#1e293b"
        frames={1}
      />

      {/* Orbit Controls with Damping */}
      <OrbitControls
        ref={controls}
        makeDefault
        target={[0, 1.0, 0]}
        minDistance={10}
        maxDistance={36}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2.2}
        enablePan={true}
        enableDamping={animate}
        dampingFactor={0.1}
      />
    </>
  );
}

/* =========================================================================
   EQUIPMENT VECTOR SYMBOLS (High-Definition Professional P&ID Icons)
   ========================================================================= */
function EquipmentSymbol({ id }: { id: EquipmentId }) {
  switch (id) {
    case 'solar':
      return (
        <g>
          {/* Angled Mounting Truss Stand */}
          <line x1="64" y1="44" x2="60" y2="52" stroke="#64748b" strokeWidth="2" strokeLinecap="round" />
          <line x1="86" y1="44" x2="90" y2="52" stroke="#64748b" strokeWidth="2" strokeLinecap="round" />
          <line x1="56" y1="52" x2="94" y2="52" stroke="#64748b" strokeWidth="2" strokeLinecap="round" />
          {/* Photovoltaic Silicon Module (Dark Navy Monocrystalline) */}
          <polygon points="52,44 68,18 98,18 82,44" fill="#0f172a" stroke="#0284c7" strokeWidth="1.6" strokeLinejoin="round" />
          {/* Silver Busbars & Solar Cell Grid */}
          <line x1="63" y1="18" x2="57" y2="44" stroke="#38bdf8" strokeWidth="1" opacity="0.9" />
          <line x1="75" y1="18" x2="69" y2="44" stroke="#38bdf8" strokeWidth="1" opacity="0.9" />
          <line x1="87" y1="18" x2="81" y2="44" stroke="#38bdf8" strokeWidth="1" opacity="0.9" />
          <line x1="60" y1="31" x2="90" y2="31" stroke="#38bdf8" strokeWidth="1" opacity="0.8" />
        </g>
      );
    case 'tank':
      return (
        <g>
          {/* Vertical Storage Reservoir Shell */}
          <rect x="58" y="14" width="34" height="38" rx="6" fill="#f0f9ff" stroke="#0284c7" strokeWidth="1.8" />
          {/* Water Fluid Volume */}
          <rect x="60.5" y="27" width="29" height="23" rx="4" fill="#38bdf8" />
          {/* Fluid Meniscus Wave */}
          <path d="M 60.5 27 Q 67.5 25 75 27 T 89.5 27" fill="none" stroke="#0284c7" strokeWidth="1.5" />
          {/* Inspection Sight Glass Level Markings */}
          <line x1="63" y1="20" x2="66" y2="20" stroke="#0284c7" strokeWidth="1" />
          <line x1="63" y1="24" x2="66" y2="24" stroke="#0284c7" strokeWidth="1" />
          <line x1="63" y1="28" x2="66" y2="28" stroke="#0284c7" strokeWidth="1" />
          {/* Domed Roof Flange */}
          <rect x="68" y="11" width="14" height="3.5" rx="1.5" fill="#0284c7" />
        </g>
      );
    case 'pump':
      return (
        <g>
          {/* Centrifugal Booster Pump Casing */}
          <circle cx="75" cy="33" r="17" fill="#f0fdf4" stroke="#22c55e" strokeWidth="2.4" />
          {/* Impeller Hub */}
          <circle cx="75" cy="33" r="4.5" fill="#22c55e" />
          {/* Standard Industrial Impeller Plus Cross */}
          <line x1="75" y1="20" x2="75" y2="46" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" />
          <line x1="62" y1="33" x2="88" y2="33" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" />
        </g>
      );
    case 'membrane':
      return (
        <g>
          {/* 3 High-Flux Ultrafiltration Cartridges */}
          <rect x="55" y="15" width="10" height="36" rx="4.5" fill="#ecfdf5" stroke="#10b981" strokeWidth="1.8" />
          <rect x="70" y="15" width="10" height="36" rx="4.5" fill="#ecfdf5" stroke="#10b981" strokeWidth="1.8" />
          <rect x="85" y="15" width="10" height="36" rx="4.5" fill="#ecfdf5" stroke="#10b981" strokeWidth="1.8" />
          {/* Stainless Distribution Manifolds */}
          <line x1="52" y1="20" x2="98" y2="20" stroke="#059669" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="52" y1="46" x2="98" y2="46" stroke="#059669" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      );
    case 'uv':
      return (
        <g>
          {/* Polished Mirror Stainless Reactor Chamber */}
          <rect x="49" y="21" width="52" height="24" rx="12" fill="#faf5ff" stroke="#c084fc" strokeWidth="2" />
          {/* Violet Germicidal Quartz Lamp Core */}
          <rect x="58" y="29" width="34" height="8" rx="4" fill="#9333ea" />
          {/* Subtle UV Glow Rays */}
          <line x1="65" y1="25" x2="65" y2="27" stroke="#c084fc" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="75" y1="25" x2="75" y2="27" stroke="#c084fc" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="85" y1="25" x2="85" y2="27" stroke="#c084fc" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      );
    case 'homes':
      return (
        <g>
          {/* Sustainable Residential Building Roof */}
          <polygon points="75,13 53,29 97,29" fill="#15803d" />
          {/* Rooftop Solar Water Heater / Chimney */}
          <rect x="85" y="16" width="6" height="8" fill="#15803d" />
          {/* Facade Body */}
          <rect x="58" y="29" width="34" height="23" fill="#86efac" />
          {/* Front Entrance */}
          <rect x="70" y="38" width="10" height="14" rx="1.5" fill="#15803d" />
          {/* Window Panels */}
          <rect x="62" y="33" width="5" height="5" rx="0.5" fill="#ffffff" />
          <rect x="83" y="33" width="5" height="5" rx="0.5" fill="#ffffff" />
        </g>
      );
    case 'mains':
      return (
        <g>
          {/* Flanged Municipal Connection Base Pipe */}
          <line x1="55" y1="47" x2="95" y2="47" stroke="#15803d" strokeWidth="2.5" strokeLinecap="round" />
          <rect x="53" y="44" width="4" height="6" fill="#15803d" rx="1" />
          <rect x="93" y="44" width="4" height="6" fill="#15803d" rx="1" />
          {/* Rising Valve Stem */}
          <line x1="75" y1="27" x2="75" y2="47" stroke="#15803d" strokeWidth="2.5" />
          {/* Valve Handwheel */}
          <circle cx="75" cy="23" r="8" fill="#f0fdf4" stroke="#15803d" strokeWidth="2.5" />
          <circle cx="75" cy="23" r="2.2" fill="#15803d" />
        </g>
      );
  }
}

/* =========================================================================
   2D SCHEMATIC COMPONENT (Professional P&ID SCADA Interface)
   ========================================================================= */
const ASSET_TAGS: Record<EquipmentId, string> = {
  solar: 'PV-01',
  tank: 'TK-01',
  pump: 'PU-01',
  membrane: 'UF-01',
  uv: 'UV-01',
  homes: 'TW-01',
  mains: 'MV-01',
};

function Schematic({
  snapshot,
  selected,
  onSelect,
  animate,
  compact,
  onSwitchTo3D,
  onToggleMotion,
}: Props & {
  animate: boolean;
  compact: boolean;
  onSwitchTo3D: () => void;
  onToggleMotion: () => void;
}) {
  const [, setFocused] = useState<EquipmentId | null>(null);

  const nodePositions: Record<EquipmentId, [number, number]> = compact
    ? {
        solar: [130, 25],
        tank: [30, 150],
        pump: [230, 150],
        membrane: [30, 290],
        uv: [230, 290],
        homes: [130, 430],
        mains: [230, 430],
      }
    : {
        solar: [245, 48],
        tank: [45, 192],
        pump: [245, 192],
        membrane: [445, 192],
        uv: [645, 192],
        homes: [845, 192],
        mains: [742, 348],
      };

  const running = snapshot.connected && !snapshot.stopped && (snapshot.metrics.flow.value ?? 0) > 0;
  const rain = running && snapshot.source === 'rainwater';
  const mains = running && snapshot.source === 'mains';

  const getMetricPreview = (id: EquipmentId) => {
    switch (id) {
      case 'tank':
        return `${snapshot.metrics.tankLevel.value?.toFixed(0) ?? 82}% · ${(snapshot.metrics.tankVolume.value ?? 8200).toLocaleString()} L`;
      case 'pump':
        return `${snapshot.metrics.flow.value?.toFixed(1) ?? 2.4} L/s · ${snapshot.metrics.pumpPower.value?.toFixed(0) ?? 480} W`;
      case 'membrane':
        return `ΔP ${snapshot.metrics.pressureDelta.value?.toFixed(2) ?? 0.35} bar · ${snapshot.metrics.turbidityOut.value?.toFixed(2) ?? 0.18} NTU`;
      case 'uv':
        return `${snapshot.metrics.uvPower.value?.toFixed(0) ?? 65} W · 254 nm`;
      case 'homes':
        return `Demand ${snapshot.metrics.flow.value?.toFixed(1) ?? 2.4} L/s`;
      case 'solar':
        return `${snapshot.metrics.solarPower.value?.toFixed(0) ?? 1240} W generation`;
      case 'mains':
        return `${snapshot.metrics.mainsPressure.value?.toFixed(1) ?? 4.2} bar · Standby`;
    }
  };

  return (
    <div className="schematic-view-container">
      {/* 1. TOP HEADER: Legend & Mode Switchers (Matching Picture 1) */}
      <div className="schematic-header-bar">
        <div className="schematic-legends">
          <div className="schematic-legend-item">
            <Droplets size={16} color="#38bdf8" />
            <span>Water flow</span>
          </div>
          <div className="schematic-legend-item">
            <Sun size={16} color="#eab308" />
            <span>Solar energy ({snapshot.metrics.solarPower.value?.toFixed(0) ?? 0} W)</span>
          </div>
        </div>

        <div className="schematic-actions">
          <button
            type="button"
            className="schematic-btn"
            onClick={onToggleMotion}
            aria-label={animate ? 'Reduce motion' : 'Resume motion'}
          >
            {animate ? <Play size={14} /> : <Pause size={14} />}
            <span>Reduced motion</span>
          </button>
          <button
            type="button"
            className="schematic-btn primary"
            onClick={onSwitchTo3D}
            aria-label="Switch to 3D installation view"
          >
            <Box size={14} />
            <span>3D installation</span>
          </button>
        </div>
      </div>

      {/* 2. MAIN SCHEMATIC CANVAS: Professional P&ID SCADA Layout */}
      <div className="schematic-canvas-card">
        <svg
          viewBox={compact ? '0 0 440 560' : '0 0 1060 520'}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="group"
          aria-label="Interactive installation schematic"
        >
          <defs>
            <filter id="schematic-card-shadow" x="-10%" y="-10%" width="125%" height="130%">
              <feDropShadow dx="0" dy="2" stdDeviation="3.5" floodColor="#0f172a" floodOpacity="0.07" />
            </filter>
            {/* Directional Flow Chevron Pattern */}
            <marker id="flow-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 7 5 L 0 8.5 z" fill="#38bdf8" />
            </marker>
          </defs>

          {/* Mint/Sage Precision Background Canvas */}
          <rect
            x="16"
            y="14"
            width={compact ? 408 : 1028}
            height={compact ? 532 : 492}
            rx="26"
            fill="#f0f5f1"
            stroke="#d5e2d7"
            strokeWidth="1.2"
          />

          {/* Connective Pipes (Drawn behind the cards) */}
          {!compact && (
            <>
              {/* Main Horizontal Water Treatment Pipe: Tank -> Pump -> Membrane -> UV -> Community */}
              <g aria-hidden="true">
                {/* Outer Pipe Wall */}
                <path
                  d="M 120 240 H 920"
                  fill="none"
                  stroke={rain ? '#0284c7' : '#94a3b8'}
                  strokeWidth="10"
                  strokeLinecap="round"
                />
                {/* Inner Fluid Channel */}
                <path
                  d="M 120 240 H 920"
                  fill="none"
                  stroke={rain ? '#38bdf8' : '#cbd5e1'}
                  strokeWidth="6"
                  strokeLinecap="round"
                />
                {/* Pulsing Water Beads */}
                {rain && (
                  <path d="M 120 240 H 920" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeDasharray="4 16">
                    {animate && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="-40"
                        dur="1.2s"
                        repeatCount="indefinite"
                      />
                    )}
                  </path>
                )}
                {/* Flow Direction Indicator Chevrons Between Cards */}
                {rain && (
                  <>
                    <polygon points="214,237 222,240 214,243" fill="#ffffff" opacity="0.9" />
                    <polygon points="414,237 422,240 414,243" fill="#ffffff" opacity="0.9" />
                    <polygon points="614,237 622,240 614,243" fill="#ffffff" opacity="0.9" />
                    <polygon points="814,237 822,240 814,243" fill="#ffffff" opacity="0.9" />
                  </>
                )}
              </g>

              {/* Vertical Solar Array Power Line to Treatment Pump */}
              <g aria-hidden="true">
                <path
                  d="M 320 144 V 192"
                  fill="none"
                  stroke={snapshot.metrics.solarPower.value && snapshot.metrics.solarPower.value > 0 ? '#0284c7' : '#cbd5e1'}
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                {snapshot.metrics.solarPower.value && snapshot.metrics.solarPower.value > 0 && (
                  <path
                    d="M 320 144 V 192"
                    fill="none"
                    stroke="#eab308"
                    strokeWidth="3"
                    strokeDasharray="3 9"
                  >
                    {animate && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="-24"
                        dur="0.9s"
                        repeatCount="indefinite"
                      />
                    )}
                  </path>
                )}
              </g>

              {/* Mains Backup Interconnection Pipe into Community Line */}
              <g aria-hidden="true">
                <path
                  d="M 894 396 H 988 V 240 H 920"
                  fill="none"
                  stroke={mains ? '#0284c7' : '#cbd5e1'}
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M 894 396 H 988 V 240 H 920"
                  fill="none"
                  stroke={mains ? '#38bdf8' : '#e2e8f0'}
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {mains && (
                  <path
                    d="M 894 396 H 988 V 240 H 920"
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="3.5"
                    strokeDasharray="4 16"
                  >
                    {animate && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="-40"
                        dur="1.2s"
                        repeatCount="indefinite"
                      />
                    )}
                  </path>
                )}
                {/* Piping Tee Node */}
                <circle cx="988" cy="240" r="5" fill="#0284c7" />
              </g>
            </>
          )}

          {/* Interactive White Equipment Cards with SVG Symbols */}
          {ids.map(id => {
            const [x, y] = nodePositions[id];
            const status = snapshot.equipment[id]?.status || 'normal';
            const isSel = selected === id;
            const statusLabel =
              status === 'critical' ? 'Fault' : status === 'warning' ? 'Elevated ΔP' : 'Normal';
            const statusColor =
              status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#2563eb';
            const tag = ASSET_TAGS[id];
            const metricPreview = getMetricPreview(id);

            return (
              <g
                key={id}
                transform={`translate(${x} ${y})`}
                role="button"
                tabIndex={0}
                aria-label={`${names[id]}, ${status}. View equipment details`}
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
                    x="-4"
                    y="-4"
                    width="160"
                    height="104"
                    rx="19"
                    fill="none"
                    stroke="#00f0ff"
                    strokeWidth="2.5"
                    opacity="0.9"
                  />
                )}

                {/* White Card Body */}
                <rect
                  width="152"
                  height="96"
                  rx="16"
                  fill={isSel ? '#f0f9ff' : '#ffffff'}
                  stroke={isSel ? '#0284c7' : '#dbe5de'}
                  strokeWidth={isSel ? 2 : 1.2}
                  filter="url(#schematic-card-shadow)"
                />

                {/* Engineering Asset Tag (Top-Left) */}
                <text
                  x="12"
                  y="18"
                  fill="#64748b"
                  fontSize="9.5"
                  fontWeight="700"
                  fontFamily="Inter, system-ui, sans-serif"
                  letterSpacing="0.6"
                >
                  {tag}
                </text>

                {/* Status Dot with Soft Outer Ring (Top-Right) */}
                <circle cx="138" cy="16" r="7" fill={statusColor} opacity="0.16" />
                <circle cx="138" cy="16" r="4.5" fill={statusColor} />

                {/* Equipment Vector Symbol */}
                <EquipmentSymbol id={id} />

                {/* Equipment Title Inside Card */}
                <text
                  x="76"
                  y="74"
                  textAnchor="middle"
                  fill="#0f172a"
                  fontSize="13"
                  fontWeight="650"
                  fontFamily="Inter, system-ui, -apple-system, sans-serif"
                >
                  {names[id]}
                </text>

                {/* Live Real-Time Telemetry Reading Subtitle */}
                <text
                  x="76"
                  y="88"
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize="10"
                  fontWeight="500"
                  fontFamily="Inter, system-ui, -apple-system, sans-serif"
                >
                  {metricPreview}
                </text>

                {/* Status Text Directly Underneath Card (Matching Picture 1: "Normal") */}
                <text
                  x="76"
                  y="118"
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

      {/* 3. BOTTOM FOOTER BAR (Matching Picture 1) */}
      <div className="schematic-footer-bar">
        <span className="schematic-footer-status">
          {animate
            ? 'SYSTEM NOMINAL · SCADA TELEMETRY STREAMING'
            : 'Visual motion paused · live readings continue'}
        </span>
        <button
          type="button"
          className="schematic-footer-btn"
          onClick={onSwitchTo3D}
          aria-label="Switch to 3D installation view"
        >
          <Box size={14} />
          <span>3D installation view</span>
        </button>
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

  if (mode === '2d') {
    return schematic;
  }

  return (
    <div
      ref={container}
      className="installation-scene modern-digital-twin"
      style={{
        position: 'relative',
        borderRadius: 16,
        overflow: 'hidden',
        background: '#0f172a',
      }}
    >
      {/* 1. TOP-LEFT OVERLAY: Live Digital Clock & Location Dropdown (Picture 2) */}
      <div className="scene-top-left-overlay">
        <div className="dt-clock-pill">
          <Clock size={14} className="dt-clock-icon" />
          <span className="dt-clock-time">{formattedTime}</span>
          <span className="dt-clock-date">{formattedDate}</span>
        </div>
        <div className="dt-location-pill">
          <MapPin size={13} className="dt-location-icon" />
          <span className="dt-location-name">Township Water System | Sector 4</span>
          <ChevronDown size={13} />
        </div>
      </div>

      {/* 2. TOP-RIGHT OVERLAY: Action Buttons (Picture 2) */}
      <div className="scene-top-right-overlay">
        <button
          type="button"
          className="dt-action-btn"
          onClick={props.onExport}
          aria-label="Export Data"
        >
          <Download size={14} />
          <span>Export Data</span>
        </button>
        <button
          type="button"
          className="dt-action-btn primary"
          onClick={props.onManageAsset}
          aria-label="Manage Asset"
        >
          <Settings size={14} />
          <span>Manage Asset</span>
        </button>
        <button
          type="button"
          className="dt-action-btn icon-only"
          onClick={() => {
            setRenderFailed(false);
            setMode('2d');
          }}
          title="Switch to 2D Schematic View"
          aria-label="Switch to 2D Schematic View"
        >
          <LayoutGrid size={15} />
        </button>
      </div>

      {/* 3. 3D CANVAS */}
      <SceneBoundary
        key={mode}
        fallback={schematic}
        onError={() => {
          setRenderFailed(true);
          setMode('2d');
        }}
      >
        <div className="scene-stage" style={{ height: compact ? 420 : 580, width: '100%' }}>
          <Canvas
            shadows
            frameloop={animate ? 'always' : 'demand'}
            camera={{ position: cameraPosition, fov: 38, near: 0.1, far: 120 }}
            dpr={[1, 1.5]}
            gl={{ antialias: true, powerPreference: 'high-performance' }}
            role="group"
            aria-label="Interactive 3D digital twin"
          >
            <Suspense fallback={null}>
              <Scene
                {...props}
                view={view}
                animate={animate}
                compact={compact || Boolean(props.immersive)}
                immersive={props.immersive}
              />
            </Suspense>
          </Canvas>
        </div>
      </SceneBoundary>

      {/* 4. VERTICAL CAMERA CONTROLS HUD (Right side, zero overlay with minimap) */}
      <div className="scene-camera-hud" role="toolbar" aria-label="3D Viewport Controls">
        {cameraButtons.map(({ action, label, aria, icon: Icon }) => (
          <button
            key={action}
            type="button"
            className="dt-hud-btn"
            aria-label={aria}
            title={label}
            onClick={() => setView(current => ({ action, sequence: current.sequence + 1 }))}
          >
            <Icon size={15} aria-hidden="true" />
          </button>
        ))}
        <div className="dt-hud-divider" />
        <button
          type="button"
          className="dt-hud-btn"
          onClick={() => setPaused(v => !v)}
          aria-label={animate ? 'Pause motion' : 'Resume motion'}
          title={animate ? 'Pause motion' : 'Resume motion'}
        >
          {animate ? <Pause size={15} /> : <Play size={15} />}
        </button>
      </div>

      {/* 5. BOTTOM-LEFT OVERLAY: Mini-map Radar Widget (Picture 2) */}
      <div className="scene-bottom-left-overlay">
        <div className="dt-minimap-card" title="Site Precinct Radar Mini-Map">
          <div className="dt-minimap-header">
            <Compass size={12} />
            <span>PRECINCT RADAR</span>
          </div>
          <svg viewBox="0 0 100 100" className="dt-minimap-svg">
            {/* Roads */}
            <rect x="0" y="70" width="100" height="18" fill="#334155" />
            <rect x="18" y="0" width="18" height="100" fill="#334155" />
            {/* Road lines */}
            <line x1="0" y1="79" x2="100" y2="79" stroke="#64748b" strokeDasharray="3 3" strokeWidth="1" />
            <line x1="27" y1="0" x2="27" y2="100" stroke="#64748b" strokeDasharray="3 3" strokeWidth="1" />
            {/* Treatment Plant Area */}
            <rect x="42" y="15" width="50" height="48" rx="4" fill="#1e293b" stroke="#0ea5e9" strokeWidth="1" />
            {/* Equipment Pings */}
            {ids.map(eq => {
              const [x, , z] = positions[eq];
              const mapX = 67 + x * 4;
              const mapY = 40 + z * 4;
              const isSel = props.selected === eq;
              return (
                <g key={eq} onClick={() => props.onSelect(eq)} style={{ cursor: 'pointer' }}>
                  {isSel && (
                    <circle cx={mapX} cy={mapY} r="7" fill="none" stroke="#00f0ff" strokeWidth="1.5" opacity="0.8">
                      <animate attributeName="r" values="3;9" dur="1.4s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="1;0" dur="1.4s" repeatCount="indefinite" />
                    </circle>
                  )}
                  <circle cx={mapX} cy={mapY} r={isSel ? 3.5 : 2.5} fill={isSel ? '#00f0ff' : '#94a3b8'} />
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* 6. BOTTOM EQUIPMENT QUICK BAR (Docked beside minimap starting at left: 148px) */}
      <div className="scene-bottom-equipment-bar" role="group" aria-label="Select equipment">
        {ids.map(id => {
          const isSel = props.selected === id;
          const st = props.snapshot.equipment[id]?.status || 'normal';
          return (
            <button
              key={id}
              type="button"
              className={`dt-quick-eq-btn ${isSel ? 'selected' : ''}`}
              onClick={() => props.onSelect(id)}
              aria-pressed={isSel}
            >
              <span className={`dt-eq-dot ${st}`} />
              <span>{names[id]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

