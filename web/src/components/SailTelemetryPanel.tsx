import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Activity } from 'lucide-react';
import { useSimulator } from '../sim/store';
import type { SailFormTelemetry } from './SpinnakerSail';

// Sail Form + Aerodynamic Wrench telemetry, docked bottom-left, collapsible.
// (Lived at the end of the Sail Rig control group before; pulled out so the
// debug readouts don't hold the controls column hostage.)

const COLLAPSE_KEY = 'skiff.sailTelemetry.collapsed';

export function SailTelemetryPanel() {
  const sailForces = useSimulator((state) => state.sailForces);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  });
  const [sailForm, setSailForm] = useState<SailFormTelemetry | null>(() => {
    if (typeof window === 'undefined') return null;
    return (window as any).__sailDebug?.form ?? null;
  });

  useEffect(() => {
    const handleSailForm = (event: Event) => {
      setSailForm((event as CustomEvent<SailFormTelemetry>).detail);
    };
    window.addEventListener('sail-form', handleSailForm);
    return () => window.removeEventListener('sail-form', handleSailForm);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const formatN = (v: number) =>
    Math.abs(v) >= 9500 ? `${(v / 1000).toFixed(2)} kN` : `${v.toFixed(0)} N`;
  const formatNm = (v: number) =>
    Math.abs(v) >= 9500 ? `${(v / 1000).toFixed(2)} kN·m` : `${v.toFixed(0)} N·m`;

  return (
    <div
      style={{
        position: 'absolute',
        left: '12px',
        bottom: '12px',
        width: '236px',
        background: 'rgba(10, 22, 32, 0.82)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px',
        padding: collapsed ? '6px 10px' : '8px 12px 12px',
        color: 'var(--ink)',
        backdropFilter: 'blur(6px)',
        zIndex: 20,
        fontSize: '12px',
      }}
    >
      <button
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'rgba(255,255,255,0.65)',
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 'bold',
        }}
        title={collapsed ? 'Expand sail telemetry' : 'Collapse sail telemetry'}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <Activity size={13} />
        Sail Telemetry
      </button>

      {!collapsed && (
        <>
          <div style={sectionHeaderStyle}>Sail Form</div>
          <table style={tableStyle}>
            <tbody>
              <Row label="Mean strain" value={sailForm ? `${(sailForm.meanStrain * 100).toFixed(2)} %` : '—'} />
              <Row label="Normal coherence" value={sailForm ? sailForm.normalCoherence.toFixed(3) : '—'} />
              <Row label="Fold edges" value={sailForm ? sailForm.foldEdgeCount.toString() : '—'} />
              <Row label="Max rest deviation" value={sailForm ? `${sailForm.maxRestDeviation.toFixed(3)} m` : '—'} />
              <Row label="Luff sag" value={sailForm ? `${sailForm.luffSagM.toFixed(3)} m` : '—'} />
              <Row label="Camber" value={sailForm ? `${sailForm.camberM.toFixed(3)} m` : '—'} />
            </tbody>
          </table>

          <div style={sectionHeaderStyle}>Aerodynamic Wrench</div>
          <table style={tableStyle}>
            <tbody>
              <Row label="Drive (fwd)" value={formatN(sailForces.f_body[0])} />
              <Row label="Side (stbd)" value={formatN(sailForces.f_body[1])} />
              <Row label="Vertical (up)" value={formatN(-sailForces.f_body[2])} />
              <Row
                label="|F| Total"
                value={formatN(
                  Math.sqrt(
                    sailForces.f_body[0] ** 2 + sailForces.f_body[1] ** 2 + sailForces.f_body[2] ** 2
                  )
                )}
              />
              <Row label="Heel moment" value={formatNm(sailForces.tau_body[0])} />
              <Row label="Pitch moment" value={formatNm(sailForces.tau_body[1])} />
              <Row label="Yaw moment" value={formatNm(sailForces.tau_body[2])} />
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'rgba(255,255,255,0.4)',
  fontWeight: 'bold',
  margin: '10px 0 6px',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  fontSize: '12px',
  borderCollapse: 'collapse',
  color: 'var(--ink)',
  fontFamily: 'monospace',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <td style={{ padding: '3px 0', color: 'rgba(255,255,255,0.5)', fontFamily: 'sans-serif' }}>{label}</td>
      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{value}</td>
    </tr>
  );
}
