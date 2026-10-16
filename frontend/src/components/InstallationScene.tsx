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
const cameraPosition: [number, number, number] = [13, 12, 17];
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

function Pipe({ points, active, animate, color = '#4260c8', speed = 0.045 }: { points: [number, number, number][]; active: boolean; animate: boolean; color?: string; speed?: number }) {
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
  return <group>
    <mesh geometry={geometry} castShadow><meshStandardMaterial color={active ? color : '#b7bbc8'} roughness={0.35} metalness={0.25} /></mesh>
    {active && Array.from({ length: 7 }, (_, i) => <mesh key={i} ref={node => { markers.current[i] = node; }} position={curve.getPointAt(i / 7)}>
      <sphereGeometry args={[0.105, 10, 8]} /><meshBasicMaterial color={color === '#4260c8' ? '#d5dfff' : '#ffeb9f'} />
    </mesh>)}
  </group>;
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
  const halo=useRef<THREE.Mesh>(null);const haloMaterial=useRef<THREE.MeshBasicMaterial>(null);
  const radius = id === 'tank' ? 1.42 : id === 'solar' ? 1.85 : id === 'homes' ? 2 : 1.2;
  const hasFault=status==='warning'||status==='critical';
  const attention=status==='warning'||status==='critical'||status==='offline';
  const ringColor=attention?tones[status]:'#2b3e8d';
  useFrame(({clock})=>{
    if(!halo.current||!haloMaterial.current)return;
    if(hasFault&&animate){const pulse=(Math.sin(clock.elapsedTime*3.2)+1)/2;haloMaterial.current.opacity=.42+pulse*.42;halo.current.scale.setScalar(1+pulse*.035);}
    else{haloMaterial.current.opacity=.82;halo.current.scale.setScalar(1);}
  });
  const compactIndex=compact&&!selected&&!hovered&&!attention;
  const labelBackground=status==='critical'?'#ffe5e1':status==='warning'?'#fff2d7':status==='offline'?'#e9ebf2':selected?'#ebeefe':'rgba(255,255,255,.97)';
  const labelColor=status==='critical'?'#852b24':status==='warning'?'#71500d':status==='offline'?'#43495d':'#1b2450';
  return <group position={positions[id]} onClick={e => { e.stopPropagation(); onSelect(id); }}
    onPointerOver={e => { e.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
    {(selected || hovered || attention) && <mesh ref={halo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
      <ringGeometry args={[radius, radius + (hasFault ? 0.11 : 0.07), 64]} /><meshBasicMaterial ref={haloMaterial} color={ringColor} transparent opacity={0.85} side={THREE.DoubleSide} />
    </mesh>}
    {children}
    <Html position={[0, labelHeights[id], 0]} center zIndexRange={[10, 0]}>
      <button className="scene-label" type="button" onClick={e => { e.stopPropagation(); onSelect(id); }} aria-label={`${names[id]}, ${status}. View equipment details`} aria-pressed={selected} title={`${names[id]} · ${status}`}
        style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', background: labelBackground, border: `1px solid ${attention?tones[status]:selected?'#2b3e8d':'#d4d7e3'}`, color: labelColor, borderRadius: compactIndex ? 20 : 9, padding: compactIndex ? '6px' : '7px 10px', minWidth: 32, minHeight: 32, justifyContent: 'center', fontFamily: 'inherit', fontSize: 12, fontWeight: 650, boxShadow: attention?`0 0 0 3px ${status==='critical'?'rgba(227,95,80,.2)':status==='warning'?'rgba(216,149,25,.2)':'rgba(135,146,155,.17)'},0 3px 12px #202a3414`:'0 3px 12px #202a3414', cursor: 'pointer' }}>
        {compactIndex ? ids.indexOf(id) + 1 : <><span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: tones[status] }} />{names[id]}{(attention||selected)&&<span style={{ color: textTones[status], fontWeight: 700, textTransform: 'capitalize' }}>· {status}</span>}</>}
      </button>
    </Html>
  </group>;
}

function Pad({ width = 1.65, depth = 1.3 }: { width?: number; depth?: number }) {
  return <RoundedBox args={[width, 0.16, depth]} radius={0.06} smoothness={2} position={[0, 0.08, 0]} receiveShadow castShadow>
    <meshStandardMaterial color="#f9faff" roughness={0.75} />
  </RoundedBox>;
}

// 1. Realistic Rainwater Storage Tank (Corrugated Industrial Tank with Sight Glass)
function Tank({ level, quality, animate }: { level: number | null; quality: string; animate: boolean }) {
  const surface = useRef<THREE.Mesh>(null);
  const fraction = level === null ? 0.5 : THREE.MathUtils.clamp(level / 100, 0.02, 0.98);
  const fillHeight = 2.35 * fraction;
  useFrame(({ clock }) => { if (surface.current) surface.current.position.y = 0.3 + fillHeight + (animate ? Math.sin(clock.elapsedTime * 1.2) * 0.015 : 0); });
  return <group>
    <Pad width={2.7} depth={2.7} />
    <mesh position={[0, 1.5, 0]} castShadow><cylinderGeometry args={[1.06, 1.12, 2.55, 48, 1, true]} /><meshPhysicalMaterial color="#cbcfde" roughness={0.12} metalness={0.08} transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} /></mesh>
    <mesh position={[0, 0.3 + fillHeight / 2, 0]}><cylinderGeometry args={[1.035, 1.085, fillHeight, 48]} /><meshStandardMaterial color={quality === 'valid' ? '#5571ce' : '#a6adc6'} transparent opacity={0.68} roughness={0.25} /></mesh>
    <mesh ref={surface} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3 + fillHeight, 0]}><circleGeometry args={[1.035, 48]} /><meshStandardMaterial color="#abb9e7" transparent opacity={0.6} roughness={0.2} side={THREE.DoubleSide} /></mesh>
    {[0.28, 2.76].map(y => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow><torusGeometry args={[1.09, 0.055, 12, 48]} /><meshStandardMaterial color="#e5e7ee" metalness={0.2} roughness={0.3} /></mesh>)}
    <mesh position={[0, 0.28, 0]} castShadow><cylinderGeometry args={[1.13, 1.13, 0.15, 48]} /><meshStandardMaterial color="#dbdee7" roughness={0.5} /></mesh>
    <mesh position={[0, 2.86, 0]} castShadow><cylinderGeometry args={[1.12, 1.12, 0.12, 48]} /><meshStandardMaterial color="#f4f6fb" roughness={0.5} /></mesh>
    <mesh position={[0.3, 2.96, 0]}><cylinderGeometry args={[0.25, 0.25, 0.07, 24]} /><meshStandardMaterial color="#8289a0" /></mesh>
    <mesh position={[0.05, 1.35, 1.065]}><boxGeometry args={[0.75, 0.42, 0.055]} /><meshStandardMaterial color="#ffffff" /></mesh>
    <Html position={[0.05, 1.36, 1.11]} transform distanceFactor={7} rotation={[0, 0, 0]} zIndexRange={[2, 0]} style={{ pointerEvents: 'none' }}><div aria-hidden="true" style={{ color: '#324eac', fontSize: 18, fontWeight: 800, letterSpacing: -1 }}>maxis</div></Html>
    <mesh position={[0.78, 1.5, 0.83]}><boxGeometry args={[0.1, 2.2, 0.055]} /><meshStandardMaterial color="#f8faff" /></mesh>
    <mesh position={[0.78, 0.4 + fraction * 1.1, 0.87]}><boxGeometry args={[0.055, fraction * 2.2, 0.02]} /><meshBasicMaterial color={quality === 'valid' ? '#304aa5' : '#878c9b'} /></mesh>
  </group>;
}

// 2. Realistic Booster Pump Skid (Blue Motor, Cooling Fins & Impeller Chamber)
function Pump({ running, animate }: { running: boolean; animate: boolean }) {
  const fan = useRef<THREE.Group>(null);
  useFrame((_, delta) => { if (fan.current && running && animate) fan.current.rotation.z += delta * 2.5; });
  return <group>
    <Pad />
    <RoundedBox args={[1.05, 0.14, 0.85]} radius={0.04} position={[0, 0.3, 0]} castShadow><meshStandardMaterial color="#586181" /></RoundedBox>
    <mesh position={[0, 0.67, -0.1]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.34, 0.34, 0.78, 32]} /><meshStandardMaterial color="#4760b5" roughness={0.5} metalness={0.15} /></mesh>
    {[-0.34, -0.24, -0.14, -0.04, 0.06].map(z => <mesh key={z} position={[0, 0.67, z]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.34, 0.02, 6, 28]} /><meshStandardMaterial color="#2e4491" /></mesh>)}
    <mesh position={[0, 0.66, 0.45]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.4, 0.4, 0.32, 32]} /><meshStandardMaterial color="#dbdee7" metalness={0.5} roughness={0.25} /></mesh>
    <group ref={fan} position={[0, 0.66, 0.62]}>{[0, 1, 2, 3].map(i => <mesh key={i} rotation={[0, 0, i * Math.PI / 2]} position={[0, 0, 0.01]}><boxGeometry args={[0.48, 0.045, 0.04]} /><meshStandardMaterial color="#526194" /></mesh>)}</group>
    <mesh position={[0.42, 0.59, 0.4]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.13, 0.13, 0.4, 16]} /><meshStandardMaterial color="#848daa" /></mesh>
  </group>;
}

function Membrane({ status }: { status: EquipmentStatus }) {
  const fault=status==='warning'||status==='critical';
  const bodyColor=status==='critical'?'#f0b9b4':status==='warning'?'#f3dfb9':'#e5e7ee';
  const glowColor=status==='critical'?'#e35f50':status==='warning'?'#d89519':'#000000';
  return <group>
    <Pad width={2.05} depth={1.6} />
    {[-0.86, 0.86].map(x => <mesh key={x} position={[x, 1.08, -0.35]} castShadow><boxGeometry args={[0.07, 1.8, 0.08]} /><meshStandardMaterial color="#878da1" metalness={0.5} /></mesh>)}
    {[0.4, 1.93].map(y => <mesh key={y} position={[0, y, -0.35]} castShadow><boxGeometry args={[1.78, 0.08, 0.09]} /><meshStandardMaterial color="#878da1" metalness={0.5} /></mesh>)}
    {[-0.56, 0, 0.56].map((x, i) => <group key={x} position={[x, 0, 0]}>
      <mesh position={[0, 1.08, 0]} castShadow><cylinderGeometry args={[0.205, 0.205, 1.45, 24]} /><meshStandardMaterial color={bodyColor} emissive={fault ? glowColor : '#000000'} emissiveIntensity={fault ? 0.12 : 0} roughness={0.4} metalness={0.08} /></mesh>
      {[0.41, 1.76].map(y => <mesh key={y} position={[0, y, 0]} castShadow><cylinderGeometry args={[0.235, 0.235, 0.17, 24]} /><meshStandardMaterial color={status === 'critical' || status === 'warning' ? tones[status] : '#737b95'} roughness={0.4} /></mesh>)}
      <mesh position={[0, 1.12, 0.211]}><boxGeometry args={[0.15, 0.4, 0.02]} /><meshStandardMaterial color={i % 2 ? '#abb8e6' : '#bec8e8'} /></mesh>
      <mesh position={[0, 1.98, 0]}><cylinderGeometry args={[0.065, 0.065, 0.23, 12]} /><meshStandardMaterial color="#a7acbe" metalness={0.45} /></mesh>
    </group>)}
    <mesh position={[0, 2.1, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.065, 0.065, 1.4, 12]} /><meshStandardMaterial color="#a7acbe" metalness={0.45} /></mesh>
  </group>;
}

function UV({ running }: { running: boolean }) {
  return <group>
    <Pad width={1.95} depth={1.2} />
    {[-0.55, 0.55].map(x => <mesh key={x} position={[x, 0.45, 0]} castShadow><boxGeometry args={[0.12, 0.5, 0.55]} /><meshStandardMaterial color="#bcc0cf" metalness={0.5} /></mesh>)}
    <mesh position={[0, 0.85, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.24, 0.24, 1.55, 32]} /><meshPhysicalMaterial color="#edeff4" transparent opacity={0.6} metalness={0.5} roughness={0.15} depthWrite={false} /></mesh>
    <mesh position={[0, 0.85, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.085, 0.085, 1.45, 24]} /><meshStandardMaterial color={running ? '#a1b5f8' : '#9195a1'} emissive={running ? '#7e93da' : '#000000'} emissiveIntensity={0.6} /></mesh>
    {[-0.8, 0.8].map(x => <mesh key={x} position={[x, 0.85, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.27, 0.27, 0.15, 24]} /><meshStandardMaterial color="#81889e" metalness={0.5} roughness={0.3} /></mesh>)}
    <RoundedBox args={[0.55, 0.45, 0.27]} radius={0.04} position={[0, 0.55, 0.48]} castShadow><meshStandardMaterial color="#f8f9fc" /></RoundedBox>
    <mesh position={[0, 0.6, 0.62]}><planeGeometry args={[0.3, 0.16]} /><meshBasicMaterial color={running ? '#bdc8ed' : '#b9bbc1'} /></mesh>
  </group>;
}

function Solar() {
  return <group>
    {[-1.3, 1.3].flatMap(x => [-0.65, 0.65].map(z => <mesh key={`${x}-${z}`} position={[x, 0.83, z]} castShadow><boxGeometry args={[0.055, 1.65, 0.06]} /><meshStandardMaterial color="#9a9faf" metalness={0.5} /></mesh>))}
    <group position={[0, 1.7, 0]} rotation={[-0.23, 0, 0]}>
      <RoundedBox args={[3.35, 0.08, 2.1]} radius={0.02} castShadow><meshStandardMaterial color="#f2f3f6" metalness={0.3} /></RoundedBox>
      {[-1.08, 0, 1.08].flatMap(x => [-0.5, 0.5].map(z => <group key={`${x}-${z}`} position={[x, 0.06, z]}>
        <mesh castShadow><boxGeometry args={[1.01, 0.055, 0.94]} /><meshStandardMaterial color="#213166" metalness={0.22} roughness={0.25} /></mesh>
        {[-0.31, 0, 0.31].map(cx => <mesh key={cx} position={[cx, 0.03, 0]}><boxGeometry args={[0.009, 0.01, 0.88]} /><meshBasicMaterial color="#546396" /></mesh>)}
        {[-0.3, 0, 0.3].map(cz => <mesh key={cz} position={[0, 0.03, cz]}><boxGeometry args={[0.95, 0.01, 0.009]} /><meshBasicMaterial color="#546396" /></mesh>)}
      </group>))}
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
  return <group>
    <Pad width={1.85} depth={1.35} />
    <mesh position={[0, 0.55, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.18, 0.18, 1.6, 24]} /><meshStandardMaterial color="#7884ae" metalness={0.5} roughness={0.3} /></mesh>
    <mesh position={[0, 0.75, 0]} castShadow><boxGeometry args={[0.45, 0.45, 0.4]} /><meshStandardMaterial color="#5467a9" metalness={0.3} /></mesh>
    <mesh position={[0, 1.08, 0]}><cylinderGeometry args={[0.05, 0.05, 0.4, 12]} /><meshStandardMaterial color="#787f96" metalness={0.6} /></mesh>
    <mesh position={[0, 1.28, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow><torusGeometry args={[0.32, 0.045, 10, 28]} /><meshStandardMaterial color="#5c6995" metalness={0.3} /></mesh>
    {[0, Math.PI / 3, 2 * Math.PI / 3].map(r => <mesh key={r} position={[0, 1.28, 0]} rotation={[0, r, 0]}><boxGeometry args={[0.6, 0.04, 0.035]} /><meshStandardMaterial color="#5c6995" /></mesh>)}
    <mesh position={[-0.58, 0.47, 0]}><boxGeometry args={[0.08, 0.6, 0.4]} /><meshStandardMaterial color="#c0c4d0" /></mesh>
    <mesh position={[0.58, 0.47, 0]}><boxGeometry args={[0.08, 0.6, 0.4]} /><meshStandardMaterial color="#c0c4d0" /></mesh>
  </group>;
}

function House({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const roof = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.58, 0, -0.6, 0.58, 0, -0.6, 0, 0.42, -0.6,
      -0.58, 0, 0.6, 0.58, 0, 0.6, 0, 0.42, 0.6,
    ], 3));
    geometry.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3]);
    geometry.computeVertexNormals();
    return geometry;
  }, []);
  useEffect(() => () => roof.dispose(), [roof]);
  return <group position={position} rotation={[0, rotation, 0]}>
    <RoundedBox args={[1, 0.82, 1.05]} radius={0.025} position={[0, 0.51, 0]} castShadow><meshStandardMaterial color="#f4f5f7" roughness={0.8} /></RoundedBox>
    <mesh geometry={roof} position={[0, 0.94, 0]} castShadow><meshStandardMaterial color="#737b95" roughness={0.7} /></mesh>
    <mesh position={[0.13, 0.37, 0.532]}><boxGeometry args={[0.23, 0.56, 0.025]} /><meshStandardMaterial color="#8990a8" /></mesh>
    <mesh position={[-0.25, 0.62, 0.533]}><boxGeometry args={[0.22, 0.24, 0.027]} /><meshStandardMaterial color="#96a6dc" roughness={0.2} /></mesh>
    <mesh position={[0.51, 0.61, 0]}><boxGeometry args={[0.025, 0.24, 0.28]} /><meshStandardMaterial color="#96a6dc" roughness={0.2} /></mesh>
    <mesh position={[0.13, 0.09, 0.73]}><boxGeometry args={[0.4, 0.06, 0.36]} /><meshStandardMaterial color="#d2d5df" /></mesh>
  </group>;
}

function Tree({ position, size = 1 }: { position: [number, number, number]; size?: number }) {
  return <group position={position} scale={size}>
    <mesh position={[0, 0.35, 0]} castShadow><cylinderGeometry args={[0.035, 0.05, 0.7, 8]} /><meshStandardMaterial color="#636d8e" /></mesh>
    <mesh position={[0, 0.87, 0]} castShadow><sphereGeometry args={[0.34, 10, 8]} /><meshStandardMaterial color="#9297aa" flatShading roughness={0.9} /></mesh>
    <mesh position={[0.08, 1.09, 0]} castShadow><sphereGeometry args={[0.26, 10, 8]} /><meshStandardMaterial color="#aeb3c2" flatShading roughness={0.9} /></mesh>
  </group>;
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
  const rainPath = useMemo<[number, number, number][]>(() => [[-5.8, 0.47, 0.5], [-5.8, 0.47, 2.25], [-3.4, 0.47, 2.25], [-3.4, 0.47, 1.1]], []);
  const filterPath = useMemo<[number, number, number][]>(() => [[-3.4, 0.47, 1.1], [-3.4, 0.47, 2.25], [-0.9, 0.47, 2.25], [-0.9, 0.47, 0.7]], []);
  const uvPath = useMemo<[number, number, number][]>(() => [[-0.9, 0.47, 0.7], [-0.9, 0.47, 2.25], [1.8, 0.47, 2.25], [1.8, 0.47, 0.8]], []);
  const homesPath = useMemo<[number, number, number][]>(() => [[1.8, 0.47, 0.8], [1.8, 0.47, 2.25], [3.6, 0.47, 2.25], [3.6, 0.47, 1.5], [5.4, 0.47, 1.5]], []);
  const mainsPath = useMemo<[number, number, number][]>(() => [[4.4, 0.47, -2.5], [6.8, 0.47, -2.5], [6.8, 0.47, -0.65], [3.6, 0.47, -0.65], [3.6, 0.47, 1.5], [5.4, 0.47, 1.5]], []);
  const powerPath = useMemo<[number, number, number][]>(() => [[-2.9, 0.18, -3.1], [-2.9, 0.18, -1.4], [-3.4, 0.18, -1.4], [-3.4, 0.18, 1.1]], []);
  return <>
    <color attach="background" args={[immersive ? '#141720' : '#e9ebf2']} />
    {immersive&&<fog attach="fog" args={['#141720',24,62]} />}
    <ambientLight intensity={immersive?0.72:1.1} />
    <hemisphereLight args={immersive?['#d3d9ec','#1b2450',1.05]:['#ffffff','#b7bccb',1.3]} />
    <directionalLight position={[-5, 12, 8]} intensity={immersive?1.65:2.1} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-11} shadow-camera-right={11} shadow-camera-top={9} shadow-camera-bottom={-9} shadow-normalBias={0.05} />
    {immersive&&<mesh rotation={[-Math.PI/2,0,0]} position={[0,-0.58,0]} receiveShadow><planeGeometry args={[160,160]}/><meshStandardMaterial color="#141720" roughness={1}/></mesh>}
    <RoundedBox args={[17.2, 0.4, 9.8]} radius={0.2} position={[0, -0.26, -0.35]} receiveShadow><meshStandardMaterial color={immersive?'#303443':'#dcdfe8'} roughness={0.9} /></RoundedBox>
    <RoundedBox args={[16.6, 0.055, 9.2]} radius={0.16} position={[0, -0.038, -0.35]} receiveShadow><meshStandardMaterial color={immersive?'#414658':'#edeef3'} roughness={0.95} /></RoundedBox>
    <mesh position={[-1.65, 0.007, 0.65]} receiveShadow><boxGeometry args={[10.9, 0.035, 3.3]} /><meshStandardMaterial color={immersive?'#393e50':'#dfe1e9'} /></mesh>
    <RoundedBox args={[4.7, 0.04, 4.65]} radius={0.3} position={[5.3, 0.01, 1.47]} receiveShadow><meshStandardMaterial color={immersive?'#484e64':'#e1e3eb'} roughness={1} /></RoundedBox>
    <mesh position={[5.3, 0.045, 1.52]} receiveShadow><boxGeometry args={[0.5, 0.03, 4.1]} /><meshStandardMaterial color={immersive?'#757882':'#e3e5ed'} /></mesh>
    <mesh position={[5.3, 0.047, 1.52]} receiveShadow><boxGeometry args={[4, 0.03, 0.35]} /><meshStandardMaterial color={immersive?'#757882':'#e3e5ed'} /></mesh>
    <Pipe points={rainPath} active={rain} animate={animate} /><Pipe points={filterPath} active={rain} animate={animate} /><Pipe points={uvPath} active={rain} animate={animate} /><Pipe points={homesPath} active={rain} animate={animate} />
    <Pipe points={mainsPath} active={mains} animate={animate} /><Pipe points={powerPath} active={snapshot.connected && (snapshot.metrics.solarPower.value ?? 0) > 0} animate={animate} color="#d9b259" speed={0.025} />
    {ids.map(id => <Equipment key={id} id={id} status={snapshot.equipment[id].status} selected={selected === id} onSelect={onSelect} compact={compact} animate={animate}>
      {id === 'tank' && <Tank level={snapshot.metrics.tankLevel.value} quality={snapshot.metrics.tankLevel.quality} animate={animate} />}
      {id === 'pump' && <Pump running={rain} animate={animate} />}
        {id === 'membrane' && <Membrane status={snapshot.equipment.membrane.status} />}
      {id === 'uv' && <UV running={rain} />}
      {id === 'solar' && <Solar />}
      {id === 'mains' && <Mains />}
      {id === 'homes' && [-1.23, 0.13, 1.48].flatMap((z, i) => [-1.05, 1.03].map((x, j) => <group key={`${x}-${z}`} position={[x, 0, z]} scale={0.8}><House position={[0, 0, 0]} rotation={(i + j) % 2 ? -0.08 : 0.06} /></group>))}
    </Equipment>)}
    {[[-7.4, 0, -3.7], [-6.5, 0, -3.85], [7.6, 0, 3.1], [3.5, 0, 3.4], [7.4, 0, -3.5]].map((p, i) => <Tree key={i} position={p as [number, number, number]} size={i % 2 ? 0.85 : 1.05} />)}
    <ContactShadows position={[0, -0.49, 0]} opacity={0.22} scale={24} blur={2.2} far={6} resolution={512} color="#686f87" frames={1} />
    <OrbitControls ref={controls} makeDefault target={[0, 0.7, -0.2]} minDistance={12} maxDistance={32} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2.25} enablePan={false} enableDamping={animate} dampingFactor={0.12} />
  </>;
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
  function route(d: string, active: boolean, color = '#4260c8') { return <g aria-hidden="true"><path d={d} fill="none" stroke={active ? color : '#c5c8d2'} strokeWidth="6" strokeLinecap="round" />{active && <path d={d} fill="none" stroke="#eff3ff" strokeWidth="3" strokeDasharray="3 14">{animate && <animate attributeName="stroke-dashoffset" from="0" to="-34" dur="1s" repeatCount="indefinite" />}</path>}</g>; }
  const tankLevel = snapshot.metrics.tankLevel.value;
  return <div className="scene-schematic" style={{ padding: '18px 10px', minHeight: compact ? 480 : 370, display: 'grid', alignItems: 'center', background:immersive?'#171b29':undefined }}>
    <svg viewBox={compact ? '0 0 390 610' : '0 0 880 400'} style={{ width: '100%', maxWidth: compact ? 440 : undefined, margin: '0 auto', maxHeight: compact ? undefined : 435 }} role="group" aria-label="Interactive two dimensional installation schematic">
      <title>MAXIS installation schematic</title>
      <desc>Rainwater flows through the pump, membrane and ultraviolet treatment to the community. Mains is the backup route. Select equipment or use the equipment buttons below.</desc>
      <rect x="10" y="8" width={compact ? 370 : 860} height={compact ? 595 : 382} rx="20" fill={immersive?'#262b3a':'#edeef3'} />
      {route(compact ? 'M 90 208 H 300 V 368 H 90 V 528' : 'M 100 188 H 780', rain)}
      {route(compact ? 'M 300 528 H 90' : 'M 690 328 H 855 V 188 H 780', mains)}
      {route(compact ? 'M 90 63 H 180 V 120 H 300 V 208' : 'M 270 63 V 188', snapshot.connected && (snapshot.metrics.solarPower.value ?? 0) > 0, '#d9b259')}
      {ids.map(id => {
        const [x, y] = nodes[id]; const status = snapshot.equipment[id].status;const fault=status==='warning'||status==='critical';
        return <g key={id} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={`${names[id]}, ${status}. View equipment details`} aria-pressed={selected === id} onClick={() => onSelect(id)} onFocus={() => setFocused(id)} onBlur={() => setFocused(null)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); } }} style={{ cursor: 'pointer' }}>
          {focused === id && <rect x="-4" y="-4" width="138" height="84" rx="16" fill="none" stroke="#203270" strokeWidth="3" />}
          {fault&&<rect x="-4" y="-4" width="138" height="84" rx="16" fill="none" stroke={tones[status]} strokeWidth="4" opacity=".8"/>}
          <rect width="130" height="76" rx="12" fill={status==='critical'?'#ffe5e1':status==='warning'?'#fff2d7':selected === id ? '#e5e9f8' : '#ffffff'} stroke={fault?tones[status]:selected === id ? '#2e479d' : '#cdd1de'} strokeWidth={fault?2.5:selected === id ? 2 : 1} />
          <circle cx="114" cy="14" r="4" fill={tones[status]} />
          <g transform="translate(10 0)" aria-hidden="true">{id === 'tank' ? <><rect x="43" y="12" width="25" height="34" rx="4" fill="#eef0f7" stroke="#a3acc9" /><rect x="44" y={45 - 31 * ((tankLevel ?? 50) / 100)} width="23" height={31 * ((tankLevel ?? 50) / 100)} rx="2" fill={snapshot.metrics.tankLevel.quality === 'valid' ? '#607ad1' : '#a3aac3'} /></> : id === 'solar' ? <><path d="M 35 38 L 43 15 H 73 L 81 38 Z" fill="#243365" /><path d="M 47 16 L 43 37 M 58 16 V 37 M 69 16 L 73 37 M 39 28 H 78" fill="none" stroke="#808cb4" strokeWidth="1" /></> : id === 'homes' ? <><path d="M 39 27 L 56 13 L 74 27 V 46 H 39 Z" fill="#c8cddf" /><path d="M 36 28 L 56 11 L 77 28" fill="none" stroke="#525d84" strokeWidth="3" /><rect x="52" y="31" width="9" height="15" rx="1" fill="#757e9d" /></> : id === 'membrane' ? <>{[39, 53, 67].map(x => <g key={x}><rect x={x} y="15" width="10" height="31" rx="3" fill="#e8eaf3" stroke="#5f6fa5" /><rect x={x} y="15" width="10" height="7" rx="2" fill={status === 'critical' || status === 'warning' ? tones[status] : '#5f6fa5'} /></g>)}</> : id === 'uv' ? <><rect x="33" y="22" width="47" height="18" rx="9" fill="#e8ecfb" stroke="#949fc4" /><path d="M 39 31 H 73" stroke={rain ? '#93a5e0' : '#aaacb4'} strokeWidth="4" /></> : id === 'pump' ? <><circle cx="55" cy="31" r="15" fill="#e8eaf3" stroke="#5f6fa5" strokeWidth="2" /><path d="M 43 31 H 67 M 55 19 V 43" stroke="#5f6fa5" strokeWidth="3" /></> : <><path d="M 35 35 H 78 M 56 35 V 19" stroke="#717b9b" strokeWidth="6" /><circle cx="56" cy="18" r="10" fill="none" stroke="#4e5f99" strokeWidth="3" /></>}</g>
          <text x="65" y="63" textAnchor="middle" fill="#333b56" fontFamily="inherit" fontSize={compact ? '15' : '14'} fontWeight="600">{names[id]}</text>
          <text x="65" y="99" textAnchor="middle" fill={textTones[status]} fontFamily="inherit" fontSize={compact ? '15' : '14'}>{status.charAt(0).toUpperCase() + status.slice(1)}</text>
        </g>;
      })}
    </svg>
  </div>;
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
  return <div ref={container} className="installation-scene" style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#f0f1f6', border: '1px solid #dbdee7' }}>
    <div className="scene-toolbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 18px', flexWrap: 'wrap', position: 'relative', zIndex: 11, borderBottom: '1px solid #dee1eb' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: '#474d61', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Droplets size={15} aria-hidden="true" color="#2f4aa4" />Water flow</span>
        <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Sun size={15} aria-hidden="true" color="#946c20" />Solar energy</span>
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
    </div>
    {renderFailed && <p role="status" style={{ margin: 0, padding: '12px 18px 0', color: '#525767', fontSize: 12 }}>The 3D view could not render. The schematic shows the same live equipment; you can retry 3D above.</p>}
    {!supported && <p style={{ margin: 0, padding: '12px 18px 0', color: '#525767', fontSize: 12 }}>This device uses the interactive schematic. Live readings and equipment details remain available.</p>}
    {mode === '3d' ? <SceneBoundary key={mode} fallback={schematic} onError={() => { setRenderFailed(true); setMode('2d'); }}>
      <div className="scene-stage" style={{ height: compact ? 400 : 470 }}>
        <Canvas shadows frameloop={animate ? 'always' : 'demand'} camera={{ position: cameraPosition, fov: 39, near: 0.1, far: 100 }} dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: 'high-performance' }} role="group" aria-label="Interactive 3D water treatment installation. Equipment and camera controls are available below">
          <Suspense fallback={null}><Scene {...props} view={view} animate={animate} compact={compact||Boolean(props.immersive)} immersive={props.immersive} /></Suspense>
        </Canvas>
      </div>
    </SceneBoundary> : schematic}
    {mode === '3d' && <div className="scene-view-controls" role="group" aria-label="Installation camera controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 18px 16px' }}>
      {cameraButtons.map(({ action, label, aria, icon: Icon }) => <button key={action} type="button" style={{ ...baseStyle, minHeight: 36, padding: '6px 10px' }} aria-label={aria} title={aria} onClick={() => setView(current => ({ action, sequence: current.sequence + 1 }))}><Icon size={15} aria-hidden="true" />{label}</button>)}
    </div>}
    <div className="scene-caption" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 18px 16px', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#525767', lineHeight: 1.5 }}>{!animate ? 'Visual motion paused · live readings continue' : mode === '3d' ? 'Rotate with the controls or drag · select equipment to inspect' : 'Select equipment to inspect live and historical readings'}</span>
      <span style={{ fontSize: 12, color: '#374060', background: '#e0e3ec', borderRadius: 20, padding: '5px 10px', fontWeight: 500 }}>3D installation view</span>
    </div>
    <div className="scene-equipment-list" role="group" aria-label="Select installation equipment" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, background: 'rgba(255,255,255,.75)', borderTop: '1px solid #dbdee7', padding: 16 }}>
      {ids.map((id, index) => <button className="scene-equipment-button" key={id} type="button" onClick={() => props.onSelect(id)} aria-pressed={props.selected === id} aria-label={`${names[id]}, ${props.snapshot.equipment[id].status}. View details`} style={{ ...baseStyle, justifyContent: 'flex-start', gap: 9, padding: '10px 12px', minHeight: 54, background: props.selected === id ? '#e7eaf6' : '#ffffff', border: `1px solid ${props.selected === id ? '#596aa4' : '#d9dbe4'}`, textAlign: 'left' }}>
        <span aria-hidden="true" style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: props.selected === id ? '#cdd4eb' : '#edeef3', color: '#424963', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600 }}>{index + 1}</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}><span style={{ fontWeight: 600, fontSize: 12 }}>{names[id]}</span><span style={{ color: listTones[props.snapshot.equipment[id].status], textTransform: 'capitalize', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: tones[props.snapshot.equipment[id].status] }} />{props.snapshot.equipment[id].status}</span></span>
      </button>)}
    </div>
  </div>;
}

