import { useEffect, useState } from 'react';
import { LogIn, LogOut, Satellite } from 'lucide-react';
import { useSimulator } from '../sim/store';
import { decodeClaims, initAuth, signIn, signOut, storedToken } from '../sim/auth';

// Meridian login, top-center. Signed out: a sign-in pill. Signed in: who you
// are + a LIVE badge while the backend is actually receiving Meridian data.
export function AuthButton() {
  const envLive = useSimulator((state) => state.boat.envLive);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Absorb a login callback (?token=...) and re-arm the backend with any
    // stored token so a server restart picks auth back up from an open tab.
    initAuth().then(setToken);
  }, []);

  const claims = decodeClaims(token);
  const who = claims?.email || claims?.sub || 'signed in';

  const base: React.CSSProperties = {
    position: 'absolute',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 30,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 14px',
    borderRadius: '18px',
    background: 'rgba(10, 22, 32, 0.82)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--ink)',
    backdropFilter: 'blur(6px)',
    fontSize: '12px',
  };

  if (!token) {
    return (
      <button
        onClick={() => signIn()}
        style={{ ...base, cursor: 'pointer', fontWeight: 600 }}
        title="Sign in with Meridian (nuts.services) for live weather"
      >
        <LogIn size={14} />
        Sign in · live weather
      </button>
    );
  }

  return (
    <div style={base}>
      <Satellite size={14} color={envLive ? '#3fb950' : 'rgba(255,255,255,0.45)'} />
      <span
        style={{
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.06em',
          color: envLive ? '#3fb950' : 'rgba(255,255,255,0.45)',
        }}
      >
        {envLive ? 'LIVE' : 'IDLE'}
      </span>
      <span style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {who}
      </span>
      <button
        onClick={async () => {
          await signOut();
          setToken(storedToken());
        }}
        title="Sign out"
        style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.55)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          padding: '2px',
        }}
      >
        <LogOut size={13} />
      </button>
    </div>
  );
}
