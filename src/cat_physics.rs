use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Foil {
    pub name: String,
    pub area: f64,
    pub aspect_ratio: f64,
    pub cd0: f64,
    pub stall_deg: f64,
    pub r: [f64; 3],
    pub oswald: f64,
    pub is_sail: bool,
}

impl Foil {
    pub fn lift_slope(&self) -> f64 {
        2.0 * std::f64::consts::PI / (1.0 + 2.0 / self.aspect_ratio)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatParams {
    pub mass: f64,
    pub ixx: f64,
    pub iyy: f64,
    pub izz: f64,
    pub added: [f64; 6],
    pub d_lin: [f64; 6],
    pub d_quad: [f64; 6],

    pub hull_offset: f64,
    pub cg_height: f64,
    pub phi_fly: f64,
    pub gm_l: f64,
    pub theta_avs: f64,
    pub awp: f64,

    pub skegs: Vec<Foil>,
    pub rudders: Vec<Foil>,
    pub engines_r: [[f64; 3]; 2],
    pub sail: Foil,
    pub mast_ce_height: f64,
    pub bridgedeck_clearance: f64,

    pub rudder_tau: f64,
    pub rudder_max: f64,
    pub gust_factor: f64,
}

impl CatParams {
    pub fn mass_matrix(&self) -> [f64; 6] {
        [
            self.mass + self.added[0],
            self.mass + self.added[1],
            self.mass + self.added[2],
            self.ixx + self.added[3],
            self.iyy + self.added[4],
            self.izz + self.added[5],
        ]
    }

    pub fn phi_avs(&self) -> f64 {
        self.hull_offset.atan2(self.cg_height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum StabilityState {
    #[serde(rename = "upright")]
    Upright,
    #[serde(rename = "knockdown")]
    Knockdown,
    #[serde(rename = "capsized_transverse")]
    CapsizedTransverse,
    #[serde(rename = "capsized_pitchpole")]
    CapsizedPitchpole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatControl {
    pub rudder_cmd: f64,
    pub sail_trim: f64,
    pub thrust_port: f64,
    pub thrust_stbd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatState {
    pub eta: [f64; 6],
    pub nu: [f64; 6],
    pub rudder: f64,
    pub stability: StabilityState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Environment {
    pub wind_world: [f64; 3],
    pub current_world: [f64; 3],
}

/// Cloth-sim sail wrench in body frame. `blend` ∈ [0, 1]: 1 = fully replace the
/// coefficient sail, 0 = pure coefficient. Intermediate values blend smoothly
/// during staleness decay (never hold a stale wrench alone, never drop to zero).
#[derive(Debug, Clone, Copy)]
pub struct SailWrenchOverride {
    pub f_body: [f64; 3],
    pub tau_body: [f64; 3],
    pub blend: f64,
}

/// Map a vector from sail/glTF frame (+X starboard, +Y up, +Z bow) into backend
/// body frame (+X forward, +Y starboard, +Z down). See plan §2.1.
pub fn gltf_vec_to_body(v_gltf: [f64; 3]) -> [f64; 3] {
    [v_gltf[2], v_gltf[0], -v_gltf[1]]
}

/// Position of the hull glTF model origin `(0,0,0)` in body coordinates, relative
/// to the CG (body origin used by `apply_at` / all foil `r` vectors).
///
/// **Assumptions (Lagoon 450S interim):**
/// - The exported hull glTF origin sits at the **waterline on centerline**.
/// - Fore-aft and lateral offsets vs CG are ≈ 0 (not surveyed; document if refined).
/// - Body frame has +Z **down**, CG is `cg_height` above the waterline, so the
///   glTF origin is at body `z = +cg_height`. The numeric vertical matches
///   [`lagoon_450s`] `cg_height` (0.86 m); update both together if VCG changes.
///
/// Cloth torques are summed about this point; backend shifts them to CG via
/// [`cloth_wrench_to_cg`] before they enter generalized forces.
pub const GLTF_ORIGIN_IN_BODY: [f64; 3] = [0.0, 0.0, 0.86];

/// Convert a cloth wrench (force + torque about the glTF origin, already in body
/// axes) into a 6-DOF wrench about the CG.
///
/// `τ_cg = τ_gltf + r_gltf_origin × f` with `r = GLTF_ORIGIN_IN_BODY`.
pub fn cloth_wrench_to_cg(f_body: [f64; 3], tau_about_gltf: [f64; 3]) -> [f64; 6] {
    let shift = cross(GLTF_ORIGIN_IN_BODY, f_body);
    [
        f_body[0],
        f_body[1],
        f_body[2],
        tau_about_gltf[0] + shift[0],
        tau_about_gltf[1] + shift[1],
        tau_about_gltf[2] + shift[2],
    ]
}

// Helper functions for vector math

pub fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn rotation_body_to_world(phi: f64, theta: f64, psi: f64) -> [[f64; 3]; 3] {
    let cphi = phi.cos();
    let sphi = phi.sin();
    let cth = theta.cos();
    let sth = theta.sin();
    let cpsi = psi.cos();
    let spsi = psi.sin();

    [
        [
            cpsi * cth,
            cpsi * sth * sphi - spsi * cphi,
            cpsi * sth * cphi + spsi * sphi,
        ],
        [
            spsi * cth,
            spsi * sth * sphi + cpsi * cphi,
            // D1 fix: was `… - cphi * sphi`; must be `… - cpsi * sphi` (standard ZYX).
            spsi * sth * cphi - cpsi * sphi,
        ],
        [
            -sth,
            cth * sphi,
            cth * cphi,
        ],
    ]
}

pub fn rotate_body_to_world(r: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
        r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
        r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
    ]
}

pub fn rotate_world_to_body(r: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        r[0][0] * v[0] + r[1][0] * v[1] + r[2][0] * v[2],
        r[0][1] * v[0] + r[1][1] * v[1] + r[2][1] * v[2],
        r[0][2] * v[0] + r[1][2] * v[1] + r[2][2] * v[2],
    ]
}

pub fn euler_rate_t_apply(phi: f64, theta: f64, omega: [f64; 3]) -> [f64; 3] {
    let cphi = phi.cos();
    let sphi = phi.sin();
    let cth = theta.cos().abs().max(1.0e-3) * theta.cos().signum();
    let tth = theta.tan();

    let p = omega[0];
    let q = omega[1];
    let r = omega[2];

    [
        p + sphi * tth * q + cphi * tth * r,
        cphi * q - sphi * r,
        (sphi * q + cphi * r) / cth,
    ]
}

pub fn wrap_pi(a: f64) -> f64 {
    (a + std::f64::consts::PI).rem_euclid(2.0 * std::f64::consts::PI) - std::f64::consts::PI
}

fn foil_force_2d(inflow_xy: [f64; 2], chord_unit: [f64; 2], foil: &Foil, rho: f64) -> [f64; 3] {
    let v = inflow_xy[0].hypot(inflow_xy[1]);
    if v < 1e-4 {
        return [0.0, 0.0, 0.0];
    }
    let flow_dir = [inflow_xy[0] / v, inflow_xy[1] / v];
    let dot = chord_unit[0] * flow_dir[0] + chord_unit[1] * flow_dir[1];
    let c = if dot >= 0.0 {
        chord_unit
    } else {
        [-chord_unit[0], -chord_unit[1]]
    };
    let cross_val = c[0] * flow_dir[1] - c[1] * flow_dir[0];
    let dot_val = c[0] * flow_dir[0] + c[1] * flow_dir[1];
    let alpha = cross_val.atan2(dot_val);
    let a_abs = alpha.abs();
    let stall = foil.stall_deg.to_radians();

    let cl_lin = foil.lift_slope() * a_abs;
    let (cl, cd) = if a_abs <= stall {
        let cl = cl_lin;
        let cd = foil.cd0 + cl * cl / (std::f64::consts::PI * foil.aspect_ratio * foil.oswald);
        (cl, cd)
    } else {
        let cl_peak = foil.lift_slope() * stall;
        let cl = (cl_peak - (a_abs - stall) * 2.0).max(0.0);
        let cd_attached = foil.cd0 + cl_peak * cl_peak / (std::f64::consts::PI * foil.aspect_ratio * foil.oswald);
        let cd = cd_attached + 1.2 * (a_abs.sin() - stall.sin()).powi(2) * 6.0;
        (cl, cd)
    };

    let q = 0.5 * rho * v * v;
    let lift = q * foil.area * cl;
    let drag = q * foil.area * cd;
    let sign = if alpha >= 0.0 { 1.0 } else { -1.0 };
    let perp = [-flow_dir[1], flow_dir[0]];
    let fx = drag * flow_dir[0] + lift * perp[0] * sign;
    let fy = drag * flow_dir[1] + lift * perp[1] * sign;
    [fx, fy, 0.0]
}

/// Apply a body-frame force at position `r` (body coords relative to CG).
/// Returns the 6-DOF wrench `[F, r × F]` about the CG.
pub fn apply_at(force_body: [f64; 3], r: [f64; 3]) -> [f64; 6] {
    let mut tau = [0.0; 6];
    tau[0] = force_body[0];
    tau[1] = force_body[1];
    tau[2] = force_body[2];
    let moments = cross(r, force_body);
    tau[3] = moments[0];
    tau[4] = moments[1];
    tau[5] = moments[2];
    tau
}

fn gz_transverse(phi: f64, p: &CatParams) -> f64 {
    let b = p.hull_offset;
    let h = p.cg_height;
    let pf = p.phi_fly;
    let a = phi.abs();
    let flying = |x: f64| b * x.cos() - h * x.sin();
    let gz_at_fly = flying(pf);
    let gz = if a < pf {
        gz_at_fly * (a / pf)
    } else {
        flying(a)
    };
    if phi >= 0.0 { gz } else { -gz }
}

fn gz_longitudinal(theta: f64, p: &CatParams) -> f64 {
    let a = theta.abs();
    let min_val = a.min(p.theta_avs);
    let max_val = 0.0f64.max(a - p.theta_avs);
    let gz = p.gm_l * min_val.sin() - p.gm_l * 0.6 * max_val;
    if theta >= 0.0 { gz } else { -gz }
}

fn cat_restoring(eta: &[f64; 6], p: &CatParams) -> [f64; 6] {
    let z = eta[2];
    let phi = eta[3];
    let theta = eta[4];
    let w = p.mass * 9.81;
    let mut g = [0.0; 6];
    g[2] = 1025.0 * 9.81 * p.awp * z;
    g[3] = w * gz_transverse(phi, p);
    g[4] = w * gz_longitudinal(theta, p);
    g
}

fn rm_transverse_peak(p: &CatParams) -> f64 {
    let w = p.mass * 9.81;
    w * (p.hull_offset * p.phi_fly.cos() - p.cg_height * p.phi_fly.sin())
}

fn rm_longitudinal_peak(p: &CatParams) -> f64 {
    let w = p.mass * 9.81;
    w * p.gm_l * p.theta_avs.sin()
}

fn damping_nu(nu: &[f64; 6], p: &CatParams) -> [f64; 6] {
    let mut d_nu = [0.0; 6];
    for i in 0..6 {
        let d = p.d_lin[i] + p.d_quad[i] * nu[i].abs();
        d_nu[i] = d * nu[i];
    }
    d_nu
}

/// Air density (kg/m³) — aerodynamic pressure is `0.5 * RHO_AIR * v² * C`.
pub const RHO_AIR: f64 = 1.225;

/// Sheet/boom angle at full trim (`sail_trim = 1`): hard-sheeted, near centerline.
pub const SAIL_SHEET_HARD_DEG: f64 = 6.0;
/// Sheet/boom angle at zero trim (`sail_trim = 0`): fully eased.
pub const SAIL_SHEET_EASED_DEG: f64 = 85.0;

/// Map UI/control `sail_trim` ∈ [0, 1] to max sheet/boom angle (radians).
///
/// - `trim = 1` → hard sheeted at [`SAIL_SHEET_HARD_DEG`] (~6°)
/// - `trim = 0` → fully eased at [`SAIL_SHEET_EASED_DEG`] (~85°)
/// - linear in between
///
/// `CatControl.sail_trim` is this angle (rad). The coefficient sail then applies a
/// weathervane clamp so |boom| ≤ |AWA| (sail cannot be sheeted "above" the wind).
pub fn sail_trim_to_sheet_rad(sail_trim_01: f64) -> f64 {
    let t = sail_trim_01.clamp(0.0, 1.0);
    let deg =
        SAIL_SHEET_EASED_DEG + t * (SAIL_SHEET_HARD_DEG - SAIL_SHEET_EASED_DEG);
    deg.to_radians()
}

// Hull/rig windage: flat-plate drag per body axis on projected areas (m²).
// Rough Lagoon 450S-class numbers (documented for tuning, not survey data):
//   A_x ≈ frontal hull ends + cabin face
//   A_y ≈ beam profile (hull side + cabin + freeboard + rough rig)
//   A_z ≈ planform deck / cabin top
// Cd ≈ 1.1 typical flat-plate bluff body.
const WINDAGE_AREA_M2: [f64; 3] = [6.0, 18.0, 45.0];
const WINDAGE_CD: f64 = 1.1;

/// Build the coefficient-model sail wrench at the CE (body frame 6-DOF).
/// Returns zeros when inverted or when apparent wind is negligible.
fn coefficient_sail_wrench(
    st: &CatState,
    p: &CatParams,
    ctrl: &CatControl,
    wind_body: [f64; 3],
    ground_lin: [f64; 3],
    omega: [f64; 3],
) -> [f64; 6] {
    let inverted = matches!(
        st.stability,
        StabilityState::CapsizedTransverse | StabilityState::CapsizedPitchpole
    );
    if inverted {
        return [0.0; 6];
    }

    // Ground-relative velocity at CE: ground_lin + ω × r_ce (full cross, incl. aft CE).
    let r = p.sail.r;
    let v_ce = [
        ground_lin[0] + omega[1] * r[2] - omega[2] * r[1],
        ground_lin[1] + omega[2] * r[0] - omega[0] * r[2],
    ];
    let inflow = [wind_body[0] - v_ce[0], wind_body[1] - v_ce[1]];

    // Sheet/boom: `ctrl.sail_trim` is max sheet angle (rad) from
    // [`sail_trim_to_sheet_rad`]. Sign toward leeward (same sign as AWA).
    // Weathervane clamp: |boom| cannot exceed |AWA| (cannot sheet above the wind).
    let awa = inflow[1].atan2(inflow[0]);
    let trim = ctrl.sail_trim.abs();
    let boom = if awa.abs() <= trim {
        awa
    } else if awa == 0.0 {
        0.0
    } else {
        awa.signum() * trim
    };

    let f = foil_force_2d(inflow, [boom.cos(), boom.sin()], &p.sail, RHO_AIR);
    apply_at(f, p.sail.r)
}

pub fn cat_forces(
    st: &CatState,
    p: &CatParams,
    env: &Environment,
    ctrl: &CatControl,
    sail_override: Option<SailWrenchOverride>,
) -> ([f64; 6], f64, f64) {
    let phi = st.eta[3];
    let theta = st.eta[4];
    let psi = st.eta[5];
    let r_mat = rotation_body_to_world(phi, theta, psi);

    let nu_lin = [st.nu[0], st.nu[1], st.nu[2]];
    let omega = [st.nu[3], st.nu[4], st.nu[5]];

    let current_body = rotate_world_to_body(&r_mat, env.current_world);
    let wind_body = rotate_world_to_body(&r_mat, env.wind_world);
    let ground_lin = [
        nu_lin[0] + current_body[0],
        nu_lin[1] + current_body[1],
        nu_lin[2] + current_body[2],
    ];

    let inverted = matches!(
        st.stability,
        StabilityState::CapsizedTransverse | StabilityState::CapsizedPitchpole
    );

    let mut tau = [0.0; 6];

    // 1. Skegs + Rudders
    for skeg in &p.skegs {
        let v_pt = [
            nu_lin[0] + omega[1] * skeg.r[2] - omega[2] * skeg.r[1],
            nu_lin[1] + omega[2] * skeg.r[0] - omega[0] * skeg.r[2],
            nu_lin[2] + omega[0] * skeg.r[1] - omega[1] * skeg.r[0],
        ];
        let inflow = [-v_pt[0], -v_pt[1]];
        let chord = [1.0, 0.0];
        let f = foil_force_2d(inflow, chord, skeg, 1025.0);
        let f_tau = apply_at(f, skeg.r);
        for i in 0..6 {
            tau[i] += f_tau[i];
        }
    }

    let rudders_info = [
        (&p.rudders[0], ctrl.thrust_port),
        (&p.rudders[1], ctrl.thrust_stbd),
    ];
    for (rudder, thrust) in rudders_info {
        let v_pt = [
            nu_lin[0] + omega[1] * rudder.r[2] - omega[2] * rudder.r[1],
            nu_lin[1] + omega[2] * rudder.r[0] - omega[0] * rudder.r[2],
            nu_lin[2] + omega[0] * rudder.r[1] - omega[1] * rudder.r[0],
        ];
        let mut inflow = [-v_pt[0], -v_pt[1]];
        inflow[0] += -0.0008 * thrust;

        let chord_angle = -st.rudder;
        let chord = [chord_angle.cos(), chord_angle.sin()];
        let f = foil_force_2d(inflow, chord, rudder, 1025.0);
        let f_tau = apply_at(f, rudder.r);
        for i in 0..6 {
            tau[i] += f_tau[i];
        }
    }

    // 2. Engines
    if !inverted {
        let engines_info = [
            (ctrl.thrust_port, p.engines_r[0]),
            (ctrl.thrust_stbd, p.engines_r[1]),
        ];
        for (t, r) in engines_info {
            let f = [t, 0.0, 0.0];
            let f_tau = apply_at(f, r);
            for i in 0..6 {
                tau[i] += f_tau[i];
            }
        }
    }

    // 3. Sail — coefficient model at CE; optional cloth wrench blend (plan §4.1/§4.2).
    // Skip entirely when inverted.
    let mut m_heel = 0.0;
    let mut m_pitch = 0.0;
    if !inverted {
        let coeff = coefficient_sail_wrench(st, p, ctrl, wind_body, ground_lin, omega);
        let sail_tau = if let Some(ov) = sail_override {
            let b = ov.blend.clamp(0.0, 1.0);
            // Cloth τ is about glTF origin; shift to CG before blending with
            // the coefficient sail (which is already about CG via apply_at).
            let ext = cloth_wrench_to_cg(ov.f_body, ov.tau_body);
            let mut blended = [0.0; 6];
            for i in 0..6 {
                blended[i] = b * ext[i] + (1.0 - b) * coeff[i];
            }
            blended
        } else {
            coeff
        };
        for i in 0..6 {
            tau[i] += sail_tau[i];
        }
        m_heel = sail_tau[3].abs();
        m_pitch = sail_tau[4].abs();
    }

    // 4. Hull/rig windage — flat-plate drag per body axis (always, incl. inverted).
    // Relative air velocity (TO convention): wind_body − ground velocity.
    let v_air = [
        wind_body[0] - ground_lin[0],
        wind_body[1] - ground_lin[1],
        wind_body[2] - ground_lin[2],
    ];
    for i in 0..3 {
        // Force on boat along axis i: ½ ρ Cd A |v| v (air pushes with relative flow).
        tau[i] += 0.5 * RHO_AIR * WINDAGE_CD * WINDAGE_AREA_M2[i] * v_air[i].abs() * v_air[i];
    }

    (tau, m_heel, m_pitch)
}

fn update_stability(st: &CatState, p: &CatParams, m_heel: f64, m_pitch: f64) -> StabilityState {
    match st.stability {
        StabilityState::CapsizedTransverse | StabilityState::CapsizedPitchpole => {
            st.stability
        }
        _ => {
            let phi = st.eta[3].abs();
            let theta = st.eta[4].abs();
            if m_heel >= rm_transverse_peak(p) || phi >= p.phi_avs() {
                StabilityState::CapsizedTransverse
            } else if m_pitch >= rm_longitudinal_peak(p) || theta >= p.theta_avs {
                StabilityState::CapsizedPitchpole
            } else if phi > p.phi_fly {
                StabilityState::Knockdown
            } else {
                StabilityState::Upright
            }
        }
    }
}

fn cat_derivative(
    vec: &[f64; 13],
    p: &CatParams,
    env: &Environment,
    ctrl: &CatControl,
    m_diag: &[f64; 6],
    m_inv_diag: &[f64; 6],
    stability: StabilityState,
    sail_override: Option<SailWrenchOverride>,
) -> ([f64; 13], f64, f64) {
    let mut eta = [0.0; 6];
    eta.copy_from_slice(&vec[0..6]);
    let mut nu = [0.0; 6];
    nu.copy_from_slice(&vec[6..12]);
    let rudder = vec[12];

    let st = CatState { eta, nu, rudder, stability };

    let phi = eta[3];
    let theta = eta[4];
    let psi = eta[5];

    let r_mat = rotation_body_to_world(phi, theta, psi);

    let nu_lin = [nu[0], nu[1], nu[2]];
    let omega = [nu[3], nu[4], nu[5]];

    let current_body = rotate_world_to_body(&r_mat, env.current_world);
    let ground_lin = [
        nu_lin[0] + current_body[0],
        nu_lin[1] + current_body[1],
        nu_lin[2] + current_body[2],
    ];

    let mut eta_dot = [0.0; 6];
    let ground_world = rotate_body_to_world(&r_mat, ground_lin);
    eta_dot[0] = ground_world[0];
    eta_dot[1] = ground_world[1];
    eta_dot[2] = ground_world[2];

    let euler_rates = euler_rate_t_apply(phi, theta, omega);
    eta_dot[3] = euler_rates[0];
    eta_dot[4] = euler_rates[1];
    eta_dot[5] = euler_rates[2];

    let (tau, m_heel, m_pitch) = cat_forces(&st, p, env, ctrl, sail_override);

    // Coriolis
    let a = [
        m_diag[0] * nu_lin[0],
        m_diag[1] * nu_lin[1],
        m_diag[2] * nu_lin[2],
    ];
    let b = [
        m_diag[3] * omega[0],
        m_diag[4] * omega[1],
        m_diag[5] * omega[2],
    ];
    let c_nu_lin = cross(a, omega);
    let c_nu_rot_a = cross(a, nu_lin);
    let c_nu_rot_b = cross(b, omega);

    let mut c_nu = [0.0; 6];
    c_nu[0] = -c_nu_lin[0];
    c_nu[1] = -c_nu_lin[1];
    c_nu[2] = -c_nu_lin[2];
    c_nu[3] = -c_nu_rot_a[0] - c_nu_rot_b[0];
    c_nu[4] = -c_nu_rot_a[1] - c_nu_rot_b[1];
    c_nu[5] = -c_nu_rot_a[2] - c_nu_rot_b[2];

    // Damping
    let d_nu = damping_nu(&nu, p);

    // Restoring
    let g = cat_restoring(&eta, p);

    // Acceleration nu_dot
    let mut nu_dot = [0.0; 6];
    for i in 0..6 {
        nu_dot[i] = m_inv_diag[i] * (tau[i] - c_nu[i] - d_nu[i] - g[i]);
    }

    // Rudder derivative
    let cmd = ctrl.rudder_cmd.clamp(-p.rudder_max, p.rudder_max);
    let rudder_dot = (cmd - rudder) / p.rudder_tau;

    let mut deriv = [0.0; 13];
    deriv[0..6].copy_from_slice(&eta_dot);
    deriv[6..12].copy_from_slice(&nu_dot);
    deriv[12] = rudder_dot;

    (deriv, m_heel, m_pitch)
}

pub fn cat_step(
    st: &CatState,
    ctrl: &CatControl,
    env: &Environment,
    p: &CatParams,
    dt: f64,
    sail_override: Option<SailWrenchOverride>,
) -> CatState {
    let m_matrix = p.mass_matrix();
    let mut m_inv = [0.0; 6];
    for i in 0..6 {
        m_inv[i] = 1.0 / m_matrix[i];
    }

    let mut vec = [0.0; 13];
    vec[0..6].copy_from_slice(&st.eta);
    vec[6..12].copy_from_slice(&st.nu);
    vec[12] = st.rudder;

    let (k1, mh, mp) =
        cat_derivative(&vec, p, env, ctrl, &m_matrix, &m_inv, st.stability, sail_override);

    let mut vec_k2 = [0.0; 13];
    for i in 0..13 {
        vec_k2[i] = vec[i] + 0.5 * dt * k1[i];
    }
    let (k2, _, _) =
        cat_derivative(&vec_k2, p, env, ctrl, &m_matrix, &m_inv, st.stability, sail_override);

    let mut vec_k3 = [0.0; 13];
    for i in 0..13 {
        vec_k3[i] = vec[i] + 0.5 * dt * k2[i];
    }
    let (k3, _, _) =
        cat_derivative(&vec_k3, p, env, ctrl, &m_matrix, &m_inv, st.stability, sail_override);

    let mut vec_k4 = [0.0; 13];
    for i in 0..13 {
        vec_k4[i] = vec[i] + dt * k3[i];
    }
    let (k4, _, _) =
        cat_derivative(&vec_k4, p, env, ctrl, &m_matrix, &m_inv, st.stability, sail_override);

    let mut next_vec = [0.0; 13];
    for i in 0..13 {
        next_vec[i] = vec[i] + (dt / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    }
    next_vec[5] = wrap_pi(next_vec[5]);

    let mut eta = [0.0; 6];
    eta.copy_from_slice(&next_vec[0..6]);
    let mut nu = [0.0; 6];
    nu.copy_from_slice(&next_vec[6..12]);
    let rudder = next_vec[12];

    let mut next_st = CatState {
        eta,
        nu,
        rudder,
        stability: st.stability,
    };
    next_st.stability = update_stability(&next_st, p, mh, mp);
    next_st
}

pub fn lagoon_450s() -> CatParams {
    let b = 3.2;

    let skegs = vec![
        Foil {
            name: "skeg.port".to_string(),
            area: 1.1,
            aspect_ratio: 1.0,
            cd0: 0.012,
            stall_deg: 16.0,
            r: [0.4, -b, 0.9],
            oswald: 0.9,
            is_sail: false,
        },
        Foil {
            name: "skeg.stbd".to_string(),
            area: 1.1,
            aspect_ratio: 1.0,
            cd0: 0.012,
            stall_deg: 16.0,
            r: [0.4, b, 0.9],
            oswald: 0.9,
            is_sail: false,
        },
    ];

    let rudders = vec![
        Foil {
            name: "rudder.port".to_string(),
            area: 0.6,
            aspect_ratio: 2.5,
            cd0: 0.012,
            stall_deg: 18.0,
            r: [-6.0, -b, 1.0],
            oswald: 0.9,
            is_sail: false,
        },
        Foil {
            name: "rudder.stbd".to_string(),
            area: 0.6,
            aspect_ratio: 2.5,
            cd0: 0.012,
            stall_deg: 18.0,
            r: [-6.0, b, 1.0],
            oswald: 0.9,
            is_sail: false,
        },
    ];

    let sail = Foil {
        name: "sail".to_string(),
        area: 90.0,
        aspect_ratio: 5.0,
        cd0: 0.08,
        stall_deg: 22.0,
        // Provisional CE: ~0.5 m aft of CG (r_x < 0) for weather-helm lever arm;
        // 8 m above CG (body +Z down). Fore-aft to be refined from Blender `ce.*`.
        r: [-0.5, 0.0, -8.0],
        oswald: 0.85,
        is_sail: true,
    };

    CatParams {
        mass: 15000.0,
        ixx: 2.0e5,
        iyy: 2.5e5,
        izz: 3.0e5,
        added: [800.0, 8000.0, 15000.0, 4.0e4, 2.0e5, 2.5e5],
        d_lin: [300.0, 4000.0, 8000.0, 3.0e4, 3.0e5, 1.2e5],
        d_quad: [110.0, 1200.0, 1600.0, 5.0e3, 8.0e4, 4.0e4],
        hull_offset: b,
        cg_height: 0.86,
        phi_fly: 12.0f64.to_radians(),
        gm_l: 30.0,
        theta_avs: 50.0f64.to_radians(),
        awp: 16.0,
        skegs,
        rudders,
        engines_r: [[-6.5, -b, 0.5], [-6.5, b, 0.5]],
        sail,
        mast_ce_height: 8.0,
        bridgedeck_clearance: 0.85,
        rudder_tau: 0.1,
        rudder_max: 35.0f64.to_radians(),
        gust_factor: 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// φ=20°, θ=5°, ψ=137° — nonzero heel/pitch so D1 is exercised.
    fn test_attitude() -> (f64, f64, f64) {
        (
            20.0f64.to_radians(),
            5.0f64.to_radians(),
            137.0f64.to_radians(),
        )
    }

    #[test]
    fn rotation_body_to_world_is_orthonormal() {
        let (phi, theta, psi) = test_attitude();
        let r = rotation_body_to_world(phi, theta, psi);

        // R · Rᵀ = I
        for i in 0..3 {
            for j in 0..3 {
                let mut dot = 0.0;
                for k in 0..3 {
                    dot += r[i][k] * r[j][k];
                }
                let expected = if i == j { 1.0 } else { 0.0 };
                assert!(
                    (dot - expected).abs() < 1e-12,
                    "R·Rᵀ[{i},{j}] = {dot}, expected {expected}"
                );
            }
        }
    }

    #[test]
    fn body_world_body_vector_round_trip() {
        let (phi, theta, psi) = test_attitude();
        let r = rotation_body_to_world(phi, theta, psi);
        let v_body = [1.2, -0.7, 0.35];
        let v_world = rotate_body_to_world(&r, v_body);
        let back = rotate_world_to_body(&r, v_world);
        for i in 0..3 {
            assert!(
                (back[i] - v_body[i]).abs() < 1e-12,
                "round-trip component {i}: got {}, want {}",
                back[i],
                v_body[i]
            );
        }
    }

    #[test]
    fn frame_map_pure_z_gltf_force_is_positive_surge() {
        // plan §2.1: v_body = [v_gltf.z, v_gltf.x, -v_gltf.y]
        let f_gltf = [0.0, 0.0, 1.0]; // pure +z_gltf (toward bow in sail frame)
        let f_body = gltf_vec_to_body(f_gltf);
        // Surge is body +X = tau[0]
        assert!(
            f_body[0] > 0.0,
            "pure +z_gltf must map to positive surge, got {:?}",
            f_body
        );
        assert!((f_body[0] - 1.0).abs() < 1e-15);
        assert!((f_body[1] - 0.0).abs() < 1e-15);
        assert!((f_body[2] - 0.0).abs() < 1e-15);
    }

    #[test]
    fn gltf_origin_vertical_matches_lagoon_cg_height() {
        let p = lagoon_450s();
        assert!(
            (GLTF_ORIGIN_IN_BODY[2] - p.cg_height).abs() < 1e-15,
            "GLTF_ORIGIN_IN_BODY.z must track lagoon_450s().cg_height"
        );
        assert_eq!(GLTF_ORIGIN_IN_BODY[0], 0.0);
        assert_eq!(GLTF_ORIGIN_IN_BODY[1], 0.0);
    }

    #[test]
    fn cloth_wrench_side_force_heel_matches_apply_at() {
        // Pure side force at a known height above CG (body +Z down → r_z < 0).
        let f = [0.0, 1500.0, 0.0];
        let h_above_cg = 8.0;
        let r_point = [0.0, 0.0, -h_above_cg];
        let expected = apply_at(f, r_point);

        // Frontend sums τ about glTF origin: τ_O = (r_point − r_O) × F.
        let r_o = GLTF_ORIGIN_IN_BODY;
        let r_from_o = [
            r_point[0] - r_o[0],
            r_point[1] - r_o[1],
            r_point[2] - r_o[2],
        ];
        let tau_about_gltf = cross(r_from_o, f);
        let through_wrench = cloth_wrench_to_cg(f, tau_about_gltf);

        for i in 0..6 {
            assert!(
                (through_wrench[i] - expected[i]).abs() < 1e-12,
                "wrench path component {i}: got {}, want {} (apply_at)",
                through_wrench[i],
                expected[i]
            );
        }
        // Heel moment (body X) must be nonzero for a side force above CG.
        assert!(expected[3].abs() > 1.0);
        assert!((expected[3] - h_above_cg * f[1]).abs() < 1e-12);
    }

    #[test]
    fn sail_trim_sheet_map_endpoints() {
        let hard = sail_trim_to_sheet_rad(1.0).to_degrees();
        let eased = sail_trim_to_sheet_rad(0.0).to_degrees();
        assert!((hard - SAIL_SHEET_HARD_DEG).abs() < 1e-12);
        assert!((eased - SAIL_SHEET_EASED_DEG).abs() < 1e-12);
        assert!(sail_trim_to_sheet_rad(0.5).to_degrees() > hard);
        assert!(sail_trim_to_sheet_rad(0.5).to_degrees() < eased);
    }

    /// Provisional aft CE (`r_x < 0`) produces a yaw moment from lateral sail force
    /// (weather-helm lever); height still dominates heel.
    #[test]
    fn coefficient_sail_aft_ce_produces_yaw_from_side_force() {
        let p = lagoon_450s();
        assert!(
            p.sail.r[0] < 0.0,
            "expected provisional aft CE, got r_x={}",
            p.sail.r[0]
        );
        let f_side = [0.0, 1000.0, 0.0];
        let wrench = apply_at(f_side, p.sail.r);
        // Mz = r_x * Fy − r_y * Fx = (−0.5)*1000 < 0
        assert!(
            (wrench[5] - p.sail.r[0] * f_side[1]).abs() < 1e-12,
            "yaw moment from side force at CE"
        );
        assert!(wrench[5].abs() > 1.0);
        // Heel from height: Mx = −r_z * Fy = 8 * 1000
        assert!((wrench[3] - (-p.sail.r[2]) * f_side[1]).abs() < 1e-12);
    }
}
