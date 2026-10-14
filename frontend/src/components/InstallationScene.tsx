import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls, RoundedBox } from '@react-three/drei';
import { Box, Droplets, LayoutGrid, MoveDown, MoveUp, Pause, Play, RotateCcw, RotateCw, Sun, ZoomIn, ZoomOut } from 'lucide-react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { EquipmentId, EquipmentStatus, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  immersive?: boolean;
}

const names: Record<EquipmentId, string> = {
  tank: 'Rainwater tank', pump: 'Pump', membrane: 'Membrane filter', uv: 'UV treatment',
  solar: 'Solar array', mains: 'Mains backup', homes: 'Community',
};
const tones: Record<EquipmentStatus, string> = {
  normal: '#2b3e8d', warning: '#d89519', critical: '#e35f50', offline: '#8086a2', stopped: '#5e6896',
};
const ids = Object.keys(names) as EquipmentId[];
const positions: Record<EquipmentId, [number, number, number]> = {
  tank: [-5.8, 0, 0.5], pump: [-3.4, 0, 1.1], membrane: [-0.9, 0, 0.7],
  uv: [1.8, 0, 0.8], solar: [-2.9, 0, -3.1], mains: [4.4, 0, -2.5], homes: [5.4, 0, 1.5],
};
const labelHeights: Record<EquipmentId, number> = {
  tank: 3.55, pump: 1.62, membrane: 2.58, uv: 1.82, solar: 2.88, mains: 1.95, homes: 2.34,
};
const cameraPosition: [number, number, number] = [13, 12, 17];
const baseStyle = { fontFamily: 'inherit', border: '1px solid #cdd1e2', borderRadius: 9, padding: '8px 12px', minHeight: 40, background: '#ffffff', color: '#34384c', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 };
const textTones: Record<EquipmentStatus, string> = { normal: '#223272', warning: '#875504', critical: '#a73327', offline: '#4c5372', stopped: '#474d6a' };
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
  } catch { return false; }
}

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Pipe({ points, active, animate, color = '#1fcf04', speed = 0.045 }: { points: [number, number, number][]; active: boolean; animate: boolean; color?: string; speed?: number }) {
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
  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 80, 0.075, 8, false), [curve]);
  const markers = useRef<(THREE.Mesh | null)[]>([]);
  const phase = useRef(0);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame((_, delta) => {
    if (!active || !animate) return;
    phase.current = (phase.current + delta * speed) % 1;
    markers.current.forEach((mesh, i) => mesh?.position.copy(curve.getPointAt((phase.current + i / 7) % 1)));
  });
  return <group>
    <mesh geometry={geometry} castShadow><meshStandardMaterial color={active ? color : '#b3b7cc'} roughness={0.35} metalness={0.25} /></mesh>
    {active && Array.from({ length: 7 }, (_, i) => <mesh key={i} ref={node => { markers.current[i] = node; }} position={curve.getPointAt(i / 7)}>
      <sphereGeometry args={[0.105, 10, 8]} /><meshBasicMaterial color={color === '#1fcf04' ? '#d6ddfe' : '#ffeb9f'} />
    </mesh>)}
  </group>;
}

function Equipment({ id, status, selected, onSelect, children, compact, animate }: {
  id: EquipmentId; status: EquipmentStatus; selected: boolean; onSelect: Props['onSelect']; children: ReactNode; compact: boolean; animate: boolean;
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
  const labelColor=status==='critical'?'#852b24':status==='warning'?'#71500d':status==='offline'?'#3d4463':'#1b2450';
  return <group position={positions[id]} onClick={e => { e.stopPropagation(); onSelect(id); }}
    onPointerOver={e => { e.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
    {(selected || hovered || attention) && <mesh ref={halo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
      <ringGeometry args={[radius, radius + (hasFault ? 0.11 : 0.07), 64]} /><meshBasicMaterial ref={haloMaterial} color={ringColor} transparent opacity={0.85} side={THREE.DoubleSide} />
    </mesh>}
    {children}
    <Html position={[0, labelHeights[id], 0]} center zIndexRange={[10, 0]}>
      <button className="scene-label" type="button" onClick={e => { e.stopPropagation(); onSelect(id); }} aria-label={`${names[id]}, ${status}. View equipment details`} aria-pressed={selected} title={`${names[id]} · ${status}`}
        style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', background: labelBackground, border: `1px solid ${attention?tones[status]:selected?'#2b3e8d':'#d4d7e3'}`, color: labelColor, borderRadius: compactIndex ? 20 : 9, padding: compactIndex ? '6px' : '7px 10px', minWidth: 32, minHeight: 32, justifyContent: 'center', fontFamily: 'inherit', fontSize: 12, fontWeight: 650, boxShadow: attention?`0 0 0 3px ${status==='critical'?'rgba(227,95,80,.2)':status==='warning'?'rgba(216,149,25,.2)':'rgba(128,134,162,.17)'},0 3px 12px #1b245014`:'0 3px 12px #1b245014', cursor: 'pointer' }}>
        {compactIndex ? ids.indexOf(id) + 1 : <><span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: tones[status] }} />{names[id]}{(attention||selected)&&<span style={{ color: textTones[status], fontWeight: 700, textTransform: 'capitalize' }}>· {status}</span>}</>}
      </button>
    </Html>
  </group>;
}

function Pad({ width = 1.65, depth = 1.3 }: { width?: number; depth?: number }) {
  return <RoundedBox args={[width, 0.16, depth]} radius={0.06} smoothness={2} position={[0, 0.08, 0]} receiveShadow castShadow>
    <meshStandardMaterial color="#fffef9" roughness={0.75} />
  </RoundedBox>;
}

function Tank({ level, quality, animate }: { level: number | null; quality: string; animate: boolean }) {
  const surface = useRef<THREE.Mesh>(null);
  const fraction = level === null ? 0.5 : THREE.MathUtils.clamp(level / 100, 0.02, 0.98);
  const fillHeight = 2.35 * fraction;
  useFrame(({ clock }) => { if (surface.current) surface.current.position.y = 0.3 + fillHeight + (animate ? Math.sin(clock.elapsedTime * 1.2) * 0.015 : 0); });
  return <group>
    <Pad width={2.7} depth={2.7} />
    <mesh position={[0, 1.5, 0]} castShadow><cylinderGeometry args={[1.06, 1.12, 2.55, 48, 1, true]} /><meshPhysicalMaterial color="#cbcfde" roughness={0.12} metalness={0.08} transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} /></mesh>
    <mesh position={[0, 0.3 + fillHeight / 2, 0]}><cylinderGeometry args={[1.035, 1.085, fillHeight, 48]} /><meshStandardMaterial color={quality === 'valid' ? '#2ecf17' : '#a7acc5'} transparent opacity={0.68} roughness={0.25} /></mesh>
    <mesh ref={surface} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3 + fillHeight, 0]}><circleGeometry args={[1.035, 48]} /><meshStandardMaterial color="#a3b1ef" transparent opacity={0.6} roughness={0.2} side={THREE.DoubleSide} /></mesh>
    {[0.28, 2.76].map(y => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow><torusGeometry args={[1.09, 0.055, 12, 48]} /><meshStandardMaterial color="#e5e7ee" metalness={0.2} roughness={0.3} /></mesh>)}
    <mesh position={[0, 0.28, 0]} castShadow><cylinderGeometry args={[1.13, 1.13, 0.15, 48]} /><meshStandardMaterial color="#dbdde7" roughness={0.5} /></mesh>
    <mesh position={[0, 2.86, 0]} castShadow><cylinderGeometry args={[1.12, 1.12, 0.12, 48]} /><meshStandardMaterial color="#f5fbf4" roughness={0.5} /></mesh>
    <mesh position={[0.3, 2.96, 0]}><cylinderGeometry args={[0.25, 0.25, 0.07, 24]} /><meshStandardMaterial color="#7a83a8" /></mesh>
    <mesh position={[0.05, 1.35, 1.065]}><boxGeometry args={[0.75, 0.42, 0.055]} /><meshStandardMaterial color="#ffffff" /></mesh>
    <Html position={[0.05, 1.36, 1.11]} transform distanceFactor={7} rotation={[0, 0, 0]} zIndexRange={[2, 0]} style={{ pointerEvents: 'none' }}><div aria-hidden="true" style={{ color: '#2b3e8d', fontSize: 18, fontWeight: 800, letterSpacing: -1 }}>maxis</div></Html>
    <mesh position={[0.78, 1.5, 0.83]}><boxGeometry args={[0.1, 2.2, 0.055]} /><meshStandardMaterial color="#f8ffff" /></mesh>
    <mesh position={[0.78, 0.4 + fraction * 1.1, 0.87]}><boxGeometry args={[0.055, fraction * 2.2, 0.02]} /><meshBasicMaterial color={quality === 'valid' ? '#2b3e8d' : '#8086a2'} /></mesh>
  </group>;
}

function Pump({ running, animate }: { running: boolean; animate: boolean }) {
  const fan = useRef<THREE.Group>(null);
  useFrame((_, delta) => { if (fan.current && running && animate) fan.current.rotation.z += delta * 2.5; });
  return <group>
    <Pad />
    <RoundedBox args={[1.05, 0.14, 0.85]} radius={0.04} position={[0, 0.3, 0]} castShadow><meshStandardMaterial color="#505a8a" /></RoundedBox>
    <mesh position={[0, 0.67, -0.1]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.34, 0.34, 0.78, 32]} /><meshStandardMaterial color="#4a5db2" roughness={0.5} metalness={0.15} /></mesh>
    {[-0.34, -0.24, -0.14, -0.04, 0.06].map(z => <mesh key={z} position={[0, 0.67, z]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.34, 0.02, 6, 28]} /><meshStandardMaterial color="#30428f" /></mesh>)}
    <mesh position={[0, 0.66, 0.45]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.4, 0.4, 0.32, 32]} /><meshStandardMaterial color="#dbdde7" metalness={0.5} roughness={0.25} /></mesh>
    <group ref={fan} position={[0, 0.66, 0.62]}>{[0, 1, 2, 3].map(i => <mesh key={i} rotation={[0, 0, i * Math.PI / 2]} position={[0, 0, 0.01]}><boxGeometry args={[0.48, 0.045, 0.04]} /><meshStandardMaterial color="#545f92" /></mesh>)}</group>
    <mesh position={[0.42, 0.59, 0.4]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.13, 0.13, 0.4, 16]} /><meshStandardMaterial color="#7c86b2" /></mesh>
  </group>;
}

function Membrane({ status }: { status: EquipmentStatus }) {
  const fault=status==='warning'||status==='critical';
  const bodyColor=status==='critical'?'#f0b9b4':status==='warning'?'#f3dfb9':'#e5e7ee';
  const glowColor=status==='critical'?'#e35f50':status==='warning'?'#d89519':'#000000';
  return <group>
    <Pad width={2.05} depth={1.6} />
    {[-0.86, 0.86].map(x => <mesh key={x} position={[x, 1.08, -0.35]} castShadow><boxGeometry args={[0.07, 1.8, 0.08]} /><meshStandardMaterial color="#8087a8" metalness={0.5} /></mesh>)}
    {[0.4, 1.93].map(y => <mesh key={y} position={[0, y, -0.35]} castShadow><boxGeometry args={[1.78, 0.08, 0.09]} /><meshStandardMaterial color="#8087a8" metalness={0.5} /></mesh>)}
    {[-0.56, 0, 0.56].map((x, i) => <group key={x} position={[x, 0, 0]}>
      <mesh position={[0, 1.08, 0]} castShadow><cylinderGeometry args={[0.205, 0.205, 1.45, 24]} /><meshStandardMaterial color={bodyColor} emissive={fault ? glowColor : '#000000'} emissiveIntensity={fault ? 0.12 : 0} roughness={0.4} metalness={0.08} /></mesh>
      {[0.41, 1.76].map(y => <mesh key={y} position={[0, y, 0]} castShadow><cylinderGeometry args={[0.235, 0.235, 0.17, 24]} /><meshStandardMaterial color={status === 'critical' || status === 'warning' ? tones[status] : '#6a749e'} roughness={0.4} /></mesh>)}
      <mesh position={[0, 1.12, 0.211]}><boxGeometry args={[0.15, 0.4, 0.02]} /><meshStandardMaterial color={i % 2 ? '#aab5e7' : '#c3e9bd'} /></mesh>
      <mesh position={[0, 1.98, 0]}><cylinderGeometry args={[0.065, 0.065, 0.23, 12]} /><meshStandardMaterial color="#a1a8c4" metalness={0.45} /></mesh>
    </group>)}
    <mesh position={[0, 2.1, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.065, 0.065, 1.4, 12]} /><meshStandardMaterial color="#a1a8c4" metalness={0.45} /></mesh>
  </group>;
}

function UV({ running }: { running: boolean }) {
  return <group>
    <Pad width={1.95} depth={1.2} />
    {[-0.55, 0.55].map(x => <mesh key={x} position={[x, 0.45, 0]} castShadow><boxGeometry args={[0.12, 0.5, 0.55]} /><meshStandardMaterial color="#b8bdd3" metalness={0.5} /></mesh>)}
    <mesh position={[0, 0.85, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.24, 0.24, 1.55, 32]} /><meshPhysicalMaterial color="#eef4ed" transparent opacity={0.6} metalness={0.5} roughness={0.15} depthWrite={false} /></mesh>
    <mesh position={[0, 0.85, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.085, 0.085, 1.45, 24]} /><meshStandardMaterial color={running ? '#a3b2f6' : '#8b90a7'} emissive={running ? '#6f85e9' : '#000000'} emissiveIntensity={0.6} /></mesh>
    {[-0.8, 0.8].map(x => <mesh key={x} position={[x, 0.85, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.27, 0.27, 0.15, 24]} /><meshStandardMaterial color="#7981a6" metalness={0.5} roughness={0.3} /></mesh>)}
    <RoundedBox args={[0.55, 0.45, 0.27]} radius={0.04} position={[0, 0.55, 0.48]} castShadow><meshStandardMaterial color="#f8fcf8" /></RoundedBox>
    <mesh position={[0, 0.6, 0.62]}><planeGeometry args={[0.3, 0.16]} /><meshBasicMaterial color={running ? '#bec7ec' : '#b5b8c5'} /></mesh>
  </group>;
}

function Solar() {
  return <group>
    {[-1.3, 1.3].flatMap(x => [-0.65, 0.65].map(z => <mesh key={`${x}-${z}`} position={[x, 0.83, z]} castShadow><boxGeometry args={[0.055, 1.65, 0.06]} /><meshStandardMaterial color="#949ab5" metalness={0.5} /></mesh>))}
    <group position={[0, 1.7, 0]} rotation={[-0.23, 0, 0]}>
      <RoundedBox args={[3.35, 0.08, 2.1]} radius={0.02} castShadow><meshStandardMaterial color="#f1f2f7" metalness={0.3} /></RoundedBox>
      {[-1.08, 0, 1.08].flatMap(x => [-0.5, 0.5].map(z => <group key={`${x}-${z}`} position={[x, 0.06, z]}>
        <mesh castShadow><boxGeometry args={[1.01, 0.055, 0.94]} /><meshStandardMaterial color="#232f64" metalness={0.22} roughness={0.25} /></mesh>
        {[-0.31, 0, 0.31].map(cx => <mesh key={cx} position={[cx, 0.03, 0]}><boxGeometry args={[0.009, 0.01, 0.88]} /><meshBasicMaterial color="#566194" /></mesh>)}
        {[-0.3, 0, 0.3].map(cz => <mesh key={cz} position={[0, 0.03, cz]}><boxGeometry args={[0.95, 0.01, 0.009]} /><meshBasicMaterial color="#566194" /></mesh>)}
      </group>))}
    </group>
  </group>;
}

function Mains() {
  return <group>
    <Pad width={1.85} depth={1.35} />
    <mesh position={[0, 0.55, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.18, 0.18, 1.6, 24]} /><meshStandardMaterial color="#7983ad" metalness={0.5} roughness={0.3} /></mesh>
    <mesh position={[0, 0.75, 0]} castShadow><boxGeometry args={[0.45, 0.45, 0.4]} /><meshStandardMaterial color="#5665a7" metalness={0.3} /></mesh>
    <mesh position={[0, 1.08, 0]}><cylinderGeometry args={[0.05, 0.05, 0.4, 12]} /><meshStandardMaterial color="#70789e" metalness={0.6} /></mesh>
    <mesh position={[0, 1.28, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow><torusGeometry args={[0.32, 0.045, 10, 28]} /><meshStandardMaterial color="#5d6794" metalness={0.3} /></mesh>
    {[0, Math.PI / 3, 2 * Math.PI / 3].map(r => <mesh key={r} position={[0, 1.28, 0]} rotation={[0, r, 0]}><boxGeometry args={[0.6, 0.04, 0.035]} /><meshStandardMaterial color="#5d6794" /></mesh>)}
    <mesh position={[-0.58, 0.47, 0]}><boxGeometry args={[0.08, 0.6, 0.4]} /><meshStandardMaterial color="#bcc0d4" /></mesh>
    <mesh position={[0.58, 0.47, 0]}><boxGeometry args={[0.08, 0.6, 0.4]} /><meshStandardMaterial color="#bcc0d4" /></mesh>
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
    <RoundedBox args={[1, 0.82, 1.05]} radius={0.025} position={[0, 0.51, 0]} castShadow><meshStandardMaterial color="#f3f4f8" roughness={0.8} /></RoundedBox>
    <mesh geometry={roof} position={[0, 0.94, 0]} castShadow><meshStandardMaterial color="#6a749e" roughness={0.7} /></mesh>
    <mesh position={[0.13, 0.37, 0.532]}><boxGeometry args={[0.23, 0.56, 0.025]} /><meshStandardMaterial color="#828aaf" /></mesh>
    <mesh position={[-0.25, 0.62, 0.533]}><boxGeometry args={[0.22, 0.24, 0.027]} /><meshStandardMaterial color="#98a4da" roughness={0.2} /></mesh>
    <mesh position={[0.51, 0.61, 0]}><boxGeometry args={[0.025, 0.24, 0.28]} /><meshStandardMaterial color="#98a4da" roughness={0.2} /></mesh>
    <mesh position={[0.13, 0.09, 0.73]}><boxGeometry args={[0.4, 0.06, 0.36]} /><meshStandardMaterial color="#cfd3e2" /></mesh>
  </group>;
}

function Tree({ position, size = 1 }: { position: [number, number, number]; size?: number }) {
  return <group position={position} scale={size}>
    <mesh position={[0, 0.35, 0]} castShadow><cylinderGeometry args={[0.035, 0.05, 0.7, 8]} /><meshStandardMaterial color="#5a6597" /></mesh>
    <mesh position={[0, 0.87, 0]} castShadow><sphereGeometry args={[0.34, 10, 8]} /><meshStandardMaterial color="#8b92b1" flatShading roughness={0.9} /></mesh>
    <mesh position={[0.08, 1.09, 0]} castShadow><sphereGeometry args={[0.26, 10, 8]} /><meshStandardMaterial color="#a9aec7" flatShading roughness={0.9} /></mesh>
  </group>;
}

function Scene({ snapshot, selected, onSelect, view = defaultCameraRequest, animate, compact, immersive = false }: Props & { view: CameraRequest; animate: boolean; compact: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const responsiveCamera: [number,number,number] = compact ? [16.5,15.2,21.6] : cameraPosition;
  useEffect(() => {
    const control = controls.current;
    if (!control) return;
    if (view.action === 'reset') {
      control.target.set(0, 0.7, -0.2);
      control.object.position.set(...responsiveCamera);
      control.update();
      control.saveState();
    }
    else if (view.action === 'left' || view.action === 'right') control.setAzimuthalAngle(control.getAzimuthalAngle() + (view.action === 'left' ? -1 : 1) * Math.PI / 8);
    else if (view.action === 'up' || view.action === 'down') control.setPolarAngle(THREE.MathUtils.clamp(control.getPolarAngle() + (view.action === 'up' ? -1 : 1) * Math.PI / 12, control.minPolarAngle, control.maxPolarAngle));
    else {
      const offset = control.object.position.clone().sub(control.target);
      const distance = THREE.MathUtils.clamp(offset.length() * (view.action === 'in' ? 0.85 : 1.18), control.minDistance, control.maxDistance);
      offset.setLength(distance);
      control.object.position.copy(control.target).add(offset);
    }
    control.update();
  }, [view,compact]);
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
    <color attach="background" args={[immersive ? '#141620' : '#e9ebf2']} />
    {immersive&&<fog attach="fog" args={['#141620',24,62]} />}
    <ambientLight intensity={immersive?0.72:1.1} />
    <hemisphereLight args={immersive?['#d4d8eb','#1b2450',1.05]:['#ffffff','#b2b8d0',1.3]} />
    <directionalLight position={[-5, 12, 8]} intensity={immersive?1.65:2.1} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-11} shadow-camera-right={11} shadow-camera-top={9} shadow-camera-bottom={-9} shadow-normalBias={0.05} />
    {immersive&&<mesh rotation={[-Math.PI/2,0,0]} position={[0,-0.58,0]} receiveShadow><planeGeometry args={[160,160]}/><meshStandardMaterial color="#141620" roughness={1}/></mesh>}
    <RoundedBox args={[17.2, 0.4, 9.8]} radius={0.2} position={[0, -0.26, -0.35]} receiveShadow><meshStandardMaterial color={immersive?'#2c3147':'#dcdee8'} roughness={0.9} /></RoundedBox>
    <RoundedBox args={[16.6, 0.055, 9.2]} radius={0.16} position={[0, -0.038, -0.35]} receiveShadow><meshStandardMaterial color={immersive?'#3b425e':'#ecedf4'} roughness={0.95} /></RoundedBox>
    <mesh position={[-1.65, 0.007, 0.65]} receiveShadow><boxGeometry args={[10.9, 0.035, 3.3]} /><meshStandardMaterial color={immersive?'#343a55':'#dde0eb'} /></mesh>
    <RoundedBox args={[4.7, 0.04, 4.65]} radius={0.3} position={[5.3, 0.01, 1.47]} receiveShadow><meshStandardMaterial color={immersive?'#42496a':'#dfe2ed'} roughness={1} /></RoundedBox>
    <mesh position={[5.3, 0.045, 1.52]} receiveShadow><boxGeometry args={[0.5, 0.03, 4.1]} /><meshStandardMaterial color={immersive?'#6e7389':'#e4ede3'} /></mesh>
    <mesh position={[5.3, 0.047, 1.52]} receiveShadow><boxGeometry args={[4, 0.03, 0.35]} /><meshStandardMaterial color={immersive?'#6e7389':'#e4ede3'} /></mesh>
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
    <ContactShadows position={[0, -0.49, 0]} opacity={0.22} scale={24} blur={2.2} far={6} resolution={512} color="#60688f" frames={1} />
    <OrbitControls ref={controls} makeDefault target={[0, 0.7, -0.2]} minDistance={12} maxDistance={32} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2.25} enablePan={false} enableDamping={animate} dampingFactor={0.12} />
  </>;
}

function Schematic({ snapshot, selected, onSelect, animate, compact, immersive = false }: Props & { animate: boolean; compact: boolean }) {
  const [focused, setFocused] = useState<EquipmentId | null>(null);
  const nodes: Record<EquipmentId, [number, number]> = compact
    ? { tank: [25, 170], pump: [235, 170], membrane: [235, 330], uv: [25, 330], homes: [25, 490], solar: [25, 25], mains: [235, 490] }
    : { tank: [35, 150], pump: [205, 150], membrane: [375, 150], uv: [545, 150], homes: [715, 150], solar: [205, 25], mains: [625, 290] };
  const running = snapshot.connected && !snapshot.stopped && (snapshot.metrics.flow.value ?? 0) > 0;
  const rain = running && snapshot.source === 'rainwater';
  const mains = running && snapshot.source === 'mains';
  function route(d: string, active: boolean, color = '#1fcf04') { return <g aria-hidden="true"><path d={d} fill="none" stroke={active ? color : '#c1c5d6'} strokeWidth="6" strokeLinecap="round" />{active && <path d={d} fill="none" stroke="#f1ffef" strokeWidth="3" strokeDasharray="3 14">{animate && <animate attributeName="stroke-dashoffset" from="0" to="-34" dur="1s" repeatCount="indefinite" />}</path>}</g>; }
  const tankLevel = snapshot.metrics.tankLevel.value;
  return <div className="scene-schematic" style={{ padding: '18px 10px', minHeight: compact ? 480 : 370, display: 'grid', alignItems: 'center', background:immersive?'#171b29':undefined }}>
    <svg viewBox={compact ? '0 0 390 610' : '0 0 880 400'} style={{ width: '100%', maxWidth: compact ? 440 : undefined, margin: '0 auto', maxHeight: compact ? undefined : 435 }} role="group" aria-label="Interactive two dimensional installation schematic">
      <title>MAXIS installation schematic</title>
      <desc>Rainwater flows through the pump, membrane and ultraviolet treatment to the community. Mains is the backup route. Select equipment or use the equipment buttons below.</desc>
      <rect x="10" y="8" width={compact ? 370 : 860} height={compact ? 595 : 382} rx="20" fill={immersive?'#283a26':'#ecedf4'} />
      {route(compact ? 'M 90 208 H 300 V 368 H 90 V 528' : 'M 100 188 H 780', rain)}
      {route(compact ? 'M 300 528 H 90' : 'M 690 328 H 855 V 188 H 780', mains)}
      {route(compact ? 'M 90 63 H 180 V 120 H 300 V 208' : 'M 270 63 V 188', snapshot.connected && (snapshot.metrics.solarPower.value ?? 0) > 0, '#d9b259')}
      {ids.map(id => {
        const [x, y] = nodes[id]; const status = snapshot.equipment[id].status;const fault=status==='warning'||status==='critical';
        return <g key={id} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={`${names[id]}, ${status}. View equipment details`} aria-pressed={selected === id} onClick={() => onSelect(id)} onFocus={() => setFocused(id)} onBlur={() => setFocused(null)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); } }} style={{ cursor: 'pointer' }}>
          {focused === id && <rect x="-4" y="-4" width="138" height="84" rx="16" fill="none" stroke="#227b15" strokeWidth="3" />}
          {fault&&<rect x="-4" y="-4" width="138" height="84" rx="16" fill="none" stroke={tones[status]} strokeWidth="4" opacity=".8"/>}
          <rect width="130" height="76" rx="12" fill={status==='critical'?'#ffe5e1':status==='warning'?'#fff2d7':selected === id ? '#e7f8e5' : '#ffffff'} stroke={fault?tones[status]:selected === id ? '#31ad1e' : '#cfdecd'} strokeWidth={fault?2.5:selected === id ? 2 : 1} />
          <circle cx="114" cy="14" r="4" fill={tones[status]} />
          <g transform="translate(10 0)" aria-hidden="true">{id === 'tank' ? <><rect x="43" y="12" width="25" height="34" rx="4" fill="#eff7ee" stroke="#a7caa2" /><rect x="44" y={45 - 31 * ((tankLevel ?? 50) / 100)} width="23" height={31 * ((tankLevel ?? 50) / 100)} rx="2" fill={snapshot.metrics.tankLevel.quality === 'valid' ? '#576fda' : '#a4a9c2'} /></> : id === 'solar' ? <><path d="M 35 38 L 43 15 H 73 L 81 38 Z" fill="#263163" /><path d="M 47 16 L 43 37 M 58 16 V 37 M 69 16 L 73 37 M 39 28 H 78" fill="none" stroke="#818ab3" strokeWidth="1" /></> : id === 'homes' ? <><path d="M 39 27 L 56 13 L 74 27 V 46 H 39 Z" fill="#cbe0c7" /><path d="M 36 28 L 56 11 L 77 28" fill="none" stroke="#588551" strokeWidth="3" /><rect x="52" y="31" width="9" height="15" rx="1" fill="#6c77a6" /></> : id === 'membrane' ? <>{[39, 53, 67].map(x => <g key={x}><rect x={x} y="15" width="10" height="31" rx="3" fill="#e9f3e8" stroke="#67a75d" /><rect x={x} y="15" width="10" height="7" rx="2" fill={status === 'critical' || status === 'warning' ? tones[status] : '#67a75d'} /></g>)}</> : id === 'uv' ? <><rect x="33" y="22" width="47" height="18" rx="9" fill="#e8ecfb" stroke="#959ec3" /><path d="M 39 31 H 73" stroke={rain ? '#8d9ee6' : '#a5a9b9'} strokeWidth="4" /></> : id === 'pump' ? <><circle cx="55" cy="31" r="15" fill="#e9f3e8" stroke="#67a75d" strokeWidth="2" /><path d="M 43 31 H 67 M 55 19 V 43" stroke="#67a75d" strokeWidth="3" /></> : <><path d="M 35 35 H 78 M 56 35 V 19" stroke="#6873a4" strokeWidth="6" /><circle cx="56" cy="18" r="10" fill="none" stroke="#579b4c" strokeWidth="3" /></>}</g>
          <text x="65" y="63" textAnchor="middle" fill="#375732" fontFamily="inherit" fontSize={compact ? '15' : '14'} fontWeight="600">{names[id]}</text>
          <text x="65" y="99" textAnchor="middle" fill={textTones[status]} fontFamily="inherit" fontSize={compact ? '15' : '14'}>{status.charAt(0).toUpperCase() + status.slice(1)}</text>
        </g>;
      })}
    </svg>
  </div>;
}

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
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 800));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const schematic = <Schematic {...props} animate={animate} compact={compact} />;
  const cameraButtons: { action: CameraAction; label: string; aria: string; icon: typeof RotateCcw }[] = [
    { action: 'left', label: 'Left', aria: 'Rotate installation camera left', icon: RotateCcw },
    { action: 'right', label: 'Right', aria: 'Rotate installation camera right', icon: RotateCw },
    { action: 'up', label: 'Tilt up', aria: 'Tilt installation camera upward', icon: MoveUp },
    { action: 'down', label: 'Tilt down', aria: 'Tilt installation camera downward', icon: MoveDown },
    { action: 'in', label: 'Zoom in', aria: 'Zoom installation camera in', icon: ZoomIn },
    { action: 'out', label: 'Zoom out', aria: 'Zoom installation camera out', icon: ZoomOut },
    { action: 'reset', label: 'Reset', aria: 'Reset installation camera to the isometric view', icon: RotateCcw },
  ];
  return <div ref={container} className="installation-scene" style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#f1f6f0', border: '1px solid #dce7db' }}>
    <div className="scene-toolbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 18px', flexWrap: 'wrap', position: 'relative', zIndex: 11, borderBottom: '1px solid #dfebde' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: '#414867', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Droplets size={15} aria-hidden="true" color="#3045a3" />Water flow</span>
        <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Sun size={15} aria-hidden="true" color="#946c20" />Solar energy</span>
      </div>
      <div className="scene-controls" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...baseStyle, cursor: reducedMotion ? 'default' : 'pointer', opacity: reducedMotion ? 0.75 : 1 }} onClick={() => setPaused(v => !v)} disabled={reducedMotion} aria-pressed={!animate} aria-label={animate ? 'Pause visual animations. Live readings continue updating' : 'Resume visual animations'} title={reducedMotion ? 'Animations are paused by your reduced motion preference' : 'Pause animation without pausing live data'}>
          {animate ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{reducedMotion ? 'Reduced motion' : animate ? 'Pause motion' : 'Resume motion'}
        </button>
        <button type="button" style={{ ...baseStyle, cursor: supported ? 'pointer' : 'default', opacity: supported ? 1 : 0.75 }} onClick={() => { setRenderFailed(false); setMode(v => v === '3d' ? '2d' : '3d'); }} disabled={!supported} aria-label={mode === '3d' ? 'Switch to two dimensional schematic' : renderFailed ? 'Retry three dimensional installation' : 'Switch to three dimensional installation'} title={supported ? undefined : 'This device does not support the 3D view'}>
          {mode === '3d' ? <LayoutGrid size={15} aria-hidden="true" /> : <Box size={15} aria-hidden="true" />}{mode === '3d' ? '2D schematic' : renderFailed ? 'Retry 3D' : supported ? '3D installation' : '2D schematic'}
        </button>
      </div>
    </div>
    {renderFailed && <p role="status" style={{ margin: 0, padding: '12px 18px 0', color: '#4c526d', fontSize: 12 }}>The 3D view could not render. The schematic shows the same live equipment; you can retry 3D above.</p>}
    {!supported && <p style={{ margin: 0, padding: '12px 18px 0', color: '#4c526d', fontSize: 12 }}>This device uses the interactive schematic. Live readings and equipment details remain available.</p>}
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
      <span style={{ fontSize: 12, color: '#4c526d', lineHeight: 1.5 }}>{!animate ? 'Visual motion paused · live readings continue' : mode === '3d' ? 'Rotate with the controls or drag · select equipment to inspect' : 'Select equipment to inspect live and historical readings'}</span>
      <span style={{ fontSize: 12, color: '#3c6136', background: '#e1ece0', borderRadius: 20, padding: '5px 10px', fontWeight: 500 }}>3D installation view</span>
    </div>
    <div className="scene-equipment-list" role="group" aria-label="Select installation equipment" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, background: 'rgba(255,255,255,.75)', borderTop: '1px solid #dce7db', padding: 16 }}>
      {ids.map((id, index) => <button className="scene-equipment-button" key={id} type="button" onClick={() => props.onSelect(id)} aria-pressed={props.selected === id} aria-label={`${names[id]}, ${props.snapshot.equipment[id].status}. View details`} style={{ ...baseStyle, justifyContent: 'flex-start', gap: 9, padding: '10px 12px', minHeight: 54, background: props.selected === id ? '#e9f6e7' : '#ffffff', border: `1px solid ${props.selected === id ? '#62a657' : '#d7d9e6'}`, textAlign: 'left' }}>
        <span aria-hidden="true" style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: props.selected === id ? '#d0eccc' : '#ecedf4', color: '#3b446a', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600 }}>{index + 1}</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}><span style={{ fontWeight: 600, fontSize: 12 }}>{names[id]}</span><span style={{ color: textTones[props.snapshot.equipment[id].status], textTransform: 'capitalize', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: tones[props.snapshot.equipment[id].status] }} />{props.snapshot.equipment[id].status}</span></span>
      </button>)}
    </div>
  </div>;
}
